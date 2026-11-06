// Empty token accounts. A TEE sell's route opens a token account in the
// wallet for each token it passes through and leaves it empty, and its answer doesn't say so: rent, about 0.002 SOL each, held in
// the user's own wallet. Candle decides which accounts qualify, and counts them in its close-empty
// preview (CLI 0.13.5, commands/wallets-close-empty.ts), so the count is Candle's, read through the
// user's own CLI with the key the wallet is bound to:
//
//   candle wallets close-empty --wallet <address> --json        (never --yes, never --client-trade-id)
//
// Without --yes and with no terminal on stdin (runChild gives it none), the CLI previews and stops:
// nothing is built, signed or sent (its own test: "without a terminal it needs --yes, and closes
// nothing"). With nothing to close, stdout is the whole preview as JSON (`nothing_to_close`). With some,
// the preview goes to stderr in the CLI's own words and stdout is CONFIRMATION_REQUIRED: the count and
// the SOL come from those lines, read strictly, and anything else is "couldn't read", never a guess.
// The CLI has no JSON form of the preview yet.
//
// Read in the background inside the key's Candle budget, as four calls (the embedded
// wallet, the key's TEE wallets, the embedded wallet again, the preview): for each Solana TEE wallet a
// Candle Harness agent pays from, while a view is attached: 20 s after the first view attaches (past the first
// screen's reads), when one is first seen after that, every 30 minutes, and 15 s after a trade, swap or
// close from it settles. Never on approve. The embedded wallet's needs
// transfer:write, which no agent key has, so it isn't read.
import { terminalText } from "../shared/terminal-text"
import type { CliResult } from "./candle-cli"

/** How long after the first view attaches the counts are first read: the first screen's reads go first. */
export const START_DELAY_MS = 20_000
/** How often each wallet's count is read again while a view is attached. */
export const EMPTY_REFRESH_MS = 30 * 60_000
/** How long after a trade, swap or close settles its wallet is read: Candle's preview reads the chain. */
export const SETTLE_DELAY_MS = 15_000
/** A read the key's budget turned back is tried again this much later. */
export const RETRY_MS = 60_000
/** Candle's calls one preview run makes, from the CLI's source (walletsCloseEmpty, tradingPayer, closeTee). */
export const PREVIEW_CALLS = 4

/** The preview's argv: no --yes and no id, so the CLI stops at its preview. Exported for the test that keeps it so. */
export const previewArgv = (address: string): string[] => ["wallets", "close-empty", "--wallet", address, "--json"]

/** A wallet's empty token accounts, as Candle's preview counted them. */
export interface EmptyAccounts {
  count: number
  /** What the wallet gains: the rent back, less the network fee, in SOL as Candle wrote it. */
  netSol: string
  /** The rent back, before the fee. */
  totalSol: string
  feeSol: string
  transactions: number
  /** Candle closes at most this many in one run, where there are more: the rest wait for the next. */
  firstOnly?: number
  at: number
}

/** A read that didn't give a count: Candle's refusal in its words (closing off on this deployment, say), or why it couldn't be read. */
export interface EmptyUnread {
  failed: string
  code: string
  at: number
}

export type EmptyState = EmptyAccounts | EmptyUnread

export const isCounted = (s: EmptyState | undefined): s is EmptyAccounts => s !== undefined && "count" in s

const DECIMAL = /^\d+(?:\.\d+)?$/
const CLOSE_LINE = /^Close (\d+) empty token accounts? on the /
const RENT_LINE = /^Rent returned to that same wallet: (\d+(?:\.\d+)?) SOL in (\d+) transactions?, network fee about (\d+(?:\.\d+)?) SOL, net (-?\d+(?:\.\d+)?) SOL$/
const CAP_LINE = /^This run closes the first (\d+); run it again for the rest\.$/

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** SOL from lamports as the CLI writes it (solOf): no trailing zeros. */
const solOf = (lamports: string): string => {
  const digits = lamports.padStart(10, "0")
  return `${digits.slice(0, -9)}.${digits.slice(-9)}`.replace(/\.?0+$/, "")
}

/** One preview run, read: a count, or why there's none. */
export function readPreview(run: Pick<CliResult, "exitCode" | "json" | "stderr" | "timedOut">, at: number): EmptyState {
  const unread = (code: string, failed: string): EmptyUnread => ({ code, failed, at })
  if (run.timedOut) return unread("TIMED_OUT", "the candle CLI didn't finish in time")
  const body = record(run.json)
  if (!body) return unread("UNREADABLE", "the candle CLI's answer couldn't be read")
  if (run.exitCode === 0) {
    // Nothing to close: the whole preview is on stdout. Any other exit 0 isn't a preview (the argv has no --yes).
    const preview = record(body.preview)
    if (body.status !== "nothing_to_close") return unread("UNEXPECTED", "the candle CLI answered something other than its preview")
    const fee = typeof preview?.estimatedFeeLamports === "string" && /^\d+$/.test(preview.estimatedFeeLamports) ? solOf(preview.estimatedFeeLamports) : "0"
    return { count: 0, netSol: "0", totalSol: "0", feeSol: fee, transactions: 0, at }
  }
  const code = typeof body.code === "string" ? body.code : `CLI_EXIT_${run.exitCode}`
  if (code !== "CONFIRMATION_REQUIRED") {
    const message = typeof body.message === "string" ? terminalText(body.message, { maxLength: 300 }) : code
    return unread(code, message)
  }
  // The CLI's own lines (previewLines), the first two always, the cap where Candle has one.
  const lines = run.stderr.split("\n").map((l) => terminalText(l).trim())
  const count = lines.map((l) => CLOSE_LINE.exec(l)).find((m) => m !== null)
  const rent = lines.map((l) => RENT_LINE.exec(l)).find((m) => m !== null)
  if (!count || !rent || !DECIMAL.test(rent[1]!) || !DECIMAL.test(rent[3]!)) return unread("PREVIEW_UNREAD", "the candle CLI's preview wasn't in the words the Candle Harness reads (checked against 0.13.5)")
  const cap = lines.map((l) => CAP_LINE.exec(l)).find((m) => m !== null)
  return {
    count: Number(count[1]),
    totalSol: rent[1]!,
    transactions: Number(rent[2]),
    feeSol: rent[3]!,
    netSol: rent[4]!,
    ...(cap ? { firstOnly: Number(cap[1]) } : {}),
    at,
  }
}

/** A Solana TEE wallet a Candle Harness agent pays from, and that agent: its key is the one the wallet is bound to. */
export interface EmptyWallet {
  address: string
  agent: string
}

export class EmptyAccountsBook {
  private readonly states = new Map<string, EmptyState>()
  private readonly inflight = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private startTimer: ReturnType<typeof setTimeout> | undefined
  /** Past the start delay, with a view attached: a wallet first seen is read at once. */
  private ready = false

  constructor(
    private readonly deps: {
      wallets: () => EmptyWallet[]
      run: (input: { agent: string; argv: string[]; json: true; calls: number }) => Promise<Pick<CliResult, "exitCode" | "json" | "stderr" | "timedOut">>
      /** The key's budget (KeyBudget.take("empty", agent, PREVIEW_CALLS)): undefined to wait. */
      take: (agent: string) => string | undefined
      now: () => number
      onChange: () => void
      settleDelayMs?: number
      retryMs?: number
      startDelayMs?: number
    },
  ) {}

  /** The `wallets` topic's `empty`: each wallet's count, or why there's none, by address. */
  view(): Record<string, EmptyState> {
    const known = new Set(this.deps.wallets().map((w) => w.address))
    return Object.fromEntries([...this.states].filter(([address]) => known.has(address)))
  }

  get(address: string): EmptyState | undefined {
    return this.states.get(address)
  }

  /** Reads per minute it would make at its own pace: one a wallet each 30 minutes. */
  perMin(): number {
    return this.refreshTimer ? (this.deps.wallets().length * 60_000) / EMPTY_REFRESH_MS : 0
  }

  /** A view attached: every wallet after the start delay, then every 30 minutes. */
  start(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => void this.readAll(), EMPTY_REFRESH_MS)
    this.refreshTimer.unref?.()
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined
      this.ready = true
      void this.readAll()
    }, this.deps.startDelayMs ?? START_DELAY_MS)
    this.startTimer.unref?.()
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.startTimer) clearTimeout(this.startTimer)
    this.refreshTimer = undefined
    this.startTimer = undefined
    this.ready = false
  }

  /** The agents' wallets were read again: one first seen is read now, once the first reads have gone. */
  walletsChanged(): void {
    if (!this.ready) return
    for (const w of this.deps.wallets()) if (!this.states.has(w.address) && !this.inflight.has(w.address)) void this.read(w.address)
  }

  /** A trade, swap or close from this wallet settled: its count is read again shortly, view or not. */
  afterSettle(address: string): void {
    if (!this.deps.wallets().some((w) => w.address === address)) return
    this.later(address, this.deps.settleDelayMs ?? SETTLE_DELAY_MS)
  }

  async readAll(): Promise<void> {
    for (const w of this.deps.wallets()) await this.read(w.address)
  }

  /** One wallet's preview, read through the CLI with its own agent's key; turned back by the budget, tried a minute later. */
  async read(address: string): Promise<void> {
    const wallet = this.deps.wallets().find((w) => w.address === address)
    if (!wallet) {
      if (this.states.delete(address)) this.deps.onChange()
      return
    }
    if (this.inflight.has(address)) return
    if (this.deps.take(wallet.agent) === undefined) {
      this.later(address, this.deps.retryMs ?? RETRY_MS)
      return
    }
    this.inflight.add(address)
    try {
      const run = await this.deps.run({ agent: wallet.agent, argv: previewArgv(address), json: true, calls: PREVIEW_CALLS }).catch((error: Error) => ({ exitCode: -1, json: { code: "CLI_FAILED", message: error.message }, stderr: "", timedOut: false }))
      this.states.set(address, readPreview(run, this.deps.now()))
    } finally {
      this.inflight.delete(address)
    }
    this.deps.onChange()
  }

  close(): void {
    this.stop()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private later(address: string, ms: number): void {
    if (this.timers.has(address)) return
    const t = setTimeout(() => {
      this.timers.delete(address)
      void this.read(address)
    }, ms)
    t.unref?.()
    this.timers.set(address, t)
  }
}
