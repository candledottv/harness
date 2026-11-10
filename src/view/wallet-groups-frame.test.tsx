// Wallet groups on screen at 50 wallets: the Wallets pane's groups folded and one open, its search, the
// approvals menu grouped as the pane, and naming several from the overlay of every wallet. Kept as frames,
// as frames.test.tsx keeps the Trade tab's, at three sizes, from a 50-wallet account (test/wallets-scene.ts).
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { CLOCK, drawScene } from "../../test/frame-scenes"
import { fiftyAddress, fiftyWallets } from "../../test/wallets-scene"

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

async function fifty(width: number, height: number) {
  const drawn = await drawScene("followed", width, height, "trade")
  setup = drawn.setup
  const f = fiftyWallets(CLOCK - 3_000)
  for (const [topic, data] of [
    ["wallets", f.wallets],
    ["portfolio", f.portfolio],
    ["autonomy", f.autonomy],
  ] as const) {
    await act(async () => drawn.session.push(topic, data, true))
    await drawn.setup.renderOnce()
  }
  // Below 100 columns the side panes are one switched pane: on to Wallets.
  if (width < 100) {
    for (let i = 0; i < 2; i++) await click(drawn.setup, "▸")
    // The pointer off the chip, so its hover colour isn't in the frame however the timing falls.
    await act(async () => drawn.setup.mockMouse.moveTo(0, height - 1))
    await drawn.setup.renderOnce()
  }
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

async function press(s: Setup, ...keys: (string | { key: string; ctrl?: boolean } | "up" | "down" | "left" | "right" | "escape" | "backspace")[]) {
  for (const k of keys) {
    await act(async () => {
      if (k === "up" || k === "down" || k === "left" || k === "right") return s.mockInput.pressArrow(k)
      // Esc waits out the terminal's escape-sequence timeout before it counts as a key.
      if (k === "escape") {
        s.mockInput.pressEscape()
        return Bun.sleep(30)
      }
      if (k === "backspace") return s.mockInput.pressBackspace()
      if (typeof k === "string") return s.mockInput.pressKey(k)
      return s.mockInput.pressKey(k.key, k.ctrl ? { ctrl: true } : {})
    })
    await s.renderOnce()
  }
}

/** A click on the first place `text` is drawn, the `nth` row it's on. */
async function click(s: Setup, text: string, nth = 0) {
  const rows = s.captureCharFrame().split("\n")
  const ys = rows.map((r, y) => (r.includes(text) ? y : -1)).filter((y) => y >= 0)
  const y = ys[nth]
  if (y === undefined) throw new Error(`"${text}" isn't on screen`)
  await act(async () => s.mockMouse.click(rows[y]!.indexOf(text) + 1, y))
  await s.renderOnce()
}

const palette = (s: Setup, words: string) => press(s, { key: "k", ctrl: true }, ...words.split(""), "\r")

for (const [width, height] of SIZES) {
  test(`the Wallets pane at 50 wallets, as it opens: the embedded wallet, then each group folded, at ${width}×${height}`, async () => {
    const d = await fifty(width, height)
    const frame = d.setup.captureCharFrame()
    // Narrow, the embedded wallet's kind goes before its ⧉ does.
    expect(frame).toMatch(width >= 100 ? /  main {9}2\.184 SOL/ : /main {2}2\.184 SOL ≈\$328 +⧉/)
    expect(frame).toMatch(/▸ bots +24 +11\.7 SOL/)
    expect(frame).not.toContain("bot-01")
    expect(frame).toContain("all groups ▾")
    await compare(`wallet-groups-${width}x${height}-pane`, d.setup)
  })

  test(`a click on a group opens it, one line a wallet, at ${width}×${height}`, async () => {
    const d = await fifty(width, height)
    await click(d.setup, "bots")
    const frame = d.setup.captureCharFrame()
    expect(frame).toMatch(/▾ bots/)
    expect(frame).toMatch(/bot-01 +0\.55 SOL/)
    // A second click folds it.
    await compare(`wallet-groups-${width}x${height}-pane-open`, d.setup)
    await click(d.setup, "bots")
    expect(d.setup.captureCharFrame()).not.toContain("bot-01")
  })

  test(`⌕ find: "bot-1" finds ten across the groups, and esc ends the search, at ${width}×${height}`, async () => {
    const d = await fifty(width, height)
    await click(d.setup, "⌕ find")
    // The pointer off the chip it clicked, so a hover colour isn't in the frame however the timing falls.
    await act(async () => d.setup.mockMouse.moveTo(0, height - 1))
    await press(d.setup, ..."bot-1".split(""))
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("bot-1▏")
    expect(frame).toContain("10 of 50")
    expect(frame).toContain("bots  10 of 24 shown")
    await compare(`wallet-groups-${width}x${height}-find`, d.setup)
    await press(d.setup, "escape")
    expect(d.setup.captureCharFrame()).not.toContain("10 of 50")
    expect(d.setup.captureCharFrame()).toContain("▸ bots")
  })

  test(`the approvals menu at 50 wallets: grouped as the pane, bot-03 picked in its open group, at ${width}×${height}`, async () => {
    const d = await fifty(width, height)
    await palette(d.setup, "approvals")
    await press(d.setup, "down", "down", "down")
    if (width < 100) await press(d.setup, "right")
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("bot-03 · TEE · agent-a")
    expect(frame).toContain("in bots (bot-*) · its own setting, as every wallet has")
    if (width >= 100) {
      expect(frame).toContain("13 of 50 inside")
      expect(frame).toMatch(/▾ bots · bot-\* +12 of 24 inside/)
      if (height >= 45) expect(frame).toMatch(/▸ snipers · snipe-\* +0 of {2}8 inside/)
    } else expect(frame).toMatch(/‹ wallets +bots · 3 of 24/)
    await compare(`wallet-groups-${width}x${height}-approvals`, d.setup)
  })
}

for (const [width, height] of SIZES.slice(1)) {
  test(`naming several: "bot-2" found, four picked, then bot- → grid- for all four, at ${width}×${height}`, async () => {
    const d = await fifty(width, height)
    await palette(d.setup, "name several")
    await press(d.setup, ..."bot-2".split(""), "down", "down", "\r", "down", "\r", "down", "\r", "down", "\r")
    const picked = d.setup.captureCharFrame()
    expect(picked).toContain("4 picked")
    expect(picked).toContain("☐ bot-20")
    expect(picked).toContain("☑ bot-24")
    expect(picked).toContain("◪ bots")
    await compare(`wallet-groups-${width}x${height}-picked`, d.setup)
    await press(d.setup, "right", "backspace", "backspace", "backspace", "backspace", ..."grid-".split(""))
    const naming = d.setup.captureCharFrame()
    expect(naming).toContain("name 4 wallets")
    expect(naming).toMatch(/bot-21 +grid-21 +Candle \(TEE\) +leaves bots/)
    await compare(`wallet-groups-${width}x${height}-naming`, d.setup)
    await press(d.setup, "\r")
    // One wallets.name for the four, which the core checks whole and sends to Candle as one batch.
    expect(d.session.requests.filter((r) => r.method === "wallets.name")).toEqual([
      { method: "wallets.name", params: { names: [21, 22, 23, 24].map((i) => ({ wallet: fiftyAddress(`bot-${i}`), name: `grid-${i}` })) } },
    ])
  })
}

test("a typed group line goes to the core as wallets.group, at once", async () => {
  const d = await fifty(120, 30)
  await press(d.setup, ..."group swing add beta".split(""), "\r")
  expect(d.session.requests.filter((r) => r.method === "wallets.group")).toEqual([{ method: "wallets.group", params: { group: "swing", op: "add", wallets: ["beta"] } }])
})
