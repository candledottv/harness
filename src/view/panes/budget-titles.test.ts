// A pane whose read the key's request budget slowed says how often it now reads, and why, in its title; a
// pane that isn't slowed says nothing new.
import { describe, expect, test } from "bun:test"
import type { Pace, ReadKind } from "../../core/key-budget"
import type { TokenView } from "../../core/token-watch"
import { type CoreView, EMPTY_VIEW, type StatusView } from "../store"
import { paneLines } from "./registry"

const NOW = 1_800_000_000_000
const MOON = "MoonFake11111111111111111111111111111111111"
const PIN = "PinFake111111111111111111111111111111111111"
const status = (pace: Partial<Record<ReadKind, Pace>>): StatusView => ({ agents: [], activeAgent: "agent-a", mode: "live", paused: false, budget: { keys: [], pace } })
const market = (followed: boolean): TokenView => ({
  followed: followed ? { mint: MOON, chain: "solana", symbol: "MOON", since: NOW, by: "you" } : null,
  market: null,
  check: null,
  samples: [],
  history: [],
  historyRead: null,
  change1h: null,
  trending: { bucket: "onfire", at: NOW - 12_000, rows: [] },
  pinned: [{ mint: PIN, chain: "solana", symbol: "PIN", since: NOW, market: null, check: null, samples: [], history: [], historyRead: null, change1h: null }],
})
const view = (pace: Partial<Record<ReadKind, Pace>>, followed = true): CoreView => ({
  ...EMPTY_VIEW,
  connected: true,
  status: status(pace),
  market: market(followed),
  views: { link: null, pins: [{ at: "Cockpit", mint: PIN, chain: "solana", symbol: "PIN" }], signals: [], popped: [] },
  portfolio: { readAt: NOW - 20_000, wallets: [], readOnly: [], paper: [] } as unknown as CoreView["portfolio"],
})
const title = (id: "token" | "feed" | "wallets" | "positions", v: CoreView, at?: string) => paneLines(id, { view: v, rect: { x: 0, y: 0, w: 140, h: 20 }, now: NOW, only: undefined, ...(at ? { at } : {}) }).title

describe("titles", () => {
  test("not slowed: the titles as they were", () => {
    const v = view({})
    expect(title("token", v)).toBe("Token · MOON · you picked")
    expect(title("feed", v)).toBe("Feed · on fire · 12s ago")
    expect(title("positions", v)).toBe("Positions")
  })

  test("the linked token, a pin, the list and prices each say their own pace", () => {
    const v = view({ linked: { everyMs: 8_000, why: "limit" }, pins: { everyMs: 60_000, why: "limit" }, lists: { why: "busy" }, prices: { everyMs: 30_000, why: "rate-limited" } })
    expect(title("token", v)).toBe("Token · MOON · every 8 s (Candle's limit) · you picked")
    expect(title("token", v, "Cockpit")).toBe("Token · PIN · every 60 s (Candle's limit) · pinned")
    expect(title("feed", v)).toBe("Feed · on fire · 12s ago · waiting (room kept for trades)")
    expect(title("wallets", v)).toContain("every 30 s (Candle rate-limited)")
    expect(title("positions", v)).toBe("Positions · every 30 s (Candle rate-limited)")
  })

  test("the token pane with nothing followed shows the list, at the list's pace", () => {
    expect(title("token", view({ lists: { everyMs: 120_000, why: "limit" } }, false))).toBe("Token · trending · every 2 min (Candle's limit)")
  })
})
