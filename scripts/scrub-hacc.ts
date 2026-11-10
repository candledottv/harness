// Turns test/record-hacc.ts's raw recordings into committed fixtures. Hacc names
// third-party wallets, their labels and owners, X accounts, groups, tokens and transactions; the
// fixtures keep only the shape. It works from an allowlist: a string survives only if its field is one
// of Hacc's own enums or messages, or it's a number or a time. Everything else becomes a made-up value,
// the same one wherever the real value appeared, and anything left that still looks like an address,
// a handle or a link is refused rather than written.
//
//   bun scripts/scrub-hacc.ts <raw recordings folder> <out folder>
//
// Long arrays keep their first five rows; each recording says what was cut (`truncated`), and keeps
// its real `bytes`, so the tools' budgets can be tested against the sizes Hacc really answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PUBLIC_MINTS } from "./scrub-recordings"

/** Hacc's own vocabulary: kept as recorded. */
const ENUMS = new Set([
  "age_bucket", "asset_chain", "basis", "chain", "code", "dex", "direction", "event_kind", "held_bucket", "heat",
  "kind", "label_source", "launch_source", "launchpad", "mcap_bucket", "minute_table", "mode", "order", "pattern",
  "period", "phase_basis", "phase_resolution", "pool", "provider", "quote_asset", "resolution", "resolve_method",
  "scope", "side", "stage", "status", "supply_source", "time_frame", "token_program", "venue_at_signal", "venues",
  "visibility", "watch_level", "wallet_tags", "wallet_chain", "window", "triaged_by", "verdict", "reason_code",
  "exit_reason", "source", "token_extensions", "close_reason", "type", "state", "missing_fields", "required_tier",
  // A replay's: why a trade closed, the sizing rules it applied or fell back from, and the kind of evidence.
  "reason_closed", "applied", "fell_back", "evidence_kind", "lead_card_version", "plan", "reads",
])
/** Hacc's own words: kept, but still checked for addresses and links. */
const PROSE = new Set(["evidence_limitations", "error", "refresh_refused", "message", "note", "n_basis", "lift_sentence", "rug_mechanics", "reason", "statusCode", "excluded_note", "suspect_note"])
/** Hacc's query parameters whose values are its own vocabulary or flags, kept in a recording's query. */
const QUERY_KEEP = new Set(["group_by", "order", "pattern", "chain", "resolution", "include_candles", "include_peak", "kind", "watch_level", "age", "venues", "exclude_venues", "quality", "period", "event_kind"])
/** Values kept in any field. */
const KEEP_VALUES = new Set(["all", "native", "unknown", "none", "SOL", "USDC"])

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM = /^0x[0-9a-fA-F]{40}$/
const EVM_TX = /^0x[0-9a-fA-F]{64}$/
const ISO = /^\d{4}-\d\d-\d\d(T[\d:.]+Z?)?$/
const NUMBER = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/
const ADDRESS_IN_TEXT = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g

const digits = (n: number) => {
  let s = ""
  do {
    s = B58[n % 58] + s
    n = Math.floor(n / 58)
  } while (n > 0)
  return s
}
// Right-aligned: "1" is base58's zero, so padding after the number would make 1 and 58 the same.
export const fakeAddress = (n: number) => `HaccFake${digits(n).padStart(35, "1")}`
export const fakeEvm = (n: number) => `0x${"fa4e".padEnd(32, "0")}${n.toString(16).padStart(8, "0")}`
export const isFake = (s: string) => s.startsWith("HaccFake") || s.startsWith("0xfa4e") || s.startsWith("fake-") || s.startsWith("https://hacc.example/")

export class HaccScrubber {
  private map = new Map<string, string>()
  private counts = new Map<string, number>()

  private next(kind: string) {
    const n = (this.counts.get(kind) ?? 0) + 1
    this.counts.set(kind, n)
    return n
  }
  private stable(value: string, make: () => string) {
    let out = this.map.get(value)
    if (out === undefined) {
      out = make()
      this.map.set(value, out)
    }
    return out
  }

  /** One string, by the field it sits in. */
  string(field: string, value: string): string {
    if (isFake(value) || KEEP_VALUES.has(value) || PUBLIC_MINTS.has(value)) return value
    if (ADDRESS.test(value)) return this.stable(value, () => fakeAddress(this.next("address")))
    if (EVM.test(value)) return this.stable(value.toLowerCase(), () => fakeEvm(this.next("evm")))
    if (EVM_TX.test(value)) return this.stable(value, () => `0xfa4e${this.next("evm-tx").toString(16).padStart(60, "0")}`)
    if (ENUMS.has(field)) return value
    if (PROSE.has(field)) return value.replace(ADDRESS_IN_TEXT, (a) => this.string("address", a))
    if (ISO.test(value) || NUMBER.test(value)) return value
    if (/^https?:\/\//.test(value)) return this.stable(value, () => `https://hacc.example/${field}-${this.next(`url-${field}`)}`)
    return this.stable(`${field}\u0000${value}`, () => `fake-${field}-${this.next(field)}`)
  }

  /** Any value: strings by field, object keys that are addresses, long arrays cut to five rows. */
  value(v: unknown, field = "<root>", path = "$", truncated?: Record<string, number>): unknown {
    if (typeof v === "string") return this.string(field, v)
    if (Array.isArray(v)) {
      if (truncated && v.length > 5) truncated[path] = v.length
      return (truncated ? v.slice(0, 5) : v).map((x, i) => this.value(x, field, `${path}[${i}]`, truncated))
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        const key = ADDRESS.test(k) || EVM.test(k) ? this.string("address", k) : k
        out[key] = this.value(x, k, `${path}.${key}`, truncated)
      }
      return out
    }
    return v
  }

  /** A route's path: each segment that's an address or a token's symbol is replaced. */
  route(route: string): string {
    return route
      .split("/")
      .map((seg) => (ADDRESS.test(seg) || EVM.test(seg) ? this.string("address", seg) : seg))
      .join("/")
  }
}

/** Anything still shaped like an address, a handle or a link that the scrub didn't make. */
export function leftovers(v: unknown, path = "$"): string[] {
  if (typeof v === "string") {
    const found: string[] = []
    for (const m of v.matchAll(ADDRESS_IN_TEXT)) if (!isFake(m[0]) && !PUBLIC_MINTS.has(m[0])) found.push(`${path}: ${m[0]}`)
    if (/x\.com\/|twitter\.com\/|t\.me\//i.test(v) && !isFake(v)) found.push(`${path}: a link`)
    return found
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => leftovers(x, `${path}[${i}]`))
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [...leftovers(k, `${path}{key}`), ...leftovers(x, `${path}.${k}`)])
  return []
}

export function scrubRecording(s: HaccScrubber, raw: Record<string, unknown>): Record<string, unknown> {
  const truncated: Record<string, number> = {}
  const out: Record<string, unknown> = { ...raw }
  if (typeof raw.route === "string") out.route = s.route(raw.route)
  if (raw.query && typeof raw.query === "object")
    out.query = Object.fromEntries(Object.entries(raw.query as Record<string, string>).map(([k, v]) => [k, QUERY_KEEP.has(k) ? v : k === "q" || k === "ticker" ? s.string("symbol", v) : s.string(k, v)]))
  if ("body" in raw) out.body = s.value(raw.body, "body")
  if ("answer" in raw) out.answer = s.value(raw.answer, "<root>", "$", truncated)
  if (Array.isArray(raw.frames)) {
    const frames = raw.frames as { at: number; bytes: number; frame: unknown }[]
    out.frameCount = frames.length
    out.frames = frames.slice(0, 8).map((f) => ({ ...f, frame: s.value(f.frame, "<root>", "$", truncated) }))
  }
  if (Object.keys(truncated).length) out.truncated = truncated
  return out
}

if (import.meta.main) {
  const [rawDir, outDir] = process.argv.slice(2)
  if (!rawDir || !outDir) throw new Error("usage: bun scripts/scrub-hacc.ts <raw folder> <out folder>")
  mkdirSync(outDir, { recursive: true })
  const s = new HaccScrubber()
  const refused: string[] = []
  const written: [string, unknown][] = []
  // Of the polls, the first and the last say everything; the last is kept as `<kind>-last`.
  const names = readdirSync(rawDir).sort()
  const lastOf = (prefix: string) => names.filter((n) => n.startsWith(prefix)).at(-1)
  const keep = new Map<string, string>()
  // The nine-socket check's sockets answer alike: one held socket and the ninth's refusal say it.
  const SAME = /^stream-cap-([2-9]|hold-)/
  for (const name of names) if (!SAME.test(name)) keep.set(name, name)
  for (const prefix of ["replay-poll-", "strategy-wait-"]) {
    const last = lastOf(prefix)
    for (const n of names) if (n.startsWith(prefix) && n !== `${prefix}000.json`) keep.delete(n)
    if (last && last !== `${prefix}000.json`) keep.set(last, `${prefix}last.json`)
  }
  for (const [name, outName] of keep) {
    if (!name.endsWith(".json") || name.startsWith("summary-")) continue
    const scrubbed = scrubRecording(s, JSON.parse(readFileSync(join(rawDir, name), "utf8")))
    const left = leftovers(scrubbed)
    if (left.length) refused.push(`${name}: ${left.slice(0, 3).join("; ")}`)
    else written.push([outName, scrubbed])
  }
  if (refused.length) {
    console.error(`refused, nothing written:\n${refused.join("\n")}`)
    process.exit(1)
  }
  for (const [name, v] of written) writeFileSync(join(outDir, name), `${JSON.stringify(v, null, 2)}\n`)
  console.log(`${written.length} recordings scrubbed into ${outDir}`)
}
