// Turns test/record-candle-data.ts's raw recordings into committed fixtures. It works
// from an allowlist, as scripts/scrub-hacc.ts does: a string survives only if its field is one of
// Candle's own enums or messages, or it's a number. Everything else becomes a made-up value, the same
// one wherever the real value appeared, and anything left that still looks like an address or a link
// is refused rather than written.
//
//   bun scripts/scrub-candle-rest.ts <raw recordings folder> <out folder>
//
// The account's own reads (P&L, trades, the account's transactions, the portfolio) also carry its
// figures and clocks. Their amounts are multiplied by one made-up factor and their clocks moved by one
// made-up offset, so no real figure or time is left, while the books still add up and every duration
// is as recorded: the shared-wallet case (two agents' books on one wallet) can be tested from the fixtures. Prices
// (cost and mark per token) are left alone, since a scaled amount over a scaled quantity is the same
// price. The market reads (the lists, perps markets) are public; their figures and times stay, and
// their tokens, names and links are replaced, as Hacc's are.
//
// Long lists keep their first five rows (each recording says what was cut, and keeps its real
// `bytes`); the account's reads are kept whole. The timing repeats (`feed-*-time-*`) aren't written:
// their times are in the check's notes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PUBLIC_MINTS } from "./scrub-recordings"

/** Candle's own vocabulary: kept as recorded. */
const ENUMS = new Set([
  "bucket", "buckets", "chain", "code", "field", "coin", "coverage", "iconState", "launchpad", "marketCapSource", "marketOwner",
  "network", "payerType", "program", "quoteAsset", "schema", "side", "source", "status", "venue", "errorCode", "fields",
])
/** Candle's own words: kept, but still checked for addresses and links. */
const PROSE = new Set(["message", "reason", "organicScoreGuidance"])
/** Key prefixes, wherever they appear. */
const PREFIX_FIELDS = new Set(["keyPrefix", "agent", "openedBy"])
/** The account's amounts, scaled: USD figures and quantities (numbers), raw amounts (strings). */
const SCALED = /Usd$|^quantity$|^soldQuantity$|^filledAmount$|^usdValue$/
const SCALED_RAW = new Set(["amountRaw", "feeRaw", "feeCollectedRaw", "lamports", "wei"])
/** Per-token prices: a scaled amount over a scaled quantity, so left as they are. */
const PRICES = new Set(["avgEntryUsd", "avgExitUsd", "markPriceUsd"])
/** Clocks in epoch milliseconds, by field name. */
const CLOCK = /(Ts|At|Time|createdAt)$/
const FACTOR = 3.7
const SHIFT_MS = -(17 * 86_400_000 + 5 * 3_600_000 + 11 * 60_000)

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM = /^0x[0-9a-fA-F]{40}$/
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/
const NUMBER = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/
const ADDRESS_IN_TEXT = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g

const fake = {
  token: (n: number) => `TokenFake${n}`.padEnd(43, "z"),
  wallet: (n: number) => `WalletFake${n}`.padEnd(43, "1"),
  evm: (n: number) => `0x${"fa4e".padEnd(32, "0")}${n.toString(16).padStart(8, "0")}`,
  prefix: (n: number) => `FakeKey${n}`,
  uuid: (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
}
export const isFake = (s: string) =>
  s.startsWith("TokenFake") || s.startsWith("WalletFake") || s.startsWith("0xfa4e") || s.startsWith("fake-") || s.startsWith("https://candle.example/")

/** The recording names the account's own reads start with. */
const ACCOUNT = /^(pnl-|trades-|transactions|portfolio|perps-overview)/
/** Fields whose addresses are the account's wallets, not tokens. */
const WALLET_FIELDS = new Set(["payerWallet", "wallet", "deployer"])

export class CandleScrubber {
  private map = new Map<string, string>()
  private counts = new Map<string, number>()
  /** Set per recording: whether its figures and clocks are the account's. */
  account = false
  /** Key labels in the account's transactions (`book`), to the agent each key is (learnBooks). */
  books = new Map<string, string>()

  /** Agents' prefixes first, so agent-a is FakeKey1 and agent-b FakeKey2 in every file. */
  constructor(prefixes: string[] = []) {
    for (const p of prefixes) this.prefix(p)
  }

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
  prefix(p: string) {
    // zzzzzzzz is the recorder's own made-up prefix, for a key nobody has.
    return p === "zzzzzzzz" ? p : this.stable(`prefix\u0000${p}`, () => fake.prefix(this.next("prefix")))
  }
  address(field: string, value: string) {
    if (PUBLIC_MINTS.has(value) || isFake(value)) return value
    if (EVM.test(value)) return this.stable(value.toLowerCase(), () => fake.evm(this.next("evm")))
    // An address seen first as a wallet stays a wallet wherever else it appears.
    return this.stable(value, () => (WALLET_FIELDS.has(field) || (this.account && field === "address") ? fake.wallet(this.next("wallet")) : fake.token(this.next("token"))))
  }
  private clock(ms: number) {
    return this.account ? ms + SHIFT_MS : ms
  }

  string(field: string, value: string): string {
    if (PREFIX_FIELDS.has(field)) return this.prefix(value)
    if (field === "book") return this.books.get(value) ?? this.stable(`book\u0000${value}`, () => `fake-book-${this.next("book")}`)
    if (field === "clientTradeId") return this.stable(value, () => fake.uuid(this.next("uuid")))
    if (field === "removed" && value.includes(":")) {
      const [chain, address] = value.split(":") as [string, string]
      return `${chain}:${this.address("address", address)}`
    }
    if (field === "cursor" || field === "since_seq") return value === "finalstretch:0" ? value : value.replace(/^[^:]+:/, "fake:")
    if (ADDRESS.test(value) || EVM.test(value)) return this.address(field, value)
    if (SCALED_RAW.has(field) && /^\d+$/.test(value)) return this.account ? String(Math.round(Number(value) * FACTOR)) : value
    if (this.account && SCALED.test(field) && NUMBER.test(value) && !PRICES.has(field)) return String(Number(value) * FACTOR)
    if (ENUMS.has(field)) return value
    if (PROSE.has(field)) return value.replace(ADDRESS_IN_TEXT, (a) => this.address("address", a))
    if (ISO.test(value)) return this.account ? new Date(Date.parse(value) + SHIFT_MS).toISOString() : value
    if (NUMBER.test(value)) return value
    if (/^https?:\/\//.test(value)) return this.stable(value, () => `https://candle.example/${field}-${this.next(`url-${field}`)}`)
    return this.stable(`${field}\u0000${value}`, () => `fake-${field}-${this.next(field)}`)
  }

  number(field: string, value: number): number {
    if (!this.account) return value
    if (CLOCK.test(field) && value > 1e12) return this.clock(value)
    if (SCALED.test(field) && !PRICES.has(field)) return value * FACTOR
    return value
  }

  value(v: unknown, field = "<root>", path = "$", truncated?: Record<string, number>): unknown {
    if (typeof v === "string") return this.string(field, v)
    if (typeof v === "number") return this.number(field, v)
    if (Array.isArray(v)) {
      const cut = truncated && !this.account && v.length > 5
      if (cut) truncated[path] = v.length
      return (cut ? v.slice(0, 5) : v).map((x, i) => this.value(x, field, `${path}[${i}]`, truncated))
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        // The portfolio's price map is keyed by mint.
        const key = ADDRESS.test(k) || EVM.test(k) ? this.address("mint", k) : k
        out[key] = this.value(x, k, `${path}.${key}`, truncated)
      }
      return out
    }
    return v
  }

  route(route: string): string {
    return route.replace(/\/keys\/([A-Za-z0-9_-]{8})\//, (_, p: string) => `/keys/${this.prefix(p)}/`)
  }
}

/** Anything still shaped like an address or a link the scrub didn't make. */
export function leftovers(v: unknown, path = "$"): string[] {
  if (typeof v === "string") {
    const found: string[] = []
    for (const m of v.matchAll(ADDRESS_IN_TEXT)) if (!isFake(m[0]) && !PUBLIC_MINTS.has(m[0])) found.push(`${path}: ${m[0]}`)
    if (/https?:\/\//.test(v) && !isFake(v)) found.push(`${path}: a link`)
    return found
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => leftovers(x, `${path}[${i}]`))
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [...leftovers(k, `${path}{key}`), ...leftovers(x, `${path}.${k}`)])
  return []
}

export function scrubRecording(s: CandleScrubber, name: string, raw: Record<string, unknown>): Record<string, unknown> {
  s.account = ACCOUNT.test(name)
  const truncated: Record<string, number> = {}
  const out: Record<string, unknown> = { ...raw }
  if (typeof raw.route === "string") out.route = s.route(raw.route)
  if (raw.args) out.args = s.value(raw.args, "args")
  if (raw.query) out.query = s.value(raw.query, "query")
  if ("answer" in raw) out.answer = s.value(raw.answer, "<root>", "$", truncated)
  if (Object.keys(truncated).length) out.truncated = truncated
  return out
}

type Rows = { answer: { trades?: { clientTradeId: string }[]; transactions?: { clientTradeId: string; book: string }[] } }
/** Each key label in the account's transactions, to the agent whose own trades hold its rows. */
function learnBooks(rawDir: string, names: string[]): Map<string, string> {
  const books = new Map<string, string>()
  const all = names.includes("transactions.json") ? (JSON.parse(readFileSync(join(rawDir, "transactions.json"), "utf8")) as Rows).answer.transactions ?? [] : []
  for (const n of names.filter((x) => /^trades-agent-[a-z]\.json$/.test(x))) {
    const agent = n.slice("trades-".length, -".json".length)
    const ids = new Set(((JSON.parse(readFileSync(join(rawDir, n), "utf8")) as Rows).answer.trades ?? []).map((t) => t.clientTradeId))
    for (const row of all) if (ids.has(row.clientTradeId)) books.set(row.book, agent)
  }
  return books
}

/** The agents' prefixes, in label order, from their own P&L recordings. */
function agentPrefixes(rawDir: string, names: string[]): string[] {
  return names
    .filter((n) => /^pnl-agent-[a-z]\.json$/.test(n))
    .sort()
    .map((n) => (JSON.parse(readFileSync(join(rawDir, n), "utf8")) as { answer: { keyPrefix: string } }).answer.keyPrefix)
}

if (import.meta.main) {
  const [rawDir, outDir] = process.argv.slice(2)
  if (!rawDir || !outDir) throw new Error("usage: bun scripts/scrub-candle-rest.ts <raw folder> <out folder>")
  mkdirSync(outDir, { recursive: true })
  const names = readdirSync(rawDir)
    .filter((n) => n.endsWith(".json") && !/-time-\d+\.json$/.test(n))
    .sort()
  const s = new CandleScrubber(agentPrefixes(rawDir, names))
  s.books = learnBooks(rawDir, names)
  const refused: string[] = []
  const written: [string, unknown][] = []
  for (const name of names) {
    const scrubbed = scrubRecording(s, name, JSON.parse(readFileSync(join(rawDir, name), "utf8")))
    const left = leftovers(scrubbed)
    if (left.length) refused.push(`${name}: ${left.slice(0, 3).join("; ")}`)
    else written.push([name, scrubbed])
  }
  if (refused.length) {
    console.error(`refused, nothing written:\n${refused.join("\n")}`)
    process.exit(1)
  }
  for (const [name, v] of written) writeFileSync(join(outDir, name), `${JSON.stringify(v, null, 2)}\n`)
  console.log(`${written.length} recordings scrubbed into ${outDir}`)
}
