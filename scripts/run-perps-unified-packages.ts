// Offline Hyperliquid unified-account run (BE-3863) through the PUBLISHED npm packages, not a source checkout:
//   - the exported SDK (`@candledottv/agent-sdk` main entry),
//   - the shipped CLI (`@candledottv/cli` `bin.candle`, run as a process),
//   - the shipped MCP server (`@candledottv/mcp` `bin.candle-mcp`, run as a stdio server and called by an MCP client).
// The pinned versions in scripts/perps-unified-packages.json are installed fresh from the npm registry (the only network use),
// then every Candle API and Hyperliquid `/info` answer comes from the in-memory stand-ins in scripts/perps-unified-stub.ts.
// The CLI and MCP processes get them through scripts/perps-unified-preload.ts. Nothing is signed, submitted or sent to a venue;
// every key, wallet, address and figure is made up.
//   bun scripts/run-perps-unified-packages.ts            installs the pins into a temp dir, writes the fixture
//   bun scripts/run-perps-unified-packages.ts <dir>      reuses a dir that already holds the pinned install
import { strict as assert } from "node:assert"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ADDRESS, BUILDER, NOW, PRIVY_ID, VENUES, WALLET_ID, cfg, makeFetcher, type Req, type VenueName } from "./perps-unified-stub"

const pins = JSON.parse(readFileSync(join(import.meta.dir, "perps-unified-packages.json"), "utf8")) as Record<string, string>
const PRELOAD = join(import.meta.dir, "perps-unified-preload.ts")

const workDir = mkdtempSync(join(tmpdir(), "perps-unified-run-"))
const installDir = process.argv[2] ? resolve(process.argv[2]) : join(workDir, "install")
if (!process.argv[2]) {
  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "perps-unified-published", private: true, type: "module" })}\n`)
  const add = Bun.spawnSync([process.execPath, "add", "--exact", ...Object.entries(pins).map(([n, v]) => `${n}@${v}`)], { cwd: installDir, stderr: "pipe", stdout: "pipe" })
  if (add.exitCode !== 0) throw new Error(`install of the pinned packages failed: ${add.stderr.toString()}`)
}

const pkgDir = (name: string) => join(installDir, "node_modules", name)
const manifest = (name: string) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8"))
const lockText = existsSync(join(installDir, "bun.lock")) ? readFileSync(join(installDir, "bun.lock"), "utf8") : ""
const packages = Object.fromEntries(
  Object.entries(pins).map(([name, version]) => {
    assert.equal(manifest(name).version, version, `${name} must be installed at the pinned ${version}`)
    const integrity = lockText.match(new RegExp(`"${name}@${version.replace(/\./g, "\\.")}", "[^"]*", [^\\n]*?"(sha512-[^"]+)"`))?.[1]
    return [name, { version, ...(integrity ? { integrity } : {}) }]
  }),
)
const CLI_ENTRY = join(pkgDir("@candledottv/cli"), manifest("@candledottv/cli").bin.candle)
const MCP_ENTRY = join(pkgDir("@candledottv/mcp"), manifest("@candledottv/mcp").bin["candle-mcp"])
const sdkManifest = manifest("@candledottv/agent-sdk")
const SDK_ENTRY = join(pkgDir("@candledottv/agent-sdk"), sdkManifest.main)
const { CandleClient } = await import(pathToFileURL(SDK_ENTRY).href)
// The SDK runs in this process: pin its clock like the CLI and MCP children (their preload does the same).
Date.now = () => NOW

// A throwaway signer for the CLI's encrypted file store, so `perps setup` can reach the server without any real key.
const configDir = join(workDir, "config")
const KEYRING_PASSPHRASE = "fixture-passphrase-not-secret"
{
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const stored = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
  const iterations = 1000
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEYRING_PASSPHRASE), "PBKDF2", false, ["deriveKey"])
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(stored)))
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
  writeFileSync(
    join(configDir, "credentials.enc"),
    JSON.stringify({ [`wallet_signer_${WALLET_ID}`]: { salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), iterations } }),
    { mode: 0o600 },
  )
}

type Scenario = { venue: VenueName; unifiedAccounts: boolean | "omit"; setupReady?: boolean; positionsBody?: Record<string, unknown> }
type Row = { id: string; scenario: string; surface: string; args?: Record<string, unknown>; requests: Req[]; outcome: unknown }
const rows: Row[] = []
const lines = (t: string) => t.trimEnd().split("\n").filter((l) => l !== "")
const scrub = (t: string) => t.split(cfg.apiKey).join("<key>").split(workDir).join("<tmp>")
let seq = 0
const baseEnv = (s: Scenario, log: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: join(workDir, "home"),
  TZ: "UTC",
  CANDLE_PLAIN: "1",
  CANDLE_NO_UPDATE_NOTIFIER: "1",
  CANDLE_API_URL: cfg.apiUrl,
  CANDLE_API_KEY: cfg.apiKey,
  CANDLE_HYPERLIQUID_BUILDER: BUILDER,
  CANDLE_CONFIG_DIR: configDir,
  CANDLE_KEYRING_PASSPHRASE: KEYRING_PASSPHRASE,
  PERPS_UNIFIED_STUB: JSON.stringify(s),
  PERPS_UNIFIED_LOG: log,
})
const readLog = (log: string): Req[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])

const runCli = async (args: string[], s: Scenario) => {
  const log = join(workDir, `cli-${seq++}.log`)
  const p = Bun.spawn([process.execPath, "--preload", PRELOAD, CLI_ENTRY, ...args], { env: baseEnv(s, log), stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { exitCode, stdout: scrub(stdout), stderr: scrub(stderr), requests: readLog(log) }
}

const callMcp = async (name: string, args: Record<string, unknown>, s: Scenario) => {
  const log = join(workDir, `mcp-${seq++}.log`)
  const client = new Client({ name: "harness-perps-unified-packages", version: "1" })
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--preload", PRELOAD, MCP_ENTRY], env: baseEnv(s, log), stderr: "ignore" })
  await client.connect(transport)
  try {
    const r: any = await client.callTool({ name, arguments: args })
    const text: string = scrub(r.content[0].text)
    let body: any
    try { body = JSON.parse(text) } catch { body = { text } }
    return { body, isError: r.isError === true, requests: readLog(log) }
  } finally {
    await client.close()
  }
}

const sdk = (s: Scenario) => {
  const requests: Req[] = []
  const fetcher = makeFetcher(requests, { venue: VENUES[s.venue], unifiedAccounts: s.unifiedAccounts, setupReady: s.setupReady, positionsBody: s.positionsBody })
  return { requests, client: new CandleClient({ ...cfg, fetch: fetcher, maxRetries: 0, hyperliquidBuilder: BUILDER }) }
}

const cliRow = (id: string, scenario: string, args: string[], out: Awaited<ReturnType<typeof runCli>>, json: boolean): Row => ({
  id: `${id}-cli${json ? "-json" : ""}`,
  scenario,
  surface: "cli",
  args: { command: `candle ${args.join(" ")}` },
  requests: out.requests,
  outcome: json
    ? { exitCode: out.exitCode, body: JSON.parse(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) }
    : { exitCode: out.exitCode, lines: lines(out.stdout), ...(out.stderr ? { stderr: lines(out.stderr) } : {}) },
})

// ── Setup ────────────────────────────────────────────────────────────────────────────────────
const setupCases: { id: string; s: Scenario; setupReady: boolean }[] = [
  { id: "setup-unified-on", s: { venue: "unifiedOk", unifiedAccounts: true }, setupReady: true },
  { id: "setup-unified-off", s: { venue: "unifiedOk", unifiedAccounts: false }, setupReady: false },
  { id: "setup-unified-older-api", s: { venue: "unifiedOk", unifiedAccounts: "omit" }, setupReady: false },
  { id: "setup-standard-with-switch-on", s: { venue: "standard", unifiedAccounts: true }, setupReady: true },
  { id: "setup-unsupported-mode", s: { venue: "portfolioMargin", unifiedAccounts: true }, setupReady: false },
]
for (const c of setupCases) {
  const s = { ...c.s, setupReady: c.setupReady }
  for (const json of [false, true]) {
    const args = ["perps", "setup", "--wallet", "perps", ...(json ? ["--json"] : [])]
    const out = await runCli(args, s)
    assert.equal(out.exitCode === 0, c.setupReady, `${c.id} cli: ${out.stdout}${out.stderr}`)
    assert.equal(out.requests.some((r) => r.path === "/api/v1/agent/perps/setup"), c.setupReady, `${c.id} cli setup POST`)
    rows.push(cliRow(c.id, c.id, args, out, json))
  }
  const m = await callMcp("candle_perps_setup", { wallet: WALLET_ID, submit: false }, s)
  assert.equal(!m.isError, c.setupReady, `${c.id} mcp: ${JSON.stringify(m)}`)
  assert.equal(m.requests.some((r) => r.path === "/api/v1/agent/perps/setup"), c.setupReady, `${c.id} mcp setup POST`)
  rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID, submit: false }, requests: m.requests, outcome: { body: m.body, isError: m.isError } })
  {
    const { client, requests } = sdk(s)
    let outcome: any
    try {
      outcome = { isError: false, body: await client.perpsSetup({ walletId: WALLET_ID, privyWalletId: PRIVY_ID, submit: false }) }
    } catch (e: any) {
      outcome = { isError: true, error: { ...(e.code ? { code: e.code } : {}), message: String(e.message) } }
    }
    assert.equal(!outcome.isError, c.setupReady, `${c.id} sdk: ${JSON.stringify(outcome)}`)
    rows.push({ id: `${c.id}-sdk`, scenario: c.id, surface: "sdk", args: { walletId: WALLET_ID, privyWalletId: PRIVY_ID, submit: false }, requests, outcome })
  }
}

// ── Risk ─────────────────────────────────────────────────────────────────────────────────────
const riskCases: { id: string; s: Scenario; exit: number; level: string }[] = [
  { id: "risk-unified-ok", s: { venue: "unifiedOk", unifiedAccounts: true }, exit: 0, level: "ok" },
  { id: "risk-unified-warn-ratio", s: { venue: "unifiedWarnRatio", unifiedAccounts: true }, exit: 10, level: "warn" },
  { id: "risk-unified-no-equity", s: { venue: "unifiedNoEquity", unifiedAccounts: true }, exit: 11, level: "critical" },
  { id: "risk-unified-switch-off", s: { venue: "unifiedOk", unifiedAccounts: false }, exit: 1, level: "unknown" },
  { id: "risk-unified-older-api", s: { venue: "unifiedOk", unifiedAccounts: "omit" }, exit: 1, level: "unknown" },
  { id: "risk-standard-switch-on", s: { venue: "standard", unifiedAccounts: true }, exit: 0, level: "ok" },
  { id: "risk-standard-switch-off", s: { venue: "standard", unifiedAccounts: false }, exit: 0, level: "ok" },
]
for (const c of riskCases) {
  for (const json of [false, true]) {
    const args = ["perps", "risk", "--wallet", "perps", ...(json ? ["--json"] : [])]
    const out = await runCli(args, c.s)
    assert.equal(out.exitCode, c.exit, `${c.id} cli: ${out.stdout}${out.stderr}`)
    rows.push(cliRow(c.id, c.id, args, out, json))
  }
  const m = await callMcp("candle_perps_risk", { wallet: WALLET_ID }, c.s)
  assert.equal(m.isError, c.level === "unknown", `${c.id} mcp`)
  rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID }, requests: m.requests, outcome: { body: m.body, isError: m.isError } })
  const { client, requests } = sdk(c.s)
  const report = await client.perpsRisk({ walletId: WALLET_ID })
  assert.equal(report.level, c.level, `${c.id} sdk`)
  rows.push({ id: `${c.id}-sdk`, scenario: c.id, surface: "sdk", args: { walletId: WALLET_ID }, requests, outcome: { isError: false, body: report } })
}
for (const [id, unifiedAccounts] of [["limits-switch-on", true], ["limits-switch-off", false], ["limits-older-api", "omit"]] as const) {
  const { client, requests } = sdk({ venue: "unifiedOk", unifiedAccounts })
  const res = await client.getPerpsRisk()
  assert.equal(res.unifiedAccounts, unifiedAccounts === true)
  rows.push({ id: `${id}-sdk`, scenario: id, surface: "sdk", args: {}, requests, outcome: { isError: false, body: res } })
}

// ── Account ──────────────────────────────────────────────────────────────────────────────────
const accountCases: { id: string; s: Scenario }[] = [
  { id: "account-unified-on", s: { venue: "unifiedOk", unifiedAccounts: true } },
  { id: "account-unified-off", s: { venue: "unifiedOk", unifiedAccounts: false } },
  { id: "account-standard-on", s: { venue: "standard", unifiedAccounts: true } },
]
for (const c of accountCases) {
  for (const json of [false, true]) {
    const args = ["perps", "account", "--wallet", "perps", "--since", "24h", ...(json ? ["--json"] : [])]
    const out = await runCli(args, c.s)
    assert.equal(out.exitCode, 0, `${c.id} cli: ${out.stdout}${out.stderr}`)
    rows.push(cliRow(c.id, c.id, args, out, json))
  }
  const m = await callMcp("candle_perps_account", { wallet: WALLET_ID, since: "24h" }, c.s)
  assert.equal(m.isError, false, `${c.id} mcp`)
  rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID, since: "24h" }, requests: m.requests, outcome: { body: m.body, isError: m.isError } })
  const { client, requests } = sdk(c.s)
  const account = await client.perpsAccount({ walletId: WALLET_ID, since: NOW - 24 * 3_600_000 })
  rows.push({ id: `${c.id}-sdk`, scenario: c.id, surface: "sdk", args: { walletId: WALLET_ID, since: NOW - 24 * 3_600_000 }, requests, outcome: { isError: false, body: account } })
}

// ── Positions ────────────────────────────────────────────────────────────────────────────────
for (const c of [
  { id: "positions-unified-on", venue: "unifiedOk" as const, withdrawable: "900" },
  { id: "positions-standard-on", venue: "standard" as const, withdrawable: "1050" },
]) {
  const positionsBody = { success: true, walletId: WALLET_ID, address: ADDRESS, network: "mainnet", mode: VENUES[c.venue].mode, withdrawable: c.withdrawable, positions: [], openWithdrawals: [] }
  const s: Scenario = { venue: c.venue, unifiedAccounts: true, positionsBody }
  for (const json of [false, true]) {
    const args = ["perps", "positions", "--wallet", "perps", ...(json ? ["--json"] : [])]
    const out = await runCli(args, s)
    assert.equal(out.exitCode, 0, `${c.id} cli: ${out.stdout}${out.stderr}`)
    rows.push(cliRow(c.id, c.id, args, out, json))
  }
  const m = await callMcp("candle_perps_positions", { wallet: WALLET_ID }, s)
  assert.equal(m.isError, false, `${c.id} mcp`)
  rows.push({ id: `${c.id}-mcp`, scenario: c.id, surface: "mcp", args: { wallet: WALLET_ID }, requests: m.requests, outcome: { body: m.body, isError: m.isError } })
}

// ── Watch (SDK entry point; the CLI watch loop only ends on a signal) ─────────────────────────
{
  const { client, requests } = sdk({ venue: "unifiedWarnRatio", unifiedAccounts: true })
  const controller = new AbortController()
  const events: any[] = []
  const res = await client.watchPerpsRisk({
    walletId: WALLET_ID,
    intervalMs: 10_000,
    heartbeatMs: 0,
    signal: controller.signal,
    onEvent: (ev: any) => { events.push(ev); if (ev.event === "level") controller.abort() },
  })
  assert.equal(res.level, "warn")
  rows.push({ id: "watch-unified-on-sdk", scenario: "watch-unified-on", surface: "sdk", args: { walletId: WALLET_ID, intervalMs: 10_000, heartbeatMs: 0 }, requests, outcome: { level: res.level, events } })
}

const text = JSON.stringify(rows)
assert.ok(!text.includes(cfg.apiKey), "no key in a recording")
assert.ok(!text.includes(workDir), "no temp path in a recording")
assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text), "no private key in a recording")
for (const hex of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) assert.ok(/^0x0{39}[0-9]$/.test(hex), `unexpected non-synthetic address: ${hex}`)

writeFileSync(
  join(import.meta.dir, "../test/fixtures/candle-perps-unified-packages.json"),
  `${JSON.stringify(
    {
      about:
        "Offline Hyperliquid unified-account run through the published npm packages: the SDK's exported entry point, the shipped candle CLI and the shipped candle-mcp server, each installed at an exact pin. Every address, balance and position is made up and time is fixed. API and Hyperliquid /info answers are in-memory stand-ins; nothing is signed, submitted or sent to a venue.",
      packages,
      entryPoints: { sdk: sdkManifest.main, cli: manifest("@candledottv/cli").bin.candle, mcp: manifest("@candledottv/mcp").bin["candle-mcp"] },
      now: new Date(NOW).toISOString(),
      rows: JSON.parse(text),
    },
    null,
    2,
  )}\n`,
)
rmSync(workDir, { recursive: true, force: true })
console.log(`Ran ${rows.length} offline unified-account scenarios through the published packages ${JSON.stringify(packages)}.`)
