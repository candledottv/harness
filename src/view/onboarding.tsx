// Onboarding's screen: full screen, a Setup rail on the left with every step as the core read it back (✓ done,
// ▸ now, · to do, – skipped), and the step in a focused pane on the right. At 80×24 the rail folds to one line
// under the bar. The prompt pane, for Candle's device code or a harness's own sign-in, opens inside the step.
//
// It draws steps 0 to 2: the welcome, the Candle sign-in and connecting your agent. Then step 3's six parts: a
// vault or not, the agent's key with Candle's cap on the create, the wallet it pays from, its limits with who
// holds each, the approvals menu on "ask every time", and a deposit or paper. And step 5, where to start: Trade
// or Cockpit as the tab the Candle Harness opens on, with the files that hold the rest. Step 4, the tour, isn't drawn
// here: it runs over the real screen (tour.tsx).
//
// Pure where it can be: `stepRows` builds the step's rows from what the core said, and the component draws them.
// A choice is a menu row in the control colour, picked by ↑/↓ and ⏎ or a click; anything else clickable is a chip.
import type { EngineId, EngineModel } from "../engine/engine"
import { ENGINE_IDS } from "../engine/engine"
import type { AutonomyTopic } from "../core/autonomy"
import type { PortfolioView } from "../core/portfolio-view"
import { freeAgentName, type OnboardingStep, type OnboardingView, testedOn } from "../setup/onboarding"
import { isAgentName } from "../paths"
import { bindsFirst, dayCapsFirst, limitRows, parseFigure, walletWords, type AgentLimits } from "./approvals"
import { HARNESS_SIGN_INS, INSTALL_LINES } from "../setup/harness-signin"
import { Chip, usePointer } from "./chip"
import { shortAddress, wrap } from "./format"
import type { EngineTopic } from "./panes/engines"
import { canRun } from "./panes/engines"
import { C, fit } from "./theme"

/** The steps this screen draws; the tour runs over the real screen instead. */
/** Where a new account authorizes its embedded wallet for agents (Candle's docs, "Agent access & API keys"). */
export const AGENT_CONSOLE = "https://alpha.candle.tv/agents?tab=keys"

export const SCREEN_STEPS: ReadonlySet<OnboardingStep | "done"> = new Set(["welcome", "signIn", "engine", "vault", "key", "wallet", "limits", "approvals", "fund", "start"])

/** What the person types on step 3: the agent's name, Candle's cap, the wallet's name, the Candle Harness's limits, and a wallet's two figures. */
export type FieldId = "agentName" | "cap" | "walletName" | "perTrade" | "perDay" | "autoTrade" | "autoDay"

/** What a field takes as it's typed: an agent's name its own characters, a figure digits and a point, a name anything printable. */
export function fieldTakes(id: FieldId, value: string, ch: string): string | undefined {
  if (ch.length !== 1 || ch < " " || ch === "\x7f") return undefined
  if (id === "agentName") return value.length < 32 && /[a-z0-9_-]/.test(ch) ? value + ch : undefined
  if (id === "walletName") return value.length < 64 ? value + ch : undefined
  return value.length < 10 && /[0-9.,]/.test(ch) ? value + ch : undefined
}

/** What a choice does when it's picked. */
export type ObAction =
  | { kind: "welcome"; straightIn: boolean }
  | { kind: "useProfile"; profile: string }
  | { kind: "signIn" }
  | { kind: "reread" }
  | { kind: "engine"; engine: EngineId; model?: string }
  | { kind: "harness"; engine: EngineId }
  | { kind: "copy"; text: string; what: string }
  | { kind: "test" }
  | { kind: "continue"; step?: OnboardingStep }
  | { kind: "back" }
  | { kind: "stepBack" }
  | { kind: "field"; id: FieldId }
  | { kind: "vault"; now: boolean }
  | { kind: "securityKey" }
  | { kind: "makeKey" }
  | { kind: "revoke"; prefix: string }
  | { kind: "allowEmbedded" }
  | { kind: "ownWallet" }
  | { kind: "keepLimits" }
  | { kind: "inside"; on: boolean }
  | { kind: "approvals" }
  | { kind: "paper" }
  /** Step 5: the tab the Candle Harness opens on, by its name, then the Candle Harness. */
  | { kind: "start"; tab: string }

type Run = [text: string, fg: string]
export type ObRow =
  | { kind: "text"; runs: Run[] }
  | { kind: "item"; item: number; runs: Run[]; right?: Run }
  | { kind: "chips"; lead?: Run[]; chips: { label: string; action: ObAction }[] }
  /** A typed figure or name: its lead, a box with what's typed (a caret while it's the highlighted one), then a hint. */
  | { kind: "field"; item: number; lead: Run[]; value: string; dollars?: boolean; width: number; after?: Run }

export interface ObItem {
  action: ObAction
}

/** What the screen holds between the core's answers: the highlight, a step running, the test's answer, a code the pane showed. */
export interface ObLocal {
  sel: number
  busy?: string
  said?: { text: string; level: "info" | "error" }
  test?: { ok: true; engine: EngineId; model?: string; reply: string; ms: number } | { ok: false; words: string }
  /** A device code and its link, read from the open pane's screen, for the ⧉ chips. */
  code?: { code?: string; url?: string }
  /** What the open pane is signing in: Candle, or a harness, for the line under it. */
  paneFor?: "candle" | EngineId
  /** OpenCode's or Pi's sign-in, said first (a subscription there is held back): what to pick there, before the pane opens. */
  before?: EngineId
  /** The engine whose models are listed, and the list, read with engine.models. */
  models?: { engine: EngineId; list: EngineModel[] }
  /** Step 3's typed fields, each until it's used; a field left untouched shows its default. */
  fields?: Partial<Record<FieldId, string>>
  /** The approvals step's "trade inside limits", picked: its two figures show. */
  inside?: boolean
  /** An owner step open in the pane (step 3): the line over it and what the line under it waits for. */
  paneWords?: { line: string; wait: string }
  /** A row the highlight is held on as rows come and go (a model list landing), until a key is pressed. */
  hold?: "test"
}

/** What step 3 reads besides onboarding's own view: the agents' limits, each wallet's setting, the wallets' balances. */
export interface ObContext {
  agents?: readonly AgentLimits[]
  autonomy?: AutonomyTopic
  portfolio?: PortfolioView
  /** Step 5's: the tabs shown, how many there are in all, and the files that hold the rest, as the person would type them. */
  start?: { tabs: readonly string[]; total: number; files: readonly string[] }
}

/** A field's value: what's typed, else its default. */
export function fieldValue(local: ObLocal, id: FieldId, fallback: string): string {
  return local.fields?.[id] ?? fallback
}

/** The agent onboarding makes: the name asked for, else the first free one. */
export function agentNameOf(view: OnboardingView, local: ObLocal, ctx: ObContext): string {
  return fieldValue(local, "agentName", view.state.agent?.name ?? freeAgentName(new Set((ctx.agents ?? []).map((a) => a.name))))
}

/**
 * `keys create` as the key step runs it, with Candle's cap on the create itself when one is typed: a day's, as
 * the CLI defaults. Weekly or monthly is `keys limit` later, from the approvals menu.
 */
export function keyArgv(name: string, cap: string): { argv: string[] } | { problem: string } {
  if (!isAgentName(name)) return { problem: `"${name}" can't be an agent's name: use 1 to 32 lower-case letters, digits, "-" or "_".` }
  if (cap.trim() === "") return { argv: ["keys", "create", "--label", name] }
  const figure = parseFigure(cap)
  if (!figure.ok) return { problem: `Candle's cap: ${figure.why}` }
  return { argv: ["keys", "create", "--label", name, "--tx-limit", String(figure.usd), "--reset", "daily"] }
}

/** The first wallet the agent pays from, with its SOL, for the fund step. */
export function fundWallet(view: OnboardingView, ctx: ObContext): { address: string; name: string; sol?: number } | undefined {
  const w = view.facts.wallet
  if (w.state !== "payable" || !w.address) return undefined
  const held = ctx.portfolio?.wallets.find((x) => x.address === w.address)
  return { address: w.address, name: held?.name ?? w.name ?? (w.kind === "embedded" ? "embedded" : shortAddress(w.address)), ...(held?.sol ? { sol: held.sol.amount } : {}) }
}

const RAIL_W = 28
const RAIL: { id: OnboardingStep; label: string; subs?: { id: OnboardingStep; label: string }[] }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "signIn", label: "Sign in to Candle" },
  { id: "engine", label: "Connect your agent" },
  {
    id: "vault",
    label: "Wallet and limits",
    subs: [
      { id: "vault", label: "a vault, or not" },
      { id: "key", label: "its key" },
      { id: "wallet", label: "its wallet" },
      { id: "limits", label: "limits" },
      { id: "approvals", label: "approvals" },
      { id: "fund", label: "fund it, or paper" },
    ],
  },
  { id: "tour", label: "The tour" },
  { id: "start", label: "Where to start" },
]

type Mark = "done" | "now" | "todo" | "skipped"
function markOf(view: OnboardingView | undefined, ids: OnboardingStep[]): Mark {
  if (!view) return "todo"
  if (view.at !== "done" && ids.includes(view.at)) return "now"
  const states = ids.map((id) => view.steps.find((s) => s.id === id)?.state ?? "todo")
  if (states.every((s) => s === "skipped")) return "skipped"
  return states.every((s) => s !== "todo") ? "done" : "todo"
}
const MARK: Record<Mark, Run> = { done: ["✓", C.good], now: ["▸", C.focus], todo: ["·", C.dim], skipped: ["–", C.dim] }

/** The rail's lines: each step with its mark, the account under a done sign-in, and step 3's parts while it's the one. */
export function railRows(view: OnboardingView | undefined): Run[][] {
  const out: Run[][] = []
  RAIL.forEach((step, i) => {
    const ids = step.subs ? step.subs.map((s) => s.id) : [step.id]
    const mark = markOf(view, ids)
    out.push([MARK[mark], [" ", C.ink], [step.label, mark === "now" ? C.hi : mark === "done" ? C.ink : C.dim], ...(mark === "skipped" ? ([[" skipped", C.dim]] as Run[]) : [])])
    if (step.id === "signIn" && mark === "done" && view?.facts.profile) {
      const account = view.facts.signIn.state === "signed-in" && view.facts.signIn.account ? `${shortAddress(view.facts.signIn.account)} · ` : ""
      out.push([["  ", C.ink], [`${account}${view.facts.profile}`, C.dim]])
    }
    if (step.subs && mark === "now") for (const sub of step.subs) out.push([["  ", C.ink], MARK[markOf(view, [sub.id])], [" ", C.ink], [sub.label, markOf(view, [sub.id]) === "now" ? C.hi : C.dim]])
    if (i < RAIL.length - 1) out.push([])
  })
  return out
}

/** The step number each screen shows in the box's corner, of the five on the rail. */
const NUMBER: Partial<Record<OnboardingStep, number>> = { signIn: 1, engine: 2, vault: 3, key: 3, wallet: 3, limits: 3, approvals: 3, fund: 3, tour: 4, start: 5 }

/** Where a step's Continue goes, said on its row. */
const NEXT_STEP = { engine: "step 3: your agent's key, wallet and limits", approvals: "funds", fund: "the tour" } as const

/** A step's main control: its label, then where ⏎ goes, in the colour read rather than the hints'. */
const continueRuns = (next: string, label = "Continue"): Run[] => [[label, C.ctl], [`      ⏎ continues to ${next}`, C.ink]]

/** One choice: a menu row, highlighted when it's the one ⏎ picks. */
function itemRow(items: ObItem[], action: ObAction, runs: Run[], right?: Run): ObRow {
  items.push({ action })
  return { kind: "item", item: items.length - 1, runs, ...(right ? { right } : {}) }
}

const text = (t: string, fg: string = C.ink): ObRow => ({ kind: "text", runs: [[t, fg]] })
const gap = (): ObRow => ({ kind: "text", runs: [] })
const para = (t: string, width: number, fg: string = C.ink): ObRow[] => wrap(t, width).map((l) => text(l, fg))

/** A typed field: a choice too, so ↑/↓ reach it and typing goes into it while it's highlighted. */
function fieldRow(items: ObItem[], id: FieldId, lead: Run[], value: string, opts: { dollars?: boolean; width?: number; after?: Run } = {}): ObRow {
  items.push({ action: { kind: "field", id } })
  return { kind: "field", item: items.length - 1, lead, value, width: opts.width ?? 8, ...(opts.dollars ? { dollars: true } : {}), ...(opts.after ? { after: opts.after } : {}) }
}

/** A step's rows and choices, from what the core read back and the screen's own state. */
export function stepRows(input: { view: OnboardingView; engine?: EngineTopic; local: ObLocal; width: number; paneOpen: boolean; ctx?: ObContext }): { rows: ObRow[]; items: ObItem[] } {
  const { view, local, width } = input
  const ctx = input.ctx ?? {}
  const rows: ObRow[] = []
  const items: ObItem[] = []
  const said = () => {
    if (local.busy) rows.push(gap(), { kind: "text", runs: [["⠋ ", C.look], [local.busy, C.ink]] })
    if (local.said) rows.push(gap(), ...para(local.said.text, width, local.said.level === "error" ? C.bad : C.dim))
  }
  switch (view.at) {
    case "welcome": {
      rows.push(text("Welcome to Candle", C.head), gap())
      rows.push(...para("A trading terminal where your own agent works beside you: Candle's feed, signals, positions and P&L, and an agent that proposes the trades you approve.", width), gap())
      rows.push(text("Setup takes about 3 minutes:"), gap())
      for (const [n, t] of [
        ["1", "Sign in to Candle"],
        ["2", "Connect your agent, and test it"],
        ["3", "A vault or not, its key, wallet, limits and approvals"],
        ["4", "A 60-second tour"],
        ["5", "Where to start"],
      ] as const)
        rows.push({ kind: "text", runs: [[`  ${n}  `, C.dim], [t, C.ink]] })
      rows.push(gap())
      rows.push(itemRow(items, { kind: "welcome", straightIn: false }, [["Guided setup", C.ctl]], ["every step, about 3 minutes", C.dim]))
      rows.push(itemRow(items, { kind: "welcome", straightIn: true }, [["Straight in", C.ctl]], ["sign in, your model and its key, then the Candle Harness on paper", C.dim]))
      rows.push(gap(), ...para("Quit any time: setup picks up where you stopped, and never runs a step twice.", width, C.dim))
      break
    }
    case "signIn": {
      rows.push(text("Sign in to Candle", C.head))
      const f = view.facts
      if (input.paneOpen) {
        rows.push(text(paneLine(local, input.engine, f.profile), C.dim))
        break
      }
      rows.push(gap())
      if (f.profile) {
        // Recorded, but not signed in now: the same profile signs in again.
        rows.push(...para(`The Candle Harness acts as the profile ${f.profile}, and Candle doesn't show it signed in.`, width), gap())
        rows.push(itemRow(items, { kind: "signIn" }, [[`Sign in again as ${f.profile}`, C.ctl]], ["Candle's device code, in a pane", C.dim]))
      } else if (f.signIn.state === "signed-in" && f.signIn.profile) {
        rows.push(text("This machine's Candle CLI is signed in:"), gap())
        rows.push({ kind: "text", runs: [["  ", C.ink], [f.signIn.account ? shortAddress(f.signIn.account) : "an account", C.hi]] })
        const host = f.profiles?.find((p) => p.name === (f.signIn as { profile: string }).profile)?.apiUrl
        rows.push({ kind: "text", runs: [["  ", C.ink], [`profile ${f.signIn.profile}${host ? ` · ${host.replace(/^https:\/\//, "")}` : ""}`, C.dim]] }, gap())
        rows.push(itemRow(items, { kind: "useProfile", profile: f.signIn.profile }, [["Use this account", C.ctl]]))
        rows.push(itemRow(items, { kind: "signIn" }, [["Sign in to another", C.ctl]], ["a new profile, by Candle's device code", C.dim]))
      } else if ((f.profiles?.length ?? 0) > 1 && !f.profiles!.some((p) => p.active)) {
        rows.push(...para(`This machine has ${f.profiles!.length} Candle profiles and none is selected. Which should the Candle Harness use?`, width), gap())
        for (const p of f.profiles!.slice(0, 8)) rows.push(itemRow(items, { kind: "useProfile", profile: p.name }, [[p.name.padEnd(14), C.ctl], [p.account ? shortAddress(p.account).padEnd(12) : "".padEnd(12), C.ink]], [p.apiUrl?.replace(/^https:\/\//, "") ?? "", C.dim]))
        rows.push(itemRow(items, { kind: "signIn" }, [["Sign in a new profile", C.ctl]]))
        rows.push(gap(), ...para("A new profile becomes the CLI's active one, since none is selected now. The CLI's other profiles stay as they are.", width, C.dim))
      } else if (f.signIn.state === "unreadable" && f.signIn.said?.includes("CANDLE_KEYRING_PASSPHRASE")) {
        // Linux with no keychain (WSL too): the CLI keeps its sign-in in a file locked by a
        // passphrase from the environment, which this Candle Harness's core took when it started. Reading again or signing in
        // can't work until it's set and the Candle Harness started again, so only that is offered.
        const rc = /zsh$/.test(process.env.SHELL ?? "") ? "~/.zshrc" : "~/.bashrc"
        const line = `echo 'export CANDLE_KEYRING_PASSPHRASE="<a passphrase of your own>"' >> ${rc}`
        rows.push(...para("This machine has no keychain, so the Candle CLI keeps its sign-in in a file locked by a passphrase you choose. The Candle Harness reads it when it starts, so set it first:", width), gap())
        rows.push(...wrap(line, width - 2).map((l) => text(`  ${l}`, C.ink)))
        rows.push(itemRow(items, { kind: "copy", text: line, what: "the line" }, [["⧉ Copy the line", C.ctl]], ["then put your own passphrase in it", C.dim]), gap())
        rows.push(...para("Then quit (ctrl-c twice), open a new terminal, and run candle-harness again. Keep the same passphrase from then on.", width), gap())
        rows.push(...para("This isn't a vault's passphrase. It only locks the CLI's sign-in file on this machine; a vault, if you make one, has its own.", width, C.dim))
        break
      } else if (f.signIn.state === "unreadable") {
        rows.push(...para("The Candle Harness couldn't read the candle CLI's sign-in. Check `candle auth status` runs in a terminal, then read it again.", width), gap())
        if (f.signIn.said) rows.push(...para(`The CLI said: ${f.signIn.said}`, width, C.look), gap())
        rows.push(itemRow(items, { kind: "reread" }, [["Read it again", C.ctl]]))
        rows.push(itemRow(items, { kind: "signIn" }, [["Sign in to Candle", C.ctl]], ["a new profile, by Candle's device code", C.dim]))
      } else {
        rows.push(...para("Candle signs this machine in with a device code: you approve it in your browser.", width), gap())
        rows.push(itemRow(items, { kind: "signIn" }, [["Sign in to Candle", C.ctl]], ["a new profile of its own, on Candle's production host", C.dim]))
      }
      rows.push(gap(), ...para("The Candle Harness records the profile it uses and acts as it on every step, so switching the CLI's active profile later never moves your agents to another account. It never reads another profile's keys.", width, C.dim))
      break
    }
    case "engine": {
      rows.push(text("Connect your agent", C.head))
      if (input.paneOpen) {
        rows.push(text(paneLine(local, input.engine), C.dim))
        break
      }
      if (local.before) {
        const label = input.engine?.engines[local.before]?.label ?? local.before
        rows.push(gap(), text(`Sign in to ${label}`, C.hi), gap())
        const [first, held] = HARNESS_SIGN_INS[local.before].before!.split(/(?<=\.) (?=A ChatGPT)/)
        rows.push(...para(first!, width), gap())
        if (held) rows.push(...para(`! ${held}`, width, C.look), gap())
        rows.push(...para("The key goes into the harness's own store, by the harness. The Candle Harness never stores a model key.", width, C.dim), gap())
        rows.push(itemRow(items, { kind: "harness", engine: local.before }, [[`Open ${label}'s sign-in`, C.ctl]]))
        rows.push(itemRow(items, { kind: "back" }, [["Back", C.ctl]]))
        break
      }
      rows.push(gap(), ...para("Your agent runs on a harness you already use, signed in as you. The Candle Harness keeps your own setup out of it and never stores a model key.", width), gap())
      const chosen = view.state.engine
      for (const id of ENGINE_IDS) {
        const info = input.engine?.engines[id]
        if (!info) continue
        const version = info.check?.version ? ` ${info.check.version}` : ""
        if (!info.check) {
          rows.push(text(`${info.label} · checking…`, C.dim))
          continue
        }
        const installed = info.check.ok || info.check.version !== undefined
        if (!installed) {
          rows.push(itemRow(items, { kind: "copy", text: INSTALL_LINES[id], what: `${info.label}'s install line` }, [[`${info.label} · not installed`, C.dim]], [`⧉ ${INSTALL_LINES[id]}`, C.ctl]))
          continue
        }
        if (!info.check.ok) {
          rows.push(text(`${info.label}${version} · ${info.check.message ?? "can't run here"}`.slice(0, width), C.dim))
          continue
        }
        if (!canRun(info) || (info.needsModel && info.signedIn === false)) {
          rows.push(itemRow(items, { kind: "harness", engine: id }, [[`${info.label}${version} · ${info.needsModel ? "no models yet" : "not signed in"}`, C.dim]], ["sign in", C.ctl]))
          continue
        }
        const state = info.needsModel ? "ready" : info.signedIn === true ? "signed in" : "installed"
        const list = local.models?.engine === id ? local.models.list : undefined
        const picked = chosen === id
        rows.push(itemRow(items, { kind: "engine", engine: id }, [[`${info.label}${version} · ${state}`, picked ? C.head : C.ctl]], picked ? undefined : ["pick", C.dim]))
        if (picked) {
          const models = (list ?? []).slice(0, 6)
          if (!list) rows.push(text("     reading its models…", C.dim))
          // As the picker: with no default of its own listed, the harness's own default is the first choice.
          if (list && !info.needsModel && !list.some((m) => m.isDefault)) {
            const on = !view.state.model
            rows.push(itemRow(items, { kind: "engine", engine: id }, [[on ? "   ● " : "     ", C.focus], [`${info.label}'s own default`, on ? C.hi : C.ctl]]))
          }
          for (const m of models) {
            const on = view.state.model === m.id || (!view.state.model && m.isDefault)
            rows.push(itemRow(items, { kind: "engine", engine: id, model: m.id }, [[on ? "   ● " : "     ", C.focus], [`${m.label === m.id ? m.id : `${m.id} · ${m.label}`}${m.isDefault ? " · default" : ""}`, on ? C.hi : C.ctl]]))
          }
          if ((list?.length ?? 0) > models.length) rows.push(text(`     and ${list!.length - models.length} more: ctrl-g picks any of them later`, C.dim))
        }
      }
      rows.push(gap(), text(`── test it ${"─".repeat(Math.max(0, width - 11))}`, C.edge), gap())
      const test = local.test
      const sameChoice = test?.ok && test.engine === chosen && test.model === view.state.model
      if (!test && testedOn(view.state)) {
        // Answered before a quit: kept by the core with the engine and model, so it isn't asked again.
        rows.push({ kind: "text", runs: [["✓ ", C.good], ["The test message answered on this engine and model before.", C.ink]] })
        rows.push(gap(), itemRow(items, { kind: "continue" }, continueRuns(NEXT_STEP.engine)))
      } else if (test?.ok && sameChoice) {
        rows.push({ kind: "text", runs: [["✓ ", C.good], [`${input.engine?.engines[test.engine]?.label ?? test.engine}${test.model ? ` · ${test.model}` : ""} answered in ${(test.ms / 1000).toFixed(1)} s:`, C.ink], [`  ${test.reply || "(nothing)"}`, C.hi]] })
        rows.push(gap(), itemRow(items, { kind: "continue" }, continueRuns(NEXT_STEP.engine)))
      } else {
        if (test && !test.ok) rows.push(...para(`✗ ${test.words}`, width, C.bad))
        const needs = chosen && input.engine?.engines[chosen]?.needsModel && !view.state.model
        if (local.busy) {
          // The test is running: said under the list, with nothing to press twice.
        } else if (!chosen) rows.push(text("Pick an engine above, then send one test message.", C.dim))
        else if (needs) rows.push(text("Pick a model above, then send one test message.", C.dim))
        else rows.push(itemRow(items, { kind: "test" }, [[test && !test.ok ? "Try again" : "Send a test message", C.ctl]], ["one word, run the way a real turn runs", C.dim]))
      }
      break
    }
    case "vault":
    case "key":
    case "wallet":
    case "limits":
    case "approvals":
    case "fund":
      stepThree({ view, local, width, ctx, paneOpen: input.paneOpen, engine: input.engine }, rows, items)
      break
    case "start":
      stepFive(width, ctx, rows, items)
      break
    default:
      break
  }
  said()
  return { rows, items }
}

/** Step 3's six parts. */
function stepThree(input: { view: OnboardingView; local: ObLocal; width: number; ctx: ObContext; paneOpen: boolean; engine?: EngineTopic }, rows: ObRow[], items: ObItem[]): void {
  const { view, local, width, ctx } = input
  const f = view.facts
  const agent = agentNameOf(view, local, ctx)
  const dim = (t: string) => para(t, width, C.dim)
  // What a choice means, set in under it: a bullet, or a plain note.
  const under = (t: string, bullet = true): ObRow[] => wrap(t, width - 6).map((l, i) => text(`    ${bullet ? (i === 0 ? "· " : "  ") : ""}${l}`, C.dim))
  const heading: Record<string, string> = {
    vault: "A vault now, or the embedded wallet only for now?",
    key: "Your agent's key",
    wallet: `Which wallet ${agent} pays from`,
    limits: `Limits for ${agent}, each with who holds it`,
    approvals: `How ${agent}'s trades are approved`,
    fund: `Fund ${walletWords(fundWallet(view, ctx)?.name ?? "its wallet")}, or start on paper`,
  }
  rows.push(text(heading[view.at]!, C.head))
  if (input.paneOpen) {
    // One row: the pane opens under it, and its own title names the command.
    if (local.paneWords) rows.push(text(fit(local.paneWords.line, width), C.dim))
    return
  }
  rows.push(gap())
  // The factor, as the core will run the step: a vault takes it first; no vault is the person in the pane.
  const factorRun = (): Run => (f.vault === "present" ? ["your vault's factor first, in the pane", C.dim] : ["no vault: approved by you in the pane", C.look])
  const factor = (): ObRow => text(...factorRun())
  switch (view.at) {
    case "vault": {
      rows.push(...para("A vault keeps your recovery words and guards every owner step with a passphrase or a security key. You can add one any time.", width))
      if (view.state.vaultChoice === "now") rows.push(gap(), ...para("The vault isn't made yet: the pane stopped before it finished. Make it again, or go on without one for now.", width, C.look))
      // Two choices, said as two (it was unclear there were two options to choose from), in the row that was blank.
      rows.push(text("Pick one of two:", C.dim))
      rows.push(itemRow(items, { kind: "vault", now: false }, [["1  The embedded wallet only, for now", C.ctl]]))
      for (const t of ["Owner steps, like making your agent's key, are approved by you in the pane.", "A wallet of its own, or a send from the Candle Harness, needs a vault: set one up later from settings ▾.", "Funds out go through Candle's site."]) rows.push(...under(t))
      rows.push(gap())
      rows.push(itemRow(items, { kind: "vault", now: true }, [[view.state.vaultChoice === "now" ? "2  Make the vault" : "2  A vault now", C.ctl]], ["candle vault init, in the pane", C.dim]))
      // So a Free account doesn't make a vault for a wallet of its own it can't have. The plan is read
      // with the agent's key, so before the key it's said as a rule; after it, as this account's.
      const own = f.plan === undefined ? "A wallet of its own for your agent needs Pro or Max; on Free a vault still keeps your recovery words and guards owner steps." : f.plan === "pro" || f.plan === "max" ? "Your agent can then have a wallet of its own." : `A wallet of its own needs Pro or Max, and this account is on ${f.plan[0]!.toUpperCase()}${f.plan.slice(1)}.`
      for (const t of ["Your 24 recovery words, shown once. Write them down.", "A passphrase on every owner step; a security key can be added next. Touch ID is coming.", own]) rows.push(...under(t))
      return
    }
    case "key": {
      rows.push(...para("Your agent trades with a key of its own, made by Candle's CLI and stored straight into the Candle Harness. It never shows on screen.", width), gap())
      const revoke = view.steps.find((s) => s.id === "key")?.revoke ?? []
      // A new account: Candle makes no agent key until the account's embedded wallet is authorized for
      // agents, which only Candle's site does, with the first key made there. That key can go straight after.
      if (f.keyRefused === "AGENT_WALLET_NOT_DELEGATED" && !revoke.length) {
        rows.push(...para("Candle won't make a key yet: this account hasn't authorized its embedded wallet for agents. A new account does this once, on Candle's site.", width, C.look), gap())
        const steps = [
          "Open the Agent Console (the link below), signed in as this account.",
          "Make a key there with Create key and authorize, and approve what Candle asks. That authorizes the wallet.",
          "Revoke that key if you like: the authorization stays. Then Try again here.",
        ]
        steps.forEach((t, n) => rows.push(...wrap(t, width - 3).map((l, i) => text(`${i === 0 ? `${n + 1}  ` : "   "}${l}`))))
        rows.push(gap())
        rows.push(itemRow(items, { kind: "copy", text: AGENT_CONSOLE, what: "the Agent Console's link" }, [["Copy the Agent Console's link", C.ctl]], [`⧉ ${AGENT_CONSOLE.replace(/^https:\/\//, "")}`, C.dim]))
        rows.push(itemRow(items, { kind: "makeKey" }, [["Try again", C.ctl]], [`candle keys create --label ${agent}`, C.dim]))
        return
      }
      if (f.keyRefused && !revoke.length) rows.push(...para(`Candle refused the last try (${f.keyRefused}): the pane said why. Fix it, then make the key again.`, width, C.look), gap())
      if (revoke.length) {
        // A key made but not stored is revoked before another is made, so nothing live is left unheld.
        rows.push(...para(`A key labelled ${view.state.agent?.name ?? agent} was made but not stored: it's live on your account and nothing holds it. Revoke it, then make the key again.`, width, C.look), gap())
        for (const r of revoke) rows.push(itemRow(items, { kind: "revoke", prefix: r.prefix }, [[`Revoke ${r.prefix}`, C.ctl]], [r.line, C.dim]))
        return
      }
      // Field rows carry the highlight's two columns, so the text beside them is set in by two as well.
      rows.push(fieldRow(items, "agentName", [["name      ", C.dim]], agent, { width: 18 }))
      const engine = view.state.engine ? `${input.engine?.engines[view.state.engine]?.label ?? view.state.engine}${view.state.model ? ` · ${view.state.model}` : ""}` : "the engine you pick"
      rows.push({ kind: "text", runs: [["  runs on   ", C.dim], [engine, C.ink], [view.state.engine ? ", from step 2" : "", C.dim]] }, gap())
      rows.push(text("Candle's cap on the key, optional"))
      const cap = fieldValue(local, "cap", "50")
      rows.push(fieldRow(items, "cap", [["cap       ", C.dim]], cap, { dollars: true, width: 8, after: ["a day · past it, Candle refuses buys and swaps · empty for none", C.dim] }))
      rows.push(gap())
      const made = keyArgv(agent, cap)
      if ("problem" in made) rows.push(...para(made.problem, width, C.bad))
      else {
        rows.push(text("It runs, in the pane:"))
        rows.push(...wrap(`candle ${made.argv.join(" ")}`, width - 2).map((l) => text(`  ${l}`, C.ink)))
        rows.push({ kind: "text", runs: [["  ", C.ink], factorRun()] })
      }
      rows.push(gap(), itemRow(items, { kind: "makeKey" }, [["Make the key", C.ctl]]))
      if (f.vault === "present") rows.push(itemRow(items, { kind: "securityKey" }, [["Add a security key to your vault", C.ctl]], ["optional: candle vault enroll security-key", C.dim]))
      return
    }
    case "wallet": {
      const prefix = f.key.state === "stored" ? f.key.prefix : undefined
      rows.push(itemRow(items, { kind: "allowEmbedded" }, [["The embedded wallet", C.ctl]], ["every plan · fills in 3 to 6 s", C.dim]))
      rows.push(...under(`A new key can't pay from any wallet until you allow one. In the pane, you type the key's prefix${prefix ? `, ${prefix},` : ""} back to allow this one.`, false))
      // The prefix exactly, since Candle checks it exactly: its look-alike characters named, and a copy.
      if (prefix) rows.push(itemRow(items, { kind: "copy", text: prefix, what: "the key's prefix" }, [[`⧉ ${prefix}`, C.ctl]], [lookAlikes(prefix) ?? "", C.dim]))
      rows.push(gap())
      const paid = f.plan === "pro" || f.plan === "max"
      if (f.vault !== "present") rows.push({ kind: "text", runs: [["  A wallet of its own  ", C.dim], ["needs a vault first (Pro or Max)", C.dim]] })
      else if (f.plan !== undefined && !paid) rows.push({ kind: "text", runs: [["  A wallet of its own  ", C.dim], ["needs Pro or Max", C.dim]] })
      else if (!f.vaultKey) rows.push({ kind: "text", runs: [["  A wallet of its own  ", C.dim], ["needs one vault key with SOL to promote it from: later", C.dim]] })
      else {
        rows.push(itemRow(items, { kind: "ownWallet" }, [["A wallet of its own", C.ctl]], [`a TEE wallet, from your vault key ${f.vaultKey}`, C.dim]))
        rows.push(...under("Promoted from your vault key, which pays its rent, then funded on the next part. Fills take 5 to 11 s.", false))
      }
      // Said, since it reads as if it must be filled in: it names whichever wallet is picked, and may stay empty.
      rows.push(gap(), fieldRow(items, "walletName", [["optional  ", C.ink], ["its name  ", C.dim]], fieldValue(local, "walletName", ""), { width: 16, after: ["the Candle Harness's name for the wallet you pick, if you want one", C.dim] }))
      if (f.wallet.state === "unknown") rows.push(gap(), text(`Reading what ${agent} can pay from…`, C.dim))
      rows.push(gap(), factor())
      return
    }
    case "limits": {
      const own = ctx.agents?.find((a) => a.name === agent)?.limits
      // Enter's choice first, saying what it does; ↓ reaches the figures. "Keep these" read as keep the defaults.
      rows.push(itemRow(items, { kind: "keepLimits" }, [["Use these limits", C.ctl], ["      ⏎ uses them · ↓ to change a figure first", C.ink]]), gap())
      rows.push({ kind: "text", runs: [["  who     ", C.dim], ["limit", C.dim]] })
      rows.push(fieldRow(items, "perTrade", [["Harness ", C.ink], ["per trade    ", C.ink]], fieldValue(local, "perTrade", String(own?.perTradeUsd ?? 10)), { dollars: true, width: 8, after: ["a trade over it is refused", C.dim] }))
      rows.push(fieldRow(items, "perDay", [["Harness ", C.ink], ["per day      ", C.ink]], fieldValue(local, "perDay", String(own?.perDayUsd ?? 50)), { dollars: true, width: 8, after: [`${agent}'s trades, from midnight`, C.dim] }))
      const candle = limitRows([agent], ctx.agents ?? []).filter((r) => r.who === "Candle")
      if (candle.length === 0) rows.push({ kind: "text", runs: [["  Candle  ", C.ink], ["key cap       ", C.ink], ["reading…", C.dim]] })
      for (const r of candle) rows.push({ kind: "text", runs: [["  Candle  ", C.ink], ["key cap       ", C.ink], [r.limit, r.look ? C.look : C.ink], [r.look ? "" : "   set on its key a step ago", C.dim]] })
      // Which day stops the key first, with the figure as typed now.
      const typedDay = Number(fieldValue(local, "perDay", String(own?.perDayUsd ?? 50)))
      for (const t of dayCapsFirst([agent], ctx.agents ?? [], () => (Number.isFinite(typedDay) ? typedDay : undefined))) rows.push(...wrap(t, width - 10).map((l) => text(`          ${l}`, C.dim)))
      rows.push(gap(), text("  Candle  per-asset caps, loss limits, circuit breaker"))
      rows.push(...wrap("Candle holds these too, set in Candle's Agent Console. A loss limit or the breaker stops the key, sells included, until you resume it there.", width - 10).map((l) => text(`          ${l}`, C.dim)))
      rows.push(gap(), ...dim(`The Candle Harness's two go in config.toml under [agents.${agent}.limits]; settings ▾ → approvals shows every limit, with who holds it.`))
      return
    }
    case "approvals": {
      const w = ctx.autonomy?.wallets.find((x) => x.agents.includes(agent) && !x.gone)
      if (!w) {
        rows.push(text(`Reading ${agent}'s wallet…`, C.dim), gap())
        rows.push(itemRow(items, { kind: "continue", step: "approvals" }, [["Continue, asking every time", C.ctl]]))
        return
      }
      rows.push({ kind: "text", runs: [[walletWords(w.name), C.hi], [` · ${agent} pays from it`, C.dim]] }, gap())
      const inside = local.inside === true
      // Continue first: Enter landed on "ask every time", already picked, and seemed to do nothing.
      rows.push(itemRow(items, { kind: "approvals" }, continueRuns(NEXT_STEP.approvals, inside ? "Turn it on and continue" : "Continue")), gap())
      rows.push(itemRow(items, { kind: "inside", on: false }, [[inside ? "○ " : "● ", C.focus], ["ask every time", C.ctl]], ["every trade is a card you approve", C.dim]))
      rows.push(itemRow(items, { kind: "inside", on: true }, [[inside ? "● " : "○ ", C.focus], ["trade inside limits", C.ctl]]))
      if (inside) {
        rows.push(...under("buys, sells and swaps inside two figures of its own run without a card, with a receipt:", false))
        const trade = fieldValue(local, "autoTrade", "")
        const day = fieldValue(local, "autoDay", "")
        rows.push(fieldRow(items, "autoTrade", [["    per trade    ", C.ink]], trade, { dollars: true, width: 8 }))
        rows.push(fieldRow(items, "autoDay", [["    per day      ", C.ink]], day, { dollars: true, width: 8, after: ["without a card", C.dim] }))
        const t = parseFigure(trade)
        const d = parseFigure(day)
        for (const note of bindsFirst([agent], ctx.agents ?? [], t.ok ? t.usd : undefined, d.ok ? d.usd : undefined)) rows.push(text(`    ${note}`, C.look))
      }
      rows.push(gap(), ...dim("Every limit on the last step still holds, and the kill switch still stops it all. Change it any time in settings ▾ → approvals."))
      return
    }
    case "fund": {
      const w = fundWallet(view, ctx)
      if (w?.sol) rows.push(itemRow(items, { kind: "continue", step: "fund" }, continueRuns(NEXT_STEP.fund)), gap())
      if (!w) {
        rows.push(text("Reading the wallet's address…", C.dim), gap())
      } else {
        rows.push(itemRow(items, { kind: "copy", text: w.address, what: "the address" }, [[`${w.name}  `, C.hi], [w.address.length > width - w.name.length - 16 ? shortAddress(w.address) : w.address, C.ink]], ["⧉ address", C.ctl]))
        rows.push(w.sol ? { kind: "text", runs: [["  ✓ ", C.good], [`${w.sol} SOL`, C.ink], ["  funded", C.dim]] } : { kind: "text", runs: [["  0 SOL  ", C.ink], ["⠋ ", C.look], ["waiting for a deposit", C.dim]] })
        rows.push(gap(), ...para(w.sol ? "Funded. The Candle Harness starts on paper either way: go live from the status bar when you're ready." : "Send SOL from any wallet of yours. This moves on by itself when it lands.", width), gap())
      }
      rows.push(itemRow(items, { kind: "paper" }, [["Start on paper", C.ctl]], ["paper trades need no funds; go live from the status bar", C.dim]))
      return
    }
  }
}

/** What each tab step 5 offers shows, in a line. */
const START_TABS: readonly { name: string; words: string }[] = [
  { name: "Trade", words: "your agent, with the token, positions, wallets and activity" },
  { name: "Cockpit", words: "feed, signals and the token, with the agent on the right" },
]
const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

/**
 * Step 5, where to start: Trade or Cockpit as the tab the Candle Harness opens on, one press each. Where a layouts.toml of
 * the person's own names neither, its first tab. Then which tabs are on, and the files that hold it all.
 */
function stepFive(width: number, ctx: ObContext, rows: ObRow[], items: ObItem[]): void {
  const tabs = ctx.start?.tabs ?? START_TABS.map((t) => t.name)
  rows.push(text("Where do you want to start?", C.head), gap())
  const offered = START_TABS.filter((t) => tabs.includes(t.name))
  for (const t of offered) rows.push(itemRow(items, { kind: "start", tab: t.name }, [[t.name.padEnd(10), C.ctl], [fit(t.words, Math.max(0, width - 13)), C.dim]]))
  if (offered.length === 0 && tabs[0]) rows.push(itemRow(items, { kind: "start", tab: tabs[0] }, [["Open the Candle Harness", C.ctl]], [`on ${tabs[0]}, your first tab`, C.dim]))
  rows.push(gap())
  const total = ctx.start?.total ?? tabs.length
  const on = tabs.length >= total ? `All ${NUMBER_WORDS[total] ?? total} tabs are on.` : `${tabs.length} of your ${total} tabs are on.`
  rows.push(...para(`${on} Tick them on or off in settings ▾, and change a tab's layout from settings ▾ → layout.`, width), gap())
  const files = ctx.start?.files ?? []
  if (files.length) {
    rows.push(text("Your files"))
    for (const f of files) rows.push(text(`  ${f}`, C.dim))
  }
}

/** The line over an open pane: whose sign-in it is, whatever step the screen has moved on to. */
function paneLine(local: ObLocal, engine: EngineTopic | undefined, profile?: string): string {
  if (local.paneWords) return local.paneWords.line
  if (local.paneFor === undefined || local.paneFor === "candle") return profile ? `Candle's device code, for the profile ${profile}.` : "A new profile of its own, on Candle's production host."
  return `${engine?.engines[local.paneFor]?.label ?? local.paneFor}'s own sign-in, as you, into its own store. The Candle Harness keeps none of it.`
}

const LOOK_ALIKE: Readonly<Record<string, string>> = { "0": "a zero", O: "a capital o", o: "a small o", "1": "a one", l: "a small L", I: "a capital i" }

/** The prefix's characters that look alike in a terminal's font, in words: "0 is a zero, O a capital o". */
export function lookAlikes(prefix: string): string | undefined {
  const seen = Object.keys(LOOK_ALIKE).filter((c) => prefix.includes(c))
  if (seen.length === 0) return undefined
  return seen.map((c, i) => `${c}${i === 0 ? " is" : ""} ${LOOK_ALIKE[c]}`).join(", ")
}

/** What the open pane's screen showed: a device code and its link, for the ⧉ chips (Candle's, Codex's, Grok's). */
export function codeFrom(screen: string): { code?: string; url?: string } {
  const plain = screen.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  const code = /(?:Device code|one-time code[^\n]*\n|Confirm this code in your browser:)\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})/.exec(plain)?.[1]
  const url = /(https:\/\/[^\s"'<>]{8,300})/.exec(plain.slice(plain.search(/Approve at|Open this link|open this URL|visit:/i) >= 0 ? plain.search(/Approve at|Open this link|open this URL|visit:/i) : 0))?.[1]
  return { ...(code ? { code } : {}), ...(url ? { url } : {}) }
}

/** Where the step's pane goes: inside the step box, under its heading, leaving two rows for the waiting line and chips. */
export function stepRect(width: number, height: number): { x: number; y: number; w: number; h: number } {
  const wide = width >= 100
  const x = wide ? RAIL_W + 2 : 0
  const top = 2
  const w = width - x - (wide ? 1 : 0)
  const h = height - top - (wide ? 2 : 1)
  return { x, y: top, w, h }
}
/** The prompt pane's rect inside the step. */
export function obPaneRect(width: number, height: number): { x: number; y: number; w: number; h: number } {
  const s = stepRect(width, height)
  return { x: s.x + 2, y: s.y + 4, w: s.w - 4, h: Math.max(8, s.h - 9) }
}

export function OnboardingScreen(props: {
  width: number
  height: number
  view: OnboardingView
  engine?: EngineTopic
  local: ObLocal
  paneOpen: boolean
  ctx?: ObContext
  /** The open pane is still running: the line under it says what it waits for. */
  paneRunning: boolean
  onPick: (index: number) => void
  onAct: (action: ObAction) => void
}) {
  const { width, height, view } = props
  const wide = width >= 100
  const step = stepRect(width, height)
  const inner = step.w - 6
  const { rows } = stepRows({ view, ...(props.engine ? { engine: props.engine } : {}), local: props.local, width: inner, paneOpen: props.paneOpen, ...(props.ctx ? { ctx: props.ctx } : {}) })
  const straight = view.state.straightIn
  const number = NUMBER[view.at as OnboardingStep]
  const room = step.h - 4
  // A long list keeps the highlighted row in view.
  const selRow = rows.findIndex((r) => (r.kind === "item" || r.kind === "field") && r.item === props.local.sel)
  const from = selRow >= room ? selRow - room + 1 : 0
  const shown = rows.slice(from, from + room)
  return (
    <box position="absolute" left={0} top={0} width={width} height={height} backgroundColor={C.page}>
      <box position="absolute" left={0} top={0} width={width} height={1} backgroundColor={C.bar} flexDirection="row">
        <text fg={C.hi} bg={C.bar}>{" ▲ candle  "}</text>
        <text fg={C.hi} bg={C.paperBg}>{straight ? " STRAIGHT IN " : " SETUP "}</text>
        <text fg={C.dim} bg={C.bar}>{fit(`  ${straight ? "sign in, your model and its key, then the Candle Harness on paper" : "nothing trades until your agent and its limits exist"}`, Math.max(0, width - (straight ? 24 : 18)))}</text>
      </box>
      {wide ? (
        <box position="absolute" left={1} top={2} width={RAIL_W} height={height - 4} border borderStyle="rounded" borderColor={C.edge} title=" Setup " titleColor={C.head} backgroundColor={C.term} flexDirection="column">
          <text> </text>
          {railRows(view).map((runs, i) => (
            <box key={`r${i}`} height={1} flexDirection="row">
              <text> </text>
              {runs.map(([t, fg], j) => (
                <text key={j} fg={fg}>
                  {t}
                </text>
              ))}
            </box>
          ))}
          <box flexGrow={1} />
          <text fg={C.dim}>{" about 3 minutes"}</text>
          <text fg={C.dim}>{" quit any time: it picks"}</text>
          <text fg={C.dim}>{" up where you stopped"}</text>
        </box>
      ) : (
        <box position="absolute" left={0} top={1} width={width} height={1} flexDirection="row">
          {RAIL.map((s, i) => {
            const ids = s.subs ? s.subs.map((x) => x.id) : [s.id]
            const mark = markOf(view, ids)
            return (
              <text key={s.id} fg={mark === "now" ? C.hi : mark === "done" ? C.good : C.dim}>
                {` ${MARK[mark][0]} ${i}${mark === "now" ? ` ${s.label}` : ""} `}
              </text>
            )
          })}
        </box>
      )}
      <box position="absolute" left={step.x} top={step.y} width={step.w} height={step.h} border borderStyle="rounded" borderColor={C.focus} backgroundColor={C.term} flexDirection="column" paddingLeft={2} paddingRight={2}>
        <text> </text>
        {shown.map((row, i) => (
          <ObRowView key={`s${from + i}`} row={row} width={inner} sel={props.local.sel} onPick={props.onPick} onAct={props.onAct} />
        ))}
      </box>
      {number !== undefined ? (
        <box position="absolute" left={step.x + step.w - 15} top={step.y} height={1}>
          <text fg={C.dim} bg={C.term}>{` step ${number} of 5 `}</text>
        </box>
      ) : null}
      {props.paneRunning ? <PaneFoot left={step.x + 3} top={step.y + step.h - 4} width={inner} local={props.local} onAct={props.onAct} /> : null}
      <box position="absolute" left={0} top={height - 1} width={width} height={1} backgroundColor={C.bar} flexDirection="row">
        <text fg={C.dim} bg={C.bar}>{fit(props.paneOpen ? (props.paneRunning ? " ctrl-] back to setup · Ctrl-C stops it" : " ⏎ or Esc closes the pane") : " ↑/↓ moves · ⏎ or a click picks · esc back", width - 18)}</text>
        <box flexGrow={1} />
        <text fg={C.dim} bg={C.bar}>{"ctrl-c ×2 quits "}</text>
      </box>
    </box>
  )
}

/** What the line under the pane says it's waiting for. */
export function waitingWords(paneFor: ObLocal["paneFor"], owner?: ObLocal["paneWords"]): string {
  if (owner) return owner.wait
  if (paneFor === undefined || paneFor === "candle") return "waiting for you to approve in your browser"
  const typeThis = HARNESS_SIGN_INS[paneFor].typeThis
  return typeThis ?? "finish signing in in your browser; the pane says if it needs a code"
}

/** Under the open pane: what it's waiting for, and the ⧉ chips for a code and its link. */
function PaneFoot(p: { left: number; top: number; width: number; local: ObLocal; onAct: (a: ObAction) => void }) {
  const code = p.local.code
  return (
    <box position="absolute" left={p.left} top={p.top} width={p.width} height={1} flexDirection="row" backgroundColor={C.term}>
      <text fg={C.look}>{"⠋ "}</text>
      <text fg={C.ink}>{`${waitingWords(p.local.paneFor, p.local.paneWords)}   `}</text>
      {code?.code ? <Chip label="⧉ code" onClick={() => p.onAct({ kind: "copy", text: code.code!, what: "the code" })} /> : null}
      {code?.code && code.url ? <text> </text> : null}
      {code?.url ? <Chip label="⧉ link" onClick={() => p.onAct({ kind: "copy", text: code.url!, what: "the link" })} /> : null}
    </box>
  )
}

function ObRowView(p: { row: ObRow; width: number; sel: number; onPick: (i: number) => void; onAct: (a: ObAction) => void }) {
  const { row } = p
  const pointer = usePointer()
  if (row.kind === "chips") {
    return (
      <box height={1} flexDirection="row">
        {(row.lead ?? []).map(([t, fg], i) => (
          <text key={`l${i}`} fg={fg}>
            {t}
          </text>
        ))}
        {row.chips.map((c) => (
          <box key={c.label} flexDirection="row">
            <Chip label={c.label} onClick={() => p.onAct(c.action)} />
            <text> </text>
          </box>
        ))}
      </box>
    )
  }
  if (row.kind === "text") {
    let room = p.width
    return (
      <box height={1} flexDirection="row">
        {row.runs.length === 0 ? <text> </text> : null}
        {row.runs.map(([t, fg], i) => {
          const cut = t.slice(0, Math.max(0, room))
          room -= cut.length
          return (
            <text key={i} fg={fg}>
              {cut}
            </text>
          )
        })}
      </box>
    )
  }
  if (row.kind === "field") {
    // A typed field: the box shaded as the input line is, its caret only while it's the highlighted one.
    const on = row.item === p.sel
    const shown = `${row.dollars ? "$" : ""}${row.value}${on ? "▏" : ""}`
    const box = ` ${shown.padEnd(row.width)} `
    return (
      <box height={1} flexDirection="row" onMouseDown={() => p.onPick(row.item)} {...pointer}>
        <text fg={C.focus}>{on ? "▸ " : "  "}</text>
        {row.lead.map(([t, fg], i) => (
          <text key={i} fg={fg}>
            {t}
          </text>
        ))}
        <text fg={C.hi} bg={C.sel}>
          {box}
        </text>
        {row.after ? <text fg={row.after[1]}>{fit(`  ${row.after[0]}`, Math.max(0, p.width - 2 - row.lead.reduce((n, [t]) => n + t.length, 0) - box.length))}</text> : null}
      </box>
    )
  }
  // A choice: a menu row in the control colour, the highlighted one shaded with its ▸.
  const on = row.item === p.sel
  const bg = on ? C.sel : C.term
  const left = row.runs.reduce((n, [t]) => n + t.length, 2)
  const right = row.right ? fit(row.right[0], Math.max(0, p.width - left - 2)) : ""
  return (
    <box height={1} flexDirection="row" backgroundColor={bg} onMouseDown={() => p.onPick(row.item)} {...pointer}>
      <text fg={C.focus} bg={bg}>
        {on ? "▸ " : "  "}
      </text>
      {row.runs.map(([t, fg], i) => (
        <text key={i} fg={on && fg === C.ctl ? C.hi : fg} bg={bg}>
          {t}
        </text>
      ))}
      <box flexGrow={1} backgroundColor={bg} />
      {right ? (
        <text fg={row.right![1]} bg={bg}>
          {`${right} `}
        </text>
      ) : null}
    </box>
  )
}

export { HARNESS_SIGN_INS }
