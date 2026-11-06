// Funds out through the prompt pane: the owner's own vault-signed
// routes, `vault transfer`, `tee sweep` and `external sweep`, with `vault fund` and `vault demote` going
// by the same destination rules. From the agent, only when the user's own message this turn asked,
// naming where and how much; a look-alike refused; a new address amber and approved only by a click.
// Typed, the line is the ask, and the destination check still runs. The agent-key routes
// are held "coming", with why; the kill switch withdraws `vault transfer` and keeps the sweeps home.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { connectTestClient, type TestClient } from "../../test/core-test-client"
import { scripted } from "../../test/scripted-engine"
import { PANE_SOCKET_ENV, PANE_TICKET_ENV } from "../pane/launcher"
import { PROTOCOL_VERSION } from "../shared/rpc"
import type { Card } from "./cards"
import { classify, pausedStops } from "./classify"
import { CLI_ROWS, sourceFor } from "./cli-table"
import { describeTool, resolveCall } from "./cli-tool"
import { inGroupsOfFour } from "./destinations"
import { paneRowNow } from "./owner-rows"
import { type PaneResult, paneOutcome, paneSteps, planPane } from "./pane-plan"

const MAIN = join(import.meta.dir, "../main.ts")
const PASS = "correct horse battery staple"
const VAULT = "VaultFake11111111111111111111111111111111111"
const TEE = "TeeFake111111111111111111111111111111111111"
const EMBEDDED = "WalletFake111111111111111111111111111111111"
const LOOKALIKE = "VaultLook11111111111111111111111111111111111"
const NEW = "NewAddr2222222222222222222222222222222222222"

const OWNER_WALLETS = {
  embedded: { success: true, wallets: { solana: { address: EMBEDDED, delegated: true } } },
  linked: { success: true, isDone: true, page: [{ address: TEE, label: "tee-one", walletKind: "tee", chain: "solana", vaultDestination: VAULT }] },
}
const VAULT_LIST = {
  ok: true,
  entries: [
    { address: VAULT, label: "cold", id: "fake-vaultEntryId-1", role: "vault", origin: "derived", derivation: "m/44'/501'/0'/0'", exposure: "cold in this vault's record" },
    { address: TEE, label: "tee-one", id: "fake-vaultEntryId-2", role: "tee-wallet", origin: "derived", derivation: "m/44'/501'/0'/1'", exposure: "remotely exposed", teeLifecycle: "enabled" },
  ],
}

const dirs: string[] = []
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  cleanupHomes()
})

const finalArgs = (args: string[], o: { json: boolean; rpcUrl: boolean }) => [...args, ...(o.json ? ["--json"] : [])]
const resolveWords = (words: string[]) => {
  const [command, maybe, ...rest] = words
  const sub = maybe !== undefined && sourceFor(command!, maybe) !== undefined
  return resolveCall({ command, ...(sub ? { subcommand: maybe } : {}), args: sub ? rest : words.slice(1) }, { defaultAgent: "momentum", agents: new Set(["momentum"]) })
}
const resolve = (words: string[]) => {
  const r = resolveWords(words)
  if (!r.ok) throw new Error(`${words.join(" ")}: ${r.message}`)
  return r.call
}

describe("the table", () => {
  test("every funds-out row runs in the pane now, as the owner, with no factor step: each asks for it itself", () => {
    const rows = CLI_ROWS.filter((r) => r.rule === "funds-out" && r.route === "pane")
    expect(rows.map((r) => r.path).sort()).toEqual(["external sweep", "tee sweep", "vault transfer"])
    for (const row of rows) {
      expect(`${row.path}: ${paneRowNow(row.rule, row.route)}`).toBe(`${row.path}: true`)
      expect(`${row.path}: ${row.identity} ${row.pane!.factorFirst}`).toBe(`${row.path}: owner false`)
      expect(row.pane!.exit3).toBeDefined()
    }
  })

  test("each row's argv: the words as given, no --json, no --yes; --from and --to taken only where they name a key", () => {
    const rows: string[][] = [
      ["vault", "transfer", VAULT, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"],
      ["tee", "sweep", TEE],
      ["external", "sweep", "ext-1", "--to", "cold"],
      ["vault", "fund", TEE, "--amount", "0.02", "--asset", "SOL"],
      ["vault", "demote", TEE],
    ]
    for (const words of rows) {
      const call = resolve(words)
      const params = planPane({ row: call.row, rule: call.rule, identity: call.identity, words: call.argv, rpcUrl: false, finalArgs })
      expect(params.pane.steps).toEqual([{ stage: "command", argv: words }])
      expect(params.pane.identity).toBe("owner")
      expect(params.pane.agent).toBeUndefined()
    }
    expect(paneSteps(resolve(rows[0]!).row, planPane({ row: resolve(rows[0]!).row, rule: "funds-out", identity: "owner", words: rows[0]!, rpcUrl: false, finalArgs }))).toEqual([
      "the CLI asks for your vault passphrase itself, naming the send",
      "it prints the destination in full, in groups of four, and you type confirm",
    ])
    // --to is a path everywhere else; --from too.
    expect(resolveWords(["vault", "export-key", "main", "--to", "/tmp/k"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolveWords(["vault", "transfer", VAULT, "--amount", "1", "--asset", "SOL", "--from", "a", "--keystore", "/tmp/v"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
  })

  test("held, with why: candle transfer, and Candle's candle_transfer and candle_sweep need a Withdraw key", () => {
    const transfer = CLI_ROWS.find((r) => r.path === "transfer")!
    expect(transfer.held).toContain("Withdraw key")
    for (const tool of ["candle_transfer", "candle_sweep"]) {
      const c = classify(tool, {}, "live")
      expect(c).toMatchObject({ class: "refused", code: "TRANSFER_USER_ONLY" })
      expect((c as { reason: string }).reason).toContain("Withdraw key")
      expect((c as { reason: string }).reason).toContain("vault transfer")
    }
    expect(resolveWords(["transfer", "--wallet", TEE, "--to", "vault", "--amount", "1"]).ok).toBe(false)
  })

  test("the agent is told funds out are the user's, asked in their own words, and which run now", () => {
    const text = describeTool()
    const line = text.split("\n").find((l) => l.startsWith("Moving funds out"))!
    for (const path of ["vault transfer", "tee sweep", "external sweep", "vault fund"]) expect(line).toContain(path)
    expect(line).toContain("only when the user asks")
    // Each row's arguments, in the CLI's own usage, so a first try is right (without them a live
    // turn took four refusals to find them); and the click is the approval, not a step after it.
    expect(line).toContain("vault transfer <to> --amount <n> --asset SOL|<mint> --from <vault key or TEE wallet label>")
    expect(line).toContain("tee sweep <TEE wallet address>")
    expect(line).toContain("external sweep <external key label> --to <vault key label>")
    expect(line).toContain("vault fund <TEE wallet address or external key label> --amount <n> --asset SOL|USDC")
    expect(line).toContain("a new address shows amber on the card, and the user's click on it is the approval")
    expect(text).toContain("Not in the Candle Harness: transfer.")
  })
})

describe("the kill switch", () => {
  test("paused, it withdraws vault transfer and vault fund, and keeps the sweeps and vault demote: they bring funds home", () => {
    const card = (kind: "funds-out" | "owner", row: string) => ({ kind, tool: "candle_cli", row })
    expect(pausedStops(card("funds-out", "vault transfer"))).toBe(true)
    expect(pausedStops(card("owner", "vault fund"))).toBe(true)
    expect(pausedStops(card("funds-out", "tee sweep"))).toBe(false)
    expect(pausedStops(card("funds-out", "external sweep"))).toBe(false)
    expect(pausedStops(card("owner", "vault demote"))).toBe(false)
  })

  test("through a running core: a transfer card is withdrawn and a typed one refused; a sweep stays and opens", async () => {
    const s = await setup()
    const asked = await s.ask(`send 0.01 SOL from tee-one to cold`, { command: "vault", subcommand: "transfer", args: ["cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })
    const transfer = s.t.core.cards.get(asked.cardId)!
    const sweep = s.t.core.cards.get((await s.ask("sweep everything from tee-one home", { command: "tee", subcommand: "sweep", args: [TEE] })).cardId)!
    await s.view.request("kill", {})
    expect(transfer.state).toBe("withdrawn")
    expect(sweep.state).toBe("awaiting_approval")
    expect((await s.view.request("cli.run", { argv: ["vault", "transfer", VAULT, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })).error?.data?.code).toBe("PAUSED")
    expect(((await s.view.request("cli.run", { argv: ["external", "sweep", "ext-1", "--to", "cold"] })).result as { ticket?: string }).ticket).toStartWith("chp_")
  }, 30_000)
})

describe("asked for, from the agent", () => {
  test("vault demote: asked by name, a card that says the stop is permanent; unasked, refused", async () => {
    const s = await setup()
    const demote = { command: "vault", subcommand: "demote", args: [TEE] }
    expect((await s.ask("how are my wallets?", demote)).error.code).toBe("ASK_FOR_IT_YOURSELF")
    const card = s.t.core.cards.get((await s.ask("demote tee-one", demote)).cardId)!
    expect(card.display.warning).toContain("Permanent: Candle never re-enables a stopped TEE wallet, so it can never trade again.")
  }, 30_000)

  test("the user's words this turn name where and how much: a card quoting what goes where, no factor step", async () => {
    const s = await setup()
    const r = await s.ask("Send 0.01 SOL from tee-one to cold", { command: "vault", subcommand: "transfer", args: ["cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"], reason: "you asked to send 0.01 SOL to cold" })
    const card = s.t.core.cards.get(r.cardId)!
    expect(card).toMatchObject({ kind: "funds-out", route: "pane" })
    // The label goes on the command line as its address, which the CLI takes; the hash covers it.
    const params = card.params as { pane: { steps: { stage: string; argv: string[] }[] } }
    expect(params.pane.steps).toEqual([{ stage: "command", argv: ["vault", "transfer", VAULT, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] }])
    expect(card.display.headline).toStartWith("FUNDS OUT · candle vault transfer ")
    expect(card.display.headline).toEndWith("…1111 --amount 0.01 --asset SOL --from tee-one")
    expect(card.display.paneNotes?.join(" ")).toContain("to cold, a vault key on this machine (Vaul…1111)")
    expect(card.display.newAddress).toBeUndefined()
    expect(card.display.paneSteps?.[0]).toBe("the CLI asks for your vault passphrase itself, naming the send")
  }, 30_000)

  test("refused, with nothing made: no amount, no destination, another amount, unprompted, a harness with no turn", async () => {
    const s = await setup()
    const transfer = { command: "vault", subcommand: "transfer", args: ["cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] }
    for (const text of ["send some SOL to my vault", "send 0.01 SOL to my vault", "send 0.5 SOL to cold", "what's my balance?"]) {
      expect(`${text}: ${(await s.ask(text, transfer)).error?.code}`).toBe(`${text}: ASK_FOR_IT_YOURSELF`)
    }
    // A harness the user registered, with no turn of the core's engine: no message to have asked in.
    expect((await s.call(transfer)).error.code).toBe("ASK_FOR_IT_YOURSELF")
    // A sweep names the wallet and says everything.
    expect((await s.ask("move tee-one's funds home", { command: "tee", subcommand: "sweep", args: [TEE] })).error?.code).toBe("ASK_FOR_IT_YOURSELF")
    expect([...s.t.core.cards.list()].filter((c) => c.kind === "funds-out")).toEqual([])
    expect(s.t.core.journal.rows().filter((r) => r.type === "tool.refused" && r.code === "ASK_FOR_IT_YOURSELF").length).toBe(6)
  }, 60_000)

  test("a previous turn's message doesn't count: each turn is asked on its own", async () => {
    const s = await setup()
    const transfer = { command: "vault", subcommand: "transfer", args: ["cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] }
    expect((await s.ask("send 0.01 SOL to cold", transfer)).cardId).toBeDefined()
    expect((await s.ask("and once more", transfer)).error?.code).toBe("ASK_FOR_IT_YOURSELF")
  }, 30_000)

  test("a look-alike of a known address is refused, naming the one it looks like", async () => {
    const s = await setup()
    const r = await s.ask(`send 0.01 SOL to ${LOOKALIKE}`, { command: "vault", subcommand: "transfer", args: [LOOKALIKE, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })
    expect(r.error).toMatchObject({ code: "LOOKALIKE_DESTINATION" })
    expect(r.error.message).toContain("cold")
  }, 30_000)

  test("a new address: the card shows it amber in groups of four, Enter is refused, a click opens the pane", async () => {
    const s = await setup()
    const r = await s.ask(`send 0.01 SOL to ${NEW}`, { command: "vault", subcommand: "transfer", args: [NEW, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })
    const card = s.t.core.cards.get(r.cardId)!
    expect(card.display.newAddress).toBe(inGroupsOfFour(NEW))
    for (const how of ["enter", "view", "typed", "instant"]) {
      const answer = await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how })
      expect(`${how}: ${answer.error?.data?.code}`).toBe(`${how}: NEW_ADDRESS_NEEDS_A_CLICK`)
    }
    expect(card.state).toBe("awaiting_approval")
    const opened = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "click" })).result as { kind: string; ticket: string }
    expect(opened).toMatchObject({ kind: "pane" })
    expect(opened.ticket).toStartWith("chp_")
    expect(card.approvedHow).toBe("click")
  }, 30_000)

  test("tee sweep: still enabled, the card says so and offers tee disable first, as a line to type", async () => {
    const s = await setup({}, { teeActive: true })
    const card = s.t.core.cards.get((await s.ask("sweep everything from tee-one", { command: "tee", subcommand: "sweep", args: ["tee-one"] })).cardId)!
    // By its address: TEE commands take the address, not the label.
    expect((card.params as { pane: { steps: { argv: string[] }[] } }).pane.steps.at(-1)!.argv).toEqual(["tee", "sweep", TEE])
    expect(card.display.paneNotes?.join(" ")).toContain("to its pinned vault, cold, a vault key on this machine")
    expect(card.display.warning).toContain("still enabled")
    expect(card.display.fills).toEqual([{ label: "disable it first", line: `candle tee disable ${TEE}` }])
  }, 30_000)
})

describe("typed: the line is the ask, and the destination check still runs", () => {
  test("a look-alike is refused with why, and nothing is made", async () => {
    const s = await setup()
    const answer = await s.view.request("cli.run", { argv: ["vault", "transfer", LOOKALIKE, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })
    expect(answer.error?.data?.code).toBe("LOOKALIKE_DESTINATION")
    expect(answer.error?.message).toContain("Nothing was run")
    expect([...s.t.core.cards.list()]).toEqual([])
  }, 30_000)

  test("a known destination opens the pane at once", async () => {
    const s = await setup()
    const r = (await s.view.request("cli.run", { argv: ["vault", "transfer", "cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })).result as { ticket: string; card: Card }
    expect(r.ticket).toStartWith("chp_")
    expect(s.t.core.cards.get(r.card.cardId)!.approvedHow).toBe("typed")
  }, 30_000)

  test("a new address becomes the amber card, not approved: a click does that", async () => {
    const s = await setup()
    const r = (await s.view.request("cli.run", { argv: ["vault", "transfer", NEW, "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })).result as { kind: string; cardId: string }
    expect(r).toMatchObject({ kind: "card", newAddress: true })
    const card = s.t.core.cards.get(r.cardId)!
    expect(card.state).toBe("awaiting_approval")
    expect(card.display.newAddress).toBe(inGroupsOfFour(NEW))
    expect(s.t.core.journal.rows().some((row) => row.type === "card.approved")).toBe(false)
  }, 30_000)
})

describe("the outcome words", () => {
  const opts = (path: string) => ({ fundsOut: true, ...(resolve(path.split(" ")).row.pane!.exit3 ? { exit3: resolve(path.split(" ")).row.pane!.exit3! } : {}) })
  test("exit 3: each row says what may still land and what to check, never that it failed", () => {
    expect(paneOutcome({ stage: "command", exit: 3 }, opts(`vault transfer ${VAULT}`)).words).toBe("sent, but not finalized yet (exit 3): it may still land. Check the signature on an explorer before sending again.")
    expect(paneOutcome({ stage: "command", exit: 3 }, opts(`tee sweep ${TEE}`)).words).toContain("Run the same candle tee sweep again to reconcile")
    expect(paneOutcome({ stage: "command", exit: 3 }, opts("external sweep ext-1")).words).toContain("Check the signatures on an explorer")
    expect(paneOutcome({ stage: "command", exit: 3 }, opts(`vault transfer ${VAULT}`)).outcome).toBe("pending")
    // A stop after the send started may still land too.
    expect(paneOutcome({ stage: "command", stopped: true }, opts(`vault transfer ${VAULT}`)).words).toContain("may still land")
  })
})

describe("in the pane", () => {
  test("vault list: only addresses and labels come back, kept 0600, and its vault keys become known destinations", async () => {
    const s = await setup({ ownerWallets: { embedded: OWNER_WALLETS.embedded, linked: { success: true, page: [] } } })
    // Before: cold isn't known, so a typed transfer to it is refused.
    expect((await s.view.request("cli.run", { argv: ["vault", "transfer", "cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })).error?.data?.code).toBe("UNKNOWN_DESTINATION")
    const r = (await s.view.request("cli.run", { argv: ["vault", "list"] })).result as { ticket: string; ticketId: string; card: Card }
    const pane = await openPane(s.t, s.view, r, s.dir)
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await pane.proc.exited
    await until(() => s.t.core.operations.get(r.card.opId)?.state === "succeeded")
    // The pane and the outcome count the same entries (they once said "2" and "1").
    expect(pane.screen()).toContain("Kept as places funds may go: 1 vault key and 1 TEE wallet, addresses and labels only.")
    expect(told(s.t, r.card.opId).words).toBe("finished in the pane: the Candle Harness now knows 1 vault key and 1 TEE wallet as places funds may go.")
    const saved = JSON.parse(readFileSync(s.t.p.destinations, "utf8"))
    expect(saved).toEqual({ vaultList: [{ address: VAULT, label: "cold", kind: "vault-key" }, { address: TEE, label: "tee-one", kind: "tee" }] })
    expect(statSync(s.t.p.destinations).mode & 0o777).toBe(0o600)
    // Nothing else of the list went anywhere: not its ids, derivations or exposure.
    const journal = readFileSync(s.t.p.journal, "utf8")
    for (const word of ["fake-vaultEntryId-1", "m/44'/501'", "cold in this vault's record"]) {
      expect(journal).not.toContain(word)
      for (const frame of [...s.view.frames, ...s.harness.frames]) expect(frame).not.toContain(word)
    }
    // After: a typed transfer to cold opens the pane at once.
    expect(((await s.view.request("cli.run", { argv: ["vault", "transfer", "cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })).result as { ticket?: string }).ticket).toStartWith("chp_")
  }, 30_000)

  test("vault transfer: the CLI asks for the factor, prints the destination in groups of four and takes confirm; anything else sends nothing", async () => {
    const s = await setup()
    const card = s.t.core.cards.get((await s.ask("send 0.01 SOL to cold", { command: "vault", subcommand: "transfer", args: ["cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })).cardId)!
    const opened = (await s.view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "click" })).result as { ticket: string; ticketId: string }
    const pane = await openPane(s.t, s.view, opened, s.dir)
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await until(() => pane.screen().includes("Type confirm"))
    expect(pane.screen()).toContain(`To: ${inGroupsOfFour(VAULT)}`)
    pane.type("no\r")
    await pane.proc.exited
    await until(() => s.t.core.operations.get(card.opId)?.state === "failed")
    expect(told(s.t, card.opId).outcome).toBe("didnt_finish")
    // The core never runs it again.
    await Bun.sleep(200)
    expect(runs(s.dir).filter((x) => x.argv[0] === "vault" && x.argv[1] === "transfer")).toHaveLength(1)
  }, 30_000)

  test("an exit 3 is pending, with what to check, and nothing re-runs", async () => {
    const s = await setup({ paneOutcome: 3 })
    const r = (await s.view.request("cli.run", { argv: ["vault", "transfer", "cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })).result as { ticket: string; ticketId: string; card: Card }
    const pane = await openPane(s.t, s.view, r, s.dir)
    await until(() => pane.screen().includes("Vault passphrase"))
    pane.type(`${PASS}\r`)
    await until(() => pane.screen().includes("Type confirm"))
    pane.type("confirm\r")
    await pane.proc.exited
    await until(() => s.t.core.operations.get(r.card.opId)?.state === "unknown")
    expect(told(s.t, r.card.opId).words).toContain("Check the signature on an explorer before sending again")
    await Bun.sleep(300)
    expect(runs(s.dir).filter((x) => x.argv[0] === "vault" && x.argv[1] === "transfer")).toHaveLength(1)
  }, 30_000)
})

// ---- harness ----

const cliDir = (script: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), "funds-cli-"))
  dirs.push(dir)
  writeFileSync(join(dir, "fake-cli.json"), JSON.stringify(script))
  return dir
}
const runs = (dir: string): { argv: string[] }[] => {
  try {
    return readFileSync(join(dir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const told = (t: TestCore, opId: string) => (t.core.operations.get(opId)!.result as { pane: PaneResult }).pane

/**
 * A core whose engine plays one turn a message: in it, the agent calls candle_cli with the args the
 * test gave, through the token the turn was minted, as Claude Code would. The known list: the owner's
 * wallets read, and (unless replaced) `cold` from a vault list.
 */
async function setup(script: Record<string, unknown> = {}, opts: { teeActive?: boolean } = {}) {
  const dir = cliDir({ vault: { passphrase: PASS }, ownerWallets: OWNER_WALLETS, vaultList: VAULT_LIST, ...script })
  let pending: { args: Record<string, unknown>; settle: (v: Record<string, unknown>) => void } | undefined
  let socket = ""
  const engine = scripted([
    async (turn, push) => {
      const job = pending!
      const config = JSON.parse(readFileSync(turn.mcpConfig, "utf8")) as { mcpServers: { candle: { args: string[] } } }
      const token = readFileSync(config.mcpServers.candle.args.at(-1)!, "utf8").trim()
      const client = await connectTestClient(socket)
      await client.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "engine" })
      const answer = await client.request("tools.call", { name: "candle_cli", args: job.args })
      job.settle(JSON.parse((answer.result as { content: { text: string }[] }).content[0]!.text))
      push({ type: "done", text: "ok" })
    },
  ])
  // The portfolio lists the TEE wallet as Candle's active one: still enabled, as far as Candle says.
  const tee = { teeWallets: [{ id: "teefakeid1", address: TEE, label: "tee-one", boundKeyPrefix: "Nobody00", active: true }] }
  const t = await startTestCore(
    {
      env: { ...process.env, CANDLE_CONFIG_DIR: dir },
      engine: { start: engine.start, version: () => ({ ok: true, version: "2.1.310" }), processes: () => [], leftoverDelayMs: 10 },
    },
    opts.teeActive ? { candle: { momentum: tee, swing: tee } } : {},
  )
  cores.push(t)
  socket = t.p.socket
  const view = await t.view()
  const { client: harness } = await t.harness(view)
  // The vault keys `vault list` would add (the owner's wallets read comes when a card is proposed).
  if (script.ownerWallets === undefined) await t.core.destinations.setVaultList([{ address: VAULT, label: "cold", kind: "vault-key" }])
  if (opts.teeActive) await until(() => t.core.wallets.view().account.some((w) => w.address === TEE), 15_000)
  const call = async (args: Record<string, unknown>) => JSON.parse(((await harness.request("tools.call", { name: "candle_cli", args })).result as { content: { text: string }[] }).content[0]!.text)
  /** The user's message, then the agent's call in that turn: what the call answered. */
  const ask = async (text: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const answered = new Promise<Record<string, unknown>>((settle) => (pending = { args, settle }))
    await view.request("agent.send", { text })
    const r = (await answered) as Record<string, any>
    // A card answers "approval required" with its id; anything else that isn't a success is a refusal.
    return r.cardId !== undefined ? r : r.success === false ? { error: r.error } : r
  }
  return { t, view, harness, call, ask, dir }
}

interface Pane {
  proc: Bun.Subprocess
  screen(): string
  type(text: string): void
}

async function openPane(t: TestCore, view: TestClient, opened: { ticket: string; ticketId: string }, dir: string): Promise<Pane> {
  let out = ""
  const decoder = new TextDecoder()
  const proc = Bun.spawn([process.execPath, MAIN, "cli-pane"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", TERM: "xterm-256color", CANDLE_CONFIG_DIR: dir, [PANE_TICKET_ENV]: opened.ticket, [PANE_SOCKET_ENV]: t.p.socket },
    terminal: { cols: 100, rows: 30, data: (_t, chunk) => void (out += decoder.decode(chunk, { stream: true })) },
  })
  expect((await view.request("pane.spawned", { ticketId: opened.ticketId, pid: proc.pid })).result).toEqual({ ok: true })
  return { proc, screen: () => out, type: (text) => void proc.terminal!.write(text) }
}
