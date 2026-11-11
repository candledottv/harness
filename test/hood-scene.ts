// An account with wallets on Solana and Hood: the embedded wallet on each chain, two
// Solana TEE wallets (bot-1 on agent-a's key, bot-2 on agent-b's) and a Hood TEE wallet (bot-1-h, agent-a's),
// with holdings on both chains. With `hoodBot: "usdg-only"`, bot-1-h holds USDG and no ETH, for the "needs ETH" note.
// The portfolio and wallets topics a view reads, for the frames.
import type { WalletsTopic } from "../src/core/agent-wallets"
import type { PortfolioView, WalletView } from "../src/core/portfolio-view"
import type { WalletNameEntry } from "../src/core/wallet-names"

const pad = (s: string) => s.padEnd(43, "1")
export const HOOD_SOL_EMBEDDED = pad("EmbFake")
export const HOOD_EVM_EMBEDDED = "0x7a3f00000000000000000000000000000000c41e"
const BOT_1 = pad("TbotOne")
const BOT_2 = pad("TbotTwo")
export const HOOD_BOT = "0x9b2e00000000000000000000000000000000d07a"
const JUPF = pad("JupF")
const LUMEN = pad("Lumen")
const KITE = "0x1f8e00000000000000000000000000000000ab12"
const MOON = "0xae6b00000000000000000000000000000000f3c4"
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"

const sol = (amount: number) => ({ nativeSymbol: "SOL", native: { amount, usd: amount * 150 } })
const eth = (amount: number) => ({ nativeSymbol: "ETH", native: { amount, usd: amount * 3300 } })

export function hoodWallets(readAt: number, o: { hoodBot?: "eth" | "usdg-only"; hoodChip?: string } = {}): { portfolio: PortfolioView; wallets: WalletsTopic } {
  const usdgOnly = o.hoodBot === "usdg-only"
  const ws: WalletView[] = [
    { address: HOOD_SOL_EMBEDDED, chain: "solana", kind: "embedded", name: "embedded", agents: ["agent-a", "agent-b"], ...sol(2.184), tokens: [
      { mint: JUPF, symbol: "JUPF", amount: 120.5, usd: 51.2, buyers: ["agent-a"] },
      { mint: LUMEN, symbol: "LUMEN", amount: 40_210, usd: 12.04, buyers: ["agent-b"] },
    ] },
    { address: BOT_1, chain: "solana", kind: "tee", label: "bot-1", name: "bot-1", agents: ["agent-a"], active: true, ...sol(1), tokens: [] },
    { address: BOT_2, chain: "solana", kind: "tee", label: "bot-2", name: "bot-2", agents: ["agent-b"], active: true, ...sol(0.4), tokens: [] },
    { address: HOOD_EVM_EMBEDDED, chain: "hood", kind: "embedded", name: "embedded", agents: ["agent-a", "agent-b"], ...eth(0.05), tokens: [{ mint: KITE, symbol: "KITE", amount: 2150, usd: 8.6, buyers: ["agent-b"] }] },
    usdgOnly
      ? { address: HOOD_BOT, chain: "hood", kind: "tee", label: "bot-1-h", name: "bot-1-h", agents: ["agent-a"], active: true, ...eth(0), needsNative: true, tokens: [{ mint: USDG, symbol: "USDG", amount: 25, usd: 25, buyers: [] }] }
      : { address: HOOD_BOT, chain: "hood", kind: "tee", label: "bot-1-h", name: "bot-1-h", agents: ["agent-a"], active: true, ...eth(0.002), tokens: [{ mint: MOON, symbol: "MOON", amount: 18_400, usd: 57.04, buyers: ["agent-a"] }] },
  ]
  const names: WalletNameEntry[] = ws.map((w) => ({ address: w.address, kind: w.kind, name: w.name!, owner: w.kind === "tee" ? "candle" : "harness" }))
  const tee = (address: string, label: string, chain: "solana" | "hood") => ({ id: `tee-${label}`, address, label, chain, active: true })
  const wallets: WalletsTopic = {
    agents: {
      "agent-a": { payable: { embedded: { address: HOOD_SOL_EMBEDDED, chain: "solana" }, tee: [tee(BOT_1, "bot-1", "solana"), tee(HOOD_BOT, "bot-1-h", "hood")], readAt, unreadable: [] }, embeddedWallet: "allowed", prefix: "agntAb3d", evm: HOOD_EVM_EMBEDDED },
      "agent-b": { payable: { embedded: { address: HOOD_SOL_EMBEDDED, chain: "solana" }, tee: [tee(BOT_2, "bot-2", "solana")], readAt, unreadable: [] }, embeddedWallet: "allowed", prefix: "agntBb3d", evm: HOOD_EVM_EMBEDDED },
    },
    account: [tee(BOT_1, "bot-1", "solana"), tee(BOT_2, "bot-2", "solana"), tee(HOOD_BOT, "bot-1-h", "hood")],
    boundTo: { [BOT_1]: "agent-a", [BOT_2]: "agent-b", [HOOD_BOT]: "agent-a" },
    names,
    groups: [],
    // agent-b has no Hood TEE wallet of its own: the chip's step, where a test offers it.
    ...(o.hoodChip ? { hoodWallet: { "agent-b": { label: "add a Hood wallet", line: o.hoodChip } } } : {}),
  }
  return { portfolio: { readAt, wallets: ws, readOnly: [], paper: {}, deposit: HOOD_SOL_EMBEDDED }, wallets }
}
