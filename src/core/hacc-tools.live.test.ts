// Hacc's tools against the real Hacc, with a Read key on an account of your
// own, in the file CANDLE_HARNESS_TEST_KEY_FILE names (never printed; skipped without it). Every view once, with ids and addresses taken from
// Hacc's own answers, so each view's parameters are checked against what Hacc accepts: Hacc refuses any it
// doesn't know. Only sizes, times and codes are printed, never rows.
//   bun run test:live src/core/hacc-tools.live.test.ts
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { HaccClient } from "./hacc"
import { ANSWER_BUDGET, HaccTools } from "./hacc-tools"

const KEY_FILE = process.env.CANDLE_HARNESS_TEST_KEY_FILE
const key = KEY_FILE ? readFileSync(KEY_FILE, "utf8").trim() : ""

test.skipIf(!KEY_FILE)(
  "every view answers the real Hacc, within 16 KB, with no parameter Hacc refuses",
  async () => {
    const tools = new HaccTools({ hacc: new HaccClient({ keyFor: () => key, now: Date.now }), plan: () => "max" })
    const results: { name: string; view: string; ms: number; bytes: number; code?: string; cut?: boolean; words?: string }[] = []
    const read = async (name: string, args: Record<string, unknown>) => {
      const started = performance.now()
      const r = await tools.call("live", name, args)
      const text = r.content[0]!.text
      expect(text).not.toContain(key)
      const body = JSON.parse(text)
      results.push({
        name,
        view: String(args.view),
        ms: Math.round(performance.now() - started),
        bytes: Buffer.byteLength(text),
        ...(body.error ? { code: body.error.code, words: String(body.error.message).slice(0, 160) } : {}),
        ...(body.cut ? { cut: true } : {}),
      })
      return body
    }
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()

    const tape = await read("hacc_signals", { view: "tape", limit: 50, quality: "all" })
    const rows = (tape.data?.signals ?? []) as Record<string, string>[]
    const sol = rows.find((r) => r.asset_chain === "solana" && r.asset_address)
    const wallet = rows.find((r) => r.wallet_chain === "solana" && r.wallet_address)?.wallet_address
    const hood = ((await read("hacc_signals", { view: "tape", chain: "hood", limit: 5 })).data?.signals ?? [])[0]?.asset_address as string | undefined
    await read("hacc_signals", { view: "by_token", limit: 20 })
    const mint = sol?.asset_address
    expect(mint).toBeDefined()

    for (const view of ["market", "history", "top_traders", "venues", "profile", "launch_overview"]) await read("hacc_token", { view, address: mint })
    await read("hacc_token", { view: "history", address: mint, resolution: "1m", from: hourAgo, candles: true })
    if (wallet) await read("hacc_token", { view: "wallet_pnl", address: mint, wallets: wallet })
    if (hood) await read("hacc_token", { view: "holders", address: hood, chain: "hood" })
    await read("hacc_token", { view: "search", q: "JUP" })

    await read("hacc_market", { view: "gainers" })
    await read("hacc_market", { view: "prices", addresses: mint })
    await read("hacc_market", { view: "metas" })
    await read("hacc_market", { view: "activity", hours: 1 })
    await read("hacc_market", { view: "final_stretch" })

    const tracked = await read("hacc_wallets", { view: "tracked", limit: 5 })
    const realtime = await read("hacc_wallets", { view: "tracked", watch_level: "realtime", limit: 1 })
    const groups = await read("hacc_wallets", { view: "groups" })
    if (tracked.data?.wallets?.[0]) await read("hacc_wallets", { view: "wallet", id: tracked.data.wallets[0].id })
    if (groups.data?.groups?.[0]) await read("hacc_wallets", { view: "group", id: groups.data.groups[0].id })
    await read("hacc_wallets", { view: "labelled_trades", kind: "smartmoney" })
    if (wallet) for (const view of ["stats", "activity", "token_breakdown", "portfolio"]) await read("hacc_wallets", { view, address: wallet, ...(view === "stats" ? { period: "30d" } : {}) })
    const rt = realtime.data?.wallets?.[0]?.address
    if (rt) await read("hacc_wallets", { view: "book_legs", address: rt })

    await read("hacc_social", { view: "mentions", address: mint })
    await read("hacc_social", { view: "marks", address: mint })
    await read("hacc_social", { view: "trending" })

    for (const view of ["follows", "rules", "signals", "groups"]) await read("hacc_follows", { view })

    await read("hacc_lab", { view: "edges" })
    await read("hacc_lab", { view: "edges", pattern: "confluence" })
    await read("hacc_lab", { view: "runners", hours: 1, min_wallets: 3 })
    await read("hacc_lab", { view: "first_signals", minutes: 30, launched_after: hourAgo })
    const assets = await read("hacc_lab", { view: "assets", launched_after: hourAgo, limit: 5 })
    if (assets.data?.next_after) await read("hacc_lab", { view: "assets", launched_after: hourAgo, limit: 5, after: assets.data.next_after })
    if (assets.data?.assets?.[0]) await read("hacc_lab", { view: "asset", id: assets.data.assets[0].id })
    const strategies = await read("hacc_lab", { view: "strategies" })
    const sid = strategies.data?.strategies?.[0]?.id
    if (sid) for (const view of ["strategy", "strategy_trades", "comparison"]) await read("hacc_lab", { view, id: sid })
    await read("hacc_lab", { view: "runs" })
    if (assets.data?.assets?.[0]) await read("hacc_lab", { view: "trades", asset_id: assets.data.assets[0].id })

    for (const r of results) console.log(`${r.name} ${r.view}: ${r.ms} ms, ${r.bytes} B${r.cut ? ", cut" : ""}${r.code ? `, ${r.code}: ${r.words}` : ""}`)
    for (const r of results) expect(r.bytes).toBeLessThanOrEqual(ANSWER_BUDGET)
    // A parameter Hacc doesn't know answers 400 in Zod's words: none of the views may send one.
    expect(results.filter((r) => r.code === "HACC_BAD_REQUEST" || r.code === "INVALID_ARGS")).toEqual([])
  },
  300_000,
)
