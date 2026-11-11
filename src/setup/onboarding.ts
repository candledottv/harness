// Onboarding's state: the step reached, and what each step did, so a quit, a
// crash or a reboot picks up where it stopped with nothing done twice. Kept in state/onboarding.json
// (0600), written by the core only.
//
// What the file holds is only what can't be read back: the person's choices (straight in, the engine and
// model, a vault now or later, the agent's name) and the steps they went past that leave nothing behind
// (the welcome, the limits, the approvals, the tour). Everything else is read back from where it lives,
// every time, and never taken from the file:
//   - the sign-in: `candle auth status --json` as the profile config.toml records, and,
//     until one is recorded, `candle profile list --json` (names, accounts and hosts; never a key), so the
//     person picks one or signs in a new one. Onboarding never opens the CLI's profile files itself;
//   - the vault: `candle vault status --json`, with no unlock;
//   - the agent's key: the Candle Harness's own key file, and the owner's `candle keys list --json`. A key labelled as
//     the agent, made since it was asked for and held by no key file, is a key made but not stored: its
//     revoke is offered, and nothing makes another;
//   - the wallet: what the agent may pay from, from Candle's reads with its own key.
// Onboarding never reads the keychain, another CLI profile's files, an env file or a harness's sign-in
// its readers are the four above, and the tests plant all of those to check.
import { randomBytes } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { ENGINE_IDS, type EngineId } from "../engine/engine"
import { isAddressShaped } from "../core/wallet-names"
import { isProfileName } from "../config"
import { isAgentName } from "../paths"
import type { ProfileRow } from "./candle-profile"

/** The steps, in order. Steps 0 to 5: welcome; sign in; your agent; vault, key, wallet, limits, approvals and funds; the tour; where to start. */
export const ONBOARDING_STEPS = ["welcome", "signIn", "engine", "vault", "key", "wallet", "limits", "approvals", "fund", "tour", "start"] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** The steps that leave nothing to read back: done when the person went past them. */
const PASSED_ONLY: ReadonlySet<OnboardingStep> = new Set(["welcome", "engine", "limits", "approvals", "fund", "tour", "start"])
/**
 * Straight in: sign in, the model and its test message, the key, then the Candle Harness: live on a fresh install, else
 * in the mode it was in.
 * The other steps are skipped, not done: there's no vault, and a trade is refused until the key is allowed a
 * wallet and it holds funds, each refusal saying how.
 */
const STRAIGHT_IN: ReadonlySet<OnboardingStep> = new Set(["signIn", "engine", "key"])

export interface OnboardingState {
  version: 1
  startedAt: string
  updatedAt: string
  straightIn: boolean
  /** Steps the person went past that leave nothing behind (PASSED_ONLY). */
  passed: OnboardingStep[]
  /** Chosen in step 2 and kept until the agent exists (no agent before step 3). */
  engine?: EngineId
  model?: string
  /**
   * Step 2's test message: the engine and model it answered on. Going past step 2 needs
   * one on the engine and model chosen, so a changed choice is tested again.
   */
  tested?: { engine: EngineId; model?: string; at: string }
  /** A vault now, or the embedded wallet only for now. */
  vaultChoice?: "now" | "later"
  /** The agent's name, and when its key was asked for: a key made but not stored is found by both. */
  agent?: { name: string; askedAt: string }
  /**
   * When setup reached its end: every step done or skipped. Until then, a machine with agents
   * still opens onboarding, so a quit after the key was made picks up at its wallet, not in the Candle Harness.
   */
  finishedAt?: string
}

/** What onboarding read back, each from where it lives. */
export interface OnboardingFacts {
  /** `auth status`, as the Candle Harness's profile, or the CLI's own pick while none is recorded: `profile` is the one it answered as. */
  signIn: { state: "signed-in"; account?: string; profile?: string } | { state: "signed-out"; code?: string } | { state: "unreadable"; said?: string }
  /** The profile the Candle Harness acts as, recorded in config.toml; undefined until the person picks. */
  profile?: string
  /** The machine's profiles, read only while none is recorded: so the person can pick one, or sign in a new one. */
  profiles?: ProfileRow[]
  vault: "present" | "missing" | "unreadable"
  key: { state: "stored"; prefix: string } | { state: "made-not-stored"; prefixes: string[] } | { state: "none" } | { state: "unreadable" }
  /**
   * What the agent may pay from, read with its own key: the first one (the embedded wallet first) for the fund
   * step, with its name; or none, with whether Candle denies its key the embedded wallet.
   */
  wallet: { state: "payable"; count: number; address?: string; kind?: "embedded" | "tee"; name?: string } | { state: "none"; embedded?: "denied" } | { state: "unknown" }
  /** The account's plan, from the agent's status read: a wallet of its own needs Pro or Max. */
  plan?: string
  /** The one vault key a fresh TEE wallet is promoted from (the chips' route); none, or several, leaves it out. */
  vaultKey?: string
  /** Candle's code when the last `keys create` made no key (such as `AGENT_WALLET_NOT_DELEGATED` on a new account). */
  keyRefused?: string
  /**
   * Setup ends on paper: the person picked paper before this run (the status bar, or an older install's config.toml),
   * and a run of setup keeps the mode it finds. Without it, setup ends live.
   */
  keepsPaper?: true
}

export interface StepProgress {
  id: OnboardingStep
  state: "done" | "skipped" | "todo"
  /** For the key's step: a key made but not stored, offered for revoking as a typed line. */
  revoke?: { prefix: string; line: string }[]
}

export interface OnboardingView {
  state: OnboardingState
  facts: OnboardingFacts
  steps: StepProgress[]
  /** The first step still to do, or "done". */
  at: OnboardingStep | "done"
}

/** Each step's progress from the person's choices and what was read back. A step done is shown done, never run again. */
export function onboardingProgress(state: OnboardingState, facts: OnboardingFacts): OnboardingView {
  const passed = new Set(state.passed)
  const steps = ONBOARDING_STEPS.map((id): StepProgress => {
    if (state.straightIn && !STRAIGHT_IN.has(id)) return { id, state: "skipped" }
    switch (id) {
      case "signIn":
        // Signed in, as the profile the Candle Harness records: the CLI's own pick isn't enough.
        return { id, state: facts.signIn.state === "signed-in" && facts.profile !== undefined && facts.signIn.profile === facts.profile ? "done" : "todo" }
      case "engine":
        return { id, state: passed.has(id) && state.engine !== undefined && testedOn(state) ? "done" : "todo" }
      case "vault":
        if (facts.vault === "present") return { id, state: "done" }
        return { id, state: state.vaultChoice === "later" ? "skipped" : "todo" }
      case "key":
        if (facts.key.state === "stored") return { id, state: "done" }
        if (facts.key.state === "made-not-stored") return { id, state: "todo", revoke: facts.key.prefixes.map((prefix) => ({ prefix, line: `candle keys revoke ${prefix}` })) }
        return { id, state: "todo" }
      case "wallet":
        return { id, state: facts.wallet.state === "payable" ? "done" : "todo" }
      default:
        return { id, state: PASSED_ONLY.has(id) && passed.has(id) ? "done" : "todo" }
    }
  })
  const next = steps.find((s) => s.state === "todo")
  return { state, facts, steps, at: next?.id ?? "done" }
}

/** Whether step 2's test message answered on the engine and model chosen now. */
export const testedOn = (state: OnboardingState): boolean => state.tested !== undefined && state.engine === state.tested.engine && state.model === state.tested.model

/** `candle auth status --json`, as the sign-in's step reads it: signed in once the device token passes. Only the account is kept. */
export function signInFrom(run: { exitCode: number; json: unknown; stderr?: string } | undefined): OnboardingFacts["signIn"] {
  const body = run?.json as Record<string, unknown> | undefined
  if (!run || body === undefined || body === null || typeof body !== "object") {
    // What the CLI said instead, so setup can say why (such as "No keychain available and no CANDLE_KEYRING_PASSPHRASE set").
    const said = cliSaid(run?.stderr)
    return { state: "unreadable", ...(said ? { said } : {}) }
  }
  const rows = Array.isArray(body.rows) ? (body.rows as { check?: unknown; state?: unknown }[]) : []
  const device = rows.find((r) => r?.check === "Device token")
  // `auth status` exits 1 when any check fails, the CLI's own API key's included (a revoked working key
  // read as "not signed in"). Signed in is the device token's check alone, when there is one.
  if (run.exitCode !== 0 && !device) return { state: "signed-out", ...(typeof body.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code) ? { code: body.code } : {}) }
  const signedIn = device ? device.state === "PASS" : typeof body.deviceTokenPrefix === "string" || body.signedIn === true
  if (!signedIn) return { state: "signed-out" }
  const account = typeof body.account === "string" && isAddressShaped(body.account) ? body.account : undefined
  const profile = isProfileName(body.profile) ? body.profile : undefined
  return { state: "signed-in", ...(account ? { account } : {}), ...(profile ? { profile } : {}) }
}

/** The CLI's first line on stderr, as words for the screen: no control characters, a key cut to its start, kept short. */
export function cliSaid(stderr: string | undefined): string | undefined {
  const line = (stderr ?? "").split("\n").map((l) => l.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]+/g, " ").trim()).find(Boolean)
  if (!line) return undefined
  const words = line.replace(/^Unexpected error:\s*/, "").replace(/cndl_[A-Za-z0-9_-]+/g, "cndl_…")
  return words.length > 300 ? `${words.slice(0, 299)}…` : words
}

/**
 * The agent's key: stored when the Candle Harness's own key file holds one; else, from the owner's key list, a key
 * labelled as the agent, made since it was asked for (a minute's slack for clocks), not revoked and held
 * by no agent here. The rule for `keys create`, read again on resume.
 */
export function keyFrom(input: { agent?: { name: string; askedAt: string }; storedPrefix?: string; heldPrefixes: ReadonlySet<string>; keysList: { exitCode: number; json: unknown } | undefined }): OnboardingFacts["key"] {
  if (input.storedPrefix) return { state: "stored", prefix: input.storedPrefix }
  if (!input.agent) return { state: "none" }
  if (!input.keysList || input.keysList.exitCode !== 0) return { state: "unreadable" }
  const rows = (input.keysList.json as { keys?: unknown } | undefined)?.keys
  if (!Array.isArray(rows)) return { state: "unreadable" }
  const asked = Date.parse(input.agent.askedAt)
  const ms = (t: unknown) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : typeof t === "string" ? Date.parse(t) : Number.NaN)
  const prefixes = (rows as { keyPrefix?: unknown; label?: unknown; createdAt?: unknown; revokedAt?: unknown }[])
    .filter((k) => typeof k.keyPrefix === "string" && /^[A-Za-z0-9_-]{8}$/.test(k.keyPrefix) && !input.heldPrefixes.has(k.keyPrefix) && k.revokedAt == null && k.label === input.agent!.name && ms(k.createdAt) >= asked - 60_000)
    .map((k) => k.keyPrefix as string)
  return prefixes.length ? { state: "made-not-stored", prefixes } : { state: "none" }
}

/** What a view may set: a choice, or a step gone past. Anything else is refused with why. */
export type OnboardingChange =
  | { straightIn: boolean }
  | { passed: OnboardingStep }
  | { engine: EngineId; model?: string }
  | { vaultChoice: "now" | "later" }
  | { agent: string }
  | { profile: string }
  | { back: true }

export function changeFrom(params: Record<string, unknown>): OnboardingChange | { problem: string } {
  const keys = Object.keys(params)
  if (keys.length === 0) return { problem: "Name one change." }
  if (typeof params.straightIn === "boolean" && keys.length === 1) return { straightIn: params.straightIn }
  if (params.back === true && keys.length === 1) return { back: true }
  if (typeof params.passed === "string" && keys.length === 1) {
    return PASSED_ONLY.has(params.passed as OnboardingStep) ? { passed: params.passed as OnboardingStep } : { problem: `${params.passed} is done when it's read back, not when it's passed.` }
  }
  if (typeof params.engine === "string" && keys.every((k) => k === "engine" || k === "model")) {
    if (!(ENGINE_IDS as readonly string[]).includes(params.engine)) return { problem: `There's no engine named ${JSON.stringify(params.engine)}.` }
    if (params.model !== undefined && (typeof params.model !== "string" || !/^[^\x00-\x1f\x7f]{1,200}$/.test(params.model))) return { problem: "A model is its name as the engine lists it." }
    return { engine: params.engine as EngineId, ...(typeof params.model === "string" ? { model: params.model } : {}) }
  }
  if ((params.vaultChoice === "now" || params.vaultChoice === "later") && keys.length === 1) return { vaultChoice: params.vaultChoice }
  if (typeof params.profile === "string" && keys.length === 1) return isProfileName(params.profile) ? { profile: params.profile } : { problem: `"${String(params.profile).slice(0, 40)}" isn't a CLI profile's name.` }
  if (typeof params.agent === "string" && keys.length === 1) return isAgentName(params.agent) ? { agent: params.agent } : { problem: `"${params.agent.slice(0, 40)}" can't be an agent's name: use 1 to 32 lower-case letters, digits, "-" or "_".` }
  return { problem: "One of straightIn, passed, engine (and model), vaultChoice, profile, agent or back." }
}

/** What each step is called when going back can't undo it. */
const DONE_ON_CANDLE: Partial<Record<OnboardingStep, string>> = { signIn: "Signing in to Candle", vault: "The vault", key: "The agent's key", wallet: "The wallet" }

/**
 * Esc in setup (a stray click can go past a step, which needs a way back): the step before this one
 * is shown again, when it was a choice. A step done on Candle or on this machine (the sign-in, the vault, the key,
 * the wallet's allow) is read back, so going back past it would only show it done: it's said instead, and nothing
 * changes. Steps straight in skipped are stepped over.
 */
export function stepBack(view: OnboardingView, now: number): { state: OnboardingState } | { problem: string } {
  const { state, steps } = view
  const here = view.at === "done" ? steps.length : steps.findIndex((s) => s.id === view.at)
  const at = new Date(now).toISOString()
  for (let i = here - 1; i >= 0; i--) {
    const step = steps[i]!
    if (step.state === "skipped" && !(step.id === "vault" && state.vaultChoice === "later")) continue
    if (step.id === "vault" && state.vaultChoice === "later") {
      const { vaultChoice: _gone, ...rest } = state
      return { state: { ...rest, updatedAt: at } }
    }
    if (PASSED_ONLY.has(step.id) && state.passed.includes(step.id)) return { state: { ...state, passed: state.passed.filter((p) => p !== step.id), updatedAt: at } }
    const what = DONE_ON_CANDLE[step.id]
    if (what) return { problem: `${what} is done, and going back doesn't undo it. Carry on from here.` }
  }
  return { problem: "This is the first step." }
}

export function applyChange(state: OnboardingState, change: Exclude<OnboardingChange, { back: true }>, now: number): OnboardingState {
  const at = new Date(now).toISOString()
  if ("straightIn" in change) return { ...state, straightIn: change.straightIn, updatedAt: at }
  if ("passed" in change) return { ...state, passed: state.passed.includes(change.passed) ? state.passed : [...state.passed, change.passed], updatedAt: at }
  // The profile lives in config.toml (the core records it there); the file keeps no copy to go stale.
  if ("profile" in change) return { ...state, updatedAt: at }
  if ("engine" in change) {
    const { model: _old, ...rest } = state
    return { ...rest, engine: change.engine, ...(change.model ? { model: change.model } : {}), updatedAt: at }
  }
  if ("vaultChoice" in change) return { ...state, vaultChoice: change.vaultChoice, updatedAt: at }
  // A name asked for again keeps its first time, so a key made under it since then is still found.
  return { ...state, agent: state.agent?.name === change.agent ? state.agent : { name: change.agent, askedAt: at }, updatedAt: at }
}

export function freshState(now: number, straightIn = false): OnboardingState {
  const at = new Date(now).toISOString()
  return { version: 1, startedAt: at, updatedAt: at, straightIn, passed: [] }
}

/** The file, read whole or not at all: anything it doesn't recognise is dropped, never trusted. */
export function parseState(text: string): OnboardingState | undefined {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (raw?.version !== 1 || typeof raw.startedAt !== "string" || typeof raw.updatedAt !== "string") return undefined
  const passed = Array.isArray(raw.passed) ? (raw.passed as unknown[]).filter((p): p is OnboardingStep => typeof p === "string" && PASSED_ONLY.has(p as OnboardingStep)) : []
  const agent = raw.agent as { name?: unknown; askedAt?: unknown } | undefined
  return {
    version: 1,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    straightIn: raw.straightIn === true,
    passed: [...new Set(passed)],
    ...(typeof raw.engine === "string" && (ENGINE_IDS as readonly string[]).includes(raw.engine) ? { engine: raw.engine as EngineId } : {}),
    ...(typeof raw.model === "string" && raw.model.length <= 200 ? { model: raw.model } : {}),
    ...testedFrom(raw.tested),
    ...(raw.vaultChoice === "now" || raw.vaultChoice === "later" ? { vaultChoice: raw.vaultChoice } : {}),
    ...(typeof agent?.name === "string" && isAgentName(agent.name) && typeof agent.askedAt === "string" && !Number.isNaN(Date.parse(agent.askedAt)) ? { agent: { name: agent.name, askedAt: agent.askedAt } } : {}),
    ...(typeof raw.finishedAt === "string" && !Number.isNaN(Date.parse(raw.finishedAt)) ? { finishedAt: raw.finishedAt } : {}),
  }
}

function testedFrom(raw: unknown): { tested?: OnboardingState["tested"] } {
  const t = raw as { engine?: unknown; model?: unknown; at?: unknown } | undefined
  if (!t || typeof t !== "object" || typeof t.engine !== "string" || !(ENGINE_IDS as readonly string[]).includes(t.engine) || typeof t.at !== "string" || Number.isNaN(Date.parse(t.at))) return {}
  if (t.model !== undefined && (typeof t.model !== "string" || t.model.length > 200)) return {}
  return { tested: { engine: t.engine as EngineId, ...(typeof t.model === "string" ? { model: t.model } : {}), at: t.at } }
}

/** Step 2's test message answered: kept with the engine and model it ran on. */
export function withTested(state: OnboardingState, engine: EngineId, model: string | undefined, now: number): OnboardingState {
  const at = new Date(now).toISOString()
  return { ...state, tested: { engine, ...(model ? { model } : {}), at }, updatedAt: at }
}

/** Setup's end, marked once: the view the core read has nothing left to do. */
export function withFinished(state: OnboardingState, view: Pick<OnboardingView, "at">, now: number): OnboardingState | undefined {
  if (view.at !== "done" || state.finishedAt !== undefined) return undefined
  const at = new Date(now).toISOString()
  return { ...state, finishedAt: at, updatedAt: at }
}

/** Whether a machine with agents still opens onboarding: a run that started and hasn't reached its end. */
export const unfinished = (state: OnboardingState | undefined): boolean => state !== undefined && state.finishedAt === undefined

/** The first agent name onboarding offers: agent-a, then agent-b and on, one no agent here has. */
export function freeAgentName(taken: ReadonlySet<string>): string {
  for (const letter of "abcdefghijklmnopqrstuvwxyz") if (!taken.has(`agent-${letter}`)) return `agent-${letter}`
  for (let n = 2; ; n++) if (!taken.has(`agent-${n}`)) return `agent-${n}`
}

/** state/onboarding.json, written whole (a temporary file renamed over it), 0600. */
export class OnboardingStore {
  constructor(private readonly deps: { file: string; now: () => number }) {}

  async read(): Promise<OnboardingState | undefined> {
    try {
      return parseState(await readFile(this.deps.file, "utf8"))
    } catch {
      return undefined
    }
  }

  /** The state, started fresh when there's none. */
  async open(opts: { straightIn?: boolean } = {}): Promise<OnboardingState> {
    const held = await this.read()
    if (held) return held
    const fresh = freshState(this.deps.now(), opts.straightIn)
    await this.write(fresh)
    return fresh
  }

  async write(state: OnboardingState): Promise<void> {
    const temp = `${this.deps.file}.tmp-${randomBytes(6).toString("base64url")}`
    await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.deps.file)
  }
}
