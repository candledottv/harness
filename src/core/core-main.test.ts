// The core process: when it stays up and when it exits, recovery after kill -9, and a
// view reattaching to a running or restarted core.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, testConfig, testEngine, testHome, type TestCore, until } from "../../test/core-fixture"
import { answers } from "../shared/socket-path"
import { pidIsAlive } from "../shared/lock"
import { connectTestClient } from "../../test/core-test-client"
import { scripted } from "../../test/scripted-engine"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { ViewSession } from "./client"
import { readViewToken } from "./tokens"
import { candleConfigDir } from "./candle-mcp"
import { AFTER_FILL_READS_MS, IDLE_EXIT_NO_AGENTS_MS, IdleWatch, holdingFrom, readAfterFill, startCore } from "./core-main"

const cores: TestCore[] = []
const procs: { kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL")
    await p.exited
  }
})
afterAll(cleanupHomes)

describe("a harness installed after the core started", () => {
  test("engine.check finds it, and an engine that runs isn't spawned again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrn-late-harness-"))
    try {
      const bin = join(dir, "codex")
      const runs = join(dir, "runs")
      const c = await startTestCore({}, { config: { engine: { ...testEngine, codex: { path: bin } } } })
      cores.push(c)
      const view = await c.view()
      const ask = async () => ((await view.request("engine.check", { engine: "codex" })).result as { check: { ok: boolean; version?: string; message?: string } }).check
      // Missing at start, as Claude Code was on the fresh Mac user: not installed, and asking again changes nothing.
      expect(await ask()).toMatchObject({ ok: false, message: expect.stringContaining("isn't installed") })
      // Installed in another tab while the core runs.
      writeFileSync(bin, `#!/bin/sh\necho run >> "${runs}"\necho "codex-cli 0.165.0"\n`)
      chmodSync(bin, 0o755)
      expect(await ask()).toMatchObject({ ok: true, version: "0.165.0" })
      const after = readFileSync(runs, "utf8").split("\n").filter(Boolean).length
      expect(await ask()).toMatchObject({ ok: true, version: "0.165.0" })
      expect(readFileSync(runs, "utf8").split("\n").filter(Boolean).length).toBe(after)
      // It updates itself (harnesses do, in the Build pane): `again` reads the new version; a plain check keeps the last.
      writeFileSync(bin, `#!/bin/sh\necho run >> "${runs}"\necho "codex-cli 0.167.0"\n`)
      expect(await ask()).toMatchObject({ ok: true, version: "0.165.0" })
      expect(((await view.request("engine.check", { engine: "codex", again: true })).result as { check: { version?: string } }).check.version).toBe("0.167.0")
      // The harness can't ask.
      const { client: harness } = await c.harness(view)
      expect((await harness.request("engine.check", { engine: "codex" })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("the idle rule", () => {
  test("a view-started core stays up while anything holds it, and exits 60 s after the last thing ends", () => {
    const idle = new IdleWatch({ headless: false, idleMs: 60_000 })
    // An operation is being read back, with no view: it holds.
    for (let t = 0; t <= 10 * 60_000; t += 1_000) expect(idle.tick(t, true)).toBe(false)
    // It settles: 60 s later, and not before, the core exits.
    const settled = 10 * 60_000 + 1
    expect(idle.tick(settled, false)).toBe(false)
    expect(idle.tick(settled + 59_999, false)).toBe(false)
    expect(idle.tick(settled + 60_000, false)).toBe(true)
  })

  test("anything holding again restarts the 60 s", () => {
    const idle = new IdleWatch({ headless: false, idleMs: 60_000 })
    expect(idle.tick(0, false)).toBe(false)
    expect(idle.tick(59_000, true)).toBe(false)
    expect(idle.tick(60_000, false)).toBe(false)
    expect(idle.tick(119_999, false)).toBe(false)
    expect(idle.tick(120_000, false)).toBe(true)
  })

  test("a core with no agents yet goes 2 s after the last view, so a fresh start takes a fresh environment", () => {
    const idle = new IdleWatch({ headless: false, idleMs: 60_000 })
    expect(idle.tick(0, false, IDLE_EXIT_NO_AGENTS_MS)).toBe(false)
    expect(idle.tick(1_999, false, IDLE_EXIT_NO_AGENTS_MS)).toBe(false)
    expect(idle.tick(2_000, false, IDLE_EXIT_NO_AGENTS_MS)).toBe(true)
  })

  test("a headless core with nothing to do is still running after 10 minutes", () => {
    const idle = new IdleWatch({ headless: true, idleMs: 60_000 })
    for (let t = 0; t <= 10 * 60_000; t += 1_000) expect(idle.tick(t, false)).toBe(false)
  })
})

describe("the lifecycle, for real", () => {
  test("a view-started core stays up while a view is attached, and exits once it's gone and the idle time has passed", async () => {
    let stopped: string | undefined
    const c = await startTestCore({ headless: false, idleExitMs: 300, idleTickMs: 25, onStopped: (r) => (stopped = r) })
    cores.push(c)
    const view = await c.view()
    await Bun.sleep(700)
    expect(stopped).toBeUndefined()
    view.close()
    await until(() => stopped !== undefined, 3000)
    expect(stopped).toBe("idle")
    expect(existsSync(c.p.socket)).toBe(false)
    expect(existsSync(c.p.lock)).toBe(false)
    expect(existsSync(c.p.viewToken)).toBe(false)
  })

  test("an open card holds a view-started core", async () => {
    let stopped: string | undefined
    const c = await startTestCore({ headless: false, idleExitMs: 300, idleTickMs: 25, onStopped: (r) => (stopped = r) })
    cores.push(c)
    const { client, registrar } = await c.harness()
    await client.request("tools.call", { name: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "buy", amount: "0.01" } })
    registrar.close()
    client.close()
    await Bun.sleep(700)
    expect(stopped).toBeUndefined() // the card (60 s) holds it
  })

  test("a headless core, idle past its idle time, still takes a view", async () => {
    let stopped: string | undefined
    const c = await startTestCore({ headless: true, idleExitMs: 200, idleTickMs: 25, onStopped: (r) => (stopped = r) })
    cores.push(c)
    await Bun.sleep(600)
    expect(stopped).toBeUndefined()
    await c.view()
  })

  test("a core still stopping when a newer one took the lock leaves the newer one's socket and view token", async () => {
    const { p, candle } = await testHome()
    const first = await startCore({ paths: p, config: testConfig(candle), env: process.env, headless: true })
    // A newer core has moved the old lock aside and written its own, and its view token.
    const newer = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), id: "newer" })}\n`
    writeFileSync(p.lock, newer)
    writeFileSync(p.viewToken, "the newer core's token\n", { mode: 0o600 })
    await first.stop("test")
    expect(readFileSync(p.viewToken, "utf8")).toBe("the newer core's token\n")
    expect(readFileSync(p.lock, "utf8")).toBe(newer)
  })

  test("a second core on the same home is refused while the first runs", async () => {
    const c = await startTestCore()
    cores.push(c)
    await expect(startCore({ paths: c.p, config: testConfig("unused"), env: process.env, headless: true })).rejects.toMatchObject({ code: "CORE_ALREADY_RUNNING" })
  })
})

describe("recovery", () => {
  test("after kill -9, the stale socket and lock are cleared by the next core, and a view attaches", async () => {
    const { home, p } = await testHome()
    const env = { ...process.env, CANDLE_HARNESS_HOME: home }
    const main = join(import.meta.dir, "../main.ts")
    const first = Bun.spawn([process.execPath, main, "core"], { env, stdout: "ignore", stderr: "ignore" })
    procs.push(first)
    await until(() => existsSync(p.socket), 10_000)
    await until(() => existsSync(p.viewToken), 10_000)
    first.kill("SIGKILL")
    await first.exited
    expect(existsSync(p.socket)).toBe(true) // left behind
    expect(existsSync(p.lock)).toBe(true)
    expect(await answers(p.socket)).toBe(false)
    const stalePid = JSON.parse(readFileSync(p.lock, "utf8")).pid as number
    expect(pidIsAlive(stalePid)).toBe(false)

    const second = Bun.spawn([process.execPath, main, "core"], { env, stdout: "ignore", stderr: "ignore" })
    procs.push(second)
    // The new lock is created empty and then written: a read can land in between.
    const lockPid = () => {
      try {
        return JSON.parse(readFileSync(p.lock, "utf8")).pid as number
      } catch {
        return undefined
      }
    }
    await until(() => lockPid() === second.pid, 10_000)
    // The dead core's view.token is still there, so wait for the new core to answer on its socket.
    for (let i = 0; i < 400 && !(await answers(p.socket)); i++) await Bun.sleep(25)
    const session = new ViewSession({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: "test", topics: ["status"] })
    const hello = await session.start()
    expect(hello).toMatchObject({ role: "view", agents: ["momentum", "swing"] })
    session.close()
  }, 30_000)

  test("an account file left empty or garbled by a start that died is replaced, and the core starts", async () => {
    for (const left of ["", "acct_\n"]) {
      const { p, candle } = await testHome()
      mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(p.stateDir, "account"), left, { mode: 0o600 })
      const core = await startCore({ paths: p, config: testConfig(candle), env: process.env, headless: true })
      expect(core.account).toMatch(/^acct_[A-Za-z0-9_-]{16,}$/)
      expect(readFileSync(join(p.stateDir, "account"), "utf8").trim()).toBe(core.account)
      expect(statSync(join(p.stateDir, "account")).mode & 0o777).toBe(0o600)
      await core.stop("test")
    }
  })

  test("a view reattaches to a restarted core on its own, and gets a fresh snapshot", async () => {
    const { p, candle } = await testHome()
    const start = () => startCore({ paths: p, config: testConfig(candle), env: process.env, headless: true })
    const first = await start()
    const session = new ViewSession({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: "test", topics: ["status"], retryMs: 50 })
    const hellos: Record<string, unknown>[] = []
    session.onHello((h) => hellos.push(h))
    const snapshots: unknown[] = []
    session.onEvent((e) => e.snapshot && snapshots.push(e.data))
    await session.start()
    await until(() => snapshots.length === 1)
    await first.stop("test")
    const second = await start()
    await until(() => hellos.length === 2, 5000)
    expect(hellos[1]!.coreId).not.toBe(hellos[0]!.coreId)
    await until(() => snapshots.length === 2)
    session.close()
    await second.stop("test")
  })
})

describe("topics a view wants while a pane shows", () => {
  test("want subscribes and lets go, and a reconnect subscribes what's still wanted", async () => {
    const { p, candle } = await testHome()
    const start = () => startCore({ paths: p, config: testConfig(candle), env: process.env, headless: true })
    const first = await start()
    const session = new ViewSession({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: "test", topics: ["status"], retryMs: 50 })
    const snapshots: string[] = []
    session.onEvent((e) => e.snapshot && snapshots.push(e.topic))
    await session.start()
    const held = async () => ((await session.request<{ topics: string[] }>("subscribe", { topics: ["status"] })).topics ?? []).sort()
    session.want(["memory"])
    await until(() => snapshots.includes("memory"))
    expect(await held()).toEqual(["memory", "status"])
    session.want([])
    // The unsubscribe goes out without waiting: ask until the core has it.
    let topics = await held()
    for (let i = 0; i < 100 && topics.join() !== "status"; i++) topics = (await Bun.sleep(20), await held())
    expect(topics).toEqual(["status"])
    // Wanted again, then the core restarts: the new core is asked for it too.
    session.want(["memory", "status"])
    await until(() => snapshots.filter((t) => t === "memory").length === 2)
    snapshots.length = 0
    await first.stop("test")
    const second = await start()
    await until(() => snapshots.includes("status") && snapshots.includes("memory"), 5000)
    session.close()
    await second.stop("test")
  })
})

describe("the mode across a restart", () => {
  test("the mode last picked survives a restart, whatever config.toml says", async () => {
    // The config says live; the user switches to paper; the core restarts in paper, not live.
    const c = await startTestCore()
    const view = await c.view()
    expect((await view.request("core.status", {})).result).toMatchObject({ mode: "live" })
    await view.request("mode.set", { mode: "paper" })
    expect(JSON.parse(readFileSync(c.p.modeState, "utf8"))).toMatchObject({ mode: "paper" })
    const p = c.p
    await c.close()
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      const client = await connectTestClient(p.socket)
      await client.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "test" })
      expect((await client.request("core.status", {})).result).toMatchObject({ mode: "paper" })
      client.close()
      const started = again.journal.rows().filter((r) => r.type === "core.started").at(-1)
      expect(started).toMatchObject({ mode: "paper", modeFrom: "saved" })
    } finally {
      await again.stop("test")
    }
  })
})

describe("the active agent across a restart, and a stop asked for", () => {
  test("the agent last made active is the one a restarted core starts on; the press to stop a turn is journalled", async () => {
    const c = await startTestCore()
    const view = await c.view()
    expect((await view.request("core.status", {})).result).toMatchObject({ activeAgent: "momentum" })
    await view.request("agent.setActive", { agent: "swing" })
    await view.request("agent.cancel", { agent: "swing", keepQueued: true })
    expect(c.core.journal.rows().find((r) => r.type === "agent.stop_asked")).toMatchObject({ agent: "swing" })
    const p = c.p
    await c.close()
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      const client = await connectTestClient(p.socket)
      await client.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "test" })
      expect((await client.request("core.status", {})).result).toMatchObject({ activeAgent: "swing" })
      client.close()
    } finally {
      await again.stop("test")
    }
  })
})

describe("holdingFrom", () => {
  const wallet = "WalletFake111111111111111111111111111111111"
  const mint = "MoonFake11111111111111111111111111111111111"
  test("reads a token's raw amount from the embedded wallet; a failed read is unreadable, never zero", () => {
    const result = { embedded: [{ address: wallet, tokens: [{ mint, amountRaw: "12345", decimals: 6 }] }] }
    expect(holdingFrom(result, wallet, mint)).toEqual({ amountRaw: 12345n, decimals: 6 })
    expect(holdingFrom(result, wallet, "Other")).toBe("none")
    expect(holdingFrom({ embedded: [{ address: wallet, tokens: null }] }, wallet, mint)).toBe("unreadable")
    expect(holdingFrom({}, wallet, mint)).toBe("unreadable")
  })

  test("finds a token in a TEE wallet too, so a TEE sell's estimate sees it", () => {
    const tee = "TeeFake111111111111111111111111111111111111"
    const result = { embedded: [{ address: wallet, tokens: [] }], tee: [{ id: "teeid1", address: tee, tokens: [{ mint, amountRaw: "777", decimals: 6 }] }] }
    expect(holdingFrom(result, tee, mint)).toEqual({ amountRaw: 777n, decimals: 6 })
    expect(holdingFrom(result, wallet, mint)).toBe("none")
    expect(holdingFrom({ embedded: [], tee: [{ address: tee, tokens: null }] }, tee, mint)).toBe("unreadable")
    expect(holdingFrom({ embedded: [] }, tee, mint)).toBe("none")
  })

  test("finds a token in a Hood wallet under `hood`, its address and contract in any case", () => {
    const hoodTee = "0x00000000000000000000000000000000000Ho0d1"
    const token = "0x00000000000000000000000000000000000T0ke1"
    const result = { embedded: [{ address: wallet, tokens: [] }], tee: [], hood: { embedded: [], tee: [{ id: "teeid4", address: hoodTee, chain: "hood", tokens: [{ chain: "hood", mint: token, amountRaw: "5000", decimals: 18 }] }] } }
    expect(holdingFrom(result, hoodTee.toLowerCase(), token.toLowerCase())).toEqual({ amountRaw: 5000n, decimals: 18 })
    expect(holdingFrom({ ...result, hood: { embedded: [], tee: [{ address: hoodTee, tokens: null }] } }, hoodTee, token)).toBe("unreadable")
    // A Solana address never matches in another case.
    expect(holdingFrom({ embedded: [{ address: wallet, tokens: [{ mint, amountRaw: "1", decimals: 6 }] }] }, wallet.toLowerCase(), mint)).toBe("none")
  })
})

describe("typed trades and the status bar's figures", () => {
  const MOON = "MoonFake11111111111111111111111111111111111"
  const buy = { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true }

  test("a typed trade is a one-press card by default", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    const card = (await view.request("cards.propose", buy)).result as { state: string; instant?: unknown }
    expect(card.state).toBe("awaiting_approval")
    expect(card.instant).toBeUndefined()
  })

  test("with cards.typedTrades = instant it's approved in the same call, as the user's", async () => {
    const { p, candle } = await testHome()
    const core = await startCore({ paths: p, config: testConfig(candle, { cards: { typedTrades: "instant" } }), env: process.env, headless: true })
    try {
      await core.candleReady
      const { connectTestClient } = await import("../../test/core-test-client")
      const { readViewToken } = await import("./tokens")
      const { PROTOCOL_VERSION } = await import("../shared/rpc")
      const view = await connectTestClient(p.socket)
      await view.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "t" })
      const typed = (await view.request("cards.propose", buy)).result as { cardId: string; instant: { kind: string; operation: { state: string } } }
      expect(typed.instant).toMatchObject({ kind: "submitted", operation: { state: "succeeded" } })
      expect(core.journal.rows().find((r) => r.type === "card.approved" && r.cardId === typed.cardId)).toMatchObject({ how: "instant" })
      // A trade the agent proposes still waits for the press, and so does one not marked typed.
      const untyped = (await view.request("cards.propose", { ...buy, typed: false, args: { ...buy.args, amount: "0.02" } })).result as { instant?: unknown; state: string }
      expect(untyped).toMatchObject({ state: "awaiting_approval" })
      expect(untyped.instant).toBeUndefined()
      view.close()
    } finally {
      await core.stop("test")
    }
  })

  test("after a restart, today's spend counts a buy approved before more rows than the journal's window holds", async () => {
    const account = "acct_spendwindowtest0001"
    const c = await startTestCore({}, {
      before: (p) => {
        mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
        writeFileSync(join(p.stateDir, "account"), `${account}\n`, { mode: 0o600 })
        const at = new Date(Date.now() - 2_000).toISOString()
        const row = (seq: number, type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ seq, at, type, account, mode: "live", ...extra })
        const lines = [
          row(1, "card.approved", { opId: "op-early", cardId: "card-early", agent: "momentum", usd: 7, side: "buy", how: "view", wallet: "W" }),
          row(2, "operation.submitting", { opId: "op-early", cardId: "card-early", agent: "momentum", kind: "trade", tool: "candle_trade", params: {} }),
          row(3, "operation.succeeded", { opId: "op-early", cardId: "card-early", agent: "momentum" }),
        ]
        for (let seq = 4; seq <= 10_010; seq++) lines.push(row(seq, "client.attached"))
        writeFileSync(p.journal, `${lines.join("\n")}\n`, { mode: 0o600 })
      },
    })
    cores.push(c)
    expect(c.core.journal.rows().some((r) => r.opId === "op-early")).toBe(false)
    const view = await c.view()
    const status = (await view.request("core.status", {})).result as { agents: { name: string; spentTodayUsd: number }[] }
    expect(status.agents.find((a) => a.name === "momentum")?.spentTodayUsd).toBe(7)
  })

  test("the status carries each agent's spend today and limits, exposure, and the P&L window's figure", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    const status = (await view.request("core.status", {})).result as {
      agents: { name: string; spentTodayUsd: number; limits: { perTradeUsd: number; perDayUsd: number } }[]
      exposureUsd: number | null
      pnl: { usd: number | null; label: string; from: number | null; short: boolean }
      typedTrades: string
    }
    expect(status.agents.find((a) => a.name === "momentum")).toMatchObject({ spentTodayUsd: 0, limits: { perTradeUsd: 10, perDayUsd: 50 } })
    // Named by its window, the last 24 hours on a fresh install; null before Candle's P&L is read, never 0.
    expect(status.pnl).toMatchObject({ label: "24h" })
    if (status.pnl.from === null) expect(status.pnl.usd).toBeNull()
    expect(status.typedTrades).toBe("card")
    // The view's attach starts the portfolio reads; the fake wallet holds MOON at $0.63.
    await until(() => (c.core.server as unknown as { viewCount(): number }).viewCount() > 0)
    let exposure: number | null = null
    await until(() => {
      // A poll still out when the test ends is answered with an error by the stopping core: no result.
      void view.request("core.status", {}).then((r) => (exposure = (r.result as { exposureUsd: number | null } | undefined)?.exposureUsd ?? exposure))
      return exposure !== null
    })
    expect(exposure!).toBeCloseTo(12_345.678901 * 0.63, 2)
  })
})

describe("limits with who enforces them", () => {
  test("the status names each limit's enforcer, with Candle's key cap once its status is read", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    type Line = { by: string; what: string; words: string }
    let lines: Line[] = []
    await until(() => {
      void view.request("core.status", {}).then((r) => {
        const agents = (r.result as { agents: { name: string; limitLines: Line[] }[] } | undefined)?.agents
        lines = agents?.find((a) => a.name === "momentum")?.limitLines ?? lines
      })
      return lines.some((l) => l.what === "volume")
    })
    expect(lines.map((l) => l.words)).toEqual(["Harness · $10.00 a trade", "Harness · $50.00 a day · $0.00 used", "Candle · $100.00 a UTC day, all volume"])
  })

  test("a status read that couldn't read the key's limits says Candle's caps aren't read, never that there are none", async () => {
    const c = await startTestCore({}, { candle: { momentum: { unreadable: ["limits"] } } })
    cores.push(c)
    const view = await c.view()
    type Agent = { name: string; wallet?: string; limitLines: { by: string; what: string; words: string }[] }
    let agent: Agent | undefined
    await until(() => {
      void view.request("core.status", {}).then((r) => {
        agent = (r.result as { agents: Agent[] } | undefined)?.agents.find((a) => a.name === "momentum") ?? agent
      })
      // Read once the status has its wallet.
      return agent?.wallet !== undefined
    })
    const candle = agent!.limitLines.filter((l) => l.by === "Candle")
    expect(candle.map((l) => l.what)).toEqual(["unread"])
  })

  test("a live sell Candle closed as the key's paper position reaches the card as paper, not a plain fill", async () => {
    const c = await startTestCore({}, { candle: { momentum: { tools: { candle_trade: "sell-to-paper" } } } })
    cores.push(c)
    const view = await c.view()
    const sell = { tool: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "sell", percent: 50 }, typed: true }
    const card = (await view.request("cards.propose", sell)).result as { cardId: string; cardHash: string }
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    await until(() => c.core.cards.get(card.cardId)?.operation?.state === "succeeded")
    expect(c.core.cards.get(card.cardId)!.operation).toMatchObject({ state: "succeeded", paper: true })
  })

  test("a re-sent sell Candle closed as the key's paper position reaches the card as paper too", async () => {
    const c = await startTestCore({ env: { ...process.env, CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1" } }, { candle: { momentum: { tools: { candle_trade: "sell-to-paper" } } } })
    cores.push(c)
    const view = await c.view()
    const sell = { tool: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "sell", percent: 50 }, typed: true }
    const card = (await view.request("cards.propose", sell)).result as { cardId: string; cardHash: string; opId: string }
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    await until(() => c.core.operations.get(card.opId)?.state === "unknown")
    await view.request("operations.resolve", { opId: card.opId, action: "resend" })
    await until(() => c.core.cards.get(card.cardId)?.operation?.state === "succeeded")
    expect(c.core.cards.get(card.cardId)!.operation).toMatchObject({ state: "succeeded", paper: true })
  })

  test("a typed paper buy the core refuses before Candle trades it (a token Candle doesn't know) answers the refusal and leaves a row", async () => {
    const c = await startTestCore({}, { config: { mode: "paper" } })
    cores.push(c)
    const view = await c.view()
    const buy = { tool: "candle_trade", args: { mint: "UnknFake11111111111111111111111111111111111", side: "buy", amountUsd: "1" }, typed: true }
    const answer = (await view.request("cards.propose", buy)).result as { paper: { isError?: boolean; content: { text: string }[] } }
    expect(answer.paper.isError).toBe(true)
    expect(answer.paper.content[0]!.text).toContain("TOKEN_UNKNOWN")
    expect(c.core.journal.rows().find((r) => r.type === "tool.refused" && r.code === "TOKEN_UNKNOWN")).toMatchObject({ role: "view", tool: "candle_trade", message: "Candle doesn't know this token." })
  })

  test("a view can't claim a trade ran without a card: its approval is recorded as the view's", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    const buy = { tool: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "buy", amount: "0.01" }, typed: true }
    const card = (await view.request("cards.propose", buy)).result as { cardId: string; cardHash: string }
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "inside-limits" })
    expect(c.core.journal.rows().find((r) => r.type === "card.approved" && r.cardId === card.cardId)).toMatchObject({ how: "view" })
  })
})

test("a fill reads the portfolio again as the chain settles; nothing else does", () => {
  const scheduled: number[] = []
  readAfterFill({ type: "operation.succeeded" }, (ms) => scheduled.push(ms))
  for (const type of ["operation.refused", "operation.unknown", "card.approved", "paper.call"]) readAfterFill({ type }, (ms) => scheduled.push(ms))
  expect(scheduled).toEqual(AFTER_FILL_READS_MS)
  expect(AFTER_FILL_READS_MS[0]).toBeLessThan(8_000)
})

describe("which wallets the panes show", () => {
  test("a view or the agent sets it, by name, checked against the wallets read; it's kept, journalled and published", async () => {
    const tee = { id: "teeA", address: "TeeA111111111111111111111111111111111111111", label: "tee-one", boundKeyPrefix: "Momentum" }
    const c = await startTestCore({}, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: { teeWallets: [tee] }, swing: { teeWallets: [tee] } } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["portfolio", "status"] })
    await until(() => view.events.some((e) => e.topic === "portfolio" && (e.data as { readAt?: unknown } | null)?.readAt != null))
    const lastStatus = () => [...view.events].reverse().find((e) => e.topic === "status")?.data as { walletsShown?: unknown } | undefined
    expect(lastStatus()?.walletsShown).toBe("active")

    // A name that isn't a wallet is refused, with the wallets there are.
    const wrong = await view.request("wallets.show", { show: ["nope"] })
    expect(wrong.error?.data).toMatchObject({ code: "UNKNOWN_WALLET" })
    expect(wrong.error?.message).toContain("embedded, tee-one")

    expect((await view.request("wallets.show", { show: ["tee-one"] })).result).toEqual({ show: ["tee-one"] })
    await until(() => JSON.stringify(lastStatus()?.walletsShown) === JSON.stringify(["tee-one"]))
    expect(JSON.parse(readFileSync(c.p.walletsShown, "utf8")).show).toEqual(["tee-one"])

    // The agent has the tool; it can't use the view's method.
    const { client } = await c.harness(view)
    const tools = (await client.request("tools.list", {})).result as { tools: { name: string }[] }
    expect(tools.tools.map((t) => t.name)).toContain("harness_show_wallets")
    expect((await client.request("wallets.show", { show: "all" })).error).toBeDefined()
    const answer = (await client.request("tools.call", { name: "harness_show_wallets", args: { show: "all" } })).result as { content: { text: string }[] }
    expect(JSON.parse(answer.content[0]!.text)).toEqual({ success: true, shown: "The panes now show embedded, tee-one." })
    const rows = c.core.journal.rows().filter((r) => r.type === "wallets.shown")
    expect(rows.map((r) => [r.show, r.agent])).toEqual([[["tee-one"], undefined], ["all", "momentum"]])
  })
})


describe("the link and pins", () => {
  const MOON = "MoonFake11111111111111111111111111111111111"
  const SOL = "So11111111111111111111111111111111111111112"
  const UNKNOWN = `NoMarketFake${"1".repeat(31)}`
  test("a view's pick moves the link, said on the views topic with who moved it; a base asset or a token Candle doesn't know says why", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["views", "market"] })
    const lastViews = () => view.events.filter((e) => e.topic === "views").at(-1)?.data as { link: { mint: string; by?: string } | null; pins: unknown[]; signals: unknown[]; popped: unknown[] } | undefined
    await until(() => lastViews() !== undefined)
    expect(lastViews()).toEqual({ link: null, pins: [], signals: [], popped: [] })

    expect((await view.request("view.link", { mint: MOON, from: "feed, by a click" })).result).toEqual({ linked: true, symbol: "MOON" })
    await until(() => lastViews()?.link?.mint === MOON)
    expect(lastViews()?.link?.by).toBe("you")
    // Each pick is journalled with where it came from (a pick nobody remembered couldn't be traced).
    expect(c.core.journal.rows().find((r) => r.type === "view.picked")).toMatchObject({ mint: MOON, symbol: "MOON", from: "feed, by a click" })
    // The same token again straight after is the same pick, journalled once.
    expect((await view.request("view.link", { mint: MOON, from: "feed, by a click" })).result).toEqual({ linked: true, symbol: "MOON" })
    expect(c.core.journal.rows().filter((r) => r.type === "view.picked")).toHaveLength(1)

    expect((await view.request("view.link", { mint: SOL })).error?.data).toMatchObject({ code: "BASE_ASSET" })
    expect((await view.request("view.link", { mint: UNKNOWN })).error?.data).toMatchObject({ code: "NO_MARKET" })
    expect((await view.request("view.link", { mint: "not a mint" })).error).toBeDefined()
    expect(lastViews()?.link?.mint).toBe(MOON)

    // The agent moves the link by showing a token; it can't pick, pin or unpin.
    const { client } = await c.harness(view)
    for (const method of ["view.link", "view.pin", "view.unpin"]) expect((await client.request(method, { mint: MOON, at: "Trade" })).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })
  })

  test("a pin holds a place on the linked token, kept 0600 across a restart; a fourth says which to unpin", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["views", "market"] })
    expect((await view.request("view.pin", { at: "Trade" })).error?.data).toMatchObject({ code: "NOT_WATCHED" })
    await view.request("view.link", { mint: MOON })
    for (const at of ["Trade", "Cockpit", "Mine"]) expect((await view.request("view.pin", { at })).error).toBeUndefined()
    const fourth = await view.request("view.pin", { at: "Fourth" })
    expect(fourth.error?.data).toMatchObject({ code: "TOO_MANY_PINS" })
    expect(fourth.error?.message).toContain("Trade on MOON, Cockpit on MOON, Mine on MOON")
    expect((await view.request("view.unpin", { at: "Mine" })).result).toEqual({ pins: [{ at: "Trade", mint: MOON, chain: "solana", symbol: "MOON" }, { at: "Cockpit", mint: MOON, chain: "solana", symbol: "MOON" }] })
    await until(() => (view.events.filter((e) => e.topic === "views").at(-1)?.data as { pins: unknown[] }).pins.length === 2)
    // The market topic carries the pinned token's data beside the linked one's.
    await until(() => (view.events.filter((e) => e.topic === "market").at(-1)?.data as { pinned?: { mint: string }[] }).pinned?.[0]?.mint === MOON)
    expect(statSync(c.p.pinsState).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(c.p.pinsState, "utf8")).pins.map((p: { at: string }) => p.at)).toEqual(["Trade", "Cockpit"])
  })
})

describe("an agent's allow and deny lists", () => {
  test("hide Candle's tools and the research tools from that agent's engine, whatever it calls or proposes, and never from a view", async () => {
    const agents = testConfig("candle").agents
    agents.momentum!.tools = { shell: "off", deny: ["candle_trade", "read", "harness_*"] }
    const c = await startTestCore({}, { config: { agents } })
    cores.push(c)
    const view = await c.view()
    const { client } = await c.harness(view, "momentum")
    const names = ((await client.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)
    for (const hidden of ["candle_trade", "research_read", "research_list", "harness_show_wallets"]) expect(names).not.toContain(hidden)
    expect(names).toContain("candle_swap")
    expect(names).toContain("candle_cli")
    const called = await client.request("tools.call", { name: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "buy", amount: "0.01" } })
    expect(called.error?.data).toMatchObject({ code: "TOOL_HIDDEN" })
    expect(called.error?.message).toBe("candle_trade is turned off for momentum in config.toml (agents.momentum.tools), so it isn't offered.")
    const proposed = await client.request("cards.propose", { tool: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "buy", amount: "0.01" } })
    expect(proposed.error?.data).toMatchObject({ code: "TOOL_HIDDEN" })
    // Another agent's engine, and the person's view, are unaffected.
    const swing = await c.harness(view, "swing")
    expect(((await swing.client.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain("candle_trade")
    expect(((await view.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain("candle_trade")
    // The engine topic carries the settings, for the picker's line.
    await view.request("subscribe", { topics: ["engine"] })
    await until(() => view.events.some((e) => e.topic === "engine"))
    const topic = view.events.find((e) => e.topic === "engine")!.data as { agents: Record<string, { tools?: unknown }> }
    expect(topic.agents.momentum!.tools).toEqual({ shell: "off", deny: ["candle_trade", "read", "harness_*"] })
    expect(topic.agents.swing!.tools).toBeUndefined()
  })
})

describe("Hacc in the core", () => {
  test("the hacc topic names each agent's plan and whether Hacc takes its key, never a key, to views only", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const { AGENT_KEY, SWING_KEY } = await import("../../test/core-fixture")
    const hacc = startFakeHacc({ keys: [AGENT_KEY] }) // swing's key isn't one Hacc takes
    try {
      const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } })
      cores.push(c)
      expect((await c.core.hacc.get("momentum", "/v1/signals", { limit: 1 })).kind).toBe("ok")
      expect((await c.core.hacc.get("swing", "/v1/signals")).kind).toBe("refused")
      expect(hacc.calls.map((call) => call.auth)).toEqual([`Bearer ${AGENT_KEY}`, `Bearer ${SWING_KEY}`])
      const view = await c.view()
      await view.request("subscribe", { topics: ["hacc"] })
      await until(() => view.events.some((e) => e.topic === "hacc"))
      const topic = view.events.find((e) => e.topic === "hacc")!.data as { enabled: boolean; agents: Record<string, { plan: string | null; key: string; why?: string }>; stream: { state: string } }
      expect(topic.enabled).toBe(true)
      expect(topic.agents.momentum).toMatchObject({ plan: "max", key: "ok" })
      expect(topic.agents.swing).toMatchObject({ plan: "pro", key: "refused" })
      expect(topic.agents.swing!.why).toContain("invalid api key")
      expect(topic.stream.state).toBe("closed")
      expect(JSON.stringify(topic)).not.toContain(AGENT_KEY)
      expect(JSON.stringify(topic)).not.toContain(SWING_KEY)
      const { client } = await c.harness(view, "momentum")
      expect((await client.request("subscribe", { topics: ["hacc"] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    } finally {
      hacc.stop()
    }
  })

  test("signals: one socket for every view and harness, each subscription with its own filter", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const { AGENT_KEY } = await import("../../test/core-fixture")
    const hacc = startFakeHacc({ keys: [AGENT_KEY] })
    try {
      const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } })
      cores.push(c)
      const all = await c.view()
      const confluence = await c.view()
      const { client: harness } = await c.harness(all, "momentum")
      expect((await all.request("subscribe", { topics: ["signals", "hacc"] })).error).toBeUndefined()
      expect((await confluence.request("subscribe", { topics: ["signals"], filters: { signals: { pattern: "confluence" } } })).error).toBeUndefined()
      expect((await harness.request("subscribe", { topics: ["signals"] })).error).toBeUndefined()
      // A filter is checked before anything is subscribed.
      expect((await all.request("subscribe", { topics: ["signals"], filters: { signals: { venue: "pump" } } })).error?.message).toContain("pattern and chain")
      expect((await all.request("subscribe", { topics: ["hacc"], filters: { signals: { pattern: "confluence" } } })).error?.message).toContain("same call")
      expect((await all.request("subscribe", { topics: ["hacc"], filters: { hacc: {} } })).error?.message).toContain("takes no filter")
      const rowsOf = (client: typeof all) => client.events.filter((e) => e.topic === "signals").flatMap((e) => ((e.data as { rows?: { id: number; pattern: string }[] }).rows ?? []))
      await until(() => rowsOf(all).length >= 100 && rowsOf(harness).length >= 100)
      expect(hacc.state.sockets.size).toBe(1)
      const hood = hacc.push({ pattern: "confluence" })
      const ticker = hacc.push({ pattern: "new_ticker" })
      await until(() => rowsOf(all).some((r) => r.id === ticker.id) && rowsOf(confluence).some((r) => r.id === hood.id))
      expect(rowsOf(confluence).every((r) => r.pattern === "confluence")).toBe(true)
      expect(rowsOf(harness).some((r) => r.id === ticker.id)).toBe(true)
      expect(hacc.state.sockets.size).toBe(1)
      await until(() => all.events.some((e) => e.topic === "hacc" && (e.data as { stream: { state: string } }).stream.state === "open"))
      const stream = all.events.filter((e) => e.topic === "hacc").at(-1)!.data as { stream: { state: string; agent?: string; rows: number } }
      expect(stream.stream).toMatchObject({ state: "open", agent: "momentum" })
      expect(JSON.stringify(stream)).not.toContain(AGENT_KEY)
      // Personal signals, for harnesses too.
      expect((await harness.request("subscribe", { topics: ["signals:mine"] })).error).toBeUndefined()
      expect(c.core.journal.rows().some((r) => r.type === "hacc.stream" && r.event === "opened")).toBe(true)
    } finally {
      hacc.stop()
    }
  })

  test("a tab's Signals choice is kept for every view, and a filter is read back from Hacc for its own subscription alone", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const { AGENT_KEY } = await import("../../test/core-fixture")
    const hacc = startFakeHacc({ keys: [AGENT_KEY] })
    try {
      const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } })
      cores.push(c)
      const whole = await c.view()
      const dormancy = await c.view()
      const { client: harness } = await c.harness(whole, "momentum")
      // The choice is the person's: kept by the tab, said on views, and refused to an agent.
      await whole.request("subscribe", { topics: ["views", "signals"] })
      expect((await dormancy.request("view.signals", { at: "Signals", pattern: "dormancy", chain: null, mine: false })).result).toEqual({ signals: [{ at: "Signals", pattern: "dormancy" }] })
      await until(() => (whole.events.filter((e) => e.topic === "views").at(-1)?.data as { signals: unknown[] }).signals.length === 1)
      expect((await dormancy.request("view.signals", { at: "Signals", pattern: "Not A Pattern" })).error).toBeDefined()
      expect((await harness.request("view.signals", { at: "Signals", mine: true })).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })
      expect(JSON.parse(readFileSync(c.p.signalsFilters, "utf8")).signals).toEqual([{ at: "Signals", pattern: "dormancy" }])
      expect(statSync(c.p.signalsFilters).mode & 0o777).toBe(0o600)

      // The stream's hundred are all new_ticker; Hacc's tape has a dormancy signal older than them.
      const rowsOf = (client: typeof whole) => client.events.filter((e) => e.topic === "signals").flatMap((e) => ((e.data as { rows?: { id: number; pattern: string }[] }).rows ?? []))
      await until(() => rowsOf(whole).length >= 100)
      expect((await dormancy.request("subscribe", { topics: ["signals"], filters: { signals: { pattern: "dormancy" } } })).error).toBeUndefined()
      await until(() => dormancy.events.some((e) => e.topic === "signals" && (e.data as { back?: unknown }).back !== undefined))
      expect(rowsOf(dormancy).map((r) => r.pattern)).toEqual(["dormancy"])
      const back = dormancy.events.find((e) => e.topic === "signals" && (e.data as { back?: unknown }).back)!.data as { back: { ok: boolean; rows: number }; since?: string }
      expect(back.back).toMatchObject({ ok: true, rows: 1 })
      expect(back.since).toBeDefined()
      expect(hacc.calls.filter((call) => call.path === "/v1/signals" && call.query.pattern === "dormancy").length).toBe(1)
      // The whole tape never gets the older row.
      await Bun.sleep(50)
      expect(rowsOf(whole).some((r) => r.pattern === "dormancy")).toBe(false)
      // Subscribed again with the same filter within the minute: its snapshot has what was found, and Hacc isn't asked again.
      expect((await dormancy.request("subscribe", { topics: ["signals"], filters: { signals: { pattern: "dormancy" } } })).error).toBeUndefined()
      const snap = dormancy.events.filter((e) => e.topic === "signals").at(-1)!.data as { rows: { pattern: string }[]; back?: { ok: boolean } }
      expect(snap.rows.map((r) => r.pattern)).toEqual(["dormancy"])
      expect(snap.back?.ok).toBe(true)
      expect(hacc.calls.filter((call) => call.path === "/v1/signals" && call.query.pattern === "dormancy").length).toBe(1)
    } finally {
      hacc.stop()
    }
  })

  test("Hacc's reads as tools: offered by plan, read with the agent's own key, a plan change between turns", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const { AGENT_KEY, SWING_KEY } = await import("../../test/core-fixture")
    const hacc = startFakeHacc({ keys: [AGENT_KEY] }) // swing's key isn't one Hacc takes
    try {
      const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } })
      cores.push(c)
      const view = await c.view()
      const { client: momentum } = await c.harness(view, "momentum")
      const { client: swing } = await c.harness(view, "swing")
      const names = async (client: typeof momentum) => ((await client.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name).filter((n) => n.startsWith("hacc_"))
      const call = async (client: typeof momentum, name: string, args: Record<string, unknown>) => {
        const r = (await client.request("tools.call", { name, args })).result as { content: { text: string }[]; isError?: boolean }
        return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) }
      }
      expect(await names(momentum)).toEqual(["hacc_signals", "hacc_token", "hacc_market", "hacc_wallets", "hacc_social", "hacc_follows", "hacc_lab"])
      expect(await names(swing)).toEqual(["hacc_signals", "hacc_token", "hacc_market", "hacc_wallets", "hacc_social", "hacc_follows"]) // swing's account reads as Pro

      // A read goes to Hacc with the calling agent's own key, and the answer carries no key.
      const tape = await call(momentum, "hacc_signals", { view: "by_token" })
      expect(tape.body).toMatchObject({ success: true, source: "hacc", view: "by_token" })
      expect(hacc.calls.at(-1)).toMatchObject({ path: "/v1/signals", query: { group_by: "token" }, auth: `Bearer ${AGENT_KEY}` })
      expect(JSON.stringify(tape)).not.toContain(AGENT_KEY)

      // Hacc refuses swing's key: the answer says so, and swing loses Hacc's tools until its key answers.
      const refused = await call(swing, "hacc_market", { view: "metas" })
      expect(refused.body.error).toMatchObject({ code: "HACC_KEY_REFUSED" })
      expect(JSON.stringify(refused)).not.toContain(SWING_KEY)
      expect(await names(swing)).toEqual([])
      expect(await names(momentum)).toHaveLength(7)

      // The account moves to Pro. The next lab call still goes out, Hacc's 403 answers in words, the plan
      // is read again, and the next turn isn't offered the lab.
      writeFileSync(join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle.json"), JSON.stringify({ tier: "pro" }))
      hacc.set({ plan: "pro" })
      const lab = await call(momentum, "hacc_lab", { view: "strategies" })
      expect(lab.body.error).toMatchObject({ code: "PLAN_REQUIRED" })
      let offered = await names(momentum)
      for (let i = 0; i < 100 && offered.includes("hacc_lab"); i++) {
        await Bun.sleep(20)
        offered = await names(momentum)
      }
      expect(offered).toEqual(["hacc_signals", "hacc_token", "hacc_market", "hacc_wallets", "hacc_social", "hacc_follows"])
    } finally {
      hacc.stop()
    }
  })

  test("Hacc's tools hide by name in an agent's tools settings, and with [hacc] off none is offered", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const { AGENT_KEY } = await import("../../test/core-fixture")
    const hacc = startFakeHacc({ keys: [AGENT_KEY] })
    try {
      const c = await startTestCore(
        { haccHost: hacc.url },
        {
          config: {
            hacc: { enabled: true },
            agents: {
              momentum: { name: "momentum", limits: { perTradeUsd: 10, perDayUsd: 50 }, tools: { shell: "off", deny: ["hacc_lab", "hacc_social"] } },
              swing: { name: "swing", limits: { perTradeUsd: 10, perDayUsd: 50 } },
            },
          },
          candle: { momentum: { tier: "max" } },
        },
      )
      cores.push(c)
      const { client } = await c.harness(undefined, "momentum")
      const list = ((await client.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)
      expect(list.filter((n) => n.startsWith("hacc_"))).toEqual(["hacc_signals", "hacc_token", "hacc_market", "hacc_wallets", "hacc_follows"])
      expect((await client.request("tools.call", { name: "hacc_lab", args: { view: "strategies" } })).error?.message).toContain("turned off for momentum")
      expect(hacc.calls).toEqual([])

      const off = await startTestCore({ haccHost: hacc.url }, { candle: { momentum: { tier: "max" } } })
      cores.push(off)
      const { client: offClient } = await off.harness(undefined, "momentum")
      const offList = ((await offClient.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)
      expect(offList.some((n) => n.startsWith("hacc_"))).toBe(false)
      const r = (await offClient.request("tools.call", { name: "hacc_market", args: { view: "metas" } })).result as { content: { text: string }[] }
      expect(JSON.parse(r.content[0]!.text).error.code).toBe("HACC_OFF")
      expect(hacc.calls).toEqual([])
    } finally {
      hacc.stop()
    }
  })
})

describe("popped panes", () => {
  type Views = { popped: string[] }
  const lastViews = (client: { events: { topic: string; data: unknown }[] }) => client.events.filter((e) => e.topic === "views").at(-1)?.data as Views | undefined

  test("a view pops a pane: the views topic says so until its connection goes; another view can't take it, and the conversation never pops", async () => {
    const c = await startTestCore()
    cores.push(c)
    const tiled = await c.view()
    await tiled.request("subscribe", { topics: ["views"] })
    await until(() => lastViews(tiled) !== undefined)
    expect(lastViews(tiled)!.popped).toEqual([])

    const popped = await c.view()
    expect((await popped.request("view.pop", { pane: "positions" })).result).toEqual({ popped: ["positions"] })
    await until(() => lastViews(tiled)!.popped.includes("positions"))
    // The same view again (a reconnect's) is fine; another view is refused, naming why.
    expect((await popped.request("view.pop", { pane: "positions" })).error).toBeUndefined()
    const other = await c.view()
    const refused = await other.request("view.pop", { pane: "positions" })
    expect(refused.error?.data).toMatchObject({ code: "POPPED_ELSEWHERE" })
    expect(refused.error?.message).toContain("close that one")
    // The agent's conversation stays in the main window, and a made-up pane is no pane.
    for (const pane of ["agent", "chart", 3]) expect((await other.request("view.pop", { pane })).error?.data).toMatchObject({ code: "INVALID_PARAMS" })
    // The agent can't move the person's panes.
    const { client } = await c.harness(tiled)
    expect((await client.request("view.pop", { pane: "feed" })).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })

    // Closed: the pane comes back, and another view may take it now.
    popped.close()
    await until(() => lastViews(tiled)!.popped.length === 0)
    expect((await other.request("view.pop", { pane: "positions" })).result).toEqual({ popped: ["positions"] })
  })

  test("a popped view killed with SIGKILL gives its pane back", async () => {
    const c = await startTestCore()
    cores.push(c)
    const tiled = await c.view()
    await tiled.request("subscribe", { topics: ["views"] })
    const client = join(import.meta.dir, "client.ts")
    const script = `
      import { ViewSession } from ${JSON.stringify(client)}
      const s = new ViewSession({ socketPath: ${JSON.stringify(c.p.socket)}, viewTokenPath: ${JSON.stringify(c.p.viewToken)}, clientName: "candle-harness view --pane wallets", topics: ["status"] })
      await s.start()
      await s.request("view.pop", { pane: "wallets" })
      console.log("popped")
      await new Promise(() => {})
    `
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" })
    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain("popped")
    await until(() => lastViews(tiled)?.popped.includes("wallets") === true)
    child.kill("SIGKILL")
    await child.exited
    await until(() => lastViews(tiled)?.popped.length === 0)
  })
})

describe("the agent changes the screen", () => {
  const asksOf = (client: { events: { topic: string; data: unknown; snapshot?: boolean }[] }) =>
    client.events.filter((e) => e.topic === "asks" && !e.snapshot).map((e) => e.data as { id: string; agent: string; args: Record<string, unknown> })
  const callView = (client: { request: (m: string, p: Record<string, unknown>) => Promise<{ result?: unknown }> }, args: Record<string, unknown>) =>
    client.request("tools.call", { name: "harness_view", args }).then((r) => JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>)

  test("harness_view goes to the main view used last, which answers; its words reach the journal and Activity, and a refusal changes nothing", async () => {
    const c = await startTestCore()
    cores.push(c)
    const first = await c.view()
    const second = await c.view()
    // A popped view never listens on asks; both main views do.
    await first.request("subscribe", { topics: ["asks", "activity"] })
    await second.request("subscribe", { topics: ["asks"] })
    const { client } = await c.harness(first)
    expect(((await client.request("tools.list", {})).result as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain("harness_view")
    // A harness can't listen on asks, nor answer one.
    expect((await client.request("subscribe", { topics: ["asks"] })).error).toBeDefined()
    expect((await client.request("view.answer", { id: "x", result: { ok: true, text: "no" } })).error).toBeDefined()

    // The first view was used last: only it is asked.
    await first.request("view.active", {})
    const asked = callView(client, { action: "tab", tab: "Cockpit" })
    await until(() => asksOf(first).length === 1)
    expect(asksOf(second)).toEqual([])
    const ask = asksOf(first)[0]!
    expect(ask).toMatchObject({ agent: "momentum", args: { action: "tab", tab: "Cockpit" } })
    // Another view can't answer it for the one asked.
    expect((await second.request("view.answer", { id: ask.id, result: { ok: true, text: "wrong view" } })).result).toEqual({ taken: false })
    expect((await first.request("view.answer", { id: ask.id, result: { ok: true, text: "The screen shows the Cockpit tab.", words: "switched to the Cockpit tab" } })).result).toEqual({ taken: true })
    expect(await asked).toEqual({ success: true, done: "The screen shows the Cockpit tab." })
    await until(() => c.core.journal.rows().some((r) => r.type === "view.changed"))
    expect(c.core.journal.rows().find((r) => r.type === "view.changed")).toMatchObject({ agent: "momentum", action: "tab", words: "switched to the Cockpit tab" })
    await until(() => first.events.some((e) => e.topic === "activity" && JSON.stringify(e.data).includes("momentum switched to the Cockpit tab")))

    // Now the second view is used: the next ask goes there. Its refusal reaches the agent and isn't journalled.
    await second.request("view.active", {})
    const refused = callView(client, { action: "layout", layout: "Nope" })
    await until(() => asksOf(second).length === 1)
    await second.request("view.answer", { id: asksOf(second)[0]!.id, result: { ok: false, code: "UNKNOWN_LAYOUT", text: "There's no layout called Nope." } })
    expect(await refused).toMatchObject({ success: false, error: { code: "UNKNOWN_LAYOUT", message: "There's no layout called Nope." } })
    expect(c.core.journal.rows().filter((r) => r.type === "view.changed")).toHaveLength(1)

    // The person's click on the change is noted for Activity.
    await first.request("view.note", { agent: "momentum", words: "kept momentum's layout on Trade, as My Agent-first" })
    await until(() => first.events.some((e) => e.topic === "activity" && JSON.stringify(e.data).includes("you kept momentum's layout on Trade")))
    expect((await first.request("view.note", { agent: "nobody", words: "x" })).error).toBeDefined()

    // The person's own change to a layout or the tabs is journalled too.
    await first.request("view.set", { words: "resized agent on Trade" })
    expect(c.core.journal.rows().find((r) => r.type === "view.set")).toMatchObject({ words: "resized agent on Trade" })
    expect((await first.request("view.set", { words: "" })).error).toBeDefined()
  })

  test("with no view listening it says so; a view closing before it answers is said too; a bad action never reaches a view", async () => {
    const c = await startTestCore({}, {})
    cores.push(c)
    const registrar = await c.view()
    const { client } = await c.harness(registrar)
    expect(await callView(client, { action: "read" })).toMatchObject({ success: false, error: { code: "NO_VIEW" } })

    const view = await c.view()
    await view.request("subscribe", { topics: ["asks"] })
    expect(await callView(client, { action: "fly" })).toMatchObject({ success: false, error: { code: "MCP_VALIDATION" } })
    expect(asksOf(view)).toEqual([])
    const pending = callView(client, { action: "read" })
    await until(() => asksOf(view).length === 1)
    view.close()
    expect(await pending).toMatchObject({ success: false, error: { code: "VIEW_CLOSED" } })
  })

  test("a pin naming a token the pane doesn't show moves the link to it first, as the agent showing it would", async () => {
    const MOON = "MoonFake11111111111111111111111111111111111"
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["asks", "views"] })
    const { client } = await c.harness(view)
    const pinned = callView(client, { action: "pin", mint: MOON })
    await until(() => asksOf(view).length === 1)
    const followed = view.events.filter((e) => e.topic === "views").map((e) => (e.data as { link: { mint: string; by?: string } | null }).link)
    expect(followed.at(-1)).toMatchObject({ mint: MOON, by: "agent" })
    await view.request("view.answer", { id: asksOf(view)[0]!.id, result: { ok: true, text: "pinned" } })
    expect(await pinned).toEqual({ success: true, done: "pinned" })
  })

  test("a tab renamed takes its pin with it", async () => {
    const MOON = "MoonFake11111111111111111111111111111111111"
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("view.link", { mint: MOON })
    await view.request("view.pin", { at: "Trade" })
    expect(((await view.request("view.repin", { from: "Trade", to: "Desk" })).result as { pins: { at: string }[] }).pins.map((p) => p.at)).toEqual(["Desk"])
    expect(JSON.parse(readFileSync(c.p.pinsState, "utf8")).pins.map((p: { at: string }) => p.at)).toEqual(["Desk"])
  })
})

describe("each key's request budget", () => {
  test("the status carries each key's Candle limit from its plan and its use over the last minute, a card's call counted with the rest", async () => {
    const c = await startTestCore({}, { candle: { momentum: { tier: "free" } } })
    cores.push(c)
    const view = await c.view()
    const budgetNow = async () =>
      ((await view.request("core.status", {})).result as { budget: { keys: { agent: string; keyLimit: number; limit: number; used: number; background: number; allowance: number }[]; pace: object } }).budget
    // A view attached: prices are read in the background through the budget.
    let before = await budgetNow()
    for (const deadline = Date.now() + 5_000; before.keys[0]!.background < 1 && Date.now() < deadline; before = await budgetNow()) await Bun.sleep(50)
    expect(before.keys[0]!.background).toBeGreaterThanOrEqual(1)
    expect(before.keys[0]).toMatchObject({ agent: "momentum", keyLimit: 30, limit: 30, allowance: 15 })
    expect(before.pace).toEqual({})
    const { client } = await c.harness()
    await client.request("tools.call", { name: "candle_get_portfolio", args: {} })
    const after = await budgetNow()
    expect(after.keys[0]!.used).toBeGreaterThan(before.keys[0]!.used)
  })
})

describe("what only the main window may do, and what a client that only looks may not", () => {
  test("re-sending a trade is the main window's: a popped view and the doctor are refused, and letting go of one stays any view's but theirs that only look", async () => {
    const c = await startTestCore({ env: { ...process.env, CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1" } })
    cores.push(c)
    const main = await c.view("candle-harness")
    const popped = await c.view("candle-harness view --pane activity")
    const doctor = await c.view("candle-harness doctor")
    const card = (await main.request("cards.propose", { tool: "candle_trade", args: { mint: "MoonFake11111111111111111111111111111111111", side: "buy", amount: "0.01" }, typed: true })).result as { cardId: string; cardHash: string; opId: string }
    await main.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    await until(() => c.core.operations.get(card.opId)?.state === "unknown")
    for (const client of [popped, doctor]) expect((await client.request("operations.resolve", { opId: card.opId, action: "resend" })).error?.data?.code).toBe("MAIN_VIEW_ONLY")
    expect(c.core.journal.rows().some((r) => r.type === "operation.resend")).toBe(false)
    expect((await doctor.request("operations.resolve", { opId: card.opId, action: "abandon" })).error?.data?.code).toBe("OBSERVER")
    expect(c.core.operations.get(card.opId)!.state).toBe("unknown")
    // The main window's re-send still runs, and a popped view may still let one go.
    expect((await main.request("operations.resolve", { opId: card.opId, action: "resend" })).error).toBeUndefined()
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  })

  test("the doctor changes no agent, engine or preset; a message from `ask` is still sent", async () => {
    const quiet = scripted([async (_t, push) => push({ type: "text", delta: "hello" })])
    const c = await startTestCore({ engine: { start: quiet.start, version: () => ({ ok: true, version: "2.1.310" }), processes: () => [], leftoverDelayMs: 10 } })
    cores.push(c)
    const doctor = await c.view("candle-harness doctor")
    for (const [method, params] of [
      ["agent.setActive", { agent: "swing" }],
      ["engine.choose", { agent: "momentum", engine: "claude-code" }],
      ["preset.choose", { agent: "momentum", preset: "trader" }],
      ["hacc.undo", { changeId: "none" }],
    ] as const) {
      expect([method, (await doctor.request(method, params)).error?.data?.code]).toEqual([method, "OBSERVER"])
    }
    expect(c.core.journal.rows().some((r) => r.type === "agent.active" || r.type === "engine.chosen")).toBe(false)
    const ask = await c.view("candle-harness ask")
    expect((await ask.request("agent.send", { text: "hello" })).error).toBeUndefined()
  })
})

describe("a swap that failed at its second leg", () => {
  test("still counts toward the agent's day: its first leg left the wallet", async () => {
    const c = await startTestCore({}, { candle: { momentum: { tools: { candle_swap: { refuse: "LEG2_FAILED", extra: { leg1: "Leg1HashFake" } } } } } })
    cores.push(c)
    const view = await c.view("candle-harness")
    const spentToday = async () => ((await view.request("core.status", {})).result as { agents: { name: string; spentTodayUsd?: number }[] }).agents.find((a) => a.name === "momentum")?.spentTodayUsd
    const card = (await view.request("cards.propose", { tool: "candle_swap", args: { from: "SOL", to: "USDC", amount: "0.02" }, typed: true })).result as { cardId: string; cardHash: string; opId: string }
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    await until(() => c.core.operations.get(card.opId)?.state === "failed")
    expect(c.core.operations.get(card.opId)!.partial).toEqual({ leg1: "Leg1HashFake" })
    expect(c.core.cards.get(card.cardId)!.operation).toMatchObject({ state: "failed", partial: { leg1: "Leg1HashFake" } })
    const value = c.core.cards.get(card.cardId)!.value.usd!
    expect(value).toBeGreaterThan(0)
    expect(await spentToday()).toBeCloseTo(value, 6)
  })
})

describe("a token by a name the wallet already holds for another mint", () => {
  test("its card says so, with both short addresses; a token whose name is its own alone says nothing", async () => {
    const MOON = "MoonFake11111111111111111111111111111111111"
    const c = await startTestCore({}, { candle: { momentum: { heldTwin: true }, swing: { heldTwin: true } } })
    cores.push(c)
    const view = await c.view("candle-harness")
    await view.request("subscribe", { topics: ["portfolio", "cards"] })
    // The wallet's holdings are read, the twin among them, before the card is made.
    await until(() => view.events.some((e) => e.topic === "portfolio" && JSON.stringify(e.data).includes("MoonTwin")))
    const card = (await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, typed: true })).result as { display: { otherMint?: string; mint?: string } }
    expect(card.display.mint).toBe(MOON)
    expect(card.display.otherMint).toBe("another MOON is in a wallet or on an earlier card here (Moon…1111): this one is Moon…1111")
    const pepe = (await view.request("cards.propose", { tool: "candle_trade", args: { mint: "PepeFake11111111111111111111111111111111111", side: "buy", amount: "0.01" }, typed: true })).result as { display: { otherMint?: string } }
    expect(pepe.display.otherMint).toBeUndefined()
  })
})
