// Research's reads, sent on the `research` topic: one token in depth, the linked one, while a Research pane
// is on screen. A view's subscription names the panes it shows (a filter, as `feeds` takes one), and nothing
// is read for a pane that isn't:
//   - Check: Candle's whole token check (candle_token_forensics), the one the token pane's line comes from,
//     read again every 5 minutes while Check shows; and from Hacc, the token's profile (its stage, its
//     curve's progress, when it was made) and its launch overview (holders and the top-10 share);
//   - Traders: Hacc's top traders on it, over 24 hours;
//   - Its signals: Hacc's tape for this token (`asset=<mint>`, since `by_token` ranks tokens across the tape
//     and isn't one token's signals), every quality;
//   - Mentions: the posts on X by the accounts Hacc follows, from the launch overview, over the token's
//     life (on Hacc's real server the 7-day mentions route answered none for both tokens read; the
//     overview had one's).
//
// Each of Hacc's reads is made at most once a minute for each token, refusals included, so a run of picks
// back and forth costs nothing more, and two panes that need one read (Check and Mentions, the overview)
// share it. Hacc reads the account, not the key, so it's read with the first agent Hacc is
// offered to (core-main.ts). A read the account's plan doesn't reach is said once, in a line, and never
// sent (all four are Free's today). A late answer for a token the link has left is kept for that
// token's minute but never shown under another.
import { terminalText } from "../shared/terminal-text"
import type { ToolOutcome } from "./candle-mcp"
import type { PlanHeld } from "./plan-held"
import { type HaccPlan, reaches } from "./plan-state"
import { cleanRow, type SignalRow } from "./signal-stream"
import { type ChainSlug, familyOfAddress } from "../shared/chains"

export const RESEARCH_PARTS = ["check", "traders", "signals", "mentions"] as const
export type ResearchPart = (typeof RESEARCH_PARTS)[number]
export const isResearchPart = (value: unknown): value is ResearchPart => typeof value === "string" && (RESEARCH_PARTS as readonly string[]).includes(value)

/** Hacc's reads behind the parts: Check and Mentions share the overview. */
export type HaccRead = "traders" | "signals" | "overview" | "profile"
const NEEDS: Readonly<Record<ResearchPart, readonly HaccRead[]>> = { check: ["profile", "overview"], traders: ["traders"], signals: ["signals"], mentions: ["overview"] }
/** The plan each read needs: all Free's today, kept so a change on Hacc's side is one line here. */
export const READ_PLAN: Readonly<Record<HaccRead, HaccPlan>> = { traders: "free", signals: "free", overview: "free", profile: "free" }
/** What each read is, in a line that says the plan doesn't reach it. */
const READ_WORDS: Readonly<Record<HaccRead, string>> = { traders: "Top traders need", signals: "A token's signals need", overview: "The launch overview needs", profile: "The token's profile needs" }

/** Research's reads a plan doesn't reach, each in a line (the doctor's); none on every plan today. */
export function researchUnreached(plan: HaccPlan): string[] {
  return (Object.keys(READ_PLAN) as HaccRead[]).filter((r) => !reaches(plan, READ_PLAN[r])).map((r) => `${READ_WORDS[r]} ${READ_PLAN[r] === "max" ? "Max" : "Pro"} on Hacc`)
}

/** Each of Hacc's reads, for each token, at most this often. */
export const READ_MS = 60_000
/** Candle's check, read again this often while Check is on screen. */
export const CHECK_MS = 5 * 60_000
/** Its signals: this many, every quality (`quality=all` adds a young token's rows). Live, a big token's 50 made a 46 KB topic. */
export const SIGNALS_LIMIT = 30
/** A read whose key Hacc refused is no answer about the token: it goes again this soon, with the next agent's key. */
export const AGAIN_MS = 2_000

type Chain = ChainSlug
export interface ResearchToken {
  mint: string
  chain: Chain
  symbol?: string
}

/** Hacc's route and query for a read of `mint`, and how long the client may share it with an agent's read of the same. */
export function researchRequest(read: HaccRead, chain: Chain, mint: string): { route: string; query: Record<string, string | number>; cacheMs: number } {
  const m = encodeURIComponent(mint)
  const hood: Record<string, string> = chain === "hood" ? { chain } : {}
  switch (read) {
    // The same query as the agent's hacc_token top_traders, so the client's short cache serves both.
    case "traders":
      return { route: `/v1/market/token/${m}/top-traders`, query: hood, cacheMs: 30_000 }
    case "signals":
      return { route: "/v1/signals", query: { asset: mint, limit: SIGNALS_LIMIT, quality: "all" }, cacheMs: 30_000 }
    case "overview":
      return { route: `/v1/market/token/${m}/launch-overview`, query: {}, cacheMs: 60_000 }
    case "profile":
      return { route: `/v1/market/token/${m}/profile`, query: {}, cacheMs: 60_000 }
  }
}

/**
 * Hacc's answer, or its refusal in words. `again`: the refusal was the key's, not the read's, so it isn't a
 * try (otherwise the first agent's refused key holds a token's reads for a minute while the second's would answer).
 */
/** `plan`: Hacc refused the read for the account's plan, which no read again changes. */
export type ResearchAnswer = { kind: "ok"; body: unknown } | { kind: "refused"; words: string; again?: true; plan?: true }

// ---------------------------------------------------------------------------------------------------------
// What each pane shows, read from the answers. Every string from Candle or Hacc is cleaned for the terminal
// and cut; a figure that isn't there is missing, never zero.

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const num = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}
const text = (value: unknown, max: number): string | undefined => {
  const t = typeof value === "string" ? terminalText(value, { maxLength: max }).trim() : ""
  return t.length > 0 ? t : undefined
}
const time = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  const t = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(t) ? t : undefined
}
/** An address: base58 or 0x hex, nothing else, so it's safe to draw and to copy. */
const address = (value: unknown): string | undefined => (typeof value === "string" && familyOfAddress(value) !== undefined ? value : undefined)
/** An X handle: letters, digits and underscores (and the scrub's hyphens), short. Anything else isn't a handle. */
const handle = (value: unknown): string | undefined => {
  const h = typeof value === "string" ? value.replace(/^@/, "") : ""
  return /^[A-Za-z0-9_-]{1,20}$/.test(h) ? h : undefined
}

/** One of Candle's checks: its name as Candle sends it, its status, and its value where that's short. */
export interface CheckFlag {
  name: string
  status: string
  value?: string
}

/** Candle's token check (candle_token_forensics, in the shape recorded from Candle), the parts the pane draws. */
export interface CandleCheck {
  /** flagged, clear, incomplete, not_applicable. */
  summary: string
  flags: CheckFlag[]
  mint?: { mintAuthority: string | null; freezeAuthority: string | null; program?: string; renounced?: boolean; extensions: string[]; risks: string[] }
  /** The sell probe: whether a $`usd` sell routed when Candle tried it, and at what cost. */
  sellProbe?: { routable: boolean | null; usd?: number; impactBps?: number; roundTripBps?: number; reason?: string; at?: number }
  dev?: { address: string; priorLaunches?: number; graduated?: number; died?: number; verdict?: string }
  /** What Candle couldn't check, by its own names (deploy_window, disclosed_wallets): unknown, not clean. */
  unchecked: string[]
  /** When Candle's safety read was made. */
  asOf?: number
}

export function candleCheck(result: unknown): CandleCheck | undefined {
  const forensics = record(record(result)?.forensics)
  const safety = record(forensics?.safety)
  if (!safety || typeof safety.summary !== "string") return undefined
  const flags = Object.entries(record(safety.flags) ?? {}).flatMap(([name, raw]): CheckFlag[] => {
    const f = record(raw)
    const status = text(f?.status, 20)
    if (!status) return []
    // A value worth a word: a count or a short word ("sellable"), never an address or a list.
    const v = typeof f?.value === "number" ? String(f.value) : typeof f?.value === "string" && f.value.length <= 16 && !address(f.value) ? text(f.value, 16) : undefined
    return [{ name: terminalText(name, { maxLength: 32 }), status, ...(v ? { value: v } : {}) }]
  })
  const mf = record(safety.mintFacts)
  const strings = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => (text(x, 32) ? [text(x, 32)!] : [])) : [])
  const mint = mf
    ? {
        mintAuthority: address(mf.mintAuthority) ?? null,
        freezeAuthority: address(mf.freezeAuthority) ?? null,
        ...(text(mf.tokenProgram, 16) ? { program: text(mf.tokenProgram, 16)! } : {}),
        ...(typeof mf.renounced === "boolean" ? { renounced: mf.renounced } : {}),
        extensions: strings(mf.extensionNames),
        risks: strings(mf.extensionRisks),
      }
    : undefined
  const sp = record(safety.sellProbe)
  const sellProbe = sp
    ? {
        routable: typeof sp.routable === "boolean" ? sp.routable : null,
        ...(num(sp.usdSize) !== undefined ? { usd: num(sp.usdSize)! } : {}),
        ...(num(sp.impactBps) !== undefined ? { impactBps: num(sp.impactBps)! } : {}),
        ...(num(sp.roundTripBps) !== undefined ? { roundTripBps: num(sp.roundTripBps)! } : {}),
        ...(text(sp.reason, 80) ? { reason: text(sp.reason, 80)! } : {}),
        ...(time(sp.at) !== undefined ? { at: time(sp.at)! } : {}),
      }
    : undefined
  const d = record(forensics?.deployer)
  const devAddress = address(d?.address)
  const rec = record(d?.record)
  const dev = devAddress
    ? {
        address: devAddress,
        ...(num(d?.priorLaunches) !== undefined ? { priorLaunches: num(d?.priorLaunches)! } : {}),
        ...(num(d?.graduated) !== undefined ? { graduated: num(d?.graduated)! } : {}),
        ...(num(rec?.died) !== undefined ? { died: num(rec?.died)! } : {}),
        ...(text(rec?.verdict, 24) ? { verdict: text(rec?.verdict, 24)! } : {}),
      }
    : undefined
  const asOf = time(safety.asOf)
  return {
    summary: terminalText(safety.summary, { maxLength: 20 }),
    flags,
    ...(mint ? { mint } : {}),
    ...(sellProbe ? { sellProbe } : {}),
    ...(dev ? { dev } : {}),
    unchecked: strings(record(forensics?.coverage)?.unavailable),
    ...(asOf !== undefined ? { asOf } : {}),
  }
}

/** Hacc's facts for Check: the profile's stage, curve and age, and the overview's holders and top-10 share. */
export interface HaccFacts {
  /** bonding_curve or migrated. */
  stage?: string
  launchpad?: string
  /** How far along the bonding curve, 0 to 1. */
  progress?: number
  holders?: number
  top10Pct?: number
  liquidityUsd?: number
  createdAt?: number
}

export function haccFacts(profile: unknown, overview: unknown): HaccFacts {
  const p = record(profile)
  const m = record(record(overview)?.market)
  // A token Hacc doesn't know still gets a profile: stage "unknown", 0 holders, 0 progress. None of it is a fact.
  const stage = text(p?.stage, 24)
  const known = stage !== undefined && stage !== "unknown" ? stage : undefined
  const counted = (n: number | undefined) => (n !== undefined && n > 0 ? n : undefined)
  const holders = counted(num(m?.holders)) ?? counted(num(p?.holder_count))
  const progress = known === "bonding_curve" ? num(p?.launchpad_progress) : undefined
  const created = time(p?.created_at) ?? time(record(record(overview)?.identity)?.launched_at) ?? time(m?.first_tick_at)
  const liquidity = num(m?.liquidity_usd) ?? num(p?.total_liquidity_usd)
  return {
    ...(known ? { stage: known } : {}),
    ...(text(p?.launchpad, 24) ? { launchpad: text(p?.launchpad, 24)! } : {}),
    ...(progress !== undefined ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
    ...(holders !== undefined ? { holders } : {}),
    ...(num(m?.top10_share_pct) !== undefined ? { top10Pct: num(m?.top10_share_pct)! } : {}),
    // Hacc reads a curve's liquidity as 0: no pool, not an empty one.
    ...(liquidity !== undefined && liquidity > 0 ? { liquidityUsd: liquidity } : {}),
    ...(created !== undefined ? { createdAt: created } : {}),
  }
}

/** One of Hacc's top traders on the token (as recorded from Hacc). */
export interface TraderRow {
  address: string
  realizedUsd?: number
  unrealizedUsd?: number
  totalUsd?: number
  trades?: number
  volumeUsd?: number
  /** Hacc's name for the wallet, where it has one. */
  label?: string
  handle?: string
  tracked: boolean
}

/**
 * Hacc's words when it answered but couldn't read the data: a 200 with `refresh_refused` ("Provider
 * endpoint has no approved research tariff") and no rows, seen on top traders from a Max key. It isn't a
 * plan refusal (that's a 403), so nothing is held; the read goes again at its pace.
 */
export function refreshRefused(body: unknown): string | undefined {
  const words = record(body)?.refresh_refused
  return typeof words === "string" && words.trim() ? terminalText(words.trim().replace(/\.\s*$/, ""), { maxLength: 200 }) : undefined
}

export function traderRows(body: unknown): TraderRow[] | undefined {
  const traders = record(body)?.traders
  if (!Array.isArray(traders)) return undefined
  return traders.flatMap((raw): TraderRow[] => {
    const t = record(raw)
    const a = address(t?.address)
    if (!a) return []
    const entity = t?.entity
    const label = text(entity, 32) ?? text(record(entity)?.name, 32) ?? text(record(entity)?.label, 32) ?? text(t?.display_label, 32) ?? text(t?.label, 32)
    const h = handle(t?.x_handle)
    const pick = (k: string) => (num(t?.[k]) !== undefined ? { [k]: num(t?.[k])! } : {})
    return [
      {
        address: a,
        ...renamed(pick("realized_pnl_usd"), "realizedUsd"),
        ...renamed(pick("unrealized_pnl_usd"), "unrealizedUsd"),
        ...renamed(pick("total_pnl_usd"), "totalUsd"),
        ...pick("trades"),
        ...renamed(pick("volume_usd"), "volumeUsd"),
        ...(label ? { label } : {}),
        ...(h ? { handle: h } : {}),
        tracked: t?.tracked === true,
      },
    ]
  })
}
const renamed = (o: Record<string, number>, to: string): Record<string, number> => {
  const v = Object.values(o)[0]
  return v === undefined ? {} : { [to]: v }
}

/** Its signals, cleaned as the stream's are, oldest first, as the Signals pane holds them. */
export function tokenSignalRows(body: unknown): SignalRow[] | undefined {
  const rows = record(body)?.signals
  if (!Array.isArray(rows)) return undefined
  return rows
    .map(cleanRow)
    .filter((r): r is SignalRow => r !== undefined)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
}

/** A post on X about the token, by an account Hacc follows (the launch overview's `kol_tweets`). */
export interface MentionRow {
  handle: string
  at: number
  followers?: number
  /** The post's text: third-party, drawn as data and never passed to the agent as the person's words. */
  text?: string
  /** A repost. */
  repost: boolean
}

export interface Mentions {
  rows: MentionRow[]
  /** How many accounts Hacc counted, and over what span (the overview's window). */
  accounts?: number
  from?: number
}

export function mentionRows(overview: unknown): Mentions | undefined {
  const k = record(record(overview)?.kol_tweets)
  if (!k || !Array.isArray(k.tweets)) return undefined
  const rows = k.tweets
    .flatMap((raw): MentionRow[] => {
      const t = record(raw)
      const h = handle(t?.handle)
      const at = time(t?.posted_at)
      if (!h || at === undefined) return []
      const body = text(t?.text, 280)
      return [{ handle: h, at, ...(num(t?.followers) !== undefined ? { followers: num(t?.followers)! } : {}), ...(body ? { text: body } : {}), repost: t?.rt === true }]
    })
    .sort((a, b) => b.at - a.at)
  const from = time(record(k.window)?.from)
  return { rows, ...(num(k.handles) !== undefined ? { accounts: num(k.handles)! } : {}), ...(from !== undefined ? { from } : {}) }
}

// ---------------------------------------------------------------------------------------------------------
// The topic.

/** A pane's part: what was last read for this token and when (null while its first read runs), or why not. */
export interface Part<T> {
  at: number | null
  data: T | null
  /** The last read failed: `data` is the last good one's (for this token), and this says why. */
  failed?: { at: number; words: string }
  /** Never read: Hacc off, no key it takes, or a plan that doesn't reach it. Said once, with no read. */
  cant?: string
}

export interface ResearchView {
  token: ResearchToken | null
  check?: { candle: Part<CandleCheck>; hacc: Part<HaccFacts> }
  traders?: Part<TraderRow[]>
  signals?: Part<SignalRow[]>
  mentions?: Part<Mentions>
}

/** A `research` subscription's filter: the panes it shows. */
export interface ResearchFilter {
  parts: ResearchPart[]
}

export const researchTopicFilter = {
  parse(raw: unknown): ResearchFilter | { problem: string } {
    const parts = (raw as { parts?: unknown } | null)?.parts
    if (!Array.isArray(parts) || parts.length === 0) return { problem: `research takes {parts: [...]}, from ${RESEARCH_PARTS.join(", ")}.` }
    const bad = parts.find((p) => !isResearchPart(p))
    if (bad !== undefined) return { problem: `No Research pane called ${terminalText(String(bad), { maxLength: 40 })}: they're ${RESEARCH_PARTS.join(", ")}.` }
    return { parts: [...new Set(parts as ResearchPart[])] }
  },
  apply(data: unknown, filter: ResearchFilter): unknown | undefined {
    const view = (data ?? { token: null }) as ResearchView
    const cut: ResearchView = { token: view.token }
    for (const p of filter.parts) if (view[p]) (cut as unknown as Record<string, unknown>)[p] = view[p]
    return cut
  },
}

/** Candle's check, as the token pane's read left it: the answer, and when. */
export interface CheckRead {
  at: number
  outcome: ToolOutcome
}

interface Held {
  at: number
  answer: ResearchAnswer
}

const tokenKey = (t: { chain: Chain; mint: string }) => `${t.chain}:${t.mint}`

export class ResearchReads {
  /** Each read's last answer, by read and token, reused for a minute. */
  private readonly answers = new Map<string, Held>()
  /** Each read's last good answer, by read and token: shown under a failed read's words. */
  private readonly good = new Map<string, Held>()
  private readonly reading = new Set<string>()
  /** A read whose key was refused: tried again at this time, by read and token. */
  private readonly againAt = new Map<string, number>()
  /** When Candle's check was last asked again, by token. */
  private readonly rechecked = new Map<string, number>()
  /** Hacc's words for a read it refused for the plan, by read. */
  private readonly planSaid = new Map<HaccRead, string>()
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private shownFor: string | null = null

  constructor(
    private readonly deps: {
      /** The linked token, if any. */
      linked: () => ResearchToken | null
      /** The parts the views' subscriptions name now. */
      wanted: () => ReadonlySet<ResearchPart>
      /** One of Hacc's reads, with the first agent Hacc is offered to. */
      hacc: (read: HaccRead, route: string, query: Record<string, string | number>, cacheMs: number) => Promise<ResearchAnswer>
      /** Why Hacc can't be read at all now (off, no key, every key refused); undefined when it can. */
      haccCant: () => string | undefined
      /** The account's plan, for what it reaches; undefined until read (Free's reads are tried). */
      plan: () => HaccPlan | undefined
      /** Reads Hacc refused for the plan: held, and not asked again, until the plan changes. */
      held?: Pick<PlanHeld, "hold" | "isHeld">
      /** Candle's check of the linked token, as the token pane last read it. */
      check: () => CheckRead | null
      /** Reads the linked token's check again. */
      recheck: () => Promise<void>
      now: () => number
      publish: (view: ResearchView) => void
    },
  ) {}

  /** The reads the wanted parts need, without a read the plan doesn't reach or Hacc refused for it. */
  private reads(wanted: ReadonlySet<ResearchPart>): HaccRead[] {
    return [...new Set([...wanted].flatMap((p) => NEEDS[p]))].filter((r) => reaches(this.deps.plan(), READ_PLAN[r]) && !this.planHeld(r))
  }

  private planHeld(read: HaccRead): boolean {
    return this.deps.held?.isHeld(`research ${read}`, this.deps.plan()) ?? false
  }

  view(): ResearchView {
    const token = this.deps.linked()
    if (!token) return { token: null }
    const wanted = this.deps.wanted()
    const out: ResearchView = { token }
    const part = <T>(read: HaccRead, parse: (body: unknown) => T | undefined, also?: HaccRead): Part<T> => {
      const cant = this.deps.haccCant() ?? this.planWords(read) ?? (also ? this.planWords(also) : undefined)
      if (cant) return { at: null, data: null, cant }
      const held = this.answers.get(`${read}:${tokenKey(token)}`)
      if (!held) return { at: null, data: null }
      if (held.answer.kind === "ok") {
        const unread = refreshRefused(held.answer.body)
        const data = unread ? undefined : parse(held.answer.body)
        if (data === undefined && unread) {
          const last = this.good.get(`${read}:${tokenKey(token)}`)
          const before = last && last.answer.kind === "ok" ? (parse(last.answer.body) ?? null) : null
          return { at: before ? last!.at : held.at, data: before, failed: { at: held.at, words: `Hacc couldn't read it (Hacc: ${unread})` } }
        }
        return { at: held.at, data: data ?? null, ...(data === undefined ? { failed: { at: held.at, words: "Hacc's answer had nothing to show" } } : {}) }
      }
      const last = this.good.get(`${read}:${tokenKey(token)}`)
      const data = last && last.answer.kind === "ok" ? (parse(last.answer.body) ?? null) : null
      return { at: last?.at ?? held.at, data, failed: { at: held.at, words: held.answer.words } }
    }
    if (wanted.has("check")) {
      const c = this.deps.check()
      const read = c?.outcome.kind === "ok" ? candleCheck(c.outcome.result) : undefined
      const candle: Part<CandleCheck> = !c
        ? { at: null, data: null }
        : read
          ? { at: c.at, data: read }
          : { at: c.at, data: null, failed: { at: c.at, words: c.outcome.kind === "error" ? c.outcome.code : c.outcome.kind === "ok" ? "Candle's answer had no check" : "Candle didn't answer" } }
      const profile = part("profile", (b) => b)
      const overview = part("overview", (b) => b)
      const hacc: Part<HaccFacts> = profile.cant
        ? { at: null, data: null, cant: profile.cant }
        : { at: profile.at ?? overview.at, data: profile.data || overview.data ? haccFacts(profile.data, overview.data) : null, ...(profile.failed ? { failed: profile.failed } : overview.failed ? { failed: overview.failed } : {}) }
      out.check = { candle, hacc }
    }
    if (wanted.has("traders")) out.traders = part("traders", traderRows)
    if (wanted.has("signals")) out.signals = part("signals", tokenSignalRows)
    if (wanted.has("mentions")) out.mentions = part("overview", mentionRows)
    return out
  }

  /** "Top traders need Pro on Hacc.", when the account's plan doesn't reach the read, or Hacc refused it for the plan. */
  private planWords(read: HaccRead): string | undefined {
    const needs = READ_PLAN[read]
    if (!reaches(this.deps.plan(), needs)) return `${READ_WORDS[read]} ${needs === "max" ? "Max" : "Pro"} on Hacc.`
    if (this.planHeld(read)) return `${READ_WORDS[read]} a higher plan on Hacc than this account's${this.planSaid.has(read) ? ` (Hacc: ${this.planSaid.get(read)})` : ""}.`
    return undefined
  }

  /** Reads a minute it would make now, for the doctor and a test. */
  demand(): number {
    if (!this.running || !this.deps.linked()) return 0
    return this.reads(this.deps.wanted()).length
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.poke()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** The subscriptions or the link changed: read what's newly wanted now, and plan the next turn again. */
  poke(): void {
    if (!this.running) return
    clearTimeout(this.timer)
    this.timer = undefined
    const token = this.deps.linked()
    const now = token ? tokenKey(token) : null
    // The link moved: the panes show the new token at once, as reading, rather than the old one's rows.
    if (now !== this.shownFor) {
      this.shownFor = now
      if (this.deps.wanted().size > 0) this.deps.publish(this.view())
    }
    void this.tick()
  }

  /** One turn: every read that's due for the linked token, together, and Candle's check if it's old. */
  async step(): Promise<void> {
    const token = this.deps.linked()
    if (!this.running || !token) return
    const wanted = this.deps.wanted()
    if (wanted.size === 0 || this.deps.haccCant()) {
      if (wanted.has("check")) await this.maybeRecheck(token)
      return
    }
    const now = this.deps.now()
    this.prune(now)
    const due = this.reads(wanted).filter((r) => {
      const key = `${r}:${tokenKey(token)}`
      const held = this.answers.get(key)
      return !this.reading.has(key) && (this.againAt.get(key) ?? 0) <= now + 250 && (!held || now - held.at >= READ_MS - 250)
    })
    await Promise.all([...due.map((r) => this.read(r, token)), ...(wanted.has("check") ? [this.maybeRecheck(token)] : [])])
  }

  private async tick(): Promise<void> {
    await this.step().catch(() => {})
    if (!this.running || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, this.nextMs())
    this.timer.unref?.()
  }

  /** Until the next read is due for the linked token, at least a second; a minute when nothing's wanted. */
  nextMs(): number {
    const token = this.deps.linked()
    const wanted = this.deps.wanted()
    if (!token || wanted.size === 0) return READ_MS
    const now = this.deps.now()
    const dues = this.reads(wanted).map((r) => {
      const key = `${r}:${tokenKey(token)}`
      const held = this.answers.get(key)
      return Math.max(held ? held.at + READ_MS - now : 0, (this.againAt.get(key) ?? 0) - now)
    })
    if (wanted.has("check")) dues.push((this.rechecked.get(tokenKey(token)) ?? this.deps.check()?.at ?? now) + CHECK_MS - now)
    return Math.max(1_000, Math.min(READ_MS, ...dues.map((d) => Math.ceil(d))))
  }

  private async read(read: HaccRead, token: ResearchToken): Promise<void> {
    const key = `${read}:${tokenKey(token)}`
    this.reading.add(key)
    const { route, query, cacheMs } = researchRequest(read, token.chain, token.mint)
    const at = this.deps.now()
    let answer: ResearchAnswer
    try {
      answer = await this.deps.hacc(read, route, query, cacheMs)
    } catch (e) {
      answer = { kind: "refused", words: e instanceof Error ? e.message : String(e) }
    } finally {
      this.reading.delete(key)
    }
    if (answer.kind === "refused" && answer.again) {
      this.againAt.set(key, this.deps.now() + AGAIN_MS)
      return
    }
    this.againAt.delete(key)
    if (answer.kind === "refused" && answer.plan) {
      this.planSaid.set(read, terminalText(answer.words.replace(/\.\s*$/, ""), { maxLength: 200 }))
      this.deps.held?.hold(`research ${read}`, this.deps.plan())
    }
    if (answer.kind === "refused") answer = { kind: "refused", words: terminalText(answer.words, { maxLength: 200 }) }
    const held = { at, answer }
    this.answers.set(key, held)
    if (answer.kind === "ok" && !refreshRefused(answer.body)) this.good.set(key, held)
    // An answer for a token the link has left is kept for its minute, and shown only when it's back.
    const linked = this.deps.linked()
    if (linked && tokenKey(linked) === tokenKey(token)) this.deps.publish(this.view())
  }

  /** Candle's check again, when the token pane's read is older than CHECK_MS: once in that time, a failed read included. */
  private async maybeRecheck(token: ResearchToken): Promise<void> {
    const key = tokenKey(token)
    const now = this.deps.now()
    const last = Math.max(this.rechecked.get(key) ?? 0, this.deps.check()?.at ?? 0)
    if (now - last < CHECK_MS - 250) return
    this.rechecked.set(key, now)
    await this.deps.recheck().catch(() => {})
    const linked = this.deps.linked()
    if (linked && tokenKey(linked) === key) this.deps.publish(this.view())
  }

  /** Answers older than a read's minute for tokens no longer linked go. */
  private prune(now: number): void {
    const linked = this.deps.linked()
    const keep = linked ? tokenKey(linked) : ""
    for (const map of [this.answers, this.good]) for (const [k, h] of map) if (now - h.at >= READ_MS && !k.endsWith(`:${keep}`)) map.delete(k)
    for (const [k, at] of this.rechecked) if (now - at >= CHECK_MS && k !== keep) this.rechecked.delete(k)
  }
}
