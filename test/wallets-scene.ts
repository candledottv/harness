// A 50-wallet account: the embedded wallet named main and 49 TEE wallets on two agents' keys, 13 of the 50
// trading inside limits, grouped in wallets.toml by name prefix (bots, snipers, copy, lp) and by hand
// (swing), with three in no group.
// The portfolio, wallets and autonomy topics a view reads, for the frames and the fake Candle alike.
import type { WalletsTopic } from "../src/core/agent-wallets"
import type { AutonomyTopic, AutonomyWallet } from "../src/core/autonomy"
import type { PortfolioView, WalletView } from "../src/core/portfolio-view"
import { type GroupDef, resolveGroups } from "../src/core/wallet-groups"
import type { WalletNameEntry } from "../src/core/wallet-names"
import type { FakeTeeWallet } from "./fake-candle-mcp"

const pad = (s: string) => s.padEnd(43, "1")
/** The scene's embedded wallet, as frame-scenes names it. */
export const FIFTY_EMBEDDED = pad("EmbFake")
const SOL_USD = 150

const range = (n: number, name: (i: number) => string) => Array.from({ length: n }, (_, i) => name(i + 1))
const two = (i: number) => String(i).padStart(2, "0")

/** The TEE wallets' names in the account's order, and the agent each is bound to. */
export const FIFTY_NAMES: { name: string; agent: "agent-a" | "agent-b" }[] = [
  ...range(24, (i) => `bot-${two(i)}`).map((name) => ({ name, agent: "agent-a" as const })),
  ...range(8, (i) => `snipe-${two(i)}`).map((name) => ({ name, agent: "agent-b" as const })),
  ...["swing-a", "swing-b", "swing-c", "swing-d"].map((name) => ({ name, agent: "agent-b" as const })),
  ...range(6, (i) => `copy-${two(i)}`).map((name) => ({ name, agent: "agent-b" as const })),
  ...range(3, (i) => `lp-${two(i)}`).map((name) => ({ name, agent: "agent-a" as const })),
  ...["alpha", "beta", "scratch", "old-tee"].map((name) => ({ name, agent: "agent-a" as const })),
]

/** A wallet's address from its name: 43 characters, as a Solana address is drawn here. */
export const fiftyAddress = (name: string): string => pad(`T${name.replace(/[^A-Za-z0-9]/g, "")}x`)

/** Its SOL: a spread from 0.2 to 0.775, the same every run. */
const solOf = (i: number) => 0.2 + ((i * 13 + 14) % 24) * 0.025

/** The groups, as wallets.toml writes them: four by prefix, swing by hand (with alpha). */
export const FIFTY_GROUPS: Record<string, GroupDef> = {
  bots: { prefix: "bot-" },
  copy: { prefix: "copy-" },
  lp: { prefix: "lp-" },
  snipers: { prefix: "snipe-" },
  swing: { wallets: ["swing-a", "swing-b", "swing-c", "swing-d", "alpha"] },
}

/** main and bot-01 to bot-12 trade inside limits: $1.50 a trade, $5.00 a day. */
const INSIDE = new Set(["main", ...range(12, (i) => `bot-${two(i)}`)])

export function fiftyWallets(readAt: number): { portfolio: PortfolioView; wallets: WalletsTopic; autonomy: AutonomyTopic; names: WalletNameEntry[] } {
  const tee: WalletView[] = FIFTY_NAMES.map(({ name, agent }, i) => {
    const sol = Number(solOf(i).toFixed(3))
    return { address: fiftyAddress(name), chain: "solana", kind: "tee", label: name, name, agents: [agent], active: true, sol: { amount: sol, usd: sol * SOL_USD }, tokens: [] }
  })
  const embedded: WalletView = { address: FIFTY_EMBEDDED, chain: "solana", kind: "embedded", label: "main", name: "main", agents: ["agent-a", "agent-b"], sol: { amount: 2.184, usd: 327.6 }, tokens: [] }
  const all = [embedded, ...tee]
  const names: WalletNameEntry[] = all.map((w) => ({ address: w.address, kind: w.kind, name: w.name!, owner: w.kind === "tee" ? "candle" : "harness" }))
  const groups = resolveGroups(FIFTY_GROUPS, names, ["agent-a", "agent-b"])
  const teeOf = (agent: string) => tee.filter((w) => w.agents[0] === agent).map((w) => ({ id: `tee-${w.name}`, address: w.address, label: w.name!, chain: "solana", active: true }))
  const wallets: WalletsTopic = {
    agents: {
      "agent-a": { payable: { embedded: { address: FIFTY_EMBEDDED, chain: "solana" }, tee: teeOf("agent-a"), readAt, unreadable: [] }, embeddedWallet: "allowed", prefix: "agntAb3d" },
      "agent-b": { payable: { embedded: { address: FIFTY_EMBEDDED, chain: "solana" }, tee: teeOf("agent-b"), readAt, unreadable: [] }, embeddedWallet: "allowed", prefix: "agntBb3d" },
    },
    account: [...teeOf("agent-a"), ...teeOf("agent-b")],
    boundTo: Object.fromEntries(tee.map((w) => [w.address, w.agents[0]!])),
    names,
    groups,
  }
  const used = (name: string) => (name === "main" ? 3 : name === "bot-03" ? 3.9 : INSIDE.has(name) ? 1.2 : 0)
  const setting = (w: WalletView): AutonomyWallet => ({
    wallet: w.address,
    name: w.kind === "embedded" ? "main" : w.name!,
    kind: w.kind,
    ...(INSIDE.has(w.name!) ? { setting: "inside" as const, perTradeUsd: 1.5, perDayUsd: 5 } : { setting: "ask" as const }),
    usedTodayUsd: used(w.name!),
    agents: w.agents,
    notes: [],
  })
  return {
    portfolio: { readAt, wallets: all, readOnly: [], paper: {}, deposit: FIFTY_EMBEDDED },
    wallets,
    autonomy: { read: true, wallets: all.map(setting) },
    names,
  }
}

/** The same 49 TEE wallets for the fake Candle's script: bound to agent-a's key or agent-b's by prefix. */
export function fiftyFakeTees(prefixA: string, prefixB: string): FakeTeeWallet[] {
  return FIFTY_NAMES.map(({ name, agent }, i) => ({ id: `tee-${name}`, address: fiftyAddress(name), label: name, boundKeyPrefix: agent === "agent-a" ? prefixA : prefixB, lamports: String(Math.round(solOf(i) * 1e9)) }))
}

/** wallets.toml for the account: the groups by hand, as a person would write them, and the embedded wallet named main. */
export function fiftyToml(embedded: string): string {
  return [
    "[names]",
    `"${embedded}" = "main"`,
    "",
    "[groups.bots]",
    'prefix = "bot-"',
    "",
    "[groups.snipers]",
    'prefix = "snipe-*"',
    "",
    "[groups.swing]",
    'wallets = ["swing-a", "swing-b", "swing-c", "swing-d", "alpha"]',
    "",
    "[groups.copy]",
    'prefix = "copy-"',
    "",
    "[groups.lp]",
    'prefix = "lp-"',
    "",
  ].join("\n")
}
