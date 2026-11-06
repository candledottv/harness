// Onboarding's first steps through a core with no agents: the Candle sign-in recorded as the profile every run
// acts as, a harness's own sign-in from the fixed list, and the test message, the doctor's one-word turn.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine } from "../../test/core-fixture"
import { fakeCodex } from "../../test/fake-codex"
import { setupProfile } from "../setup/candle-profile"
import type { OnboardingView } from "../setup/onboarding"
import { METHOD_ROLES } from "./server"

const cores: TestCore[] = []
afterAll(() => cleanupHomes())
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})

const PROFILE_ROW = (name: string, active: boolean) => ({ name, active, account: "WalletFake111111111111111111111111111111111", cachedAge: "1m", apiUrl: "https://api.candle.example", keyPrefix: "FakeKey3", rpcHost: null })

async function setupCore(script: Record<string, unknown>, extra: { engine?: Record<string, unknown>; config?: string } = {}) {
  const cliDir = mkdtempSync(join(tmpdir(), "chrn-onb-steps-cli-"))
  writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ vault: { missing: true }, ...script }))
  const t = await startTestCore(
    { env: { ...process.env, CANDLE_CONFIG_DIR: cliDir }, testTurnMs: 20_000 },
    {
      config: { agents: {}, activeAgent: "", ...(extra.engine ? { engine: { ...testEngine, ...extra.engine } } : {}) },
      before: (p) => {
        rmSync(p.keyFile("momentum"))
        rmSync(p.keyFile("swing"))
        rmSync(p.configFile)
        if (extra.config !== undefined) writeFileSync(p.configFile, extra.config)
      },
    },
  )
  cores.push(t)
  const view = await t.view()
  const runs = () => (existsSync(join(cliDir, "fake-cli-runs.jsonl")) ? readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }) : [])
  const signIn = (profile: string) => writeFileSync(join(cliDir, "fake-cli-signed.json"), JSON.stringify([profile]))
  const get = async () => (await view.request("onboarding.get", {})).result as OnboardingView
  return { t, view, cliDir, runs, signIn, get }
}

describe("step 1, sign in to Candle", () => {
  test("a new profile signs in by Candle's own device code in the pane, named so it can't collide, and is recorded once Candle shows it signed in", async () => {
    const s = await setupCore({ profileList: [PROFILE_ROW("candle-harness", false), PROFILE_ROW("desk", false)], authStatus: { exit: 1, body: { ok: false, code: "PROFILE_UNRESOLVED", message: "Several profiles and none selected." } } })
    let v = await s.get()
    expect(v.facts.signIn).toEqual({ state: "signed-out", code: "PROFILE_UNRESOLVED" })
    expect(v.facts.profiles?.map((r) => [r.name, r.active])).toEqual([
      ["candle-harness", false],
      ["desk", false],
    ])
    const r = (await s.view.request("onboarding.signIn", {})).result as { profile: string; opened: { ticket: string; ticketId: string; card: { kind: string; agent: string } } }
    expect(r.profile).toBe("candle-harness-2")
    expect(r.opened.card).toMatchObject({ kind: "ceremony", agent: "" })
    await s.view.request("pane.spawned", { ticketId: r.opened.ticketId, pid: process.pid })
    const { client: pane } = await s.t.hello(r.opened.ticket)
    const redeemed = (await pane.request("pane.redeem")).result as { steps: { argv: string[] }[]; profile?: string }
    // The core's own words: the agent can never pass --profile or --api-url.
    expect(redeemed.steps.map((x) => x.argv)).toEqual([["auth", "login", "--profile", "candle-harness-2", "--api-url", "https://api.alpha.candle.tv"]])
    expect(redeemed.profile).toBeUndefined()
    // Approved in the browser (the fake signs the profile in), then the pane ends.
    s.signIn("candle-harness-2")
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0 })).result as { words: string }
    expect(reported.words).toBe("signed in to Candle as Wall…9999: the Candle Harness acts as the profile candle-harness-2 from now on.")
    expect(readFileSync(s.t.p.configFile, "utf8")).toContain('profile = "candle-harness-2"')
    v = await s.get()
    expect(v.facts.profile).toBe("candle-harness-2")
    expect(v.steps.find((x) => x.id === "signIn")!.state).toBe("done")
    // From now on every run acts as it, and the profile list isn't read again.
    expect(s.runs().at(-1)!.env.CANDLE_PROFILE).toBe("candle-harness-2")
    expect(s.t.core.journal.rows().find((x) => x.type === "onboarding.profile")).toMatchObject({ profile: "candle-harness-2", wrote: true })
  }, 30_000)

  test("0.2's candle-tui profile, with no candle-harness one on the machine, is signed in again rather than a second profile made", async () => {
    expect(setupProfile(["candle-tui", "desk"])).toMatchObject({ profile: "candle-tui", reused: true })
    expect(setupProfile(["candle-tui", "candle-harness"])).toEqual({ profile: "candle-harness-2", reused: false })
    expect(setupProfile(["candle-tui", "candle-harness-2"])).toEqual({ profile: "candle-harness", reused: false })
    expect(setupProfile(["candle-tui-2", "desk"])).toEqual({ profile: "candle-harness", reused: false })
    expect(setupProfile([])).toEqual({ profile: "candle-harness", reused: false })
    // Its host is its own: production says nothing, anything else is said.
    expect(setupProfile([{ name: "candle-tui", apiUrl: "https://api.alpha.candle.tv/" }])).toEqual({ profile: "candle-tui", reused: true })
    const staging = setupProfile([{ name: "candle-tui", apiUrl: "https://staging.api.candle.tv" }])
    expect(staging).toMatchObject({ profile: "candle-tui", reused: true })
    expect(staging.warning).toContain("names https://staging.api.candle.tv, not Candle's production API (https://api.alpha.candle.tv)")
    expect(setupProfile([{ name: "candle-tui" }]).warning).toContain("names no host Candle's CLI shows")
    const s = await setupCore({ profileList: [PROFILE_ROW("candle-tui", false), PROFILE_ROW("desk", false)], authStatus: { exit: 1, body: { ok: false, code: "PROFILE_UNRESOLVED", message: "Several profiles and none selected." } } })
    const r = (await s.view.request("onboarding.signIn", {})).result as { profile: string; warning?: string; opened: { ticket: string; ticketId: string } }
    expect(r.profile).toBe("candle-tui")
    // This fake's profile names a host other than production: said with the result, and journalled.
    expect(r.warning).toContain("names https://api.candle.example, not Candle's production API")
    expect(s.t.core.journal.rows().find((x) => x.type === "onboarding.profile_host")).toMatchObject({ profile: "candle-tui" })
    await s.view.request("pane.spawned", { ticketId: r.opened.ticketId, pid: process.pid })
    const { client: pane } = await s.t.hello(r.opened.ticket)
    const redeemed = (await pane.request("pane.redeem")).result as { steps: { argv: string[] }[] }
    // Its host is already the profile's own: no --api-url.
    expect(redeemed.steps.map((x) => x.argv)).toEqual([["auth", "login", "--profile", "candle-tui"]])
    s.signIn("candle-tui")
    await pane.request("pane.report", { stage: "command", exit: 0 })
    expect(readFileSync(s.t.p.configFile, "utf8")).toContain('profile = "candle-tui"')
  }, 30_000)

  test("on a CLI older than the Candle Harness needs, the sign-in still opens its pane", async () => {
    const s = await setupCore({ version: "0.13.5", profileList: [], authStatus: { exit: 1, body: { ok: false, code: "NOT_SIGNED_IN" } } })
    const r = await s.view.request("onboarding.signIn", {})
    expect(r.error).toBeUndefined()
    expect((r.result as { opened: { card: { kind: string } } }).opened.card.kind).toBe("ceremony")
  })

  test("a sign-in Candle doesn't show records nothing, and says so", async () => {
    const s = await setupCore({ profileList: [], authStatus: { exit: 1, body: { ok: false, code: "NOT_SIGNED_IN" } } })
    const r = (await s.view.request("onboarding.signIn", {})).result as { profile: string; opened: { ticket: string; ticketId: string } }
    expect(r.profile).toBe("candle-harness")
    await s.view.request("pane.spawned", { ticketId: r.opened.ticketId, pid: process.pid })
    const { client: pane } = await s.t.hello(r.opened.ticket)
    await pane.request("pane.redeem")
    const reported = (await pane.request("pane.report", { stage: "command", exit: 1 })).result as { words: string }
    expect(reported.words).toContain("Candle doesn't show candle-harness signed in, so nothing was recorded: sign in again.")
    expect(existsSync(s.t.p.configFile)).toBe(false)
    expect((await s.get()).facts.profile).toBeUndefined()
  }, 30_000)

  test("use this account: a profile on the machine is recorded under an existing [candle] table, one naming another is the person's, and an unknown one is refused", async () => {
    const config = 'mode = "paper"\n\n[candle]\ncliPath = "candle"\n'
    const s = await setupCore({ profileList: [PROFILE_ROW("production", true)], authStatus: { exit: 0, body: { profile: "production", account: "WalletFake111111111111111111111111111111111", rows: [{ check: "Device token", state: "PASS" }] } } }, { config })
    // The CLI's path is a test's own; it's the line added that counts.
    const unknown = await s.view.request("onboarding.set", { profile: "elsewhere" })
    expect(unknown.error?.data?.code).toBe("NO_SUCH_PROFILE")
    const v = (await s.view.request("onboarding.set", { profile: "production" })).result as OnboardingView
    expect(v.steps.find((x) => x.id === "signIn")!.state).toBe("done")
    const text = readFileSync(s.t.p.configFile, "utf8")
    expect(text.startsWith('mode = "paper"\n\n[candle]\n')).toBe(true)
    expect(text).toContain('profile = "production"\ncliPath = "candle"')
    // Recorded already: the same again is no change; another is the person's to edit.
    expect((await s.view.request("onboarding.set", { profile: "production" })).error).toBeUndefined()
    writeFileSync(join(s.cliDir, "fake-cli.json"), JSON.stringify({ vault: { missing: true }, profileList: [PROFILE_ROW("production", true), PROFILE_ROW("desk", false)] }))
    const other = await s.view.request("onboarding.set", { profile: "desk" })
    expect(other.error?.data?.code).toBe("PROFILE_NOT_RECORDED")
    expect(other.error?.message).toContain("config.toml already names the profile production")
  }, 30_000)

  test("a step gone past is answered at once from the last read, and the reads follow and are published", async () => {
    const SIGNED_IN = { exit: 0, body: { backend: "keychain", profile: "desk", deviceTokenPrefix: "FakeDvc1", account: "WalletFake111111111111111111111111111111111", rows: [{ check: "Device token", state: "PASS", detail: "valid" }] } }
    const s = await setupCore({ authStatus: SIGNED_IN })
    expect((await s.get()).at).toBe("welcome")
    // From now on the sign-in's read takes 1.5 s.
    writeFileSync(join(s.cliDir, "fake-cli.json"), JSON.stringify({ vault: { missing: true }, authStatus: SIGNED_IN, authStatusDelayMs: 1500 }))
    await s.view.request("subscribe", { topics: ["onboarding"] })
    const before = s.runs().length
    const published = s.view.events.length
    const started = Date.now()
    const v = (await s.view.request("onboarding.set", { passed: "welcome" })).result as OnboardingView
    expect(Date.now() - started).toBeLessThan(1000)
    expect(v.at).not.toBe("welcome")
    // The reads follow, and are published.
    await Bun.sleep(2500)
    expect(s.runs().slice(before).some((r) => r.argv[0] === "auth" && r.argv[1] === "status")).toBe(true)
    const pushed = s.view.events.slice(published).filter((e) => e.topic === "onboarding")
    // The quick answer, then the one the reads made.
    expect(pushed.length).toBeGreaterThanOrEqual(2)
    expect((pushed.at(-1)!.data as OnboardingView).at).toBe(v.at)
  }, 30_000)

  test("only the person, from the main view: no harness, pane or agent reaches the sign-ins or the test", () => {
    for (const m of ["onboarding.signIn", "onboarding.harness", "onboarding.test"]) expect(METHOD_ROLES[m]).toEqual({ view: "yes", harness: "no" })
  })
})

describe("step 2, connect your agent", () => {
  test("a harness's own sign-in runs its fixed command, as the person, with nothing of Candle's, and the engine is read again after", async () => {
    const codex = fakeCodex()
    const s = await setupCore({}, { engine: { codex: { path: codex.bin } } })
    expect((await s.view.request("onboarding.harness", { engine: "nope" })).error?.message).toContain("engine is one of")
    const r = (await s.view.request("onboarding.harness", { engine: "codex" })).result as { ticket: string; ticketId: string; title: string }
    expect(r.title).toBe("codex login --device-auth · your own Codex sign-in")
    await s.view.request("pane.spawned", { ticketId: r.ticketId, pid: process.pid })
    const { client: pane } = await s.t.hello(r.ticket)
    const redeemed = (await pane.request("pane.redeem")).result as Record<string, unknown>
    expect(redeemed).toEqual({ title: r.title, bin: codex.bin, steps: [{ stage: "command", argv: ["login", "--device-auth"] }], identity: "owner", harness: "codex" })
    // A second redeem is refused: one ticket, one run.
    expect((await pane.request("pane.redeem")).error?.data?.code).toBe("TICKET_SPENT")
    const reported = (await pane.request("pane.report", { stage: "command", exit: 0 })).result as { outcome: string; words: string }
    expect(reported).toEqual({ outcome: "finished", words: "Codex's sign-in finished: the Candle Harness read Codex again." })
    expect(s.t.core.journal.rows().filter((x) => x.type.startsWith("onboarding.harness")).map((x) => x.type)).toEqual(["onboarding.harness", "onboarding.harness_ended"])
  }, 30_000)

  test("the test message: the doctor's one-word turn on the engine and model picked, kept with them, so step 2 can be passed", async () => {
    const codex = fakeCodex({ fixture: "codex" })
    const s = await setupCore({}, { engine: { codex: { path: codex.bin } } })
    expect((await s.view.request("onboarding.test", {})).error?.data?.code).toBe("NO_ENGINE")
    await s.view.request("onboarding.set", { engine: "codex", model: "gpt-5.5" })
    const tested = (await s.view.request("onboarding.test", {})).result as { ok: boolean; ms: number; reply: string; view: OnboardingView }
    expect(tested.ok).toBe(true)
    expect(tested.view.state.tested).toMatchObject({ engine: "codex", model: "gpt-5.5" })
    // It ran with no Candle tools: an MCP server that's empty.
    const run = codex.runs().find((x) => x.argv.includes("exec"))!
    expect(JSON.stringify(run.argv)).toContain("--empty")
    expect((await s.view.request("onboarding.set", { passed: "engine" })).error).toBeUndefined()
    expect(s.t.core.journal.rows().find((x) => x.type === "onboarding.tested")).toMatchObject({ engine: "codex", model: "gpt-5.5", ok: true })
  }, 30_000)

  test("a test message that fails says why in the engine's words, and step 2 stays", async () => {
    const codex = fakeCodex({ fixture: "codex-signedout" })
    const s = await setupCore({}, { engine: { codex: { path: codex.bin } } })
    await s.view.request("onboarding.set", { engine: "codex" })
    const tested = (await s.view.request("onboarding.test", {})).result as { ok: boolean; words: string }
    expect(tested.ok).toBe(false)
    expect(tested.words).toStartWith("Codex didn't answer:")
    expect(JSON.stringify((await s.view.request("onboarding.set", { passed: "engine" })).error)).toContain("NOT_TESTED")
  }, 30_000)
})
