// What the core knows of each agent's key, from candle_execution_status: the embedded wallets it pays
// from, whether the owner has allowed it on them, its plan fee and its Candle key limit. Read when the
// core starts and when an agent is added, and kept, so proposing a card and approving one need no
// network call for it. The read bundles three API reads (agentic orchestrate.ts, executionStatus):
//   wallets  GET /agent/wallets/embedded: `wallets.solana`, `wallets.evm`, `embeddedWalletPermission`
//            (docs.candle.tv/developers/agent-wallets: no value means allowed);
//   tier     GET /agent/tier: the plan (`tier`: free, pro or max), its `feeBps`
//            (docs.candle.tv/developers/agent-trading, "Fee model"; TEE wallets need Pro or Max), and
//            `tierCaps.dailyLaunchCap`, the account's launches a UTC day (docs.candle.tv/developers/headless-launch),
//            and `tierCaps.rateLimitPerMin`, the key's requests a minute (docs.candle.tv/developers/agent-wallets);
//   limits   GET /agent/keys/self/limits: `txLimit` `{ usdMicros, reset }` (docs.candle.tv/developers/agent-access), and
//            `keyLimits`, the key's per-asset caps `[{ asset, maxPerTxRaw }]` or null for none
//            (docs.candle.tv/developers/agent-wallets, "Spend limits").
import type { ToolOutcome } from "./candle-mcp"

/** One of Candle's per-asset caps on a key: the most one buy may spend of that asset, in raw units. */
export interface AssetCap {
  /** Candle's name, lowercase: sol, usdc, cndl, eth or usdg. */
  asset: string
  /** A whole number of raw units, as a string so the status stays JSON. */
  maxPerTxRaw: string
}

export interface AgentStatus {
  readAt: number
  wallets: { solana?: string; evm?: string }
  embeddedWallet: "allowed" | "denied"
  /** The account's plan, as Candle names it: "free", "pro" or "max". */
  tier?: string
  feeBps?: number
  /** Launches a UTC day, per account: every key shares it. */
  dailyLaunchCap?: number
  /** Candle's requests a minute for this key: 30, 300 or 600 on Free, Pro and Max. */
  rateLimitPerMin?: number
  /** Candle's own cap on this key: USD volume over a window (UTC day for `daily`). Unset is unlimited. */
  keyLimit?: { usd: number; reset: string }
  /** Candle's per-asset caps on this key, on each buy (sells and base-pair swaps skip them). Unset is none. */
  assetCaps?: AssetCap[]
  /** The reads that failed; what they'd have said is unknown, not false. */
  unreadable: string[]
  /** The key's limits weren't read and no earlier read had them: Candle's caps are unknown, never "none". */
  limitsUnread?: boolean
}

/** The highest plan fee (Free, 100 bps): used when the plan can't be read, so a limit is never under-counted. */
export const FALLBACK_FEE_BPS = 100

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export function parseExecutionStatus(result: unknown, readAt: number): AgentStatus | undefined {
  const body = record(result)
  if (!body) return undefined
  const walletsBody = record(body.wallets)
  const wallets = record(walletsBody?.wallets)
  const address = (w: unknown) => {
    const a = record(w)?.address
    return typeof a === "string" && a.length > 0 ? a : undefined
  }
  const tier = record(body.tier)
  const launchCap = record(tier?.tierCaps)?.dailyLaunchCap
  const rateLimit = record(tier?.tierCaps)?.rateLimitPerMin
  const unreadable = Array.isArray(body.unreadable) ? body.unreadable.filter((u): u is string => typeof u === "string") : []
  // A partial read names the limits read as failed, or carries it unsuccessful: its caps say nothing.
  const limitsUnread = unreadable.some((u) => /limit/i.test(u)) || record(body.limits)?.success === false
  const limits = limitsUnread ? undefined : record(body.limits)
  const txLimit = record(limits?.txLimit)
  const usdMicros = txLimit?.usdMicros
  const assetCaps = parseAssetCaps(limits?.keyLimits)
  const solana = address(wallets?.solana)
  const evm = address(wallets?.evm)
  return {
    readAt,
    wallets: { ...(solana ? { solana } : {}), ...(evm ? { evm } : {}) },
    embeddedWallet: walletsBody?.embeddedWalletPermission === "denied" ? "denied" : "allowed",
    ...(typeof tier?.tier === "string" && tier.tier.length > 0 ? { tier: tier.tier.toLowerCase() } : {}),
    ...(typeof tier?.feeBps === "number" ? { feeBps: tier.feeBps } : {}),
    ...(typeof launchCap === "number" ? { dailyLaunchCap: launchCap } : {}),
    ...(typeof rateLimit === "number" && rateLimit > 0 ? { rateLimitPerMin: rateLimit } : {}),
    ...(typeof usdMicros === "number" && usdMicros > 0
      ? { keyLimit: { usd: usdMicros / 1_000_000, reset: typeof txLimit?.reset === "string" ? txLimit.reset : "never" } }
      : {}),
    ...(assetCaps.length ? { assetCaps } : {}),
    unreadable,
    ...(limitsUnread ? { limitsUnread: true } : {}),
  }
}

/** `keyLimits`: null for none; an entry that isn't a whole raw amount for a named asset is left out. */
function parseAssetCaps(value: unknown): AssetCap[] {
  if (!Array.isArray(value)) return []
  const caps: AssetCap[] = []
  for (const entry of value) {
    const e = record(entry)
    const raw = typeof e?.maxPerTxRaw === "number" && Number.isSafeInteger(e.maxPerTxRaw) ? String(e.maxPerTxRaw) : e?.maxPerTxRaw
    if (typeof e?.asset === "string" && /^[a-z]{2,8}$/i.test(e.asset) && typeof raw === "string" && /^\d{1,30}$/.test(raw)) caps.push({ asset: e.asset.toLowerCase(), maxPerTxRaw: raw })
  }
  return caps
}

export class AgentStatusBook {
  private readonly statuses = new Map<string, AgentStatus>()
  private readonly errors = new Map<string, string>()

  constructor(
    private readonly deps: {
      pool: { for(agent: string): { call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> } }
      now: () => number
    },
  ) {}

  get(agent: string): AgentStatus | undefined {
    return this.statuses.get(agent)
  }

  /** Why the last read failed, for the doctor and the card's refusal. */
  error(agent: string): string | undefined {
    return this.errors.get(agent)
  }

  async refresh(agent: string): Promise<AgentStatus | undefined> {
    const outcome = await this.deps.pool.for(agent).call("candle_execution_status", {})
    const body = outcome.kind === "ok" ? outcome.result : outcome.kind === "error" ? outcome.body : undefined
    // A partial read comes back as an error with the readable parts in it: keep what it says.
    const status = parseExecutionStatus(body, this.deps.now())
    // The limits read failed this time: the caps last read still stand, rather than reading as none.
    const before = this.statuses.get(agent)
    if (status?.limitsUnread && before && !before.limitsUnread) {
      delete status.limitsUnread
      if (before.keyLimit) status.keyLimit = before.keyLimit
      if (before.assetCaps) status.assetCaps = before.assetCaps
    }
    if (status && (outcome.kind === "ok" || status.wallets.solana || status.wallets.evm)) {
      this.statuses.set(agent, status)
      this.errors.delete(agent)
      return status
    }
    this.errors.set(agent, outcome.kind === "error" ? outcome.code : outcome.kind === "lost" ? `no answer (${outcome.reason})` : "unreadable")
    return this.statuses.get(agent)
  }
}
