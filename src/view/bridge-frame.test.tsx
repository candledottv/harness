// A bridge on screen: its card, waiting (what and roughly what arrives, the route between the account's two wallets,
// how it goes and what it costs, the chips), then on its way, folded to where the funds are. Kept as frames at each
// size, as frames.test.tsx keeps the Trade tab's.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { CLOCK, drawScene, TEE } from "../../test/frame-scenes"
import type { ViewCard } from "./store"

process.env.TZ = "UTC"
const DIR = join(import.meta.dir, "../../test/fixtures/frames")
const UPDATE = process.env.UPDATE_FRAMES === "1"

type Setup = Awaited<ReturnType<typeof drawScene>>["setup"]
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

const SIZES = [
  [160, 45],
  [120, 30],
  [80, 24],
] as const

const HOOD_TEE = "0x00000000000000000000000000000000000E7e01"
const bridge: ViewCard = {
  cardId: "cb",
  opId: "op-cb",
  cardHash: "hash-cb",
  kind: "bridge",
  tool: "candle_bridge",
  agent: "agent-a",
  chain: "solana",
  state: "awaiting_approval",
  expiresAt: new Date(CLOCK + 50_000).toISOString(),
  params: { argv: ["swap", "SOL", "ETH", "--amount", "0.5", "--wallet", TEE, "--to", HOOD_TEE, "--client-trade-id", "op-cb", "--yes", "--json"], identity: "agent", agent: "agent-a", json: true },
  display: {
    title: "BRIDGE 0.5 SOL → ETH (≈$75.00)",
    headline: "BRIDGE 0.5 SOL → ETH",
    gets: { amount: 0.025, asset: "ETH" },
    valueUsd: 75,
    agent: "agent-a",
    wallet: TEE,
    walletLabel: "bot-1",
    paysFrom: "pays from bot-1 (TEE · TeeF…1111)",
    mode: "live",
    expiresAt: new Date(CLOCK + 50_000).toISOString(),
    why: "bot-1-h is nearly out of ETH for gas",
    bridge: { route: "bot-1 · TEE (Solana) → bot-1-h · TEE (Hood)", via: "via Relay · no Candle fee · same key, not funds out", arriving: "sent on Solana · arriving on Hood…" },
  },
}

async function scene(width: number, height: number) {
  const drawn = await drawScene("followed", width, height, "trade")
  setup = drawn.setup
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => drawn.session.push(topic, data, snapshot))
    await drawn.setup.renderOnce()
  }
  // The scene's own card goes: this conversation is the bridge.
  await push("cards", [], true)
  await push("agent", { agent: "agent-a", turnId: "tb", type: "ended", user: "bot-1-h is nearly out of ETH for gas, top it up", reply: "bot-1 holds SOL on the same key, so half a SOL can cross to bot-1-h. It's a card for you to approve.", outcome: "done" })
  return { ...drawn, push }
}

async function compare(name: string, s: Setup): Promise<void> {
  const chars = s.captureCharFrame()
  const runs = s
    .captureSpans()
    .lines.map((l, y) => `${y}: ${l.spans.map((sp) => `${[sp.fg.r, sp.fg.g, sp.fg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}/${[sp.bg.r, sp.bg.g, sp.bg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}${sp.attributes ? `+${sp.attributes}` : ""}×${sp.width}`).join(" ")}`)
    .join("\n")
  const got = `${chars}\n--- colours ---\n${runs}\n`
  const file = join(DIR, `${name}.txt`)
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE) throw new Error(`No frame kept for ${name}: run with UPDATE_FRAMES=1 to keep this one.\n${got}`)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, got)
    return
  }
  expect(got).toBe(readFileSync(file, "utf8"))
}

for (const [width, height] of SIZES) {
  test(`a bridge card waiting: its route between the two wallets, how it goes, and the chips, at ${width}×${height}`, async () => {
    const d = await scene(width, height)
    await d.push("cards", bridge)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("BRIDGE 0.5 SOL → ETH")
    expect(frame).toContain("bot-1 · TEE (Solana) → bot-1-h")
    expect(frame).toContain("via Relay · no Candle fee")
    expect(frame).toContain("approve")
    await compare(`bridge-${width}x${height}-card`, d.setup)
  })

  test(`a bridge on its way, folded to where the funds are, at ${width}×${height}`, async () => {
    const d = await scene(width, height)
    await d.push("operations", [{ opId: "op-cb", cardId: "cb", agent: "agent-a", state: "pending", kind: "bridge", route: "cli", startedAt: CLOCK - 24_000 }], true)
    await d.push("cards", { ...bridge, state: "approved", approvedHow: "enter", operation: { state: "pending" } })
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("◌ BRIDGE 0.5 SOL → ETH")
    expect(frame).toContain("sent on Solana · arriving on Hood…")
    await compare(`bridge-${width}x${height}-in-flight`, d.setup)
  })
}
