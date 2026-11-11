// The Hood chip's places for the active agent: the model picker's row under its own heading, the palette's row,
// and the Wallets pane's line where the account is on Hood. Each puts the step on the input line; nothing is sent.
import { expect, test } from "bun:test"
import type { PortfolioView } from "../core/portfolio-view"
import { INITIAL_UI, step, type UiContext } from "./keys"
import { type PaletteInput, paletteRows } from "./palette-rows"
import { type EngineTopic, pickable, pickerRows } from "./panes/engines"
import { hoodOffers, walletLines } from "./panes/wallets"
import { paneNext } from "./store"

const LINE = "candle vault promote --to-key Momentum --label momentum-hood --from cold-evm"
const topic: EngineTopic = { agents: { momentum: { engine: "claude-code", from: "config" } }, engines: {} }

test("the picker: a Hood wallet row under its own heading where it's offered, which Enter puts on the line", () => {
  expect(pickerRows(topic, {}, "", "momentum").some((r) => r.kind === "fill")).toBe(false)
  const rows = pickerRows(topic, {}, "", "momentum", "linux", { line: LINE })
  const at = rows.findIndex((r) => r.kind === "presets" && r.text === "Hood wallet")
  expect(at).toBeGreaterThanOrEqual(0)
  expect(rows[at + 1]).toEqual({ kind: "fill", line: LINE, text: "add a Hood wallet · ⏎ puts its next step on the line", current: false })
  expect(pickerRows(topic, {}, "hood", "momentum", "linux", { line: LINE }).some((r) => r.kind === "fill")).toBe(true)
  expect(pickerRows(topic, {}, "opus", "momentum", "linux", { line: LINE }).some((r) => r.kind === "fill")).toBe(false)
  // Enter on it: the line is the step, the picker closed, and nothing sent.
  const ctx: UiContext = { cards: [], seenAt: {}, mode: "live", agents: ["momentum"], activeAgent: "momentum", commands: { agents: ["momentum"], knownTokens: new Map() }, engines: { rows: (q, a) => pickerRows(topic, {}, q, a, "linux", { line: LINE }), needsModel: () => false } }
  const index = pickable(rows).findIndex((r) => r.kind === "fill")
  const r = step({ ...INITIAL_UI, overlay: { kind: "engines", agent: "momentum", query: "", index, moved: true } }, { type: "key", key: { name: "return" }, now: 0 }, ctx)
  expect(r.state).toMatchObject({ input: LINE, cursor: LINE.length, overlay: undefined })
  expect(r.effects).toEqual([])
})

const BASE: PaletteInput = { tabs: ["Trade"], tab: 0, agents: ["momentum"], activeAgent: "momentum", presets: {}, tokens: new Map(), paused: false, card: false, requotable: false, working: false, ask: false, aliases: new Map(), aliasProblems: 0, popped: [] }

test("the palette: a row for the active agent where the chip is offered, which types the step", () => {
  expect(paletteRows(BASE, "hood").some((r) => r.id === "hood-wallet")).toBe(false)
  expect(paletteRows({ ...BASE, hoodWallet: { line: LINE } }, "hood wallet").find((r) => r.id === "hood-wallet")).toMatchObject({ label: "add a Hood wallet for momentum", run: { kind: "fill", text: LINE } })
})

const wallet = (over: Partial<PortfolioView["wallets"][number]>): PortfolioView["wallets"][number] =>
  ({ address: "Embed1111111111111111111111111111111111111", chain: "solana", kind: "embedded", agents: ["momentum"], nativeSymbol: "SOL", native: { amount: 1, usd: 150 }, tokens: [], ...over }) as PortfolioView["wallets"][number]

test("the Wallets pane: on Hood, a line for each agent with no Hood TEE wallet and its chip; on Solana alone, nothing", () => {
  const offers = hoodOffers({ hoodWallet: { momentum: { label: "add a Hood wallet", line: LINE } } })
  expect(offers).toEqual([{ agent: "momentum", line: LINE }])
  const solanaOnly = { wallets: [wallet({})], deposit: "Embed1111111111111111111111111111111111111", readOnly: [], readAt: 1 } as unknown as PortfolioView
  const text = (p: PortfolioView, width: number) => walletLines(p, { mode: "live", now: 2, width, hood: offers })
  expect(text(solanaOnly, 60).some((l) => l.ref === LINE)).toBe(false)
  const both = { ...solanaOnly, wallets: [wallet({}), wallet({ address: "0x00000000000000000000000000000000000E4b01", chain: "hood", nativeSymbol: "ETH", native: { amount: 0.01, usd: 30 } })] } as unknown as PortfolioView
  const wide = text(both, 60)
  const at = wide.findIndex((l) => l.ref === LINE)
  expect(wide[at]!.segs.map((s) => s.text).join("")).toBe("momentum: no Hood TEE wallet   add a Hood wallet ")
  // Narrow, the chip goes under the words, never cut.
  const narrow = text(both, 28)
  const chipAt = narrow.findIndex((l) => l.ref === LINE)
  expect(narrow[chipAt - 1]!.segs.map((s) => s.text).join("")).toBe("momentum: no Hood TEE wallet")
  expect(narrow[chipAt]!.segs.map((s) => s.text).join("")).toBe("   add a Hood wallet ")
})

test("a pane's next steps as the view reads them: a line with where its cursor waits, and an address to copy; anything else is left out", () => {
  const op = (next: unknown) => ({ opId: "o", state: "succeeded", result: { pane: { next } } }) as unknown as Parameters<typeof paneNext>[0]
  const BRIDGE = "bridge  sol to eth from tee-one as momentum"
  expect(paneNext(op([{ label: "bridge ETH", line: BRIDGE, cursor: 7 }, { label: "⧉ address", copy: "0xabc" }, { label: "bad", line: 5 }, { label: "far", line: "x", cursor: 9 }]))).toEqual([
    { label: "bridge ETH", line: BRIDGE, cursor: 7 },
    { label: "⧉ address", copy: "0xabc" },
    // A cursor past the line's end is dropped: the cursor goes at the end.
    { label: "far", line: "x" },
  ])
  // Its chip puts the line on the input line with the cursor where the amount goes; typing fills it in.
  const ctx: UiContext = { cards: [], seenAt: {}, mode: "live", agents: ["momentum"], activeAgent: "momentum", commands: { agents: ["momentum"], knownTokens: new Map() } }
  let state = step(INITIAL_UI, { type: "clickFill", text: BRIDGE, cursor: 7, now: 0 }, ctx).state
  expect(state).toMatchObject({ input: BRIDGE, cursor: 7 })
  for (const ch of "0.5") state = step(state, { type: "key", key: { name: ch, sequence: ch }, now: 0 }, ctx).state
  expect(state.input).toBe("bridge 0.5 sol to eth from tee-one as momentum")
})
