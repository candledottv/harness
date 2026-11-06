// A core for tests: a temporary home (short, for the socket path), a config with one or two agents,
// their key files, and the fake Candle MCP server compiled to a binary standing in for `candle`.
import { $ } from "bun"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../src/config"
import { candleConfigDir } from "../src/core/candle-mcp"
import { type CoreOptions, type RunningCore, startCore } from "../src/core/core-main"
import { type Paths, paths } from "../src/paths"
import { PROTOCOL_VERSION } from "../src/shared/rpc"
import { readViewToken } from "../src/core/tokens"
import { connectTestClient, type TestClient } from "./core-test-client"

export const AGENT_KEY = `cndl_live_${"q".repeat(40)}`
export const SWING_KEY = `cndl_live_${"w".repeat(40)}`

let fakeBin: string | undefined
const homes: string[] = []

/** Compiles the fake Candle once per test file. */
export async function fakeCandle(): Promise<string> {
  if (fakeBin) return fakeBin
  const dir = mkdtempSync("/tmp/chrn-bin-")
  homes.push(dir)
  fakeBin = join(dir, "candle")
  await $`bun build --compile ${join(import.meta.dir, "fake-candle.ts")} --outfile ${fakeBin}`.quiet()
  return fakeBin
}

/**
 * testConfig's engine table: Claude Code by default on its plain name. The engines built since (Codex,
 * Grok, OpenCode, Pi) point nowhere, so a test core never runs a real one; a test that wants one names its fake.
 */
export const testEngine: Config["engine"] = { default: "claude-code", claude: { path: "claude" }, codex: { path: "/nonexistent/candle-test/codex" }, grok: { path: "/nonexistent/candle-test/grok" }, opencode: { path: "/nonexistent/candle-test/opencode" }, pi: { path: "/nonexistent/candle-test/pi" }, stepCap: 30 }

export function testConfig(candle: string, overrides: Partial<Config> = {}): Config {
  return {
    agents: {
      momentum: { name: "momentum", limits: { perTradeUsd: 10, perDayUsd: 50 } },
      swing: { name: "swing", limits: { perTradeUsd: 10, perDayUsd: 50 } },
    },
    activeAgent: "momentum",
    mode: "live",
    cards: { typedTrades: "card" },
    pricing: { source: "auto", quoteTool: "candle_quote" },
    trade: { spendAsset: "SOL" },
    engine: testEngine,
    candle: { mcp: { route: "cli", path: "candle-mcp" }, cliPath: candle, rpcUrl: undefined, profile: undefined },
    wallets: { show: "active" },
    // Off unless a test turns it on with the fake Hacc (`haccHost`), so no test core reaches the real one.
    hacc: { enabled: false },
    pnl: { window: "24h" },
    skills: { from: [] },
    ...overrides,
  }
}

/** A fresh home with config.toml and key files written, for a core started in or out of process. */
export async function testHome(prefix = "/tmp/chrn-h-"): Promise<{ home: string; p: Paths; candle: string }> {
  const candle = await fakeCandle()
  const home = mkdtempSync(prefix)
  homes.push(home)
  const p = paths({ CANDLE_HARNESS_HOME: home })
  mkdirSync(p.keysDir, { recursive: true, mode: 0o700 })
  writeFileSync(p.keyFile("momentum"), `${AGENT_KEY}\n`, { mode: 0o600 })
  writeFileSync(p.keyFile("swing"), `${SWING_KEY}\n`, { mode: 0o600 })
  writeFileSync(
    p.configFile,
    `mode = "live"\n[candle]\ncliPath = "${candle}"\n[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.swing.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`,
  )
  return { home, p, candle }
}

export interface TestCore {
  core: RunningCore
  p: Paths
  connect(): Promise<TestClient>
  hello(token: string, extra?: Record<string, unknown>): Promise<{ client: TestClient; response: Awaited<ReturnType<TestClient["request"]>> }>
  /** A view; `clientName` as a popped view names itself ("candle-harness view --pane wallets"). */
  view(clientName?: string): Promise<TestClient>
  harness(via?: TestClient, agent?: string): Promise<{ client: TestClient; token: string; tokenId: string; registrar: TestClient }>
  close(): Promise<void>
}

/**
 * Made-up keys of the real shape, so each has a prefix (`apiKeyPrefix`), built at run time so no
 * key-shaped text sits in the source: `prefixedKey("Momentum")` has prefix "Momentum".
 */
export const prefixedKey = (prefix: string) => `${["cndl", "live", ""].join("_")}${prefix}${"x".repeat(43 - prefix.length)}`

export interface TestHomeOptions {
  /** Key files to write instead of AGENT_KEY and SWING_KEY, by agent. */
  keys?: Record<string, string>
  /** Each agent's fake Candle MCP script (test/fake-candle-mcp.ts, FakeScript), written before the core starts. */
  candle?: Record<string, unknown>
  /** Config to change from testConfig's, such as cards.typedTrades. */
  config?: Partial<Config>
  /** Runs against the fresh home before the core starts, to leave files a past core would have. */
  before?: (p: Paths) => void
  /** Where the home is made, as mkdtemp's prefix: /tmp by default. A live read canary needs one outside /tmp, which every Grok profile reads. */
  prefix?: string
}

export async function startTestCore(opts: Partial<CoreOptions> = {}, home: TestHomeOptions = {}): Promise<TestCore> {
  const { p, candle } = await testHome(home.prefix)
  for (const [agent, key] of Object.entries(home.keys ?? {})) writeFileSync(p.keyFile(agent), `${key}\n`, { mode: 0o600 })
  for (const [agent, script] of Object.entries(home.candle ?? {})) {
    const folder = candleConfigDir(p.stateDir, agent)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, "fake-candle.json"), JSON.stringify(script))
  }
  home.before?.(p)
  // No test core reads the chain: a stopped wallet's balance is unread unless a test gives one.
  const chainBalance = async () => ({ error: "not read in tests", readAt: Date.now() })
  const core = await startCore({ paths: p, config: testConfig(candle, home.config), env: process.env, headless: true, chainBalance, ...opts })
  await core.candleReady
  const clients: TestClient[] = []
  const connect = async () => {
    const client = await connectTestClient(p.socket)
    clients.push(client)
    return client
  }
  const hello = async (token: string, extra: Record<string, unknown> = {}) => {
    const client = await connect()
    const response = await client.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "test", ...extra })
    return { client, response }
  }
  const view = async (clientName?: string) => {
    const { client, response } = await hello((await readViewToken(p.viewToken))!, clientName ? { clientName } : {})
    if (response.error) throw new Error(`view hello failed: ${JSON.stringify(response.error)}`)
    return client
  }
  const harness = async (via?: TestClient, agent?: string) => {
    const registrar = via ?? (await view())
    const minted = (await registrar.request("harness.register", { name: "Claude Code", ...(agent ? { agent } : {}) })).result as { token: string; tokenId: string }
    const { client, response } = await hello(minted.token, { harnessKind: "claude-code" })
    if (response.error) throw new Error(`harness hello failed: ${JSON.stringify(response.error)}`)
    return { client, registrar, ...minted }
  }
  return {
    core,
    p,
    connect,
    hello,
    view,
    harness,
    close: async () => {
      for (const client of clients) client.close()
      await core.stop("test")
    },
  }
}

/** Polls until `condition` holds (5 s at most). */
export async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

export function cleanupHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  fakeBin = undefined
}
