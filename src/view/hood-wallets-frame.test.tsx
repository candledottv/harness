// Wallets on two chains: the Wallets pane under a heading per chain, the embedded wallet under each with its own
// balance and ⧉, each TEE wallet under its chain, and Positions grouped the same way. Kept as frames at 120×30 and
// 80×24, from test/hood-scene.ts. An account on Solana alone is unchanged: its frames are
// frames.test.tsx's.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { CLOCK, drawScene } from "../../test/frame-scenes"
import { hoodWallets } from "../../test/hood-scene"
import { positionLines } from "./panes/positions"
import { walletLines } from "./panes/wallets"

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
  [120, 30],
  [80, 24],
] as const

const PAGE_DOWN = "\x1b[6~"

async function twoChains(width: number, height: number, o: Parameters<typeof hoodWallets>[1] = {}, pane: "wallets" | "positions" = "wallets") {
  const drawn = await drawScene("followed", width, height, "trade")
  setup = drawn.setup
  const h = hoodWallets(CLOCK - 3_000, o)
  for (const [topic, data] of [
    ["wallets", h.wallets],
    ["portfolio", h.portfolio],
  ] as const) {
    await act(async () => drawn.session.push(topic, data, true))
    await drawn.setup.renderOnce()
  }
  // Focus on the pane (a focused side pane takes the rows); below 100 columns the side panes are one switched pane.
  const title = pane === "wallets" ? "Wallets" : "Positions"
  await act(async () => {
    if (width >= 100) {
      const rows = drawn.setup.captureCharFrame().split("\n")
      const y = rows.findIndex((r) => r.includes(`╭─ ${title}`))
      return drawn.setup.mockMouse.click(rows[y]!.indexOf(`╭─ ${title}`) + 3, y)
    }
  })
  if (width < 100) for (let i = 0; i < (pane === "wallets" ? 3 : 2); i++) await act(async () => drawn.setup.mockInput.pressArrow("right"))
  await act(async () => drawn.setup.mockMouse.moveTo(0, height - 1))
  await drawn.setup.renderOnce()
  return drawn
}

async function click(s: Setup, text: string, nth = 0) {
  const rows = s.captureCharFrame().split("\n")
  const ys = rows.map((r, y) => (r.includes(text) ? y : -1)).filter((y) => y >= 0)
  const y = ys[nth]
  if (y === undefined) throw new Error(`"${text}" isn't on screen`)
  await act(async () => s.mockMouse.click(rows[y]!.indexOf(text) + 1, y))
  await s.renderOnce()
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


/** A pane's lines as text. */
const text = (lines: readonly { segs: readonly { text: string }[] }[]) => lines.map((l) => l.segs.map((x) => x.text).join("")).join("\n")

test("the Wallets pane's lines on two chains: Solana, then Hood, the embedded wallet under each in its own asset", () => {
  const p = hoodWallets(CLOCK - 3_000).portfolio
  for (const rows of [undefined, 4]) {
    const t = text(walletLines(p, { mode: "live", now: CLOCK, width: 46, ...(rows ? { rows } : {}) }))
    expect(t.indexOf("Solana")).toBeLessThan(t.indexOf("Hood"))
    expect(t.slice(0, t.indexOf("Hood"))).not.toContain("ETH")
    expect(t.slice(t.indexOf("Hood"))).not.toMatch(/\bSOL\b/)
    expect(t).toMatch(/embedded[^\n]*(\n[^\n]*)?2\.184 SOL/)
    expect(t).toMatch(/embedded[^\n]*(\n[^\n]*)?0\.05 ETH/)
    expect(t).toMatch(/bot-1-h[^\n]*(\n[^\n]*)?0\.002 ETH/)
    // Each embedded wallet has its own ⧉.
    expect(t.split("\n").filter((r) => /^embedded/.test(r) && r.includes("⧉")).length).toBe(2)
  }
})

test("Positions' lines on two chains: a heading per chain over its holdings", () => {
  const t = text(positionLines(hoodWallets(CLOCK - 3_000).portfolio, { mode: "live", now: CLOCK, width: 46, market: undefined }))
  expect(t.split("\n").slice(0, 5)).toEqual(["Solana", "embedded wallet · agent-a, agent-b", expect.stringContaining("JUPF"), expect.stringContaining("LUMEN"), "Hood"])
  expect(t.slice(t.indexOf("Hood"))).toMatch(/KITE[\s\S]*bot-1-h · TEE wallet[\s\S]*MOON/)
})

test("on one chain, neither pane draws a heading", () => {
  const p = hoodWallets(CLOCK - 3_000).portfolio
  const solana = { ...p, wallets: p.wallets.filter((w) => w.chain === "solana") }
  expect(text(walletLines(solana, { mode: "live", now: CLOCK, width: 46 }))).not.toContain("Solana")
  expect(text(positionLines(solana, { mode: "live", now: CLOCK, width: 46, market: undefined }))).not.toContain("Solana")
})

for (const [width, height] of SIZES) {
  test(`the Wallets pane on two chains, as it opens, at ${width}×${height}`, async () => {
    const d = await twoChains(width, height)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("Solana")
    // Where the pane is short, Hood is below, and the pane says how many more.
    if (!frame.includes("Hood")) expect(frame).toMatch(/Wallets[\s\S]*↓ 3 more/)
    await compare(`hood-wallets-${width}x${height}-pane`, d.setup)
    if (frame.includes("Hood")) return
    await act(async () => d.setup.mockInput.pressKey(PAGE_DOWN))
    await d.setup.renderOnce()
    expect(d.setup.captureCharFrame()).toMatch(/Hood\s*│\n[^\n]*embedded +0\.05 ETH/)
    await compare(`hood-wallets-${width}x${height}-pane-down`, d.setup)
  })

  test(`a Hood TEE wallet holding USDG and no ETH says it needs ETH to trade, dim, at ${width}×${height}`, async () => {
    const d = await twoChains(width, height, { hoodBot: "usdg-only" })
    await act(async () => d.setup.mockInput.pressKey(PAGE_DOWN))
    await d.setup.renderOnce()
    expect(d.setup.captureCharFrame()).toMatch(/needs ETH/)
    await compare(`hood-wallets-${width}x${height}-needs-eth`, d.setup)
  })

  test(`Positions follows, as it opens, at ${width}×${height}`, async () => {
    const d = await twoChains(width, height, {}, "positions")
    expect(d.setup.captureCharFrame()).toMatch(/Positions[\s\S]*Solana/)
    await compare(`hood-positions-${width}x${height}`, d.setup)
  })
}

const HOOD_CHIP = "candle vault promote --to-key agntBb3d --label agent-b-hood --from cold-evm"
for (const [width, height] of [
  [80, 24],
  [120, 30],
  [160, 45],
] as const) {
  test(`an agent with no Hood TEE wallet: a line under Hood with the chip, which types its next step and sends nothing, at ${width}×${height}`, async () => {
    const d = await twoChains(width, height, { hoodChip: HOOD_CHIP })
    for (let i = 0; i < 3 && !d.setup.captureCharFrame().includes("add a Hood wallet"); i++) {
      await act(async () => d.setup.mockInput.pressKey(PAGE_DOWN))
      await d.setup.renderOnce()
    }
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("add a Hood wallet")
    expect(frame).toMatch(/agent-b: no Hood/)
    await compare(`hood-wallets-${width}x${height}-chip`, d.setup)
    const sent = d.session.requests.length
    await click(d.setup, "add a Hood wallet")
    await act(async () => d.setup.mockMouse.moveTo(0, height - 1))
    await d.setup.renderOnce()
    expect(d.session.requests.length).toBe(sent)
    expect(d.setup.captureCharFrame()).toContain(HOOD_CHIP.slice(-30))
  })
}
