// The CLI's card rows through the agent: each row's argv and hash, the upload's path rule and staged
// file, the rows held until Candle switches them on, outcomes and read-backs, paper, the kill switch and
// the limits, then through a running core and the fake candle CLI.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { Redactor } from "../shared/redact"
import type { AgentStatus } from "./agent-status"
import type { PayerResult } from "./agent-wallets"
import type { CliResult } from "./candle-cli"
import { type Card, CardBook, hashCard } from "./cards"
import { pausedStops } from "./classify"
import { CliCards, mapCliRow, UploadStage } from "./cli-cards"
import { CLI_ROWS, closeEmptyOn } from "./cli-table"
import type { EmptyState } from "./empty-accounts"
import { resolveCall } from "./cli-tool"
import type { Operation } from "./execute"
import { Journal } from "./journal"
import { DaySpend, Limits } from "./limits"
import type { FaceClient } from "./tool-face"

const TEE = "TeeFakeA1111111111111111111111111111111111"
const EMBEDDED = "WalletFake111111111111111111111111111111111"
const POOL = "PoolFake11111111111111111111111111111111111"
const MINT = "MintFake11111111111111111111111111111111111"
const HARNESS: FaceClient = { clientId: "h1", role: "harness", agent: "momentum" }
const T0 = new Date(2026, 9, 27, 12, 0, 0).getTime()
/** A PNG's first bytes, and some more. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake image body")])

const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {})
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  cleanupHomes()
})
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `chrn-${name}-`))
  dirs.push(d)
  return d
}

const status = (): AgentStatus => ({ readAt: 0, wallets: { solana: EMBEDDED }, embeddedWallet: "allowed", feeBps: 50, unreadable: [] })

/** A card book with the CLI rows' deps: momentum pays from the embedded wallet or tee-one. */
async function book(opts: { mode?: "paper" | "live"; dryRun?: (argv: string[]) => CliResult; staking?: Record<string, unknown>; empty?: Record<string, EmptyState> } = {}) {
  const dir = tempDir("rows")
  const research = join(dir, "research", "momentum")
  mkdirSync(research, { recursive: true })
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => T0 })
  journals.push(journal)
  const dryRuns: string[][] = []
  let paused = false
  const spend = new DaySpend()
  const stage = new UploadStage(join(dir, "state", "uploads"))
  const payer = (word?: string): PayerResult => {
    if (word === undefined || word === "embedded" || word === EMBEDDED) return { ok: true, kind: "embedded", address: EMBEDDED, chain: "solana" }
    if (word === "tee-one" || word === TEE) return { ok: true, kind: "tee", address: TEE, id: "teeA", label: "tee-one", chain: "solana" }
    return { ok: false, code: "WALLET_NOT_PAYABLE", message: `momentum can't pay from ${word}. It can pay from: embedded, tee-one.`, canPayFrom: ["embedded", "tee-one"] }
  }
  const cards = new CardBook({
    journal,
    account: "acct_fake",
    now: () => T0,
    mode: () => opts.mode ?? "live",
    agents: () => ["momentum"],
    keyPrefix: () => "MomeAb3d",
    status: { get: () => status() },
    markets: { resolve: async () => ({ ok: false, code: "MARKET_NOT_FOUND", message: "no" }) } as never,
    spendAsset: () => "SOL",
    holding: async () => "none",
    pricing: {
      asset: async (_agent, asset) => ({ usd: asset === "SOL" ? 150 : asset === "CNDL" ? 0.02 : 1, at: T0, source: "test" }),
      token: async () => ({ usd: 0.5, at: T0, source: "test" }),
      quote: async () => undefined,
    },
    limits: new Limits({ limitsFor: () => ({ perTradeUsd: 10, perDayUsd: 50 }), spend }),
    spend,
    paused: () => paused,
    wallets: { payer: (_agent, word) => payer(word) },
    cliArgs: (args, o) => [...args, "--json", ...(o?.rpcUrl ? ["--rpc-url", "https://rpc.example"] : [])],
    cliRows: {
      researchDir: () => research,
      stage,
      dryRun: async (_agent, argv) => {
        dryRuns.push(argv)
        return opts.dryRun ? opts.dryRun(argv) : { exitCode: 0, stdout: "", stderr: "", timedOut: false, json: { success: true, dryRun: true, kind: "launch" } }
      },
      emptyOf: (address) => opts.empty?.[address],
    },
    candle: async (_agent, tool) => (tool === "candle_get_staking" && opts.staking ? { kind: "ok", result: opts.staking } : { kind: "error", code: "FAKE", retryable: false, body: {} }),
    execute: async () => ({ state: "submitting" as const }),
  })
  /** The agent's candle_cli words, resolved as candle_cli does, then proposed. */
  const propose = async (command: string, subcommand: string | undefined, args: string[]) => {
    const r = resolveCall({ command, subcommand, args }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    const c = r.call
    return (await cards.propose({
      client: HARNESS,
      agent: "momentum",
      tool: "candle_cli",
      args: { cli: c.argv },
      params: { cli: c.argv },
      kind: c.row.card!.kind,
      idKey: "coreOpId",
      cli: { row: c.row.path, words: c.argv, valueFlags: c.valueFlags, rpcUrl: c.withRpcUrl, yes: c.takesYes },
    })) as Card
  }
  const refusal = (p: Promise<unknown>) => p.then(() => "no refusal", (e: { data?: { code?: string }; code?: string; message?: string }) => `${e.data?.code ?? e.code}: ${e.message}`)
  return { cards, propose, refusal, research, stage, dryRuns, journal, pause: () => (paused = true) }
}

describe("each row's argv and hash", () => {
  test("stake add from a TEE wallet: by address, the core's id on --client-stake-id, --yes; the hash covers the final argv", async () => {
    const b = await book({ staking: { pool: { withdrawalTimelockSeconds: 7 * 86_400 }, wallets: [{ address: TEE, payer: "linked" }] } })
    const card = await b.propose("stake", "add", ["10", "--wallet", "tee-one"])
    expect(card.params.argv).toEqual(["stake", "add", "10", "--wallet", TEE, "--client-stake-id", card.opId, "--yes", "--json"])
    expect(card).toMatchObject({ kind: "stake", tool: "candle_cli", route: "cli", row: "stake add", wallet: TEE, params: { identity: "agent", agent: "momentum", json: true, row: "stake add" } })
    expect(card.display).toMatchObject({ title: "STAKE 10 CNDL · tee-one", preview: "pool wait 7 days to unstake later", paysFrom: `pays from tee-one (TEE · TeeF…1111)` })
    expect(card.display.resendNote).toContain("same --client-stake-id")
    expect(card.cardHash).toBe(hashCard({ kind: "stake", tool: "candle_cli", params: card.params, opId: card.opId, account: "acct_fake", agent: "momentum", wallet: TEE, mode: "live", route: "cli" }))
    // No --rpc-url: candle stake doesn't take one.
    expect(card.params.argv).not.toContain("--rpc-url")
  })

  test("stake remove and finish: their words, the same id flag", async () => {
    const b = await book()
    const remove = await b.propose("stake", "remove", ["4.5", "--wallet", TEE])
    expect(remove.params.argv).toEqual(["stake", "remove", "4.5", "--wallet", TEE, "--client-stake-id", remove.opId, "--yes", "--json"])
    expect(remove.display.headline).toBe("UNSTAKE 4.5 sCNDL")
    const finish = await b.propose("stake", "finish", ["--wallet", "tee-one"])
    expect(finish.params.argv).toEqual(["stake", "finish", "--wallet", TEE, "--client-stake-id", finish.opId, "--yes", "--json"])
  })

  test("staking named by the embedded wallet's address points at Candle's tool; a wallet it can't pay from names the ones it can", async () => {
    const b = await book()
    expect(await b.refusal(b.propose("stake", "add", ["10", "--wallet", EMBEDDED]))).toStartWith("USE_MCP_TOOL: From the embedded wallet: candle_stake")
    expect(await b.refusal(b.propose("stake", "add", ["10", "--wallet", "someone-elses"]))).toBe("WALLET_NOT_PAYABLE: momentum can't pay from someone-elses. It can pay from: embedded, tee-one.")
    expect(await b.refusal(b.propose("stake", "add", ["ten", "--wallet", "tee-one"]))).toStartWith("INVALID_STAKE")
  })

  test("an id the agent gives is refused: the Candle Harness mints every card's id", async () => {
    const b = await book()
    expect(await b.refusal(b.propose("stake", "add", ["10", "--wallet", "tee-one", "--client-stake-id", "mine"]))).toStartWith("CLIENT_ID_BY_HARNESS")
  })

  test("lp add (held): valued in its token, a buy against the Candle Harness limits, --rpc-url from config", async () => {
    const b = await book()
    const card = await b.propose("lp", "add", [POOL, "USDC", "--amount", "5", "--wallet", "tee-one"])
    expect(card.params.argv).toEqual(["lp", "add", POOL, "USDC", "--amount", "5", "--wallet", TEE, "--client-trade-id", card.opId, "--yes", "--json", "--rpc-url", "https://rpc.example"])
    expect(card).toMatchObject({ kind: "lp", side: "buy", value: { usd: 5, unvalued: false } })
    expect(await b.refusal(b.propose("lp", "add", [POOL, "SOL", "--amount", "1", "--wallet", "tee-one"]))).toBe("OVER_TRADE_LIMIT: Over momentum's Candle Harness limit: $150.00 is more than $10.00 per trade.")
    const remove = await b.propose("lp", "remove", [POOL, "--percent", "50", "--wallet", "tee-one"])
    expect(remove.side).toBeUndefined()
    expect(remove.display.headline).toBe("LP REMOVE 50%")
  })

  test("launch from a TEE wallet (held): dry-run through the CLI when proposed, the first buy limited, a refused dry run makes no card", async () => {
    const b = await book()
    const words = ["--name", "Fake", "--symbol", "FAKE", "--image-url", "https://img.example/f.png", "--wallet", "tee-one"]
    const card = await b.propose("launch", undefined, [...words, "--buy", "0.05"])
    expect(b.dryRuns[0]).toEqual(["launch", ...words.slice(0, 6), "--wallet", TEE, "--buy", "0.05", "--client-trade-id", card.opId, "--dry-run", "--json", "--rpc-url", "https://rpc.example"])
    expect(card.params.argv).toEqual(["launch", ...words.slice(0, 6), "--wallet", TEE, "--buy", "0.05", "--client-trade-id", card.opId, "--yes", "--json", "--rpc-url", "https://rpc.example"])
    expect(card).toMatchObject({ kind: "launch", side: "buy", value: { usd: 7.5 } })
    expect(card.display.publicNote).toBe("public: a new token can't be taken back")
    expect(await b.refusal(b.propose("launch", undefined, [...words, "--buy", "1"]))).toStartWith("OVER_TRADE_LIMIT")
    const refused = await book({ dryRun: () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false, json: { ok: false, code: "LAUNCH_NOT_ALLOWED", message: "This wallet may not launch." } }) })
    expect(await refused.refusal(refused.propose("launch", undefined, words))).toBe("LAUNCH_NOT_ALLOWED: The candle CLI's dry run refused it: This wallet may not launch.. No card was made, and nothing was sent.")
  })

  test("close-empty: a TEE wallet by address, Candle's last count on the card; --keep passes through, repeated", async () => {
    const b = await book({ empty: { [TEE]: { count: 3, netSol: "0.00614264", totalSol: "0.00615264", feeSol: "0.00001", transactions: 2, at: T0 } } })
    const card = await b.propose("wallets", "close-empty", ["--wallet", "tee-one", "--keep", MINT, "--keep", POOL])
    expect(card.params.argv).toEqual(["wallets", "close-empty", "--wallet", TEE, "--keep", MINT, "--keep", POOL, "--client-trade-id", card.opId, "--yes", "--json"])
    expect(card).toMatchObject({ kind: "close", wallet: TEE })
    expect(card.side).toBeUndefined()
    expect(card.display.title).toBe("CLOSE EMPTY ACCOUNTS · tee-one")
    expect(card.display.preview).toBe("3 empty token accounts · 0.00614264 SOL back to the same wallet · keeps Mint…1111, Pool…1111")
    // Not counted yet, it says where the rent goes; Candle's preview at the run decides what closes.
    const fresh = await (await book()).propose("wallets", "close-empty", ["--wallet", TEE])
    expect(fresh.display.preview).toBe("rent back to the same wallet")
  })

  test("close-empty from the embedded wallet is refused with why, by word or by address: an agent key has no transfer:write", async () => {
    const b = await book()
    for (const args of [[], ["--wallet", "embedded"], ["--wallet", EMBEDDED]]) {
      expect(await b.refusal(b.propose("wallets", "close-empty", args))).toBe(
        "NEEDS_TRANSFER_WRITE: candle wallets close-empty from the embedded wallet isn't in the Candle Harness: From the embedded wallet it needs transfer:write, which an agent key doesn't have. Nothing was sent.",
      )
    }
  })

})

describe("image upload's path", () => {
  test("a file in the research folder passes: staged in the core's state folder, its SHA-256 in the hash", async () => {
    const b = await book()
    writeFileSync(join(b.research, "logo.png"), PNG)
    const card = await b.propose("image", "upload", ["logo.png"])
    const file = card.params.file as { path: string; sha256: string; bytes: number }
    expect(file.path.startsWith(join(b.research, "..", "..", "state", "uploads"))).toBe(true)
    expect(file).toMatchObject({ bytes: PNG.length, sha256: new Bun.CryptoHasher("sha256").update(PNG).digest("hex") })
    expect(readFileSync(file.path)).toEqual(PNG)
    expect(card.params.argv).toEqual(["image", "upload", file.path, "--json"])
    expect(card).toMatchObject({ kind: "upload", wallet: "none" })
    expect(card.display.title).toBe("UPLOAD IMAGE logo.png (PNG, 1 KB)")
    expect(card.display.publicNote).toContain("public and permanent")
    // The same file named absolutely, and a banner.
    const banner = await b.propose("image", "upload", [join(b.research, "logo.png"), "--banner"])
    expect((banner.params.argv as string[]).slice(-2)).toEqual(["--banner", "--json"])
  })

  test("../, a path elsewhere, a symlink out, a folder, over 10 MB and a file that isn't an image are refused, and nothing is staged", async () => {
    const b = await book()
    const outside = tempDir("outside")
    writeFileSync(join(outside, "secret.png"), PNG)
    symlinkSync(join(outside, "secret.png"), join(b.research, "link.png"))
    mkdirSync(join(b.research, "folder"))
    writeFileSync(join(b.research, "big.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]))
    writeFileSync(join(b.research, "notes.png"), "just text")
    const cases: [string, string][] = [
      [`../../../${outside.split("/").pop()}/secret.png`, "is outside it"],
      [join(outside, "secret.png"), "is outside it"],
      ["link.png", "is outside it"],
      ["folder", "isn't a file"],
      ["big.png", "over 10 MB"],
      ["notes.png", "isn't a PNG, JPEG, GIF or WebP"],
      ["missing.png", "There's no file"],
    ]
    for (const [path, why] of cases) {
      const said = await b.refusal(b.propose("image", "upload", [path]))
      expect(`${path}: ${said.startsWith("PATH_NOT_ALLOWED") && said.includes(why)}`).toBe(`${path}: true`)
    }
    expect(existsSync(join(b.research, "..", "..", "state", "uploads"))).toBe(false)
  })

  test("what runs is the staged copy: a source changed after the card changes nothing, a staged copy changed is refused", async () => {
    const b = await book()
    writeFileSync(join(b.research, "logo.png"), PNG)
    const card = await b.propose("image", "upload", ["logo.png"])
    writeFileSync(join(b.research, "logo.png"), Buffer.concat([PNG, Buffer.from("swapped")]))
    const runs: string[][] = []
    const cli = new CliCards({
      cli: { runExact: async (input) => (runs.push(input.argv), { exitCode: 0, stdout: "", stderr: "", timedOut: false, json: { success: true, imageUrl: "https://img.example/a.png" } }) },
      redactor: new Redactor(),
      journal: b.journal,
      stage: b.stage,
      now: () => T0,
    })
    const op = { opId: card.opId, params: card.params, mode: "live", agent: "momentum", cardExpiresAt: T0 + 600_000 } as unknown as Operation
    expect(await cli.execute(op)).toMatchObject({ state: "succeeded", result: { imageUrl: "https://img.example/a.png" } })
    expect(readFileSync((card.params.file as { path: string }).path)).toEqual(PNG)
    writeFileSync((card.params.file as { path: string }).path, "tampered")
    expect(await cli.execute(op)).toMatchObject({ state: "refused", error: { code: "UPLOAD_FILE_CHANGED" } })
    expect(runs).toHaveLength(1)
    await b.stage.release(card.opId)
    expect(existsSync((card.params.file as { path: string }).path)).toBe(false)
  })
})

describe("paper, the kill switch and limits", () => {
  test("paper mode refuses every row: no paper form", async () => {
    const b = await book({ mode: "paper" })
    writeFileSync(join(b.research, "logo.png"), PNG)
    for (const [c, s, a] of [["stake", "add", ["1", "--wallet", "tee-one"]], ["image", "upload", ["logo.png"]], ["wallets", "close-empty", []]] as const) {
      expect(await b.refusal(b.propose(c, s, [...a]))).toStartWith("NO_PAPER_FORM")
    }
  })

  test("the kill table: stake add, LP add, a launch and an upload stop; unstakes, finishes, LP removes and claims and close-empty are kept", () => {
    const stops = Object.fromEntries(CLI_ROWS.filter((r) => r.card).map((r) => [r.path, pausedStops({ kind: r.card!.kind, tool: "candle_cli", row: r.path })]))
    expect(stops).toEqual({
      "stake add": true,
      "stake remove": false,
      "stake finish": false,
      launch: true,
      "image upload": true,
      "lp add": true,
      "lp remove": false,
      "lp claim": false,
      "wallets close-empty": false,
    })
  })

  test("paused, a stopped row makes no card, and a kept one does", async () => {
    const b = await book()
    b.pause()
    expect(await b.refusal(b.propose("stake", "add", ["1", "--wallet", "tee-one"]))).toStartWith("PAUSED: Staking is paused")
    expect((await b.propose("stake", "remove", ["1", "--wallet", "tee-one"])).state).toBe("awaiting_approval")
  })
})

describe("outcomes", () => {
  const run = (exitCode: number, json?: unknown, timedOut = false) => ({ exitCode, json, timedOut })
  test("exit 0 is read by its body, per kind", () => {
    expect(mapCliRow("stake add", run(0, { status: "confirmed", signature: "S" })).state).toBe("succeeded")
    expect(mapCliRow("stake add", run(0, { status: "built" })).state).toBe("unknown")
    expect(mapCliRow("image upload", run(0, { success: true, imageUrl: "https://x" })).state).toBe("succeeded")
    expect(mapCliRow("lp add", run(0, { kind: "lp", signature: "S" })).state).toBe("succeeded")
    expect(mapCliRow("launch", run(0, { job: { status: "submitted" } })).state).toBe("pending")
    expect(mapCliRow("wallets close-empty", run(0, { success: true, status: "recovering" })).state).toBe("unknown")
  })

  test("a close's answers as CLI 0.13.5 prints them: the submit, nothing to close, and a stored job read back", () => {
    const close = (json: unknown) => mapCliRow("wallets close-empty", run(0, json))
    expect(close({ success: true, status: "completed", signatures: ["S0", "S1"], solRecovered: "0.00615264", failed: [], unattempted: [] }).state).toBe("succeeded")
    expect(close({ success: true, status: "nothing_to_close", preview: {} }).state).toBe("succeeded")
    // Read back under the same id, the job is nested: completed, or never submitted (Candle sent nothing; exit 0).
    expect(close({ success: true, job: { status: "completed", result: { success: true, status: "completed" } }, clientTradeId: "op" }).state).toBe("succeeded")
    expect(close({ success: true, job: { status: "completed" }, clientTradeId: "op" }).state).toBe("succeeded")
    expect(close({ success: true, job: { result: { status: "built" } } })).toMatchObject({ state: "failed", error: { code: "CLOSE_NOT_SUBMITTED" } })
    // Anything not plainly done is unknown, and read back again: never sent twice.
    expect(close({ success: true, status: "built" }).state).toBe("unknown")
    expect(close({ success: true, status: "partial" }).state).toBe("unknown")
    expect(close({ success: true }).state).toBe("unknown")
  })

  test("exit 1 or 2 is refused only for a code raised before anything was signed or sent; the rest is unknown", () => {
    expect(mapCliRow("stake add", run(1, { ok: false, code: "SIGNER_UNAVAILABLE" }))).toMatchObject({ state: "refused", error: { code: "SIGNER_UNAVAILABLE" } })
    expect(mapCliRow("stake add", run(2, { ok: false, code: "USAGE" })).state).toBe("refused")
    expect(mapCliRow("stake add", run(1, { ok: false, code: "REQUEST_FAILED" })).state).toBe("unknown")
    expect(mapCliRow("stake add", run(1, { ok: false, code: "OPERATION_ALREADY_STARTED" })).state).toBe("unknown")
    // An LP or a launch broadcasts over the RPC itself: an RPC failure may come after it sent.
    expect(mapCliRow("lp add", run(1, { ok: false, code: "RPC_FAILED" })).state).toBe("unknown")
    expect(mapCliRow("lp add", run(1, { ok: false, code: "LP_NOT_ENABLED" })).state).toBe("refused")
    expect(mapCliRow("image upload", run(1, { ok: false, code: "IMAGE_TOO_LARGE" })).state).toBe("refused")
    expect(mapCliRow("image upload", run(1, { ok: false, code: "REQUEST_FAILED" })).state).toBe("unknown")
  })

  test("exit 3, a timeout and an unreadable answer are unknown", () => {
    expect(mapCliRow("wallets close-empty", run(3, { ok: false, code: "RECOVERING" })).state).toBe("unknown")
    expect(mapCliRow("stake add", run(0, undefined, true)).state).toBe("unknown")
    expect(mapCliRow("stake add", { exitCode: 1, timedOut: false, jsonError: "bad" }).state).toBe("unknown")
  })

  test("read-backs: a rerun only within the card's lifetime, and a refused rerun stays unknown; a launch by its job; an upload has none", async () => {
    const dir = tempDir("reads")
    const journal = await Journal.open({ path: join(dir, "j.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => T0 })
    journals.push(journal)
    let now = T0
    let answer: CliResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false, json: { status: "confirmed", signature: "S", resumed: true } }
    const runs: string[][] = []
    const cli = new CliCards({ cli: { runExact: async (i) => (runs.push(i.argv), answer) }, redactor: new Redactor(), journal, stage: new UploadStage(join(dir, "u")), now: () => now })
    const op = (row: string) => ({ opId: "op-1", params: { argv: ["x"], identity: "agent", agent: "momentum", json: true, row }, mode: "live", agent: "momentum", cardExpiresAt: T0 + 600_000 }) as unknown as Operation
    expect(await cli.read(op("stake add"))).toMatchObject({ mapped: { state: "succeeded" }, detail: "rerun" })
    answer = { exitCode: 1, stdout: "", stderr: "", timedOut: false, json: { ok: false, code: "SIGNER_UNAVAILABLE" } }
    expect(await cli.read(op("stake add"))).toMatchObject({ mapped: { state: "unknown" }, detail: "rerun refused" })
    now = T0 + 600_000
    expect(await cli.read(op("stake add"))).toBeUndefined()
    expect(await cli.read(op("image upload"))).toBeUndefined()
    answer = { exitCode: 0, stdout: "", stderr: "", timedOut: false, json: { job: { status: "confirmed" }, kind: "launch" } }
    expect(await cli.read(op("launch"))).toMatchObject({ mapped: { state: "succeeded" }, detail: "launch job" })
    expect(runs.at(-1)).toEqual(["swap", "status", "op-1", "--kind", "launch", "--json"])
    expect(runs).toHaveLength(3)
  })
})

describe("through a running core and the fake candle CLI", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })
  const tee = { id: "teeA", address: TEE, label: "tee-one", boundKeyPrefix: "Momentum" }

  async function setup(script: Record<string, unknown> = {}, config: Record<string, unknown> = {}, env: Record<string, string> = {}) {
    const cliDir = tempDir("rows-cli")
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ tee: { wallets: [tee], ...script } }))
    const t = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: cliDir, ...env } }, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: { teeWallets: [tee] }, swing: {} }, config })
    cores.push(t)
    const view = await t.view()
    const { client } = await t.harness(view)
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.request("tools.call", { name: "candle_cli", args })).result as { content: { text: string }[] }).content[0]!.text)
    const runs = () =>
      existsSync(join(cliDir, "fake-cli-runs.jsonl"))
        ? readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> })
        : []
    const rowRuns = (word: string) => runs().filter((r) => r.argv[0] === word)
    return { t, view, call, runs, rowRuns, cliDir }
  }

  test("the agent's TEE stake is a card; one press runs candle stake once, with its key, and the journal says how", async () => {
    const s = await setup()
    const answer = await s.call({ command: "stake", subcommand: "add", args: ["10", "--wallet", "tee-one"], reason: "the user asked" })
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    expect(s.rowRuns("stake")).toEqual([])
    const card = s.t.core.cards.get(answer.cardId)!
    const approved = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).result as { operation: { state: string } }
    expect(approved.operation.state).toBe("succeeded")
    const [run] = s.rowRuns("stake")
    expect(run!.argv).toEqual(["stake", "add", "10", "--wallet", TEE, "--client-stake-id", card.opId, "--yes", "--json"])
    expect(run!.env.CANDLE_API_KEY).toBe(prefixedKey("Momentum"))
    expect(s.t.core.journal.rows().find((r) => r.type === "card.approved")).toMatchObject({ how: "enter", opId: card.opId })
    expect(s.t.core.journal.rows().find((r) => r.type === "card.created")).toMatchObject({ row: "stake add", route: "cli", kind: "stake" })
  }, 30_000)

  test("a lost answer is unknown, and the rerun under the same id resumes it: the CLI resubmits, never a second stake", async () => {
    const s = await setup({ stakeOutcome: "requestFailed" })
    const answer = await s.call({ command: "stake", subcommand: "add", args: ["10", "--wallet", "tee-one"] })
    const card = s.t.core.cards.get(answer.cardId)!
    const approved = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { operation: { state: string } }
    expect(approved.operation.state).toBe("unknown")
    await until(() => s.t.core.operations.get(card.opId)?.state === "succeeded", 10_000)
    const runs = s.rowRuns("stake")
    expect(runs).toHaveLength(2)
    expect(runs[1]!.argv).toEqual(runs[0]!.argv)
    expect(s.t.core.operations.get(card.opId)!.result).toMatchObject({ resumed: true })
  }, 30_000)

  test("the debug switch reaches a CLI card row: a TEE stake's answer is dropped once and read back by rerun; narrowing access is never dropped", async () => {
    const s = await setup({}, {}, { CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1" })
    // A narrowing has no read-back, so the switch passes it by and stays on.
    const revoke = await s.call({ command: "keys", subcommand: "revoke", args: ["abc123"] })
    const revokeCard = s.t.core.cards.get(revoke.cardId)!
    const revoked = (await s.view.request("cards.approve", { cardId: revokeCard.cardId, cardHash: revokeCard.cardHash })).result as { operation: { state: string } }
    expect(revoked.operation.state).toBe("succeeded")
    expect(s.t.core.operations.losingNextReply()).toBe(true)
    const answer = await s.call({ command: "stake", subcommand: "add", args: ["10", "--wallet", "tee-one"] })
    const card = s.t.core.cards.get(answer.cardId)!
    const approved = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { operation: { state: string; reason?: string } }
    expect(approved.operation).toMatchObject({ state: "unknown", reason: "no answer (transport)" })
    expect(s.t.core.operations.losingNextReply()).toBe(false)
    await until(() => s.t.core.operations.get(card.opId)?.state === "succeeded", 10_000)
    const runs = s.rowRuns("stake")
    expect(runs).toHaveLength(2)
    expect(runs[1]!.argv).toEqual(runs[0]!.argv)
  }, 30_000)

  test("an upload from the research folder: one press, the URL in the operation, the staged copy gone after", async () => {
    const s = await setup()
    const research = s.t.p.researchDir("momentum")
    mkdirSync(research, { recursive: true })
    writeFileSync(join(research, "logo.png"), PNG)
    const answer = await s.call({ command: "image", subcommand: "upload", args: ["logo.png"] })
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    const card = s.t.core.cards.get(answer.cardId)!
    const staged = (card.params.file as { path: string }).path
    expect(staged.startsWith(s.t.p.uploads)).toBe(true)
    await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    const op = s.t.core.operations.get(card.opId)!
    expect(op.state).toBe("succeeded")
    expect((op.result as { imageUrl: string }).imageUrl).toStartWith("https://fake-images.example/")
    expect(s.rowRuns("image")[0]!.argv).toEqual(["image", "upload", staged, "--json"])
    await until(() => !existsSync(staged))
    // A file outside the folder is refused, and nothing runs.
    const outside = await s.call({ command: "image", subcommand: "upload", args: ["/etc/hosts"] })
    expect(outside.error.code).toBe("PATH_NOT_ALLOWED")
    expect(s.rowRuns("image")).toHaveLength(1)
  }, 30_000)

  test("held rows answer coming, with why; the embedded wallet's form points at Candle's tool; funds out must be asked for", async () => {
    const s = await setup()
    const lp = await s.call({ command: "lp", subcommand: "add", args: [POOL, "SOL", "--amount", "1", "--wallet", "tee-one"] })
    expect(lp.error).toMatchObject({ code: "NOT_YET" })
    expect(lp.error.message).toContain("Candle hasn't switched LP on")
    // close-empty: from the embedded wallet never an agent key's. From a TEE wallet it's on.
    const close = await s.call({ command: "wallets", subcommand: "close-empty" })
    expect(close.error).toMatchObject({ code: "NEEDS_TRANSFER_WRITE" })
    expect(close.error.message).toContain("transfer:write")
    expect(closeEmptyOn()).toBe(true)
    const launch = await s.call({ command: "launch", args: ["--name", "F", "--symbol", "F", "--image-url", "https://i.example/f.png", "--wallet", "tee-one"] })
    expect(launch.error.message).toStartWith("candle launch from a TEE wallet is coming: A TEE wallet's launch needs the owner")
    expect((await s.call({ command: "launch", args: ["--name", "F", "--symbol", "F"] })).error.code).toBe("USE_MCP_TOOL")
    expect((await s.call({ command: "stake", subcommand: "add", args: ["1"] })).error.message).toContain("candle_stake")
    // A harness with no turn of the core's engine has no message from the user that asked for it.
    const sweep = await s.call({ command: "tee", subcommand: "sweep", args: [TEE] })
    expect(sweep.error).toMatchObject({ code: "ASK_FOR_IT_YOURSELF" })
    expect(s.rowRuns("lp").concat(s.rowRuns("launch"), s.rowRuns("wallets"), s.rowRuns("tee"))).toEqual([])
  }, 30_000)

  test("paper mode refuses the rows before anything runs", async () => {
    const s = await setup()
    await s.view.request("mode.set", { mode: "paper" })
    expect((await s.call({ command: "stake", subcommand: "add", args: ["1", "--wallet", "tee-one"] })).error.code).toBe("NO_PAPER_FORM")
    expect((await s.call({ command: "image", subcommand: "upload", args: ["logo.png"] })).error.code).toBe("NO_PAPER_FORM")
    expect(s.rowRuns("stake").concat(s.rowRuns("image"))).toEqual([])
  }, 30_000)

  test("typed, candle stake add … --wallet is the same card, as the user's", async () => {
    const s = await setup()
    const typed = (await s.view.request("cli.run", { argv: ["stake", "add", "10", "--wallet", "tee-one"] })).result as { cardId: string; state: string }
    expect(typed.state).toBe("awaiting_approval")
    expect(s.t.core.cards.get(typed.cardId)).toMatchObject({ origin: { role: "view" }, row: "stake add" })
    expect(s.rowRuns("stake")).toEqual([])
    // From the embedded wallet, typed, it's the agent's to propose.
    expect((await s.view.request("cli.run", { argv: ["stake", "add", "10"] })).error?.data?.code).toBe("ASK_THE_AGENT")
  }, 30_000)

  test("typed under cards.typedTrades = instant, it runs at once, approved by the core as instant", async () => {
    const s = await setup({}, { cards: { typedTrades: "instant" } })
    const typed = (await s.view.request("cli.run", { argv: ["stake", "remove", "2", "--wallet", "tee-one"] })).result as { instant: { operation: { state: string } }; opId: string }
    expect(typed.instant.operation.state).toBe("succeeded")
    expect(s.rowRuns("stake")).toHaveLength(1)
    expect(s.t.core.journal.rows().find((r) => r.type === "card.approved")).toMatchObject({ how: "instant" })
  }, 30_000)

  test("the hash binds what runs: a card whose wallet or amount changed after it was made never runs", async () => {
    const s = await setup()
    const answer = await s.call({ command: "stake", subcommand: "add", args: ["10", "--wallet", "tee-one"] })
    const card = s.t.core.cards.get(answer.cardId)!
    ;(card.params.argv as string[])[2] = "1000"
    const approved = await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    expect(approved.error?.data?.code).toBe("CARD_CHANGED")
    expect(s.rowRuns("stake")).toEqual([])
  }, 30_000)

  test("the kill switch withdraws an open stake add and keeps an unstake", async () => {
    const s = await setup()
    const add = await s.call({ command: "stake", subcommand: "add", args: ["10", "--wallet", "tee-one"] })
    const remove = await s.call({ command: "stake", subcommand: "remove", args: ["3", "--wallet", "tee-one"] })
    await s.view.request("kill")
    expect(s.t.core.cards.get(add.cardId)!.state).toBe("withdrawn")
    expect(s.t.core.cards.get(remove.cardId)!.state).toBe("awaiting_approval")
  }, 30_000)
})

describe("closing a TEE wallet's empty accounts, switched on", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })
  const tee = { id: "teeA", address: TEE, label: "tee-one", boundKeyPrefix: "Momentum" }

  async function setup(closeEmpty: Record<string, unknown>) {
    const cliDir = tempDir("close-cli")
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ tee: { wallets: [tee] }, closeEmpty }))
    const t = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } }, { keys: { momentum: prefixedKey("Momentum") }, candle: { momentum: { teeWallets: [tee] } } })
    cores.push(t)
    const view = await t.view()
    const { client } = await t.harness(view)
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.request("tools.call", { name: "candle_cli", args })).result as { content: { text: string }[] }).content[0]!.text)
    const runs = () =>
      existsSync(join(cliDir, "fake-cli-runs.jsonl"))
        ? readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> })
        : []
    const closes = () => runs().filter((r) => r.argv[1] === "close-empty")
    const kept = (): { closed: string[] } => (existsSync(join(cliDir, "fake-cli-close.json")) ? JSON.parse(readFileSync(join(cliDir, "fake-cli-close.json"), "utf8")) : { closed: [] })
    await until(() => t.core.wallets.payable("momentum").tee.length > 0, 10_000)
    return { t, view, call, closes, kept }
  }

  test("the count is Candle's preview, read with the wallet's own key and never --yes; the agent's close is a card with it, and one press runs it", async () => {
    const s = await setup({ accounts: { [TEE]: 3 } })
    await s.t.core.emptyAccounts.read(TEE)
    expect(s.t.core.emptyAccounts.get(TEE)).toMatchObject({ count: 3, totalSol: "0.00611784", feeSol: "0.000005", netSol: "0.00611284", transactions: 1 })
    const [preview] = s.closes()
    expect(preview!.argv).toEqual(["wallets", "close-empty", "--wallet", TEE, "--json"])
    expect(preview!.env.CANDLE_API_KEY).toBe(prefixedKey("Momentum"))
    expect(s.kept().closed).toEqual([])
    const answer = await s.call({ command: "wallets", subcommand: "close-empty", args: ["--wallet", "tee-one"], reason: "rent from the sells" })
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    const card = s.t.core.cards.get(answer.cardId)!
    expect(card.display.preview).toBe("3 empty token accounts · 0.00611284 SOL back to the same wallet")
    // A close that settles has its wallet counted again (15 s on, in the core).
    const settled: string[] = []
    const after = s.t.core.emptyAccounts.afterSettle.bind(s.t.core.emptyAccounts)
    s.t.core.emptyAccounts.afterSettle = (address) => (settled.push(address), after(address))
    const approved = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).result as { operation: { state: string } }
    expect(approved.operation.state).toBe("succeeded")
    expect(s.closes().at(-1)!.argv).toEqual(["wallets", "close-empty", "--wallet", TEE, "--client-trade-id", card.opId, "--yes", "--json"])
    expect(s.kept().closed).toEqual([TEE])
    await until(() => settled.length === 1)
    expect(settled).toEqual([TEE])
    await s.t.core.emptyAccounts.read(TEE)
    expect(s.t.core.emptyAccounts.get(TEE)).toMatchObject({ count: 0 })
  }, 30_000)

  test("a close Candle hasn't settled (exit 3) is read back under the same id, and nothing is closed twice", async () => {
    const s = await setup({ accounts: { [TEE]: 2 }, outcome: "recovering" })
    const answer = await s.call({ command: "wallets", subcommand: "close-empty", args: ["--wallet", TEE] })
    const card = s.t.core.cards.get(answer.cardId)!
    const approved = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { operation: { state: string } }
    expect(approved.operation.state).toBe("unknown")
    await until(() => s.t.core.operations.get(card.opId)?.state === "succeeded", 10_000)
    const sent = s.closes().filter((r) => r.argv.includes("--yes"))
    expect(sent).toHaveLength(2)
    expect(sent[1]!.argv).toEqual(sent[0]!.argv)
    expect(s.kept().closed).toEqual([TEE])
  }, 30_000)

  test("typed, or from the Wallets pane's chip, it runs at once as typed: nothing leaves the wallet", async () => {
    const s = await setup({ accounts: { [TEE]: 1 } })
    const result = (await s.view.request("cli.run", { argv: ["wallets", "close-empty", "--wallet", TEE], agent: "momentum" })).result as { said: string; instant: { operation: { state: string } } }
    expect(result.said).toBe("CLOSE EMPTY ACCOUNTS · tee-one: approved as typed. Activity says how it ends; the rent comes back to the same wallet.")
    expect(result.instant.operation.state).toBe("succeeded")
    expect(s.t.core.journal.rows().find((r) => r.type === "card.approved")).toMatchObject({ how: "typed" })
    expect(s.t.core.cards.list().filter((c) => c.state === "awaiting_approval")).toEqual([])
    // From the embedded wallet it's still refused, typed too.
    const refused = (await s.view.request("cli.run", { argv: ["wallets", "close-empty"], agent: "momentum" })) as { error?: { message: string } }
    expect(refused.error?.message).toContain("transfer:write")
  }, 30_000)

  test("where Candle keeps it off, the count says so in Candle's words, and nothing shows on the pane", async () => {
    const s = await setup({ off: true })
    await s.t.core.emptyAccounts.read(TEE)
    expect(s.t.core.emptyAccounts.get(TEE)).toMatchObject({ code: "CLOSE_EMPTY_DISABLED" })
  }, 30_000)
})
