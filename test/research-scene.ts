// The Research tab's data for tests and frames: what the core's `research` topic sends,
// built from the recordings of JUP and of a token minutes old, with their times moved to `now`. Variants:
// JUP in depth, the young token, the first reads still running, and Hacc off.
import forensics from "./fixtures/candle-recorded/cli-agent-a-candle_token_forensics.json"
import jupOverview from "./fixtures/hacc-recorded/research/research-jup-launch-overview.json"
import jupProfile from "./fixtures/hacc-recorded/research/research-jup-profile.json"
import jupSignals from "./fixtures/hacc-recorded/research/research-jup-signals-asset.json"
import jupTraders from "./fixtures/hacc-recorded/research/research-jup-top-traders.json"
import youngOverview from "./fixtures/hacc-recorded/research/research-young-launch-overview.json"
import youngProfile from "./fixtures/hacc-recorded/research/research-young-profile.json"
import youngSignals from "./fixtures/hacc-recorded/research/research-young-signals-asset.json"
import youngTraders from "./fixtures/hacc-recorded/research/research-young-top-traders.json"
import { candleCheck, haccFacts, mentionRows, type ResearchToken, type ResearchView, tokenSignalRows, traderRows } from "../src/core/research-reads"
import type { TokenView } from "../src/core/token-watch"

export type ResearchVariant = "jup" | "young" | "reading" | "hacc-off"

/** When they were read: JUP's overview's `as_of`, and the young token's newest signal. */
const READ_AT = Date.parse("2026-10-30T13:40:05.453Z")

/** The young token, as the frames name it (the scrub left it "fake-symbol-2"). */
export const YOUNG_MINT = "SparkFake1111111111111111111111111111111111"
export const YOUNG_SYMBOL = "SPARK"

/** Every time in a value moved by `by`: ISO dates in strings, and epoch ms in the fields that carry them. */
function shifted<T>(value: T, by: number): T {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) return new Date(Date.parse(value) + by).toISOString() as T
  if (Array.isArray(value)) return value.map((v) => shifted(v, by)) as T
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v, by)])) as T
  return value
}

/** Its signals named by the frame's symbol, not the scrub's. */
const named = (rows: ReturnType<typeof tokenSignalRows>, symbol: string, mint: string) => (rows ?? []).map((r) => ({ ...r, asset_symbol: symbol, asset_address: mint }))

export function researchScene(now: number, which: ResearchVariant, token: ResearchToken): ResearchView {
  const by = now - 20_000 - READ_AT
  const at = now - 20_000
  // The check as the token pane's line says it: JUPF clear, the young token incomplete (its sell unprobed).
  const check = candleCheck(shifted(forensics.outcome.result, by))!
  const flags = check.flags.map((f) => (which === "young" && f.name === "sellability" ? { name: f.name, status: "unknown" } : { ...f, status: "clear" }))
  const candle = {
    at: now - 4 * 60_000,
    data: {
      ...check,
      summary: which === "young" ? "incomplete" : "clear",
      flags,
      mint: { ...check.mint!, mintAuthority: null },
      ...(which === "young" ? { sellProbe: { routable: null } } : {}),
    },
  }
  if (which === "reading") return { token, check: { candle: { at: null, data: null }, hacc: { at: null, data: null } }, traders: { at: null, data: null }, signals: { at: null, data: null }, mentions: { at: null, data: null } }
  if (which === "hacc-off") {
    const cant = "Hacc's data is off in this Candle Harness's config ([hacc] enabled = false)."
    return { token, check: { candle, hacc: { at: null, data: null, cant } }, traders: { at: null, data: null, cant }, signals: { at: null, data: null, cant }, mentions: { at: null, data: null, cant } }
  }
  const young = which === "young"
  const profile = shifted(young ? youngProfile.answer : jupProfile.answer, by)
  const overview = shifted(young ? youngOverview.answer : jupOverview.answer, by)
  return {
    token,
    check: { candle, hacc: { at, data: haccFacts(profile, overview) } },
    traders: { at, data: traderRows(young ? youngTraders.answer : jupTraders.answer) ?? [] },
    signals: { at, data: named(tokenSignalRows(shifted(young ? youngSignals.answer : jupSignals.answer, by)), token.symbol ?? "?", token.mint) },
    mentions: { at, data: mentionRows(overview) ?? { rows: [] } },
  }
}

/** The token pane on the young token: minutes old, a few samples, its check incomplete. */
export function youngMarket(now: number, base: TokenView): TokenView {
  const samples = Array.from({ length: 30 }, (_, i) => ({ at: now - (30 - i) * 5_000, usd: 0.0000086 * (1 + 0.02 * Math.sin(i / 3) + i * 0.004) }))
  return {
    ...base,
    followed: { mint: YOUNG_MINT, chain: "solana", symbol: YOUNG_SYMBOL, since: now - 3 * 60_000, by: "you" },
    market: { name: "Spark", symbol: YOUNG_SYMBOL, priceUsd: 0.0000098, marketCap: 9_800, liquidityUsd: null, at: now - 4_000 },
    check: { summary: "incomplete", flagged: [], unknown: ["sellability"], at: now - 3 * 60_000 },
    samples,
    history: [],
    candles: [],
    historyRead: { source: "samples", at: now - 3 * 60_000, words: "Hacc has no trades for it in the last hour." },
    change1h: null,
  }
}
