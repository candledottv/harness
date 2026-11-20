// Offline own-balance transfer contracts (BE-3765, SendAsset only) from an exact clean Candle source
// checkout: the pre-sign check every package ships (SDK, MCP and CLI copies), `candle perps transfer`'s
// prompts and refusals, and the MCP tool and SDK method that do the same. All venue and API data is
// synthetic, every fetch is intercepted, and each surface stops at its own prompt, at `submit: false`,
// or before the relay is asked to sign. No real key, balance, signature, transfer or network.
//   bun scripts/read-transfer-source.ts <candle-monorepo checkout>
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-transfer-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const COPIES = ["packages/sdk/src/hyperliquid-transfer.ts", "packages/mcp/src/hyperliquid-transfer.ts", "packages/cli/src/hyperliquid-transfer.ts"] as const
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/mcp", "packages/sdk", "apps/api/src/lib/perps-transfer.ts")
const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(checkout, path))).digest("hex")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  // The transfer check is one file copied into the three packages; the recording holds only if they agree.
  transferCheck: { files: [...COPIES], sha256: sha256(COPIES[0]) },
}
for (const path of COPIES) assert.equal(sha256(path), source.transferCheck.sha256, `${path} is not the SDK's transfer check`)
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({ name: "transfer-source-workspaces", setup(build) {
  build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
} })
const originalFetch = globalThis.fetch
const originalNow = Date.now
const NOW = 1_790_000_000_000
globalThis.fetch = (() => { throw new Error("transfer recording may not access the network") }) as unknown as typeof fetch
Date.now = () => NOW
const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
const fakeAddress = (n: string) => `0x${n.padStart(40, "0")}`
const ADDRESS = fakeAddress("9"), OTHER = fakeAddress("8")
const USDC = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"
const SIG = `0x${"11".repeat(65)}`
const dir = mkdtempSync(join(tmpdir(), "candle-transfer-source-"))
const pemFile = join(dir, "signer.pem")
writeFileSync(pemFile, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString())

type Request = { method: string; host?: string; path: string; body?: Record<string, unknown> }
type Row = { id: string; surface: string; tool?: string; evidence?: string; args: Record<string, unknown>; requests?: Request[]; outcome: any }
const rows: Row[] = []
const NONCE = NOW

/** The build Candle returns for an own-wallet SendAsset, in the shape the pure builder gives (apps/api perps-transfer.ts). */
const sendAsset = (over: { id: string; mode: "toDex" | "fromDex"; dex: string; amount: string; message?: Record<string, unknown>; top?: Record<string, unknown> }) => {
  const message = {
    hyperliquidChain: "Mainnet", destination: ADDRESS, sourceDex: over.mode === "toDex" ? "" : over.dex, destinationDex: over.mode === "toDex" ? over.dex : "",
    token: USDC, amount: over.amount, fromSubAccount: "", nonce: NONCE, ...(over.message ?? {}),
  }
  return {
    id: over.id, status: "built", mode: over.mode, dex: over.dex, amountUsdc: over.amount, nonce: NONCE, walletId: "wallet",
    typedData: {
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: `0x${"0".repeat(40)}` },
      types: { "HyperliquidTransaction:SendAsset": Object.keys({ hyperliquidChain: 0, destination: 0, sourceDex: 0, destinationDex: 0, token: 0, amount: 0, fromSubAccount: 0, nonce: 0 }).map((name) => ({ name, type: name === "nonce" ? "uint64" : "string" })) },
      primary_type: "HyperliquidTransaction:SendAsset", message,
    },
    action: { type: "sendAsset", signatureChainId: "0xa4b1", ...message }, ...(over.top ?? {}),
  }
}

try {
  // 1. The transfer check through its SDK, MCP and CLI copies: they give the same answer each time.
  const copies = await Promise.all(COPIES.map(async (p) => (await load(p)).verifyOwnTransferBuild as (b: any, e: any) => string | null))
  const check = (id: string, build: any, expect: Record<string, unknown>, evidenceNote?: string) => {
    const answers = copies.map((fn) => fn(build, expect))
    for (const a of answers) assert.equal(a, answers[0], `${id}: the SDK, MCP and CLI copies differ`)
    rows.push({ id: `check-${id}`, surface: "check", ...(evidenceNote ? { evidence: evidenceNote } : {}), args: { expect: { ...expect, amountMicros: expect.amountMicros === null ? null : String(expect.amountMicros) } }, outcome: { refusal: answers[0] } })
    return answers[0]
  }
  const to = { id: "t1", account: ADDRESS, mode: "toDex", dex: "xyz", amountMicros: 5_000_000n }
  const from = { id: "t2", account: ADDRESS, mode: "fromDex", dex: "xyz", amountMicros: 5_000_000n }
  assert.equal(check("honest-to-dex", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5" }), to), null)
  assert.equal(check("honest-from-dex", sendAsset({ id: "t2", mode: "fromDex", dex: "xyz", amount: "5" }), from), null)
  assert.equal(check("honest-all-any-amount", sendAsset({ id: "t2", mode: "fromDex", dex: "xyz", amount: "12.345678" }), { ...from, amountMicros: null }), null)
  const hostile: [string, any, Record<string, unknown>][] = [
    ["foreign-destination", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", message: { destination: OTHER } }), to],
    ["foreign-destination-in-action-only", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", top: { action: { ...sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5" }).action, destination: OTHER } } }), to],
    ["other-token", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", message: { token: "PURR:0xc4bf3f870c0e9465323c0b6ed28096c2" } }), to],
    ["sub-account", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", message: { fromSubAccount: OTHER } }), to],
    ["another-dex", sendAsset({ id: "t1", mode: "toDex", dex: "abc", amount: "5" }), to],
    ["wrong-direction", sendAsset({ id: "t1", mode: "fromDex", dex: "xyz", amount: "5" }), to],
    ["amount-differs", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "50" }), to],
    ["other-transfer-id", sendAsset({ id: "t9", mode: "toDex", dex: "xyz", amount: "5" }), to],
    ["testnet-chain", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", message: { hyperliquidChain: "Testnet" } }), to],
    ["untrusted-domain", { ...sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5" }), typedData: { ...sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5" }).typedData, domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 1, verifyingContract: `0x${"0".repeat(40)}` } } }, to],
    ["action-differs-from-message", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", top: { action: { ...sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5" }).action, amount: "6" } } }), to],
    ["no-nonce", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", top: { nonce: 0 } }), to],
    ["missing-typed-data", { id: "t1", status: "built", mode: "toDex", dex: "xyz", nonce: NONCE }, to],
  ]
  for (const [id, build, expect] of hostile) assert.notEqual(check(`refused-${id}`, build, expect), null, `${id} must be refused`)
  // A perps-to-spot build isn't something this release asks for; the shared checker still names it, and still refuses a wrong direction.
  assert.notEqual(check("refused-spot-mode-on-a-dex-build", sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5" }), { ...to, mode: "toSpot", dex: undefined }), null)

  // 2. The CLI: what it shows before the prompt, a hostile build refused before the relay, local refusals with
  //    nothing requested, and the API's refusals passed through with their code.
  const cli = await load("packages/cli/src/commands/perps-transfer.ts")
  const { createCapture, createTestDeps, createFakeStore } = await load("packages/cli/src/test-support.ts")
  const { pemToStoredSigner } = await load("packages/cli/src/secret-store.ts")
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const wallets = { scopes: ["perps:write"], privyAppId: "fixture-app", page: [{ id: "wallet", address: ADDRESS, label: "perps", chain: "evm", active: true, allowLaunch: false, privyWalletId: "fixture-privy" }], isDone: true }
  const runCli = (argv: string[], answer: (path: string, body: any) => unknown, opts: { json?: boolean; prompt?: string; sign?: boolean; wallets?: typeof wallets } = {}) =>
    runCmd(cli.perpsTransfer, argv, answer, opts)
  const runCmd = async (cmd: (args: string[], ctx: any) => Promise<number>, argv: string[], answer: (path: string, body: any) => unknown, opts: { json?: boolean; prompt?: string; sign?: boolean; wallets?: typeof wallets } = {}) => {
    const requests: Request[] = []
    const stdout = createCapture(), stderr = createCapture()
    let shown = "", stop = "exit"
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method: init?.method ?? "GET", host: u.host, path: u.pathname, ...(u.pathname === "/api/v1/agent/perps/transfer" && body ? { body } : {}) })
      // The full-flow rows (opts.sign) let the recorder answer the relay, the venue and the acknowledgement itself.
      if (u.pathname.endsWith("/sign")) {
        if (opts.sign) return Response.json({ success: true, signature: SIG })
        shown = stderr.text; stop = "before-relay"; throw new Error("offline recorder stops before signing")
      }
      if (u.host === "api.hyperliquid.xyz") return Response.json({ status: "ok", response: { type: "default" } })
      if (u.pathname === "/api/v1/agent/wallets/trading") return Response.json(opts.wallets ?? wallets)
      if (u.pathname === "/api/v1/agent/perps/transfer/submitted") return Response.json({ success: true, status: "submitted", id: body?.clientTransferId })
      const reply = answer(u.pathname, body)
      if (reply instanceof Response) return reply
      if (reply === undefined) throw new Error(`unexpected request ${u.host}${u.pathname}`)
      return Response.json(reply)
    }
    const deps = createTestDeps({ stdout, stderr, now: () => NOW, fetch: fetcher,
      env: { CANDLE_API_KEY: cfg.apiKey },
      store: createFakeStore({ wallet_signer_wallet: pemToStoredSigner(ephemeral) }),
      promptLine: async () => { shown = stderr.text; stop = "before-prompt"; return opts.prompt ?? "n" },
    })
    const exitCode = await cmd(argv, { deps, apiUrl: cfg.apiUrl, json: opts.json === true })
    return { exitCode, stop, shown, stdout: stdout.text, stderr: stderr.text, requests }
  }
  // The lines before the confirm: the id, the amount and the two balances. The wallet address stays out of a fixture.
  const shownLines = (shown: string) => shown.split("\n").filter((l) => /^\s*(Transfer|Amount|From|To)\b/.test(l)).map((l) => l.trim().replace(/\s+/g, " "))
  const buildFor = (argv: string[]) => {
    const mode = argv.includes("--to-dex") ? "toDex" : "fromDex"
    const dex = argv[argv.indexOf(mode === "toDex" ? "--to-dex" : "--from-dex") + 1] as string
    const id = argv[argv.indexOf("--id") + 1] as string
    return sendAsset({ id, mode, dex, amount: "5" })
  }
  const transferPath = "/api/v1/agent/perps/transfer"
  const cases: [string, string[]][] = [
    ["to-dex", ["--to-dex", "xyz", "5", "--id", "t1", "--wallet", "perps"]],
    ["from-dex", ["--from-dex", "xyz", "5", "--id", "t2", "--wallet", "perps"]],
    ["from-dex-all", ["--from-dex", "xyz", "--all", "--id", "t3", "--wallet", "perps"]],
  ]
  for (const [id, argv] of cases) for (const yes of [false, true]) {
    const run = [...argv, ...(yes ? ["--yes"] : [])]
    const r = await runCli(run, (path, body) => {
      if (path !== transferPath) return undefined
      assert.equal(body.walletId, "wallet")
      assert.equal(body.clientTransferId, argv[argv.indexOf("--id") + 1])
      assert.equal("destination" in body, false, "the request never names a destination")
      return buildFor(argv)
    })
    assert.equal(r.stop, yes ? "before-relay" : "before-prompt", r.stdout + r.stderr)
    assert.ok(!r.requests.some((q) => q.host === "api.hyperliquid.xyz"), "nothing goes to the venue")
    if (!yes) assert.ok(!r.requests.some((q) => q.path === transferPath), "a declined prompt builds nothing")
    rows.push({ id: `cli-${id}-${yes ? "yes" : "prompt"}`, surface: "cli", args: { argv: run.map((a) => (a === "perps" ? "<tee>" : a)) }, requests: r.requests,
      outcome: { stop: r.stop, exitCode: r.exitCode, disclosure: shownLines(r.shown) } })
  }
  {
    const argv = ["--to-dex", "xyz", "5", "--id", "t1", "--wallet", "perps", "--yes", "--no-submit"]
    const r = await runCli(argv, (path) => path === transferPath ? buildFor(argv) : undefined, { json: true })
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    assert.ok(!r.requests.some((q) => q.path.endsWith("/sign")))
    rows.push({ id: "cli-no-submit-builds-and-checks-only", surface: "cli", args: { argv: argv.map((a) => (a === "perps" ? "<tee>" : a)) }, requests: r.requests, outcome: { exitCode: r.exitCode, submitted: JSON.parse(r.stdout).submitted, status: JSON.parse(r.stdout).status } })
  }
  for (const [id, message] of [["foreign-destination", { destination: OTHER }], ["other-token", { token: "PURR:0xc4bf3f870c0e9465323c0b6ed28096c2" }], ["sub-account", { fromSubAccount: OTHER }]] as const) {
    const argv = ["--to-dex", "xyz", "5", "--id", "t1", "--wallet", "perps", "--yes"]
    const r = await runCli(argv, (path) => path === transferPath ? sendAsset({ id: "t1", mode: "toDex", dex: "xyz", amount: "5", message }) : undefined, { json: true })
    assert.equal(r.stop, "exit")
    assert.ok(!r.requests.some((q) => q.path.endsWith("/sign")), "a refused build never reaches the relay")
    rows.push({ id: `cli-hostile-${id}`, surface: "cli", args: { argv: argv.map((a) => (a === "perps" ? "<tee>" : a)) }, requests: r.requests, outcome: { exitCode: r.exitCode, body: JSON.parse(r.stdout || r.stderr) } })
  }
  const local: [string, string[]][] = [
    ["to-spot", ["--to-spot", "5", "--yes"]],
    ["from-spot", ["--from-spot", "--all", "--yes"]],
    ["to-spot-with-dex", ["--to-dex", "xyz", "--to-spot", "5", "--yes"]],
    ["both-directions", ["--to-dex", "xyz", "--from-dex", "xyz", "5", "--yes"]],
    ["no-direction", ["5", "--yes"]],
    ["all-into-a-dex", ["--to-dex", "xyz", "--all", "--yes"]],
    ["all-with-an-amount", ["--from-dex", "xyz", "--all", "5", "--yes"]],
    ["spot-as-a-dex-name", ["--to-dex", "spot", "5", "--yes"]],
    ["dex-name-with-a-dash", ["--to-dex", "x-y", "5", "--yes"]],
    ["zero-amount", ["--to-dex", "xyz", "0", "--yes"]],
    ["seven-decimals", ["--to-dex", "xyz", "1.0000001", "--yes"]],
    ["no-amount", ["--to-dex", "xyz", "--yes"]],
    ["bad-id", ["--to-dex", "xyz", "5", "--id", "has space", "--yes"]],
  ]
  for (const [id, argv] of local) {
    const r = await runCli(argv, () => undefined, { json: true })
    assert.equal(r.requests.length, 0, `${id} requests nothing`)
    assert.notEqual(r.exitCode, 0)
    rows.push({ id: `cli-local-${id}`, surface: "cli", args: { argv }, requests: [], outcome: { exitCode: r.exitCode, body: JSON.parse(r.stdout || r.stderr) } })
  }
  // The API's own refusals, as it answers them (codes from apps/api routes/agent-perps-transfer.ts). The keyed route is not run.
  const apiRefusals: [string, string, string[]][] = [
    ["unknown-dex", "PERPS_TRANSFER_DEX_REFUSED", ["--to-dex", "nodex", "5"]],
    ["non-usdc-collateral-dex", "PERPS_TRANSFER_DEX_REFUSED", ["--to-dex", "hyna", "5"]],
    ["amount-above-source-balance", "PERPS_TRANSFER_EXCEEDS_SOURCE", ["--from-dex", "xyz", "1000000"]],
    ["nothing-to-move", "PERPS_TRANSFER_NOTHING_TO_MOVE", ["--from-dex", "xyz", "--all"]],
  ]
  for (const [id, code, tail] of apiRefusals) {
    const argv = [...tail, "--id", "t1", "--wallet", "perps", "--yes"]
    const r = await runCli(argv, (path) => path === transferPath ? new Response(JSON.stringify({ success: false, error: { code, message: `refused: ${id}` } }), { status: 400, headers: { "content-type": "application/json" } }) : undefined, { json: true })
    assert.ok(!r.requests.some((q) => q.path.endsWith("/sign")))
    assert.equal(JSON.parse(r.stdout || r.stderr).code, code)
    rows.push({ id: `cli-refused-${id}`, surface: "cli", evidence: "response-stub: the code is the API route's own; the keyed API route is not executed", args: { argv: argv.map((a) => (a === "perps" ? "<tee>" : a)) }, requests: r.requests, outcome: { exitCode: r.exitCode, code } })
  }

  // 2b. The happy path and the read-backs (BE-3910), every stand-in answered by the recorder: the
  //     relay's signature, the venue and the acknowledgement. Nothing is signed with a real key.
  const flowCases: [string, string[], string][] = [
    ["to-dex", ["--to-dex", "xyz", "5", "--id", "t1", "--wallet", "perps", "--yes"], "Moved 5 USDC: Main perps -> builder dex xyz."],
    ["from-dex-all", ["--from-dex", "xyz", "--all", "--id", "t3", "--wallet", "perps", "--yes"], "Moved 5 USDC: builder dex xyz -> Main perps."],
  ]
  for (const [id, argv, moved] of flowCases) {
    const r = await runCli(argv, (path) => (path === transferPath ? buildFor(argv) : undefined), { json: true, sign: true })
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    assert.ok(r.stderr.includes(moved), r.stderr)
    const order = r.requests.map((q) => `${q.host === "api.hyperliquid.xyz" ? "venue:" : ""}${q.path}`)
    const at = (needle: string) => order.findIndex((p) => p === needle || p.endsWith(needle))
    assert.ok(at(transferPath) < at("/wallets/wallet/sign") && at("/wallets/wallet/sign") < at("venue:/exchange")
      && at("venue:/exchange") < at("/perps/transfer/submitted"), JSON.stringify(order))
    rows.push({ id: `cli-${id}-full-flow-synthetic-venue`, surface: "cli", evidence: "stand-in: the relay and the venue are answered by the recorder; nothing is signed with a real key",
      args: { argv }, requests: r.requests, outcome: { exitCode: r.exitCode, notice: moved } })
  }
  {
    // The transfer's own read-back: `candle perps transfer status` after the move.
    const r = await runCli(["status", "t1"], (path) => (path === "/api/v1/agent/perps/transfer/t1"
      ? { success: true, id: "t1", status: "submitted", amountUsdc: "5", mode: "toDex" } : undefined), { json: true })
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    rows.push({ id: "cli-status-read-back", surface: "cli", evidence: "response-stub: the read is the API route's own shape; the keyed route is not executed",
      args: { argv: ["status", "t1"] }, requests: r.requests, outcome: { exitCode: r.exitCode, body: JSON.parse(r.stdout) } })
  }
  {
    // The balances read-back: `candle perps positions` reports the main perps balance that moved.
    const perps = await load("packages/cli/src/commands/perps.ts")
    const r = await runCmd(perps.perpsPositions, ["--wallet", "perps"], (path) => (path === "/api/v1/agent/perps/positions"
      ? { success: true, address: ADDRESS, network: "hyperliquid", mode: "cross", withdrawable: "12", positions: [], openWithdrawals: [] } : undefined))
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    const withdrawable = r.stdout.split("\n").find((l: string) => l.includes("Withdrawable now"))?.trim().replace(/\s+/g, " ")
    assert.equal(withdrawable, "Withdrawable now 12 USDC", r.stdout)
    rows.push({ id: "cli-positions-read-back", surface: "cli", evidence: "stand-in: the direct Hyperliquid reads are answered by the recorder and fail closed; the balance line is the API route's own",
      args: { argv: ["positions", "--wallet", "perps"] }, requests: r.requests, outcome: { exitCode: r.exitCode, withdrawable } })
  }
  {
    // The sweep before a withdrawal, and its read-back of the resulting balances: the first build
    // answers `sweeping` with one own-balance move and the balances that stay; the move runs on the
    // same stand-ins, and the re-asked build answers a withdrawal past its quote, so nothing else signs.
    const withdraw = await load("packages/cli/src/commands/perps-withdraw.ts")
    const next = { ...sendAsset({ id: "child-xyz", mode: "fromDex", dex: "xyz", amount: "2" }), signature: SIG }
    const builds = [
      { id: "w1", status: "sweeping", nextTransfer: next, retained: [{ dex: "xyz", amountUsdc: "40" }] },
      { id: "w1", status: "settled", amountUsdc: "5", to: { chain: "hood", address: ADDRESS } },
    ]
    const r = await runCmd(withdraw.perpsWithdraw, ["5", "--to", "hood", "--id", "w1", "--wallet", "perps"],
      (path) => (path === "/api/v1/agent/perps/withdraw" ? builds.shift() : undefined),
      { prompt: "confirm", sign: true, wallets: { ...wallets, scopes: ["perps:withdraw"] } })
    assert.equal(r.exitCode, 0, r.stdout + r.stderr)
    const retained = r.stderr.split("\n").find((l: string) => l.includes("Retained balances"))?.trim().replace(/\s+/g, " ")
    assert.ok(retained && retained.includes("xyz") && retained.includes("40"), r.stderr)
    const order = r.requests.map((q) => `${q.host === "api.hyperliquid.xyz" ? "venue:" : ""}${q.path}`)
    assert.ok(order.indexOf("venue:/exchange") < order.lastIndexOf("/api/v1/agent/perps/withdraw"), JSON.stringify(order))
    rows.push({ id: "cli-withdraw-sweep-read-back", surface: "cli", evidence: "stand-in: the venue and the acknowledgement are answered by the recorder; the withdrawal never reaches a quote, so the vault gate never opens",
      args: { argv: ["5", "--to", "hood", "--id", "w1", "--wallet", "perps"] }, requests: r.requests, outcome: { exitCode: r.exitCode, retained } })
  }

  // 3. The MCP tool and the SDK method on the same builds and refusals.
  const mcp = await load("packages/mcp/src/perps-transfer.ts")
  const { CandleClient } = await load("packages/sdk/src/index.ts")
  const mcpFetch = (answer: (path: string, body: any) => unknown, requests: Request[]) => async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method: init?.method ?? "GET", host: u.host, path: u.pathname, ...(u.pathname === transferPath && body ? { body } : {}) })
    const reply = u.pathname === "/api/v1/agent/wallets/trading" ? wallets : u.pathname.endsWith("/sign") ? { success: true, signature: SIG }
      : u.host === "api.hyperliquid.xyz" ? { status: "ok", response: { type: "default" } } : u.pathname.endsWith("/transfer/submitted") ? { success: true, status: "submitted", id: body?.clientTransferId } : answer(u.pathname, body)
    if (reply instanceof Response) return reply
    if (reply === undefined) throw new Error(`unexpected request ${u.host}${u.pathname}`)
    return new Response(JSON.stringify(reply), { status: 200 })
  }
  const venueSeen = (requests: Request[]) => requests.some((q) => q.host === "api.hyperliquid.xyz")
  const mcpRun = async (args: Record<string, unknown>, answer: (path: string, body: any) => unknown, env: Record<string, string | undefined> = {}) => {
    const requests: Request[] = []
    const r = await mcp.executePerpsTransfer(args, cfg, env, mcpFetch(answer, requests))
    return { requests, isError: r.isError === true, body: JSON.parse(r.text) }
  }
  const compact = (body: any) => ({ id: body.id, status: body.status, submitted: body.submitted, error: body.error?.code })
  const argsFor: [string, Record<string, unknown>][] = [
    ["to-dex", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "5" }],
    ["from-dex", { clientTransferId: "t2", mode: "fromDex", dex: "xyz", amountUsdc: "5" }],
    ["from-dex-all", { clientTransferId: "t3", mode: "fromDex", dex: "xyz", all: true }],
  ]
  const buildOf = (a: Record<string, unknown>) => sendAsset({ id: String(a.clientTransferId), mode: a.mode as "toDex" | "fromDex", dex: String(a.dex), amount: "5" })
  const answerOf = (a: Record<string, unknown>, override?: (b: any) => any) => (path: string, body: any) => {
    if (path !== transferPath) return undefined
    // The CLI and MCP name the wallet `walletId`; the SDK's build request names it `wallet`; the API takes either.
    assert.equal(body.walletId ?? body.wallet, "wallet")
    assert.equal("destination" in body, false, "the request never names a destination")
    return override ? override(buildOf(a)) : buildOf(a)
  }
  for (const [id, a] of argsFor) {
    // A built transfer, checked, and not signed: submit false.
    const m = await mcpRun({ ...a, submit: false }, answerOf(a))
    assert.equal(m.isError, false, JSON.stringify(m.body))
    assert.ok(!m.requests.some((q) => q.path.endsWith("/sign")) && !venueSeen(m.requests))
    rows.push({ id: `mcp-${id}-submit-false`, surface: "mcp", tool: "candle_perps_transfer", args: a, requests: m.requests, outcome: { isError: m.isError, body: compact(m.body) } })
    const client = new CandleClient({ ...cfg, fetch: mcpFetch(answerOf(a), []), maxRetries: 0 })
    const requests: Request[] = []
    const s = new CandleClient({ ...cfg, fetch: mcpFetch(answerOf(a), requests), maxRetries: 0 })
    void client
    const result = await s.perpsTransfer({ ...a, walletId: "wallet", account: ADDRESS, submit: false } as never)
    assert.ok(!requests.some((q) => q.path.endsWith("/sign")) && !venueSeen(requests))
    rows.push({ id: `sdk-${id}-submit-false`, surface: "sdk", tool: "perpsTransfer", args: a, requests, outcome: { isError: false, body: compact(result) } })
  }
  {
    // The whole MCP flow, once: build, local check, the relay's signature, the venue, the acknowledgement.
    const a = argsFor[0]![1]
    const m = await mcpRun(a, answerOf(a), { CANDLE_KEY_SIGNER_PEM_FILE: pemFile })
    assert.equal(m.isError, false, JSON.stringify(m.body))
    const venue = m.requests.find((q) => q.host === "api.hyperliquid.xyz")
    assert.ok(venue && venue.path === "/exchange")
    rows.push({ id: "mcp-to-dex-full-flow-synthetic-venue", surface: "mcp", tool: "candle_perps_transfer", evidence: "stand-in: the relay and the venue are answered by the recorder; nothing is signed with a real key", args: a, requests: m.requests.map((q) => ({ method: q.method, host: q.host, path: q.path })), outcome: { isError: m.isError, body: compact(m.body) } })
  }
  const mcpRefused: [string, Record<string, unknown>, ((b: any) => any) | null, Record<string, string | undefined>, string][] = [
    ["to-spot", { clientTransferId: "s1", mode: "toSpot", amountUsdc: "1" }, null, {}, "MCP_VALIDATION"],
    ["from-spot", { clientTransferId: "s2", mode: "fromSpot", all: true }, null, {}, "MCP_VALIDATION"],
    ["destination-input", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "5", destination: ADDRESS }, null, {}, "MCP_VALIDATION"],
    ["spot-as-a-dex-name", { clientTransferId: "t1", mode: "toDex", dex: "spot", amountUsdc: "5" }, null, {}, "MCP_VALIDATION"],
    ["all-into-a-dex", { clientTransferId: "t1", mode: "toDex", dex: "xyz", all: true }, null, {}, "MCP_VALIDATION"],
    ["all-with-an-amount", { clientTransferId: "t1", mode: "fromDex", dex: "xyz", all: true, amountUsdc: "5" }, null, {}, "MCP_VALIDATION"],
    ["zero-amount", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "0" }, null, {}, "MCP_VALIDATION"],
    ["foreign-destination-build", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "5", submit: false }, (b) => ({ ...b, typedData: { ...b.typedData, message: { ...b.typedData.message, destination: OTHER } }, action: { ...b.action, destination: OTHER } }), {}, "PERPS_BUILD_REFUSED"],
    ["amount-above-what-was-asked", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "4", submit: false }, null, {}, "PERPS_BUILD_REFUSED"],
    ["no-signer", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "5" }, null, {}, "SIGNER_UNAVAILABLE"],
  ]
  for (const [id, a, override, env, code] of mcpRefused) {
    const m = await mcpRun(a, answerOf(a, override ?? undefined), env)
    assert.equal(m.isError, true, `${id}: ${JSON.stringify(m.body)}`)
    assert.equal(m.body.error.code, code, id)
    assert.ok(!m.requests.some((q) => q.path.endsWith("/sign")) && !venueSeen(m.requests), `${id} never signs or reaches the venue`)
    rows.push({ id: `mcp-refused-${id}`, surface: "mcp", tool: "candle_perps_transfer", args: a, requests: m.requests, outcome: { isError: true, code } })
  }
  for (const [id, code] of [["unknown-dex", "PERPS_TRANSFER_DEX_REFUSED"], ["amount-above-source-balance", "PERPS_TRANSFER_EXCEEDS_SOURCE"]] as const) {
    const a = { clientTransferId: "t1", mode: "toDex", dex: id === "unknown-dex" ? "nodex" : "xyz", amountUsdc: id === "unknown-dex" ? "5" : "1000000", submit: false }
    const m = await mcpRun(a, (path) => path === transferPath ? new Response(JSON.stringify({ success: false, error: { code, message: id } }), { status: 400 }) : undefined)
    assert.equal(m.isError, true)
    assert.equal(m.body.error.code, code)
    rows.push({ id: `mcp-refused-api-${id}`, surface: "mcp", tool: "candle_perps_transfer", evidence: "response-stub: the code is the API route's own; the keyed API route is not executed", args: a, requests: m.requests, outcome: { isError: true, code } })
  }
  const sdkRefused: [string, Record<string, unknown>, ((b: any) => any) | null][] = [
    ["all-into-a-dex", { clientTransferId: "t1", mode: "toDex", dex: "xyz", all: true }, null],
    ["zero-amount", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "0" }, null],
    ["foreign-destination-build", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "5" }, (b) => ({ ...b, typedData: { ...b.typedData, message: { ...b.typedData.message, destination: OTHER } }, action: { ...b.action, destination: OTHER } })],
    ["other-dex-in-build", { clientTransferId: "t1", mode: "toDex", dex: "xyz", amountUsdc: "5" }, (b) => ({ ...b, dex: "abc" })],
  ]
  for (const [id, a, override] of sdkRefused) {
    const requests: Request[] = []
    const s = new CandleClient({ ...cfg, fetch: mcpFetch(answerOf(a, override ?? undefined), requests), maxRetries: 0 })
    let message = ""
    try { await s.perpsTransfer({ ...a, walletId: "wallet", account: ADDRESS } as never) } catch (e: any) { message = String(e.message) }
    assert.notEqual(message, "", `${id} must be refused`)
    assert.ok(!requests.some((q) => q.path.endsWith("/sign")) && !venueSeen(requests))
    rows.push({ id: `sdk-refused-${id}`, surface: "sdk", tool: "perpsTransfer", args: a, requests, outcome: { isError: true, message } })
  }

  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-transfer-source.json"), `${JSON.stringify({
    about: "Offline own-balance transfer contracts (BE-3765, SendAsset only: main perps <-> a builder dex; perps <-> spot is BE-3864 and not covered) from exact merged source. check rows run the transfer check through its SDK, MCP and CLI copies, which agree; cli rows run `candle perps transfer` with an ephemeral in-memory key, declining at the prompt or stopping before the relay signs, except the full-flow and read-back rows (BE-3910), where the recorder itself answers the relay, the venue and the acknowledgement, and nothing is signed with a real key; mcp and sdk rows run candle_perps_transfer and perpsTransfer() against response stubs. API refusals are response stubs carrying the route's own codes; the keyed API route is not executed. All addresses are made up. No funded account, signature, submission or deployed behavior is claimed.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline transfer contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; rmSync(dir, { recursive: true, force: true }) }
