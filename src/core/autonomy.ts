// Autonomy per wallet: each wallet the agents pay from asks every time (the default) or trades inside
// limits, with two figures of its own: per trade, and per day across every agent that pays from it,
// counting only what ran without a card, so it means "what ran without me today". Over either figure a
// trade is a card; over an agent's own Candle Harness limit it's refused, as before. cards.ts runs the trades; this is
// the setting.
//
// - Only the person turns it on or raises a figure, from a main view (`autonomy.set`). A harness, a popped
//   view and every agent tool are refused: no agent widens its own leash.
// - The agent may narrow it, back to asking or to lower figures: that's less access, so a one-press card
//   (kind `autonomy`), checked again when it runs. A proposal that would widen anything is refused.
// - The kill switch doesn't change it: the pause refuses buys and swaps with no card as it refuses cards.
// - Kept by wallet address in `state/autonomy.json` (0600), and journalled. A wallet that's gone (retired,
//   swept, unbound) keeps its entry, shown as gone, and an address never applies to another wallet. There's
//   no config key: a hand-edited file can't turn it on unseen.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import { invalidParams, refused } from "../shared/rpc"
import type { Mode } from "./classify"
import type { Mapped, Operation } from "./execute"
import type { Journal } from "./journal"
import { usd, type WalletFigures } from "./limits"
import type { CardDesk, CardView, FaceClient } from "./tool-face"

export type WalletSetting = { setting: "ask" } | { setting: "inside"; perTradeUsd: number; perDayUsd: number }

export const ASK: WalletSetting = { setting: "ask" }

export interface AutonomyEntry {
  wallet: string
  /** The wallet's name when it was set ("embedded", or a TEE wallet's label), for a wallet that's gone since. */
  name?: string
  value: WalletSetting
  at: string
  /** Who set it: a view's client id, or "card" for the agent's narrowing the person approved. */
  by: string
}

/** No figure above this: a typo's extra zeros, not a setting. */
const MAX_FIGURE_USD = 1_000_000

/** A positive dollar amount, from a number or a typed "$1.50", to the cent; undefined when it isn't one. */
export function dollars(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\$?\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value.replace(/[$\s]/g, "")) : NaN
  if (!Number.isFinite(n)) return undefined
  const cents = Math.round(n * 100) / 100
  return cents >= 0.01 && cents <= MAX_FIGURE_USD ? cents : undefined
}

/** A setting from a method's or a tool's arguments, or why it isn't one. */
export function parseSetting(params: { setting?: unknown; perTradeUsd?: unknown; perDayUsd?: unknown }): { ok: true; value: WalletSetting } | { ok: false; message: string } {
  if (params.setting === "ask") return { ok: true, value: ASK }
  if (params.setting !== "inside") return { ok: false, message: 'setting is "ask" (every trade is a card) or "inside" (trades inside its figures run without one).' }
  const perTradeUsd = dollars(params.perTradeUsd)
  const perDayUsd = dollars(params.perDayUsd)
  if (perTradeUsd === undefined || perDayUsd === undefined) return { ok: false, message: `perTradeUsd and perDayUsd are each a dollar amount from $0.01 to ${usd(MAX_FIGURE_USD)}.` }
  // A day figure under the trade figure would make the trade figure mean nothing.
  if (perDayUsd < perTradeUsd) return { ok: false, message: `The day figure, ${usd(perDayUsd)}, is under a trade's, ${usd(perTradeUsd)}: a day holds at least one trade.` }
  return { ok: true, value: { setting: "inside", perTradeUsd, perDayUsd } }
}

export const sameSetting = (a: WalletSetting, b: WalletSetting): boolean =>
  a.setting === b.setting && (a.setting === "ask" || (b.setting === "inside" && a.perTradeUsd === b.perTradeUsd && a.perDayUsd === b.perDayUsd))

/** What `to` would widen over `from`, in words; empty when it widens nothing. */
export function widens(from: WalletSetting, to: WalletSetting): string[] {
  if (to.setting === "ask") return []
  if (from.setting === "ask") return ["it turns on trading without a card"]
  const out: string[] = []
  if (to.perTradeUsd > from.perTradeUsd) out.push(`it raises a trade from ${usd(from.perTradeUsd)} to ${usd(to.perTradeUsd)}`)
  if (to.perDayUsd > from.perDayUsd) out.push(`it raises a day from ${usd(from.perDayUsd)} to ${usd(to.perDayUsd)}`)
  return out
}

/** A setting in words: "asks every time", or "trades inside limits · $1.00 a trade, $5.00 a day without a card". */
export function settingWords(value: WalletSetting): string {
  return value.setting === "ask" ? "asks every time" : `trades inside limits · ${usd(value.perTradeUsd)} a trade, ${usd(value.perDayUsd)} a day without a card`
}

/** A narrowing card's title: what the wallet goes to. */
export function narrowingTitle(name: string, to: WalletSetting): string {
  return to.setting === "ask"
    ? `LESS AUTONOMY · ${name}: ask every time`
    : `LESS AUTONOMY · ${name}: ${usd(to.perTradeUsd)} a trade, ${usd(to.perDayUsd)} a day without a card`
}

function entryFrom(raw: unknown): AutonomyEntry | undefined {
  const e = raw as Partial<AutonomyEntry> | null
  if (!e || typeof e.wallet !== "string" || e.wallet.length === 0 || e.wallet.length > 64 || typeof e.at !== "string" || typeof e.by !== "string") return undefined
  const parsed = parseSetting((e.value ?? {}) as Record<string, unknown>)
  if (!parsed.ok) return undefined
  return { wallet: e.wallet, ...(typeof e.name === "string" ? { name: e.name.slice(0, 64) } : {}), value: parsed.value, at: e.at, by: e.by }
}

export class Autonomy {
  private readonly entries = new Map<string, AutonomyEntry>()

  /** Opens the setting as the last core left it. An entry that doesn't read is dropped, so that wallet asks. */
  constructor(private readonly path: string) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as { wallets?: unknown }
      for (const raw of Array.isArray(saved.wallets) ? saved.wallets : []) {
        const entry = entryFrom(raw)
        if (entry) this.entries.set(entry.wallet, entry)
      }
    } catch {}
  }

  /** The wallet's setting: "ask" unless the person set it otherwise. */
  get(wallet: string): WalletSetting {
    return this.entries.get(wallet)?.value ?? ASK
  }

  entry(wallet: string): AutonomyEntry | undefined {
    return this.entries.get(wallet)
  }

  all(): AutonomyEntry[] {
    return [...this.entries.values()]
  }

  /** Sets one wallet and saves the file; the caller has checked who may. Returns what it was. */
  async set(wallet: string, value: WalletSetting, by: string, now: number, name?: string): Promise<WalletSetting> {
    const from = this.get(wallet)
    this.entries.set(wallet, { wallet, ...(name ? { name } : {}), value, at: new Date(now).toISOString(), by })
    const temp = `${this.path}.tmp-${randomBytes(6).toString("base64url")}`
    await writeFile(temp, `${JSON.stringify({ wallets: this.all() })}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.path)
    return from
  }
}

// --- The desk: who may set it, the agent's narrowing card, and the topic ---

/** A wallet the agents pay from, as the desk sees it: by address, with its name and who pays from it. */
export interface PayWallet {
  address: string
  /** "embedded", or a TEE wallet's label (else its short address). */
  name: string
  kind: "embedded" | "tee"
  agents: string[]
}

/** One wallet on the `autonomy` topic. */
export interface AutonomyWallet {
  wallet: string
  name: string
  kind?: "embedded" | "tee"
  setting: "ask" | "inside"
  perTradeUsd?: number
  perDayUsd?: number
  /** Spent today without a card, by every agent paying from it. */
  usedTodayUsd: number
  agents: string[]
  /** No agent here pays from it now: retired, swept or unbound. Its entry is kept, and applies to nothing. */
  gone?: true
  setAt?: string
  /**
   * What the person should read beside it: an agent's own Candle Harness limit that binds before the
   * wallet's figure, or a key Candle doesn't cap, where only the Candle Harness's limits hold.
   */
  notes: { kind: "binds-first" | "uncapped"; agent: string; words: string }[]
}

export interface AutonomyTopic {
  /** Whether every agent's wallets have been read: until then, a wallet isn't called gone. */
  read: boolean
  wallets: AutonomyWallet[]
}

export interface AutonomyDeskDeps {
  autonomy: Autonomy
  journal: Journal
  mode: () => Mode
  now: () => number
  /** The wallets the agents pay from now, and whether they've all been read. */
  wallets: () => { list: PayWallet[]; read: boolean }
  /** Spent today without a card from this wallet (`walletSpend`). */
  usedToday: (wallet: string) => number
  agentLimits: (agent: string) => { perTradeUsd: number; perDayUsd: number } | undefined
  /** Whether Candle caps the agent's key: undefined before its status is read. */
  candleCaps: (agent: string) => boolean | undefined
  propose: CardDesk["propose"]
  onChange: () => void
}

const matches = (w: PayWallet, word: string) =>
  word === w.address || (w.kind === "embedded" ? word.toLowerCase() === "embedded" : word.toLowerCase() === w.name.toLowerCase())

/** The person's own words for a wallet: "the embedded wallet", or a TEE wallet's name. */
const walletWords = (name: string) => (name === "embedded" ? "the embedded wallet" : name)

export class AutonomyDesk {
  constructor(private readonly deps: AutonomyDeskDeps) {}

  /**
   * The person's setting, from a main view only: it turns a wallet on, raises or lowers its
   * figures, or sends it back to asking. A popped view is refused; a harness never reaches this (METHOD_ROLES).
   */
  async set(from: { clientId: string; popped: boolean }, params: Record<string, unknown>): Promise<{ wallet: string; name: string; was: WalletSetting; now: WalletSetting }> {
    if (from.popped) throw refused("MAIN_VIEW_ONLY", "Autonomy is set in the main window's settings ▾ → approvals, not from a popped pane.")
    if (typeof params.wallet !== "string" || params.wallet.length === 0 || params.wallet.length > 64) throw invalidParams("wallet names a wallet by address, \"embedded\" or a TEE wallet's label.")
    const parsed = parseSetting(params)
    if (!parsed.ok) throw invalidParams(parsed.message)
    const { list } = this.deps.wallets()
    const known = list.find((w) => matches(w, params.wallet as string))
    // A wallet that's gone may only go back to asking: nothing pays from it, and it's never turned on unseen.
    const kept = known ? undefined : this.deps.autonomy.entry(params.wallet)
    if (!known && !(kept && parsed.value.setting === "ask")) {
      const names = list.map((w) => w.name)
      throw refused("UNKNOWN_WALLET", `No agent here pays from a wallet named ${params.wallet}. The wallets: ${names.join(", ") || "none read yet"}.`)
    }
    const wallet = known?.address ?? kept!.wallet
    const name = known?.name ?? kept!.name ?? wallet
    const was = await this.apply(wallet, name, parsed.value, from.clientId, { how: "view" })
    return { wallet, name, was, now: parsed.value }
  }

  /**
   * The agent's narrowing: back to asking, or lower figures, on a wallet it pays from. A
   * one-press card; anything that would widen is refused at proposal, naming the approvals menu.
   */
  async propose(client: FaceClient, args: Record<string, unknown>, reason?: string): Promise<CardView> {
    const word = args.wallet
    const own = this.deps.wallets().list.filter((w) => w.agents.includes(client.agent))
    const wallet = typeof word === "string" ? own.find((w) => matches(w, word)) : undefined
    if (!wallet) throw refused("UNKNOWN_WALLET", `${client.agent} pays from ${own.map((w) => w.name).join(", ") || "no wallet read yet"}; name one of those.`)
    const current = this.deps.autonomy.get(wallet.address)
    // A figure left out stays as it is: "lower the day figure to $2" names one.
    const merged = args.setting === "inside" && current.setting === "inside" ? { perTradeUsd: current.perTradeUsd, perDayUsd: current.perDayUsd, ...args } : args
    const parsed = parseSetting(merged)
    if (!parsed.ok) throw refused("INVALID_SETTING", parsed.message)
    const wider = widens(current, parsed.value)
    if (wider.length) {
      throw refused("WIDENS_AUTONOMY", `That would widen what runs without a card on ${walletWords(wallet.name)}: ${wider.join(", and ")}. Only the person can, in settings ▾ → approvals. Nothing was proposed.`)
    }
    if (sameSetting(current, parsed.value)) throw refused("ALREADY_SET", `${walletWords(wallet.name)} already ${settingWords(current)}. Nothing to change.`)
    const title = narrowingTitle(wallet.name, parsed.value)
    return this.deps.propose({
      client,
      agent: client.agent,
      tool: "harness_limits",
      args,
      params: { wallet: wallet.address, name: wallet.name, to: parsed.value },
      kind: "autonomy",
      idKey: "coreOpId",
      title,
      ...(wallet.agents.length > 1 ? { warning: `${wallet.agents.filter((a) => a !== client.agent).join(", ")} also pay${wallet.agents.length > 2 ? "" : "s"} from it: this holds for them too.` } : {}),
      ...(reason ? { reason } : {}),
    })
  }

  /** An approved narrowing, checked again against the setting now: the person may have changed it since. */
  async run(op: Operation): Promise<Mapped> {
    const p = op.params as { wallet: string; name: string; to: WalletSetting }
    const current = this.deps.autonomy.get(p.wallet)
    if (widens(current, p.to).length) {
      return { state: "refused", error: { code: "WIDENS_AUTONOMY", message: `${walletWords(p.name)} was set lower since this card was made, so it would now widen it. Nothing changed.`, retryable: false } }
    }
    if (!sameSetting(current, p.to)) await this.apply(p.wallet, p.name, p.to, "card", { how: "card", agent: op.agent, opId: op.opId })
    return { state: "succeeded", result: { done: true, wallet: p.name, now: settingWords(p.to) } }
  }

  /** A narrowing a restart cut off: the setting says whether it took. */
  read(op: Operation): Mapped {
    const p = op.params as { wallet: string; name: string; to: WalletSetting }
    if (sameSetting(this.deps.autonomy.get(p.wallet), p.to)) return { state: "succeeded", result: { done: true, wallet: p.name, now: settingWords(p.to), readBack: "Read from the core's setting: it took." } }
    return { state: "failed", error: { code: "NOT_APPLIED", message: `The core stopped before it took: ${walletWords(p.name)} still ${settingWords(this.deps.autonomy.get(p.wallet))}.`, retryable: false } }
  }

  /** Each wallet that trades inside limits and that the agent pays from, with today's use, for its limit lines. */
  figures(agent: string): WalletFigures[] {
    return this.deps.wallets().list.flatMap((w) => {
      const v = this.deps.autonomy.get(w.address)
      return w.agents.includes(agent) && v.setting === "inside" ? [{ wallet: w.address, name: w.name, perTradeUsd: v.perTradeUsd, perDayUsd: v.perDayUsd, usedUsd: this.deps.usedToday(w.address) }] : []
    })
  }

  /** The wallets that trade inside limits now, for the kill report. */
  inside(): { wallet: string; name: string }[] {
    return this.deps.wallets().list.filter((w) => this.deps.autonomy.get(w.address).setting === "inside").map((w) => ({ wallet: w.address, name: w.name }))
  }

  view(): AutonomyTopic {
    const { list, read } = this.deps.wallets()
    const out: AutonomyWallet[] = list.map((w) => this.walletView(w.address, w.name, w.agents, w.kind))
    for (const e of this.deps.autonomy.all()) {
      if (!list.some((w) => w.address === e.wallet)) out.push({ ...this.walletView(e.wallet, e.name ?? e.wallet, []), ...(read ? { gone: true as const } : {}) })
    }
    return { read, wallets: out }
  }

  private walletView(wallet: string, name: string, agents: string[], kind?: "embedded" | "tee"): AutonomyWallet {
    const entry = this.deps.autonomy.entry(wallet)
    const v = entry?.value ?? ASK
    const notes: AutonomyWallet["notes"] = []
    if (v.setting === "inside") {
      for (const agent of agents) {
        const own = this.deps.agentLimits(agent)
        if (own && own.perTradeUsd < v.perTradeUsd) notes.push({ kind: "binds-first", agent, words: `${agent}'s own limit, ${usd(own.perTradeUsd)} a trade, binds first.` })
        else if (own && own.perDayUsd < v.perDayUsd) notes.push({ kind: "binds-first", agent, words: `${agent}'s own limit, ${usd(own.perDayUsd)} a day, binds first.` })
        if (this.deps.candleCaps(agent) === false) notes.push({ kind: "uncapped", agent, words: `Candle doesn't cap ${agent}'s key. Only the Candle Harness's limits hold here.` })
      }
    }
    return {
      wallet,
      name,
      ...(kind ? { kind } : {}),
      setting: v.setting,
      ...(v.setting === "inside" ? { perTradeUsd: v.perTradeUsd, perDayUsd: v.perDayUsd } : {}),
      usedTodayUsd: this.deps.usedToday(wallet),
      agents,
      ...(entry ? { setAt: entry.at } : {}),
      notes,
    }
  }

  private async apply(wallet: string, name: string, to: WalletSetting, by: string, how: { how: "view" | "card"; agent?: string; opId?: string }): Promise<WalletSetting> {
    const was = await this.deps.autonomy.set(wallet, to, by, this.deps.now(), name)
    await this.deps.journal.append({ type: "autonomy.set", mode: this.deps.mode(), wallet, walletName: name, from: was, to, by, ...how })
    this.deps.onChange()
    return was
  }
}
