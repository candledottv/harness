// Token names learned from Candle: each mint's symbol from a token check or one of Candle's
// lists, kept in state/symbols.json (0600) so a restarted core names what it replays from the journal (Activity,
// paper positions) before any read has answered. Only what Candle said; a symbol is display text, never a key.
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { terminalText } from "../shared/terminal-text"

/** At most this many names are kept: the newest learned. */
export const MAX_SYMBOLS = 2_000
const WRITE_DELAY_MS = 2_000

const MINT = /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/

export class SymbolBook {
  private readonly names = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly file: string) {
    try {
      const body = JSON.parse(readFileSync(file, "utf8")) as { symbols?: Record<string, unknown> }
      for (const [mint, symbol] of Object.entries(body.symbols ?? {})) if (MINT.test(mint) && typeof symbol === "string" && symbol.trim()) this.names.set(mint, terminalText(symbol, { maxLength: 16 }))
    } catch {
      // None yet, or unreadable: names are learned again as Candle answers.
    }
  }

  get(mint: string): string | undefined {
    return this.names.get(mint)
  }

  /** A name Candle gave: kept, newest last, and written a moment later. */
  learn(mint: string, symbol: string | undefined): void {
    if (!symbol || !MINT.test(mint)) return
    const clean = terminalText(symbol, { maxLength: 16 })
    if (!clean.trim() || this.names.get(mint) === clean) return
    this.names.delete(mint)
    this.names.set(mint, clean)
    while (this.names.size > MAX_SYMBOLS) this.names.delete(this.names.keys().next().value!)
    this.timer ??= setTimeout(() => this.flush(), WRITE_DELAY_MS)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const temp = `${this.file}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify({ symbols: Object.fromEntries(this.names) })}\n`, { mode: 0o600 })
      renameSync(temp, this.file)
    } catch {
      // A name not kept is read again; nothing depends on it.
    }
  }
}
