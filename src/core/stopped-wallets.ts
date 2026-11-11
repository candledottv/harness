// TEE wallets this Candle Harness stopped. `candle tee disable` is final: the CLI
// never re-enables a TEE wallet, and Candle then drops it from every list a key or the owner can read
// (`keys wallets`, `wallets`), so the Wallets pane, the kill report and the agent lost it with its funds
// still in it. The core remembers each one it stopped in the prompt pane, until a sweep in the pane
// retires it, then keeps it as retired, so nothing sends funds there again (`vault list` still
// lists a retired TEE wallet as a plain one). A wallet stopped outside the Candle Harness is caught by what the
// account's portfolio lists: every Solana TEE wallet it has listed is remembered, and one missing from two
// reads in a row is kept as stopped outside the Candle Harness, until it's listed again or swept.
import { readFile, rename, writeFile } from "node:fs/promises"
import { sameAddress } from "../shared/address-key"
import { terminalText } from "../shared/terminal-text"
import { EVM_ADDRESS_SOURCE, SOLANA_ADDRESS_SOURCE } from "../shared/chains"

export interface StoppedWallet {
  address: string
  label?: string
  /** The agent whose key it was bound to. */
  agent?: string
  /** When the stop finished, or was asked for (exit 3: not yet confirmed). */
  at: string
  confirmed: boolean
  /** Not stopped here: Candle stopped listing it, which a stop elsewhere does. */
  outside?: true
}

/** A TEE wallet the account's portfolio listed. */
export interface ListedWallet {
  address: string
  label?: string
  agent?: string
}

/** A Solana address, or a Hood one: a 0x wallet stopped in the pane is kept across a core start like any other. */
const ADDRESS = new RegExp(`^(?:${SOLANA_ADDRESS_SOURCE}|${EVM_ADDRESS_SOURCE})$`)

/**
 * Whether a portfolio read says which TEE wallets are missing: it must list TEE wallets at all, and its
 * wallet list must not be cut off. A `walletsComplete` that is anything but `true` is a cut-off list; a server that predates
 * that field may mean the same by `complete: false`, so that counts as cut off too (candle_get_portfolio).
 * A cut-off list that misses a live wallet would otherwise mark it stopped, and a stable cut never clears.
 */
export function listsEveryTee(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false
  const read = body as { tee?: unknown; walletsComplete?: unknown; complete?: unknown }
  if (!Array.isArray(read.tee)) return false
  // Present and anything but true (false, null, "false"): cut off.
  if (read.walletsComplete !== undefined) return read.walletsComplete === true
  if (read.complete === false) return false
  return true
}

export class StoppedWallets {
  private list: StoppedWallet[] = []
  private retiredList: { address: string; label?: string; at: string }[] = []
  private seenList: ListedWallet[] = []
  /** How many reads in a row each seen wallet has been missing from. */
  private readonly missing = new Map<string, number>()

  /** Whose wallets the seen list holds (the account's embedded wallet): another account's starts it again. */
  private seenFor: string | undefined

  constructor(private readonly deps: { file: string }) {}

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.deps.file, "utf8")) as { stopped?: unknown; retired?: unknown; seen?: unknown; account?: unknown }
      this.seenFor = typeof saved.account === "string" ? saved.account : undefined
      this.seenList = Array.isArray(saved.seen) ? saved.seen.flatMap((w) => (parseListed(w) ? [parseListed(w)!] : [])) : []
      this.list = Array.isArray(saved.stopped) ? saved.stopped.flatMap((w) => (parse(w) ? [parse(w)!] : [])) : []
      this.retiredList = Array.isArray(saved.retired)
        ? saved.retired.flatMap((w) => {
            const r = parse(w)
            return r ? [{ address: r.address, ...(r.label ? { label: r.label } : {}), at: r.at }] : []
          })
        : []
    } catch {
      this.list = []
      this.retiredList = []
      this.seenList = []
    }
  }

  /**
   * One good portfolio read's Solana TEE wallets. A wallet seen before and missing from two reads in a row is
   * kept as stopped outside the Candle Harness; one listed again is taken off. Saved only when something changed.
   */
  async listed(given: readonly ListedWallet[], now: number, account?: string): Promise<void> {
    // Only a real address is kept: it's shown, typed into the sweep chip's command and told to the agent.
    const wallets = given.filter((w) => typeof w.address === "string" && ADDRESS.test(w.address))
    let changed = false
    // Another account's portfolio: none of the old list is missing, it's someone else's.
    if (account !== undefined && account !== this.seenFor) {
      if (this.seenFor !== undefined) this.seenList = []
      this.missing.clear()
      this.seenFor = account
      changed = true
    }
    const listed = new Set(wallets.map((w) => w.address))
    for (const w of wallets) {
      this.missing.delete(w.address)
      const seen = this.seenList.find((s) => s.address === w.address)
      if (!seen || seen.label !== w.label || seen.agent !== w.agent) {
        this.seenList = [...this.seenList.filter((s) => s.address !== w.address), { address: w.address, ...(w.label ? { label: w.label } : {}), ...(w.agent ? { agent: w.agent } : {}) }]
        changed = true
      }
      if (this.list.some((s) => s.address === w.address && s.outside)) {
        this.list = this.list.filter((s) => s.address !== w.address)
        changed = true
      }
    }
    for (const seen of this.seenList) {
      if (listed.has(seen.address) || this.gone(seen.address)) continue
      const count = (this.missing.get(seen.address) ?? 0) + 1
      this.missing.set(seen.address, count)
      if (count < 2) continue
      this.list = [...this.list, { address: seen.address, ...(seen.label ? { label: seen.label } : {}), ...(seen.agent ? { agent: seen.agent } : {}), at: new Date(now).toISOString(), confirmed: false, outside: true }]
      changed = true
    }
    if (changed) await this.save()
  }

  all(): StoppedWallet[] {
    return this.list.map((w) => ({ ...w }))
  }

  has(address: string): boolean {
    return this.list.some((w) => sameAddress(w.address, address))
  }

  /** Whether an address is stopped for good, or swept and retired: either way, no place to send funds. */
  gone(address: string): "stopped" | "retired" | undefined {
    if (this.has(address)) return "stopped"
    return this.retiredList.some((w) => sameAddress(w.address, address)) ? "retired" : undefined
  }

  async stopped(wallet: Omit<StoppedWallet, "at" | "confirmed">, opts: { now: number; confirmed: boolean }): Promise<void> {
    const held = this.list.find((w) => sameAddress(w.address, wallet.address))
    const entry: StoppedWallet = {
      address: wallet.address,
      ...((wallet.label ?? held?.label) ? { label: wallet.label ?? held!.label! } : {}),
      ...((wallet.agent ?? held?.agent) ? { agent: wallet.agent ?? held!.agent! } : {}),
      at: new Date(opts.now).toISOString(),
      confirmed: opts.confirmed || held?.confirmed === true,
    }
    this.list = [...this.list.filter((w) => !sameAddress(w.address, wallet.address)), entry]
    await this.save()
  }

  /** A sweep in the pane finished: the CLI retired the address, and there's nothing left to do. */
  async swept(address: string, now = Date.now()): Promise<void> {
    const held = this.list.find((w) => sameAddress(w.address, address))
    if (this.retiredList.some((w) => sameAddress(w.address, address))) return
    this.list = this.list.filter((w) => !sameAddress(w.address, address))
    this.retiredList = [...this.retiredList, { address, ...(held?.label ? { label: held.label } : {}), at: new Date(now).toISOString() }]
    await this.save()
  }

  /** A rename finished in the pane: the kept label follows it by address, stopped or retired. */
  async relabel(renames: readonly { address: string; name: string }[]): Promise<void> {
    const by = new Map(renames.map((r) => [r.address, r.name]))
    if (!this.list.some((w) => by.has(w.address)) && !this.retiredList.some((w) => by.has(w.address))) return
    this.list = this.list.map((w) => (by.has(w.address) ? { ...w, label: by.get(w.address)! } : w))
    this.retiredList = this.retiredList.map((w) => (by.has(w.address) ? { ...w, label: by.get(w.address)! } : w))
    await this.save()
  }

  /** Retired wallets, with their kept labels: still known by name, never somewhere to send funds. */
  retired(): { address: string; label?: string }[] {
    return this.retiredList.map((w) => ({ address: w.address, ...(w.label ? { label: w.label } : {}) }))
  }

  private async save(): Promise<void> {
    const tmp = `${this.deps.file}.tmp`
    await writeFile(tmp, `${JSON.stringify({ stopped: this.list, retired: this.retiredList, seen: this.seenList, ...(this.seenFor ? { account: this.seenFor } : {}) })}\n`, { mode: 0o600 })
    await rename(tmp, this.deps.file)
  }
}

function parse(value: unknown): StoppedWallet | undefined {
  const w = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  if (typeof w?.address !== "string" || !ADDRESS.test(w.address) || typeof w.at !== "string") return undefined
  return {
    address: w.address,
    ...(typeof w.label === "string" ? { label: terminalText(w.label, { maxLength: 64 }) } : {}),
    ...(typeof w.agent === "string" ? { agent: terminalText(w.agent, { maxLength: 64 }) } : {}),
    at: w.at,
    confirmed: w.confirmed === true,
    ...(w.outside === true ? { outside: true as const } : {}),
  }
}

function parseListed(value: unknown): ListedWallet | undefined {
  const w = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  if (typeof w?.address !== "string" || !ADDRESS.test(w.address)) return undefined
  return {
    address: w.address,
    ...(typeof w.label === "string" ? { label: terminalText(w.label, { maxLength: 64 }) } : {}),
    ...(typeof w.agent === "string" ? { agent: terminalText(w.agent, { maxLength: 64 }) } : {}),
  }
}

/** What the agent is told of the wallets it can't use any more, ahead of each turn. */
export function stoppedNote(list: readonly StoppedWallet[], agent: string): string | undefined {
  const mine = list.filter((w) => w.agent === agent)
  if (mine.length === 0) return undefined
  const named = mine.map((w) => `${w.label ?? "a TEE wallet"} (${w.address})${w.outside ? ", which Candle stopped listing, as a stop outside the Candle Harness does" : ""}`).join(" and ")
  return `Stopped for good on Candle: ${named}. Candle never re-enables a stopped TEE wallet, so you can't trade from it again, and candle tee enable won't bring it back. Its funds are still in it until the user sweeps it home (candle tee sweep <address>, to its pinned vault); after that it's retired, and a new TEE wallet is promoted from a vault key to an agent's key (candle vault promote), then funded from that vault key.`
}
