// Screens drawn from realistic data, for frame checks: two agents, an embedded and a
// TEE wallet, a trending list as long as Candle's (11 tokens), a long Activity, an open card and a
// rendered reply with a table. Every name and address here is made up.
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../src/core/client"
import type { PortfolioView } from "../src/core/portfolio-view"
import type { TokenView } from "../src/core/token-watch"
import type { WalletsTopic } from "../src/core/agent-wallets"
import { App, type Session } from "../src/view/app"
import { type LayoutStore, memoryStore } from "../src/view/layouts-store"
import { KNOWN_TABS, layoutsText, parseLayouts } from "../src/view/layouts-file"
import type { ThemeStore } from "../src/view/themes"
import type { BuildSpawner } from "../src/view/build-process"
import type { KillReport } from "../src/core/kill"
import type { EngineTopic } from "../src/view/panes/engines"
import type { StatusView, ViewCard } from "../src/view/store"
import { type PnlVariant, pnlScene, pnlSeriesScene } from "./pnl-scene"
import { type ResearchVariant, researchScene, YOUNG_MINT, YOUNG_SYMBOL, youngMarket } from "./research-scene"
import { journalScenePage, journalSceneRows } from "./journal-scene"

export const CLOCK = 1_800_000_000_000
/** How far a scene's clock has moved past CLOCK: a test that needs time to pass moves it, and each scene starts at 0. */
let moved = 0
export const advanceClock = (ms: number): void => {
  moved += ms
}

const pad = (s: string) => s.padEnd(43, "1")
export const MINT = pad("JupFake")
export const EMBEDDED = pad("EmbFake")
export const TEE = pad("TeeFake")

export class SceneSession implements Session {
  requests: { method: string; params: Record<string, unknown> }[] = []
  /** Each set of extra topics the view asked for, in order (the Signals pane's, Candle's lists), and each one's filters. */
  wanted: string[][] = []
  filters: Record<string, unknown>[] = []
  /** The core's id for this view, as the Away summary names the view whose attach made it. */
  clientIds(): readonly string[] {
    return ["v1"]
  }
  want(topics: readonly string[], filters: Record<string, unknown> = {}): void {
    this.wanted.push([...topics])
    this.filters.push(filters)
  }
  private listeners: ((e: CoreEventParams) => void)[] = []
  private seq = 0
  /** Each tab's Signals choice, kept as the core keeps it, and said on `views`. */
  private signalsChoices: Record<string, unknown>[] = []
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === "view.signals") {
      const { at, mine, pattern, chain } = params as { at: string; mine?: boolean; pattern?: string | null; chain?: string | null }
      const choice = { at, ...(mine ? { mine: true } : {}), ...(pattern ? { pattern } : {}), ...(chain ? { chain } : {}) }
      this.signalsChoices = [...this.signalsChoices.filter((c) => c.at !== at), ...(Object.keys(choice).length > 1 ? [choice] : [])]
      this.push("views", { link: null, pins: [], signals: this.signalsChoices, popped: [] })
      return { signals: this.signalsChoices } as T
    }
    // The P&L chart's points, drawn from the scene's samples over the span asked for.
    // The Journal: the scene's rows, answered by the core's own query.
    if (method === "journal.query") return (await journalScenePage(CLOCK, params, this.journalEmpty)) as T
    if (method === "journal.rows") return { rows: journalSceneRows(CLOCK).filter((r) => (params.seqs as number[]).includes(r.seq)) } as T
    // The Build pane's choices, kept as the core keeps them, and its token.
    if (method === "build.prefs") {
      const set = params.set as Partial<SceneSession["buildPrefs"]> | undefined
      if (set) this.buildPrefs = { ...this.buildPrefs, ...set }
      return { ...this.buildPrefs } as T
    }
    if (method === "build.open") {
      // Each core's session is a new token: the first is the scene's own, a reopen after a restart the next.
      const n = ++this.buildOpens
      return { tokenId: n === 1 ? "tok-build" : `tok-build-${n}`, token: n === 1 ? "scene-build-token" : `scene-build-token-${n}`, socketPath: this.buildSocketPath, agent: params.agent, gate: this.buildGate } as T
    }
    // A code bot's log, as the supervisor keeps it: its own lines, its stderr, and the Candle Harness's own.
    if (method === "bots.logs") return { lines: botLogScene(CLOCK), file: `/srv/state/bots/${String(params.name)}.log` } as T
    if (method === "pnl.series") return { points: this.pnlSamples === "none" ? [] : pnlSeriesScene(CLOCK, Math.max(Number(params.from), this.pnlSamplesFrom), Number(params.points) || 120, { change: this.pnlChange }) } as T
    return {} as T
  }
  /** The Build pane's folder and harness, as the core keeps them: a fresh install's until the first open. */
  buildPrefs: { folder: string; harness?: string; opened: boolean; bins: Record<string, string> } = { folder: "~/candle-bots", opened: false, bins: {} }
  /** How many Build sessions were opened, and where the scene's core socket is (the pane's token file goes beside it). */
  buildOpens = 0
  buildSocketPath = "/run/scene/core.sock"
  private lostListeners: (() => void)[] = []
  onLost(listener: () => void): void {
    this.lostListeners.push(listener)
  }
  /** The core goes away while the view is open, as a restart does: the view's next status is the new core's. */
  lose(): void {
    for (const l of this.lostListeners) l()
  }
  /** Free's words for code bots, where the scene is on Free. */
  buildGate: { words: string; fix?: string } | null = null
  /** A fresh install's journal: nothing recorded. */
  journalEmpty = false
  /** The scene's P&L samples: a day's with a gap where the core wasn't running, or none (a fresh install). */
  pnlSamples: "gap" | "none" = "gap"
  /** Where the scene's samples start, as the core's series starts at the first sample. */
  pnlSamplesFrom = CLOCK - 86_400_000 + 60_000
  /** The window's figure, which the scene's samples move by. */
  pnlChange = 0.31
  onEvent(listener: (e: CoreEventParams) => void): void {
    this.listeners.push(listener)
  }
  push(topic: string, data: unknown, snapshot = false): void {
    for (const l of this.listeners) l({ topic, seq: ++this.seq, data, ...(snapshot ? { snapshot } : {}) })
  }
}

/** A code bot's last two hours of log, as the supervisor writes it. */
export function botLogScene(clock: number): string[] {
  const t = (minsAgo: number) => new Date(clock - minsAgo * 60_000).toISOString()
  return [
    `${t(130)} ---  started: bun run bot.ts in ~/candle-bots/momentum · code 3f9a…c21e · lockfile 81d0…07b2 · pid 48211`,
    `${t(130)} out  connected as momentum (live)`,
    `${t(40)} out  signal: 4 wallets bought WIFY, mcap $212K`,
    `${t(40)} out  buy $2.00 of WIFY asked`,
    `${t(25)} out  signal: 4 wallets bought BONKY, mcap $188K`,
    `${t(25)} out  buy $2.00 of BONKY asked, exits -30% / +80% / 24h`,
    `${t(16)} out  skipped MOONX: spread 9.4%`,
    `${t(9)} err  warn: Hacc read slow (2.3 s), retrying`,
    `${t(1)} out  report: ok · watching 38 tokens`,
  ]
}

export const status: StatusView = {
  agents: [
    { name: "agent-a", candle: "ready", spentTodayUsd: 12, limits: { perTradeUsd: 25, perDayUsd: 100 } },
    { name: "agent-b", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 10, perDayUsd: 50 } },
  ],
  activeAgent: "agent-a",
  mode: "live",
  paused: false,
  exposureUsd: 412.5,
  // The P&L window's figure: Candle's, over the last 24 hours.
  pnl: { usd: 3.4, label: "24h", from: 0, short: false },
  pricesAgeMs: 2_000,
}

const NAMES = ["Orbit", "Kettle", "Lumen", "Basalt", "Fennel", "Quill", "Marrow", "Tundra", "Saffron", "Pylon", "Wisp"]
const trending: NonNullable<TokenView["trending"]> = {
  bucket: "onfire",
  at: CLOCK - 5_000,
  // Figures shaped like Candle's live list: prices far below a cent, hours of +2,439% and -95%, one market cap missing.
  rows: NAMES.map((name, i) => ({
    mint: pad(`Trend${i}`),
    symbol: name.toUpperCase().slice(0, 5),
    name: `${name} Coin`,
    marketCap: i === 5 ? null : Math.round(4_200_000 / (i + 1)),
    priceUsd: i === 5 ? 0.0000031718 : 4.2 / (i + 1) / 1000,
    change1h: [0.1015, 0.003, 1.18, 0.918, 0.1886, -0.9261, 0.1443, -0.8748, 24.3897, -0.936, -0.9571][i]!,
  })),
}

// Candle's other three lists, shaped as recorded from Candle: New at 20 with every age and
// market cap, Graduated short (6), Final Stretch at 20 with the curve's progress and last trade on every row
// but a market cap on only some and a price on fewer. On Fire is the trending list above.
const NEW_NAMES = ["Sprig", "Ember", "Cobalt", "Thistle", "Gully", "Rook", "Nimbus", "Pebble", "Juniper", "Vesper", "Mica", "Larch", "Brine", "Cinder", "Flint", "Hazel", "Opal", "Reed", "Sorrel", "Tansy"]
const feedList = (bucket: string, rows: Record<string, unknown>[], matched: number) => ({ bucket, at: CLOCK - 4_000, rows, matched })
/** Where each row launched: mostly pump.fun, as recorded, with a bonk and a Candle launch among them. */
const WHERE = ["pump", "pump", "bonk", "pump", "candle", "pump", "pump"]
const feeds = (finalStretch: "on" | "off" | "behind") => ({
  new: feedList(
    "new",
    NEW_NAMES.map((name, i) => ({
      mint: pad(`New${i}`),
      symbol: name.toUpperCase().slice(0, 6),
      name: `${name} Token`,
      marketCap: Math.round(3_900 + ((i * 7919) % 41_000)),
      priceUsd: (3_900 + ((i * 7919) % 41_000)) / 1e9,
      change1h: i % 7 === 3 ? null : [0.412, -0.045, 2.31, 0.087, -0.31, 0.0, 0.66][i % 7]!,
      createdAt: CLOCK - (i * 47 + 12) * 1_000,
      where: WHERE[i % 7]!,
    })),
    79,
  ),
  graduated: feedList(
    "graduated",
    ["Bridge", "Summit", "Harbor", "Crest", "Delta", "Arch"].map((name, i) => ({ mint: pad(`Grad${i}`), symbol: name.toUpperCase().slice(0, 6), name: `${name} Coin`, marketCap: [848_000, 412_000, 96_500, 71_200, 58_000, 41_900][i]!, priceUsd: [848_000, 412_000, 96_500, 71_200, 58_000, 41_900][i]! / 1e9, change1h: i === 2 ? null : [0.183, -0.12, 0, 0.051, -0.402, 0.9][i]!, graduatedAt: CLOCK - [4, 19, 46, 83, 140, 260][i]! * 60_000, where: WHERE[(i + 2) % 7]! })),
    6,
  ),
  onfire: { bucket: "onfire", at: trending.at, rows: trending.rows.map((r, i) => ({ ...r, symbol: r.symbol ?? "?", priceUsd: r.priceUsd ?? null, change1h: r.change1h ?? null, where: WHERE[(i + 4) % 7]! })), matched: 51 },
  finalstretch:
    finalStretch === "off"
      ? { bucket: "finalstretch", at: CLOCK - 4_000, rows: [], state: "off" }
      : {
          ...feedList(
            "finalstretch",
            Array.from({ length: 20 }, (_, i) => ({
              mint: pad(`Curve${i}`),
              symbol: ["CREST", "PULSE", "DRIFT", "GLINT", "HALO", "KNOT", "LOOM", "MOSS", "NOVA", "PRISM"][i % 10]! + (i >= 10 ? "2" : ""),
              marketCap: i % 3 === 2 ? null : 32_100 - i * 900,
              priceUsd: i % 4 === 0 ? (32_100 - i * 900) / 1e9 : null,
              change1h: null,
              progress: 0.9963 - i * 0.0221,
              lastTradeAt: CLOCK - (i * 13 + 4) * 1_000,
              where: WHERE[(i + 1) % 7]!,
            })),
            93,
          ),
          ...(finalStretch === "behind" ? { state: "behind", behindS: 184 } : {}),
        },
})

// Hacc's tape, oldest first as the core sends it: recorded patterns and payloads, made-up
// wallets and labels, one stretch the core couldn't read back.
const PATTERNS: [string, Record<string, unknown>, string?][] = [
  ["new_ticker", { usd_value: "292.77" }],
  ["new_ticker", { usd_value: "970.50" }, "fast hands"],
  ["confluence", { wallets: [{ label: "desk seven" }, { address: pad("Conf1") }, { label: "early bird" }], window_minutes: 60 }],
  ["large_move", { usd_value: "11640.47", direction: "out" }, "desk seven"],
  ["dormancy", { dormant_days: 27 }],
  ["distribution", { usd_value: "30.04" }],
  ["kol_mention", { usd_value: "130.01", handle: "callsguy", followers: 7896, order: "post_then_buy", lag_minutes: 47 }],
  ["intra_book", { direction: "in" }],
]
const signalRows = Array.from({ length: 30 }, (_, i) => {
  const [pattern, payload, label] = PATTERNS[i % PATTERNS.length]!
  return {
    id: 116_150_000 + i,
    pattern,
    event_kind: pattern === "intra_book" || pattern === "dormancy" ? "transfer" : "swap",
    summary: "drawn from the fields, never this",
    payload,
    created_at: new Date(CLOCK - (30 - i) * 47_000).toISOString(),
    wallet_address: pad(`Wal${i}`),
    wallet_label: label ?? null,
    display_label: label ?? null,
    asset_symbol: NAMES[(i * 3) % NAMES.length]!.toUpperCase().slice(0, 5),
    asset_address: pad(`Trend${(i * 3) % NAMES.length}`),
    // Every seventh on Hood, for the wide row's chain.
    asset_chain: i % 7 === 3 ? "hood" : "solana",
  }
})
/** The scene's tape, for a Signals tab test to filter as the core would. */
export const SIGNAL_ROWS = signalRows
const gap = { kind: "gap", id: "g1", created_at: new Date(CLOCK - 12 * 47_000 - 1_000).toISOString(), from: new Date(CLOCK - 14 * 60_000).toISOString(), to: new Date(CLOCK - 11 * 60_000).toISOString(), words: "Hacc's tape didn't answer" }
const signals = { state: "open", rows: [...signalRows.slice(0, 18), gap, ...signalRows.slice(18)] }
const hacc = { enabled: true, agents: { "agent-a": { plan: "max", key: "ok" }, "agent-b": { plan: "max", key: "ok" } }, stream: { state: "open", mine: { state: "closed" } } }

export const followed = (): TokenView => ({
  followed: { mint: MINT, chain: "solana", symbol: "JUPF", since: CLOCK - 20 * 60_000 },
  market: { name: "Jupiter Fake", symbol: "JUPF", priceUsd: 0.4249, marketCap: 1_284_000_000, liquidityUsd: 18_400_000, at: CLOCK - 4_000 },
  check: { summary: "clear", flagged: [], unknown: [], at: CLOCK - 60_000 },
  samples: Array.from({ length: 60 }, (_, i) => ({ at: CLOCK - (59 - i) * 5_000, usd: 0.42 + Math.sin(i / 6) * 0.004 })),
  history: Array.from({ length: 60 }, (_, i) => ({ at: CLOCK - 65 * 60_000 + i * 60_000, usd: 0.41 + i * 0.0002 })),
  historyRead: { source: "hacc", at: CLOCK - 20 * 60_000 },
  // Hacc's 1m candles for the hour before the samples (the pane draws two-minute candles from them):
  // a climb with a dip at its middle, some minutes red, two with no trade.
  candles: Array.from({ length: 60 }, (_, i) => {
    const open = 0.41 + i * 0.0002 + Math.sin(i / 4) * 0.0015
    const close = open + (i % 5 === 2 ? -0.0011 : 0.0007) * (i === 30 ? -3 : 1)
    const flat = i === 17 || i === 44
    return { at: CLOCK - 65 * 60_000 + i * 60_000, open, high: flat ? open : Math.max(open, close) + 0.0004, low: flat ? open : Math.min(open, close) - 0.0004, close: flat ? open : close }
  }),
  change1h: 0.031,
  trending,
})

const portfolio: PortfolioView = {
  readAt: CLOCK - 3_000,
  wallets: [
    {
      address: EMBEDDED,
      chain: "solana",
      kind: "embedded",
      agents: ["agent-a", "agent-b"],
      sol: { amount: 2.184, usd: 327.6 },
      tokens: [
        { mint: MINT, symbol: "JUPF", amount: 120.5, usd: 51.2, buyers: ["agent-a"] },
        { mint: pad("Trend2"), symbol: "LUMEN", amount: 40_210.33, usd: 12.04, buyers: ["agent-b"] },
        { mint: pad("Trend5"), symbol: "QUILL", amount: 912, usd: 3.3, buyers: ["agent-a"] },
      ],
    },
    { address: TEE, chain: "solana", kind: "tee", label: "tee-one", agents: ["agent-a"], active: true, sol: { amount: 0.5, usd: 75 }, tokens: [{ mint: pad("Trend0"), symbol: "ORBIT", amount: 18, usd: 4.1, buyers: ["agent-a"] }] },
  ],
  readOnly: [],
  paper: {},
  deposit: EMBEDDED,
}

const wallets: WalletsTopic = {
  agents: {
    "agent-a": { payable: { embedded: { address: EMBEDDED, chain: "solana" }, tee: [{ id: "teeA", address: TEE, label: "tee-one", chain: "solana", active: true }], readAt: CLOCK, unreadable: [] }, embeddedWallet: "allowed", prefix: "agntAb3d" },
    "agent-b": { payable: { embedded: { address: EMBEDDED, chain: "solana" }, tee: [], readAt: CLOCK, unreadable: [] }, embeddedWallet: "allowed", prefix: "agntBb3d" },
  },
  account: [{ id: "teeA", address: TEE, label: "tee-one", chain: "solana", active: true }],
  boundTo: { [TEE]: "agent-a" },
}

const ACTIVITY: [string | undefined, string, "info" | "good" | "bad" | "warn"][] = [
  [undefined, "live mode", "info"],
  ["agent-a", "agent-a proposed BUY 0.1 SOL → JUPF", "info"],
  ["agent-a", "you approved BUY 0.1 SOL → JUPF (Enter)", "info"],
  ["agent-a", "filled BUY 0.1 SOL → JUPF · 35.2 JUPF", "good"],
  ["agent-b", "agent-b proposed BUY 0.05 SOL → LUMEN", "info"],
  ["agent-b", "you rejected BUY 0.05 SOL → LUMEN", "warn"],
  ["agent-b", "over agent-b's $10 per trade: BUY 0.1 SOL → LUMEN", "bad"],
  ["agent-a", "agent-a followed a wallet on Hacc", "info"],
  ["agent-a", "filled SELL 50% QUILL · 0.21 SOL", "good"],
  ["agent-b", "filled BUY 0.04 SOL → LUMEN", "good"],
]
const activity = Array.from({ length: 30 }, (_, i) => {
  const [agent, text, tone] = ACTIVITY[i % ACTIVITY.length]!
  return { seq: i + 1, at: new Date(CLOCK - (30 - i) * 90_000).toISOString(), ...(agent ? { agent } : {}), text: `${text} #${i + 1}`, tone, ...(i === 27 ? { undo: "chg-1" } : {}) }
})

export const card: ViewCard = {
  cardId: "c1",
  opId: "op-c1",
  cardHash: "hash-c1",
  kind: "trade",
  tool: "candle_trade",
  agent: "agent-a",
  state: "awaiting_approval",
  expiresAt: new Date(CLOCK + 50_000).toISOString(),
  side: "buy",
  params: { mint: MINT, side: "buy", amount: "0.1" },
  display: { title: "BUY 0.1 SOL (≈$15.00) → JUPF", headline: "BUY 0.1 SOL of JUPF", agent: "agent-a", wallet: EMBEDDED, mode: "live", expiresAt: new Date(CLOCK + 50_000).toISOString(), mint: MINT, mintLabel: "JUPF", price: "JUPF $0.4249", why: "volume up 3× on the hour, holders rising", paysFrom: "pays from embedded" },
}

/** Each agent's engine, as the core sends it: the agent pane's border shows `engine · model ▾`. */
export const engineTopic: EngineTopic = {
  agents: { "agent-a": { engine: "claude-code", model: "sonnet", from: "saved" }, "agent-b": { engine: "claude-code", model: "sonnet", from: "saved" } },
  engines: { "claude-code": { label: "Claude Code", minVersion: "2.1.300", check: { ok: true, version: "2.1.316" }, capabilities: { webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true }, signedIn: true, modelsReadAt: CLOCK } },
} as EngineTopic

export const REPLY = [
  "## JUPF on the hour",
  "",
  "Volume is up and the book is **deep** for its size.",
  "",
  "| | Now | 1h ago |",
  "|---|---|---|",
  "| Price | $0.4249 | $0.4121 |",
  "| Liquidity | $18.4M | $18.1M |",
  "",
  `Mint \`${MINT}\`. Want a small buy?`,
].join("\n")

/** A sell the kill switch kept open, and the report pinned over the reply. */
const sellCard: ViewCard = {
  ...card,
  cardId: "c2",
  opId: "op-c2",
  cardHash: "hash-c2",
  side: "sell",
  params: { mint: MINT, side: "sell", amount: "50%" },
  display: { ...card.display, title: "SELL 50% JUPF (≈$7.40)", headline: "SELL 50% of JUPF", why: "the kill switch kept it: a fresh price" },
}
const killReport: KillReport = {
  at: new Date(CLOCK - 40_000).toISOString(),
  by: "v1",
  stopped: { turns: [{ agent: "agent-a", turnId: "t2" }], cards: [{ cardId: "c1", title: "BUY 0.1 SOL (≈$15.00) → JUPF", agent: "agent-a" }] },
  stillOpen: [{ cardId: "c2", cardHash: "hash-c2", title: "SELL 50% JUPF (≈$7.40)", agent: "agent-a", kind: "trade", side: "sell" }],
  inFlight: [],
  standing: { portfolioAgeMs: 30_000, wallets: [], pnl: { usd: 3.4, label: "24h", from: 0, short: false }, spentToday: [{ agent: "agent-a", usd: 12, perDayUsd: 100 }] },
  notStopped: { wording: "Bots and other apps using these keys aren't stopped.", steps: [], candleStopped: [] },
  resume: "type resume",
}

export type SceneName = "followed" | "trending" | "fresh"

// A fresh install: one agent, paper mode, nothing traded, no cards, no journal, no P&L
// samples, no conversation. Candle's lists and Hacc's tape are the scene's real-shaped ones, as a fresh
// core reads them within seconds; the embedded wallet is read and empty.
const freshStatus: StatusView = {
  agents: [{ name: "agent-a", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 25, perDayUsd: 100 } }],
  activeAgent: "agent-a",
  mode: "paper",
  paused: false,
  exposureUsd: 0,
  pnl: { usd: null, label: "24h", from: null, short: false },
  pricesAgeMs: 2_000,
}
const freshWallets: WalletsTopic = {
  agents: { "agent-a": { payable: { embedded: { address: EMBEDDED, chain: "solana" }, tee: [], readAt: CLOCK, unreadable: [] }, embeddedWallet: "allowed", prefix: "agntAb3d" } },
  account: [],
  boundTo: {},
}
const freshPortfolio: PortfolioView = {
  readAt: CLOCK - 3_000,
  wallets: [{ address: EMBEDDED, chain: "solana", kind: "embedded", agents: ["agent-a"], sol: { amount: 0, usd: 0 }, tokens: [] }],
  readOnly: [],
  paper: {},
  deposit: EMBEDDED,
}
export const freshHacc = { enabled: true, agents: { "agent-a": { plan: "free", key: "ok" } }, stream: { state: "open", mine: { state: "closed" } } }
export const freshPnl = {
  window: "24h",
  figure: { window: "24h", label: "24h", start: CLOCK - 86_400_000, usd: null, from: null, short: false, agents: {} },
  agents: [{ agent: "agent-a", prefix: "agntAb3d", readAt: null, book: null }],
  sum: null,
  wallets: [],
  trades: [],
  swaps: [],
  paper: {},
  samplesFrom: null,
}

/** A fresh install's topics, as the core sends them in its first seconds, for a pane test to apply. */
export const freshEvents = (): [string, unknown][] => [
  ["status", freshStatus],
  ["wallets", freshWallets],
  ["portfolio", freshPortfolio],
  ["activity", { lines: [] }],
  ["hacc", freshHacc],
  ["signals", signals],
  ["feeds", feeds("on")],
  ["market", { ...followed(), followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null }],
  ["pnl", freshPnl],
]

/** Lets the Journal's query answer and the frame redraw (its search waits a moment after a key). */
export async function settleJournal(setup: { renderOnce(): Promise<void> }, ms = 10): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
    await setup.renderOnce()
  }
}

/** The tabs a scene can be drawn on, by their place on a fresh install's tab bar. */
const TAB_AT = { trade: 0, cockpit: 1, trending: 2, signals: 3, pnl: 4, research: 5, journal: 6, perps: 7, bots: 8, build: 9 } as const

/** Each scene's tab by its name on the tab bar. */
const TAB_NAMES: Record<keyof typeof TAB_AT, string> = { trade: "Trade", cockpit: "Cockpit", trending: "Trending", signals: "Signals", pnl: "P&L", research: "Research", journal: "Journal", perps: "Perps", bots: "Bots", build: "Build" }

/**
 * The tabs as a person sees them: a fresh install's five, plus the scene's own tab ticked on where a fresh install
 * has it off (Trending, Signals, P&L, the Journal and Perps are a tick away in settings ▾).
 */
export function tabsShowing(...names: string[]): LayoutStore {
  const tabs = KNOWN_TABS.filter((k) => k.shown || names.includes(k.tab.name)).map((k) => k.tab)
  return memoryStore(layoutsText({ tabs, own: [] }))
}

/** Every known tab shown, for a test that walks across them. */
export const everyTab = (): LayoutStore => memoryStore(layoutsText({ tabs: KNOWN_TABS.map((k) => k.tab), own: [] }))

/**
 * The Signals tab's choice and what the core sent for it: a filter whose rows the tape
 * has, with its read-back's; one that matches nothing, read back from Hacc with none; and one whose
 * read-back failed.
 */
function signalsExtra(which: "filtered" | "empty" | "empty-failed") {
  const since = new Date(CLOCK - 30 * 47_000).toISOString()
  if (which === "filtered") {
    const rows = signalRows.filter((r) => r.pattern === "large_move" && r.asset_chain === "solana")
    return { choice: { at: "Signals", pattern: "large_move", chain: "solana" }, data: { state: "open", rows, back: { at: new Date(CLOCK - 5_000).toISOString(), ok: true, rows: 2 }, since } }
  }
  return {
    choice: { at: "Signals", pattern: "deployer" },
    data: { state: "open", rows: [], back: which === "empty" ? { at: new Date(CLOCK - 5_000).toISOString(), ok: true, rows: 0 } : { at: new Date(CLOCK - 5_000).toISOString(), ok: false, rows: 0, words: "HTTP 503: upstream busy" }, since },
  }
}

/**
 * Draws the app at a size, with a scene's data pushed in, on a tab: the Trade tab (Agent-first), the
 * Cockpit, Trending (Candle's four lists, Final Stretch on, off or behind), or Perps (its stub over the
 * short agent pane). `streaming`: a second turn, answering that much so far.
 */
export async function drawScene(scene: SceneName, width: number, height: number, tab: keyof typeof TAB_AT = "trade", layouts?: LayoutStore, extra: { themes?: ThemeStore; kill?: boolean; streaming?: string; finalStretch?: "on" | "off" | "behind"; signals?: "filtered" | "empty" | "empty-failed"; pnl?: PnlVariant; journal?: "full" | "empty"; research?: ResearchVariant; onPaste?: (text: string) => void; spawnBuild?: BuildSpawner; buildPrefs?: SceneSession["buildPrefs"] } = {}) {
  moved = 0
  const session = new SceneSession()
  if (extra.buildPrefs) session.buildPrefs = extra.buildPrefs
  const fresh = scene === "fresh"
  if (extra.journal === "empty" || fresh) session.journalEmpty = true
  if (extra.pnl === "fresh" || fresh) session.pnlSamples = "none"
  const store = layouts ?? (KNOWN_TABS.some((k) => !k.shown && k.tab.name === TAB_NAMES[tab]) ? tabsShowing(TAB_NAMES[tab]) : undefined)
  const shownAt = parseLayouts(store?.read() ?? "", "layouts.toml").tabs.findIndex((t) => t.name === TAB_NAMES[tab])
  const tabIndex = shownAt >= 0 ? shownAt : TAB_AT[tab]
  const setup = await testRender(<App session={session} onQuit={() => {}} now={() => CLOCK + moved} tickMs={0} {...(store ? { layouts: store } : {})} {...(extra.themes ? { themes: extra.themes } : {})} {...(extra.onPaste ? { onPaste: extra.onPaste } : {})} {...(extra.spawnBuild ? { spawnBuild: extra.spawnBuild } : {})} />, { width, height, exitOnCtrlC: false })
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => session.push(topic, data, snapshot))
    await setup.renderOnce()
  }
  await setup.renderOnce()
  await push("status", fresh ? freshStatus : status, true)
  await push("engine", engineTopic, true)
  await push("wallets", fresh ? freshWallets : wallets)
  await push("portfolio", fresh ? freshPortfolio : portfolio)
  await push("activity", { lines: fresh ? [] : activity }, true)
  await push("hacc", fresh ? freshHacc : hacc, true)
  await push("signals", signals, true)
  await push("feeds", feeds(extra.finalStretch ?? "on"), true)
  if (scene === "followed") {
    await push("market", followed())
    await push("agent", { agent: "agent-a", turnId: "t1", type: "ended", user: "how's JUPF looking?", reply: REPLY, outcome: "done" })
    await push("cards", card)
    if (extra.kill) {
      // The kill switch: the buy withdrawn, the sell kept on a fresh card, the report pinned.
      await push("cards", { ...card, state: "withdrawn" })
      await push("cards", sellCard)
      await push("status", { ...status, paused: true }, true)
      await push("activity", { kind: "kill.report", report: killReport })
    }
  } else if (fresh) {
    await push("market", { ...followed(), followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null })
    await push("pnl", freshPnl, true)
  } else {
    await push("market", { ...followed(), followed: null, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null })
    await push("agent", { agent: "agent-a", turnId: "t1", type: "ended", user: "what's trending?", reply: "Orbit leads the on-fire list. Want me to check it?", outcome: "done" })
  }
  if (extra.signals) {
    const { choice, data } = signalsExtra(extra.signals)
    await push("views", { link: null, pins: [], signals: [choice], popped: [] })
    await push("signals", data, true)
  }
  // P&L: the recorded books, as the core's topic sends them; a fresh install's has nothing read.
  if (extra.pnl) {
    const pnl = pnlScene(CLOCK, extra.pnl)
    if (pnl.samplesFrom !== null) session.pnlSamplesFrom = pnl.samplesFrom
    if (pnl.figure.usd !== null) session.pnlChange = pnl.figure.usd
    await push("pnl", pnl, true)
    // The status bar's figure is the same window's, as the core sends both.
    const figure = { usd: pnl.figure.usd, label: pnl.figure.label, from: pnl.figure.from, short: pnl.figure.short }
    await push("status", { ...status, pnl: figure, ...(extra.pnl === "paper" ? { mode: "paper" } : {}) }, true)
  }
  // Research: the linked token in depth, JUPF from the recorded JUP, or a token minutes old.
  if (extra.research) {
    const young = extra.research === "young"
    if (young) await push("market", youngMarket(CLOCK, followed()))
    const token = young ? { mint: YOUNG_MINT, chain: "solana" as const, symbol: YOUNG_SYMBOL } : { mint: MINT, chain: "solana" as const, symbol: "JUPF" }
    await push("research", researchScene(CLOCK, extra.research, token), true)
  }
  if (extra.streaming !== undefined) {
    await push("agent", { agent: "agent-a", turnId: "t2", type: "started", user: "and the perps?" })
    await push("agent", { agent: "agent-a", turnId: "t2", type: "text", delta: extra.streaming })
  }
  if (tab !== "trade") {
    // Up to the tab bar, along to the tab, and down to its agent pane: where a press of its digit would leave it.
    // The Build tab's first open takes the keys itself as it shows.
    for (const arrow of ["up", ...Array.from({ length: tabIndex }, () => "right" as const), ...(tab === "build" ? [] : ["down" as const])] as const) {
      await act(async () => setup.mockInput.pressArrow(arrow))
      await setup.renderOnce()
    }
  }
  // The Journal's first page, asked for as it came on screen.
  if (tab === "journal") await settleJournal(setup)
  return { setup, session }
}
