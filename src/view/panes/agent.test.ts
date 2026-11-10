// The agent pane's lines: the kill report pinned at the top while paused, the agent
// speaking first, and the conversation with its quiet tool line and labelled addresses.
import { expect, test } from "bun:test"
import { C } from "../theme"
import type { KillReport } from "../../core/kill"
import type { Exchange } from "../store"
import { addressLines, conversationLines, greetingLines, highlightedCard, killReportLines, operationTitle, paperFiringLines, replyRows, resendsUnderId, resentWords, unansweredLines, waitingWords, withPrompt } from "./agent"
import { textOf } from "./lines"
import { activityLines } from "./activity"

const MOON = "MoonFake11111111111111111111111111111111111"
const NOW = Date.parse("2026-10-26T14:00:00.000Z")
const report = (over: Partial<KillReport> = {}): KillReport => ({
  at: new Date(NOW - 30_000).toISOString(),
  by: "v1",
  stopped: { turns: [{ agent: "momentum", turnId: "t1" }], cards: [{ cardId: "c1", title: "BUY 0.1 SOL (≈$15.00) → MOON", agent: "momentum" }] },
  stillOpen: [{ cardId: "c2", cardHash: "h", title: "SELL 50% MOON", agent: "swing" }],
  inFlight: [{ opId: "op-c3", cardId: "c3", agent: "momentum", title: "BUY 0.05 SOL (≈$7.50) → PEPE", state: "pending" }],
  standing: {
    portfolioAgeMs: 180_000,
    wallets: [{ wallet: "WalletFake111111111111111111111111111111111", agents: ["momentum", "swing"], solUsd: 300, tokensUsd: null, unpriced: 1 }],
    pnl: null,
    spentToday: [{ agent: "momentum", usd: 12, perDayUsd: 50 }],
  },
  notStopped: {
    wording: "Stops the agent and everything that trades through the Candle Harness. Bots and other apps using your keys aren't stopped.",
    steps: [{ agent: "momentum", takeOffWallet: "candle keys self embedded-wallet deny", revoke: "candle keys revoke ab12cd34" }],
    candleStopped: [{ agent: "swing", code: "PROFILE_PAUSED" }],
  },
  resume: "type resume, or click PAUSED in the status bar",
  ...over,
})
const texts = (lines: ReturnType<typeof killReportLines>) => lines.map(textOf).join("\n")

test("the kept cards are named as cards once they aren't all sells: an unstake and a claim stay open too", () => {
  const stillOpen = [
    { cardId: "c2", cardHash: "h", title: "SELL 50% MOON", agent: "swing", kind: "trade", side: "sell" },
    { cardId: "c4", cardHash: "h", title: "CLAIM FEES · Moon…1111", agent: "swing", kind: "claim" },
  ]
  expect(texts(killReportLines(report({ stillOpen }), {}, NOW, 200))).toContain("open        2 cards, below: one press to approve, or let them expire, which is safe")
  expect(texts(killReportLines(report({ stillOpen: [stillOpen[0]!] }), {}, NOW, 200))).toContain("open        1 sell, below")
})

test("the kill report: what it stopped, what's still open, what's in flight, where you stand, what it didn't stop, how to resume", () => {
  const t = texts(killReportLines(report(), {}, NOW, 200))
  expect(t).toContain("KILL SWITCH ON · 30s ago · buys paused, the agent's turn stopped")
  expect(t).toContain("stopped     momentum's turn · withdrew BUY 0.1 SOL (≈$15.00) → MOON (momentum)")
  // The open sell itself is drawn below as a full card.
  expect(t).toContain("open        1 sell, below: one press to approve, or let it expire, which is safe")
  expect(t).toContain("in flight   BUY 0.05 SOL (≈$7.50) → PEPE (momentum): pending")
  // A figure the core didn't have is —, never 0.
  expect(t).toContain("standing    Wall…1111 (momentum, swing): SOL $300.00 · tokens — · 1 unpriced · P&L — · prices 3m ago · stale")
  // A report that says which wallet is the embedded one names it as the panes do; older ones by address.
  const named = report()
  named.standing.wallets = [{ ...named.standing.wallets[0]!, kind: "embedded" }]
  expect(texts(killReportLines(named, {}, NOW, 200))).toContain("standing    embedded (momentum, swing): SOL $300.00")
  expect(t).toContain("spent       momentum $12.00 of $50.00 today")
  // What it can't reach is one line with a chip; the steps open from it.
  expect(t).toContain("not stopped other apps on these keys   how to stop them ")
  expect(t).not.toContain("candle keys revoke ab12cd34")
  expect(killReportLines(report(), {}, NOW, 200).some((l) => l.segs.some((s) => s.act === "stopHelp"))).toBe(true)
  expect(t).toContain("Candle has stopped swing: PROFILE_PAUSED")
  expect(t).toContain("resume      type resume, or click PAUSED in the status bar")
})

test("a TEE wallet the kill switch can't reach gets a chip: its tee disable on the input line, with the key it's bound to", () => {
  const tee = "TeeFake1111111111111111111111111111111111111"
  const r = report()
  r.notStopped.steps = [{ ...r.notStopped.steps[0]!, disableTee: [{ wallet: "tee-one", command: `candle tee disable ${tee}` }] }]
  const lines = killReportLines(r, {}, NOW, 200)
  const chipLine = lines.find((l) => l.segs.some((s) => s.act === "fill"))!
  expect(textOf(chipLine)).toContain("TEE wallet tee-one (momentum)")
  expect(chipLine.ref).toBe(`candle tee disable ${tee} as momentum`)
  // Still there in a short slot: it's what stops a wallet the switch can't.
  expect(killReportLines(r, {}, NOW, 80, 12).some((l) => l.segs.some((s) => s.act === "fill"))).toBe(true)
  expect(killReportLines(report(), {}, NOW, 200).some((l) => l.segs.some((s) => s.act === "fill"))).toBe(false)
})

test("an open card says letting it expire is safe", () => {
  expect(texts(killReportLines(report(), {}, NOW, 200))).toContain("let it expire, which is safe")
})

test("a short slot drops detail, never what's open, what's in flight or how to resume", () => {
  const full = killReportLines(report(), {}, NOW, 80)
  for (const rows of [full.length - 1, 9, 7, 6, 3]) {
    const lines = killReportLines(report(), {}, NOW, 80, rows)
    const t = lines.map(textOf).join("\n")
    expect(lines.length).toBeLessThanOrEqual(Math.max(rows, 2))
    expect(lines.at(-1) && textOf(lines.at(-1)!)).toStartWith("resume")
    expect(t).toContain("KILL SWITCH ON")
    if (rows >= 6) {
      expect(t).toContain("open        1 sell, below")
      expect(t).toContain("in flight   BUY 0.05 SOL")
    }
  }
  // Where you stand goes first.
  const shorter = killReportLines(report(), {}, NOW, 80, full.length - 1).map(textOf).join("\n")
  expect(shorter).not.toContain("standing")
  expect(shorter).toContain("spent")
})

test("an in-flight line follows the operation as it settles", () => {
  const t = texts(killReportLines(report(), { "op-c3": { opId: "op-c3", cardId: "c3", agent: "momentum", state: "succeeded" } }, NOW, 200))
  expect(t).toContain("in flight   BUY 0.05 SOL (≈$7.50) → PEPE (momentum): filled")
})

test("a lost swap whose read-back waits for a resume says so in flight", () => {
  const r = report({ inFlight: [{ opId: "op-c3", cardId: "c3", agent: "momentum", title: "SWAP 0.05 SOL → USDC", state: "unknown", held: true }] })
  expect(texts(killReportLines(r, { "op-c3": { opId: "op-c3", cardId: "c3", agent: "momentum", state: "unknown" } }, NOW, 200))).toContain("waits until you resume")
  expect(texts(killReportLines(report({ inFlight: [{ ...r.inFlight[0]!, held: undefined }] }), {}, NOW, 200))).not.toContain("waits until you resume")
})

test("a live sell Candle closed as paper isn't called filled in flight", () => {
  const t = texts(killReportLines(report(), { "op-c3": { opId: "op-c3", cardId: "c3", agent: "momentum", state: "succeeded", paper: true } }, NOW, 200))
  expect(t).not.toContain(": filled")
  expect(t).toContain("not sold live")
})

test("with no portfolio read, where you stand is —", () => {
  const t = texts(killReportLines(report({ standing: { portfolioAgeMs: null, wallets: [], pnl: null, spentToday: [] } }), {}, NOW, 200))
  expect(t).toContain("standing    — (no portfolio read yet) · P&L —")
})

test("the agent speaks first: what it can do, and three things to try", () => {
  const lines = greetingLines("momentum", 200).map(textOf)
  expect(lines[0]).toStartWith("momentum here.")
  expect(lines.filter((l) => l.startsWith("  · "))).toHaveLength(3)
})

test("a conversation: you, the tools in a quiet line, the reply wrapped, and addresses with their source", () => {
  const exchange: Exchange = {
    turnId: "t1",
    user: "what's moving?",
    reply: "MOON is up. Its mint is MoonFake11111111111111111111111111111111111.",
    streaming: false,
    outcome: "done",
    tools: ["candle_get_feed bucket=onfire", "candle_token_forensics MOON"],
    labelled: [{ address: MOON, source: "candle" }],
  }
  const lines = conversationLines([exchange], 50).map(textOf)
  expect(lines[0]).toBe("you › what's moving?")
  // A blank line between your words and the answer.
  expect(lines[1]).toBe("")
  expect(lines[2]).toBe("  ⌁ candle_get_feed · candle_token_forensics")
  expect(lines.slice(3, -1).every((l) => l.length <= 50 && l.startsWith("  "))).toBe(true)
  expect(lines.at(-1)).toBe("  ⌖  Moon…1111  from candle  ⧉  ")
})

test("a woken turn: the trigger's mark and what fired, never \"you ›\"", () => {
  const exchange: Exchange = { turnId: "t2", user: 'woken by the trigger "conf": a confluence signal on BONK at 14:02', reply: "Woke on conf: bought $1 of BONK.", streaming: false, outcome: "done", tools: [], woken: ["conf"] }
  const lines = conversationLines([exchange], 80).map(textOf)
  expect(lines[0]).toBe('⚡ woke › the trigger "conf": a confluence signal on BONK at 14:02')
  expect(lines.some((l) => l.startsWith("you ›"))).toBe(false)
})

test("a message sent from outside (candle-harness ask): yours, said dim after the words, or on a row of its own where it won't fit", () => {
  const exchange: Exchange = { turnId: "t3", user: "how am I doing?", reply: "Up $1.20 today.", streaming: false, outcome: "done", tools: [], outside: true }
  const lines = conversationLines([exchange], 80)
  expect(textOf(lines[0]!)).toBe("you › how am I doing? · from outside")
  expect(lines[0]!.segs.at(-1)).toMatchObject({ text: " · from outside", fg: C.dim })
  const narrow = conversationLines([exchange], 24).map(textOf)
  expect(narrow.slice(0, 2)).toEqual(["you › how am I doing?", "      · from outside"])
  expect(conversationLines([{ ...exchange, outside: undefined }], 80).map(textOf)[0]).toBe("you › how am I doing?")
})

test("Markdown emphasis and code markers don't show as characters", () => {
  const lines = conversationLines([{ turnId: "t", user: "hi", reply: "**Check:** id `abc` and __done__", streaming: false, outcome: "done", tools: [] }], 80).map(textOf)
  expect(lines.at(-1)).toBe("  Check: id abc and done  ⧉ ")
})

test("a double underscore inside a name stays: MCP tool names aren't emphasis", () => {
  const reply = "I have candle__candle_trade, `candle__harness_show_wallets` and __done__, and **bold** in `a**b`."
  const lines = conversationLines([{ turnId: "t", user: "hi", reply, streaming: false, outcome: "done", tools: [] }], 200).map(textOf)
  expect(lines.at(-1)).toBe("  I have candle__candle_trade, candle__harness_show_wallets and done, and bold in a**b.  ⧉ ")
})

test("a reply still streaming shows what's come so far; a turn that didn't finish is muted, in the runner's words", () => {
  expect(conversationLines([{ turnId: "t", user: "hi", reply: "", streaming: true, tools: [] }], 50).map(textOf)).toContain("  …")
  const stopped = conversationLines([{ turnId: "t", user: "hi", reply: "Stopped after 30 steps: tell the agent to carry on.", streaming: false, outcome: "stopped", tools: [] }], 80)
  expect(textOf(stopped.at(-1)!)).toBe("  Stopped after 30 steps: tell the agent to carry on.  ⧉ ")
  expect(stopped.at(-1)!.segs[0]!.fg).not.toBe(conversationLines([{ turnId: "t", user: "hi", reply: "ok", streaming: false, outcome: "done", tools: [] }], 80).at(-1)!.segs[0]!.fg)
})

test("an operation Candle didn't answer: what it was, that it's read back, and re-send or abandon, clickable", () => {
  const ops = {
    "op-a": { opId: "op-a", cardId: "card-a", agent: "momentum", state: "unknown", kind: "trade", params: { mint: MOON, side: "buy", amount: "0.01" }, startedAt: NOW - 90_000 },
    "op-b": { opId: "op-b", cardId: "card-b", agent: "momentum", state: "succeeded", kind: "trade" },
  }
  const lines = unansweredLines(ops, [], NOW, 100)
  const text = lines.map(textOf).join("\n")
  expect(text).toContain("NO ANSWER FROM CANDLE · BUY 0.01 · Moon…1111 · momentum")
  expect(text).toContain("If it stays, check")
  expect(text).not.toContain("op-b")
  const actions = lines.at(-1)!
  expect(actions.cardId).toBe("card-a")
  expect(actions.segs.filter((s) => s.act).map((s) => s.act)).toEqual(["resend", "abandon"])
  expect(unansweredLines({}, [], NOW, 100)).toEqual([])
})

test("three trades Candle didn't answer, read back by their ids (a restart cut off a bot's exits): said once, each a line with its chips", () => {
  const op = (id: string, mint: string) => ({ opId: id, cardId: `card-${id}`, agent: "momentum", state: "unknown", kind: "trade", params: { mint, side: "sell", percent: 100 }, startedAt: NOW - 38_000 })
  const ops = { a: op("a", MOON), b: op("b", "Ejax1111111111111111111111111111111111pump"), c: op("c", "G2hd111111111111111111111111111111111Wgjs") }
  const lines = unansweredLines(ops, [], NOW, 45)
  const text = lines.map(textOf)
  expect(text[0]).toBe("NO ANSWER FROM CANDLE · 3 trades · momentum ·")
  expect(text.filter((t) => t.includes("reads each back by its id"))).toHaveLength(1)
  const rows = lines.filter((l) => l.segs.some((s) => s.act === "resend"))
  expect(rows.map((l) => l.cardId)).toEqual(["card-a", "card-b", "card-c"])
  for (const r of rows) expect(r.segs.filter((s) => s.act).map((s) => s.act)).toEqual(["resend", "abandon"])
  // At 80×24's agent pane, the three fit in under half the rows they took one block each.
  expect(lines.length).toBeLessThanOrEqual(12)
})

test("a post, fee claim or upload Candle didn't answer says a re-send may run it twice, with its card's note", () => {
  const post = { opId: "op-p", cardId: "card-p", agent: "momentum", state: "unknown", kind: "public", tool: "candle_create_post", params: { text: "gm" }, startedAt: NOW - 30_000 }
  const card = { cardId: "card-p", display: { title: "POST", resendNote: "A re-sent post can post twice: check the agent's page before re-sending." } } as never
  const text = unansweredLines({ "op-p": post }, [card], NOW, 200).map(textOf).join("\n")
  expect(text).toContain("re-send (no id: may run twice)")
  expect(text).toContain("A re-sent post can post twice")
  expect(text).not.toContain("never runs twice")
  expect(text).not.toContain("reads it back by its id")
  expect(resendsUnderId({ ...post, kind: "upload", tool: "candle_cli", params: { argv: ["image", "upload", "x.png"] } })).toBe(false)
  expect(resendsUnderId({ ...post, kind: "claim", tool: "candle_claim_fees", params: {} })).toBe(false)
  // An id the tool replays by, or the CLI's id flag, keeps the promise.
  expect(resendsUnderId({ ...post, kind: "claim", tool: "candle_claim_staking_reward", params: { rewardId: "r1" } })).toBe(true)
  expect(resendsUnderId({ ...post, kind: "lp", tool: "candle_cli", params: { argv: ["lp", "add", "--client-trade-id", "x"] } })).toBe(true)
  expect(resendsUnderId({ ...post, kind: "swap" })).toBe(true)
})

test("what a re-send came to says the same id only where there is one, as its chip did", () => {
  const post = { opId: "op-p", cardId: "card-p", agent: "momentum", state: "unknown", kind: "public", tool: "candle_create_post", params: { text: "gm" } }
  expect(resentWords(post, { state: "succeeded" })).not.toContain("same id")
  expect(resentWords(post, { state: "succeeded" })).toContain("may have run twice")
  expect(resentWords({ ...post, kind: "claim", tool: "candle_claim_fees", params: {} }, { state: "unknown" })).toContain("may have run twice")
  const sell = { ...post, kind: "trade", tool: "candle_trade", params: { side: "sell" } }
  expect(resentWords(sell, { state: "succeeded" })).toBe("Re-sent under the same id: filled.")
  expect(resentWords(sell, { state: "succeeded", paper: true })).toContain("not sold live")
})

test("while a re-send is out, the pane says so and offers no second one", () => {
  const op = { opId: "op-a", cardId: "card-a", agent: "momentum", state: "unknown", kind: "trade", params: { mint: MOON, side: "buy", amount: "0.01" }, startedAt: NOW - 30_000, resending: true }
  const lines = unansweredLines({ "op-a": op }, [], NOW, 100)
  expect(lines.map(textOf).join("\n")).toContain("Re-sending it")
  expect(lines.flatMap((l) => l.segs).some((s) => s.act)).toBe(false)
})

test("an operation's title is its card's when the view has it, else what was sent", () => {
  const swap = { opId: "o", cardId: "c", agent: "a", state: "unknown", kind: "swap", params: { amount: "0.005", from: "SOL", to: "USDC" } }
  expect(operationTitle(swap, [])).toBe("SWAP 0.005 SOL → USDC")
  expect(operationTitle({ ...swap, kind: "trade", params: { side: "sell", percent: 100, mint: MOON } }, [])).toBe("SELL 100% · Moon…1111")
  expect(operationTitle({ ...swap, kind: "cli", tool: "candle_cli", params: {} }, [])).toBe("candle_cli")
})

test("a Markdown table is laid out in columns, numbers right-aligned, or as a block a row when the pane is too narrow", () => {
  const reply = "Your wallets:\n\n| Wallet | SOL | USD |\n|---|---:|---|\n| embedded | 0.1 | $10.02 |\n| tee | 0.02 | $2.00 |\n\nAbout $12 in total."
  const rows = (w: number) => replyRows(reply, w).map((r) => r.map((s) => s.text).join(""))
  expect(rows(60)).toEqual(["Your wallets:", "", "Wallet     SOL     USD", "embedded   0.1  $10.02", "tee       0.02   $2.00", "", "About $12 in total."])
  // The header is a label, dim.
  expect(replyRows(reply, 60)[2]![0]!.fg).toBe(C.dim)
  expect(rows(15)).toEqual(["Your wallets:", "", "embedded", "  SOL: 0.1 ·", "  USD: $10.02", "", "tee", "  SOL: 0.02 ·", "  USD: $2.00", "", "About $12 in", "total."])
})

test("a stacked table labels short and long cells alike, so a row reads the same either way (not \"Result No PEPE\" beside \"Result: Empty, so …\")", () => {
  const reply = "| Check | Result |\n|---|---|\n| Trades | Empty, so the buy isn't listed anywhere yet |\n| `tee-one` wallet | No PEPE |"
  const lines = replyRows(reply, 30).map((r) => r.map((s) => s.text).join(""))
  expect(lines).toContain("  Result: No PEPE")
  expect(lines.some((l) => l.startsWith("  Result: Empty"))).toBe(true)
})

test("Markdown renders for the terminal: headings, bold, code, bullets with hanging indents, nested bullets, quotes", () => {
  const reply = "## Its record\n\n**Biggest wins:**\n- AUTON: +$65.8k over about six hours\n  - one trade\n1. first\n> quoted\n\nUse `view strategy` next."
  const rows = replyRows(reply, 24)
  const text = rows.map((r) => r.map((s) => s.text).join(""))
  expect(text).toEqual(["Its record", "", "Biggest wins:", "• AUTON: +$65.8k over", "  about six hours", "  ◦ one trade", "1. first", "│ quoted", "", "Use view strategy next."])
  expect(rows[0]![0]).toMatchObject({ fg: C.head, bold: true })
  expect(rows[2]![0]).toMatchObject({ fg: C.hi, bold: true })
  // Code in its own colour, as glow draws it, not bold's.
  expect(rows.at(-1)!.find((s) => s.text === "view strategy")!.fg).toBe(C.mdCode)
  expect(C.mdCode).not.toBe(C.hi)
  expect(rows[7]![0]!.fg).toBe(C.dim)
})

test("an address in a reply shows short and bright; the line under it lists each in full with a ⧉ chip that copies it", () => {
  const rows = replyRows(`AgenC ${MOON} has 42 signals.`, 80)
  expect(rows[0]!.map((s) => s.text).join("")).toBe("AgenC Moon…1111 has 42 signals.")
  expect(rows[0]!.find((s) => s.text === "Moon…1111")!.fg).toBe(C.hi)
  const lines = addressLines([{ address: MOON, source: "hacc" }, { address: "PepeFake11111111111111111111111111111111111", source: "candle" }], 80)
  expect(lines.map(textOf)).toEqual(["  ⌖  Moon…1111  from hacc  ⧉  ·  Pepe…1111  from candle  ⧉  "])
  const chips = lines[0]!.segs.filter((s) => s.act === "copy")
  expect(chips.map((s) => s.ref)).toEqual([MOON, "PepeFake11111111111111111111111111111111111"])
  // Narrow, a line each; a copied one shows in full.
  expect(addressLines([{ address: MOON, source: "hacc" }, { address: "PepeFake11111111111111111111111111111111111", source: "web" }], 30, MOON).map(textOf)).toEqual([`  ⌖  ${MOON}  from hacc  ⧉  `, "    ·  Pepe…1111  from web  ⧉  "])
})

test("your words are bright and 'you ›' dim; an answer is shown whole, and ends with a ⧉ that copies it", () => {
  const long = { turnId: "t9", user: "tell me everything", reply: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"), streaming: false, outcome: "done", tools: [] }
  const lines = conversationLines([long], 80)
  expect(lines[0]!.segs.map((s) => s.fg)).toEqual([C.dim, C.hi])
  expect(lines.map(textOf)).toContain("  line 1")
  const copy = lines.flatMap((l) => l.segs).filter((s) => s.act === "copyReply")
  expect(copy.map((s) => s.ref)).toEqual(["t9"])
  // After the last words, on their row.
  expect(textOf(lines.find((l) => l.segs.some((s) => s.act === "copyReply"))!)).toBe("  line 30  ⧉ ")
  // Its click never focuses a card.
  expect(lines.every((l) => l.cardId === undefined)).toBe(true)
  // One still streaming has no ⧉ yet; an answer whose last row is full puts it on a row of its own.
  expect(conversationLines([{ ...long, streaming: true }], 80).some((l) => l.segs.some((s) => s.act))).toBe(false)
  const full = conversationLines([{ ...long, reply: "x".repeat(28) }], 30)
  expect(textOf(full.at(-1)!)).toBe("   ⧉ ")
})

test("with two cards waiting, the one Enter approves is shaded even from the input line", () => {
  const open = [{ cardId: "c1" }, { cardId: "c2" }]
  // From the input line, Enter takes the newest (keys.ts, focusedCard): it's the shaded one.
  expect(highlightedCard(open, undefined, false)).toBe("c2")
  // Picked with the arrows or a click, that one.
  expect(highlightedCard(open, "c1", false)).toBe("c1")
  expect(highlightedCard(open, "c1", true)).toBe("c1")
  // One card: no shade until the cards have focus, as before; nothing to tell apart.
  expect(highlightedCard([{ cardId: "c1" }], undefined, false)).toBeUndefined()
  expect(highlightedCard([{ cardId: "c1" }], undefined, true)).toBe("c1")
  // A picked card that's gone falls back to the newest, as Enter does.
  expect(highlightedCard(open, "gone", false)).toBe("c2")
  expect(highlightedCard([], undefined, true)).toBeUndefined()
})

// The figure gate's mark.
const markedExchange = (reply: string, texts: string[], over: Partial<Exchange> = {}): Exchange => ({
  turnId: "t",
  user: "how's MOON?",
  reply,
  streaming: false,
  outcome: "done",
  tools: [],
  marked: texts.map((text) => ({ at: reply.indexOf(text), text })),
  ...over,
})

test("a figure no tool showed is dimmed with a ? after it, and the legend says what ? means", () => {
  const lines = conversationLines([markedExchange("Price $0.0042, market cap $4.4M, liquidity $90K. 0.1 SOL is about $15.", ["$4.4M", "$90K"])], 80)
  const row = lines.find((l) => textOf(l).includes("Price"))!
  expect(textOf(row)).toBe("  Price $0.0042, market cap $4.4M?, liquidity $90K?. 0.1 SOL is about $15.  ⧉ ")
  expect(row.segs.filter((s) => s.fg === C.dim && s.text.trim()).map((s) => s.text)).toEqual(["$4.4M?", "$90K?"])
  // The read figure is in the reply's own colour.
  expect(row.segs.find((s) => s.text.includes("$0.0042"))!.fg).toBe(C.ink)
  expect(textOf(lines.at(-1)!)).toBe("  ? not read from a tool")
  expect(lines.at(-1)!.segs[0]!.fg).toBe(C.dim)
})

test("no marks, no legend; ≈ keeps its own meaning; a reply still streaming isn't marked yet", () => {
  const plain = conversationLines([markedExchange("MOON is ≈$0.0042.", [])], 80).map(textOf)
  expect(plain).not.toContain("  ? not read from a tool")
  expect(plain.at(-1)).toBe("  MOON is ≈$0.0042.  ⧉ ")
  const streaming = conversationLines([markedExchange("MOON is $0.0051", ["$0.0051"], { streaming: true })], 80).map(textOf)
  expect(streaming.at(-1)).toBe("  MOON is $0.0051")
})

test("the mark survives Markdown, a table and wrapping at 80×24's width, and keeps columns aligned", () => {
  const reply = "**Price:** `$0.0051` now.\n\n| token | mcap |\n|---|---|\n| MOON | $4.2M |\n| PEPE | $812K |\n\n" + "word ".repeat(12) + "then $9.99 at the end"
  const lines = conversationLines([markedExchange(reply, ["$0.0051", "$812K", "$9.99"])], 36).map(textOf)
  expect(lines).toContain("  Price: $0.0051? now.")
  const moon = lines.find((l) => l.startsWith("  MOON"))!
  const pepe = lines.find((l) => l.startsWith("  PEPE"))!
  expect(pepe).toContain("$812K?")
  // A column of figures is right-aligned, the mark counted.
  expect(moon.length).toBe(pepe.length)
  expect(lines.some((l) => l.includes("$9.99?"))).toBe(true)
  expect(lines.every((l) => l.length <= 36)).toBe(true)
})

test("a mark that no longer sits on its figure is left off, rather than dimming something else", () => {
  const lines = conversationLines([{ ...markedExchange("MOON is $0.0051.", []), marked: [{ at: 3, text: "$0.0051" }] }], 80).map(textOf)
  expect(lines.at(-1)).toBe("  MOON is $0.0051.  ⧉ ")
})

test("while a turn runs, what you asked stays on screen when a long answer pushes it off the top", () => {
  const asked = { turnId: "t2", user: "Please tell me, of the wallets on today's tape, which one you'd follow and why", reply: Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join("\n"), streaming: true, tools: [] }
  const convo = conversationLines([asked], 40)
  const end = convo.length
  const shown = withPrompt(convo, end - 10, end, true)
  expect(shown).toHaveLength(10)
  expect(textOf(shown[0]!)).toBe("you › Please tell me, of the wallets on …")
  expect(textOf(shown.at(-1)!)).toBe("  row 40")
  // Done, or with the prompt already in sight, nothing changes.
  expect(withPrompt(convo, end - 10, end, false).map(textOf)).toEqual(convo.slice(end - 10).map(textOf))
  expect(withPrompt(convo, 0, 10, true).map(textOf)).toEqual(convo.slice(0, 10).map(textOf))
})

test("in a narrow pane the kill report's chips go under their words, never cut off", () => {
  const tee = "TeeFake1111111111111111111111111111111111111"
  const r = report()
  r.notStopped.steps = [{ ...r.notStopped.steps[0]!, disableTee: [{ wallet: "tee-wide-name", command: `candle tee disable ${tee}` }] }]
  const lines = killReportLines(r, {}, NOW, 53)
  for (const act of ["stopHelp", "fill"]) {
    const at = lines.findIndex((l) => l.segs.some((s) => s.act === act))
    expect(at).toBeGreaterThan(0)
    expect(textOf(lines[at]!).length).toBeLessThanOrEqual(53)
  }
  expect(texts(lines)).toContain("not stopped other apps on these keys")
  expect(lines.find((l) => l.segs.some((s) => s.act === "fill"))!.ref).toBe(`candle tee disable ${tee} as momentum`)
})

test("a conversation from before the core started ends in a dim divider naming when, so its figures don't read as today's", () => {
  const at = new Date(2026, 9, 31, 22, 45).toISOString()
  const old = { turnId: "t1", user: "how much is left today?", reply: "agent-a-tee has used $2.00 of today's $3.00.", streaming: false, outcome: "done", tools: [], earlier: at }
  const lines = conversationLines([old, { ...old, turnId: "t2", earlier: at }, { turnId: "t3", user: "and now?", reply: "Nothing yet.", streaming: false, outcome: "done", tools: [] }], 50).map(textOf)
  const dividers = lines.filter((l) => l.startsWith("── earlier"))
  expect(dividers).toEqual(["── earlier · Sat 31 Oct 22:45 ".padEnd(50, "─")])
  // Under the last of them, before the new message.
  expect(lines.indexOf(dividers[0]!)).toBeLessThan(lines.findIndex((l) => l.includes("and now?")))
  expect(conversationLines([{ turnId: "t3", user: "x", reply: "y", streaming: false, outcome: "done", tools: [] }], 50).map(textOf).some((l) => l.startsWith("── earlier"))).toBe(false)
})

test("the kill report names each trigger the pause holds, short, beside the wallets it holds", () => {
  const lines = texts(killReportLines(report({ triggersHeld: [{ name: "dip", agent: "momentum", words: "its buys and swaps are held until you resume; its sells still go" }] }), {}, NOW, 200))
  expect(lines).toContain('held        trigger "dip": its buys and swaps are held; its sells still go')
})

test("a kill report too tall for its slot names every trigger the pause holds in one line, rather than cutting some unsaid", () => {
  const words = "wakes momentum: held, no wake until you resume"
  const triggersHeld = ["fill review", "check tape", "daily buy"].map((name) => ({ name, agent: "momentum", words }))
  const lines = texts(killReportLines(report({ triggersHeld, stillOpen: [], inFlight: [] }), {}, NOW, 46, 7)).split("\n")
  expect(lines.join(" ").replace(/\s+/g, " ")).toContain('3 triggers that buy, swap or wake: "fill review", "check tape", "daily buy"')
  expect(lines.at(-2)).toContain("resume")
  // With room, each has its own line.
  expect(texts(killReportLines(report({ triggersHeld }), {}, NOW, 200)).split("\n").filter((l) => l.startsWith("held        trigger"))).toHaveLength(3)
  // At its smallest (an unanswered trade pinned under it), what it holds still has a line.
  const tiny = texts(killReportLines(report({ triggersHeld, stillOpen: [], inFlight: [], insideLimits: [{ wallet: "W", name: "embedded" }] } as never), {}, NOW, 46, 3)).split("\n")
  expect(tiny).toEqual(["KILL SWITCH ON · 30s ago · buys paused, the a…", "held        embedded wallet and 3 triggers", expect.stringMatching(/^resume {6}type resume/)])
})

test("the kill report names each bot whose entries the pause holds, and what its exits still guard", () => {
  const botsHeld = [{ name: "conf", agent: "momentum", mode: "live" as const, open: ["MOON"], words: "its entries are held until you resume; its exits still sell, guarding its MOON position" }]
  expect(texts(killReportLines(report({ botsHeld }), {}, NOW, 200))).toContain('held        bot "conf": its entries are held; its exits still sell, guarding its MOON position')
  // Too tall for its slot: every bot in one line, by name, with how many positions their exits guard.
  const many = ["conf", "fast", "slow"].map((name) => ({ ...botsHeld[0]!, name }))
  const lines = texts(killReportLines(report({ botsHeld: many, stillOpen: [], inFlight: [] }), {}, NOW, 46, 7)).split("\n")
  expect(lines.join(" ").replace(/\s+/g, " ")).toContain(`3 bots' buys: "conf", "fast", "slow"; exits guard 3 open`)
  expect(lines.at(-2)).toContain("resume")
})

test("in two rows, as the short pane at 80×24 gives it, the kill report still says what the pause holds", () => {
  const botsHeld = [{ name: "jup-paper", agent: "momentum", mode: "paper" as const, open: ["JUP"], words: "its entries are held until you resume; its exits still sell, guarding its JUP position" }]
  const lines = texts(killReportLines(report({ botsHeld }), {}, NOW, 76, 2)).split("\n")
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('KILL SWITCH ON · held bot "jup-paper"; its 1 open position still sells')
  expect(lines[1]).toStartWith("resume")
})

test("Activity's run it now chip on a trigger's expired card carries the card", () => {
  const lines = activityLines([{ seq: 1, at: new Date(NOW).toISOString(), text: "expired BUY 0.02 SOL → MOON: nobody pressed it", tone: "warn", runNow: "c7" }], 80, NOW)
  const chip = lines.flatMap((l) => l.segs.map((s) => ({ s, ref: (l as { ref?: string }).ref }))).find((x) => x.s.act === "runNow")
  expect(chip?.s.text.trim()).toBe("run it now")
  expect(chip?.ref).toBe("c7")
})

test("once a trigger's expired card is run again, its run it now chip goes, in Activity and on the card", () => {
  const entry = { seq: 1, at: new Date(NOW).toISOString(), text: "expired BUY 0.02 SOL → MOON: nobody pressed it", tone: "warn" as const, runNow: "c7" }
  const chipOf = (lines: ReturnType<typeof activityLines>) => lines.flatMap((l) => l.segs).find((x) => x.act === "runNow")
  expect(chipOf(activityLines([entry], 80, NOW, [], new Set(["c7"])))).toBeDefined()
  expect(chipOf(activityLines([entry], 80, NOW, [], new Set()))).toBeUndefined()
})

test("a trigger's paper trade, which makes no card, is a firing line in the agent pane: ⚡ and its name, then what it saw and did", () => {
  const e = { seq: 1, at: new Date(NOW).toISOString(), agent: "momentum", text: "x", tone: "info" as const, firing: { name: "JUP stop", said: "JUP was $0.2617, under $0.264 → paper sell JUP: ≈3.82 JUP for ≈0.0104 SOL at the quoted price", paper: true as const } }
  const lines = paperFiringLines(e, 60)
  expect(lines[0]!.segs[0]).toMatchObject({ text: "⚡ JUP stop", fg: C.head })
  expect(lines.map(textOf).join(" ").replace(/\s+/g, " ")).toBe("⚡ JUP stop JUP was $0.2617, under $0.264 → paper sell JUP: ≈3.82 JUP for ≈0.0104 SOL at the quoted price")
  for (const l of lines) expect(textOf(l).length + (textOf(l).includes("⚡") ? 1 : 0)).toBeLessThanOrEqual(60)
})

test("a pause that couldn't be saved says so in amber, whole; a saved one says nothing of it", () => {
  const unsaved = "The pause couldn't be saved (the disk or the state folder can't be written), so it won't survive a restart of the Candle Harness. Press the kill switch again once it can."
  const lines = killReportLines(report({ unsaved }), {}, NOW, 60)
  const said = lines.filter((l) => l.segs.some((seg) => seg.fg === C.look)).map(textOf).join(" ").replace(/\s+/g, " ")
  expect(said).toContain("The pause couldn't be saved")
  expect(said).toContain("Press the kill switch again once it can.")
  expect(texts(killReportLines(report(), {}, NOW, 60))).not.toContain("couldn't be saved")
})

test("the cards' heading says how to reach them while another pane has the keys, and that ⏎ approves only when this one does", () => {
  expect(waitingWords(1, true)).toBe("1 card waiting · ctrl-] then ⏎, or click")
  expect(waitingWords(2, true)).toBe("2 cards waiting · ctrl-] then ⏎, or click")
  expect(waitingWords(1, true)).not.toContain("⏎ approves")
  expect(waitingWords(1)).toBe("1 card waiting · ⏎ approves the highlighted one")
})
