// Turns test/record-triggers.ts's raw recordings into committed fixtures: Hacc's by scripts/scrub-hacc.ts's
// allowlist into test/fixtures/hacc-recorded/triggers/, Candle's by scripts/scrub-candle-rest.ts's into
// test/fixtures/candle-recorded/triggers/. Both refuse to write anything still shaped like a real address or link.
//
//   bun scripts/scrub-triggers.ts <raw recordings folder> <hacc out folder> <candle out folder>
//
// Only single reads become fixtures. The measurements built from many reads (staleness, the tape's two steps,
// the stream's reopen, the cost check, the personal-signals watch) name real tokens throughout; their figures
// are in the check's notes, not here. A recording's send time (`at`) is dropped, since the account's clocks
// are moved and it would no longer line up with them.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CandleScrubber, leftovers as candleLeftovers, scrubRecording as scrubCandle } from "./scrub-candle-rest"
import { HaccScrubber, leftovers as haccLeftovers, scrubRecording as scrubHacc } from "./scrub-hacc"

type Raw = Record<string, unknown>
/** The measurements and bookkeeping files: not single reads. Of the hour's polls, the first says the shape. */
const MEASURES = /^(staleness|tape-two-steps|reopen|cost|refresh-limit|mine-cursor|mine-watch|mine-watch-follow-ids|mine-watch-follow-\d+|mine-watch-poll-([2-9]|\d\d+))\.json$/

export function scrubTriggers(rawDir: string) {
  const names = readdirSync(rawDir)
    .filter((n) => n.endsWith(".json") && !MEASURES.test(n) && !n.startsWith("staleness"))
    .sort()
  const read = (n: string) => JSON.parse(readFileSync(join(rawDir, n), "utf8")) as Raw
  // Agents' prefixes first, so agent-a is FakeKey1 and agent-b FakeKey2, as in the other Candle fixtures.
  const prefixes = names
    .filter((n) => /^entry-pnl-agent-[a-z]\.json$/.test(n))
    .map((n) => (read(n).answer as { keyPrefix: string }).keyPrefix)
  const candle = new CandleScrubber(prefixes)
  const hacc = new HaccScrubber()
  const out = { hacc: [] as [string, Raw][], candle: [] as [string, Raw][], refused: [] as string[] }
  for (const name of names) {
    const raw = read(name)
    const { at: _at, ...rec } = raw
    if (rec.host === "candle") {
      // The entry reads are the account's own: scrubbed as its P&L and trades are.
      // A market read's route names its token: replaced as the answer's mint is, so the two still agree.
      const route = String(rec.route).replace(/[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40}/g, (a) => candle.address("mint", a))
      const scrubbed = scrubCandle(candle, name.replace(/^entry-/, ""), { ...rec, route })
      const left = candleLeftovers(scrubbed)
      if (left.length) out.refused.push(`${name}: ${left.slice(0, 3).join("; ")}`)
      else out.candle.push([name, scrubbed])
      continue
    }
    // A poll of personal signals holds two reads.
    const scrubbed =
      "fresh" in rec
        ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v && typeof v === "object" ? scrubHacc(hacc, (({ at: _a, ...r }) => r)(v as Raw)) : v]))
        : { ...scrubHacc(hacc, rec), ...("streamRow" in rec ? { streamRow: hacc.value(rec.streamRow) } : {}) }
    const left = haccLeftovers(scrubbed)
    if (left.length) out.refused.push(`${name}: ${left.slice(0, 3).join("; ")}`)
    else out.hacc.push([name, scrubbed])
  }
  return out
}

if (import.meta.main) {
  const [rawDir, haccDir, candleDir] = process.argv.slice(2)
  if (!rawDir || !haccDir || !candleDir) throw new Error("usage: bun scripts/scrub-triggers.ts <raw folder> <hacc out folder> <candle out folder>")
  const { hacc, candle, refused } = scrubTriggers(rawDir)
  if (refused.length) {
    console.error(`refused, nothing written:\n${refused.join("\n")}`)
    process.exit(1)
  }
  mkdirSync(haccDir, { recursive: true })
  mkdirSync(candleDir, { recursive: true })
  for (const [name, v] of hacc) writeFileSync(join(haccDir, name), `${JSON.stringify(v, null, 2)}\n`)
  for (const [name, v] of candle) writeFileSync(join(candleDir, name), `${JSON.stringify(v, null, 2)}\n`)
  console.log(`${hacc.length} Hacc recordings into ${haccDir}, ${candle.length} Candle recordings into ${candleDir}`)
}
