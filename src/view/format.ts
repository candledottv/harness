// Data honesty in one place: a value a source can't supply is "—", never zero; how old
// a value is travels with it, and stale is marked; converted figures carry ≈. Every pane formats its
// figures here.
import { short } from "../core/wallet-names"

const DASH = "—"

const missing = (n: number | null | undefined): n is null | undefined => n === null || n === undefined || !Number.isFinite(n)

/** Dollars: cents above a dollar, six significant figures below it. */
export function usd(n: number | null | undefined): string {
  if (missing(n)) return DASH
  const abs = Math.abs(n)
  // Under a dollar, three figures; one that rounds up to a dollar is said as one, "$1.00", not "$1".
  const small = abs !== 0 && Number(abs.toPrecision(3)) < 1
  const text = small ? `$${Number(abs.toPrecision(3)).toString()}` : `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return n < 0 ? `-${text}` : text
}

/** A dollar figure converted from another unit. */
export const approxUsd = (n: number | null | undefined): string => (missing(n) ? DASH : `≈${usd(n)}`)

/** Market cap and liquidity: $812K, $1.4M. */
export function compactUsd(n: number | null | undefined): string {
  if (missing(n)) return DASH
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]
  for (const [size, unit] of units) if (Math.abs(n) >= size) return `$${Number((n / size).toFixed(n / size >= 100 ? 0 : 1)).toString()}${unit}`
  return `$${Math.round(n)}`
}

/** A count, short: 7.9K, 1.2M. */
export const compactNumber = (n: number): string => (Math.abs(n) >= 1e3 ? compactUsd(n).slice(1) : String(Math.round(n)))

/**
 * A fraction as a signed percentage: ▲ 41.2%; whole from 1,000%, and past 9,999% only that it is (a
 * token minutes old had read "▲ 1657834.0%", a change from almost nothing).
 */
export function pct(n: number | null | undefined): string {
  if (missing(n)) return DASH
  const p = Math.abs(n) * 100
  // Whole from 100%: a tenth of a percent says nothing there, and the lists need the cell.
  const text = p > 9999 ? ">9999" : p >= 100 ? p.toFixed(0) : p.toFixed(1)
  return `${n >= 0 ? "▲" : "▼"} ${text}%`
}

/** A token quantity: grouped, about four significant decimals, no trailing zeros. */
export function qty(n: number | null | undefined): string {
  if (missing(n)) return DASH
  if (n !== 0 && Math.abs(n) < 0.01) return Number(n.toPrecision(2)).toString()
  const decimals = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 3 : 4
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals })
}

/**
 * A token or asset amount, rounded to what matters: 3 significant figures below 1
 * (0.00997), up to 4 from 1 to 999 (18.42), and whole numbers, grouped, from 1,000 (18,400). The exact
 * figure is in a card's details (`exact`).
 */
export function amount(n: number | null | undefined): string {
  if (missing(n)) return DASH
  const abs = Math.abs(n)
  if (abs === 0) return "0"
  const opts: Intl.NumberFormatOptions = abs < 1 ? { maximumSignificantDigits: 3 } : abs < 1000 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 0 }
  return n.toLocaleString("en-US", opts)
}

/** The full figure, for details: grouped, every decimal kept, no trailing zeros. */
export function exact(n: number | null | undefined): string {
  if (missing(n)) return DASH
  return n.toLocaleString("en-US", { maximumFractionDigits: 12 })
}

/** How old a value read at `at` is, and whether it's past `staleMs`. */
export function ago(at: number | null | undefined, now: number, staleMs: number): { text: string; stale: boolean } {
  if (missing(at)) return { text: "never read", stale: true }
  const s = Math.max(0, Math.round((now - at) / 1000))
  const text = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
  const stale = now - at > staleMs
  return { text: stale ? `${text} · stale` : text, stale }
}

/** An address shortened, as everywhere: wallet-names.ts holds the one copy. */
export const shortAddress = short

/** Wraps text to `width` columns: whole words where they fit, long words broken, blank lines kept. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(/ +/).filter(Boolean)) {
      let rest = word
      if (line && line.length + 1 + rest.length > w) {
        out.push(line)
        line = ""
      }
      while (rest.length > w) {
        if (line) {
          out.push(line)
          line = ""
        }
        out.push(rest.slice(0, w))
        rest = rest.slice(w)
      }
      line = line ? `${line} ${rest}` : rest
    }
    out.push(line)
  }
  return out
}
