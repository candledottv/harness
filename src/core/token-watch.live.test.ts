// The token pane's history against the real Hacc, with a Read key on an
// account of your own, in the file CANDLE_HARNESS_TEST_KEY_FILE names (never printed; skipped without it): the core's exact read (65 minutes
// at 1m from a whole minute, no `to`) for the tape's busiest tokens, often minutes old, and JUP, old
// and busy, then the chart and the 1h change it gives.
// Only counts, times and codes are printed, never prices or addresses.
//   bun run test:live src/core/token-watch.live.test.ts
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { HaccClient } from "./hacc"
import { historyRequest, TokenWatch } from "./token-watch"

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
const KEY_FILE = process.env.CANDLE_HARNESS_TEST_KEY_FILE
const key = KEY_FILE ? readFileSync(KEY_FILE, "utf8").trim() : ""

test.skipIf(!KEY_FILE)(
  "a busy token's last hour reads, and gives the chart and the 1h change at once",
  async () => {
    const hacc = new HaccClient({ keyFor: () => key, now: Date.now })
    const tape = await hacc.get("live", "/v1/signals", { limit: 100, quality: "all" })
    expect(tape.kind).toBe("ok")
    const rows = ((tape.kind === "ok" ? (tape.body as { signals?: Record<string, string>[] }).signals : undefined) ?? []).filter((r) => r.asset_chain === "solana" && r.asset_address)
    // The token on the tape most often: the likeliest to have traded through the hour.
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.asset_address!, (counts.get(r.asset_address!) ?? 0) + 1)
    const mints = [...counts].sort((a, b) => b[1] - a[1]).map(([m]) => m)
    expect(mints.length).toBeGreaterThan(0)
    const results: { token: number; ms: number; status: string; points: number; spanMin: number | null; change1h: boolean; words?: string }[] = []
    for (const [i, mint] of [...mints.slice(0, 2), JUP].entries()) {
      let ms = 0
      let last = 0
      const watch = new TokenWatch({
        call: async (tool) =>
          tool === "candle_get_market" ? { kind: "ok", result: { success: true, market: { chain: "solana", mint, metadata: { symbol: "T" }, priceUsd: last || 1 } } } : { kind: "ok", result: {} },
        history: async (chain, m, from) => {
          const { route, query } = historyRequest(chain, m, from)
          const answer = await hacc.get("live", route, query)
          ms = answer.ms
          if (answer.kind === "ok") last = ((answer.body as { candles?: { close: number }[] }).candles ?? []).at(-1)?.close ?? 0
          return answer.kind === "ok" ? { kind: "ok", body: answer.body } : { kind: "refused", words: answer.message }
        },
        now: Date.now,
        publish: () => {},
      })
      await watch.follow(mint)
      const v = watch.view()
      expect(JSON.stringify(v)).not.toContain(key)
      results.push({
        token: i + 1,
        ms,
        status: v.historyRead?.source ?? "none",
        points: v.history.length,
        spanMin: v.history[0] ? Math.round((Date.now() - v.history[0].at) / 60_000) : null,
        change1h: v.change1h !== null,
        ...(v.historyRead?.source === "samples" ? { words: v.historyRead.words.slice(0, 160) } : {}),
      })
    }
    console.log(JSON.stringify(results, null, 1))
    // Hacc took the core's query: no refusal in Hacc's words for any token.
    for (const r of results) expect(r.words ?? "").not.toContain("Hacc refused the request")
    expect(results.some((r) => r.status === "hacc" && r.points > 1)).toBe(true)
    // An old, busy token has its hour at once: the chart's whole span and the 1h change.
    expect(results.at(-1)).toMatchObject({ status: "hacc", change1h: true })
    expect(results.at(-1)!.spanMin).toBeGreaterThanOrEqual(60)
  },
  { timeout: 60_000 },
)
