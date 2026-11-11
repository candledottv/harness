// What the question before live says is missing: read from what the view holds, and nothing where it can't tell.
import { expect, test } from "bun:test"
import { liveGaps } from "./live-gaps"
import type { CoreView } from "./store"

const W = "WalletFake1111111111111111111111111111111111"
const agent = (over: Record<string, unknown> = {}) => ({ name: "agent-a", candle: "ready", limits: { perTradeUsd: 5, perDayUsd: 20 }, ...over })
const view = (over: { agent?: Record<string, unknown>; wallets?: Record<string, unknown>; sol?: number | null }): Pick<CoreView, "status" | "wallets" | "portfolio"> =>
  ({
    status: { agents: [agent(over.agent)], activeAgent: "agent-a", mode: "paper", paused: false },
    ...(over.wallets ? { wallets: { agents: { "agent-a": over.wallets }, account: [], boundTo: {} } } : {}),
    ...(over.sol !== undefined ? { portfolio: { wallets: [{ address: W, chain: "solana", kind: "embedded", name: "main", agents: ["agent-a"], sol: over.sol === null ? null : { amount: over.sol, usd: null } }] } } : {}),
  }) as never

const allowed = { payable: { embedded: { address: W, chain: "solana" }, tee: [], readAt: 1, unreadable: [] }, embeddedWallet: "allowed", prefix: "FakeKey1" }

test("a wallet that pays but holds no SOL is said; one with SOL, or not read yet, isn't", () => {
  const empty = liveGaps(view({ wallets: allowed, sol: 0 }))
  expect(empty).toHaveLength(1)
  expect(empty[0]!.words).toContain("main holds no SOL, so agent-a's live buys have nothing to spend")
  expect(empty[0]!.fill).toBeUndefined()
  expect(liveGaps(view({ wallets: allowed, sol: 0.4 }))).toEqual([])
  expect(liveGaps(view({ wallets: allowed, sol: null }))).toEqual([])
  expect(liveGaps(view({ wallets: allowed }))).toEqual([])
})

test("a key not allowed any wallet gets the command that allows it; before its wallets are read, nothing is claimed", () => {
  const denied = liveGaps(view({ wallets: { payable: { tee: [], readAt: 1, unreadable: [] }, embeddedWallet: "denied", prefix: "FakeKey1" } }))
  expect(denied[0]!.fill).toEqual({ label: "allow the embedded wallet", line: "candle keys update FakeKey1 --embedded-wallet allow" })
  expect(liveGaps(view({}))).toEqual([])
  // No limits of its own here.
  expect(liveGaps(view({ agent: { limits: undefined } })).map((g) => g.words)).toEqual(["agent-a has no limits of its own set here: only Candle's caps on its key would hold a live trade."])
})

test("a key denied the embedded wallet that holds an active Hood TEE wallet can pay, and its SOL isn't asked of that wallet", () => {
  const hood = { id: "h1", address: "0x00000000000000000000000000000000000Ho0d1", label: "hood-bot", chain: "hood", active: true }
  expect(liveGaps(view({ wallets: { payable: { tee: [hood], readAt: 1, unreadable: [] }, embeddedWallet: "denied", prefix: "FakeKey1" }, sol: 0 }))).toEqual([])
})
