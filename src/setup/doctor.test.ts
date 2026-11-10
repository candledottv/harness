// The doctor against the fake Candle (MCP server and CLI, test/fake-candle.ts) and a scripted claude.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, fakeCandle, until } from "../../test/core-fixture"
import type { FakeScript } from "../../test/fake-candle-mcp"
import { candleConfigDir } from "../core/candle-mcp"
import { paths, type Paths } from "../paths"
import { COMMIT, VERSION } from "../version"
import { fakeCodex } from "../../test/fake-codex"
import { fakeGrok } from "../../test/fake-grok"
import { fakeOpenCode } from "../../test/fake-opencode"
import { fakePi } from "../../test/fake-pi"
import { aliasesChecks, budgetWords, type Check, layoutsChecks, nameChecks, onboardingChecks, themeChecks, doctorCommand, formatReport, outOfCredit, quickDoctor, runDoctor, signInTurnArgs, UNLOCK_KEYCHAIN, utcMidnightHere } from "./doctor"

/** Made-up keys of the real shape (a kind, then 43 characters), built so no key-shaped text sits in the source. */
const LIVE = ["cndl", "live", ""].join("_")
const fakeKey = (kind: "live" | "test", prefix: string, fill: string) => `${["cndl", kind, ""].join("_")}${prefix}${fill.repeat(35)}`
const MOMENTUM_KEY = fakeKey("live", "Momentum", "m")
const SWING_KEY = fakeKey("live", "Swingkey", "s")
const DAY = 24 * 60 * 60 * 1000

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  cleanupHomes() // the compiled fake candle
})
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(`/tmp/${prefix}`)
  dirs.push(dir)
  return dir
}

const engineFixture = (name: string) => join(import.meta.dir, "../../test/fixtures/engine", `${name}.jsonl`)

/** A fake `claude`: `--version` answers, and a turn records its arguments and stdin, then replays a fixture. */
function fakeClaude(dir: string, fixture: "claude" | "claude-signedout"): string {
  const bin = join(dir, "claude")
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.310 (Claude Code)"; exit 0; fi
printf '%s\\n' "$@" > '${dir}/claude-args.txt'
cat > '${dir}/claude-stdin.txt'
cat '${engineFixture(fixture)}'
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

/** The owner's key list, as `candle keys list --json` answers (the recorded shape, made-up values). */
function keyRow(prefix: string, extra: Record<string, unknown> = {}) {
  return { keyPrefix: prefix, label: prefix.toLowerCase(), environment: "production", embeddedWallet: "allowed", walletScope: "selected", scopes: ["launch:write", "launch:read", "activity:write", "swap:write", "account:read"], ...extra }
}

interface Setup {
  claude?: "claude" | "claude-signedout" | "missing"
  agents?: Record<string, string>
  keysList?: unknown
  keysListFail?: { stderr: string; exitCode: number }
  cliVersion?: string
  candle?: Record<string, FakeScript>
  cliPath?: string
  /** The fake CLI's TEE script (test/fake-candle-cli.ts). */
  tee?: { wallets: { id: string; address: string; label?: string; boundKeyPrefix: string; active?: boolean }[]; signers?: Record<string, string> }
  lpEnabled?: boolean
  /** Each agent's default wallet, by agent. */
  wallets?: Record<string, string>
  rpcUrl?: string
  /** The fake CLI's vault: missing, or opened by a passphrase. */
  vault?: { missing?: boolean; passphrase?: string }
  /** The other engines' binaries; one left out isn't installed. */
  engines?: Partial<Record<"codex" | "grok" | "opencode" | "pi", string>>
  /** Each agent's engine as picked with ctrl-g, saved in state. */
  choices?: Record<string, { engine: string; model?: string }>
  /** Sign-ins at their usual places under HOME. */
  signedIn?: ("codex" | "grok")[]
  /** Hacc on: off unless a test points the doctor at the fake Hacc, so none reaches the real one. */
  hacc?: boolean
  /** config.toml's candle.profile, and the CLI's config.json profiles and those signed in. */
  profile?: string
  cliProfiles?: string[]
  signedProfiles?: string[]
  /** The fake CLI's close-empty script. */
  closeEmpty?: { accounts?: Record<string, number>; off?: boolean }
}

async function setup(s: Setup = {}): Promise<{ env: Record<string, string>; p: Paths; dir: string }> {
  const dir = tempDir("chrn-dr-")
  const home = join(dir, "h")
  mkdirSync(home)
  const cliConfig = join(dir, "cli")
  mkdirSync(cliConfig)
  const env = { CANDLE_HARNESS_HOME: home, HOME: dir, PATH: "/usr/bin:/bin", CANDLE_CONFIG_DIR: cliConfig }
  const p = paths(env)
  const agents = s.agents ?? { momentum: MOMENTUM_KEY, swing: SWING_KEY }
  const claude = s.claude === "missing" ? join(dir, "no-claude") : fakeClaude(dir, s.claude ?? "claude")
  const candle = s.cliPath ?? (await fakeCandle())
  writeFileSync(
    p.configFile,
    `[candle]\ncliPath = "${candle}"\n${s.rpcUrl ? `rpcUrl = "${s.rpcUrl}"\n` : ""}${s.profile ? `profile = "${s.profile}"\n` : ""}[engine.claude]\npath = "${claude}"\n` +
      (["codex", "grok", "opencode", "pi"] as const).map((e) => `[engine.${e}]\npath = "${s.engines?.[e] ?? join(dir, `no-${e}`)}"\n`).join("") +
      `[hacc]\nenabled = ${s.hacc ? "true" : "false"}\n` +
      Object.keys(agents).map((a) => `${s.wallets?.[a] ? `[agents.${a}]\nwallet = "${s.wallets[a]}"\n` : ""}[agents.${a}.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`).join(""),
  )
  mkdirSync(p.keysDir, { recursive: true, mode: 0o700 })
  for (const [agent, key] of Object.entries(agents)) writeFileSync(p.keyFile(agent), `${key}\n`, { mode: 0o600 })
  writeFileSync(
    join(cliConfig, "fake-cli.json"),
    JSON.stringify({
      ...(s.cliVersion ? { version: s.cliVersion } : {}),
      ...(s.keysListFail ? { keysListFail: s.keysListFail } : { keysList: s.keysList ?? { success: true, keys: [keyRow("Momentum"), keyRow("Swingkey")] } }),
      ...(s.tee ? { tee: s.tee } : {}),
      ...(s.lpEnabled ? { lpEnabled: true } : {}),
      ...(s.vault ? { vault: s.vault } : {}),
      ...(s.closeEmpty ? { closeEmpty: s.closeEmpty } : {}),
    }),
  )
  if (s.cliProfiles) writeFileSync(join(cliConfig, "config.json"), JSON.stringify({ profiles: Object.fromEntries(s.cliProfiles.map((n) => [n, {}])) }))
  if (s.signedProfiles) writeFileSync(join(cliConfig, "fake-cli-signed.json"), JSON.stringify(s.signedProfiles))
  if (s.choices) {
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(p.engineState, JSON.stringify({ agents: s.choices }), { mode: 0o600 })
  }
  for (const e of s.signedIn ?? []) {
    mkdirSync(join(dir, `.${e}`), { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `.${e}`, "auth.json"), "{}", { mode: 0o600 })
  }
  for (const [agent, script] of Object.entries(s.candle ?? {})) {
    const folder = candleConfigDir(p.stateDir, agent)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, "fake-candle.json"), JSON.stringify(script))
  }
  return { env, p, dir }
}

const failing = (checks: Check[]) => checks.filter((c) => c.state === "fail")
const find = (checks: Check[], area: string, text: RegExp) => checks.find((c) => c.area === area && text.test(c.text))

test("all set: every check passes, each agent checked with Candle under its own key", async () => {
  const { env, p, dir } = await setup()
  const checks = await runDoctor({ env })
  expect(failing(checks)).toEqual([])
  expect(checks.filter((c) => c.state === "warn")).toEqual([])
  expect(find(checks, "config", /2 agents \(momentum, swing\); the core starts in paper mode \(config\.toml's mode/)).toBeDefined()
  expect(find(checks, "key", new RegExp(`^momentum: key ${LIVE}Momentum…, private \\(0600\\)`))).toBeDefined()
  expect(find(checks, "candle", /the candle CLI is 0\.13\.18/)).toBeDefined()
  expect(find(checks, "claude", /signed in/)).toBeDefined()
  expect(find(checks, "vault", /^a vault is on this machine/)).toMatchObject({ state: "ok" })
  expect(find(checks, "access", /^no agent key is Withdraw/)).toMatchObject({ state: "ok" })
  for (const agent of ["momentum", "swing"]) {
    expect(find(checks, "candle", new RegExp(`^${agent}: Candle answers \\(MCP server .*\\); trades from the embedded wallet Wall…1111, plan Pro \\(fee 0.5%\\), Candle key limit \\$100 daily`))).toBeDefined()
    expect(find(checks, "candle", new RegExp(`^${agent}: its key has Write access`))).toBeDefined()
    const calls = readFileSync(join(candleConfigDir(p.stateDir, agent), "fake-candle-calls.jsonl"), "utf8")
    expect(calls).toContain("candle_execution_status")
    const seen = JSON.parse(readFileSync(join(candleConfigDir(p.stateDir, agent), "fake-candle-seen.json"), "utf8"))
    expect(seen.env.CANDLE_API_KEY).toBe(agent === "momentum" ? MOMENTUM_KEY : SWING_KEY)
  }
  // The owner's key list ran as the user, with no agent key in its environment.
  const runs = readFileSync(join(env.CANDLE_CONFIG_DIR!, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const list = runs.find((r) => r.argv[0] === "keys")
  expect(list.argv).toEqual(["keys", "list", "--json"])
  expect(list.env.CANDLE_API_KEY).toBeUndefined()
  // The one-word turn: the prompt on stdin, no tools, none of the user's settings, nothing kept.
  expect(readFileSync(join(dir, "claude-stdin.txt"), "utf8")).toBe("Reply with the single word: ok")
  const args = readFileSync(join(dir, "claude-args.txt"), "utf8").split("\n")
  for (const flag of ["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence"]) expect(args).toContain(flag)
  expect(args[args.indexOf("--tools") + 1]).toBe("")
})

test("the command prints the report, never a key, and exits 0 when nothing fails", async () => {
  const { env } = await setup()
  const out: string[] = []
  expect(await doctorCommand([], { out: (s) => void out.push(s), err: (s) => void out.push(s) }, env)).toBe(0)
  const text = out.join("")
  expect(text).toContain("All checks passed.")
  // The first line names the version and the commit, so a run can confirm its binary.
  expect(text.split("\n")[0]).toStartWith(`candle-harness doctor ${VERSION} (${COMMIT})`)
  expect(text).not.toContain(MOMENTUM_KEY)
  expect(text).not.toContain(SWING_KEY)
})

test("Claude Code signed out: a failure saying how to sign in", async () => {
  const { env } = await setup({ claude: "claude-signedout" })
  const check = find(await runDoctor({ env }), "claude", /isn't signed in/)
  expect(check).toMatchObject({ state: "fail", fix: expect.stringContaining("/login") })
})

test("before setup, Claude Code signed out is a warning that names setup's step 2", async () => {
  const { env, p, dir } = await setup({ claude: "claude-signedout" })
  rmSync(p.configFile)
  const checks = await runDoctor({ env: { ...env, PATH: `${dir}:${env.PATH}` } })
  expect(find(checks, "claude", /isn't signed in/)).toMatchObject({ state: "warn", fix: expect.stringMatching(/^Setup's step 2 does this when you pick Claude Code \(candle-harness\), or: Run `claude`.*\/login/) })
})

test("Claude Code missing: a failure saying to install it", async () => {
  const { env } = await setup({ claude: "missing" })
  expect(find(await runDoctor({ env }), "claude", /isn't installed/)).toMatchObject({ state: "fail" })
})

test("the candle CLI missing, or too old", async () => {
  const missing = await setup({ cliPath: "/nowhere/candle" })
  const checks = await runDoctor({ env: missing.env, online: false })
  expect(find(checks, "candle", /isn't installed/)).toMatchObject({ state: "fail", fix: expect.stringContaining("install.sh") })
  const old = await setup({ cliVersion: "0.11.30" })
  expect(find(await runDoctor({ env: old.env, online: false }), "candle", /0\.11\.30; the Candle Harness needs 0\.13\.18/)).toMatchObject({ state: "fail", fix: "Run `candle update`." })
})

test("the CLI's version against the one the Candle Harness was checked against", async () => {
  const same = await setup({ cliVersion: "0.13.18" })
  expect(find(await runDoctor({ env: same.env, online: false }), "candle", /^the candle CLI is 0\.13\.18, the version the Candle Harness was checked against$/)).toMatchObject({ state: "ok" })
  // Older than the one checked against: only that one is supported.
  const older = await setup({ cliVersion: "0.13.5" })
  expect(find(await runDoctor({ env: older.env, online: false }), "candle", /0\.13\.5; the Candle Harness needs 0\.13\.18 or later/)).toMatchObject({ state: "fail", fix: "Run `candle update`." })
  // Newer: it runs, and what the table doesn't hold is refused.
  const newer = await setup({ cliVersion: "0.14.0" })
  const check = find(await runDoctor({ env: newer.env, online: false }), "candle", /0\.14\.0/)
  expect(check).toMatchObject({ state: "warn" })
  expect(check!.text).toBe("the candle CLI is 0.14.0; the Candle Harness was checked against 0.13.18, so commands newer than that are refused")
})

test("no config: before setup, says where to start as a warning, with no key in it, and still checks the tools", async () => {
  const { env, p } = await setup()
  rmSync(p.configFile)
  const checks = await runDoctor({ env, online: false })
  const config = find(checks, "config", /^no agent yet: setup hasn't made one/)!
  expect(config.state).toBe("warn")
  expect(config.fix).toBe("Run `candle-harness`: setup opens and makes your first agent.")
  expect(checks.filter((c) => c.area === "config" && c.state === "fail")).toEqual([])
  // With no config, the defaults are looked for: `candle` and `claude` on PATH.
  expect(find(checks, "candle", /the candle CLI isn't installed \(no "candle" found\)/)).toBeDefined()
  expect(find(checks, "claude", /Claude Code isn't installed \(no "claude" found\)/)).toBeDefined()
})

test("key files: missing, readable by others, not a key, or a test key", async () => {
  const { env, p } = await setup({ agents: { momentum: MOMENTUM_KEY, swing: SWING_KEY, tester: fakeKey("test", "Testtest", "t"), broken: "hello" } })
  rmSync(p.keyFile("swing"))
  chmodSync(p.keyFile("momentum"), 0o644)
  const checks = await runDoctor({ env, online: false })
  expect(find(checks, "key", /^swing has no key file/)).toMatchObject({ state: "fail", fix: "Run `candle-harness key add --agent swing` with its key." })
  expect(find(checks, "key", /momentum\.key can be read by others \(mode 644\)/)).toMatchObject({ state: "fail", fix: `Run \`chmod 600 ${p.keyFile("momentum")}\`.` })
  expect(find(checks, "key", /broken\.key doesn't hold a Candle agent key/)).toMatchObject({ state: "fail" })
  expect(find(checks, "key", /tester has a test key/)).toMatchObject({ state: "warn", text: expect.stringContaining("TEST_ENVIRONMENT_FORBIDDEN") })
})

test("the state folder: readable by others warns; writable by others fails and skips Candle", async () => {
  const loose = await setup()
  chmodSync(loose.p.stateDir, 0o755)
  expect(find(await runDoctor({ env: loose.env, online: false }), "state", /readable by others \(mode 755\)/)).toMatchObject({ state: "warn" })
  const open = await setup()
  chmodSync(open.p.stateDir, 0o777)
  const checks = await runDoctor({ env: open.env })
  expect(find(checks, "state", /writable by others/)).toMatchObject({ state: "fail", fix: `Run \`chmod 700 ${open.p.stateDir}\`.` })
  expect(find(checks, "candle", /state folder needs fixing first/)).toMatchObject({ state: "skip" })
  chmodSync(open.p.stateDir, 0o700)
})

test("a config.toml anyone can write fails, with the chmod that fixes it", async () => {
  const open = await setup()
  chmodSync(open.p.configFile, 0o666)
  expect(find(await runDoctor({ env: open.env, online: false }), "state", /config\.toml is writable by anyone/)).toMatchObject({ state: "fail", fix: expect.stringContaining(`chmod o-w ${open.p.configFile}`) })
  chmodSync(open.p.configFile, 0o600)
})

test("while config.toml isn't safe, the doctor runs none of the programs it names, and says why", async () => {
  const dir = tempDir("chrn-dr-ran-")
  const ran = join(dir, "ran.log")
  const program = join(dir, "logs-its-calls")
  writeFileSync(program, `#!/bin/sh\necho "$@" >> '${ran}'\necho 0.13.18\n`, { mode: 0o755 })
  const open = await setup({ cliPath: program, engines: { codex: program, grok: program, opencode: program, pi: program } })
  chmodSync(open.p.configFile, 0o666)
  const checks = await runDoctor({ env: open.env, online: false })
  chmodSync(open.p.configFile, 0o600)
  expect(existsSync(ran)).toBe(false)
  expect(find(checks, "candle", /weren't run: config\.toml names them/)).toMatchObject({ state: "skip" })
})

test("a socket path over the limit says to set a shorter home", async () => {
  const checks = await runDoctor({ env: { CANDLE_HARNESS_HOME: `/tmp/${"x".repeat(100)}` }, online: false })
  expect(checks).toEqual([expect.objectContaining({ area: "paths", state: "fail", fix: expect.stringContaining("CANDLE_HARNESS_HOME") })])
})

test("a key not allowed the embedded wallet: a warning (a key the Candle Harness makes starts so), the owner command that allows it, and Candle still answers", async () => {
  const { env } = await setup({ candle: { swing: { embeddedWalletPermission: "denied" } } })
  const checks = await runDoctor({ env })
  // The plan and the key's requests a minute are said whatever its wallets.
  expect(find(checks, "candle", /^swing: Candle answers/)).toMatchObject({ state: "ok", text: expect.stringMatching(/plan \w+.*Candle allows the key \d+ requests a minute/) })
  expect(find(checks, "candle", /^swing: its key isn't allowed the account's embedded wallet/)).toMatchObject({
    state: "warn",
    fix: expect.stringContaining("candle keys update Swingkey --embedded-wallet allow"),
  })
  expect(find(checks, "candle", /^momentum: Candle answers/)).toBeDefined()
})

test("Candle refusing the key: expired, unknown, paused or stopped", async () => {
  const cases: [string, RegExp][] = [
    ["KEY_EXPIRED", /has expired/],
    ["UNAUTHORIZED", /doesn't accept this key/],
    ["PROFILE_PAUSED", /paused/],
    ["RISK_LIMIT_REACHED", /circuit breaker/],
  ]
  for (const [code, text] of cases) {
    const { env } = await setup({ agents: { momentum: MOMENTUM_KEY }, candle: { momentum: { tools: { candle_execution_status: { refuse: code } } } } })
    const check = find(await runDoctor({ env }), "candle", text)
    expect(check?.state).toBe("fail")
    expect(check?.fix).toBeDefined()
  }
})

test("a status read with unreadable parts says to fix that first", async () => {
  const { env } = await setup({ agents: { momentum: MOMENTUM_KEY }, candle: { momentum: { unreadable: ["limits"] } } })
  expect(find(await runDoctor({ env }), "candle", /couldn't read this key's limits\. Fix that before anything else/)).toMatchObject({ state: "fail" })
})

test("Candle's MCP server failing to start: the locked keychain explained, other errors shown redacted", async () => {
  const locked = await setup({ agents: { momentum: MOMENTUM_KEY }, candle: { momentum: { startError: "Error: Cannot read the macOS Keychain (security exited 36)" } } })
  expect(find(await runDoctor({ env: locked.env }), "candle", /can't read the macOS keychain/)).toMatchObject({ state: "fail", fix: UNLOCK_KEYCHAIN })
  const other = await setup({ agents: { momentum: MOMENTUM_KEY }, candle: { momentum: { startError: "boom: bad key $KEY" } } })
  const checks = await runDoctor({ env: other.env })
  const check = find(checks, "candle", /^momentum: /)
  expect(check?.state).toBe("fail")
  expect(check?.text).toContain("boom: bad key [redacted]")
  expect(JSON.stringify(checks)).not.toContain(MOMENTUM_KEY)
})

test("an MCP server older than the Candle Harness needs is refused, with the update", async () => {
  const { env } = await setup({ agents: { momentum: MOMENTUM_KEY }, candle: { momentum: { version: "0.10.1" } } })
  expect(find(await runDoctor({ env }), "candle", /0\.10\.1; the Candle Harness needs 0\.10\.22/)).toMatchObject({ state: "fail" })
})

test("the owner's key list: a locked keychain, or a CLI that isn't signed in", async () => {
  const locked = await setup({ keysListFail: { stderr: "Error: Cannot read the macOS Keychain (security exited 36)", exitCode: 1 } })
  expect(find(await runDoctor({ env: locked.env }), "access", /keychain/)).toMatchObject({ state: "fail", fix: UNLOCK_KEYCHAIN })
  const signedOut = await setup({ keysListFail: { stderr: "Not signed in. Run `candle auth login` first.", exitCode: 1 } })
  const checks = await runDoctor({ env: signedOut.env })
  expect(find(checks, "access", /isn't signed in/)).toMatchObject({ state: "skip", fix: expect.stringContaining("candle auth login") })
  // The agent-key checks still ran.
  expect(failing(checks)).toEqual([])
  expect(find(checks, "candle", /^momentum: Candle answers/)).toBeDefined()
})

test("the owner's key list: no swap:write, revoked, expiring, expired, or on another account", async () => {
  const now = Date.now()
  const { env } = await setup({
    agents: { momentum: MOMENTUM_KEY, swing: SWING_KEY, reader: fakeKey("live", "Readonly", "r"), old: fakeKey("live", "Oldkey00", "o"), soon: fakeKey("live", "Soonkey0", "n"), gone: fakeKey("live", "Expired0", "e") },
    keysList: {
      success: true,
      keys: [
        keyRow("Momentum"),
        keyRow("Readonly", { scopes: ["launch:write", "launch:read", "account:read", "activity:write"] }),
        keyRow("Oldkey00", { revokedAt: now - DAY }),
        keyRow("Soonkey0", { expiresAt: now + 2 * DAY }),
        keyRow("Expired0", { expiresAt: now - DAY }),
      ],
    },
  })
  const checks = await runDoctor({ env })
  expect(find(checks, "candle", /^reader: its key can't trade/)).toMatchObject({ state: "fail", fix: expect.stringContaining("candle keys access Readonly --access write") })
  expect(find(checks, "candle", /^old: its key was revoked/)).toMatchObject({ state: "fail", fix: expect.stringContaining("candle-harness key add --agent old") })
  expect(find(checks, "candle", /^soon: its key expires on/)).toMatchObject({ state: "warn" })
  expect(find(checks, "candle", /^gone: its key expired on/)).toMatchObject({ state: "fail" })
  expect(find(checks, "candle", /^swing: key Swingkey isn't on the account your candle CLI is signed in to/)).toMatchObject({ state: "warn" })
  expect(find(checks, "candle", /^momentum: its key has Write access/)).toBeDefined()
})

test("--offline asks Candle nothing and sends Claude Code no turn", async () => {
  const { env, p, dir } = await setup()
  const checks = await runDoctor({ env, online: false })
  expect(find(checks, "candle", /--offline/)).toMatchObject({ state: "skip" })
  expect(find(checks, "claude", /sign-in wasn't checked/)).toMatchObject({ state: "skip" })
  expect(existsSync(join(candleConfigDir(p.stateDir, "momentum"), "fake-candle-seen.json"))).toBe(false)
  expect(existsSync(join(dir, "claude-args.txt"))).toBe(false)
  const runs = readFileSync(join(env.CANDLE_CONFIG_DIR!, "fake-cli-runs.jsonl"), "utf8")
  expect(runs).not.toContain('"keys"')
  expect(runs).not.toContain('"vault"')
})

describe("owner steps", () => {
  test("a vault on this machine: ok, with its factors, read with no unlock", async () => {
    const { env } = await setup({ vault: { passphrase: "right horse" } })
    const checks = await runDoctor({ env })
    expect(find(checks, "vault", /^a vault is on this machine, with 1 factor: owner steps through the Candle Harness ask for it in the prompt pane/)).toMatchObject({ state: "ok" })
    const runs = readFileSync(join(env.CANDLE_CONFIG_DIR!, "fake-cli-runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv as string[])
    const reads = runs.filter((a) => a[0] === "vault")
    expect(reads).toEqual([["vault", "status", "--json"]])
  })

  test("no vault: a warning that owner steps run without a factor, and candle vault init", async () => {
    const { env } = await setup({ vault: { missing: true } })
    const checks = await runDoctor({ env })
    const vault = find(checks, "vault", /no vault/)!
    expect(vault).toMatchObject({ state: "warn", text: "no vault: owner steps run without a factor, approved by you in the prompt pane, which the agent can't type in" })
    expect(vault.fix).toContain("candle vault init")
    expect(failing(checks)).toEqual([])
  })

  test("a vault the Candle Harness saw, gone now: a failure naming vault restore and forget vault", async () => {
    const { env, p } = await setup({ vault: { missing: true } })
    writeFileSync(p.vaultSeen, `${JSON.stringify({ seenAt: "2026-10-01T00:00:00.000Z" })}\n`, { mode: 0o600 })
    const checks = await runDoctor({ env })
    const vault = find(checks, "vault", /had a vault/)!
    expect(vault.state).toBe("fail")
    expect(vault.fix).toContain("candle vault restore")
    expect(vault.fix).toContain("forget vault")
  })

  test("an agent key with Withdraw access is named plainly, with the command that narrows it to Write", async () => {
    const withdraw = ["launch:write", "launch:read", "activity:write", "swap:write", "transfer:write", "account:read", "transfer:bound"]
    const { env } = await setup({ keysList: { success: true, keys: [keyRow("Momentum", { scopes: withdraw }), keyRow("Swingkey")] } })
    const checks = await runDoctor({ env })
    const line = find(checks, "access", /Withdraw/)!
    expect(line.state).toBe("warn")
    expect(line.text).toBe("momentum's key is Withdraw (transfer:write): it can move funds out with its own key, outside any card. The Candle Harness never moves funds with an agent's key, only from your vault")
    expect(line.fix).toContain("`candle keys access Momentum --access write`")
    expect(find(checks, "access", /^no agent key is Withdraw/)).toBeUndefined()
    // The key still trades: Withdraw holds swap:write.
    expect(find(checks, "candle", /^momentum: its key has Write access/)).toBeDefined()
  })

  test("a revoked Withdraw key isn't named: it can't move anything", async () => {
    const withdraw = ["swap:write", "transfer:write", "account:read"]
    const { env } = await setup({ keysList: { success: true, keys: [keyRow("Momentum", { scopes: withdraw, revokedAt: Date.now() - DAY }), keyRow("Swingkey")] } })
    const checks = await runDoctor({ env })
    expect(find(checks, "access", /Withdraw/)?.state).toBe("ok")
  })
})

test("the quick doctor a failed view prints: only what's wrong, and the way to the full check", async () => {
  const { env, p } = await setup()
  rmSync(p.keyFile("swing"))
  const text = await quickDoctor(env)
  expect(text).toContain("swing has no key file")
  expect(text).not.toContain("Claude Code is 2.1.310")
  expect(text).toContain("Run `candle-harness doctor` for the full check")
})

test("the sign-in turn has no tools, no MCP servers and keeps no session", () => {
  const args = signInTurnArgs("claude")
  expect(args.slice(0, 2)).toEqual(["claude", "-p"])
  expect(args[args.indexOf("--tools") + 1]).toBe("")
  expect(args).not.toContain("--mcp-config")
  for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) expect(args).toContain(flag)
})

test("the config line says which mode the core starts in, and why", async () => {
  const { env, p } = await setup()
  writeFileSync(p.modeState, JSON.stringify({ mode: "live", at: "2026-10-26T00:00:00.000Z" }), { mode: 0o600 })
  expect(find(await runDoctor({ env, online: false }), "config", /the core starts in live mode \(the mode last picked\)/)).toBeDefined()
})

test("the lost-reply debug switch, when set, is a warning that says how to unset it", async () => {
  const { env } = await setup()
  expect(find(await runDoctor({ env, online: false }), "debug", /./)).toBeUndefined()
  const on = await runDoctor({ env: { ...env, CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1" }, online: false })
  expect(find(on, "debug", /answer to the next live trade, swap or CLI card row is dropped, once/)).toMatchObject({ state: "warn", fix: expect.stringContaining("unset CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY") })
})

test("each key's Candle cap use, from the owner's key list by the CLI's rule; a warning near the cap", async () => {
  const keys = [
    keyRow("Momentum", { txLimit: { usdMicros: 10_000_000, reset: "daily" }, usage: { todayUsdMicros: 9_500_000 }, emberWindow: null }),
    keyRow("Swingkey", { txLimit: { usdMicros: 10_000_000, reset: "daily" }, usage: { todayUsdMicros: 9_900_000 }, emberWindow: { reservedUsdMicros: 1_010_000 } }),
  ]
  const { env } = await setup({ keysList: { success: true, keys } })
  const checks = await runDoctor({ env })
  const momentum = find(checks, "candle", /^momentum: Candle's cap on its key: \$9\.50 of \$10\.00 used today \(UTC\), counting buys, sells and swaps/)!
  expect(momentum.state).toBe("warn")
  expect(momentum.text).toEndWith("selling a token is never refused by it, and a TEE wallet's sells count towards it without showing here")
  expect(momentum.fix).toContain("`candle keys limit Momentum --tx-limit <usd>`")
  // The window's reservation is the figure Candle checks, when there is one, and the booked one beside it.
  const swing = find(checks, "candle", /^swing: Candle's cap on its key: \$1\.01 of \$10\.00 used today/)!
  expect(swing.state).toBe("ok")
  expect(swing.text).toEndWith("and its fills book $9.90 today (UTC), a TEE wallet's sells included, which the figure Candle checks counts only as they settle")
  // Where the two agree, it says so, with no second figure.
  const even = await setup({ keysList: { success: true, keys: [keys[0]!, keyRow("Swingkey", { txLimit: { usdMicros: 10_000_000, reset: "daily" }, usage: { todayUsdMicros: 4_000_000 }, emberWindow: { reservedUsdMicros: 4_000_000 } })] } })
  expect(find(await runDoctor({ env: even.env }), "candle", /^swing: Candle's cap on its key: \$4\.00 of \$10\.00/)!.text).toEndWith("selling a token is never refused by it, and its fills agree")

})

describe("TEE wallets", () => {
  const TEE = { id: "teeid1", address: "TeeFake111111111111111111111111111111111111", label: "bot-wallet", boundKeyPrefix: "Momentum" }
  const teeSetup = (extra: Setup = {}, wallet: Partial<typeof TEE> & { active?: boolean } = {}, tier: FakeScript["tier"] = "max") => {
    const teeWallets = [{ ...TEE, ...wallet }]
    return setup({ candle: { momentum: { teeWallets, tier }, swing: { teeWallets, tier } }, tee: { wallets: teeWallets }, ...extra })
  }

  test("all set: each agent's TEE wallet active with its signer here, the RPC from config, and whether Candle serves LP", async () => {
    const { env } = await teeSetup({ rpcUrl: "https://rpc.example.test/v1/secret-path" })
    const checks = await runDoctor({ env })
    expect(failing(checks)).toEqual([])
    expect(checks.filter((c) => c.state === "warn")).toEqual([])
    expect(find(checks, "wallet", /^momentum: TEE wallet bot-wallet \(TeeF…1111\) is active, and its signer is on this machine$/)).toBeDefined()
    expect(checks.some((c) => c.area === "wallet" && c.text.startsWith("swing:"))).toBe(false)
    // Only the host is shown: a provider key can sit in the URL.
    const rpc = find(checks, "wallet", /TEE trades read the chain over rpc\.example\.test/)!
    expect(rpc.state).toBe("ok")
    expect(rpc.text).not.toContain("secret-path")
    expect(find(checks, "candle", /^Candle doesn't serve LP yet \(LP_NOT_ENABLED\)/)).toMatchObject({ state: "ok" })
    expect(find(checks, "candle", /^momentum: .*plan Max \(fee 0\.5%\)/)).toBeDefined()
    // The signer read ran with the agent's own key; the LP read too.
    const runs = readFileSync(join(env.CANDLE_CONFIG_DIR!, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(runs.find((r) => r.argv[0] === "wallets")).toMatchObject({ argv: ["wallets", "--json"], env: { CANDLE_API_KEY: MOMENTUM_KEY } })
    expect(runs.filter((r) => r.argv[0] === "wallets" && r.argv[1] !== "close-empty")).toHaveLength(1) // swing holds none, so isn't asked
    // Its empty token accounts: Candle's preview with the wallet's key, never --yes.
    expect(runs.filter((r) => r.argv[1] === "close-empty")).toEqual([expect.objectContaining({ argv: ["wallets", "close-empty", "--wallet", TEE.address, "--json"], env: expect.objectContaining({ CANDLE_API_KEY: MOMENTUM_KEY }) })])
    expect(find(checks, "wallet", /^TEE wallet bot-wallet \(TeeF…1111\) has no empty token accounts \(Candle's preview\)$/)).toMatchObject({ state: "ok" })
    expect(runs.find((r) => r.argv[0] === "lp").argv.slice(0, 2)).toEqual(["lp", "pools"])
  })

  test("no TEE wallet anywhere: no RPC warning, and nothing about signers", async () => {
    const { env } = await setup()
    const checks = await runDoctor({ env })
    // The approvals' line shares the area: only the embedded wallet is named.
    expect(checks.filter((c) => c.area === "wallet").map((c) => c.text)).toEqual([
      "every wallet the agents pay from asks every time (the embedded wallet (Wall…1111)), so every live trade is a card, as by default. Trading inside limits is turned on wallet by wallet in the view's settings ▾ → approvals",
    ])
  })

  test("no candle.rpcUrl and no CLI profile RPC with a TEE wallet: a warning that TEE trades read over Solana's public endpoint", async () => {
    const { env } = await teeSetup()
    const rpc = find(await runDoctor({ env }), "wallet", /neither candle\.rpcUrl nor a candle CLI profile names an RPC/)!
    expect(rpc.state).toBe("warn")
    expect(rpc.text).toContain("Solana's public endpoint, which rate-limits")
    expect(rpc.fix).toContain("candle.rpcUrl")
  })

  describe("the CLI profile's own RPC, read from its config.json, as the CLI picks it", () => {
    const rpcWith = async (cliConfig: unknown, extra: Setup = {}) => {
      const { env } = await teeSetup(extra)
      writeFileSync(join(env.CANDLE_CONFIG_DIR!, "config.json"), JSON.stringify(cliConfig))
      return (await runDoctor({ env })).find((c) => c.area === "wallet" && /TEE trade|RPC/.test(c.text))!
    }
    const profile = (rpcUrl?: string) => ({ apiUrl: "https://api.example.test", ...(rpcUrl ? { rpcUrl } : {}) })

    test("the active profile's rpcUrl: ok, host only", async () => {
      const rpc = await rpcWith({ activeProfile: "work", profiles: { work: profile("https://rpc.example.test/key-in-path"), play: profile("https://other.example.test") } })
      expect(rpc).toMatchObject({ state: "ok", text: "TEE trades read the chain over rpc.example.test (the candle CLI's profile work)" })
    })

    test("a sole profile acts with no activeProfile", async () => {
      expect(await rpcWith({ profiles: { solo: profile("https://rpc.example.test") } })).toMatchObject({ state: "ok", text: expect.stringContaining("profile solo") })
    })

    test("the active profile has none: the public endpoint, though another profile has one", async () => {
      const rpc = await rpcWith({ activeProfile: "work", profiles: { work: profile(), play: profile("https://other.example.test") } })
      expect(rpc).toMatchObject({ state: "warn", text: expect.stringContaining("nor the candle CLI's profile work names an RPC") })
    })

    test("candle.rpcUrl wins over the profile's, as --rpc-url does", async () => {
      const rpc = await rpcWith({ activeProfile: "work", profiles: { work: profile("https://other.example.test") } }, { rpcUrl: "https://rpc.example.test" })
      expect(rpc).toMatchObject({ state: "ok", text: "TEE trades read the chain over rpc.example.test (candle.rpcUrl)" })
    })

    test("a profile rpcUrl the CLI would refuse fails, naming the fix", async () => {
      const rpc = await rpcWith({ activeProfile: "work", profiles: { work: profile("http://rpc.example.test") } })
      expect(rpc).toMatchObject({ state: "fail", text: expect.stringContaining("isn't https"), fix: expect.stringContaining("candle profile set work --rpc-url") })
    })

    test("several profiles and none selected: the CLI refuses every TEE trade", async () => {
      const rpc = await rpcWith({ profiles: { work: profile(), play: profile() } })
      expect(rpc).toMatchObject({ state: "fail", text: expect.stringContaining("PROFILE_UNRESOLVED"), fix: expect.stringContaining("candle profile use") })
    })

    test("a config.json from before profiles: no profile RPC, so the public endpoint", async () => {
      expect(await rpcWith({ apiUrl: "https://api.example.test", keyPrefix: "x" })).toMatchObject({ state: "warn" })
    })
  })

  test("a signer that isn't on this machine, and a wallet stopped on Candle's side", async () => {
    const off = await runDoctor({ env: (await teeSetup({ tee: { wallets: [TEE], signers: {} } })).env })
    expect(find(off, "wallet", /^momentum: TEE wallet bot-wallet \(TeeF…1111\)'s signer isn't on this machine/)).toMatchObject({ state: "warn", fix: expect.stringContaining("machine that promoted it") })
    const inactive = await runDoctor({ env: (await teeSetup({}, { active: false })).env })
    expect(find(inactive, "wallet", /^momentum: TEE wallet bot-wallet \(TeeF…1111\) is stopped on Candle's side/)).toMatchObject({ state: "warn" })
  })

  test("on Free: the plan named, and a key holding a TEE wallet warned that TEE wallets need Pro or Max", async () => {
    const free = await runDoctor({ env: (await teeSetup({}, {}, "free")).env })
    expect(find(free, "candle", /^swing: .*plan Free \(fee 0\.5%; TEE wallets need Pro or Max\)/)).toMatchObject({ state: "ok" })
    expect(find(free, "wallet", /^momentum: its key holds TEE wallet bot-wallet, but the plan is Free: TEE wallets need Pro or Max/)).toMatchObject({ state: "warn" })
  })

  test("a default wallet that pays is ok; one that no longer can is a warning saying what to edit", async () => {
    const good = await runDoctor({ env: (await teeSetup({ wallets: { momentum: "bot-wallet" } })).env })
    expect(find(good, "wallet", /^momentum: pays from bot-wallet when a trade names no wallet \(agents\.momentum\.wallet\)/)).toMatchObject({ state: "ok" })
    const bad = await runDoctor({ env: (await teeSetup({ wallets: { swing: "bot-wallet" } })).env })
    const check = find(bad, "wallet", /^swing: swing's default wallet \(agents\.swing\.wallet = "bot-wallet"\) can't pay: it's bound to momentum's key/)!
    expect(check.state).toBe("warn")
    expect(check.fix).toContain("config.toml")
  })

  test("a default named by a wallet's old name: it still pays, by the address it was last found at, and the line to change is named", async () => {
    const { env } = await teeSetup({ wallets: { momentum: "tee-one" } })
    // The core found "tee-one" at the TEE wallet before Candle renamed it bot-wallet.
    writeFileSync(paths(env).defaultPins, JSON.stringify({ pins: { momentum: { setting: "tee-one", address: TEE.address } } }))
    const checks = await runDoctor({ env })
    const check = find(checks, "wallet", /^momentum: pays from bot-wallet when a trade names no wallet, by its address: config\.toml's line \(agents\.momentum\.wallet = "tee-one"\) is that wallet's old name$/)!
    expect(check).toMatchObject({ state: "warn", fix: `Change agents.momentum.wallet in config.toml to "bot-wallet" (or its address), so the line says what it pays from.` })
    expect(checks.some((c) => c.text.includes("can't pay"))).toBe(false)
  })

  test("a TEE wallet bound to a revoked key: named, with the owner's rebind command", async () => {
    const stranded = { ...TEE, boundKeyPrefix: "OldKey12" }
    const { env } = await setup({
      keysList: { success: true, keys: [keyRow("Momentum"), keyRow("Swingkey"), keyRow("OldKey12", { revokedAt: Date.now() - DAY })] },
      tee: { wallets: [stranded] },
      candle: { momentum: { teeWallets: [stranded] }, swing: { teeWallets: [stranded] } },
    })
    const checks = await runDoctor({ env })
    const check = find(checks, "wallet", /^TEE wallet bot-wallet \(TeeF…1111\) is bound to revoked key OldKey12/)!
    expect(check.state).toBe("warn")
    // Ready to type in the Candle Harness, for each agent.
    expect(check.fix).toContain(`\`candle tee rebind ${TEE.address} --to-key Momentum\` (momentum)`)
    expect(check.fix).toContain(`\`candle tee rebind ${TEE.address} --to-key Swingkey\` (swing)`)
    // The owner's read: no agent key in its environment.
    const runs = readFileSync(join(env.CANDLE_CONFIG_DIR!, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const read = runs.find((r) => r.argv[0] === "keys" && r.argv[1] === "wallets")
    expect(read.argv).toEqual(["keys", "wallets", "OldKey12", "--json"])
    expect(read.env.CANDLE_API_KEY).toBeUndefined()
  })

  test("Candle serving LP is said, so the LP cards can be checked live", async () => {
    const checks = await runDoctor({ env: (await setup({ lpEnabled: true })).env })
    expect(find(checks, "candle", /^Candle serves LP now/)).toMatchObject({ state: "ok" })
  })
})

test("each agent's tools: the shell on is named with what it means, a list the engine can't hold is off, and hidden tools are listed", async () => {
  const { parseConfig } = await import("../config")
  const { config } = parseConfig(
    `[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.momentum.tools]\nshell = ["ls", "git log"]\ndeny = ["web_search"]\n` +
      `[agents.swing.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.swing.tools]\nshell = "everything"\n` +
      `[agents.quiet.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.quiet.tools]\nallow = ["candle_get_*"]\n` +
      `[agents.plain.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`,
    "config.toml",
  )
  const { toolChecks } = await import("./doctor")
  const on = { momentum: "codex", swing: "claude-code", quiet: "pi", plain: "claude-code" } as const
  const checks = toolChecks(config, { get: (agent: string) => ({ engine: on[agent as keyof typeof on], from: "saved" as const }) })
  expect(checks).toEqual([
    {
      area: "tools",
      state: "warn",
      text: "momentum has the shell on (ls, git log): reads aren't held to the research folder, and cards and limits don't cover what the shell runs",
      fix: 'If you don\'t mean that, set agents.momentum.tools.shell = "off" in config.toml. docs.candle.tv/harness/engines says what each engine\'s shell can reach.',
    },
    { area: "tools", state: "warn", text: "momentum is on Codex, which can't hold a list of shell commands, so its shell is off there", fix: "Pick Claude Code, Grok, OpenCode or Pi for momentum with ctrl-g to use the list." },
    { area: "tools", state: "ok", text: "momentum hides web_search (agents.momentum.tools)" },
    {
      area: "tools",
      state: "warn",
      text: "swing has the shell on (everything): reads aren't held to the research folder, and cards and limits don't cover what the shell runs",
      fix: 'If you don\'t mean that, set agents.swing.tools.shell = "off" in config.toml. docs.candle.tv/harness/engines says what each engine\'s shell can reach.',
    },
    { area: "tools", state: "ok", text: "quiet offers only candle_get_* (agents.quiet.tools)" },
  ])
})

test("an agent on Grok with a list: Grok's read-only commands also run, and its dangerous ones can't be listed", async () => {
  const { parseConfig } = await import("../config")
  const { toolChecks } = await import("./doctor")
  const { config } = parseConfig(`[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.momentum.tools]\nshell = ["git log", "rm", "git push"]\n`, "config.toml")
  const checks = toolChecks(config, { get: () => ({ engine: "grok" as const, from: "saved" as const }) })
  expect(checks.map((c) => [c.state, c.text])).toEqual([
    ["warn", "momentum has the shell on (git log, rm, git push): reads aren't held to the research folder, and cards and limits don't cover what the shell runs"],
    ["warn", 'momentum is on Grok, which won\'t run rm, git push from a list: Grok refuses its dangerous commands unless the shell is "everything"'],
    ["ok", "momentum is on Grok, which also runs its own read-only commands (ls, cat, grep…) beside the list"],
  ])
})

test("each agent's preset and skills, and what in the skills folder was left out", async () => {
  const { parseConfig } = await import("../config")
  const { skillChecks } = await import("./doctor")
  const { paths } = await import("../paths")
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const p = paths({ HOME: mkdtempSync(join(tmpdir(), "chds-")) })
  mkdirSync(join(p.skillsDir, "dip-buyer"), { recursive: true })
  writeFileSync(join(p.skillsDir, "dip-buyer", "SKILL.md"), "---\ndescription: Buy dips.\n---\nx\n")
  mkdirSync(join(p.skillsDir, "half-done"))
  writeFileSync(join(p.skillsDir, "half-done", "SKILL.md"), "no frontmatter")
  const { config } = parseConfig(
    `[agents.momentum.limits]\nperTradeUsd = 10\nperDayUsd = 50\n` +
      `[agents.swing]\npreset = "bare"\n[agents.swing.limits]\nperTradeUsd = 10\nperDayUsd = 50\n` +
      `[agents.quiet]\npreset = "bare"\n[agents.quiet.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.quiet.tools]\ndeny = ["skill_*"]\n`,
    "config.toml",
  )
  const checks = skillChecks(p, config, { preset: (_agent: string, configured?: "quant" | "trader" | "bare") => ({ preset: configured ?? "quant", from: "config" as const }) })
  expect(checks).toEqual([
    { area: "skills", state: "ok", text: "momentum runs as Quant, with 11 skills (1 your own)" },
    { area: "skills", state: "ok", text: "swing runs as Bare, with 1 skill (1 your own)" },
    { area: "skills", state: "ok", text: "quiet runs as Bare; skill_read is hidden in config, so it has no skills" },
    { area: "skills", state: "ok", text: "Candle's 10 skills are built in from candledottv/agentic at 26daf47 (MIT); Quant agents get them" },
    {
      area: "skills",
      state: "warn",
      text: 'half-done in your skills folder is left out: its SKILL.md has no description: start it with ---, a line "description: when to use it", then ---',
      fix: `See ${p.skillsDir}: each skill is a folder holding SKILL.md, with a description in its frontmatter.`,
    },
  ])
})

describe("Hacc and memory", () => {
  const hacc = (checks: Check[]) => checks.filter((c) => c.area === "hacc").map((c) => [c.state, c.text, ...(c.fix ? [c.fix] : [])])

  test("each key read once by Hacc, the account's plan and the tools it offers, and the stream; a refused key warns and fails nothing", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const fake = startFakeHacc({ keys: [MOMENTUM_KEY] }) // swing's key isn't one Hacc takes
    try {
      const { env } = await setup({ hacc: true, candle: { momentum: { tier: "max" }, swing: { tier: "pro" } } })
      const checks = await runDoctor({ env, haccHost: fake.url })
      expect(failing(checks)).toEqual([])
      const rows = hacc(checks)
      expect(rows).toHaveLength(4)
      expect(rows[0]).toEqual(["ok", expect.stringMatching(/^momentum: Hacc takes its key \(the tape answered in \d+ ms\); the account is on Max, so it's offered 7 of Hacc's 7 tools$/)])
      expect(rows[1]).toEqual(["warn", expect.stringMatching(/^Hacc refused swing's key \(invalid api key\)\. .*Its trades and Candle's reads still work; its Hacc tools are left out$/), expect.stringContaining("candle-harness key add --agent swing")])
      // Research's reads by the account's plan: all of them are Free's today.
      expect(rows[2]).toEqual(["ok", "Research: the account's plan (Max) reaches all of Hacc's reads its panes make"])
      expect(rows[3]).toEqual(["ok", "Hacc's stream opens with momentum's key; the core opens it while a view or an agent reads the tape"])
      // One row of the tape per key, each with its own key, and the upgrade with the key Hacc took.
      const reads = fake.calls.filter((c) => c.path === "/v1/signals")
      expect(reads.map((c) => [c.query.limit, c.auth])).toEqual(expect.arrayContaining([["1", `Bearer ${MOMENTUM_KEY}`], ["1", `Bearer ${SWING_KEY}`]]))
      expect(fake.calls.filter((c) => c.path === "/v1/signals/stream").map((c) => c.auth)).toEqual([`Bearer ${MOMENTUM_KEY}`])
      expect(formatReport(checks)).not.toContain(SWING_KEY)
    } finally {
      fake.stop()
    }
  })

  test("Pro and Free say what the next plan adds, a tool hidden in config isn't counted, and a full stream warns with Hacc's words", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const fake = startFakeHacc({ keys: [MOMENTUM_KEY, SWING_KEY], maxSockets: 0 })
    try {
      const { env, p } = await setup({ hacc: true, candle: { momentum: { tier: "pro" }, swing: { tier: "free" } } })
      writeFileSync(p.configFile, `${readFileSync(p.configFile, "utf8")}[agents.momentum.tools]\ndeny = ["hacc_social"]\n`)
      const rows = hacc(await runDoctor({ env, haccHost: fake.url }))
      expect(rows[0]![1]).toMatch(/^momentum: .*the account is on Pro, so it's offered 5 of Hacc's 7 tools \(Max adds hacc_wallets book_legs, hacc_lab\), with hacc_social hidden in config$/)
      expect(rows[1]![1]).toMatch(/^swing: .*the account is on Free, so it's offered 5 of Hacc's 7 tools \(Pro and Max add .*hacc_follows.*hacc_lab\)$/)
      expect(rows[2]).toEqual(["ok", "Research: the account's plan (Pro) reaches all of Hacc's reads its panes make"])
      expect(rows[3]).toEqual(["warn", expect.stringMatching(/^Hacc's stream is full for momentum's key \(Hacc: "too many subscribers for this key"\)/), expect.stringContaining("tries again every 30 s")])
    } finally {
      fake.stop()
    }
  })

  test("a plan refusal is the plan, not a fault: no fix to chase (a Free account's first run)", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const fake = startFakeHacc({ keys: [MOMENTUM_KEY, SWING_KEY], fail: { "GET /v1/signals": { status: 403, body: { error: "Stored intelligence requires Pro or Max" } } } })
    try {
      const { env } = await setup({ hacc: true, candle: { momentum: { tier: "free" }, swing: { tier: "free" } } })
      const rows = hacc(await runDoctor({ env, haccHost: fake.url }))
      expect(rows[0]).toEqual(["ok", expect.stringMatching(/^momentum: Hacc takes its key, and this read of the tape needs a paid plan \(.*Stored intelligence requires Pro or Max.*\); the account is on Free/)])
    } finally {
      fake.stop()
    }
  })

  test("Hacc off in config is one line, and --offline asks Hacc nothing", async () => {
    const off = await setup()
    expect(hacc(await runDoctor({ env: off.env, online: false }))).toEqual([])
    expect(hacc(await runDoctor({ env: off.env }))).toEqual([["skip", expect.stringContaining("[hacc] enabled = false"), "Set [hacc] enabled = true in config.toml to turn it on."]])
    const on = await setup({ hacc: true })
    expect(hacc(await runDoctor({ env: on.env, online: false }))).toEqual([["skip", "Hacc wasn't asked about each key or the stream (--offline)"]])
  })

  test("a running core's stream, read from its hacc topic as a view; it opens nothing", async () => {
    const { startFakeHacc } = await import("../../test/fake-hacc")
    const { AGENT_KEY, startTestCore } = await import("../../test/core-fixture")
    const { streamCheck } = await import("./doctor")
    const fake = startFakeHacc({ keys: [AGENT_KEY] })
    const c = await startTestCore({ haccHost: fake.url }, { config: { hacc: { enabled: true } } })
    try {
      expect(await streamCheck(c.p, undefined)).toEqual({ area: "hacc", state: "ok", text: "the running core has Hacc's stream closed: it opens while a view or an agent reads the tape" })
      expect(fake.calls.filter((call) => call.path === "/v1/signals/stream")).toEqual([])
      const view = await c.view()
      await view.request("subscribe", { topics: ["signals"] })
      await until(() => c.core.signals.view().state === "open")
      expect(await streamCheck(c.p, undefined)).toMatchObject({ state: "ok", text: expect.stringMatching(/^the running core has Hacc's stream open on momentum's key since \d\d:\d\d UTC$/) })
    } finally {
      await c.close()
      fake.stop()
    }
  })

  test("each agent's memory: none yet, its length, past the merge point, and an index the core won't read", async () => {
    const { parseConfig } = await import("../config")
    const { memoryChecks } = await import("./doctor")
    const p = paths({ HOME: tempDir("chrn-doc-mem-") })
    const { config } = parseConfig(["momentum", "swing", "long", "linked"].map((a) => `[agents.${a}.limits]\nperTradeUsd = 10\nperDayUsd = 50\n`).join(""), "config.toml")
    const memory = (agent: string) => {
      const dir = join(p.researchDir(agent), "memory")
      mkdirSync(dir, { recursive: true })
      return dir
    }
    writeFileSync(join(memory("swing"), "index.md"), "# Memory\n\n- buy floor: see buy-floor.md\n- skill: candle-risk-gate\n")
    writeFileSync(join(memory("swing"), "buy-floor.md"), "x")
    writeFileSync(join(memory("long"), "index.md"), `${"- a note that runs on\n".repeat(400)}`)
    const { symlinkSync } = await import("node:fs")
    writeFileSync(join(p.researchDir("swing"), "elsewhere.md"), "- x\n")
    symlinkSync(join(p.researchDir("swing"), "elsewhere.md"), join(memory("linked"), "index.md"))
    expect(memoryChecks(p, config)).toEqual([
      { area: "memory", state: "ok", text: "momentum has no memory index yet" },
      { area: "memory", state: "ok", text: "swing's memory index is 3 lines, 66 characters, and 1 other file" },
      { area: "memory", state: "ok", text: "long's memory index is 400 lines, 8,800 characters; past 6,000, so the agent is asked to merge it" },
      { area: "memory", state: "warn", text: "linked's memory isn't read into its turns: memory/index.md is a link, and memory is read only from files in the research folder", fix: `Make ${join(p.researchDir("linked"), "memory", "index.md")} a plain file, or clear the memory with the memory chip.` },
    ])
  })
})

describe("each engine", () => {
  const engineRows = (checks: Check[]) => checks.filter((c) => c.area === "engine")
  const PI_MODEL = "fake/fake-1"

  test("every engine ready: its version and gaps, a one-word turn through its own adapter on the agent's model or the default only where an agent is on it, and each agent's choice", async () => {
    const codex = fakeCodex()
    const pi = fakePi()
    const { env, p } = await setup({
      engines: { codex: codex.bin, grok: fakeGrok().bin, opencode: fakeOpenCode().bin, pi: pi.bin },
      signedIn: ["codex", "grok"],
      choices: { momentum: { engine: "codex" }, swing: { engine: "pi", model: PI_MODEL } },
    })
    const checks = await runDoctor({ env })
    expect(failing(checks)).toEqual([])
    expect(checks.filter((c) => c.state === "warn")).toEqual([])
    expect(find(checks, "engine", /^Codex is 0\.165\.0 \(needs 0\.165\.0\+; momentum is on it\): no web fetch, replies arrive whole$/)).toBeDefined()
    expect(find(checks, "engine", /^Codex is ready: a one-word turn answered on gpt-6\.1-sol \(it lists 8 models\)$/)).toBeDefined()
    expect(find(checks, "engine", /^Grok is 1\.0\.70 \(needs 1\.0\.70\+; no agent is on it\)$/)).toBeDefined()
    // No agent is on Grok or OpenCode: no turn spends the user's credit there.
    expect(find(checks, "engine", /^Grok lists 4 models and is signed in; no one-word turn was sent, since no agent is on it$/)).toMatchObject({ state: "ok" })
    expect(checks.some((c) => /^Grok is ready/.test(c.text))).toBe(false)
    expect(find(checks, "claude", /^Claude Code wasn't sent a one-word turn: no agent is on it$/)).toMatchObject({ state: "skip" })
    expect(find(checks, "engine", /^Pi is ready: a one-word turn answered on fake\/fake-1/)).toBeDefined()
    // A held-back ChatGPT sign-in is said.
    expect(find(checks, "engine", /^Your ChatGPT sign-in in OpenCode isn't offered here/)).toBeDefined()
    expect(find(checks, "engine", /^OpenCode lists 9 models; no one-word turn was sent, since no agent is on it$/)).toMatchObject({ state: "ok" })
    expect(find(checks, "engine", /^momentum is on Codex, its default model \(picked with ctrl-g\)$/)).toBeDefined()
    expect(find(checks, "engine", /^swing is on Pi, model fake\/fake-1 \(picked with ctrl-g\)$/)).toBeDefined()
    // Each turn reached the Candle Harness's empty MCP server, never a token or the core.
    const turn = codex.runs().find((r) => r.argv.includes("exec"))!
    expect(turn.argv.join(" ")).toContain("mcp\", \"--empty")
    expect(turn.argv.join(" ")).not.toContain("--token-file")
    // The doctor's homes are handed back and gone.
    expect(readdirSync(join(p.stateDir, "doctor-homes"))).toEqual([])
  }, 60_000)

  test("not installed: blocks only for an engine an agent is on, with how to install it and ctrl-g; too old, or not used, warns", async () => {
    const { env } = await setup({
      engines: { opencode: fakeOpenCode({ version: "1.19.4" }).bin },
      choices: { momentum: { engine: "grok" } },
    })
    const checks = engineRows(await runDoctor({ env, online: false }))
    expect(find(checks, "engine", /^Grok isn't installed \(no ".*no-grok" found\)\. Install it from x\.ai\/cli, sign in with grok login\.$/)).toMatchObject({
      state: "fail",
      fix: "momentum is on Grok: do that, or pick another engine with ctrl-g.",
    })
    expect(find(checks, "engine", /^Codex isn't installed; no agent is on it$/)).toMatchObject({ state: "skip" })
    expect(find(checks, "engine", /^Update OpenCode: this is 1\.19\.4, .*Run opencode upgrade\. No agent is on it\.$/)).toMatchObject({ state: "warn" })
    expect(find(checks, "engine", /models and sign-ins weren't checked \(--offline\)/)).toMatchObject({ state: "skip" })
  })

  test("signed out, or a one-word turn that fails: the engine's own words and how to sign in", async () => {
    const { env } = await setup({
      engines: { codex: fakeCodex().bin, grok: fakeGrok({ fixture: "grok-signedout" }).bin },
      signedIn: ["grok"],
      choices: { momentum: { engine: "codex" }, swing: { engine: "grok" } },
    })
    const checks = engineRows(await runDoctor({ env }))
    expect(find(checks, "engine", /^Codex isn't signed in \(momentum is on it\)$/)).toMatchObject({
      state: "fail",
      fix: "Sign in (codex login, or codex login --device-auth over SSH), then run candle-harness doctor again. Or pick another engine for momentum with ctrl-g.",
    })
    const grok = find(checks, "engine", /^Grok's one-word turn on .* failed: /)
    expect(grok).toMatchObject({ state: "fail" })
    expect(grok!.fix).toContain("grok login")
  }, 60_000)

  test("Pi listing no models, with a provider key only in the shell: named (never its value), and told to store it in Pi", async () => {
    const { env } = await setup({ engines: { pi: fakePi({ models: "No models available. Use /login to log into a provider via OAuth or API key.\n" }).bin }, choices: { momentum: { engine: "pi" } } })
    const secret = ["sk", "or", "v1", "x".repeat(20)].join("-")
    const checks = engineRows(await runDoctor({ env: { ...env, OPENROUTER_API_KEY: secret, CANDLE_API_KEY: "c" } }))
    const row = find(checks, "engine", /^Pi has no models to run/)
    expect(row).toMatchObject({ state: "fail" })
    expect(row!.fix).toContain("OPENROUTER_API_KEY is set in your shell, but engines don't get your environment here: store the key in Pi itself.")
    expect(JSON.stringify(checks)).not.toContain(secret)
    expect(row!.fix).not.toContain("CANDLE_API_KEY")
  }, 60_000)

  test("a turn that doesn't answer in time is cancelled and said", async () => {
    const { env } = await setup({ engines: { codex: fakeCodex({ delayMs: 5000 }).bin }, signedIn: ["codex"], choices: { momentum: { engine: "codex" } } })
    const checks = engineRows(await runDoctor({ env, engineTurnTimeoutMs: 1500 }))
    expect(find(checks, "engine", /^Codex didn't answer a one-word turn on gpt-6\.1-sol in 2 s$/)).toMatchObject({ state: "fail" })
  }, 60_000)

  test("Claude Code with no agent on it: missing is a skip, not a failure", async () => {
    const { env } = await setup({ claude: "missing", choices: { momentum: { engine: "codex" }, swing: { engine: "codex" } } })
    const checks = await runDoctor({ env, online: false })
    expect(find(checks, "claude", /^Claude Code isn't installed; no agent is on it$/)).toMatchObject({ state: "skip" })
    expect(failing(checks).map((c) => c.text)).toEqual([expect.stringMatching(/^Codex isn't installed/)])
  })

  test("--offline sends no engine a turn and reads no model list", async () => {
    const codex = fakeCodex()
    const { env } = await setup({ engines: { codex: codex.bin }, signedIn: ["codex"], choices: { momentum: { engine: "codex" } } })
    await runDoctor({ env, online: false })
    expect(codex.runs().map((r) => r.argv)).toEqual([["--version"]])
  })
})

test("the doctor names config.toml's aliases, and each it leaves out with its line", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "chrn-alias-"))
  try {
    const p = paths({ CANDLE_HARNESS_HOME: dir })
    writeFileSync(p.configFile, `[aliases]\nb5 = "buy $5 of"\n`)
    expect(aliasesChecks(p)).toEqual([{ area: "aliases", state: "ok", text: `1 alias in ${p.configFile}: b5` }])
    writeFileSync(p.configFile, `[aliases]\nb5 = "buy $5 of"\nsell = "buy $1 of"\n`)
    expect(aliasesChecks(p)).toMatchObject([{ area: "aliases", state: "warn", text: expect.stringContaining('config.toml line 3: alias "sell" is left out') }])
    writeFileSync(p.configFile, `activeAgent = "a"\n`)
    expect(aliasesChecks(p)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("layouts and themes", () => {
  const home = () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "chrn-look-"))
    const p = paths({ CANDLE_HARNESS_HOME: dir })
    mkdirSync(p.stateDir, { recursive: true })
    return { dir, p }
  }
  const texts = (checks: Check[]) => checks.map((c) => `${c.state} ${c.text}`)

  test("which layout each tab shows: the file's or the last picked, and Agent-first for a tab whose layout is gone", () => {
    const { dir, p } = home()
    try {
      expect(texts(layoutsChecks(p))[0]).toBe(`ok no ${p.layoutsFile}: 5 tabs (Trade, Cockpit, Research, Bots, Build), each on its preset, 5 ticked off (Trending, Signals, P&L, Journal, Perps)`)
      writeFileSync(p.layoutsFile, `tabs = [{ name = "Trade", layout = "Agent-first" }, { name = "Tape", layout = "Cockpit" }]\n\n[layouts.Wide]\nroot = ["row", "agent", "token"]\n`)
      writeFileSync(p.layoutChoice, JSON.stringify({ tabs: { Trade: "Wide", Tape: "Gone" } }))
      const lines = texts(layoutsChecks(p))
      expect(lines[0]).toBe(`ok ${p.layoutsFile}: 2 tabs shown (Trade, Tape), 8 ticked off (Trending, Signals, P&L, Research, Journal, Perps, Bots, Build), 1 layout of yours`)
      expect(lines.at(-1)).toBe("ok Trade shows Wide, last picked; Tape shows Cockpit")
      // A tab's own changes, kept until saved, are said; one left from a layout it no longer shows isn't.
      writeFileSync(p.layoutChoice, JSON.stringify({ tabs: { Trade: "Wide", Tape: "Gone" }, adjusted: { Tape: { base: "Cockpit", tree: ["row", "feed", "agent"] }, Trade: { base: "Agent-first", tree: ["row", "agent"] } } }))
      expect(texts(layoutsChecks(p)).at(-1)).toBe("ok Trade shows Wide, last picked; Tape shows Cockpit, with unsaved changes")
      writeFileSync(p.layoutsFile, `tabs = [{ name = "Trade", layout = "Mine" }]\nbogus = 1\n`)
      writeFileSync(p.layoutChoice, "{}")
      const bad = layoutsChecks(p)
      expect(bad.filter((c) => c.state === "warn").map((c) => c.text)).toContainEqual(expect.stringContaining("layouts.toml line 2"))
      expect(bad.filter((c) => c.state === "warn").map((c) => c.text)).toContainEqual(expect.stringContaining('"Mine"'))
      expect(bad.at(-1)!.text).toBe("Trade shows Agent-first")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the theme the view starts on and why, and each theme of yours that can't be used or leaves something out", () => {
    const { dir, p } = home()
    try {
      expect(texts(themeChecks(p))).toEqual(["ok the view starts on Candle dark (the default)"])
      writeFileSync(p.configFile, `[theme]\nname = "candle light"\n`)
      expect(texts(themeChecks(p))).toEqual(["ok the view starts on Candle light (config.toml's [theme] name)"])
      mkdirSync(p.themesDir)
      writeFileSync(join(p.themesDir, "Faint.toml"), 'dim = "#2a2e36"\n')
      writeFileSync(join(p.themesDir, "Warm.toml"), 'base = "dark"\ntext = "#f0e0d0"\nsparkle = "#ffffff"\n')
      writeFileSync(p.themeChoice, JSON.stringify({ name: "Warm", config: "Candle light" }))
      const lines = texts(themeChecks(p))
      expect(lines[0]).toBe(`ok the view starts on Warm (the theme last picked); 2 of yours in ${p.themesDir}: Faint, Warm`)
      expect(lines).toContainEqual(expect.stringMatching(/^warn themes\/Faint\.toml can't be used, since dim text/))
      expect(lines).toContainEqual(expect.stringMatching(/^warn themes\/Warm\.toml line 3: "sparkle" isn't one of a theme's colours/))
      // A left-out line of a theme that can't be used anyway doesn't say the rest is used.
      writeFileSync(join(p.themesDir, "Faint.toml"), 'dim = "#2a2e36"\nsparkle = "#ffffff"\n')
      const faintFixes = themeChecks(p).filter((c) => c.text.startsWith("themes/Faint.toml")).map((c) => c.fix)
      expect(faintFixes).toHaveLength(2)
      for (const fix of faintFixes) expect(fix).toEndWith("the palette won't draw it until then.")
      // The theme it starts on can't be drawn: said once, with what's drawn instead.
      writeFileSync(p.themeChoice, JSON.stringify({ name: "Faint", config: "Candle light" }))
      const faint = themeChecks(p).filter((c) => c.text.includes("Faint.toml can't"))
      expect(faint).toHaveLength(1)
      expect(faint[0]!.text).toEndWith(": the view starts on Candle dark instead")
      writeFileSync(p.themeChoice, JSON.stringify({ name: "Terminal", config: "Candle light" }))
      expect(themeChecks(p)[0]!.text).toStartWith("the view starts on Terminal (the theme last picked), drawn from the terminal's own colours")
      writeFileSync(p.configFile, `[theme]\nname = 3\n`)
      expect(themeChecks(p)[0]).toMatchObject({ state: "warn", text: expect.stringContaining("config.toml line 2: theme.name is 3") })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test("an engine refused for money is told to top up, not to sign in (Grok's 402)", () => {
  expect(outOfCredit('API error (status 402 Payment Required): Grok Build usage balance exhausted')).toBe(true)
  expect(outOfCredit("Your credit balance is too low to access the API")).toBe(true)
  expect(outOfCredit("Not logged in · Please run /login")).toBe(false)
  expect(outOfCredit(undefined)).toBe(false)
})

describe("each key's Candle limit and a running core's use of it", () => {
  test("the use over the last minute, background apart, and what was slowed to leave room for trades", () => {
    const checks = budgetWords({
      keys: [
        { agent: "agent-a", limit: 30, keyLimit: 30, lowered: false, used: 21, background: 14, allowance: 15 },
        { agent: "agent-b", limit: 150, keyLimit: 300, lowered: true, used: 4, background: 2, allowance: 75 },
      ],
      pace: { linked: { everyMs: 8_000, why: "limit" }, pins: { everyMs: 60_000, why: "limit" } },
    })
    expect(checks).toEqual([
      { area: "candle", state: "ok", text: "agent-a: the running core used 21 of its 30 requests in the last minute, 14 by background reads, which may use 15" },
      {
        area: "candle",
        state: "warn",
        text: "agent-b: the running core used 4 of its 150 requests in the last minute (half its 300, since Candle rate-limited it in the last 2 minutes), 2 by background reads, which may use 75",
        fix: "It eases by itself after 2 minutes. If it keeps happening, something else is using the key: an app or script with the same key counts against the same limit.",
      },
      { area: "candle", state: "ok", text: "to leave room for trades, the running core reads the linked token every 8 s (Candle's limit); pinned tokens every 60 s (Candle's limit)" },
    ])
  })

  test("nothing slowed adds no line, and a core from before the budget adds nothing", () => {
    expect(budgetWords({ keys: [{ agent: "agent-a", limit: 600, keyLimit: 600, lowered: false, used: 9, background: 9, allowance: 300 }], pace: {} })).toHaveLength(1)
    expect(budgetWords({ keys: [], pace: undefined as never })).toEqual([])
  })
})

describe("Final Stretch, P&L, the journal and Research", () => {
  test("Final Stretch on, behind or off on Candle's server, asked of one agent's server only", async () => {
    const on = await setup()
    const checks = await runDoctor({ env: on.env })
    expect(find(checks, "candle", /^Final Stretch/)).toEqual({ area: "candle", state: "ok", text: "Final Stretch is on Candle's server, so Trending shows all four lists" })
    const asked = (agent: string) => readFileSync(join(candleConfigDir(on.p.stateDir, agent), "fake-candle-calls.jsonl"), "utf8").includes("candle_get_feed")
    expect([asked("momentum"), asked("swing")]).toEqual([true, false])
    const off = await setup({ candle: { momentum: { finalStretch: "off" } } })
    expect(find(await runDoctor({ env: off.env }), "candle", /^Final Stretch/)).toMatchObject({ state: "ok", text: "Final Stretch is off on Candle's server, so Trending shows three lists and gives it no room" })
    const stale = await setup({ candle: { momentum: { finalStretch: "stale" } } })
    expect(find(await runDoctor({ env: stale.env }), "candle", /^Final Stretch/)).toMatchObject({ state: "warn", text: expect.stringMatching(/^Final Stretch is on, but Candle says its source is behind/) })
    expect(find(await runDoctor({ env: on.env, online: false }), "candle", /^Final Stretch/)).toBeUndefined()
  })

  test("the P&L window and where it came from, and each agent's samples with the last one's age", async () => {
    const { parseConfig } = await import("../config")
    const { pnlChecks } = await import("./doctor")
    const p = paths({ HOME: tempDir("chrn-doc-pnl-") })
    mkdirSync(p.stateDir, { recursive: true })
    const now = Date.parse("2026-10-30T18:00:00Z")
    const config = parseConfig('[agents.a.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[agents.b.limits]\nperTradeUsd = 10\nperDayUsd = 50\n[pnl]\nwindow = "midnight"\n', "config.toml").config
    expect(pnlChecks(p, config, now).map((c) => c.text)).toEqual([
      "the P&L window is since midnight (config.toml's [pnl] window, as nothing's been picked yet)",
      `no P&L samples yet in ${p.pnlSamples}: the core takes one with each read of Candle's books (every 5 minutes, every minute while a P&L pane is on screen), so each figure starts from its first`,
    ])
    const sample = (at: string) => JSON.stringify({ at, agent: "a", prefix: "Aaaaaaaa", totalUsd: 1, realizedNetUsd: 0, unrealizedUsd: 1 })
    writeFileSync(p.pnlSamples, [sample("2026-10-29T13:26:00Z"), "not a sample", sample("2026-10-30T17:57:00Z")].join("\n") + "\n")
    writeFileSync(p.pnlWindow, JSON.stringify({ window: "session", sessionEnd: "2026-10-30T15:00:00Z" }))
    expect(pnlChecks(p, config, now).map((c) => c.text)).toEqual([
      "the P&L window is since last session (the window last picked); the last session ended 3 hours ago",
      `P&L samples in ${p.pnlSamples}: a 2 since 2026-10-29, the last 3 min ago; b none yet`,
    ])
  })

  test("the journal's rows and size, counted without reading it into memory; none yet says the core starts one", async () => {
    const { journalChecks } = await import("./doctor")
    const p = paths({ HOME: tempDir("chrn-doc-jr-") })
    expect((await journalChecks(p))[0]!.text).toBe(`no journal yet at ${p.journal}: the core starts one`)
    mkdirSync(p.stateDir, { recursive: true })
    const row = `${JSON.stringify({ seq: 1, type: "core.started", pad: "x".repeat(200) })}\n`
    writeFileSync(p.journal, row.repeat(12_345))
    expect((await journalChecks(p))[0]).toEqual({ area: "journal", state: "ok", text: `${p.journal}: 12,345 rows, 2.8 MB; the Journal tab searches all of it` })
  })

  test("Research's reads a plan doesn't reach are named; all are Free's today", async () => {
    const { researchUnreached } = await import("../core/research-reads")
    expect(researchUnreached("free")).toEqual([])
    expect(researchUnreached("max")).toEqual([])
  })
})

describe("hands off and the last session", () => {
  const EMB = "WalletFake111111111111111111111111111111111"
  const TEE = "TeeWa11et22222222222222222222222222222222222"
  const OLD = "OldTee3333333333333333333333333333333333333"
  const now = Date.parse("2026-10-31T18:00:00Z")
  let seq = 0
  const row = (at: string, type: string, extra: Record<string, unknown> = {}) => ({ seq: ++seq, at, type, account: "acct", mode: "live" as const, ...extra })
  const stamp = (ms: number) => {
    const d = new Date(ms)
    const two = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
  }
  const clock = (iso: string) => stamp(Date.parse(iso)).slice(11)
  const LOSS = "Candle also has loss limits on each key (a day's realized loss, a fall from its high mark, losing trades in a row) and a circuit breaker on every key (30 trades in a minute, or 3 failed sells of one token in a row). A breach stops the key, sells included, until the owner resumes it in Candle's Agent Console, where they're set; the Candle Harness can't read them yet"
  const home = async (autonomy?: unknown) => {
    const { parseConfig } = await import("../config")
    const p = paths({ HOME: tempDir("chrn-doc-m6-") })
    mkdirSync(p.stateDir, { recursive: true })
    if (autonomy) writeFileSync(p.autonomyState, JSON.stringify(autonomy))
    const config = parseConfig("[agents.a.limits]\nperTradeUsd = 1\nperDayUsd = 10\n[agents.b.limits]\nperTradeUsd = 10\nperDayUsd = 4\n", "config.toml").config
    return { p, config }
  }
  const inside = (wallet: string, name: string, perTradeUsd: number, perDayUsd: number) => ({ wallet, name, value: { setting: "inside", perTradeUsd, perDayUsd }, at: "2026-10-31T09:00:00Z", by: "view-1" })
  // Today's use without a card: an inside-limits approval counts, one that failed doesn't, a card's approval doesn't, nor yesterday's.
  const spendRows = () => [
    row("2026-10-30T17:00:00Z", "card.approved", { agent: "a", opId: "op-old", how: "inside-limits", wallet: EMB, usd: 1.2, side: "buy" }),
    row("2026-10-31T17:50:00Z", "card.approved", { agent: "a", opId: "op-1", how: "inside-limits", wallet: EMB, usd: 1.01, side: "buy" }),
    row("2026-10-31T17:51:00Z", "card.approved", { agent: "b", opId: "op-2", how: "inside-limits", wallet: EMB, usd: 1.4, side: "buy" }),
    row("2026-10-31T17:51:05Z", "operation.failed", { agent: "b", opId: "op-2" }),
    row("2026-10-31T17:52:00Z", "card.approved", { agent: "b", opId: "op-3", how: "enter", wallet: EMB, usd: 3, side: "buy" }),
  ]

  test("no wallet trades inside limits: one line, naming the wallets the agents pay from when they were read; Candle's loss limits named", async () => {
    const { approvalsChecks } = await import("./doctor")
    const { p, config } = await home()
    expect(approvalsChecks({ p, config, rows: [], now })).toEqual([
      { area: "wallet", state: "ok", text: "every wallet asks every time, so every live trade is a card, as by default. Trading inside limits is turned on wallet by wallet in the view's settings ▾ → approvals" },
      { area: "limits", state: "ok", text: LOSS },
    ])
    const reads = new Map([["a", { status: { embeddedWallet: "allowed" as const, wallets: { solana: EMB }, keyLimit: { usd: 10, reset: "daily" } }, tee: [{ address: TEE, label: "tee-one", chain: "solana" }] }]])
    expect(approvalsChecks({ p, config, rows: [], now, reads })[0]!.text).toStartWith("every wallet the agents pay from asks every time (the embedded wallet (Wall…1111), TEE wallet tee-one (TeeW…2222)), so every live trade is a card")
  })

  test("each wallet's setting and figures with today's use without a card, offline from state and the journal", async () => {
    const { approvalsChecks } = await import("./doctor")
    const { p, config } = await home({ wallets: [inside(EMB, "embedded", 1.5, 5), inside(OLD, "old-tee", 1, 2), { wallet: TEE, name: "tee-one", value: { setting: "ask" }, at: "2026-10-31T09:00:00Z", by: "card" }] })
    expect(approvalsChecks({ p, config, rows: spendRows(), now }).map((c) => [c.state, c.text])).toEqual([
      ["ok", "the embedded wallet (Wall…1111) trades inside limits: up to $1.50 a trade and $5.00 a day run without a card, $1.01 of it used today; every sell from it runs without one, unless its slippage is looser than the default"],
      ["ok", "TEE wallet old-tee (OldT…3333) trades inside limits: up to $1.00 a trade and $2.00 a day run without a card, $0.00 of it used today; every sell from it runs without one, unless its slippage is looser than the default"],
      ["ok", LOSS],
    ])
  })

  test("online: who pays, an agent's own limit that binds first, a key Candle doesn't cap, a wallet nobody pays from, and one that asks", async () => {
    const { approvalsChecks, CONSOLE_KEYS } = await import("./doctor")
    const { p, config } = await home({ wallets: [inside(EMB, "embedded", 1.5, 5), inside(OLD, "old-tee", 1, 2)] })
    const reads = new Map([
      ["a", { status: { embeddedWallet: "allowed" as const, wallets: { solana: EMB }, keyLimit: { usd: 10, reset: "daily" } }, tee: [{ address: TEE, label: "tee-one", chain: "solana" }] }],
      ["b", { status: { embeddedWallet: "allowed" as const, wallets: { solana: EMB } } }],
    ])
    const checks = approvalsChecks({ p, config, rows: spendRows(), now, reads })
    expect(checks.map((c) => [c.state, c.text])).toEqual([
      ["ok", "the embedded wallet (Wall…1111) trades inside limits, paid from by a and b: up to $1.50 a trade and $5.00 a day run without a card, $1.01 of it used today; every sell from it runs without one, unless its slippage is looser than the default"],
      ["warn", "a's own limit, $1.00 a trade, binds first on the embedded wallet (Wall…1111), whose figure is $1.50: a trade between the two is refused, not run without a card"],
      ["warn", "b's own limit, $4.00 a day, binds first on the embedded wallet (Wall…1111), whose figure is $5.00 a day without a card: b stops at its own"],
      ["warn", "Candle doesn't cap b's key, and b pays from the embedded wallet (Wall…1111), which trades inside limits: only the Candle Harness's limits hold for it, and nothing holds what the key does outside the Candle Harness"],
      ["ok", "TEE wallet old-tee (OldT…3333) was set to trade inside limits, but no agent pays from it now: the setting is kept, and applies to no other wallet"],
      ["ok", "TEE wallet tee-one (TeeW…2222) asks every time: each live trade from it is a card"],
      ["ok", LOSS],
    ])
    expect(checks[1]!.fix).toBe(`Lower the wallet's figure in the view's settings ▾ → approvals, or raise a's limits in ${p.configFile}.`)
    expect(checks[3]!.fix).toBe(`The owner sets a cap on the key in Candle's Agent Console, on its Agents tab (${CONSOLE_KEYS}), or makes a new key with one: \`candle keys create --access write --embedded-wallet allow --tx-limit <usd>\`.`)
  })

  test("a held key and when it lifts: Candle's cap until its reset, a stopped key for 5 minutes, sells included; a lifted hold says nothing", async () => {
    const { approvalsChecks } = await import("./doctor")
    const { p, config } = await home()
    const rows = [
      row("2026-10-31T09:00:00Z", "operation.failed", { agent: "b", opId: "op-x", error: { code: "KEY_LIMIT_REACHED", resetsAt: Date.parse("2026-10-31T17:00:00Z") } }),
      row("2026-10-31T17:30:00Z", "operation.failed", { agent: "a", opId: "op-y", error: { code: "KEY_LIMIT_REACHED", resetsAt: Date.parse("2026-11-01T00:00:00Z") } }),
      row("2026-10-31T17:58:00Z", "operation.failed", { agent: "b", opId: "op-z", error: { code: "RISK_LIMIT_REACHED" } }),
    ]
    const held = approvalsChecks({ p, config, rows, now }).filter((c) => c.area === "limits" && c.state === "warn")
    expect(held.map((c) => c.text)).toEqual([
      "b: Candle stopped its key (a loss limit or its circuit breaker), so the Candle Harness holds its trades, sells included, and asks Candle again from 18:03 UTC",
      "a: Candle's cap on its key is used up, so the Candle Harness holds its buys and swaps until 00:00 UTC, in 6h 00m; sells still go",
    ])
    expect(held[0]!.fix).toStartWith("Waiting won't clear it: the owner reviews the key and resumes it in Candle's Agent Console")
    expect(approvalsChecks({ p, config, rows, now: now + 10 * 60_000 }).filter((c) => c.state === "warn").map((c) => c.text)).toEqual([
      "a: Candle's cap on its key is used up, so the Candle Harness holds its buys and swaps until 00:00 UTC, in 5h 50m; sells still go",
    ])
  })

  test("the last session's end, by the core's rule, and the last gap from its kept summary", async () => {
    const { awayChecks } = await import("./doctor")
    const { p } = await home()
    expect(awayChecks(p, [], now, false).map((c) => c.text)).toEqual([
      "the main view hasn't closed yet, so there's no last session",
      "no gap yet: while you were away fills once the main view has been closed for 10 minutes or more and opened again",
    ])
    const rows = [
      row("2026-10-31T09:00:00Z", "core.started"),
      row("2026-10-31T09:01:00Z", "client.attached", { role: "view", clientId: "c1", clientName: "candle-harness view" }),
      row("2026-10-31T14:00:00Z", "client.detached", { clientId: "c1" }),
      row("2026-10-31T14:05:00Z", "core.stopped"),
    ]
    const from = Date.parse("2026-10-31T14:00:00Z")
    const to = Date.parse("2026-10-31T17:12:00Z")
    const counts = { turns: 1, trades: 3, withoutCard: 2, cards: 0, expired: 1, changes: 0, stopped: 1, outside: 0, maybe: 0, signals: 0, holdings: 0 }
    writeFileSync(p.awayState, JSON.stringify({ summary: { id: "s", from, to, madeAt: to, coreDown: [{ from: Date.parse("2026-10-31T14:05:00Z"), to: Date.parse("2026-10-31T16:00:00Z") }], coreGoneThroughout: false, counts, happened: true } }))
    expect(awayChecks(p, rows, now, false).map((c) => c.text)).toEqual([
      `the last session ended ${stamp(from)} (4 hours ago)`,
      `the last gap ran 3h 12m, from ${stamp(from)} to ${stamp(to)}: 3 trades (2 without a card), 1 turn, 1 stopped or refused; the core wasn't running from ${clock("2026-10-31T14:05:00Z")} to ${clock("2026-10-31T16:00:00Z")}. The palette's "while you were away" shows it`,
    ])
    // Two stretches: how many, and how long in all.
    const twice = [{ from: Date.parse("2026-10-31T14:05:00Z"), to: Date.parse("2026-10-31T15:00:00Z") }, { from: Date.parse("2026-10-31T15:10:00Z"), to: Date.parse("2026-10-31T17:00:00Z") }]
    writeFileSync(p.awayState, JSON.stringify({ summary: { id: "s", from, to, madeAt: to, coreDown: twice, coreGoneThroughout: false, counts, happened: true } }))
    expect(awayChecks(p, rows, now, false)[1]!.text).toContain("; the core wasn't running 2 times, 2h 45m in all. ")
    writeFileSync(p.awayState, JSON.stringify({ summary: { id: "s", from, to, madeAt: to, coreDown: [], coreGoneThroughout: true, counts: { ...counts, trades: 0, withoutCard: 0, turns: 0, stopped: 0 }, happened: false } }))
    expect(awayChecks(p, rows, now, false)[1]!.text).toEndWith(`: nothing happened; the core wasn't running. The palette's "while you were away" shows it`)
    // A core that died with the view open: that session ended at its last row.
    const died = [row("2026-10-31T09:00:00Z", "core.started"), row("2026-10-31T09:01:00Z", "client.attached", { role: "view", clientId: "c2", clientName: "candle-harness view" }), row("2026-10-31T15:30:00Z", "card.created")]
    expect(awayChecks(p, died, now, false)[0]!.text).toBe(`the last session ended ${stamp(Date.parse("2026-10-31T15:30:00Z"))} (3 hours ago)`)
  })

  test("the whole doctor: the setting offline, and online who pays and a key Candle doesn't cap", async () => {
    const { env, p } = await setup({ candle: { swing: { uncapped: true } } })
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(p.autonomyState, JSON.stringify({ wallets: [inside(EMB, "embedded", 1.5, 5)] }), { mode: 0o600 })
    const offline = await runDoctor({ env, online: false })
    expect(find(offline, "wallet", /trades inside limits/)?.text).toBe("the embedded wallet (Wall…1111) trades inside limits: up to $1.50 a trade and $5.00 a day run without a card, $0.00 of it used today; every sell from it runs without one, unless its slippage is looser than the default")
    expect(find(offline, "away", /^the main view/)).toBeDefined()
    expect(find(offline, "limits", /^Candle also has loss limits/)).toBeDefined()
    const online = await runDoctor({ env })
    expect(find(online, "wallet", /trades inside limits,/)?.text).toStartWith("the embedded wallet (Wall…1111) trades inside limits, paid from by momentum and swing:")
    expect(online.filter((c) => c.area === "wallet" && c.state === "warn" && /inside limits/.test(c.text)).map((c) => c.text)).toEqual([
      "Candle doesn't cap swing's key, and swing pays from the embedded wallet (Wall…1111), which trades inside limits: only the Candle Harness's limits hold for it, and nothing holds what the key does outside the Candle Harness",
    ])
  }, 60_000)
})

describe("wallet names", () => {
  test("wallets.toml's problems by line, a name left unused, and a Candle label taken by address only, each with its fix", async () => {
    const home = mkdtempSync("/tmp/chrn-doc-names-")
    const p = paths({ CANDLE_HARNESS_HOME: home })
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
    const EMB = "Embd3333333333333333333333333333333333333333"
    const TEE = "TeeA1111111111111111111111111111111111111111"
    writeFileSync(p.walletsFile, `[names]\n"${TEE}" = "mine"\n"oops" = "x"\n`)
    const read = { status: { wallets: { solana: EMB } }, tee: [{ id: "a", address: TEE, label: "embedded", chain: "solana", active: true }], portfolio: undefined }
    const checks = await nameChecks(p, { agents: { "agent-a": {} } } as never, new Map([["agent-a", read as never]]))
    expect(checks.map((c) => `${c.state}: ${c.text}`)).toEqual([
      "warn: wallets.toml line 3: \"oops\" isn't an address: each name is \"<address>\" = \"<name>\": the Candle Harness won't write wallets.toml until it's fixed",
      `warn: embedded (TeeA…1111) is taken by address only: "embedded" already means the account's embedded wallet`,
      `ok: wallets.toml names TeeA…1111 mine, but Candle calls it embedded, which wins`,
    ])
    expect(checks[1]!.fix).toBe(`Rename it: candle tee rename ${TEE} <new name>.`)
    rmSync(home, { recursive: true, force: true })
  })

  test("wallet groups: how many and what's in them, a group named like a wallet, and a listed wallet it can't find", async () => {
    const home = mkdtempSync("/tmp/chrn-doc-groups-")
    const p = paths({ CANDLE_HARNESS_HOME: home })
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
    const EMB = "Embd3333333333333333333333333333333333333333"
    const TEE = "TeeA1111111111111111111111111111111111111111"
    writeFileSync(p.walletsFile, `[groups.bots]\nprefix = "bot-"\n\n[groups.hot]\nwallets = ["bot-gone"]\n\n[groups.pair]\nwallets = ["bot-01", "embedded"]\n`)
    const read = { status: { wallets: { solana: EMB } }, tee: [{ id: "a", address: TEE, label: "bot-01", chain: "solana", active: true }, { id: "b", address: "TeeB1111111111111111111111111111111111111111", label: "hot", chain: "solana", active: true }], portfolio: undefined }
    const checks = await nameChecks(p, { agents: { "agent-a": {} } } as never, new Map([["agent-a", read as never]]))
    expect(checks.map((c) => `${c.state}: ${c.text}`)).toEqual([
      "warn: the group hot is named like a wallet (a wallet is called hot), so it's hard to tell apart from it",
      "warn: the group hot lists bot-gone, which isn't a wallet the Candle Harness knows (or two wallets share that name): it's kept, and shows nothing",
      "ok: 3 wallet groups: bots (1 wallet, names starting bot-), hot (0), pair (2)",
    ])
    expect(checks[0]!.fix).toBe(`Rename the group in ${p.walletsFile}, or the wallet.`)
    rmSync(home, { recursive: true, force: true })
  })
})

describe("onboarding and the CLI profile", () => {
  test("onboarding's state from its file alone: not run, unreadable, where it stopped, and finished", async () => {
    const home = mkdtempSync("/tmp/chrn-doc-onb-")
    dirs.push(home)
    const p = paths({ CANDLE_HARNESS_HOME: home })
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
    const text = async (hasAgents: boolean) => (await onboardingChecks(p, hasAgents)).map((c) => `${c.state}: ${c.text}`)
    expect(await text(false)).toEqual(["ok: onboarding hasn't started: `candle-harness` opens it"])
    expect(await text(true)).toEqual(["ok: onboarding wasn't run on this machine (the agents were added by hand); `candle-harness setup` runs it"])
    writeFileSync(p.onboarding, "{not json")
    expect((await onboardingChecks(p, true))[0]).toMatchObject({ state: "warn", text: expect.stringContaining("starts again from its welcome. Nothing it made is lost") })
    const state = { version: 1, startedAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:04:30.000Z", straightIn: false, passed: ["welcome", "engine", "limits"], engine: "claude-code", vaultChoice: "later", agent: { name: "agent-a", askedAt: "2026-11-01T09:03:00.000Z" } }
    writeFileSync(p.onboarding, JSON.stringify(state))
    const stopped = (await onboardingChecks(p, true))[0]!
    expect(stopped).toMatchObject({ state: "warn", fix: "Run `candle-harness` to finish it: until then it opens in place of the Candle Harness." })
    expect(stopped.text).toBe("onboarding started 2026-11-01 09:00 UTC and isn't finished (guided, the embedded wallet only for now, agent-a on Claude Code, past the limits; last changed 2026-11-01 09:04 UTC): `candle-harness` opens it where it stopped, and runs nothing twice")
    // With no agent yet, nothing is in the way: it's where the machine is.
    expect((await onboardingChecks(p, false))[0]!.state).toBe("ok")
    writeFileSync(p.onboarding, JSON.stringify({ ...state, straightIn: true, finishedAt: "2026-11-01T09:10:00.000Z" }))
    expect(await text(true)).toEqual(["ok: onboarding finished 2026-11-01 09:10 UTC (straight in, agent-a on Claude Code); `candle-harness setup` reopens it"])
  })

  test("the profile the Candle Harness acts as: none recorded, recorded and signed in, signed out, and one the CLI doesn't have", async () => {
    const line = (checks: Check[]) => checks.find((c) => c.area === "candle" && /profile/.test(c.text))!
    let { env } = await setup({ cliProfiles: ["default"] })
    expect(line(await runDoctor({ env, online: false }))).toMatchObject({ state: "ok", text: "config.toml names no candle.profile, so each candle run acts as the CLI's own pick (now default); `candle-harness setup` records one" })
    ;({ env } = await setup({ cliProfiles: ["default", "work"] }))
    expect(line(await runDoctor({ env, online: false }))).toMatchObject({ state: "warn", text: expect.stringContaining("several profiles with none selected (default, work)") })
    ;({ env } = await setup({ profile: "candle-harness", cliProfiles: ["default", "candle-harness"], signedProfiles: ["candle-harness"] }))
    expect(line(await runDoctor({ env, online: false }))).toMatchObject({ state: "ok", text: "the Candle Harness acts as the candle CLI's profile candle-harness (config.toml's candle.profile)" })
    expect(line(await runDoctor({ env }))).toMatchObject({ state: "ok", text: "the Candle Harness acts as the candle CLI's profile candle-harness (config.toml's candle.profile), signed in as Wall…9999" })
    const runs = readFileSync(join(env.CANDLE_CONFIG_DIR!, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(runs.find((r) => r.argv[0] === "auth")).toMatchObject({ argv: ["auth", "status", "--profile", "candle-harness", "--json"] })
    ;({ env } = await setup({ profile: "candle-harness", cliProfiles: ["candle-harness"], signedProfiles: [] }))
    expect(line(await runDoctor({ env }))).toMatchObject({ state: "fail", fix: "Run `candle auth login --profile candle-harness`, or `candle-harness setup`." })
    ;({ env } = await setup({ profile: "candle-harness", cliProfiles: ["default"] }))
    const checks = await runDoctor({ env, online: false })
    expect(line(checks)).toMatchObject({ state: "fail", text: "config.toml's candle.profile is candle-harness, which isn't one of the candle CLI's profiles (it has default), so every candle run the Candle Harness makes refuses" })
  })

  test("the recorded profile is the one whose RPC TEE trades read, not the CLI's active one", async () => {
    const TEE = { id: "teeid1", address: "TeeFake111111111111111111111111111111111111", label: "bot-wallet", boundKeyPrefix: "Momentum" }
    const { env } = await setup({ profile: "candle-harness", signedProfiles: ["candle-harness"], candle: { momentum: { teeWallets: [TEE], tier: "max" }, swing: { teeWallets: [TEE], tier: "max" } }, tee: { wallets: [TEE] } })
    writeFileSync(join(env.CANDLE_CONFIG_DIR!, "config.json"), JSON.stringify({ activeProfile: "default", profiles: { default: { rpcUrl: "https://active.example.test" }, "candle-harness": { rpcUrl: "https://recorded.example.test" } } }))
    const checks = await runDoctor({ env })
    expect(find(checks, "wallet", /TEE trades read the chain over/)!.text).toBe("TEE trades read the chain over recorded.example.test (the candle CLI's profile candle-harness)")
  })

  test("each TEE wallet's empty token accounts: counted, Candle not serving it, and the rest left to the core past three", async () => {
    const tee = (n: number) => ({ id: `tee${n}`, address: `TeeFake${n}`.padEnd(44, "1"), label: `bot-${n}`, boundKeyPrefix: "Momentum" })
    const wallets = [1, 2, 3, 4, 5].map(tee)
    const script = { teeWallets: wallets, tier: "max" as const }
    let { env } = await setup({ candle: { momentum: script, swing: { tier: "max" } }, tee: { wallets }, closeEmpty: { accounts: { [wallets[0]!.address]: 3 } } })
    let checks = await runDoctor({ env })
    const empty = checks.filter((c) => /empty token account/.test(c.text))
    expect(empty.map((c) => `${c.state}: ${c.text}`)).toEqual([
      "ok: TEE wallet bot-1 (TeeF…1111) has 3 empty token accounts · 0.00611284 SOL back (Candle's preview)",
      "ok: TEE wallet bot-2 (TeeF…1111) has no empty token accounts (Candle's preview)",
      "ok: TEE wallet bot-3 (TeeF…1111) has no empty token accounts (Candle's preview)",
      "skip: 2 more TEE wallets' empty token accounts weren't read, to spare the keys' Candle limit: the core counts them once it runs",
    ])
    expect(empty[0]!.fix).toContain("close chip")
    const runs = readFileSync(join(env.CANDLE_CONFIG_DIR!, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(runs.filter((r) => r.argv[1] === "close-empty" && r.argv.includes("--yes"))).toEqual([])
    ;({ env } = await setup({ candle: { momentum: { teeWallets: [wallets[0]!], tier: "max" }, swing: { tier: "max" } }, tee: { wallets: [wallets[0]!] }, closeEmpty: { off: true } }))
    checks = await runDoctor({ env })
    expect(find(checks, "wallet", /empty token accounts/)).toMatchObject({ state: "ok", text: "Candle doesn't serve closing empty token accounts here (CLOSE_EMPTY_DISABLED), so TEE wallet bot-1 (TeeF…1111)'s aren't counted" })
  })
})

describe("when Candle's day ends here", () => {
  const at = (tz: string, iso: string) => {
    const was = process.env.TZ
    process.env.TZ = tz
    try { return utcMidnightHere(new Date(iso)) } finally { process.env.TZ = was }
  }
  test("west of UTC, before its midnight, the end is this evening", () => {
    expect(at("America/New_York", "2026-11-04T23:52:00Z")).toBe("19:00 here")
  })
  test("west of UTC, just after its midnight, the end is tomorrow's evening, and says so", () => {
    expect(at("America/New_York", "2026-11-05T00:02:00Z")).toBe("19:00 here tomorrow")
  })
  test("east of UTC, the end is tomorrow morning until local midnight, then this morning", () => {
    expect(at("Asia/Tokyo", "2026-11-05T12:00:00Z")).toBe("09:00 here tomorrow")
    expect(at("Asia/Tokyo", "2026-11-05T16:00:00Z")).toBe("09:00 here")
  })
})
