// The key reducer: every rule that keeps a stray key from trading, and a
// burst of keys landing where the last state says.
import { describe, expect, test } from "bun:test"
import { APPROVE_AFTER_BEHIND_MS, APPROVE_AFTER_MS, scrollOf, type Effect, ERROR_MESSAGE_MS, INITIAL_UI, joinWrappedAddresses, KILL_WINDOW_MS, type Key, MESSAGE_MS, paletteFound, step, type UiAction, type UiContext, type UiState, SETTINGS } from "./keys"
import { AGENT_FIRST, type PaneId, paneNav, place, shownOf } from "./layout"
import type { ViewCard } from "./store"

const MOON = "MoonFake11111111111111111111111111111111111"
const card = (cardId: string): ViewCard => ({
  cardId,
  opId: `op-${cardId}`,
  cardHash: `hash-${cardId}`,
  kind: "trade",
  tool: "candle_trade",
  agent: "momentum",
  state: "awaiting_approval",
  expiresAt: "2026-10-26T12:01:00.000Z",
  side: "buy",
  display: { title: `BUY ${cardId}`, agent: "momentum", wallet: "W", mode: "live", expiresAt: "2026-10-26T12:01:00.000Z" },
})

function ctx(over: Partial<UiContext> = {}): UiContext {
  return { cards: [], seenAt: {}, mode: "live", agents: ["momentum", "swing"], activeAgent: "momentum", commands: { agents: ["momentum", "swing"], knownTokens: new Map([["MOON", MOON]]) }, ...over }
}

/** Runs actions in order, collecting every effect. */
function run(actions: UiAction[], c: UiContext = ctx(), start: UiState = INITIAL_UI): { state: UiState; effects: Effect[] } {
  let state = start
  const effects: Effect[] = []
  for (const a of actions) {
    const r = step(state, a, c)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}
const key = (name: string, now = 0, extra: Partial<Key> = {}): UiAction => ({ type: "key", key: { name, sequence: name.length === 1 ? name : undefined, ...extra }, now })
const type = (text: string, now = 0): UiAction[] => [...text].map((ch) => ({ type: "key", key: { name: ch === " " ? "space" : ch, sequence: ch }, now }))
const enter = (now = 0) => key("return", now)
const ctrl = (name: string, now = 0) => key(name, now, { ctrl: true, sequence: undefined })

describe("Enter and cards", () => {
  const c = ctx({ cards: [card("a"), card("b")], seenAt: { a: 0, b: 1_000 } })

  test("with text on the line, Enter sends it and approves nothing", () => {
    const r = run([...type("what's up", 2_000), enter(2_000)], c)
    expect(r.effects).toEqual([{ type: "command", command: { kind: "agent", text: "what's up" } }])
    expect(r.state.input).toBe("")
  })

  test("with the line empty, Enter approves the newest card once it's been on screen 300 ms", () => {
    expect(run([enter(1_000 + APPROVE_AFTER_MS)], c).effects).toEqual([{ type: "approve", cardId: "b", how: "enter" }])
  })

  test("not within 300 ms of it appearing: a double tap after a typed buy approves nothing", () => {
    // The first Enter sends `buy …`; the card arrives at 1000; the second Enter lands 120 ms later.
    expect(run([enter(1_120)], c).effects).toEqual([])
    expect(run([enter(1_000 + APPROVE_AFTER_MS - 1)], c).effects).toEqual([])
  })

  test("a card that arrived while another was open waits 1.5 s for Enter; a click on it, and a card that arrived alone, keep 300 ms", () => {
    const late = { ...c, behind: { b: true as const } }
    expect(run([enter(1_000 + APPROVE_AFTER_MS)], late).effects).toEqual([])
    expect(run([enter(1_000 + APPROVE_AFTER_BEHIND_MS - 1)], late).effects).toEqual([])
    expect(run([enter(1_000 + APPROVE_AFTER_BEHIND_MS)], late).effects).toEqual([{ type: "approve", cardId: "b", how: "enter" }])
    expect(run([{ type: "clickApprove", cardId: "b", now: 1_000 + APPROVE_AFTER_MS }], late).effects).toEqual([{ type: "approve", cardId: "b", how: "click" }])
    // The card it arrived under is still one move away, on its own 300 ms.
    expect(run([key("tab", 1_400), key("up", 1_400), enter(1_400)], late).effects).toEqual([{ type: "approve", cardId: "a", how: "enter" }])
  })

  test("after the frame comes back from a window too small to draw, Enter's 300 ms starts over on every card", () => {
    const back: UiAction = { type: "shown", now: 9_000 }
    expect(run([back, enter(9_100)], c).effects).toEqual([])
    expect(run([back, enter(9_000 + APPROVE_AFTER_MS)], c).effects).toEqual([{ type: "approve", cardId: "b", how: "enter" }])
  })

  test("a Build card that opened while the person typed in the harness doesn't hold the keys until it's taken, and then waits its 300 ms", () => {
    const build = ctx({ cards: [{ ...card("a"), origin: { role: "build" } } as ViewCard], seenAt: { a: 0 } })
    const typing = run([{ type: "openBuildCard", cardId: "a", typing: true, now: 0 }], build)
    expect(typing.state.overlay).toEqual({ kind: "card", cardId: "a", build: true, waiting: true })
    const taken = run([{ type: "takeBuildCard", now: 5_000 }], build, typing.state)
    expect(taken.state.overlay).toEqual({ kind: "card", cardId: "a", build: true })
    expect(run([enter(5_100)], build, taken.state).effects).toEqual([])
    expect(run([enter(5_000 + APPROVE_AFTER_MS)], build, taken.state).effects).toEqual([{ type: "approve", cardId: "a", how: "enter" }])
    // Not typing: it opens with the keys, as ever.
    expect(run([{ type: "openBuildCard", cardId: "a", now: 0 }], build).state.overlay).toEqual({ kind: "card", cardId: "a", build: true })
  })

  test("a card the user moved to is the one Enter approves", () => {
    const r = run([key("tab", 2_000), key("up", 2_000), enter(2_000)], c)
    expect(r.state.focus).toBe("cards")
    expect(r.effects).toEqual([{ type: "approve", cardId: "a", how: "enter" }])
  })

  test("ctrl-n rejects the highlighted card from anywhere, with text on the line too", () => {
    expect(run([ctrl("n", 2_000)], c).effects).toEqual([{ type: "reject", cardId: "b" }])
    expect(run([key("tab", 2_000), key("up", 2_000), ctrl("n", 2_000)], c).effects).toEqual([{ type: "reject", cardId: "a" }])
    const typed = run([...type("hold", 2_000), ctrl("n", 2_000)], c)
    expect(typed.effects).toEqual([{ type: "reject", cardId: "b" }])
    expect(typed.state.input).toBe("hold")
    expect(run([ctrl("n", 2_000)]).effects).toEqual([])
  })

  test("n, r and ? are letters, even with a card highlighted: a stray r became an agent turn", () => {
    const typing = run([key("down", 2_000), key("n", 2_000), key("r", 2_000)], { ...c, requotable: "a" })
    expect(typing.effects).toEqual([])
    expect(typing.state.input).toBe("nr")
    // ? on an empty line is help, wherever the focus is; with text on the line it's a character.
    expect(run([key("down", 2_000), key("?", 2_000)], c).state.overlay).toEqual({ kind: "help" })
    expect(run([...type("why?", 2_000)], c).state.input).toBe("why?")
  })

  test("ctrl-o opens the highlighted card's details; ctrl-r re-quotes the newest expired card", () => {
    expect(run([ctrl("o", 2_000)], c).state.overlay).toEqual({ kind: "card", cardId: "b" })
    expect(run([ctrl("r", 2_000)], { ...c, requotable: "x" }).effects).toEqual([{ type: "requote", cardId: "x" }])
    expect(run([ctrl("r", 2_000)], c).effects).toEqual([])
  })

  test("funds out to a new address: Enter approves nothing and says why; only a click does", () => {
    const fresh: ViewCard = { ...card("n"), kind: "funds-out", display: { ...card("n").display, newAddress: "NewA ddr2 2222" } }
    const n = ctx({ cards: [fresh], seenAt: { n: 0 } })
    const r = run([enter(2_000)], n)
    expect(r.effects).toEqual([])
    expect(r.state.message?.text).toContain("click yes, a new address")
    expect(run([{ type: "clickApprove", cardId: "n", now: 2_000 }], n).effects).toEqual([{ type: "approve", cardId: "n", how: "click" }])
  })

  test("a click on approve keeps the 300 ms rule; a click on reject doesn't need it", () => {
    expect(run([{ type: "clickApprove", cardId: "b", now: 1_050 }], c).effects).toEqual([])
    expect(run([{ type: "clickApprove", cardId: "b", now: 1_400 }], c).effects).toEqual([{ type: "approve", cardId: "b", how: "click" }])
    expect(run([{ type: "clickReject", cardId: "a", now: 0 }], c).effects).toEqual([{ type: "reject", cardId: "a" }])
  })

  test("a double click on a Build card's approve or reject acts only on it: the close starts the 300 ms again", () => {
    const build: ViewCard = { ...card("cb"), origin: { role: "build" } } as ViewCard
    const both = ctx({ cards: [card("c1"), build], seenAt: { c1: 0, cb: 4_000 } })
    const open = run([{ type: "openBuildCard", cardId: "cb", now: 5_000 }], both)
    // The first half of the double click approves the Build card and closes it over the frame.
    const first = run([{ type: "clickApprove", cardId: "cb", now: 5_000 }], both, open.state)
    expect(first.effects).toEqual([{ type: "approve", cardId: "cb", how: "click" }])
    expect(first.state.overlay).toBeUndefined()
    expect(first.state.shownSince).toBe(5_000)
    // The second half, 120 ms later, lands on the live card that waited beneath: it approves and rejects nothing.
    expect(run([{ type: "clickApprove", cardId: "c1", now: 5_120 }], both, first.state).effects).toEqual([])
    expect(run([{ type: "clickReject", cardId: "c1", now: 5_120 }], both, first.state).effects).toEqual([])
    expect(run([enter(5_120)], both, first.state).effects).toEqual([])
    // Past the 300 ms, a click on the card beneath is the person's own.
    expect(run([{ type: "clickApprove", cardId: "c1", now: 5_000 + APPROVE_AFTER_MS }], both, first.state).effects).toEqual([{ type: "approve", cardId: "c1", how: "click" }])
    // A reject closes it the same way, and its second half rejects nothing either.
    const shut = run([{ type: "clickReject", cardId: "cb", now: 5_000 }], both, open.state)
    expect(shut.effects).toEqual([{ type: "reject", cardId: "cb" }])
    expect(shut.state.overlay).toBeUndefined()
    expect(run([{ type: "clickReject", cardId: "c1", now: 5_120 }], both, shut.state).effects).toEqual([])
    expect(run([{ type: "clickApprove", cardId: "c1", now: 5_120 }], both, shut.state).effects).toEqual([])
  })
})

describe("the kill switch", () => {
  test("ctrl-x twice within a second kills; the first press only arms it, and says so", () => {
    const first = run([ctrl("x", 0)])
    expect(first.effects).toEqual([])
    expect(first.state.message?.text).toBe("ctrl-x again to kill")
    expect(run([ctrl("x", 0), ctrl("x", KILL_WINDOW_MS)]).effects).toEqual([{ type: "kill" }])
  })

  test("a second press after the window only arms it again", () => {
    expect(run([ctrl("x", 0), ctrl("x", KILL_WINDOW_MS + 1)]).effects).toEqual([])
  })

  test("any other key between the two cancels it, and the tick clears the prompt", () => {
    expect(run([ctrl("x", 0), ctrl("c", 100), ctrl("x", 200)]).effects).toEqual([])
    expect(run([ctrl("x", 0), key("v", 100), ctrl("x", 200)]).effects).toEqual([])
    const ticked = run([ctrl("x", 0), { type: "tick", now: KILL_WINDOW_MS + 1 }])
    expect(ticked.state.killArmedAt).toBeUndefined()
    expect(ticked.state.message).toBeUndefined()
  })

  test("it works over an overlay, and typing kill or clicking kill is one action", () => {
    const helpOpen = run([key("?"), ctrl("x", 10), ctrl("x", 20)])
    expect(helpOpen.effects).toEqual([{ type: "kill" }])
    expect(helpOpen.state.overlay).toBeUndefined()
    expect(run([...type("kill"), enter()]).effects).toEqual([{ type: "kill" }])
    expect(run([{ type: "clickKill", now: 0 }]).effects).toEqual([{ type: "kill" }])
  })
})

describe("quitting", () => {
  test("ctrl-c clears a line with text; on an empty line, twice within a second quits", () => {
    const cleared = run([...type("buy 0.1"), ctrl("c", 10)])
    expect(cleared.state.input).toBe("")
    expect(cleared.effects).toEqual([])
    expect(run([ctrl("c", 0)]).effects).toEqual([])
    expect(run([ctrl("c", 0), ctrl("c", 500)]).effects).toEqual([{ type: "quit" }])
    expect(run([ctrl("c", 0), ctrl("c", 1_500)]).effects).toEqual([])
  })
})

describe("modes and agents", () => {
  test("switching to live asks once; y switches, anything else stays", () => {
    const paper = ctx({ mode: "paper" })
    const asked = run([...type("live"), enter()], paper)
    expect(asked.state.overlay).toEqual({ kind: "confirmLive" })
    expect(asked.effects).toEqual([])
    expect(run([...type("live"), enter(), key("y")], paper).effects).toEqual([{ type: "mode", mode: "live" }])
    const stayed = run([...type("live"), enter(), key("return")], paper)
    expect(stayed.effects).toEqual([])
    expect(stayed.state.message?.text).toBe("Staying in paper mode.")
    // The status bar's mode is the same question.
    expect(run([{ type: "clickMode", now: 0 }], paper).state.overlay).toEqual({ kind: "confirmLive" })
  })

  test("switching to paper doesn't ask", () => {
    expect(run([...type("paper"), enter()]).effects).toEqual([{ type: "mode", mode: "paper" }])
    expect(run([{ type: "clickMode", now: 0 }]).effects).toEqual([{ type: "mode", mode: "paper" }])
  })

  test("the agent picker, by click then keys, and the agent command", () => {
    expect(run([{ type: "clickAgent", now: 0 }, key("down"), enter()]).effects).toEqual([{ type: "setAgent", agent: "swing" }])
    expect(run([...type("agent swing"), enter()]).effects).toEqual([{ type: "setAgent", agent: "swing" }])
  })
})

describe("the input line", () => {
  test("a typed live buy becomes a trade command for the core", () => {
    expect(run([...type("buy 0.1 sol MOON"), enter()]).effects).toEqual([
      { type: "command", command: { kind: "trade", tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.1", quoteAsset: "sol" }, echo: "buy 0.1 sol MOON" }, line: "buy 0.1 sol MOON" },
    ])
  })

  test("a refused command says why and sends nothing", () => {
    const r = run([...type("buy 0.1 sol MOON as ghost"), enter()])
    expect(r.effects).toEqual([])
    expect(r.state.message).toMatchObject({ level: "error", text: expect.stringContaining("No agent named ghost") })
    // An error stays 20 s, a notice 6 s (an over-limit refusal was gone before it was read).
    const tick = (now: number): UiAction => ({ type: "tick", now })
    expect(run([...type("buy 0.1 sol MOON as ghost"), enter(), tick(MESSAGE_MS + 1)]).state.message?.level).toBe("error")
    expect(run([...type("buy 0.1 sol MOON as ghost"), enter(), tick(ERROR_MESSAGE_MS + 1)]).state.message).toBeUndefined()
  })

  test("a typed trade with a name nobody has shown stays on the line, says why, and sends nothing", () => {
    const r = run([...type("sell 100% WOOF"), enter()])
    expect(r.effects).toEqual([])
    expect(r.state.input).toBe("sell 100% WOOF")
    expect(r.state.message).toMatchObject({ level: "error", text: expect.stringContaining("WOOF isn't a token this session has shown") })
  })

  test("a typed CLI line the core refuses goes back on the line, unless the user has typed since", () => {
    const line = "candle vault transfer VaultLook1 --amount 0.01 --asset SOL --from cold"
    const sent = run([...type(line), enter()])
    expect(sent.state.input).toBe("")
    expect(sent.effects).toEqual([{ type: "command", command: { kind: "cli", argv: ["vault", "transfer", "VaultLook1", "--amount", "0.01", "--asset", "SOL", "--from", "cold"] }, line }])
    const refused = run([{ type: "message", text: "looks like your vault key, but isn't it. Nothing was run.", level: "error", now: 0, restore: line }], ctx(), sent.state)
    expect(refused.state).toMatchObject({ input: line, cursor: line.length, message: { level: "error" } })
    const typedSince = run([...type("hi"), { type: "message", text: "refused", level: "error", now: 0, restore: line }], ctx(), sent.state)
    expect(typedSince.state.input).toBe("hi")
    // An agent message carries no line: it's the agent's turn, never put back.
    expect(run([...type("what's moving?"), enter()]).effects).toEqual([{ type: "command", command: { kind: "agent", text: "what's moving?" } }])
  })

  test("the prompt pane opening clears an info message about its step, and leaves an error", () => {
    const info = run([{ type: "message", text: "that's a new address, so it's a card. Check it in full, then click yes, a new address.", level: "info", now: 0 }, { type: "paneOpened" }])
    expect(info.state.message).toBeUndefined()
    const error = run([{ type: "message", text: "refused", level: "error", now: 0 }, { type: "paneOpened" }])
    expect(error.state.message).toMatchObject({ level: "error", text: "refused" })
  })

  test("a chip that fills the input line puts its text there for the user to send, and sends nothing (the kill report's tee disable)", () => {
    const r = run([...type("half typed"), { type: "clickFill", text: "candle tee disable Tee1 as momentum", now: 0 }])
    expect(r.state).toMatchObject({ input: "candle tee disable Tee1 as momentum", cursor: "candle tee disable Tee1 as momentum".length })
    expect(r.effects).toEqual([])
  })

  test("ctrl-t, or the refusal's chip, sends a line refused for an unknown name to the agent as typed", () => {
    const r = run([...type("Buy $1 of WOOF."), enter()])
    expect(r.state.message).toMatchObject({ level: "error", ask: "Buy $1 of WOOF." })
    const asked = run([...type("Buy $1 of WOOF."), enter(), key("t", 0, { ctrl: true })])
    expect(asked.effects).toEqual([{ type: "command", command: { kind: "agent", text: "Buy $1 of WOOF." } }])
    expect(asked.state).toMatchObject({ input: "", message: undefined })
    expect(run([...type("Buy $1 of WOOF."), enter(), { type: "clickAsk", now: 0 }]).effects).toEqual(asked.effects)
    // Edited since, the line stays; the refused line is what goes.
    const edited = run([...type("Buy $1 of WOOF."), enter(), ...type("x"), key("t", 0, { ctrl: true })])
    expect(edited.state.input).toBe("Buy $1 of WOOF.x")
    // Nothing on offer: ctrl-t does nothing, and other refusals don't offer it.
    expect(run([key("t", 0, { ctrl: true })]).effects).toEqual([])
    const other = run([...type("buy $12.505 MOON"), enter()])
    expect(other.state.message?.ask).toBeUndefined()
    expect(run([...type("buy $12.505 MOON"), enter(), key("t", 0, { ctrl: true })]).effects).toEqual([])
  })

  test("a paste is text on the line, never a sent command", () => {
    const r = run([{ type: "paste", text: "buy 0.1 sol MOON\nkill\n", now: 0 }])
    expect(r.state.input).toBe("buy 0.1 sol MOON kill ")
    expect(r.effects).toEqual([])
  })

  test("a paste joins an address broken across a terminal's wrap, and nothing else", () => {
    const mint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
    const r = run([{ type: "paste", text: `should I buy $1 of ${mint.slice(0, 40)}\n${mint.slice(40)} today?`, now: 0 }])
    expect(r.state.input).toBe(`should I buy $1 of ${mint} today?`)
    // Terminal.app sends the break as a bare \r, and Windows-style text as \r\n.
    expect(run([{ type: "paste", text: `buy $1 of ${mint.slice(0, 34)}\r${mint.slice(34)}`, now: 0 }]).state.input).toBe(`buy $1 of ${mint}`)
    expect(joinWrappedAddresses(`${mint.slice(0, 20)}\r\n${mint.slice(20)}`)).toBe(mint)
    // Two whole addresses, or words, on their own lines stay apart.
    expect(joinWrappedAddresses(`${mint}\n${mint}`)).toBe(`${mint}\n${mint}`)
    expect(joinWrappedAddresses("buy JUP\nsell BONK")).toBe("buy JUP\nsell BONK")
  })

  test("with text on the line, the arrows move the cursor; editing works there", () => {
    const r = run([...type("buy 0.1 MOON"), key("left"), key("left"), key("left"), key("left"), ...type("sol "), key("end"), key("backspace")])
    expect(r.state.input).toBe("buy 0.1 sol MOO")
  })

  test("a digit picks a tab from the tab bar; on the line it types, even with the line empty", () => {
    // Up from the agent pane is the tab bar.
    expect(run([key("up")]).state.focus).toBe("tabs")
    const fromBar = run([key("up"), key("2")])
    expect(fromBar.state.tab).toBe(1)
    expect(fromBar.state.input).toBe("")
    // "2 SOL of…" on an empty line, the agent pane focused: it types.
    const typed = run([key("2")])
    expect(typed.state.tab).toBe(0)
    expect(typed.state.input).toBe("2")
    // A fresh install shows five tabs: 5 is the last, and 9 picks nothing.
    expect(run([key("up"), key("5")]).state.tab).toBe(4)
    expect(run([key("up"), key("9")]).state.tab).toBe(0)
  })
})

describe("a burst of keys", () => {
  test("lands from the last state, however fast it arrives", () => {
    const c = ctx({ cards: [card("a"), card("b"), card("c")], seenAt: { a: 0, b: 0, c: 0 } })
    // Down into the cards, then up twice and down once, all at the same instant.
    const r = run([key("down", 5), key("up", 5), key("up", 5), key("down", 5)], c)
    expect(r.state.focus).toBe("cards")
    expect(r.state.focusedCardId).toBe("b")
  })
})

test("the numpad's Enter is Enter: it sends the line, and approves on an empty one after 300 ms", () => {
  const sent = run([...type("hello"), key("kpenter", 10)])
  expect(sent.effects).toEqual([{ type: "command", command: { kind: "agent", text: "hello" } }])
  const c = ctx({ cards: [card("c1")], seenAt: { c1: 0 } })
  expect(run([key("kpenter", 100)], c).effects).toEqual([])
  expect(run([key("kpenter", APPROVE_AFTER_MS + 1)], c).effects).toEqual([{ type: "approve", cardId: "c1", how: "enter" }])
})

describe("stopping a turn", () => {
  test("Esc on an empty line stops the active agent's turn; with text typed, or nothing running, it doesn't", () => {
    const working = ctx({ activeAgent: "agent-b", working: true })
    expect(run([key("escape")], working).effects).toEqual([{ type: "stopTurn", agent: "agent-b" }])
    expect(run([...type("wait"), key("escape")], working).effects).toEqual([])
    expect(run([key("escape")], ctx({ activeAgent: "agent-b" })).effects).toEqual([])
    // A message waiting behind the turn is named only when there is one.
    expect(run([key("escape")], working).state.message?.text).toBe("Stopping agent-b's turn.")
    expect(run([key("escape")], ctx({ activeAgent: "agent-b", working: true, queuedBehind: true })).state.message?.text).toBe("Stopping agent-b's turn; the message waiting behind it runs next.")
  })
  test("sending a message scrolls the agent pane back to the newest, so it shows at once", () => {
    const r = run([...type("is it in?"), enter()], ctx({ activeAgent: "agent-b" }), { ...INITIAL_UI, scroll: { agent: { rows: 30 } } })
    expect(scrollOf(r.state, "agent")).toBe(0)
  })
})

describe("every pane scrolls", () => {
  const on = (focus: UiState["focus"]): UiState => ({ ...INITIAL_UI, focus })
  const scroll = (pane: PaneId, delta: number): UiAction => ({ type: "scroll", pane, delta, now: 0 })

  test("Activity scrolls up from its newest with PgUp and PgDn, anchored on its newest line", () => {
    const c = ctx({ scrolls: { activity: { max: 40, newest: "30", since: 0 } } })
    expect(run([key("pageup")], c, on("activity")).state.scroll.activity).toEqual({ rows: 10, anchor: "30" })
    expect(run([key("pageup"), key("pagedown"), key("pagedown")], c, on("activity")).state.scroll).toEqual({})
    expect(run([scroll("activity", 3)], c).state.scroll.activity).toEqual({ rows: 3, anchor: "30" })
  })

  test("a list scrolls down from its first: PgDn and the wheel down move into it, PgUp back", () => {
    const c = ctx({ scrolls: { positions: { max: 6 }, wallets: { max: 2 } } })
    expect(scrollOf(run([key("pagedown")], c, on("positions")).state, "positions")).toBe(6)
    expect(run([key("pagedown"), key("pageup")], c, on("positions")).state.scroll).toEqual({})
    expect(run([scroll("wallets", -3)], c).state.scroll.wallets).toEqual({ rows: 2 })
    // Up from its first row, a list stays there.
    expect(run([scroll("wallets", 3)], c).state.scroll).toEqual({})
  })

  test("never past what the pane holds as last drawn; the conversation too", () => {
    const c = ctx({ scrolls: { agent: { max: 4 }, token: { max: 0 } } })
    expect(scrollOf(run([key("pageup")], c).state, "agent")).toBe(4)
    expect(run([key("pagedown")], c, on("token")).state.scroll).toEqual({})
    // The cards and the tab bar don't scroll.
    expect(run([key("pageup")], c, on("cards")).state.scroll).toEqual({})
  })

  test("a scrolled tail pane counts the lines that arrived since its anchor, and anchors on the newest again", () => {
    // Scrolled 3 up from line 20; five lines have arrived since. The wheel down 3 leaves it 5 up from the newest, 30.
    const c = ctx({ scrolls: { activity: { max: 40, newest: "30", since: 5 } } })
    const start = { ...INITIAL_UI, scroll: { activity: { rows: 3, anchor: "20" } } }
    expect(run([scroll("activity", -3)], c, start).state.scroll.activity).toEqual({ rows: 5, anchor: "30" })
    expect(run([scroll("activity", -8)], c, start).state.scroll).toEqual({})
  })

  test("each pane keeps its own scroll, whichever has focus", () => {
    const c = ctx({ scrolls: { activity: { max: 40, newest: "9", since: 0 }, positions: { max: 9 } } })
    const r = run([scroll("activity", 6), scroll("positions", -3), key("tab")], c)
    expect(r.state.scroll).toEqual({ activity: { rows: 6, anchor: "9" }, positions: { rows: 3 } })
  })
})

describe("focus by pane id", () => {
  const narrow = ctx({ panes: paneNav(place(AGENT_FIRST, { x: 0, y: 2, w: 80, h: 18 })) })
  const focusAfter = (actions: UiAction[], c: UiContext = ctx()) => run(actions, c).state.focus

  test("Tab goes round the layout: the tab bar, the agent, its cards when any wait, then each pane of the column", () => {
    const tabs = (n: number, c: UiContext = ctx()) => focusAfter(Array.from({ length: n }, () => key("tab")), c)
    expect([1, 2, 3, 4, 5, 6].map((n) => tabs(n))).toEqual(["token", "positions", "wallets", "activity", "tabs", "agent"])
    const withCards = ctx({ cards: [card("a")] })
    expect([1, 2, 6].map((n) => tabs(n, withCards))).toEqual(["cards", "token", "tabs"])
    expect(focusAfter([key("tab", 0, { shift: true })])).toBe("tabs")
    expect(focusAfter([key("tab", 0, { shift: true }), key("tab", 0, { shift: true })])).toBe("activity")
    // Collapsed, the switched pane is one stop: the one it shows.
    expect([1, 2, 3].map((n) => tabs(n, narrow))).toEqual(["token", "tabs", "agent"])
  })

  test("→ from the agent goes to the side pane last focused; ↑/↓ step down the column; ← comes back", () => {
    expect(focusAfter([key("right")])).toBe("token")
    expect(focusAfter([key("right"), key("down"), key("down")])).toBe("wallets")
    expect(focusAfter([key("right"), key("down"), key("down"), key("left"), key("right")])).toBe("wallets")
    expect(focusAfter([key("right"), key("up")])).toBe("tabs")
    expect(focusAfter([key("right"), ...Array.from({ length: 5 }, () => key("down"))])).toBe("activity")
    expect(focusAfter([{ type: "clickPane", pane: "positions", now: 0 }, key("left"), key("right")])).toBe("positions")
  })

  test("collapsed, ←/→ switch the shown pane, and ← from the first goes back to the agent", () => {
    const r = run([key("right"), key("right"), key("right")], narrow)
    expect(r.state.focus).toBe("wallets")
    expect(shownOf(narrow.panes!.group, r.state.recent)).toBe("wallets")
    expect(run([key("right"), key("left")], narrow).state.focus).toBe("agent")
    expect(run([key("right"), key("right"), key("left"), key("left")], narrow).state.focus).toBe("agent")
    // Back in the agent pane, the switched pane still shows what it last showed.
    const back = run([key("right"), key("right"), key("right"), key("escape")], narrow)
    expect(back.state.focus).toBe("agent")
    expect(shownOf(narrow.panes!.group, back.state.recent)).toBe("wallets")
    expect(run([key("right"), key("right"), key("up")], narrow).state.focus).toBe("tabs")
  })

  test("Esc, a click on the agent pane, and ↓ from the tab bar focus the agent", () => {
    expect(focusAfter([key("right"), key("escape")])).toBe("agent")
    expect(focusAfter([key("right"), { type: "clickPane", pane: "agent", now: 0 }])).toBe("agent")
    expect(focusAfter([key("up"), key("down")])).toBe("agent")
  })
})

describe("linked panes: picking a row's token", () => {
  const JUP = "JupFake111111111111111111111111111111111111"
  const BONK = "BonkFake11111111111111111111111111111111111"
  const rows = [
    { id: "w:moon", mint: MOON, line: 1 },
    { id: "w:jup", mint: JUP, line: 2 },
    { id: "w:bonk", mint: BONK, line: 3 },
  ]
  const on = (focus: UiState["focus"], over: Partial<UiState> = {}): UiState => ({ ...INITIAL_UI, focus, ...over })
  const c = ctx({ picks: { positions: rows }, scrolls: { positions: { max: 0, start: 0, rows: 6, total: 4 } } })
  const tick = (now: number): UiAction => ({ type: "tick", now })

  test("↓ in a pane with token rows highlights the first in view, then the next; the link waits until the highlight has rested 300 ms", () => {
    const moved = run([key("down", 0), key("down", 100)], c, on("positions"))
    expect(moved.state.focus).toBe("positions")
    expect(moved.state.highlight?.positions).toMatchObject({ id: "w:jup", mint: JUP, at: 100 })
    expect(moved.effects.filter((e) => e.type === "link")).toEqual([])
    expect(moved.effects).toContainEqual({ type: "wake", afterMs: 300 })
    // A tick before it has rested sends nothing; after, the one link.
    expect(run([tick(399)], c, moved.state).effects).toEqual([])
    const settled = run([tick(400), tick(700)], c, moved.state)
    expect(settled.effects).toEqual([{ type: "link", mint: JUP, from: "positions, by the arrows" }])
  })

  test("a run of arrows sends one link, for the row it ended on", () => {
    const burst = run([key("down", 0), key("down", 50), key("down", 100), key("up", 150), tick(500)], c, on("positions"))
    expect(burst.effects.filter((e) => e.type === "link")).toEqual([{ type: "link", mint: JUP, from: "positions, by the arrows" }])
  })

  test("past the first row ↑ moves to the pane above, and past the last ↓ to the pane below, as in a pane without rows", () => {
    const top = run([key("down"), key("up")], c, on("positions"))
    expect(top.state.focus).toBe("token")
    const bottom = run([key("down"), key("down"), key("down"), key("down")], c, on("positions"))
    expect(bottom.state.focus).toBe("wallets")
    expect(bottom.state.highlight?.positions?.id).toBe("w:bonk")
  })

  test("a tail pane (Activity) starts at its newest, at its foot", () => {
    const tail = ctx({ picks: { activity: rows }, scrolls: { activity: { max: 0, start: 0, rows: 6, total: 4 } } })
    expect(run([key("up")], tail, on("activity")).state.highlight?.activity?.id).toBe("w:bonk")
  })

  test("a highlight out of view scrolls the pane to it", () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, mint: MOON, line: i }))
    const cut = ctx({ picks: { positions: long }, scrolls: { positions: { max: 14, start: 0, rows: 6, total: 20 } } })
    const r = run(Array.from({ length: 7 }, () => key("down")), cut, on("positions"))
    expect(r.state.highlight?.positions?.id).toBe("r6")
    expect(r.state.scroll.positions).toEqual({ rows: 1 })
  })

  test("a click on a row picks it at once, and a click on a card picks the card's token", () => {
    const click = run([{ type: "clickRow", pane: "feed", pick: { id: BONK, mint: BONK }, now: 5 }], c)
    expect(click.state.focus).toBe("feed")
    expect(click.effects).toEqual([{ type: "link", mint: BONK, from: "feed, by a click" }])
    expect(run([tick(1_000)], c, click.state).effects).toEqual([])
    // A second click on the same row picks nothing new (not one pick and two journal rows).
    expect(run([{ type: "clickRow", pane: "feed", pick: { id: BONK, mint: BONK }, now: 400 }], c, click.state).effects).toEqual([])
    const withMint = { ...card("a"), display: { ...card("a").display, mint: JUP } }
    expect(run([{ type: "clickCard", cardId: "a", now: 0 }], ctx({ cards: [withMint] })).effects).toEqual([{ type: "link", mint: JUP, from: "a card" }])
  })

  test("Enter never picks: with Positions focused, a row highlighted and a card open, it approves the card", () => {
    const open = ctx({ ...c, cards: [card("a")], seenAt: { a: 0 } })
    const r = run([key("down", 1_000), key("down", 1_100), enter(1_200)], open, on("positions"))
    expect(r.effects.filter((e) => e.type === "approve")).toEqual([{ type: "approve", cardId: "a", how: "enter" }])
    expect(r.effects.filter((e) => e.type === "link")).toEqual([])
  })

  test("a pane without token rows: ↑/↓ step between panes as before", () => {
    expect(run([key("down")], c, on("wallets")).state.focus).toBe("activity")
  })
})

describe("pop-out", () => {
  const at = (focus: PaneId): UiState => ({ ...INITIAL_UI, focus, recent: [focus] })
  test("ctrl-p moves the focused pane out and focus to the agent; never the conversation, never twice", () => {
    const out = run([ctrl("p")], ctx(), at("wallets"))
    expect(out.effects).toEqual([{ type: "popOut", pane: "wallets" }])
    expect(out.state.focus).toBe("agent")
    for (const focus of ["agent", "cards"] as const) {
      const r = run([ctrl("p")], ctx(), { ...INITIAL_UI, focus })
      expect(r.effects).toEqual([])
      expect(r.state.message?.text).toContain("stay here")
    }
    const twice = run([ctrl("p")], ctx({ popped: ["wallets"] }), at("wallets"))
    expect(twice.effects).toEqual([])
    expect(twice.state.message?.text).toContain("popped out already")
    // Without the agent pane on the layout, focus goes to the tab bar.
    const nav = paneNav(place({ ...AGENT_FIRST, root: { dir: "row", weight: 1, children: [{ pane: "feed", weight: 1 }, { pane: "wallets", weight: 1 }] } }, { x: 0, y: 2, w: 140, h: 30 }))
    expect(run([ctrl("p")], ctx({ panes: nav }), at("wallets")).state.focus).toBe("tabs")
  })
  test("over an overlay, ctrl-p does nothing; the ⇱ chip pops the pane it's on", () => {
    const r = run([ctrl("p")], ctx(), { ...at("wallets"), overlay: { kind: "help" } })
    expect(r.effects).toEqual([])
    expect(run([{ type: "popOutPane", pane: "feed", now: 0 }], ctx(), at("positions")).effects).toEqual([{ type: "popOut", pane: "feed" }])
  })
})

test("the agent switching the tab on screen leaves focus where the person put it; a click on a tab moves it there", () => {
  const c = ctx({ tabs: ["Trade", "Cockpit", "Tape"] })
  const r = run([{ type: "showTab", tab: 2, now: 0 }], c, { ...INITIAL_UI, focus: "positions" })
  expect(r.state).toMatchObject({ tab: 2, focus: "positions" })
  expect(r.effects).toEqual([])
  expect(run([{ type: "showTab", tab: 9, now: 0 }], c).state.tab).toBe(2)
  expect(run([{ type: "clickTab", tab: 1, now: 0 }], c).state).toMatchObject({ tab: 1, focus: "tabs" })
})

test("the agent showing a pane or searching the Journal leaves focus where it was", () => {
  const c = ctx({ tabs: ["Trade", "Trending"] })
  const shown = run([{ type: "showPane", pane: "final-stretch", now: 0 }], c, { ...INITIAL_UI, focus: "positions", recent: ["new", "positions"] })
  expect(shown.state).toMatchObject({ focus: "positions", recent: ["final-stretch", "new", "positions"] })
  const lit = { ...INITIAL_UI, focus: "positions" as const, highlight: { journal: { id: "r1", mint: "r1", at: 0 } }, scroll: { journal: { rows: 4 } }, journal: { query: "old", kinds: ["hacc" as const] } }
  const searched = run([{ type: "journalSet", search: { query: "JUP sell" }, now: 0 }], c, lit)
  expect(searched.state).toMatchObject({ focus: "positions", journal: { query: "JUP sell" } })
  expect(searched.state.journal?.kinds).toBeUndefined()
  expect(searched.state.highlight?.journal).toBeUndefined()
  expect(searched.state.scroll.journal).toBeUndefined()
  // A search the person was typing in keeps taking keys.
  expect(run([{ type: "journalSet", search: { query: "JUP" }, now: 0 }], c, { ...INITIAL_UI, focus: "journal", journal: { query: "x", editing: true } }).state.journal).toEqual({ query: "JUP", editing: true })
})

describe("ctrl-t on a row asks the agent about it", () => {
  const JUP = "JupFake111111111111111111111111111111111111"
  const ask = "What do you make of JUP? From On Fire: +12.0% in the hour, $4.2M market cap."
  const rows = [
    { id: MOON, mint: MOON, line: 0, ask: "What do you make of MOON? From On Fire: +1.0% in the hour, $1.0M market cap." },
    { id: JUP, mint: JUP, line: 1, ask },
  ]
  const c = ctx({ picks: { feed: rows }, scrolls: { feed: { max: 0, start: 0, rows: 6, total: 2 } } })
  const on: UiState = { ...INITIAL_UI, focus: "feed" }

  test("it picks the highlighted row at once, as a click does, and puts its question on the line; nothing is sent", () => {
    const r = run([key("down", 0), key("down", 50), ctrl("t", 100)], c, on)
    expect(r.state.input).toBe(ask)
    expect(r.state.cursor).toBe(ask.length)
    // The pick goes at once (the agent's note carries the mint), and only once.
    expect(r.effects.filter((e) => e.type === "link")).toEqual([{ type: "link", mint: JUP, from: "feed, by ctrl-t" }])
    expect(r.effects.some((e) => e.type === "command")).toBe(false)
    expect(run([{ type: "tick", now: 1_000 }], c, r.state).effects).toEqual([])
    // Enter then sends the question to the agent.
    expect(run([enter(2_000)], c, r.state).effects).toEqual([{ type: "command", command: { kind: "agent", text: ask } }])
  })

  test("a highlight that has already become the link isn't sent again", () => {
    const rested = run([key("down", 0), key("down", 50), { type: "tick", now: 400 }], c, on)
    expect(rested.effects.filter((e) => e.type === "link")).toHaveLength(1)
    expect(run([ctrl("t", 500)], c, rested.state).effects).toEqual([])
  })

  test("the highlighted row's ask chip does the same", () => {
    const r = run([{ type: "clickAskRow", pane: "feed", id: JUP, now: 0 }], c)
    expect(r.state.focus).toBe("feed")
    expect(r.state.input).toBe(ask)
    expect(r.effects).toEqual([{ type: "link", mint: JUP, from: "feed, by ctrl-t" }])
  })

  test("no row highlighted: it says how, and a refused trade line keeps ctrl-t's own meaning", () => {
    expect(run([ctrl("t")], c, on).state.message?.text).toBe("↑/↓ to a row first: ctrl-t then puts a question about it on the line.")
    const refused: UiState = { ...on, highlight: { feed: { id: JUP, mint: JUP, at: 0, sent: true } }, input: "buy $5 of FOO", message: { text: "no FOO", level: "error", at: 0, ask: "buy $5 of FOO" } }
    expect(run([ctrl("t", 10)], c, refused).effects).toEqual([{ type: "command", command: { kind: "agent", text: "buy $5 of FOO" } }])
  })
})

test("settings ▾ → vault puts candle vault init on the line for the person to send, and runs nothing", () => {
  const r = run([{ type: "clickSettings", now: 0 }, { type: "pickSettings", index: SETTINGS.findIndex((s) => s.id === "vault"), now: 0 }])
  expect(r.effects).toEqual([])
  expect(r.state).toMatchObject({ input: "candle vault init", overlay: undefined, message: { text: expect.stringContaining("⏎ runs it in the pane") } })
})

describe("tabs ticked on and off in settings ▾", () => {
  const ticks = [
    { name: "Trade", shown: true },
    { name: "Perps", shown: false },
  ]
  const c = ctx({ tabTicks: ticks })
  test("the menu's rows go on to each tab's tick; picking one flips it and the menu stays for another", () => {
    const own = SETTINGS.length
    const opened = run([{ type: "clickSettings", now: 0 }, ...Array.from({ length: own + 2 }, () => key("down"))], c)
    // Its own rows (approvals, the vault, skills), then the two ticks: ↓ stops at the last.
    expect(opened.state.overlay).toEqual({ kind: "settings", index: own + 1 })
    const picked = run([enter()], c, opened.state)
    expect(picked.effects).toEqual([{ type: "layout", op: { kind: "tabShown", name: "Perps", shown: true } }])
    expect(picked.state.overlay).toEqual({ kind: "settings", index: own + 1 })
    expect(run([{ type: "pickSettings", index: own, now: 0 }], c).effects).toEqual([{ type: "layout", op: { kind: "tabShown", name: "Trade", shown: false } }])
  })
})

test("the list pane's ◂ ▸ go round Candle's four lists and Hacc's tape, On Fire first; the palette picks one where the pane's on the tab", () => {
  expect(run([{ type: "listsSource", delta: 1, now: 0 }]).state.lists).toBe("new")
  expect(run([{ type: "listsSource", delta: -1, now: 0 }]).state.lists).toBe("signals")
  expect(run([{ type: "listsSource", delta: 1, now: 0 }, { type: "listsSource", delta: 1, now: 0 }, { type: "listsSource", delta: 1, now: 0 }]).state.lists).toBe("finalstretch")
  const nav = { order: ["token", "lists", "agent"] as const, group: [] as const, rects: {} }
  const rows = paletteFound(INITIAL_UI, ctx({ panes: { ...nav, order: [...nav.order], group: [] } }), "final stretch").filter((r) => r.id.startsWith("lists:"))
  expect(rows.map((r) => r.label)).toContain("pick from Final Stretch")
  expect(paletteFound(INITIAL_UI, ctx(), "final stretch").some((r) => r.id.startsWith("lists:"))).toBe(false)
})
