// Onboarding's step 3 through a core: the agent's key with Candle's cap on the create, made on the engine and
// model step 2 tested; the embedded wallet allowed in the pane; the Candle Harness's limits written into the agent's own
// table; "start on paper"; Straight in ending on paper; and a run that hasn't finished opening onboarding again
// on a machine that already has its agent.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { parseConfig } from "../config"
import { viewOpening } from "../main"
import { recordAgentLimits, storeNewAgentKey } from "../setup/key-add"
import { freeAgentName, type OnboardingView } from "../setup/onboarding"
import type { Card } from "./cards"
import { METHOD_ROLES } from "./server"

afterAll(() => cleanupHomes())
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})

const SIGNED = { exit: 0, body: { profile: "candle-harness", account: "WalletFake111111111111111111111111111111111", rows: [{ check: "Device token", state: "PASS" }] } }

async function setupCore(opts: { straightIn?: boolean; mode?: "paper" | "live" } = {}) {
  const cliDir = mkdtempSync(join(tmpdir(), "chrn-onb-step3-cli-"))
  const profileList = [{ name: "candle-harness", active: true, account: "WalletFake111111111111111111111111111111111", cachedAge: "1m", apiUrl: "https://api.candle.example", keyPrefix: "Ownerkey", rpcHost: null }]
  writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: { missing: true }, keysCreate: { prefix: "Agentaaa" }, authKeyPrefix: "Ownerkey", authStatus: SIGNED, profileList }))
  const t = await startTestCore(
    { env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } },
    {
      config: { agents: {}, activeAgent: "", mode: opts.mode ?? "paper" },
      before: (p) => {
        rmSync(p.keyFile("momentum"))
        rmSync(p.keyFile("swing"))
        writeFileSync(p.configFile, `mode = "${opts.mode ?? "paper"}"\n`)
        const at = new Date().toISOString()
        writeFileSync(p.onboarding, JSON.stringify({ version: 1, startedAt: at, updatedAt: at, straightIn: opts.straightIn === true, passed: ["welcome", "engine"], engine: "codex", model: "gpt-5.5", tested: { engine: "codex", model: "gpt-5.5", at } }), { mode: 0o600 })
      },
    },
  )
  cores.push(t)
  const view = await t.view()
  await view.request("subscribe", { topics: ["onboarding"] })
  // Signed in already (step 1), so step 3 is where it stands.
  await view.request("onboarding.set", { profile: "candle-harness" })
  const get = async () => (await view.request("onboarding.get", { straightIn: opts.straightIn === true })).result as OnboardingView
  const set = async (params: Record<string, unknown>) => {
    const r = await view.request("onboarding.set", params)
    if (r.error) throw new Error(r.error.message)
    return r.result as OnboardingView
  }
  // A typed owner step, as the screen sends it: the pane opens, the launcher redeems and reports.
  const pane = async (argv: string[], report: Record<string, unknown>, before?: () => Promise<void>) => {
    const r = (await view.request("cli.run", { argv })).result as { kind: string; ticket: string; ticketId: string; card: Card }
    expect(r.kind).toBe("pane")
    await view.request("pane.spawned", { ticketId: r.ticketId, pid: process.pid })
    const { client } = await t.hello(r.ticket)
    const redeemed = (await client.request("pane.redeem")).result as { steps: { stage: string; argv: string[] }[] }
    await before?.()
    const reported = (await client.request("pane.report", { stage: "command", exit: 0, ...report })).result as { words: string }
    return { card: r.card, redeemed, reported }
  }
  return { t, view, get, set, pane }
}

describe("step 3, through a core", () => {
  test("a key Candle gave no wallet: setup moves on by itself once the allow finishes in the pane", async () => {
    const s = await setupCore()
    await s.set({ vaultChoice: "later" })
    await s.set({ agent: "agent-a" })
    // A real new key starts denied; the fake's script is read on every call.
    const script = join(s.t.p.stateDir, "candle", "agent-a", "fake-candle.json")
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, JSON.stringify({ embeddedWalletPermission: "denied" }))
    await s.pane(["keys", "create", "--label", "agent-a", "--tx-limit", "50", "--reset", "daily"], { captured: { prefix: "Agentaaa", agent: "agent-a", stored: true } }, async () => {
      await storeNewAgentKey(s.t.p, "agent-a", prefixedKey("Agentaaa"))
    })
    let v = await s.get()
    for (let i = 0; i < 200 && v.at !== "wallet"; i++) {
      await Bun.sleep(25)
      v = await s.get()
    }
    expect(v.at).toBe("wallet")
    const frames = s.view.frames.length
    await s.pane(["keys", "update", "Agentaaa", "--embedded-wallet", "allow"], {}, async () => {
      writeFileSync(script, JSON.stringify({ embeddedWalletPermission: "allowed" }))
    })
    // Pushed, with no view asking: the screen has nothing else to read it again.
    await until(() => s.view.frames.slice(frames).some((f) => f.includes('"topic":"onboarding"') && f.includes('"at":"limits"')))
  })

  test("setup ends on the agent it made, not before: a second agent becomes the active one at the end", async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "chrn-onb-step3-cli-"))
    const profileList = [{ name: "candle-harness", active: true, account: "WalletFake111111111111111111111111111111111", cachedAge: "1m", apiUrl: "https://api.candle.example", keyPrefix: "Ownerkey", rpcHost: null }]
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: { missing: true }, authKeyPrefix: "Ownerkey", authStatus: SIGNED, profileList }))
    const at = new Date().toISOString()
    const t = await startTestCore(
      { env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } },
      {
        before: (p) => {
          // momentum is active; a later run has made swing, and stands at its last part.
          writeFileSync(p.keyFile("swing"), prefixedKey("Swingkey"), { mode: 0o600 })
          writeFileSync(p.onboarding, JSON.stringify({ version: 1, startedAt: at, updatedAt: at, straightIn: false, passed: ["welcome", "engine", "limits", "approvals", "fund", "tour"], engine: "codex", tested: { engine: "codex", at }, vaultChoice: "later", agent: { name: "swing", askedAt: at } }), { mode: 0o600 })
        },
      },
    )
    cores.push(t)
    const view = await t.view()
    await view.request("onboarding.set", { profile: "candle-harness" })
    const active = async () => ((await view.request("core.status", {})).result as { activeAgent: string }).activeAgent
    expect(await active()).toBe("momentum")
    // Quit here and nothing has moved; the last part ends setup, and the Candle Harness is on swing.
    const before = ((await view.request("onboarding.get", {})).result as OnboardingView)
    expect(before.at).toBe("start")
    expect(await active()).toBe("momentum")
    const done = (await view.request("onboarding.set", { passed: "start" })).result as OnboardingView
    expect(done.state.finishedAt).toBeDefined()
    expect(await active()).toBe("swing")
    expect(t.core.journal.rows().filter((r) => r.type === "agent.active").at(-1)).toMatchObject({ agent: "swing", by: "setup" })
    expect(JSON.parse(readFileSync(t.p.activeState, "utf8")).agent).toBe("swing")
  })

  test("moving through setup's steps doesn't spend a Free key's limit: one read for a run of steps", async () => {
    const s = await setupCore()
    await s.set({ vaultChoice: "later" })
    await s.set({ agent: "agent-a" })
    await s.pane(["keys", "create", "--label", "agent-a", "--tx-limit", "50", "--reset", "daily"], { captured: { prefix: "Agentaaa", agent: "agent-a", stored: true } }, async () => {
      await storeNewAgentKey(s.t.p, "agent-a", prefixedKey("Agentaaa"))
    })
    await until(() => s.view.frames.some((f) => f.includes('"topic":"onboarding"') && f.includes('"kind":"embedded"')))
    const log = join(s.t.p.stateDir, "candle", "agent-a", "fake-candle-calls.jsonl")
    const statusReads = () => readFileSync(log, "utf8").trim().split("\n").filter((l) => l.includes("candle_execution_status")).length
    await s.get()
    const before = statusReads()
    for (let i = 0; i < 10; i++) await s.get()
    expect(statusReads() - before).toBe(0)
  })

  test("a new agent's key is read once as the core loads it and once after the allow, with no second read of either", async () => {
    // Candle allows a Free key 30 requests a minute, and a status read with its wallets costs 5 of them: setup's end
    // read the key three times in ten seconds, and the first paper trade after it was rate-limited.
    const s = await setupCore()
    await s.set({ vaultChoice: "later" })
    await s.set({ agent: "agent-a" })
    await s.pane(["keys", "create", "--label", "agent-a", "--tx-limit", "50", "--reset", "daily"], { captured: { prefix: "Agentaaa", agent: "agent-a", stored: true } }, async () => {
      await storeNewAgentKey(s.t.p, "agent-a", prefixedKey("Agentaaa"))
    })
    await until(() => s.view.frames.some((f) => f.includes('"topic":"onboarding"') && f.includes('"kind":"embedded"')))
    const log = join(s.t.p.stateDir, "candle", "agent-a", "fake-candle-calls.jsonl")
    const statusReads = () => readFileSync(log, "utf8").trim().split("\n").filter((l) => l.includes("candle_execution_status")).length
    expect(statusReads()).toBe(1)
    await s.pane(["keys", "update", "Agentaaa", "--embedded-wallet", "allow"], {})
    await Bun.sleep(200)
    expect(statusReads()).toBe(2)
  })

  test("no vault for now; the key with Candle's cap on the create, on the engine step 2 tested; the embedded wallet allowed; limits written; paper", async () => {
    const s = await setupCore()
    let v = await s.get()
    expect(v.at).toBe("vault")
    v = await s.set({ vaultChoice: "later" })
    expect(v.at).toBe("key")
    await s.set({ agent: "agent-a" })

    // The cap goes on the create itself, and with no vault there's no factor step.
    const made = await s.pane(["keys", "create", "--label", "agent-a", "--tx-limit", "50", "--reset", "daily"], { captured: { prefix: "Agentaaa", agent: "agent-a", stored: true } }, async () => {
      expect(await storeNewAgentKey(s.t.p, "agent-a", prefixedKey("Agentaaa"))).toEqual({ ok: true, prefix: "Agentaaa" })
    })
    expect(made.card).toMatchObject({ kind: "owner", agent: "" })
    expect(made.redeemed.steps.map((x) => x.stage)).toEqual(["command"])
    expect(made.redeemed.steps[0]!.argv).toEqual(["keys", "create", "--label", "agent-a", "--tx-limit", "50", "--reset", "daily", "--access", "write", "--json"])
    expect(made.reported.words).toBe("made agent-a (key Agentaaa…): it's in the Agents list now.")
    // It runs on what step 2 tested, recorded as onboarding's choice.
    await until(() => s.t.core.journal.rows().some((r) => r.type === "engine.chosen" && r.by === "onboarding"))
    expect(s.t.core.journal.rows().find((r) => r.type === "engine.chosen")).toMatchObject({ agent: "agent-a", engine: "codex", model: "gpt-5.5", by: "onboarding" })

    // Once Candle answers for the new key, the core reads setup again and publishes it.
    await until(() => s.view.frames.some((f) => f.includes('"topic":"onboarding"') && f.includes('"kind":"embedded"')))
    // The fake's key is allowed the embedded wallet already, so the wallet part reads done; the allow is still the
    // person's owner step in the pane, with the key's prefix in the CLI's own words.
    v = await s.get()
    expect(v.facts.key).toEqual({ state: "stored", prefix: "Agentaaa" })
    expect(v.facts.wallet).toMatchObject({ state: "payable", kind: "embedded", address: "WalletFake111111111111111111111111111111111" })
    expect(v.at).toBe("limits")
    const allow = await s.pane(["keys", "update", "Agentaaa", "--embedded-wallet", "allow"], {})
    expect(allow.card).toMatchObject({ kind: "owner" })
    expect(allow.redeemed.steps.map((x) => x.argv)).toEqual([["keys", "update", "Agentaaa", "--embedded-wallet", "allow"]])

    // The Candle Harness's two limits: two lines of the agent's own table changed, used at once.
    const before = readFileSync(s.t.p.configFile, "utf8")
    const refused = await s.view.request("onboarding.limits", { perTradeUsd: 60, perDayUsd: 50 })
    expect(refused.error?.data?.code).toBe("LIMITS_NOT_RECORDED")
    expect(refused.error?.message).toBe("The limit a trade can't be over the limit a day. Nothing changed.")
    v = (await s.view.request("onboarding.limits", { perTradeUsd: 5, perDayUsd: 25 })).result as OnboardingView
    expect(v.at).toBe("approvals")
    const after = readFileSync(s.t.p.configFile, "utf8")
    expect(parseConfig(after, s.t.p.configFile).config.agents["agent-a"]!.limits).toEqual({ perTradeUsd: 5, perDayUsd: 25 })
    expect(after.replace("perTradeUsd = 5", "perTradeUsd = 10").replace("perDayUsd = 25", "perDayUsd = 50")).toBe(before)
    const status = (await s.view.request("core.status", {})).result as { agents: { name: string; limits: unknown }[] }
    expect(status.agents.find((a) => a.name === "agent-a")!.limits).toEqual({ perTradeUsd: 5, perDayUsd: 25 })

    // Approvals on "ask every time", then fund it later: the fund part gone past unfunded, and setup ends live.
    await s.set({ passed: "approvals" })
    expect(((await s.view.request("core.status", {})).result as { mode: string }).mode).toBe("paper")
    v = (await s.view.request("onboarding.fundLater", {})).result as OnboardingView
    expect(v.at).toBe("tour")
    expect(v.state.finishedAt).toBeUndefined()
    expect(((await s.view.request("core.status", {})).result as { mode: string }).mode).toBe("live")
    const words = s.t.core.journal.rows().filter((r) => r.type === "onboarding.limits" || (r.type === "onboarding.changed" && r.later === true) || r.type === "mode.changed")
    expect(words.map((r) => r.type)).toEqual(["onboarding.limits", "onboarding.changed", "mode.changed"])

    // Quit here: config.toml has its agent, and the unfinished run still opens onboarding (where it picks up at the tour).
    expect(viewOpening(s.t.p).onboarding).toEqual({ straightIn: false, asked: false })
    for (const step of ["tour", "start"]) await s.set({ passed: step })
    v = await s.get()
    expect(v.at).toBe("done")
    expect(v.state.finishedAt).toBeDefined()
    expect(viewOpening(s.t.p).onboarding).toBeUndefined()
    expect(s.t.core.journal.rows().filter((r) => r.type === "onboarding.changed" && r.change === "finished")).toHaveLength(1)
  }, 30_000)

  test("Straight in: the key, then the Candle Harness live with no vault; the run is finished once the key is stored", async () => {
    const s = await setupCore({ straightIn: true, mode: "paper" })
    let v = await s.get()
    expect(v.at).toBe("key")
    expect(((await s.view.request("core.status", {})).result as { mode: string }).mode).toBe("paper")
    await s.set({ agent: "agent-a" })
    await s.pane(["keys", "create", "--label", "agent-a"], { captured: { prefix: "Agentaaa", agent: "agent-a", stored: true } }, async () => {
      expect(await storeNewAgentKey(s.t.p, "agent-a", prefixedKey("Agentaaa"))).toEqual({ ok: true, prefix: "Agentaaa" })
    })
    await until(() => s.t.core.journal.rows().some((r) => r.type === "mode.changed" && r.by === "onboarding"))
    expect(((await s.view.request("core.status", {})).result as { mode: string }).mode).toBe("live")
    v = await s.get()
    expect(v.at).toBe("done")
    expect(v.state.finishedAt).toBeDefined()
    expect(viewOpening(s.t.p).onboarding).toBeUndefined()
  }, 30_000)

  test("funded, going on past the fund part ends setup live too; a core already live stays as it is", async () => {
    const s = await setupCore({ mode: "paper" })
    await s.set({ passed: "fund" })
    expect(((await s.view.request("core.status", {})).result as { mode: string }).mode).toBe("live")
    expect(s.t.core.journal.rows().filter((r) => r.type === "mode.changed").map((r) => r.mode)).toEqual(["live"])
    await s.set({ passed: "fund" })
    expect(s.t.core.journal.rows().filter((r) => r.type === "mode.changed")).toHaveLength(1)
  }, 30_000)

  test("limits and funding later are the person's, from the main view, and only for the agent onboarding made", async () => {
    for (const m of ["onboarding.limits", "onboarding.fundLater"]) expect(METHOD_ROLES[m]).toEqual({ view: "yes", harness: "no" })
    const s = await setupCore()
    expect((await s.view.request("onboarding.limits", { perTradeUsd: 5, perDayUsd: 25 })).error?.data?.code).toBe("NO_AGENT_YET")
  }, 30_000)
})

describe("the Candle Harness's limits in config.toml", () => {
  test("two lines of the agent's own table, nothing else; a table that isn't there, or figures that don't hold, write nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "chrn-onb-limits-"))
    const p = { configFile: join(home, "config.toml") } as Parameters<typeof recordAgentLimits>[0]
    const text = `mode = "paper"\n\n[agents.agent-a]\n# a note\n[agents.agent-a.limits]\nperTradeUsd = 10\nperDayUsd = 50 # mine\n\n[agents.agent-b]\n[agents.agent-b.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`
    writeFileSync(p.configFile, text)
    expect(await recordAgentLimits(p, "agent-a", { perTradeUsd: 2.5, perDayUsd: 20 })).toEqual({ ok: true, wrote: true })
    expect(readFileSync(p.configFile, "utf8")).toBe(text.replace("perTradeUsd = 10\nperDayUsd = 50 # mine", "perTradeUsd = 2.5\nperDayUsd = 20"))
    expect(await recordAgentLimits(p, "agent-a", { perTradeUsd: 2.5, perDayUsd: 20 })).toEqual({ ok: true, wrote: false })
    expect(await recordAgentLimits(p, "agent-c", { perTradeUsd: 1, perDayUsd: 2 })).toEqual({ ok: false, why: "config.toml has no [agents.agent-c.limits] table" })
    expect((await recordAgentLimits(p, "agent-a", { perTradeUsd: 0.001, perDayUsd: 2 })).ok).toBe(false)
    expect(readFileSync(p.configFile, "utf8")).toContain("[agents.agent-b.limits]\nperTradeUsd = 10\nperDayUsd = 50")
  })

  test("the name offered: agent-a, then the next free one", () => {
    expect(freeAgentName(new Set())).toBe("agent-a")
    expect(freeAgentName(new Set(["agent-a", "agent-b"]))).toBe("agent-c")
  })
})
