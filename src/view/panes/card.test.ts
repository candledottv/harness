// The card, inline in the agent pane: the compact open card, and the one line an ended card folds to.
import { describe, expect, test } from "bun:test"
import type { ViewCard } from "../store"
import type { WalletsTopic } from "../../core/agent-wallets"
import { cardDetails, otherWallets } from "../overlays"
import { cardLines } from "./card"
import { requotable } from "../trade-tab"
import { C } from "../theme"
import { textOf } from "./lines"

const MOON = "MoonFake11111111111111111111111111111111111"
const NOW = Date.parse("2026-10-26T14:00:00.000Z")
const card = (over: Partial<ViewCard> = {}, display: Partial<ViewCard["display"]> = {}): ViewCard => ({
  cardId: "c1",
  opId: "op-c1",
  cardHash: "hash-c1",
  kind: "trade",
  tool: "candle_trade",
  agent: "momentum",
  state: "awaiting_approval",
  expiresAt: new Date(NOW + 42_000).toISOString(),
  side: "buy",
  params: { mint: MOON, side: "buy", amount: "0.166666666" },
  display: {
    title: "BUY 0.166666666 SOL (≈$25.00) → MOON",
    headline: "BUY $25.00 of MOON",
    gets: { amount: 39.6825, asset: "MOON" },
    spend: { amount: 0.166666666, asset: "SOL" },
    valueUsd: 25,
    walletLabel: "embedded",
    agent: "momentum",
    wallet: "WalletFake111111111111111111111111111111111",
    mode: "live",
    expiresAt: new Date(NOW + 42_000).toISOString(),
    mint: MOON,
    mintLabel: "MOON",
    price: "MOON $0.63 (portfolio)",
    receives: "≈39.68 MOON",
    sizedFromUsd: "$25.00 at SOL $150.00",
    limits: "$25.00 of $50 per trade · $12.00 of $100 today",
    candleKeyLimit: "Candle key limit $100/day",
    why: "6 smart wallets bought in 10 min",
    pricedAt: new Date(NOW - 3_000).toISOString(),
    pricedBy: "Candle market read",
    ...display,
  },
  ...over,
})
const texts = (c: ViewCard, opts: Partial<Parameters<typeof cardLines>[1]> = {}) => cardLines(c, { now: NOW, focused: false, width: 80, ...opts }).map(textOf)

test("an open card is its decision in three lines, then the actions as chips", () => {
  const lines = texts(card())
  // The expiry sits at the right edge.
  expect(lines[0]).toMatch(/^▌ BUY \$25\.00 of MOON   ≈39\.68 MOON · 0\.167 SOL +42s$/)
  expect(lines[0]!.length).toBe(80)
  expect(lines.slice(1)).toEqual([
    // The token's short address ends the who line: the name alone could be a copy's.
    "▌ momentum · pays from embedded · live · Moon…1111",
    "▌ why  6 smart wallets bought in 10 min",
    "▌  ⏎ approve    ctrl-n reject    ctrl-o details ",
  ])
})

test("a trade's short address is never cut from its who line, however narrow; the full address is in details; other cards carry none", () => {
  const tee = card({}, { paysFrom: "pays from a-long-named-wallet (TEE · TeeF…1111)", sharedWith: ["swing", "scout"] })
  for (const width of [80, 48, 36]) {
    const who = texts({ ...tee, side: "sell" }, { width }).find((l) => l.startsWith("▌ momentum"))!
    expect(who.length).toBeLessThanOrEqual(width)
    expect(who.endsWith(" · Moon…1111")).toBe(true)
  }
  // With a trigger's or a bot's mark after it, both stay.
  expect(texts(card({}, { trigger: "dip", fired: "MOON was $0.39" }), { width: 44 }).find((l) => l.startsWith("▌ momentum"))).toMatch(/Moon…1111 · ⚡ dip$/)
  expect(cardDetails(card())).toContain(`mint      ${MOON}`)
  const swap = card({ kind: "swap", tool: "candle_swap", side: "swap" }, { headline: "SWAP 1 SOL → USDC", mint: undefined })
  expect(texts(swap)[1]).toBe("▌ momentum · pays from embedded · live")
  expect(cardDetails(swap).some((l) => l.startsWith("mint"))).toBe(false)
})

test("a name read here for another token is said in amber on the card, and on the receipt of a trade that ran with no card", () => {
  const words = "another MOON was read here (Moon…Copy): this one is Moon…1111"
  const open = cardLines(card({}, { otherMint: words }), { now: NOW, focused: false, width: 80 })
  const line = open.find((l) => textOf(l).includes(words))!
  expect(line.segs.at(-1)!.fg).toBe(C.look)
  // A card for a token read once says nothing of the kind.
  expect(texts(card()).some((l) => l.includes("another"))).toBe(false)
  const ran = cardLines(card({ state: "approved", approvedHow: "inside-limits", withoutCard: "without a card, inside the embedded wallet's limits ($1.00 of $1.50 a trade, $1.00 of $3.00 today)", operation: { state: "succeeded" } }, { otherMint: words }), { now: NOW, focused: false, width: 100 })
  expect(textOf(ran[0]!)).toContain("Moon…1111 · without a card")
  expect(ran.find((l) => textOf(l).includes(words))!.segs[0]!.fg).toBe(C.look)
  // A card the person pressed showed the address already: its folded line stays as it was.
  expect(textOf(cardLines(card({ state: "approved", approvedHow: "enter", operation: { state: "succeeded" } }), { now: NOW, focused: false, width: 100 })[0]!)).not.toContain("Moon…1111")
})

test("real funds under a paper screen are said in amber; a card in the Candle Harness's own mode says nothing more", () => {
  const words = 'real funds: the bot "conf" is live, though the Candle Harness is on paper'
  const lines = cardLines(card({}, { bot: "conf", modeDiffers: words }), { now: NOW, focused: false, width: 80 })
  expect(lines.find((l) => textOf(l).includes(words))!.segs.at(-1)!.fg).toBe(C.look)
  expect(texts(card({}, { bot: "conf" })).some((l) => l.includes("real funds"))).toBe(false)
  expect(cardDetails(card({}, { modeDiffers: words }))).toContain(`mode      ${words}`)
})

test("a launch card says what it publishes on one line, and terms the agent set in amber, whole", () => {
  const launch = (display: Partial<ViewCard["display"]>) => card({ kind: "launch", tool: "candle_launch_token", side: undefined, params: {} }, { headline: "LAUNCH FMOON", title: "LAUNCH FMOON (Fake Moon)", mint: undefined, gets: undefined, spend: undefined, valueUsd: undefined, why: undefined, publicNote: "public: a new token can't be taken back", ...display })
  const publishes = "links: website fakemoon.example, twitter x.com · image from img.example.com · description: To the fake moon."
  const terms = "set by the agent, not Candle's defaults: creator fee 5% · launch rules {\"maxWalletPct\":2}"
  const lines = cardLines(launch({ publishes, launchTerms: terms }), { now: NOW, focused: false, width: 60 })
  expect(lines.some((l) => textOf(l).includes("links: website fakemoon.example"))).toBe(true)
  const amber = lines.filter((l) => l.segs.at(-1)!.fg === C.look).map(textOf).join(" ")
  expect(amber).toContain("creator fee 5%")
  expect(amber).toContain('{"maxWalletPct":2}')
  expect(cardDetails(launch({ publishes, launchTerms: terms }))).toEqual(expect.arrayContaining([`publishes ${publishes}`, `terms     ${terms}`]))
  // Candle's defaults add no amber line beyond the public note.
  expect(cardLines(launch({ publishes }), { now: NOW, focused: false, width: 60 }).filter((l) => l.segs.at(-1)!.fg === C.look)).toHaveLength(2)
})

test("a CLI card's details show the command as the person would read it, without the flag the core adds for the configured RPC", () => {
  const tee = card({ params: { argv: ["swap", "SOL", MOON, "--amount", "0.04", "--yes", "--json", "--rpc-url", "@config"], identity: "agent", agent: "momentum", json: true } })
  const runs = cardDetails(tee).find((l) => l.startsWith("runs"))!
  expect(runs).toBe(`runs      candle swap SOL ${MOON} --amount 0.04 --yes --json`)
})

test("an expired card made from its proposer's own words offers no re-quote: it's asked for again", () => {
  const flatten = card({ kind: "bot", tool: "harness_bots", side: undefined, state: "expired" }, { headline: undefined, title: 'FLATTEN BOT "conf"', askAgain: true, mint: undefined })
  const said = texts(flatten).join("\n")
  expect(said).toContain("expired, never ran: ask for it again")
  expect(said).not.toContain("re-quote")
  expect(texts(card({ state: "expired" })).join("\n")).toContain("ctrl-r re-quote")
  // ctrl-r goes to the newest expired card that can be re-quoted, never to one that's asked for again.
  expect(requotable([card({ cardId: "trade", state: "expired" }), flatten])).toBe("trade")
  expect(requotable([flatten])).toBeUndefined()
})

test("a swap whose first leg went and second failed reads as part done, with the first leg's hash, never as plainly failed", () => {
  const swap = card({ kind: "swap", tool: "candle_swap", side: "swap", state: "approved", approvedHow: "enter", params: { from: "SOL", to: "USDC", amount: "0.02" }, operation: { state: "failed", partial: { leg1: "Leg1HashFake1111111111111111111111111111111" } } }, { headline: "SWAP 0.02 SOL → USDC", mint: undefined })
  const lines = cardLines(swap, { now: NOW, focused: false, width: 80 })
  const said = lines.map(textOf).join(" ")
  expect(said).toContain("part done: the first leg went, the second failed")
  expect(said).toContain("0.02 SOL left the wallet · first leg Leg1…1111")
  expect(lines[0]!.segs.some((seg) => seg.fg === C.look)).toBe(true)
})

test("a Hacc card in paper mode says it's real on Hacc in place of the mode", () => {
  const lines = texts(card({ kind: "hacc", tool: "hacc_follows", side: undefined }, { headline: "Add rule 'big' (large_move, $5,000)", walletLabel: undefined, gets: undefined, spend: undefined, valueUsd: undefined, mode: "paper", modeNote: "real on Hacc, even in paper mode" }))
  expect(lines[1]).toBe("▌ momentum · real on Hacc, even in paper mode")
})

test("the open card's colours: headline bright, figures and who dim, expiry and edge amber, approve the solid chip", () => {
  const [first, second, , actions] = cardLines(card(), { now: NOW, focused: false, width: 80 })
  expect(first!.segs[0]).toEqual({ text: "▌ ", fg: C.look })
  expect(first!.segs.find((s) => s.text === "BUY $25.00 of MOON")!.fg).toBe(C.hi)
  expect(first!.segs.find((s) => s.text.includes("≈39.68"))!.fg).toBe(C.dim)
  expect(first!.segs.at(-1)).toEqual({ text: "42s", fg: C.look })
  expect(second!.segs[1]!.fg).toBe(C.dim)
  expect(actions!.segs.find((s) => s.act === "approve")!.kind).toBe("primary")
})

test("a focused card is tinted on every line", () => {
  const lines = cardLines(card(), { now: NOW, focused: true, width: 80 })
  expect(lines.every((l) => l.bg === C.sel)).toBe(true)
})

test("what was moved to details stays off the card: price, priced, sized, limits, the Candle key limit", () => {
  const all = texts(card()).join("\n")
  for (const gone of ["price", "priced", "sized", "per trade", "Candle key limit"]) expect(all).not.toContain(gone)
})

test("the limits line shows near a limit, in amber", () => {
  const lines = cardLines(card({}, { nearLimit: "Candle Harness limit: $9.20 of $10.00 per trade · $9.20 of $50.00 today" }), { now: NOW, focused: false, width: 80 })
  const near = lines.find((l) => textOf(l).includes("Candle Harness limit"))!
  expect(near.segs[1]!.fg).toBe(C.look)
})

test("a buy sized in an asset shows its dollar value; a sell shows what it sells, what comes back and the value", () => {
  expect(texts(card({}, { headline: "BUY 0.1 SOL of MOON", spend: undefined, valueUsd: 15.08 }))[0]).toContain("≈39.68 MOON · ≈$15.08")
  const sell = texts(card({ side: "sell" }, { headline: "SELL 50% of MOON", spend: undefined, sells: { amount: 0.00294429955, asset: "MOON" }, gets: { amount: 0.004991, asset: "SOL" }, valueUsd: 0.5, sharedWith: ["swing"] }))
  expect(sell[0]).toContain("SELL 50% of MOON   ≈0.00294 MOON → ≈0.00499 SOL · ≈$0.50")
  expect(sell[1]).toBe("▌ momentum · pays from embedded · live · shared with swing · Moon…1111")
})

test("token risks show in red; a card the Candle Harness can't run offers only reject and details", () => {
  const lines = cardLines(card({}, { risks: "transfer_fee, permanent_delegate" }), { now: NOW, focused: false, width: 80 })
  expect(lines.find((l) => textOf(l).includes("risks"))!.segs.at(-1)!.fg).toBe(C.bad)
  expect(texts(card({}, { supported: false })).at(-1)).toBe("▌  ctrl-n reject    ctrl-o details ")
})

test("a narrow pane: figures drop a line, the why is cut with …, the actions wrap, nothing runs off", () => {
  const lines = texts(card({}, { why: "a reason that runs on for quite a while, longer than the pane is wide" }), { width: 40 })
  expect(lines.every((l) => l.length <= 40)).toBe(true)
  expect(lines[1]).toContain("≈39.68 MOON")
  expect(lines.find((l) => l.includes("why"))).toContain("…")
  expect(lines.filter((l) => l.includes("approve") || l.includes("reject") || l.includes("details")).length).toBeGreaterThan(1)
})

test("the countdown reaching 0 folds the card to one line with a re-quote chip, never approve", () => {
  const lines = cardLines(card(), { now: NOW + 42_000, focused: true, width: 80 })
  expect(lines.map(textOf)).toEqual(["  ◷ BUY $25.00 of MOON  expired, never ran   ctrl-r re-quote "])
  expect(lines[0]!.segs.some((s) => s.act === "approve")).toBe(false)
  expect(lines[0]!.segs.find((s) => s.act === "requote")).toBeDefined()
})

test("ended cards fold to one line that says what happened", () => {
  expect(texts(card({ state: "approved", operation: { state: "pending" } }))).toEqual(["  ◌ BUY $25.00 of MOON  pending · approved"])
  expect(texts(card({ state: "approved", approvedHow: "enter", operation: { state: "succeeded" } }))).toEqual(["  ✓ BUY $25.00 of MOON  filled · ≈39.68 MOON · approved by Enter"])
  // Detail that doesn't fit the line wraps under the headline.
  expect(texts(card({ state: "approved", approvedHow: "instant", operation: { state: "succeeded" } }))).toEqual([
    "  ✓ BUY $25.00 of MOON  filled",
    "    ≈39.68 MOON · approved at once (typed cards run instantly)",
  ])
  expect(texts(card({ state: "rejected" }))).toEqual(["  ✕ BUY $25.00 of MOON  rejected, never ran"])
  // A live sell Candle closed as the key's paper position: nothing live sold, never "filled".
  const paper = texts(card({ state: "approved", approvedHow: "enter", operation: { state: "succeeded", paper: true } })).join(" ")
  expect(paper).toContain("not sold live")
  expect(paper).not.toContain("filled")
  expect(texts(card({ state: "withdrawn" }))).toEqual(["  ✕ BUY $25.00 of MOON  withdrawn, never ran"])
  expect(texts(card({ state: "withdrawn", replacedBy: "card_new" }))).toEqual(["  ✕ BUY $25.00 of MOON  replaced by a new card, never ran"])
  expect(texts(card({ state: "expired" }))[0]).toContain("expired, never ran")
  // A Hacc change or a stake is done, not filled: "filled" means a position.
  expect(texts(card({ kind: "hacc", tool: "hacc_follows", state: "approved", approvedHow: "enter", operation: { state: "succeeded" } }, { headline: "Unfollow 9oC3…KR8W", gets: undefined }))).toEqual(["  ✓ Unfollow 9oC3…KR8W  done · approved by Enter"])
  expect(texts(card({ kind: "stake", state: "approved", operation: { state: "succeeded" } }, { headline: "STAKE 10 CNDL", gets: undefined }))[0]).toContain("done")
})

test("a refusal after approve says Candle's reason; a long one wraps under the headline", () => {
  const op = { opId: "op-c1", cardId: "c1", agent: "momentum", state: "refused", error: { code: "SWAP_FAILED", message: "Nothing was signed or sent. Retry." } }
  const lines = cardLines(card({ state: "approved", approvedHow: "click", operation: { state: "refused" } }), { now: NOW, focused: false, width: 100, op })
  expect(lines.map(textOf)).toEqual(["  ✕ BUY $25.00 of MOON  refused · Nothing was signed or sent. Retry. · approved by click"])
  expect(lines[0]!.segs.find((s) => s.text === "refused")!.fg).toBe(C.bad)
  const narrow = cardLines(card({ state: "approved", operation: { state: "refused" } }), { now: NOW, focused: false, width: 40, op }).map(textOf)
  expect(narrow.length).toBeGreaterThan(1)
  expect(narrow.every((l) => l.length <= 40)).toBe(true)
})

test("a card from an older core, with only a title, still draws", () => {
  const old = card({}, { headline: undefined, gets: undefined, spend: undefined, valueUsd: undefined, walletLabel: undefined })
  expect(texts(old)[0]).toContain("BUY 0.166666666 SOL (≈$25.00) → MOON")
})

test("a warning shows whole, in amber, before the actions (the stranding line)", () => {
  const warning = "This key holds TEE wallet bot-wallet. Revoking leaves it stranded until the owner rebinds it (candle tee rebind)."
  const lines = cardLines(card({ kind: "lessaccess" }, { warning }), { now: NOW, focused: false, width: 60 })
  const texts = lines.map(textOf)
  const at = texts.findIndex((t) => t.includes("This key holds"))
  expect(at).toBeGreaterThan(0)
  expect(texts.slice(at, at + 3).join(" ").replace(/▌ /g, "").replace(/\s+/g, " ")).toContain("rebinds it (candle tee rebind).")
  expect(lines[at]!.segs.at(-1)!.fg).toBe(C.look)
  expect(texts.findIndex((t) => t.includes("approve"))).toBeGreaterThan(at)
  expect(cardDetails(card({}, { warning }))).toContain(`warning   ${warning}`)
})

test("details (ctrl-o) holds everything the compact card leaves out, with the exact amounts", () => {
  const lines = cardDetails(card({ params: { mint: MOON, side: "buy", amount: "0.166666666" } }))
  const text = lines.join("\n")
  expect(text).toContain("size      0.166666666 SOL")
  for (const label of ["title", "gets", "price", "priced", "limits", "wallet", "agent", "why", "runs", "hash"]) expect(lines.some((l) => l.startsWith(label))).toBe(true)
  expect(text).toContain("$25.00 of $50 per trade · $12.00 of $100 today · Candle key limit $100/day")
  expect(text).toContain("embedded WalletFake111111111111111111111111111111111")
  const sell = cardDetails(card({ side: "sell", params: { mint: MOON, side: "sell", percent: 50 } }, { sharedWith: ["swing"] }))
  expect(sell).toContain("size      50% of the wallet's holding, when it runs")
  expect(sell).toContain("shared    with swing: a sell takes from the whole holding, whoever bought it")
})

test("a launch card: the dry run's preview on one grey line, then that it's public, in amber, before the actions", () => {
  const launch = card(
    { kind: "launch", tool: "candle_launch_token", side: undefined, params: { name: "Fake Moon", symbol: "FMOON", imageUrl: "https://cdn.example/fake.png", dryRun: false } },
    {
      title: "LAUNCH FMOON (Fake Moon)",
      headline: "LAUNCH FMOON",
      gets: undefined,
      spend: undefined,
      valueUsd: undefined,
      why: "the user asked",
      preview: "raises 80 SOL to graduate · dev-buy ceiling 0.5 SOL · 50 launches a day, shared by every key on the account",
      publicNote: "public: a new token can't be taken back",
      resendNote: "Re-send uses the same clientLaunchId, which Candle replays: it never launches a second token.",
    },
  )
  const lines = cardLines(launch, { now: NOW, focused: false, width: 80 })
  const t = lines.map(textOf)
  expect(t[0]).toMatch(/^▌ LAUNCH FMOON +42s$/)
  const preview = t.findIndex((l) => l.startsWith("▌ raises 80 SOL"))
  expect(lines[preview]!.segs.at(-1)!.fg).toBe(C.dim)
  expect(t[preview]!.length).toBeLessThanOrEqual(80)
  expect(t[preview + 1]).toBe("▌ public: a new token can't be taken back")
  expect(lines[preview + 1]!.segs.at(-1)!.fg).toBe(C.look)
  expect(t.at(-1)).toContain("approve")
  const details = cardDetails(launch).join("\n")
  expect(details).toContain("preview   raises 80 SOL to graduate · dev-buy ceiling 0.5 SOL · 50 launches a day, shared by every key on the account")
  expect(details).toContain("public    public: a new token can't be taken back")
  expect(details).toContain("re-send   Re-send uses the same clientLaunchId")
})

describe("TEE wallets' and the CLI's cards", () => {
  const TEE = "TeeFakeA11111111111111111111111111111111111"
  const OTHER = "TeeFakeB11111111111111111111111111111111111"
  const EMBEDDED = "WalletFake111111111111111111111111111111111"
  const teeCard = (over: Partial<ViewCard> = {}, display: Partial<ViewCard["display"]> = {}) =>
    card(
      { params: { argv: ["swap", "SOL", MOON, "--amount", "0.04", "--wallet", TEE, "--client-trade-id", "op-c1", "--yes", "--json"], identity: "agent", agent: "momentum", json: true }, ...over },
      { walletLabel: "tee-one", paysFrom: "pays from tee-one (TEE · TeeF…1111)", wallet: TEE, resendNote: "Re-send reads it back; the CLI never sends it twice.", ...display },
    )

  test("a TEE wallet's card says which wallet pays, by label and short address, on its second line", () => {
    expect(texts(teeCard())[1]).toBe("▌ momentum · pays from tee-one (TEE · TeeF…1111) · live · Moon…1111")
    // The embedded wallet's card is as it was.
    expect(texts(card())[1]).toBe("▌ momentum · pays from embedded · live · Moon…1111")
    // Narrow, it's cut, never run off the pane.
    for (const l of texts(teeCard(), { width: 40 })) expect(l.length).toBeLessThanOrEqual(40)
  })

  test("details show the exact argv a CLI card runs, and the wallet in full", () => {
    const d = cardDetails(teeCard()).join("\n")
    expect(d).toContain(`runs      candle swap SOL ${MOON} --amount 0.04 --wallet ${TEE} --client-trade-id op-c1 --yes --json`)
    expect(d).toContain(`wallet    tee-one ${TEE}`)
    expect(d).toContain("re-send   Re-send reads it back; the CLI never sends it twice.")
  })

  test("a TEE stake, an upload and an LP card use the same lines: headline, who and wallet, preview, public, actions", () => {
    const stake = teeCard(
      { kind: "stake", tool: "candle_cli", side: undefined, params: { argv: ["stake", "add", "10", "--wallet", TEE, "--client-stake-id", "op-c1", "--yes", "--json"], identity: "agent", agent: "momentum", json: true, row: "stake add" } },
      { title: "STAKE 10 CNDL · tee-one", headline: "STAKE 10 CNDL", gets: undefined, spend: undefined, valueUsd: 4.2, preview: "unstaking later waits out the pool's cooldown" },
    )
    const s = texts(stake)
    expect(s[0]).toMatch(/^▌ STAKE 10 CNDL   ≈\$4\.20 +42s$/)
    expect(s[1]).toBe("▌ momentum · pays from tee-one (TEE · TeeF…1111) · live")
    expect(s).toContain("▌ unstaking later waits out the pool's cooldown")
    expect(s.at(-1)).toContain("⏎ approve")
    const upload = card(
      { kind: "upload", tool: "candle_cli", side: undefined, params: { argv: ["image", "upload", "/state/uploads/op-c1/logo.png", "--json"], identity: "agent", agent: "momentum", json: true, row: "image upload", file: "/state/uploads/op-c1/logo.png" } },
      { title: "UPLOAD image logo.png (PNG, 12 KB)", headline: "UPLOAD image logo.png", walletLabel: undefined, wallet: "none", gets: undefined, spend: undefined, valueUsd: undefined, why: "for the launch", publicNote: "public and permanent: an uploaded image can't be taken down" },
    )
    const u = texts(upload)
    expect(u[0]).toMatch(/^▌ UPLOAD image logo\.png +42s$/)
    expect(u[1]).toBe("▌ momentum · live")
    expect(u).toContain("▌ public and permanent: an uploaded image can't be taken down")
    const lp = teeCard({ kind: "lp", tool: "candle_cli", side: "buy" }, { title: "LP ADD 1 SOL · pool Pool…1111 · tee-one", headline: "LP ADD 1 SOL", gets: undefined, spend: undefined, valueUsd: 150 })
    expect(texts(lp)[0]).toMatch(/^▌ LP ADD 1 SOL   ≈\$150\.00 +42s$/)
    expect(texts(lp)[1]).toContain("pays from tee-one")
  })

  test("details list the other wallets the agent can pay from: trades and swaps only, never the one paying", () => {
    const wallets: WalletsTopic = {
      agents: {
        momentum: {
          payable: {
            embedded: { address: EMBEDDED, chain: "solana" },
            tee: [
              { id: "a", address: TEE, label: "tee-one", chain: "solana", active: true },
              { id: "b", address: OTHER, chain: "solana", active: true },
              { id: "c", address: "TeeFakeC11111111111111111111111111111111111", label: "stopped", chain: "solana", active: false },
            ],
            readAt: 0,
            unreadable: [],
          },
          embeddedWallet: "allowed",
        },
      },
      account: [],
      boundTo: {},
    }
    expect(otherWallets(card({}, { wallet: EMBEDDED }), wallets)).toEqual([
      { word: TEE, name: "tee-one" },
      { word: OTHER, name: "TeeF…1111" },
    ])
    expect(otherWallets(teeCard(), wallets)).toEqual([
      { word: "embedded", name: "embedded" },
      { word: OTHER, name: "TeeF…1111" },
    ])
    expect(otherWallets(card({ kind: "launch", tool: "candle_launch_token" }), wallets)).toEqual([])
    expect(otherWallets(card({ state: "approved" }), wallets)).toEqual([])
    expect(otherWallets(card(), undefined)).toEqual([])
    // On Free there's only the embedded wallet, and it's the one paying.
    const free = { ...wallets, agents: { momentum: { ...wallets.agents.momentum!, payable: { ...wallets.agents.momentum!.payable, tier: "free" } } } }
    expect(otherWallets(card({}, { wallet: EMBEDDED }), free)).toEqual([])
  })
})

describe("owner cards", () => {
  const owner = (display: Partial<ViewCard["display"]> = {}) =>
    card({ kind: "owner", route: "pane" } as Partial<ViewCard>, { headline: "OWNER · candle keys create --label scout --access write", paneSteps: ["your vault factor first (the Candle Harness asks the CLI to unlock, and nothing runs if it doesn't)"], paneNote: "Runs in a terminal pane the agent can't see.", ...display })
  const lines = (c: ViewCard, op?: Parameters<typeof cardLines>[1]["op"]) => cardLines(c, { now: NOW, focused: false, width: 90, ...(op ? { op } : {}) })

  test("its own words show before the pane's steps", () => {
    const t = lines(owner({ paneNotes: ["New agent scout: Write access, no Candle cap, the embedded wallet denied."] })).map(textOf)
    const at = t.findIndex((l) => l.includes("New agent scout"))
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(t.findIndex((l) => l.includes("your vault factor first")))
  })

  test("a ceremony's line, what it shows or takes, comes first, whole and in amber, before the pane's steps", () => {
    const out = lines(owner({ headline: "AT THE PROMPT · candle vault phrase show", paneShows: "Shows your 24 words.", paneSteps: ["you'll type understood, then three of the 24 words back"] }))
    const at = out.findIndex((l) => textOf(l).includes("Shows your 24 words."))
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(out.findIndex((l) => textOf(l).includes("you'll type understood")))
    expect(out[at]!.segs.find((s) => s.text.includes("Shows your 24 words."))!.fg).toBe(C.look)
  })

  test("no vault: why, and a chip that puts candle vault init on the input line, in place of approve", () => {
    const out = lines(owner({ supported: false, blocked: { why: "No vault on this machine, so there's no factor to ask for.", fill: { label: "set up a vault", line: "candle vault init" } } }))
    expect(out.map(textOf).some((l) => l.includes("No vault on this machine"))).toBe(true)
    const fill = out.find((l) => l.segs.some((s) => s.act === "fill"))!
    expect(fill.ref).toBe("candle vault init")
    expect(out.some((l) => l.segs.some((s) => s.act === "approve"))).toBe(false)
    expect(out.some((l) => l.segs.some((s) => s.act === "reject"))).toBe(true)
    // Not the factor step it can't take.
    expect(out.map(textOf).some((l) => l.includes("your vault factor first"))).toBe(false)
  })

  test("funds out to a new address: said plainly, the address in groups of four in amber, and a click chip for approve", () => {
    const groups = "NewA ddr2 2222 2222 2222 2222 2222 2222 2222 2222 2222"
    const out = lines(owner({ headline: "FUNDS OUT · candle vault transfer NewA…2222 --amount 0.01 --asset SOL --from tee-one", newAddress: groups }))
    const at = out.findIndex((l) => textOf(l).includes(groups))
    expect(at).toBeGreaterThan(0)
    expect(textOf(out[at - 1]!)).toContain("A new address: not one of your wallets or vault keys.")
    expect(out[at]!.segs.find((s) => s.text.includes(groups))!.fg).toBe(C.look)
    const approve = out.flatMap((l) => l.segs).find((s) => s.act === "approve")!
    expect(approve.text).toContain("yes, a new address")
    expect(out.map(textOf).some((l) => l.includes("⏎ approve"))).toBe(false)
    // A known destination keeps Enter's chip.
    expect(lines(owner()).flatMap((l) => l.segs).find((s) => s.act === "approve")!.text).toContain("⏎ approve")
  })

  test("a short pane: the card drops the pane's steps, then why, and keeps the headline, the amber address and the chips (80×24)", () => {
    const groups = "NewA ddr2 2222 2222 2222 2222 2222 2222 2222 2222 2222"
    const c = owner({
      headline: "FUNDS OUT · candle vault transfer NewA…2222 --amount 0.01 --asset SOL --from tee-one",
      why: "You asked to send 0.01 SOL to NewAddr2222.",
      newAddress: groups,
      paneNotes: ["Sends 0.01 SOL from tee-one to a new address."],
      paneSteps: ["the CLI asks for your vault passphrase itself, naming the send", "it prints the destination in full, in groups of four, and you type confirm"],
      paneNote: "Runs in a terminal pane the agent can't see. You answer the CLI's own prompts there.",
    })
    const full = cardLines(c, { now: NOW, focused: false, width: 46 }).map(textOf)
    const short = cardLines(c, { now: NOW, focused: false, width: 46, maxRows: 11 }).map(textOf)
    expect(full.length).toBeGreaterThan(11)
    expect(short.length).toBeLessThanOrEqual(11)
    expect(short[0]).toContain("FUNDS OUT")
    expect(short.join("\n")).toContain("A new address: not one of your wallets")
    for (const g of groups.split(" ")) expect(short.join(" ")).toContain(g)
    expect(short.join("\n")).toContain("yes, a new address")
    expect(short.join("\n")).toContain("Sends 0.01 SOL from tee-one")
    expect(short.join("\n")).not.toContain("the CLI asks for your vault passphrase")
    // Room for everything: nothing dropped.
    expect(cardLines(c, { now: NOW, focused: false, width: 46, maxRows: 40 }).map(textOf)).toEqual(full)
    // Tighter still, why goes too; the headline and the chips never do.
    const tighter = cardLines(c, { now: NOW, focused: false, width: 46, maxRows: 9 }).map(textOf)
    expect(tighter.join("\n")).not.toContain("why ")
    expect(tighter[0]).toContain("FUNDS OUT")
    expect(tighter.at(-1)).toContain("ctrl-o details")
  })

  test("details hold the pane's steps and a new address, which a short pane's card may drop", () => {
    const d = cardDetails(owner({ newAddress: "NewA ddr2 2222", paneSteps: ["it prints the destination in full"], paneNote: "Runs in a terminal pane the agent can't see." }))
    expect(d).toContain("to        NewA ddr2 2222")
    expect(d).toContain("pane      it prints the destination in full · Runs in a terminal pane the agent can't see.")
  })

  test("a stranding warning's rebind chips each carry their command", () => {
    const out = lines(card({}, { warning: "This key holds TEE wallet tee-one.", fills: [{ label: "rebind to swing", line: "candle tee rebind TeeX --to-key Swingkey" }] }))
    const fill = out.find((l) => l.segs.some((s) => s.act === "fill"))!
    expect(textOf(fill)).toContain("rebind to swing")
    expect(fill.ref).toBe("candle tee rebind TeeX --to-key Swingkey")
  })

  test("an ended step's next steps are chips under it", () => {
    const done = { ...owner(), state: "approved" } as ViewCard
    const op = { opId: done.opId, cardId: done.cardId, state: "succeeded", route: "pane", result: { pane: { outcome: "finished", words: "made scout (key Scoutkey…): it's in the Agents list now.", next: [{ label: "new TEE wallet for scout", line: "candle vault promote --to-key Scoutkey --label scout-tee --from " }] } } } as unknown as Parameters<typeof cardLines>[1]["op"]
    const out = lines(done, op)
    // The headline is long, so what happened goes under it, whole.
    expect(textOf(out[0]!)).toContain("OWNER · candle keys create")
    expect(textOf(out[1]!).trim()).toBe("made scout (key Scoutkey…): it's in the Agents list now.")
    const next = out.find((l) => l.segs.some((s) => s.act === "fill"))!
    expect(textOf(next).trimStart()).toStartWith("next")
    expect(textOf(next)).toContain("new TEE wallet for scout")
    expect(next.ref).toBe("candle vault promote --to-key Scoutkey --label scout-tee --from ")
  })
})

describe("a slippage bound the agent set", () => {
  const sell = (display: Partial<ViewCard["display"]> = {}, over: Partial<ViewCard> = {}) =>
    card({ side: "sell", params: { mint: MOON, side: "sell", percent: 100, maxSlippageBps: 5000 }, ...over }, { headline: "SELL 100% of MOON", slippage: "slippage 50%, the default is 1%", slippageLooser: true, ...display })

  test("is on the open card, in amber when looser than the default", () => {
    const lines = cardLines(sell(), { now: NOW, focused: false, width: 80 })
    const line = lines.find((l) => textOf(l).includes("slippage 50%"))!
    expect(textOf(line)).toBe("▌ slippage 50%, the default is 1%")
    expect(line.segs.at(-1)!.fg).toBe(C.look)
    expect(cardLines(sell({ slippageLooser: undefined, slippage: "slippage 0.25%, the default is 1%" }), { now: NOW, focused: false, width: 80 }).find((l) => textOf(l).includes("slippage"))!.segs.at(-1)!.fg).toBe(C.dim)
  })

  test("is on the receipt of a trade that ran without a card, since nobody saw a card", () => {
    const ran = sell({}, { state: "approved", approvedHow: "inside-limits", withoutCard: "without a card: the embedded wallet trades inside limits, and sells aren't limited", operation: { state: "succeeded" } })
    const lines = texts(ran)
    expect(lines).toContain("    slippage 50%, the default is 1%")
    // A card the person approved showed it already: its folded line doesn't repeat it.
    expect(texts(sell({}, { state: "approved", approvedHow: "enter", operation: { state: "succeeded" } })).some((t) => t.includes("slippage"))).toBe(false)
  })

  test("is in the details", () => {
    expect(cardDetails(sell())).toContain("slippage  50%, the default is 1%")
  })
})

describe("a trigger's card", () => {
  test("its receipt is one line, the trigger's name after ⚡, what it saw, then what came of it; expired, it offers run it now in place of re-quote", () => {
    const ran = card({ state: "approved", approvedHow: "inside-limits", operation: { state: "succeeded" } }, { trigger: "dip", fired: "MOON was $0.39, under $0.40" })
    expect(texts(ran, { width: 120 })).toEqual(["⚡ dip  MOON was $0.39, under $0.40 → BUY $25.00 of MOON filled, without a card   sell "])
    const line = cardLines(ran, { now: NOW, focused: false, width: 120 })[0]!
    expect(line.segs[0]).toMatchObject({ text: "⚡ dip", fg: C.head })
    // Narrow, it wraps under the name, the chip after the last words.
    expect(texts(ran, { width: 40 })).toEqual(["⚡ dip  MOON was $0.39, under $0.40 →", "  BUY $25.00 of MOON filled, without a", "  card   sell "])
    const expired = card({ state: "expired" }, { trigger: "dip" })
    const lines = cardLines(expired, { now: NOW, focused: false, width: 80 })
    expect(lines.map(textOf).join("\n")).toContain("expired, nobody pressed it")
    expect(lines.flatMap((l) => l.segs).filter((s) => s.act).map((s) => [s.text.trim(), s.act])).toEqual([["run it now", "runNow"]])
    // Run again since (the triggers topic no longer offers it): the chip goes, the words stay.
    const ran2 = cardLines(expired, { now: NOW, focused: false, width: 80, runnable: new Set() })
    expect(ran2.map(textOf).join("\n")).toContain("expired, nobody pressed it")
    expect(ran2.flatMap((l) => l.segs).filter((s) => s.act === "runNow")).toEqual([])
  })
  test("a card from a turn a trigger woke: its receipt says which; expired, it's re-quoted as any agent's", () => {
    const ran = card({ state: "approved", approvedHow: "inside-limits", operation: { state: "succeeded" } }, { woken: "conf" })
    expect(texts(ran).join("\n")).toContain('without a card · woke on trigger "conf"')
    const expired = cardLines(card({ state: "expired" }, { woken: "conf" }), { now: NOW, focused: false, width: 80 })
    expect(expired.flatMap((l) => l.segs).filter((s) => s.act).map((s) => s.act)).toEqual(["requote"])
  })
})

test("a trigger's card: the exact line it saves, whole, the trigger in words and how it runs, in amber where it will wait, and the chip toward a wallet of its own", () => {
  const line = `when ${MOON} < $0.40 sell 50% of ${MOON}`
  const trigger = card(
    { kind: "trigger", tool: "harness_triggers", side: undefined, params: { line } },
    {
      title: 'NEW TRIGGER "stop"',
      headline: 'NEW TRIGGER "stop"',
      gets: undefined,
      spend: undefined,
      valueUsd: undefined,
      walletLabel: undefined,
      paysFrom: "pays from embedded",
      why: "your stop",
      triggerCard: { line, words: "When MOON's price falls below $0.40, sell 50% of MOON. Fires once, then switches off.", runs: "Asks you each time: the embedded wallet asks every time, so each firing is a card for you to approve or reject within 60 s." },
      warning: "The embedded wallet asks every time, so this will wait for you.",
      fills: [{ label: "new TEE wallet for momentum", line: "candle vault promote --to-key PREFIXxx --label momentum-tee --from " }],
    },
  )
  const lines = texts(trigger)
  expect(lines[0]).toMatch(/^▌ NEW TRIGGER "stop" +42s$/)
  expect(lines.slice(1)).toEqual([
    "▌ momentum · pays from embedded · live",
    "▌ why  your stop",
    `▌ when ${MOON} < $0.40 sell 50% of`,
    `▌ ${MOON}`,
    "▌ When MOON's price falls below $0.40, sell 50% of MOON. Fires once, then",
    "▌ switches off.",
    "▌ Asks you each time: the embedded wallet asks every time, so each firing is a",
    "▌ card for you to approve or reject within 60 s.",
    "▌ The embedded wallet asks every time, so this will wait for you.",
    "▌  new TEE wallet for momentum ",
    "▌  ⏎ approve    ctrl-n reject    ctrl-o details ",
  ])
  expect(cardDetails(trigger).slice(0, 4)).toEqual([`title     NEW TRIGGER "stop"`, `line      ${line}`, "trigger   When MOON's price falls below $0.40, sell 50% of MOON. Fires once, then switches off.", "runs      Asks you each time: the embedded wallet asks every time, so each firing is a card for you to approve or reject within 60 s."])
  expect(cardDetails(trigger).find((l) => l.startsWith("saves"))).toBe(`saves     harness_triggers {"line":"${line}"}`)
})

test("a bot's buy names its bot on the who line, kept where a short pane drops why; expired, it's skipped, with no re-quote", () => {
  const bot = card({}, { bot: "conf", why: 'the bot "conf" entered on a signal' })
  const open = texts(bot, { maxRows: 1 })
  expect(open[1]).toContain("momentum · pays from embedded · live · Moon…1111 · bot conf")
  expect(open.join("\n")).not.toContain("why")
  const expired = texts({ ...bot, state: "expired" })
  expect(expired.join("\n")).toContain('expired, skipped by the bot "conf"')
  expect(expired.join("\n")).not.toContain("re-quote")
  expect(otherWallets(bot, { agents: { momentum: { payable: [{ address: "Tee1111111111111111111111111111111111111111", kind: "tee" }] } } } as unknown as WalletsTopic)).toEqual([])
})

test("folded at 80 columns, a card keeps its headline and who line, its wrapped figures folded with the middle", () => {
  const bot = card({}, { bot: "conf", why: 'the bot "conf" entered on a signal', headline: "BUY $1.50 of A-LONGER-NAMED-TOKEN" })
  const lines = texts(bot, { width: 46, fitRows: 5 })
  expect(lines).toHaveLength(5)
  expect(lines[0]).toContain("BUY $1.50 of A-LONGER-NAMED-TOKEN")
  expect(lines[1]).toContain("bot conf")
  expect(lines[2]).toContain("folded · ctrl-o details")
  expect(lines.at(-1)).toContain("ctrl-o details")
})

describe("a rules bot's card", () => {
  const botCard = (over: Partial<NonNullable<ViewCard["display"]["botCard"]>> = {}): NonNullable<ViewCard["display"]["botCard"]> => ({
    name: "conf",
    words: "Buys $2 when several tracked wallets buy the same token, between $50K and $2M market cap. Sells at +40%, at -25%, or after 2 hours. At most 3 at once.",
    definition: "{}",
    mode: "paper",
    runs: { kind: "paper", entries: "On paper: buys paper trades with no card.", exits: "Sells paper trades, on their own." },
    worst: "At worst 3 open at $2.00.",
    parts: { buys: "paper trades with no card: nothing real is bought", sells: "paper trades, on their own", worst: "3 open at $2.00: $6.00 at risk, plus Candle's fee", tested: "fail · 61 trades · −$12.31" },
    backtest: "Hacc's replay 238: fail.",
    differs: "Hacc's backtest buys at its first price after the signal. A live run buys within seconds.",
    ...over,
  })
  const bot = (b: NonNullable<ViewCard["display"]["botCard"]>, display: Partial<ViewCard["display"]> = {}) =>
    card({ kind: "bot", tool: "harness_bots", side: undefined, params: { action: "save" } }, { headline: undefined, title: `NEW BOT "${b.name}"`, gets: undefined, spend: undefined, valueUsd: undefined, wallet: "none", paysFrom: "pays from embedded", mode: b.mode, why: "Paper test of confluence entries", botCard: b, ...display })

  test("folded at 80×24, what it shows after the fold starts on a whole line, never mid-sentence", () => {
    const b = bot(botCard())
    for (const fitRows of [6, 7, 8, 9, 10, 11]) {
      const lines = texts(b, { width: 48, fitRows })
      const at = lines.findIndex((l) => l.includes("folded · ctrl-o details"))
      expect(at).toBeGreaterThan(0)
      const next = lines[at + 1]!.replace(/^▌ /, "").trim()
      // Never a wrapped line's later part: not a box line with no label, nor words that start mid-sentence.
      expect(next).not.toMatch(/^│ {8}/)
      expect(next).not.toMatch(/^(hours|real|plus|market|token)/)
    }
  })

  test("too tall for its pane, it keeps the lines the press approves: the box's title, buys, sells and worst, and the wallet chip; the steer's paragraph goes first", () => {
    const live = botCard({ mode: "live", runs: { kind: "asks", entries: "Its buys ask you each time.", exits: "Sells on their own.", amber: "its buys ask you each time" }, parts: { buys: "each a card for you within 60 s; one you miss is skipped", sells: "on their own, on any wallet: you approve them now", worst: "4 open at $2.00: $8.00 at risk, plus Candle's fee", tested: "pass · 41 trades · +$9.12 · drawdown 18.4% · Jan 5 to Jan 12" }, from: "From your saved strategy conf-v2." })
    const steer = "Its buys ask you each time. A wallet of its own is the better way: the bot can lose only what that wallet holds, and its figures are the bot's alone."
    const b = bot(live, { warning: steer, fills: [{ label: "new TEE wallet for agent-a", line: "vault promote" }] })
    const whole = texts(b, { width: 46 })
    const lines = texts(b, { width: 46, fitRows: 15 })
    expect(lines.length).toBeLessThanOrEqual(15)
    expect(whole.length).toBeGreaterThan(15)
    const said = lines.join("\n")
    for (const kept of ["its buys ask you each time", "│ buys   each a card for you", "│ sells  on their own, on any wallet", "│ worst  4 open at $2.00", "new TEE wallet for agent-a", "backtest  pass · 41 trades", "⏎ approve"]) expect(said).toContain(kept)
    // The steer's paragraph, and where the bot came from, are what it gave up: details has both.
    expect(said).not.toContain("the bot can lose only")
    expect(said).not.toContain("From your saved strategy")
    expect(cardDetails(b).some((l) => l.includes("the bot can lose only"))).toBe(true)
    // A pane with room draws it whole, as before.
    expect(texts(b, { width: 46, fitRows: 40 })).toEqual(whole)
  })

  test("a code bot's card too tall for its pane keeps its command and its limits line", () => {
    const code = botCard({ name: "momentum", mode: "live", words: "Runs bun run bot.ts in /srv/bots/momentum.", runs: { kind: "asks", entries: "Its buys ask you each time.", exits: "Sells on their own.", amber: "its buys ask you each time" }, parts: { buys: "each a card for you within 60 s; one you miss is refused to the bot", sells: "of what it bought, on their own, on any wallet: you approve them now", worst: "3 open at $2.00: $6.00 at risk, plus Candle's fee", tested: "" }, code: { folder: "/srv/bots/momentum", command: "bun run bot.ts", figures: "$2.00 a trade · $10.00 a day · 3 open at most", holds: "The core holds this bot to these figures. What it trades inside them is its code's." }, backtest: undefined, differs: undefined })
    const b = bot(code, { title: 'NEW CODE BOT "momentum"', warning: "Its buys ask you each time. A wallet of its own is the better way: the bot can lose only what that wallet holds.", fills: [{ label: "new TEE wallet for agent-a", line: "vault promote" }] })
    const lines = texts(b, { width: 46, fitRows: 15 })
    expect(lines.length).toBeLessThanOrEqual(15)
    const said = lines.join("\n")
    for (const kept of ["Runs bun run bot.ts in /srv/bots/momentum.", "its buys ask you each time", "│ buys   each a card", "│ sells  of what it bought", "│ limits $2.00 a trade · $10.00 a day", "│ worst  3 open at $2.00", "new TEE wallet for agent-a", "The core holds this bot to these figures"]) expect(said).toContain(kept)
  })

  test("a change says what it changes on its face, kept when it folds", () => {
    const b = bot(botCard({ changes: "a stake of $3, from $2", replaces: true }), { title: 'CHANGE BOT "conf"' })
    expect(texts(b, { width: 100 }).some((l) => l.includes("changes  a stake of $3, from $2"))).toBe(true)
    const folded = texts(b, { width: 48, fitRows: 6 })
    expect(folded[2]).toContain("changes  a stake of $3, from $2")
    expect(folded[3]).toContain("folded · ctrl-o details")
    expect(cardDetails(b)).toContain("changes   a stake of $3, from $2")
  })

  test("its details name the wallet it pays from, never none", () => {
    const details = cardDetails(bot(botCard()))
    expect(details).toContain("wallet    embedded")
    expect(details.some((l) => l.includes("none"))).toBe(false)
  })

  test("a live bot's card says how a live run differs from its backtest; a paper bot's keeps it in details", () => {
    const differs = "Hacc's backtest buys at its first price after the signal."
    const short = "a live run buys sooner and sells at the market, so it can differ"
    expect(texts(bot(botCard({ mode: "live", runs: { kind: "own", entries: "Runs on its own.", exits: "Sells on its own." } })), { width: 120 }).some((l) => l.includes(short))).toBe(true)
    expect(texts(bot(botCard()), { width: 120 }).some((l) => l.includes(short))).toBe(false)
    expect(cardDetails(bot(botCard())).some((l) => l.includes(differs))).toBe(true)
  })
})
