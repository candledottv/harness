// The card, inline in the agent pane: the compact open card, and the one line an ended card folds to.
import { describe, expect, test } from "bun:test"
import type { ViewCard } from "../store"
import type { WalletsTopic } from "../../core/agent-wallets"
import { cardDetails, otherWallets } from "../overlays"
import { cardLines } from "./card"
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
    "▌ momentum · pays from embedded · live",
    "▌ why  6 smart wallets bought in 10 min",
    "▌  ⏎ approve    ctrl-n reject    ctrl-o details ",
  ])
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
  expect(sell[1]).toBe("▌ momentum · pays from embedded · live · shared with swing")
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
    expect(texts(teeCard())[1]).toBe("▌ momentum · pays from tee-one (TEE · TeeF…1111) · live")
    // The embedded wallet's card is as it was.
    expect(texts(card())[1]).toBe("▌ momentum · pays from embedded · live")
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
