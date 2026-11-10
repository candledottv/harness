// The palette: ctrl-k, searched together, every action,
// tab, layout, pane, agent, preset, memory, token and Candle command. Picking a row does what its key or
// click does; a Candle command only puts a request on the input line (`?` then `c` opens the palette
// there), and no row approves a card. The Candle rows are the commands pane's.
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { CATALOGUE } from "../core/cli-catalogue"
import type { CoreEventParams } from "../core/client"
import { App, type Session } from "./app"
import { parseCommand } from "../shared/commands"
import { type Effect, INITIAL_UI, type Key, paletteFound, SETTINGS, step, type UiAction, type UiContext, type UiState } from "./keys"
import { AGENT_FIRST, COCKPIT } from "./layout"
import type { LayoutInfo } from "./layout-menu"
import { whenLabel } from "./palette"
import type { ViewCard } from "./store"

const LAYOUT: LayoutInfo = { tab: "Trade", current: AGENT_FIRST, names: [AGENT_FIRST.name, COCKPIT.name], preset: true, path: "/h/layouts.toml", problems: [], tabNames: ["Trade", "Cockpit"] }
const MOON = "MoonMint1111111111111111111111111111111111"

function ctx(over: Partial<UiContext> = {}): UiContext {
  return {
    cards: [],
    seenAt: {},
    mode: "live",
    agents: ["momentum", "scout"],
    activeAgent: "momentum",
    commands: { agents: ["momentum", "scout"], knownTokens: new Map([["MOON", MOON], ["SOL", "So11111111111111111111111111111111111111112"]]) },
    tabs: ["Trade", "Cockpit"],
    layout: LAYOUT,
    presets: { momentum: "quant", scout: "trader" },
    pin: { pinned: false, symbol: "MOON" },
    ...over,
  }
}

function run(actions: UiAction[], start: UiState = INITIAL_UI, c: UiContext = ctx()): { state: UiState; effects: Effect[] } {
  let state = start
  const effects: Effect[] = []
  for (const a of actions) {
    const r = step(state, a, c)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}
const key = (name: string, extra: Partial<Key> = {}): UiAction => ({ type: "key", key: { name, sequence: name.length === 1 ? name : undefined, ...extra }, now: 0 })
const ctrl = (name: string): UiAction => key(name, { ctrl: true, sequence: undefined })
const type = (text: string): UiAction[] => [...text].map((ch) => ({ type: "key", key: { name: ch === " " ? "space" : ch, sequence: ch }, now: 0 }))
const open = [key("?"), key("c")]
/** What the palette finds for a search, in order. */
const found = (query: string, c: UiContext = ctx()) => paletteFound(INITIAL_UI, c, query)
const firstCli = () => found("").findIndex((r) => r.cli)

describe("the palette's keys", () => {
  test("ctrl-k opens it from anywhere and closes it again; over another overlay it takes its place", () => {
    expect(run([ctrl("k")]).state.overlay).toEqual({ kind: "palette", query: "", index: 0 })
    expect(run([ctrl("k"), ctrl("k")]).state.overlay).toBeUndefined()
    expect(run([key("?"), ctrl("k")]).state.overlay).toMatchObject({ kind: "palette" })
    expect(run([...type("buy 1"), ctrl("k")]).state).toMatchObject({ overlay: { kind: "palette" }, input: "buy 1" })
  })

  test("? then c opens it at Candle's commands; any other key still closes help", () => {
    expect(firstCli()).toBeGreaterThan(0)
    expect(run(open).state.overlay).toEqual({ kind: "palette", query: "", index: firstCli() })
    expect(run([key("?"), key("x")]).state.overlay).toBeUndefined()
  })

  test("typing searches, and the arrows move through what it found", () => {
    const { state } = run([ctrl("k"), ...type("keys revoke")])
    expect(state.overlay).toEqual({ kind: "palette", query: "keys revoke", index: 0 })
    expect(run([ctrl("k"), key("down"), key("down"), key("up")]).state.overlay).toMatchObject({ index: 1 })
    expect(run([ctrl("k"), key("up")]).state.overlay).toMatchObject({ index: 0 })
    expect(run([ctrl("k"), ...type("revokx"), key("backspace"), key("e")]).state.overlay).toMatchObject({ query: "revoke", index: 0 })
    expect(run([ctrl("k"), { type: "paste", text: "lp\npools", now: 0 }]).state.overlay).toMatchObject({ query: "lp pools" })
  })

  test("Enter on a Candle command puts the request on the input line, closes it and runs nothing", () => {
    const { state, effects } = run([...open, ...type("keys revoke"), key("return")])
    expect(state.overlay).toBeUndefined()
    expect(state.input).toBe("revoke an API key permanently ")
    expect(state.cursor).toBe(state.input.length)
    expect(effects).toEqual([])
    // The next Enter sends it to the agent: it never approves a card.
    expect(run([key("return")], state).effects).toEqual([{ type: "command", command: { kind: "agent", text: "revoke an API key permanently" } }])
  })

  test("a pasted mint or 0x address is the one row, and Enter opens it in the token pane, trading nothing", () => {
    const mint = "4yxnPMCxgXWRYbFxnFzMr7bLPm9YWcCrhZWhdsXspump"
    expect(found(mint).map((r) => r.label)).toEqual(["open 4yxn…pump"])
    expect(found(MOON)[0]!.label).toBe(`open MOON · ${MOON.slice(0, 4)}…${MOON.slice(-4)}`)
    const { state, effects } = run([ctrl("k"), ...type(mint), key("return")])
    expect(state.overlay).toBeUndefined()
    expect(effects).toEqual([{ type: "link", mint, from: "the palette" }])
    const hood = `0x${"ab12".repeat(10)}`
    expect(run([ctrl("k"), ...type(hood), key("return")]).effects).toEqual([{ type: "link", mint: hood, chain: "hood", from: "the palette" }])
  })

  test("a command the agent never runs puts nothing on the line, and says why", () => {
    const { state, effects } = run([...open, ...type("completion zsh"), key("return")])
    expect(state.input).toBe("")
    expect(state.message?.text).toContain("Shell setup")
    expect(effects).toEqual([])
  })

  test("Enter on an empty search result, and esc, close it with nothing on the line", () => {
    expect(run([ctrl("k"), ...type("zzzz"), key("return")]).state).toMatchObject({ overlay: undefined, input: "" })
    expect(run([ctrl("k"), key("escape")]).state).toMatchObject({ overlay: undefined, input: "" })
  })

  test("the settings menu opens by keys: its row is the first found for settings, and Enter opens the menu the tab bar's chip does", () => {
    const r = run([ctrl("k"), ...type("settings"), key("return")])
    expect(r.state.overlay).toEqual({ kind: "settings", index: 0 })
    expect(r.effects).toEqual([])
  })

  test("the kill switch still works over it", () => {
    expect(run([ctrl("k"), ctrl("x"), ctrl("x")]).effects).toEqual([{ type: "kill" }])
  })

  test("every Candle request goes to the agent as plain English, never as a typed command", () => {
    for (const e of CATALOGUE.filter((e) => e.request)) {
      expect(`${e.path}: ${parseCommand(e.request!, ctx().commands)?.kind}`).toBe(`${e.path}: agent`)
    }
  })
})

describe("the palette's rows", () => {
  test("sections in order, then Candle's commands in the CLI's groups", () => {
    const sections = [...new Set(found("").map((r) => r.section))]
    expect(sections.slice(0, 14)).toEqual(["Actions", "Tabs", "Layouts", "Panes", "Agents", "Presets", "Model", "Memory", "Triggers", "Build", "P&L", "Journal", "Tokens", "Aliases"])
    expect(sections.slice(14).every((s) => s.startsWith("candle · "))).toBe(true)
    expect(found("").filter((r) => r.cli).length).toBe(CATALOGUE.length)
  })

  test("the Journal's row opens its search line, on the tab on screen or on the Journal's own", () => {
    expect(found("journal")[0]).toMatchObject({ section: "Journal", label: "search the journal" })
    const eight = ctx({ tabs: ["Trade", "Cockpit", "Trending", "Signals", "P&L", "Research", "Journal", "Perps"] })
    const there = run([ctrl("k"), ...type("search the journal"), key("return")], INITIAL_UI, eight)
    expect(there.state.focus).toBe("journal")
    expect(there.state.journal?.editing).toBe(true)
    expect(there.state.tab).toBe(6)
    // No tab shows it: it says how to show one.
    expect(run([ctrl("k"), ...type("search the journal"), key("return")]).state.message?.text).toContain("No tab shows the Journal")
  })

  test("the preset and the memory are one step: their rows top the list for preset and memory", () => {
    expect(found("preset").slice(0, 6).map((r) => r.label)).toEqual(["Quant for momentum", "Trader for momentum", "Bare for momentum", "Quant for scout", "Trader for scout", "Bare for scout"])
    expect(found("memory")[0]).toMatchObject({ label: "momentum's memory", run: { kind: "memory", agent: "momentum" } })
    expect(found("mem")[0]?.section).toBe("Memory")
    expect(found("tok")[0]).toMatchObject({ section: "Tokens", label: "MOON" })
    // The preset on now says so, and picking it changes nothing.
    expect(found("quant for momentum")[0]).toMatchObject({ current: true, why: "momentum runs as Quant" })
    expect(run([ctrl("k"), ...type("trader for momentum"), key("return")]).effects).toEqual([{ type: "choosePreset", agent: "momentum", preset: "trader" }])
    expect(run([ctrl("k"), ...type("scout's memory"), key("return")])).toMatchObject({ state: { overlay: { kind: "memory", agent: "scout" } }, effects: [{ type: "readMemory" }] })
  })

  test("each row does what its key or click does", () => {
    const pick = (query: string) => run([ctrl("k"), ...type(query), key("return")])
    expect(pick("cockpit show this").state.tab).toBe(1)
    expect(pick("engine and model").state.overlay).toMatchObject({ kind: "engines", agent: "momentum" })
    expect(pick("every key").state.overlay).toEqual({ kind: "help" })
    expect(pick("one agent or all").state.oneAgent).toBe(true)
    expect(pick("scout make").effects).toEqual([{ type: "setAgent", agent: "scout" }])
    expect(pick("show it on Trade").effects).toEqual([{ type: "layout", op: { kind: "show", name: COCKPIT.name } }])
    expect(pick("open feed").effects).toEqual([{ type: "layout", op: { kind: "open", pane: "feed", near: "agent" } }])
    expect(pick("focus wallets").state).toMatchObject({ focus: "wallets", overlay: undefined })
    expect(pick("pin the token").effects).toEqual([{ type: "pin", on: true }])
    expect(pick("MOON link").effects).toEqual([{ type: "link", mint: MOON, from: "the palette" }])
    expect(pick("kill switch").effects).toEqual([{ type: "kill" }])
    expect(pick("paper mode").effects).toEqual([{ type: "mode", mode: "paper" }])
    expect(pick("save this layout").state.overlay).toMatchObject({ kind: "layouts", naming: "" })
    expect(pick("edit this layout").state.overlay).toMatchObject({ kind: "layouts", index: 0 })
  })

  test("a click on a row does the same, by its id", () => {
    const opened = run([ctrl("k")]).state
    expect(run([{ type: "pickPalette", id: "agent:scout", now: 0 }], opened).effects).toEqual([{ type: "setAgent", agent: "scout" }])
    expect(run([{ type: "pickPalette", id: "nothing", now: 0 }], opened).state.overlay).toBeUndefined()
  })

  test("a row that can't run here says why, and does nothing", () => {
    for (const query of ["reject the", "re-quote", "stop the agent", "resume buys", "live mode", "nobody has shown"]) {
      const r = run([ctrl("k"), ...type(query), key("return")])
      expect(`${query}: ${r.effects.length} ${r.state.message?.text ?? ""}`).toMatch(new RegExp(`^${query}: 0 .+: .+`))
    }
    // Base assets aren't tokens to link.
    expect(found("SOL").some((r) => r.section === "Tokens")).toBe(false)
    // A tab without a token pane has nothing to pin.
    const agentOnly = ctx({ pin: undefined, layout: { ...LAYOUT, current: { ...AGENT_FIRST, root: { dir: "row", weight: 1, children: [{ pane: "agent", weight: 1 }] } } } })
    expect(found("pin", agentOnly)[0]).toMatchObject({ why: "Trade has no token pane" })
  })

  test("no row approves a card: its row says how, and picking it with a card open approves nothing", () => {
    const card = { cardId: "c1", display: {} } as unknown as ViewCard
    const c = ctx({ cards: [card], seenAt: { c1: -10_000 } })
    const r = run([ctrl("k"), ...type("approve"), key("return")], INITIAL_UI, c)
    expect(r.effects).toEqual([])
    expect(r.state.message?.text).toContain("a pick in the palette never trades")
    // With a card open, reject is a row that runs.
    expect(run([ctrl("k"), ...type("reject the"), key("return")], INITIAL_UI, c).effects).toEqual([{ type: "reject", cardId: "c1" }])
    // And quitting is ctrl-c twice only.
    expect(run([ctrl("k"), ...type("quit"), key("return")]).effects).toEqual([])
  })
})

class FakeSession implements Session {
  requests: string[] = []
  private listeners: ((e: CoreEventParams) => void)[] = []
  async request<T>(method: string): Promise<T> {
    this.requests.push(method)
    return {} as T
  }
  onEvent(listener: (e: CoreEventParams) => void): void {
    this.listeners.push(listener)
  }
  push(topic: string, data: unknown): void {
    for (const l of this.listeners) l({ topic, seq: 1, data, snapshot: true })
  }
}

type Setup = Awaited<ReturnType<typeof testRender>>
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

async function input(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn()
  })
  await setup!.renderOnce()
}
const frame = () => setup!.captureCharFrame()
/** Whether a screen line is the row for this path: the path starts after the row's marker column. */
const rowOf = (line: string, path: string) => line.includes(`▸ ${path}  `) || line.includes(`   ${path}  `)

async function opened(width = 120, height = 32): Promise<FakeSession> {
  const session = new FakeSession()
  setup = await testRender(<App session={session} onQuit={() => {}} now={() => 1_000} tickMs={0} />, { width, height, exitOnCtrlC: false })
  await setup.renderOnce()
  await input(() =>
    session.push("status", {
      agents: [{ name: "momentum", candle: "ready", spentTodayUsd: 0, limits: { perTradeUsd: 10, perDayUsd: 50 } }],
      activeAgent: "momentum",
      mode: "live",
      paused: false,
      exposureUsd: null,
      pnl: null,
      pricesAgeMs: null,
    }),
  )
  await input(() => setup!.mockInput.pressKey("?"))
  await input(() => setup!.mockInput.pressKey("c"))
  return session
}

describe("skill folders of the person's own", () => {
  const folders = [
    { shown: "~/.claude/skills", label: "Claude Code's skills", on: false, exists: true, count: 3, skipped: 0 },
    { shown: "~/.codex/skills", label: "Codex's skills", on: true, exists: true, count: 1, skipped: 0 },
    { shown: "~/.pi/agent/skills", label: "Pi's skills", on: false, exists: false, count: 0, skipped: 0 },
  ]
  test("settings ▾ → skills opens the palette on them, read fresh; each row says on or off and how many", () => {
    const c = ctx({ skillFolders: folders })
    const opened = run([{ type: "pickSettings", index: SETTINGS.findIndex((r) => r.id === "skills"), now: 0 }], { ...INITIAL_UI, overlay: { kind: "settings", index: 0 } }, c)
    expect(opened.state.overlay).toEqual({ kind: "palette", query: "skills", index: 0 })
    expect(opened.effects).toContainEqual({ type: "skillsRead" })
    const rows = found("skills", c).filter((r) => r.section === "Skills")
    expect(rows.map((r) => [r.label, r.words, r.current ?? false, r.run ?? r.why])).toEqual([
      ["Claude Code's skills · ~/.claude/skills", "off: 3 skills there; ⏎ turns it on, for every agent", false, { kind: "skillsFolder", folder: "~/.claude/skills", on: true }],
      ["Codex's skills · ~/.codex/skills", "on: the agents read its 1 skill; ⏎ turns it off", true, { kind: "skillsFolder", folder: "~/.codex/skills", on: false }],
      ["Pi's skills · ~/.pi/agent/skills", "not on this machine", false, "there's no ~/.pi/agent/skills here"],
    ])
  })
  test("a row picked asks the core, and the palette stays open on it", () => {
    const c = ctx({ skillFolders: folders })
    const start: UiState = { ...INITIAL_UI, overlay: { kind: "palette", query: "skills", index: 0 } }
    const picked = run([key("return")], start, c)
    expect(picked.effects).toContainEqual({ type: "skillsFolder", folder: "~/.claude/skills", on: true })
    expect(picked.state.overlay?.kind).toBe("palette")
  })
})

describe("the palette on screen", () => {
  test("lists every command with its rule and whether the agent can do it now, grouped as the CLI groups them", async () => {
    await opened()
    expect(frame()).toContain("─ palette ─")
    const seen = new Map<string, string>()
    const groups = new Set<string>()
    for (let i = 0; i <= CATALOGUE.length; i++) {
      for (const line of frame().split("\n")) {
        for (const e of CATALOGUE) if (rowOf(line, e.path) && !seen.has(e.path)) seen.set(e.path, line)
        for (const g of ["Start here", "Trade", "Account", "Custody, on this machine", "Your own services", "Maintain"]) if (line.includes(`── candle · ${g} ─`)) groups.add(g)
      }
      await input(() => setup!.mockInput.pressArrow("down"))
    }
    for (const e of CATALOGUE) {
      const line = seen.get(e.path)
      expect(`${e.path}: ${line !== undefined}`).toBe(`${e.path}: true`)
      // Wide enough, a row that runs in the prompt pane says its rule in words.
      expect(line).toContain(e.availability === "never" ? "not in the Candle Harness" : whenLabel(e, true))
    }
    expect(groups.size).toBe(6)
  })

  test("searching narrows the list; Enter fills the input line and asks the core for nothing", async () => {
    const session = await opened()
    const before = session.requests.length
    await input(async () => {
      await setup!.mockInput.typeText("keys revoke")
    })
    expect(frame()).toContain("keys revoke")
    expect(frame()).toContain("narrows access · now")
    expect(frame()).not.toContain("wallets revoke")
    await input(() => setup!.mockInput.pressEnter())
    expect(frame()).not.toContain("─ palette ─")
    expect(frame()).toContain("revoke an API key")
    expect(session.requests.length).toBe(before)
  })

  test("a click on a row fills the input line too", async () => {
    const session = await opened()
    const before = session.requests.length
    await input(async () => {
      await setup!.mockInput.typeText("lp pools")
    })
    const rows = frame().split("\n")
    const y = rows.findIndex((r) => rowOf(r, "lp pools"))
    expect(y).toBeGreaterThan(0)
    await input(() => setup!.mockMouse.click(rows[y]!.indexOf("lp pools") + 1, y))
    expect(frame()).not.toContain("─ palette ─")
    expect(frame()).toContain(CATALOGUE.find((e) => e.path === "lp pools")!.request!.trim())
    expect(session.requests.length).toBe(before)
  })

  test("a card row is now, or coming with the reason on the detail line", async () => {
    await opened()
    await input(async () => {
      await setup!.mockInput.typeText("stake add")
    })
    expect(frame().split("\n").find((r) => rowOf(r, "stake add"))).toContain("card · now")
    for (let i = 0; i < "stake add".length; i++) await input(() => setup!.mockInput.pressBackspace())
    await input(async () => {
      await setup!.mockInput.typeText("lp add")
    })
    expect(frame().split("\n").find((r) => rowOf(r, "lp add"))).toContain("card · coming")
    // The whole reason, wrapped over the detail lines, so a narrow pane doesn't cut it.
    const text = frame().replace(/[│\s]+/g, " ")
    expect(text).toContain("coming: Candle hasn't switched LP on for agent keys yet, and it needs a key with lp:write, which no preset has. candle-harness doctor says when Candle serves LP.")
  })

  test("a row that runs in the prompt pane says its rule in words; at 80 columns the detail line does", async () => {
    const search = async (text: string) => {
      await input(async () => {
        await setup!.mockInput.typeText(text)
      })
      const shown = frame()
      for (let i = 0; i < text.length; i++) await input(() => setup!.mockInput.pressBackspace())
      return shown
    }
    const row = (shown: string, path: string) => shown.split("\n").find((r) => rowOf(r, path)) ?? ""
    await opened(140, 40)
    expect(row(await search("keys create"), "keys create")).toContain("owner: the factor first · now")
    expect(row(await search("vault list"), "vault list")).toContain("the CLI asks for the factor · now")
    expect(row(await search("vault phrase"), "vault phrase")).toContain("you complete it in the pane · now")
    expect(row(await search("vault transfer"), "vault transfer")).toContain("moves funds · now")
    // The highlighted row's detail line names the CLI's own prompts, and what a ceremony shows.
    const access = (await search("keys access in place")).replace(/[│\s]+/g, " ")
    expect(access).toContain("owner: the factor first · to widen it, you'll type the key's prefix")
    expect((await search("24-word recovery phrase")).replace(/[│\s]+/g, " ")).toContain("Shows your 24 words.")
    // A held row says why, perps included.
    expect((await search("perps open limit")).replace(/[│\s]+/g, " ")).toContain("coming: Perps trading comes in a later release")
    await act(async () => setup!.dispose())
    setup = undefined

    await opened(80, 24)
    const narrow = await search("keys create")
    expect(row(narrow, "keys create")).toContain("owner step · now")
    expect(narrow.replace(/[│\s]+/g, " ")).toContain("owner: the factor first")
  })

  test("fits an 80×24 terminal", async () => {
    await opened(80, 24)
    expect(frame()).toContain("─ palette ─")
    expect(frame()).toContain("candle · Start here")
    expect(frame()).toContain("⏎ does it")
  })
})

test("keys typed straight after ctrl-k reach the search, even in the same read from the terminal", async () => {
  await opened()
  await input(() => setup!.mockInput.pressEscape())
  await input(() => Bun.sleep(30))
  await input(() => {
    setup!.renderer.stdin.emit("data", Buffer.from("\x0bawake"))
  })
  expect(frame()).toContain("search › awake▏")
})
