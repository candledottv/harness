// A code bot's own report: what it says about itself, beside the core's count. Its status in a line, its health, its
// alerts, its rules in words, a few named counts, and its events (what it considered, entered, skipped, exited). Shown
// on the Bots tab as "the bot says".
//
// - **Never its figures.** Its P&L, positions, fills and balances are the core's count from its own fills; a report
//   naming any of them is refused, so a bot can't show a number the core didn't see.
// - **Each field it sends replaces that field;** one it leaves out keeps what it said before. Events are added, newest
//   first, a resent id kept once, so a report sent again after a reconnect adds nothing twice.
// - **Its text is drawn,** so it's cleaned as every outside text is (terminal-text.ts) and kept to one line. A field
//   over its size is refused by name rather than cut, so the bot knows what didn't land.
// - **Its controls are suggestions, never changes.** A bot may offer a few: pause it, or one of its figures set to a
//   new value. Each shows as a chip; the person's click lowers a figure or pauses at once, and anything that raises
//   a figure is a card the person presses (code-bots.ts `codeChanges`). A bot never changes its own figures.
// - **Kept in memory, the newest per bot,** until the core stops: a bot says it again when it connects. What it traded
//   is in the journal already, as the core's own rows.
import { refused } from "../shared/rpc"
import { terminalText } from "../shared/terminal-text"

export type BotHealth = "ok" | "warn" | "error"
export const BOT_EVENT_KINDS = ["considered", "entered", "skipped", "exited", "alert", "note"] as const
export type BotEventKind = (typeof BOT_EVENT_KINDS)[number]

export interface BotReportEvent {
  id: string
  /** When it happened, as the bot said, else when the core took it. */
  at: string
  kind: BotEventKind
  text: string
  mint?: string
}

/** The figures a control may set: a code bot's card's. */
export const CONTROL_FIGURES = ["perTradeUsd", "perDayUsd", "maxOpen", "maxSlippageBps"] as const
export type ControlFigure = (typeof CONTROL_FIGURES)[number]

/** A control a bot offers the person: pause it, or set some of its figures. */
export type BotControl = { id: string; label: string; pause: true } | { id: string; label: string; set: Partial<Record<ControlFigure, number>> }

export interface BotReport {
  /** When the core last took a report from it. */
  at: string
  status?: string
  health?: BotHealth
  alerts: { code?: string; text: string }[]
  rules: string[]
  counts: { name: string; value: number }[]
  events: BotReportEvent[]
  controls: BotControl[]
}

/** The sizes a report keeps to: over one is refused by name. */
export const REPORT_LIMITS = { status: 120, text: 160, alerts: 8, rules: 8, counts: 12, countName: 32, eventsPerReport: 50, eventsKept: 100, eventsShown: 20, controls: 4, label: 40 } as const
/** Fields a report may carry. */
const FIELDS = ["status", "health", "alerts", "rules", "counts", "events", "controls"] as const
/** What only the core counts: a report naming one is refused. */
const FIGURES = ["pnl", "realized", "unrealized", "positions", "fills", "balance", "balances", "value", "basis", "cost", "costUsd", "wallets", "books", "trades"] as const
/** The same, and their other spellings, as a count's name is compared: lowercase, letters only ("PnL", "Cost USD"). */
const FIGURE_NAMES = new Set([...FIGURES.map((f) => f.toLowerCase()), "pl", "profit", "loss", "realised", "unrealised", "equity", "roi"])
/** The ones that mean money made or held wherever they stand in a name ("P&L today", "realized so far"). */
const FIGURE_WORDS = new Set(["pnl", "pl", "profit", "realized", "realised", "unrealized", "unrealised", "balance", "balances", "equity", "roi"])
/** Whether a count's name reads as one of the core's figures, however it's spelt. Other words ("stop loss hits") are the bot's own. */
function readsAsFigure(name: string): boolean {
  if (FIGURE_NAMES.has(name.toLowerCase().replace(/[^a-z]/g, ""))) return true
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z&]+/)
    .some((w) => FIGURE_WORDS.has(w.replace(/&/g, "")))
}
/** An event's own id, or a code: letters, digits and `_ . : -`. */
const ID = /^[A-Za-z0-9_.:-]{1,64}$/
const WORD = /^[A-Za-z0-9_.-]{1,32}$/
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const HOOD_MINT = /^0x[0-9a-fA-F]{40}$/
/** An event may say it happened up to this far ahead of the core's clock (clocks drift), and no further. */
const FUTURE_MS = 5 * 60_000

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const bad = (words: string): never => {
  throw refused("INVALID_PARAMS", words)
}

/** Outside text as one line to draw: cleaned, its breaks and runs of space made one space, refused when over its size. */
function line(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") bad(`${field} is text.`)
  const s = terminalText(v as string)
    .replace(/[\r\n\t\u0085\u2028\u2029]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
  if (!s) bad(`${field} is empty once cleaned.`)
  if ([...s].length > max) bad(`${field} is ${[...s].length} characters, over its ${max}.`)
  return s
}

function list(v: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(v)) bad(`${field} is a list.`)
  if ((v as unknown[]).length > max) bad(`${field} has ${(v as unknown[]).length}, over its ${max}.`)
  return v as unknown[]
}

function onlyKeys(r: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const k of Object.keys(r)) if (!allowed.includes(k) && r[k] !== undefined) bad(`${field}.${k} isn't part of a report: it takes ${allowed.join(", ")}.`)
}

/** When an event happened: ISO text or unix seconds, not ahead of the core's clock. */
function when(v: unknown, field: string, now: number): string {
  if (v === undefined) return new Date(now).toISOString()
  const ms = typeof v === "number" && Number.isFinite(v) ? v * 1000 : typeof v === "string" ? Date.parse(v) : NaN
  if (!Number.isFinite(ms) || ms <= 0) bad(`${field} is when it happened: ISO text, or unix seconds.`)
  if (ms > now + FUTURE_MS) bad(`${field} is ahead of the core's clock by more than 5 minutes.`)
  return new Date(ms).toISOString()
}

export class BotReports {
  private readonly reports = new Map<string, BotReport>()
  private seq = 0

  constructor(private readonly now: () => number) {}

  /** A report from a bot, checked whole before any of it is kept. Answers what it keeps now. */
  take(bot: string, params: Record<string, unknown>): { at: string; events: number } {
    for (const k of FIGURES) {
      if (params[k] !== undefined) throw refused("REPORT_FIGURES", `A bot's ${k} is the core's count from its own fills, never its report's. Nothing of this report was kept.`)
    }
    onlyKeys(params, FIELDS, "report")
    const now = this.now()
    const next: Partial<BotReport> = {}
    if (params.status !== undefined) next.status = line(params.status, "status", REPORT_LIMITS.status)
    if (params.health !== undefined) {
      if (params.health !== "ok" && params.health !== "warn" && params.health !== "error") bad("health is ok, warn or error.")
      next.health = params.health as BotHealth
    }
    if (params.alerts !== undefined) {
      next.alerts = list(params.alerts, "alerts", REPORT_LIMITS.alerts).map((a, i) => {
        if (typeof a === "string") return { text: line(a, `alerts[${i}]`, REPORT_LIMITS.text) }
        const r = record(a) ?? bad(`alerts[${i}] is text, or { code, text }.`)
        onlyKeys(r, ["code", "text"], `alerts[${i}]`)
        if (r.code !== undefined && (typeof r.code !== "string" || !WORD.test(r.code))) bad(`alerts[${i}].code is one word: letters, digits, _ . or -.`)
        return { ...(r.code !== undefined ? { code: r.code as string } : {}), text: line(r.text, `alerts[${i}].text`, REPORT_LIMITS.text) }
      })
    }
    if (params.rules !== undefined) next.rules = list(params.rules, "rules", REPORT_LIMITS.rules).map((x, i) => line(x, `rules[${i}]`, REPORT_LIMITS.text))
    if (params.counts !== undefined) {
      const r = record(params.counts) ?? bad("counts is a record of names to numbers, such as { watching: 14 }.")
      const entries = Object.entries(r)
      if (entries.length > REPORT_LIMITS.counts) bad(`counts has ${entries.length}, over its ${REPORT_LIMITS.counts}.`)
      next.counts = entries.map(([raw, value]) => {
        const name = line(raw, "a count's name", REPORT_LIMITS.countName)
        // Compared as it would be read, not as it's spelt: "PnL", "P&L today" and "Balance" are the core's figures too.
        if (FIGURES.includes(raw as (typeof FIGURES)[number]) || readsAsFigure(name)) throw refused("REPORT_FIGURES", `A bot's ${name} is the core's count from its own fills, never its report's. Nothing of this report was kept.`)
        if (typeof value !== "number" || !Number.isFinite(value)) bad(`counts.${name} is a number.`)
        return { name, value: value as number }
      })
    }
    if (params.controls !== undefined) {
      const ids = new Set<string>()
      next.controls = list(params.controls, "controls", REPORT_LIMITS.controls).map((c, i) => {
        const r = record(c) ?? bad(`controls[${i}] is { id, label, pause: true }, or { id, label, set: { perTradeUsd, … } }.`)
        onlyKeys(r, ["id", "label", "pause", "set"], `controls[${i}]`)
        if (typeof r.id !== "string" || !ID.test(r.id)) bad(`controls[${i}].id is its own: 1 to 64 letters, digits, _ . : or -.`)
        if (ids.has(r.id as string)) bad(`controls[${i}].id "${r.id}" is used twice.`)
        ids.add(r.id as string)
        const label = line(r.label, `controls[${i}].label`, REPORT_LIMITS.label)
        if ((r.pause === true) === (r.set !== undefined)) bad(`controls[${i}] takes pause: true, or set: one or more of ${CONTROL_FIGURES.join(", ")}.`)
        if (r.pause === true) return { id: r.id as string, label, pause: true as const }
        const set = record(r.set) ?? bad(`controls[${i}].set is a record of figures, such as { perTradeUsd: 1 }.`)
        onlyKeys(set, CONTROL_FIGURES, `controls[${i}].set`)
        const figures: Partial<Record<ControlFigure, number>> = {}
        for (const k of CONTROL_FIGURES) {
          const v = set[k]
          if (v === undefined) continue
          if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`controls[${i}].set.${k} is a number above 0.`)
          if ((k === "maxOpen" || k === "maxSlippageBps") && !Number.isInteger(v)) bad(`controls[${i}].set.${k} is a whole number.`)
          figures[k] = v as number
        }
        if (!Object.keys(figures).length) bad(`controls[${i}].set names one or more of ${CONTROL_FIGURES.join(", ")}.`)
        return { id: r.id as string, label, set: figures }
      })
    }
    const events: BotReportEvent[] = []
    if (params.events !== undefined) {
      list(params.events, "events", REPORT_LIMITS.eventsPerReport).forEach((e, i) => {
        const r = record(e) ?? bad(`events[${i}] is { kind, text }, with id, at and mint if it has them.`)
        onlyKeys(r, ["id", "at", "kind", "text", "mint"], `events[${i}]`)
        if (!BOT_EVENT_KINDS.includes(r.kind as BotEventKind)) bad(`events[${i}].kind is one of ${BOT_EVENT_KINDS.join(", ")}.`)
        if (r.id !== undefined && (typeof r.id !== "string" || !ID.test(r.id))) bad(`events[${i}].id is its own: 1 to 64 letters, digits, _ . : or -.`)
        if (r.mint !== undefined && (typeof r.mint !== "string" || !(SOLANA_MINT.test(r.mint) || HOOD_MINT.test(r.mint)))) bad(`events[${i}].mint is a token's address.`)
        events.push({
          id: typeof r.id === "string" ? r.id : `core:${++this.seq}`,
          at: when(r.at, `events[${i}].at`, now),
          kind: r.kind as BotEventKind,
          text: line(r.text, `events[${i}].text`, REPORT_LIMITS.text),
          ...(typeof r.mint === "string" ? { mint: r.mint } : {}),
        })
      })
    }
    // Checked whole: now kept.
    const was = this.reports.get(bot)
    const kept = new Set((was?.events ?? []).map((e) => e.id))
    const added = events.filter((e) => !kept.has(e.id) && (kept.add(e.id), true))
    const all = [...added, ...(was?.events ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, REPORT_LIMITS.eventsKept)
    const report: BotReport = {
      at: new Date(now).toISOString(),
      ...(next.status ?? was?.status ? { status: next.status ?? was!.status! } : {}),
      ...(next.health ?? was?.health ? { health: next.health ?? was!.health! } : {}),
      alerts: next.alerts ?? was?.alerts ?? [],
      rules: next.rules ?? was?.rules ?? [],
      counts: next.counts ?? was?.counts ?? [],
      events: all,
      controls: next.controls ?? was?.controls ?? [],
    }
    this.reports.set(bot, report)
    return { at: report.at, events: added.length }
  }

  /** What a bot last said, its newest events only: the Bots topic's `says`. */
  view(bot: string): BotReport | undefined {
    const r = this.reports.get(bot)
    return r ? { ...r, events: r.events.slice(0, REPORT_LIMITS.eventsShown) } : undefined
  }

  /** One of the controls it offers now, by id. */
  control(bot: string, id: string): BotControl | undefined {
    return this.reports.get(bot)?.controls.find((c) => c.id === id)
  }

  /** Its events, newest first, as many as are kept. */
  events(bot: string, limit: number = REPORT_LIMITS.eventsKept): BotReportEvent[] {
    return (this.reports.get(bot)?.events ?? []).slice(0, limit)
  }

  /** A bot removed, or no longer approved: what it said goes with it. */
  forgetExcept(names: ReadonlySet<string>): void {
    for (const name of [...this.reports.keys()]) if (!names.has(name)) this.reports.delete(name)
  }
}
