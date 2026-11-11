// The chain filter on screen, drawn from the account with wallets on Solana and Hood (test/hood-scene.ts) over the
// Trade tab: the status bar's chip with its menu open, all chains with each row's chain at its edge and a card on
// Hood saying so, and Hood picked, every listing pane showing Hood's rows alone. Kept at 80×24, 120×30 and 160×45.
import { afterEach, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect } from "bun:test"
import { act } from "react"
import { card, CLOCK, drawScene, status } from "../../test/frame-scenes"
import { hoodWallets } from "../../test/hood-scene"
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
  [80, 24],
  [120, 30],
  [160, 45],
] as const

const MOON = "0xae6b00000000000000000000000000000000f3c4"
const KITE = "0x1f8e00000000000000000000000000000000ab12"
const LUMEN = "LumenFake1111111111111111111111111111111111"
const at = (hh: number, mm: number) => new Date(Date.UTC(new Date(CLOCK).getUTCFullYear(), new Date(CLOCK).getUTCMonth(), new Date(CLOCK).getUTCDate(), hh, mm)).toISOString()
const activity = [
  { seq: 1, at: at(7, 58), agent: "agent-b", text: "filled BUY 0.04 SOL → LUMEN", tone: "good", mint: LUMEN, chain: "solana" },
  { seq: 2, at: at(8, 2), agent: "agent-b", text: "filled BUY 0.01 ETH → KITE", tone: "good", mint: KITE, chain: "hood" },
  { seq: 3, at: at(8, 6), agent: "agent-a", text: "filled SELL 50% QUILL · 0.21 SOL", tone: "good", mint: LUMEN, chain: "solana" },
]
const hoodCard: ViewCard = {
  ...card,
  cardId: "h1",
  opId: "op-h1",
  cardHash: "hash-h1",
  chain: "hood",
  params: { mint: MOON, side: "buy", amount: "0.01" },
  display: { ...card.display, title: "BUY 0.01 ETH (≈$33.00) → MOON", headline: "BUY 0.01 ETH of MOON", mint: MOON, mintLabel: "MOON", price: "MOON $0.0031", why: "buyers steady on the hour, pool growing", paysFrom: "pays from bot-1-h · TEE" },
}

async function scene(width: number, height: number, chain: "hood" | null) {
  const drawn = await drawScene("followed", width, height, "trade")
  setup = drawn.setup
  const h = hoodWallets(CLOCK - 3_000)
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => drawn.session.push(topic, data, snapshot))
    await drawn.setup.renderOnce()
  }
  await push("wallets", h.wallets, true)
  await push("portfolio", h.portfolio, true)
  await push("cards", { ...card, state: "rejected" })
  await push("cards", hoodCard)
  // The scene's own Activity predates a line's chain: these, each with its chain, take its place.
  await push("activity", { lines: activity }, true)
  await push("views", { link: null, pins: [], signals: [], popped: [], chain })
  await act(async () => drawn.setup.mockMouse.moveTo(0, height - 1))
  await drawn.setup.renderOnce()
  return drawn
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
  test(`the chain chip's menu, open over all chains, at ${width}×${height}`, async () => {
    const d = await scene(width, height, null)
    const rows = d.setup.captureCharFrame().split("\n")
    const x = rows[0]!.indexOf("all chains ▾")
    expect(x).toBeGreaterThan(0)
    await act(async () => d.setup.mockMouse.click(x + 2, 0))
    await act(async () => d.setup.mockMouse.moveTo(0, height - 1))
    await d.setup.renderOnce()
    expect(d.setup.captureCharFrame()).toContain("✓ all chains")
    await compare(`chain-filter-${width}x${height}-menu`, d.setup)
  })

  test(`all chains: each mixed row's chain at its edge, and the card on Hood says so, at ${width}×${height}`, async () => {
    const d = await scene(width, height, null)
    const f = d.setup.captureCharFrame()
    expect(f).toContain("· on Hood")
    await compare(`chain-filter-${width}x${height}-all`, d.setup)
  })

  test(`Hood picked: every listing pane shows Hood's rows alone, the agent's pane and the card as they were, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "hood")
    const f = d.setup.captureCharFrame()
    expect(f.split("\n")[0]).toContain("Hood ▾")
    expect(f).not.toContain("LUMEN")
    expect(f).toContain("· on Hood")
    await compare(`chain-filter-${width}x${height}-hood`, d.setup)
  })
}

test("at 80 columns, a long agent name with the chain chip and a card waiting: the waiting count stays and the chain chip goes first", async () => {
  const d = await scene(80, 24, null)
  const long = "momentum-trader-on-hood"
  await act(async () => d.session.push("status", { ...status, activeAgent: long, agents: status.agents.map((a, i) => (i === 0 ? { ...a, name: long } : a)) }, true))
  await d.setup.renderOnce()
  const top = d.setup.captureCharFrame().split("\n")[0]!
  expect(top).toContain(`${long} ▾`)
  expect(top).toContain("● 1 card waiting")
  expect(top).toContain("ctrl-x ×2 kill")
  expect(top).not.toContain("all chains")
  await compare("chain-filter-80x24-long-agent", d.setup)
})
