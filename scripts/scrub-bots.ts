// Turns test/record-bots.ts's raw recordings into committed fixtures, by scripts/scrub-hacc.ts's allowlist, into
// test/fixtures/hacc-recorded/bots/. It refuses to write anything still shaped like a real address or link.
//
//   bun scripts/scrub-bots.ts <raw recordings folder> <out folder>
//
// Each fixture's name starts `bots-`, so the fake Hacc can load it beside the others without a clash.
// Single reads and replays become fixtures, and the hour's full tape as the core's matcher reads it
// (`bots-hour-tape.json`, made-up tokens and groups). The stream as heard, the ages and the comparison name real tokens
// throughout; their figures are in the check's notes, not here. A recording's send time (`at`) is dropped.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HaccScrubber, leftovers, scrubRecording } from "./scrub-hacc"

type Raw = Record<string, unknown>
/** The measurements and bookkeeping files: not single reads. */
const MEASURES = /^(hour-stream|hour-rest-.*|hour-ages|hour-compare|schema-summary)\.json$/

export function scrubBots(rawDir: string) {
  const names = readdirSync(rawDir)
    .filter((n) => n.endsWith(".json") && !MEASURES.test(n))
    .sort()
  const s = new HaccScrubber()
  const out = { written: [] as [string, Raw][], refused: [] as string[] }
  for (const name of names) {
    const { at: _at, trades, ...rec } = JSON.parse(readFileSync(join(rawDir, name), "utf8")) as Raw
    // A run's trades paged together, as the recorder first kept them: scrubbed and cut as an answer is.
    if (trades !== undefined) rec.answer = { trades }
    // A replay's result keeps the request it answered, scrubbed as a body is.
    const { request, ...rest } = rec
    const scrubbed = { ...scrubRecording(s, rest), ...(request !== undefined ? { request: s.value(request, "body") } : {}) }
    const left = leftovers(scrubbed)
    if (left.length) out.refused.push(`${name}: ${left.slice(0, 3).join("; ")}`)
    else out.written.push([`bots-${name}`, scrubbed])
  }
  return out
}

/** The replays of the recorded hour a matcher test reads, by recording: each one's definition and entries. */
const HOUR_REPLAYS = ["hour-clean-new-ticker", "hour-clean-confluence", "hour-groups", "hour-usd-direction"]
/** The patterns those replays enter on. */
const HOUR_PATTERNS = ["new_ticker", "confluence", "large_move"]
/** A tape row's columns in the hour's fixture. */
export const HOUR_COLUMNS = ["id", "ms", "asset", "chain", "groups", "usd", "direction"] as const

/**
 * The recorded hour, cut to what the core's matcher reads, a row as a list of `HOUR_COLUMNS`: Hacc's id, ms after
 * the hour's start, the token as the number of its made-up address (`fakeAddress`), its chain, the wallet groups a
 * replay's definition names (the rest are dropped), the payload's size to the cent and its direction. Each replay
 * keeps its definition and the signals it entered on. Groups are made up as everywhere else, the same fake in a row
 * and a definition.
 */
export function scrubHour(rawDir: string): Raw {
  const s = new HaccScrubber()
  const read = (name: string) => JSON.parse(readFileSync(join(rawDir, `${name}.json`), "utf8")) as Raw
  const replays: Record<string, Raw> = {}
  const named = new Set<string>()
  let from: string | undefined
  let to: string | undefined
  for (const name of HOUR_REPLAYS) {
    const rec = read(`${name}-result`)
    const request = rec.request as Raw
    from ??= String(request.from)
    to ??= String(request.to)
    const filters = (((request.definition as Raw).entry as Raw).filters ?? {}) as Raw
    for (const g of [...((filters.groups ?? []) as string[]), ...((filters.groups_all ?? []) as string[])]) named.add(g)
    const trades = (((rec.answer as Raw).result as Raw).trades ?? []) as Raw[]
    // A definition's groups as the rows' groups: the same fake for the same group.
    const definition = s.value(request.definition, "body") as Raw
    const scrubbedFilters = ((definition.entry as Raw).filters ?? {}) as Raw
    for (const key of ["groups", "groups_all"]) if (Array.isArray(filters[key])) scrubbedFilters[key] = (filters[key] as string[]).map((g) => s.string("groups", g))
    replays[name] = {
      definition,
      entries: trades.map((t) => (t.reason_opened as Raw).signal_id),
      skips: ((rec.answer as Raw).result as Raw).skips,
    }
  }
  const start = Date.parse(from!)
  const assets = new Map<string, number>()
  const tapes: Record<string, unknown[][]> = {}
  for (const pattern of HOUR_PATTERNS) {
    tapes[pattern] = ((read(`hour-rest-${pattern}-all`).rows ?? []) as Raw[]).map((r) => {
      const payload = (r.payload ?? {}) as Raw
      const address = String(r.asset_address)
      if (!assets.has(address)) assets.set(address, assets.size + 1)
      const usd = payload.usd_value === null || payload.usd_value === undefined ? null : (Math.round(Number(payload.usd_value) * 100) / 100).toFixed(2)
      const groups = ((r.wallet_groups ?? []) as string[]).filter((g) => named.has(g)).map((g) => s.string("groups", g))
      return [r.id, Date.parse(String(r.created_at)) - start, assets.get(address), r.asset_chain, groups, usd, payload.direction ?? null]
    })
  }
  return {
    name: "bots-hour-tape",
    from,
    to,
    columns: HOUR_COLUMNS,
    replays,
    tapes,
  }
}

if (import.meta.main) {
  const [rawDir, outDir] = process.argv.slice(2)
  if (!rawDir || !outDir) throw new Error("usage: bun scripts/scrub-bots.ts <raw folder> <out folder>")
  const { written, refused } = scrubBots(rawDir)
  if (refused.length) {
    console.error(`refused, nothing written:\n${refused.join("\n")}`)
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })
  for (const [name, v] of written) writeFileSync(join(outDir, name), `${JSON.stringify(v, null, 2)}\n`)
  // The hour, one tape row a line, its number lists on one line each.
  const { tapes, ...rest } = scrubHour(rawDir) as { tapes: Record<string, unknown[][]> } & Raw
  const head = JSON.stringify(rest, null, 2).replace(/\[\s*(-?\d+(?:,\s*-?\d+)*)\s*\]/g, (_m, list: string) => `[${list.replace(/\s+/g, "")}]`)
  const lines = Object.entries(tapes).map(([p, rows]) => `    ${JSON.stringify(p)}: [\n${rows.map((r) => `      ${JSON.stringify(r)}`).join(",\n")}\n    ]`)
  writeFileSync(join(outDir, "bots-hour-tape.json"), `${head.replace(/\n}$/, `,\n  "tapes": {\n${lines.join(",\n")}\n  }\n}`)}\n`)
  console.log(`${written.length} recordings scrubbed into ${outDir}`)
}
