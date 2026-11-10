// Candle's MCP server as a child process per agent key, driven against the fake server compiled to a
// binary (so nothing between the core and the child, such as a shell shim, adds to its environment).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FakeScript } from "../../test/fake-candle-mcp"
import fixture from "../../test/fixtures/candle-tools.json"
import { allowEnv } from "../shared/child"
import { pidIsAlive } from "../shared/lock"
import { candleConfigDir, CandleMcpPool, type ChildOptions, childLaunch, MIN_CANDLE_MCP, toOutcome, UnknownAgent, versionAtLeast } from "./candle-mcp"

const KEY_A = `cndl_live_${"a".repeat(40)}`
const KEY_B = `cndl_live_${"b".repeat(40)}`
const MOON = "MoonFake11111111111111111111111111111111111"

let binDir: string
let fakeBin: string
beforeAll(async () => {
  binDir = mkdtempSync(join(tmpdir(), "chrn-fakebin-"))
  fakeBin = join(binDir, "candle")
  await $`bun build --compile ${join(import.meta.dir, "../../test/fake-candle-mcp.ts")} --outfile ${fakeBin}`.quiet()
})
afterAll(() => rmSync(binDir, { recursive: true, force: true }))

const pools: CandleMcpPool[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(opts: { agents?: [string, string][]; scripts?: Record<string, FakeScript>; route?: "cli" | "package"; connectTimeoutMs?: number; backoffMs?: number[]; meter?: ChildOptions["meter"] } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "chrn-mcp-"))
  dirs.push(stateDir)
  const agents = (opts.agents ?? [["momentum", KEY_A]]).map(([name, apiKey]) => ({ name, apiKey }))
  for (const [agent, script] of Object.entries(opts.scripts ?? {})) writeScript(stateDir, agent, script)
  const pool = new CandleMcpPool({
    route: opts.route ?? "cli",
    path: fakeBin,
    stateDir,
    parentEnv: process.env,
    agents,
    child: { backoffMs: opts.backoffMs ?? [100, 200], connectTimeoutMs: opts.connectTimeoutMs, ...(opts.meter ? { meter: opts.meter } : {}) },
  })
  pools.push(pool)
  return { pool, stateDir }
}

function writeScript(stateDir: string, agent: string, script: FakeScript) {
  const dir = candleConfigDir(stateDir, agent)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, "fake-candle.json"), JSON.stringify(script))
}

function seen(stateDir: string, agent: string): { argv: string[]; env: Record<string, string>; pid: number } {
  return JSON.parse(readFileSync(join(candleConfigDir(stateDir, agent), "fake-candle-seen.json"), "utf8"))
}

function calls(stateDir: string, agent: string): { name: string; args: Record<string, unknown> }[] {
  const path = join(candleConfigDir(stateDir, agent), "fake-candle-calls.jsonl")
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
}

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(20)
  }
}

describe("starting the children", () => {
  test("the child's environment is exactly the allowlist plus its key, its private config folder and no update notices", async () => {
    const { pool, stateDir } = setup()
    await pool.start()
    const configDir = candleConfigDir(stateDir, "momentum")
    expect(seen(stateDir, "momentum").env).toEqual(
      allowEnv(process.env, { CANDLE_API_KEY: KEY_A, CANDLE_CONFIG_DIR: configDir, CANDLE_NO_UPDATE_NOTIFIER: "1" }),
    )
    expect(statSync(configDir).mode & 0o777).toBe(0o700)
  })

  test("CANDLE_IMAGE_DIR never reaches a child, even when the core has it: launch images go by URL only", () => {
    for (const route of ["cli", "package"] as const) {
      const spec = childLaunch({ route, path: "/usr/local/bin/candle", apiKey: KEY_A, configDir: "/tmp/fake-config", parentEnv: { ...process.env, CANDLE_IMAGE_DIR: "/tmp/research" } })
      expect(spec.env).not.toHaveProperty("CANDLE_IMAGE_DIR")
      expect(Object.keys(spec.env).filter((k) => k.startsWith("CANDLE_")).sort()).toEqual(["CANDLE_API_KEY", "CANDLE_CONFIG_DIR", "CANDLE_NO_UPDATE_NOTIFIER"])
    }
  })

  test("the key never appears in the child's arguments; route A runs `candle mcp`, route B the package", async () => {
    for (const route of ["cli", "package"] as const) {
      const { pool, stateDir } = setup({ route })
      await pool.start()
      const { argv } = seen(stateDir, "momentum")
      expect(argv).toEqual(route === "cli" ? ["mcp"] : [])
      expect(JSON.stringify(argv)).not.toContain(KEY_A)
    }
  })

  test("every agent's child is started when the pool starts, each holding only its own key", async () => {
    const { pool, stateDir } = setup({ agents: [["momentum", KEY_A], ["swing", KEY_B]] })
    await pool.start()
    expect(pool.for("momentum").status().state).toBe("ready")
    expect(pool.for("swing").status().state).toBe("ready")
    expect(seen(stateDir, "momentum").env.CANDLE_API_KEY).toBe(KEY_A)
    expect(seen(stateDir, "swing").env.CANDLE_API_KEY).toBe(KEY_B)
    expect(seen(stateDir, "momentum").pid).not.toBe(seen(stateDir, "swing").pid)
  })

  test("a call for one agent reaches only that agent's child", async () => {
    const { pool, stateDir } = setup({ agents: [["momentum", KEY_A], ["swing", KEY_B]] })
    await pool.start()
    expect((await pool.for("swing").call("candle_get_wallets", {})).kind).toBe("ok")
    expect(calls(stateDir, "swing").map((c) => c.name)).toEqual(["candle_get_wallets"])
    expect(calls(stateDir, "momentum")).toEqual([])
    expect(() => pool.for("ghost")).toThrow(UnknownAgent)
  })

  test("an agent added while the core runs gets its child started then", async () => {
    const { pool, stateDir } = setup()
    await pool.start()
    await pool.add({ name: "swing", apiKey: KEY_B })
    expect(pool.for("swing").status().state).toBe("ready")
    expect(seen(stateDir, "swing").env.CANDLE_API_KEY).toBe(KEY_B)
  })

  test(`a server older than ${MIN_CANDLE_MCP} is refused with "update Candle", and not restarted`, async () => {
    const { pool, stateDir } = setup({ scripts: { momentum: { version: "0.10.21" } } })
    await pool.start()
    const status = pool.for("momentum").status()
    expect(status.state).toBe("refused")
    expect(status.state === "refused" && status.reason).toContain("update Candle")
    const pid = seen(stateDir, "momentum").pid
    await Bun.sleep(400) // past the backoff
    expect(seen(stateDir, "momentum").pid).toBe(pid)
    expect(pidIsAlive(pid)).toBe(false)
  })

  test("a slow initialize under 20 s passes with the default timeout", async () => {
    const { pool } = setup({ scripts: { momentum: { initializeDelayMs: 2000 } } })
    await pool.start()
    expect(pool.for("momentum").status().state).toBe("ready")
  })

  test("an initialize slower than the timeout leaves the child down, and it's tried again", async () => {
    const { pool, stateDir } = setup({ scripts: { momentum: { initializeDelayMs: 1500 } }, connectTimeoutMs: 300 })
    await pool.start()
    expect(pool.for("momentum").status().state).toBe("down")
    const first = seen(stateDir, "momentum").pid
    await until(() => !pidIsAlive(first)) // killed, not left waiting
    writeScript(stateDir, "momentum", {})
    await until(() => pool.for("momentum").status().state === "ready")
  })

  test("tools() serves what tools/list showed, schemas included", async () => {
    const { pool } = setup()
    await pool.start()
    const tools = pool.for("momentum").tools()
    // 0.10.30's 92, less the four listed only to a key that may edit its profile (the fake leaves them out).
    expect(tools).toHaveLength(88)
    expect(tools.find((t) => t.name === "candle_trade")!.inputSchema).toEqual(
      fixture.tools.find((t) => t.name === "candle_trade")!.inputSchema as never,
    )
  })

  test("stop leaves nothing running", async () => {
    const { pool, stateDir } = setup()
    await pool.start()
    const pid = seen(stateDir, "momentum").pid
    await pool.stop()
    await until(() => !pidIsAlive(pid))
  })
})

describe("counting each key's calls", () => {
  test("every call that reaches the server is counted on its own key, and a RATE_LIMITED answer is told", async () => {
    const counted: string[] = []
    const answers: string[] = []
    const meter = { noteCall: (agent: string, n = 1) => void counted.push(`${agent}×${n}`), noteOutcome: (agent: string, o: { kind: string; code?: string }) => void answers.push(`${agent}:${o.kind === "error" ? o.code : o.kind}`) }
    const { pool } = setup({ agents: [["momentum", KEY_A], ["scout", KEY_B]], scripts: { scout: { rateLimitPerMin: 2 } }, meter })
    await pool.start()
    counted.length = 0
    await pool.for("momentum").call("candle_get_portfolio", {})
    await pool.for("scout").call("candle_get_portfolio", {})
    const refused = await pool.for("scout").call("candle_get_portfolio", {})
    expect(refused).toMatchObject({ kind: "error", code: "RATE_LIMITED", retryable: true })
    expect(counted).toEqual(["momentum×2", "scout×2", "scout×2"])
    expect(answers).toEqual(["momentum:ok", "scout:ok", "scout:RATE_LIMITED"])
  })

  test("a read Candle doesn't count (its market read, for triggers' levels) counts nothing toward the key, and its answer is still told", async () => {
    const counted: string[] = []
    const answers: string[] = []
    const meter = { noteCall: (agent: string, n = 1) => void counted.push(`${agent}×${n}`), noteOutcome: (agent: string, o: { kind: string }) => void answers.push(`${agent}:${o.kind}`) }
    const { pool } = setup({ meter })
    await pool.start()
    counted.length = 0
    await pool.for("momentum").call("candle_get_market", { chain: "solana", mint: "MoonFake11111111111111111111111111111111111" }, { uncounted: true })
    await pool.for("momentum").call("candle_get_market", { chain: "solana", mint: "MoonFake11111111111111111111111111111111111" })
    expect(counted).toEqual(["momentum×0", "momentum×1"])
    expect(answers).toEqual(["momentum:ok", "momentum:ok"])
  })

  test("the server's own reads as it starts (whether the key may edit its profile, at start and on its tool list) count toward the key", async () => {
    const counted: string[] = []
    const { pool } = setup({ agents: [["momentum", KEY_A], ["scout", KEY_B]], meter: { noteCall: (agent: string, n = 1) => void counted.push(`${agent}×${n}`), noteOutcome: () => {} } })
    await pool.start()
    expect(counted.sort()).toEqual(["momentum×2", "scout×2"])
  })

  test("a call while the child is down reaches nothing, so it isn't counted", async () => {
    const counted: string[] = []
    const { pool } = setup({ scripts: { momentum: { startError: "no" } }, meter: { noteCall: (a) => void counted.push(a), noteOutcome: () => {} } })
    await pool.start()
    expect(await pool.for("momentum").call("candle_get_portfolio", {})).toMatchObject({ kind: "error", code: "CANDLE_MCP_DOWN" })
    expect(counted).toEqual([])
  })
})

describe("calls and their outcomes", () => {
  test("ok returns the parsed result", async () => {
    const { pool } = setup()
    await pool.start()
    const outcome = await pool.for("momentum").call("candle_resolve_token", { mint: MOON })
    expect(outcome).toMatchObject({ kind: "ok", result: { success: true, market: { mint: MOON } } })
  })

  test("a refusal is an error with its code, in both of Candle's shapes", async () => {
    const { pool } = setup({
      scripts: {
        momentum: {
          tools: {
            candle_trade: { refuse: "KEY_LIMIT_REACHED", retryable: true, extra: { resetsAt: "2026-10-27T00:00:00Z" } },
            candle_swap: { refuse: "SWAP_FAILED", stage: "not_broadcast", retryable: true },
          },
        },
      },
    })
    await pool.start()
    const child = pool.for("momentum")
    expect(await child.call("candle_trade", { mint: MOON, side: "buy", amount: "0.1", clientTradeId: "t1" })).toMatchObject({
      kind: "error",
      code: "KEY_LIMIT_REACHED",
      retryable: true,
      body: { clientTradeId: "t1", api: { error: { resetsAt: "2026-10-27T00:00:00Z" } } },
    })
    expect(await child.call("candle_swap", { from: "SOL", to: "USDC", amount: "1", clientSwapId: "s1" })).toMatchObject({
      kind: "error",
      code: "SWAP_FAILED",
      retryable: true,
      body: { error: { stage: "not_broadcast" } },
    })
  })

  test("MCP_TRANSPORT is lost, with the id it echoed", async () => {
    const { pool } = setup({ scripts: { momentum: { tools: { candle_trade: "transport" } } } })
    await pool.start()
    const outcome = await pool.for("momentum").call("candle_trade", { mint: MOON, side: "buy", amount: "0.1", clientTradeId: "t2" })
    expect(outcome).toMatchObject({ kind: "lost", reason: "transport", body: { clientTradeId: "t2" } })
  })

  test("a timeout is lost", async () => {
    const { pool } = setup({ scripts: { momentum: { tools: { candle_trade: "hang" } } } })
    await pool.start()
    const outcome = await pool.for("momentum").call("candle_trade", { mint: MOON, side: "buy", amount: "0.1" }, { timeoutMs: 300 })
    expect(outcome).toEqual({ kind: "lost", reason: "timeout" })
  })

  test("a call while the child dies is lost, never retried here, and the child restarts", async () => {
    const { pool, stateDir } = setup({ scripts: { momentum: { tools: { candle_trade: "die-once" } } } })
    await pool.start()
    const first = seen(stateDir, "momentum").pid
    const outcome = await pool.for("momentum").call("candle_trade", { mint: MOON, side: "buy", amount: "0.1", clientTradeId: "t3" })
    expect(outcome).toEqual({ kind: "lost", reason: "child_exited" })
    expect(calls(stateDir, "momentum").filter((c) => c.name === "candle_trade")).toHaveLength(1)
    await until(() => pool.for("momentum").status().state === "ready" && seen(stateDir, "momentum").pid !== first)
    expect(calls(stateDir, "momentum").filter((c) => c.name === "candle_trade")).toHaveLength(1)
  })

  test("a call while the child is down is refused before anything is sent", async () => {
    // A long backoff keeps it down for the rest of the test.
    const { pool, stateDir } = setup({ scripts: { momentum: { tools: { candle_trade: "die" } } }, backoffMs: [10_000] })
    await pool.start()
    await pool.for("momentum").call("candle_trade", { mint: MOON, side: "buy", amount: "0.1" })
    expect(pool.for("momentum").status().state).toBe("down")
    const before = calls(stateDir, "momentum").length
    const outcome = await pool.for("momentum").call("candle_get_wallets", {})
    expect(outcome).toMatchObject({ kind: "error", code: "CANDLE_MCP_DOWN", retryable: true })
    expect(calls(stateDir, "momentum")).toHaveLength(before)
  })

  test("the SDK's refusal of bad arguments is an error: nothing was sent", async () => {
    const { pool } = setup({ scripts: { momentum: { tools: { candle_trade: "validation-text" } } } })
    await pool.start()
    expect(await pool.for("momentum").call("candle_trade", { side: "buy" })).toMatchObject({ kind: "error", code: "MCP_VALIDATION", retryable: false })
  })

  test("a reply nobody can read is lost: an error that isn't JSON, or a result that isn't", async () => {
    const { pool } = setup({ scripts: { momentum: { tools: { candle_trade: "throw-text", candle_swap: "garbled" } } } })
    await pool.start()
    expect(await pool.for("momentum").call("candle_trade", { mint: MOON, side: "buy", amount: "0.1" })).toEqual({ kind: "lost", reason: "unparseable" })
    expect(await pool.for("momentum").call("candle_swap", { from: "SOL", to: "USDC", amount: "1" })).toEqual({ kind: "lost", reason: "unparseable" })
  })
})

describe("pure pieces", () => {
  test("versionAtLeast", () => {
    expect(versionAtLeast("0.10.22", "0.10.22")).toBe(true)
    expect(versionAtLeast("0.11.0", "0.10.22")).toBe(true)
    expect(versionAtLeast("1.0.0", "0.10.22")).toBe(true)
    expect(versionAtLeast("0.10.21", "0.10.22")).toBe(false)
    expect(versionAtLeast("0.9.99", "0.10.22")).toBe(false)
    expect(versionAtLeast("0.10.22-beta.1", "0.10.22")).toBe(false)
    expect(versionAtLeast("garbage", "0.10.22")).toBe(false)
    expect(versionAtLeast(undefined, "0.10.22")).toBe(false)
  })

  test("toOutcome reads an error's code wherever Candle puts it", () => {
    const t = (body: unknown, isError = true) => ({ content: [{ type: "text", text: JSON.stringify(body) }], isError })
    expect(toOutcome(t({ success: false, error: { code: "RATE_LIMITED", retryable: true } }))).toMatchObject({ kind: "error", code: "RATE_LIMITED", retryable: true })
    expect(toOutcome(t({ clientTradeId: "x", api: { success: false, error: { code: "TIER_REQUIRED" } } }))).toMatchObject({ kind: "error", code: "TIER_REQUIRED", retryable: false })
    expect(toOutcome(t({ error: "Agent not found" }))).toMatchObject({ kind: "error", code: "UNKNOWN_ERROR" })
    expect(toOutcome(t({ clientSwapId: "s", success: false, error: { code: "MCP_TRANSPORT", retryable: true } }))).toMatchObject({ kind: "lost", reason: "transport" })
    expect(toOutcome(t({ ok: 1 }, false))).toEqual({ kind: "ok", result: { ok: 1 } })
    expect(toOutcome({ content: [] })).toEqual({ kind: "lost", reason: "unparseable" })
  })
})
