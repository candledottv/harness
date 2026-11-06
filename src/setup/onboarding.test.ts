// Onboarding's state: each step read back from where it
// lives, so a resume runs nothing twice; a key made but not stored offered for revoking; and onboarding
// reading none of the credentials a machine already holds.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, fakeCandle, prefixedKey, testConfig } from "../../test/core-fixture"
import { connectTestClient, type TestClient } from "../../test/core-test-client"
import { parseConfig } from "../config"
import { startCore, type RunningCore } from "../core/core-main"
import { readViewToken } from "../core/tokens"
import { paths, type Paths } from "../paths"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { storeNewAgentKey } from "./key-add"
import { applyChange, withTested, changeFrom, freshState, keyFrom, type OnboardingView, onboardingProgress, parseState, signInFrom, stepBack } from "./onboarding"

afterAll(() => cleanupHomes())

const recorded = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../../test/fixtures/candle-recorded/cli-0.13.5", `${name}.json`), "utf8")) as { exit: number; stdout: unknown }
const NOW = Date.parse("2026-11-01T12:00:00.000Z")
const facts = (over: Partial<Parameters<typeof onboardingProgress>[1]> = {}) => ({ signIn: { state: "signed-out" as const }, vault: "missing" as const, key: { state: "none" as const }, wallet: { state: "unknown" as const }, ...over })

describe("each step, read back", () => {
  test("the sign-in, from a recorded auth status: signed in once the device token passes, and only the account and the profile it answered as kept", () => {
    const ok = recorded("clicmd-auth-status")
    expect(signInFrom({ exitCode: ok.exit, json: ok.stdout })).toEqual({ state: "signed-in", account: "WalletFake111111111111111111111111111111111", profile: "production" })
    const unknown = recorded("clicmd-auth-status-unknown-profile")
    // The refusal lists the machine's other profiles: none of it is kept but the code.
    expect(signInFrom({ exitCode: unknown.exit, json: unknown.stdout })).toEqual({ state: "signed-out", code: "PROFILE_UNRESOLVED" })
    const failing = { ...(ok.stdout as object), rows: [{ check: "Device token", state: "FAIL", detail: "expired" }] }
    expect(signInFrom({ exitCode: 0, json: failing })).toEqual({ state: "signed-out" })
    // The CLI's own API key failing makes auth status exit 1; the device token still signs it in.
    const keyFailing = { ...(ok.stdout as object), rows: [{ check: "Device token", state: "PASS" }, { check: "API key", state: "FAIL", detail: "revoked" }] }
    expect(signInFrom({ exitCode: 1, json: keyFailing })).toMatchObject({ state: "signed-in" })
    expect(signInFrom({ exitCode: 1, json: { ...keyFailing, rows: [{ check: "Device token", state: "FAIL" }] } })).toEqual({ state: "signed-out" })
    expect(signInFrom(undefined)).toEqual({ state: "unreadable" })
    // Linux with no keychain: the CLI's own words come through, for setup to say.
    expect(signInFrom({ exitCode: 1, json: undefined, stderr: "Unexpected error: No keychain available and no CANDLE_KEYRING_PASSPHRASE set; set it to use the encrypted file store on this machine\n" })).toEqual({
      state: "unreadable",
      said: "No keychain available and no CANDLE_KEYRING_PASSPHRASE set; set it to use the encrypted file store on this machine",
    })
    expect(signInFrom({ exitCode: 1, json: undefined, stderr: `\x1b[31mbad key cndl_live_${"q".repeat(30)}\x1b[0m` })).toEqual({ state: "unreadable", said: "bad key cndl_…" })
  })

  test("the key: stored by its file; else a key labelled as the agent, made since it was asked for and held by no agent, is made but not stored", () => {
    const agent = { name: "agent-a", askedAt: new Date(NOW).toISOString() }
    const list = (keys: unknown[]) => ({ exitCode: 0, json: { success: true, keys } })
    expect(keyFrom({ agent, storedPrefix: "Agentaaa", heldPrefixes: new Set(), keysList: undefined })).toEqual({ state: "stored", prefix: "Agentaaa" })
    expect(keyFrom({ agent, heldPrefixes: new Set(), keysList: list([{ keyPrefix: "Agentaaa", label: "agent-a", createdAt: NOW + 5_000, revokedAt: null }]) })).toEqual({ state: "made-not-stored", prefixes: ["Agentaaa"] })
    // Candle's prefixes are base64url: one made and not stored is found, one held isn't.
    expect(keyFrom({ agent, heldPrefixes: new Set(), keysList: list([{ keyPrefix: "abCD-e_f", label: "agent-a", createdAt: NOW + 5_000, revokedAt: null }]) })).toEqual({ state: "made-not-stored", prefixes: ["abCD-e_f"] })
    expect(keyFrom({ agent, heldPrefixes: new Set(["abCD-e_f"]), keysList: list([{ keyPrefix: "abCD-e_f", label: "agent-a", createdAt: NOW + 5_000, revokedAt: null }]) })).toEqual({ state: "none" })
    // An older key of the same label, a revoked one, another label, one an agent here holds: none of them.
    const others = [
      { keyPrefix: "Oldkey11", label: "agent-a", createdAt: NOW - 3_600_000 },
      { keyPrefix: "Revoked1", label: "agent-a", createdAt: NOW + 1, revokedAt: NOW + 2 },
      { keyPrefix: "Otherlbl", label: "agent-b", createdAt: NOW + 1 },
      { keyPrefix: "Heldkey1", label: "agent-a", createdAt: NOW + 1 },
    ]
    expect(keyFrom({ agent, heldPrefixes: new Set(["Heldkey1"]), keysList: list(others) })).toEqual({ state: "none" })
    expect(keyFrom({ agent, heldPrefixes: new Set(), keysList: { exitCode: 1, json: undefined } })).toEqual({ state: "unreadable" })
    expect(keyFrom({ heldPrefixes: new Set(), keysList: undefined })).toEqual({ state: "none" })
  })

  const IN = { signIn: { state: "signed-in" as const, profile: "candle-harness" }, profile: "candle-harness" }

  test("progress: a step done is done whatever the file says, straight in skips what it doesn't need, and the first to do is where it stands", () => {
    let state = freshState(NOW)
    expect(onboardingProgress(state, facts()).at).toBe("welcome")
    state = applyChange(state, { passed: "welcome" }, NOW)
    expect(onboardingProgress(state, facts()).at).toBe("signIn")
    expect(onboardingProgress(state, facts({ ...IN })).at).toBe("engine")
    // Signed in, but as the CLI's own pick: not done until the Candle Harness records the profile.
    expect(onboardingProgress(state, facts({ signIn: { state: "signed-in", profile: "production" } })).at).toBe("signIn")
    // Going past step 2 needs its test message on the engine and model chosen.
    state = applyChange(state, { engine: "codex", model: "gpt-5.5" }, NOW)
    expect(onboardingProgress(applyChange(state, { passed: "engine" }, NOW), facts({ ...IN })).at).toBe("engine")
    state = applyChange(withTested(state, "codex", "gpt-5.5", NOW), { passed: "engine" }, NOW)
    expect(onboardingProgress(applyChange(state, { engine: "codex", model: "gpt-5.5-mini" }, NOW), facts({ ...IN })).at).toBe("engine")
    const later = applyChange(state, { vaultChoice: "later" }, NOW)
    expect(onboardingProgress(later, facts({ ...IN })).steps.find((s) => s.id === "vault")!.state).toBe("skipped")
    // A vault on the machine is done, whatever was chosen.
    expect(onboardingProgress(state, facts({ ...IN, vault: "present" })).at).toBe("key")
    const notStored = onboardingProgress(later, facts({ ...IN, key: { state: "made-not-stored", prefixes: ["Agentaaa"] } }))
    expect(notStored.at).toBe("key")
    expect(notStored.steps.find((s) => s.id === "key")!.revoke).toEqual([{ prefix: "Agentaaa", line: "candle keys revoke Agentaaa" }])
    // Straight in: sign in, the model, the key; the rest skipped.
    const straight = applyChange(freshState(NOW), { straightIn: true }, NOW)
    const view = onboardingProgress(straight, facts({ ...IN, key: { state: "stored", prefix: "Agentaaa" } }))
    expect(view.steps.filter((s) => s.state !== "skipped").map((s) => s.id)).toEqual(["signIn", "engine", "key"])
    expect(view.at).toBe("engine")
  })

  test("what a view may set, and the file read whole or not at all", () => {
    expect(changeFrom({ passed: "signIn" })).toEqual({ problem: "signIn is done when it's read back, not when it's passed." })
    expect(changeFrom({ passed: "key" })).toMatchObject({ problem: expect.any(String) })
    expect(changeFrom({ engine: "nope" })).toMatchObject({ problem: expect.any(String) })
    expect(changeFrom({ agent: "Bad Name" })).toMatchObject({ problem: expect.any(String) })
    expect(changeFrom({ agent: "agent-a", passed: "welcome" })).toMatchObject({ problem: expect.any(String) })
    expect(changeFrom({ vaultChoice: "later" })).toEqual({ vaultChoice: "later" })
    // A name asked for again keeps its first time.
    const first = applyChange(freshState(NOW), { agent: "agent-a" }, NOW)
    expect(applyChange(first, { agent: "agent-a" }, NOW + 60_000).agent).toEqual({ name: "agent-a", askedAt: new Date(NOW).toISOString() })
    expect(parseState("not json")).toBeUndefined()
    expect(parseState(JSON.stringify({ version: 2 }))).toBeUndefined()
    const junk = parseState(JSON.stringify({ ...freshState(NOW), passed: ["welcome", "key", "nope"], engine: "nope", agent: { name: "../x", askedAt: "y" }, key: "cndl_live_x" }))
    expect(junk).toEqual({ ...freshState(NOW), passed: ["welcome"] })
  })
})

describe("Esc goes back a step (a stray click needs a way back)", () => {
  const signedIn = facts({ signIn: { state: "signed-in", profile: "candle-harness" }, profile: "candle-harness" })
  const tested = withTested(applyChange(applyChange(freshState(NOW), { passed: "welcome" }, NOW), { engine: "claude-code" }, NOW), "claude-code", undefined, NOW)

  test("a step that was a choice is shown again; the choice made in it is kept", () => {
    const atVault = onboardingProgress(applyChange(tested, { passed: "engine" }, NOW), signedIn)
    expect(atVault.at).toBe("vault")
    const back = stepBack(atVault, NOW)
    expect("state" in back && onboardingProgress(back.state, signedIn).at).toBe("engine")
    expect("state" in back && back.state.engine).toBe("claude-code")
    // "The embedded wallet only, for now" is taken back too.
    const later = onboardingProgress(applyChange(applyChange(tested, { passed: "engine" }, NOW), { vaultChoice: "later" }, NOW), signedIn)
    expect(later.at).toBe("key")
    const again = stepBack(later, NOW)
    expect("state" in again && onboardingProgress(again.state, signedIn).at).toBe("vault")
  })

  test("past a step done on Candle it's said, and nothing changes", () => {
    const atEngine = onboardingProgress(tested, signedIn)
    expect(atEngine.at).toBe("engine")
    expect(stepBack(atEngine, NOW)).toEqual({ problem: "Signing in to Candle is done, and going back doesn't undo it. Carry on from here." })
    const stored = facts({ ...signedIn, key: { state: "stored", prefix: "Agentaaa" } })
    const atWallet = onboardingProgress(applyChange(applyChange(tested, { passed: "engine" }, NOW), { vaultChoice: "later" }, NOW), stored)
    expect(atWallet.at).toBe("wallet")
    expect(stepBack(atWallet, NOW)).toEqual({ problem: "The agent's key is done, and going back doesn't undo it. Carry on from here." })
    expect(stepBack(onboardingProgress(freshState(NOW), facts()), NOW)).toEqual({ problem: "This is the first step." })
    expect(changeFrom({ back: true })).toEqual({ back: true })
  })
})

describe("through a core, stopped and started again at each step", () => {
  const running: { core: RunningCore; clients: TestClient[] }[] = []
  afterEach(async () => {
    for (const r of running.splice(0)) {
      for (const c of r.clients) c.close()
      await r.core.stop("test")
    }
  })

  /** A machine with planted credentials of every kind onboarding must never read. */
  function plantedMachine(): { home: string; harness: string; cliDir: string; canaries: string[] } {
    const home = mkdtempSync(join(tmpdir(), "chrn-onb-home-"))
    const canaries = ["CANARY-cli-profile", "CANARY-keychain", "CANARY-claude", "CANARY-codex", "CANARY-grok", "CANARY-opencode", "CANARY-pi", "CANARY-env"]
    const plant = (path: string, text: string) => {
      mkdirSync(join(home, path, ".."), { recursive: true })
      writeFileSync(join(home, path), text, { mode: 0o600 })
    }
    plant(".config/candle/config.json", JSON.stringify({ profiles: { production: { apiKey: canaries[0] } }, activeProfile: "production" }))
    plant("Library/Keychains/login.keychain-db", canaries[1]!)
    plant(".claude/.credentials.json", JSON.stringify({ token: canaries[2] }))
    plant(".codex/auth.json", JSON.stringify({ token: canaries[3] }))
    plant(".grok/auth.json", JSON.stringify({ token: canaries[4] }))
    plant(".local/share/opencode/auth.json", JSON.stringify({ token: canaries[5] }))
    plant(".pi/agent/auth.json", JSON.stringify({ token: canaries[6] }))
    plant(".env", `CANDLE_API_KEY=${canaries[7]}\n`)
    const harness = join(home, "harness")
    mkdirSync(harness)
    const cliDir = mkdtempSync(join(tmpdir(), "chrn-onb-cli-"))
    return { home, harness, cliDir, canaries }
  }

  const script = (cliDir: string, s: Record<string, unknown>) => writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify(s))
  const runsEnv = (cliDir: string) => (existsSync(join(cliDir, "fake-cli-runs.jsonl")) ? readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { env: Record<string, string> }).env) : [])
  const runs = (cliDir: string) => (existsSync(join(cliDir, "fake-cli-runs.jsonl")) ? readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv) : [])

  async function boot(m: { home: string; harness: string; cliDir: string }, clock: { now: number }) {
    const p: Paths = paths({ CANDLE_HARNESS_HOME: m.harness })
    const candle = await fakeCandle()
    const onDisk = existsSync(p.configFile) ? parseConfig(readFileSync(p.configFile, "utf8"), p.configFile, { setup: true }).config : undefined
    const base = testConfig(candle, { agents: onDisk?.agents ?? {}, activeAgent: onDisk?.activeAgent ?? "" })
    // The profile onboarding recorded, as a restarted core reads it from config.toml.
    const config = { ...base, candle: { ...base.candle, profile: onDisk?.candle.profile } }
    const core = await startCore({ paths: p, config, env: { ...process.env, HOME: m.home, CANDLE_CONFIG_DIR: m.cliDir }, headless: true, now: () => clock.now })
    await core.candleReady
    const view = await connectTestClient(p.socket)
    const hello = await view.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "test" })
    if (hello.error) throw new Error(JSON.stringify(hello.error))
    running.push({ core, clients: [view] })
    const get = async () => (await view.request("onboarding.get", {})).result as OnboardingView
    const set = async (params: Record<string, unknown>) => {
      const r = await view.request("onboarding.set", params)
      if (r.error) throw new Error(JSON.stringify(r.error))
      return r.result as OnboardingView
    }
    return { p, core, view, get, set }
  }
  async function stop() {
    const r = running.pop()!
    for (const c of r.clients) c.close()
    await r.core.stop("killed for the test")
  }

  test("each step survives a restart, done steps are never run again, and a key made but not stored before the kill is offered for revoking", async () => {
    const m = plantedMachine()
    const clock = { now: NOW }
    script(m.cliDir, { vault: { missing: true }, authStatus: { exit: 1, body: { ok: false, code: "NOT_SIGNED_IN", message: "Not signed in." } } })

    // Step 0, then stopped.
    let c = await boot(m, clock)
    expect((await c.get()).at).toBe("welcome")
    await c.set({ passed: "welcome" })
    expect(statSync(c.p.onboarding).mode & 0o777).toBe(0o600)
    await stop()

    // Step 1: signed in outside the core. Read back, not taken from the file, and not done until the person
    // picks the account: then it's recorded in config.toml, and a restart reads it from there.
    const profileList = [{ name: "production", active: true, account: "WalletFake111111111111111111111111111111111", cachedAge: "1m", apiUrl: "https://api.candle.example", keyPrefix: "FakeKey3", rpcHost: null }]
    script(m.cliDir, { vault: { missing: true }, profileList, authStatus: { exit: 0, body: recorded("clicmd-auth-status").stdout } })
    c = await boot(m, clock)
    let v = await c.get()
    expect(v.at).toBe("signIn")
    expect(v.facts.signIn).toMatchObject({ state: "signed-in", profile: "production" })
    // What the person picks from: names, accounts and hosts, never a key.
    expect(v.facts.profiles).toEqual([{ name: "production", active: true, account: "WalletFake111111111111111111111111111111111", apiUrl: "https://api.candle.example" }])
    v = await c.set({ profile: "production" })
    expect(v.steps.slice(0, 2).map((s) => s.state)).toEqual(["done", "done"])
    expect(readFileSync(c.p.configFile, "utf8")).toContain('profile = "production"')
    await stop()
    c = await boot(m, clock)
    v = await c.get()
    expect(v.facts.profile).toBe("production")
    expect(v.at).toBe("engine")
    // Every run acts as the recorded profile.
    expect(runsEnv(m.cliDir).at(-1)?.CANDLE_PROFILE).toBe("production")
    await c.set({ engine: "pi", model: "deepseek-v4.1-flash" })
    // Not past step 2 before its test message answered.
    expect(JSON.stringify((await c.view.request("onboarding.set", { passed: "engine" })).error)).toContain("NOT_TESTED")
    // The test message answered (onboarding.test's own run is in onboarding-screens.test.ts): kept in the file.
    await stop()
    const held = JSON.parse(readFileSync(c.p.onboarding, "utf8"))
    writeFileSync(c.p.onboarding, JSON.stringify({ ...held, tested: { engine: "pi", model: "deepseek-v4.1-flash", at: new Date(NOW).toISOString() } }), { mode: 0o600 })
    c = await boot(m, clock)
    await c.set({ passed: "engine" })
    await c.set({ vaultChoice: "later" })
    await c.set({ agent: "agent-a" })
    await stop()

    // Step 3's key: made by the CLI, then the Candle Harness killed before it stored it.
    clock.now = NOW + 30_000
    script(m.cliDir, {
      vault: { missing: true },
      authStatus: { exit: 0, body: recorded("clicmd-auth-status").stdout },
      keysList: { success: true, keys: [{ keyPrefix: "Agentaaa", label: "agent-a", createdAt: NOW + 20_000, revokedAt: null }] },
    })
    c = await boot(m, clock)
    v = await c.get()
    expect(v.state).toMatchObject({ engine: "pi", model: "deepseek-v4.1-flash", vaultChoice: "later", agent: { name: "agent-a" } })
    expect(v.at).toBe("key")
    expect(v.steps.find((s) => s.id === "key")).toEqual({ id: "key", state: "todo", revoke: [{ prefix: "Agentaaa", line: "candle keys revoke Agentaaa" }] })
    // Offered, never run: no revoke and no second create went to the CLI.
    expect(runs(m.cliDir).filter((a) => a[0] === "keys" && a[1] !== "list")).toEqual([])
    await stop()

    // The key stored (key add's path), then started again: the agent is configured, the key read from its file, the wallet from Candle.
    expect(await storeNewAgentKey(paths({ CANDLE_HARNESS_HOME: m.harness }), "agent-a", prefixedKey("Agentaaa"))).toEqual({ ok: true, prefix: "Agentaaa" })
    c = await boot(m, clock)
    v = await c.get()
    expect(v.facts.key).toEqual({ state: "stored", prefix: "Agentaaa" })
    expect(v.facts.wallet).toEqual({ state: "payable", count: 1, address: "WalletFake111111111111111111111111111111111", kind: "embedded", name: "embedded" })
    expect(v.at).toBe("limits")
    for (const step of ["limits", "approvals", "fund", "tour", "start"]) await c.set({ passed: step })
    expect((await c.get()).at).toBe("done")
    // `candle-harness setup` after a finished run starts a new one, for another agent; while one is unfinished it's kept.
    const again = (await c.view.request("onboarding.get", { again: true, straightIn: true })).result as OnboardingView
    expect(again.state).toMatchObject({ straightIn: true, passed: [] })
    expect(again.state.agent).toBeUndefined()
    expect(((await c.view.request("onboarding.get", { again: true })).result as OnboardingView).state.straightIn).toBe(true)

    // No planted credential anywhere the core keeps or says, and the CLI asked only these.
    const kept = [readFileSync(c.p.onboarding, "utf8"), readFileSync(c.p.journal, "utf8"), ...c.view.frames]
    for (const canary of m.canaries) for (const text of kept) expect(text).not.toContain(canary)
    const asked = new Set(runs(m.cliDir).map((a) => a.filter((w) => w !== "--json").slice(0, 2).join(" ")))
    expect([...asked].filter((a) => !["auth status", "vault status", "keys list", "profile list"].includes(a))).toEqual([])
  }, 60_000)

  test("onboarding's own code names no credential store: its readers are the CLI, the Candle Harness's key files and Candle's reads", () => {
    // The code, without its comments, which name what it never reads.
    const src = readFileSync(join(import.meta.dir, "onboarding.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n")
    for (const word of ["homedir", "process.env", "keychain", ".claude", ".codex", ".grok", "opencode/auth", ".pi/", "config.json", ".env"]) expect(`${word}: ${src.includes(word)}`).toBe(`${word}: false`)
    // The only file it opens is its own state file, through the store.
    expect(src.match(/readFile\(|writeFile\(/g)).toHaveLength(2)
    expect(readdirSync(import.meta.dir)).toContain("onboarding.ts")
  })
})
