// The model picker: what it lists, how its keys and clicks pick, and the agent
// pane's engine chip. The core's side (lists read in the background, the choice journalled, one
// conversation across engines) is in src/engine/switch.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CoreEventParams } from "../../core/client"
import type { EngineCapabilities, EngineModel } from "../../engine/engine"
import { App, type Session } from "../app"
import { engineChipText } from "../engine-chip"
import { type Effect, INITIAL_UI, type Key, step, type UiAction, type UiContext, type UiState } from "../keys"
import { type EngineInfo, EnginePicker, type EngineTopic, gapsOf, type ModelsRead, needsModel, pickable, type PickerRow, pickerRows } from "./engines"

const FULL: EngineCapabilities = { webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true }
const info = (label: string, extra: Partial<EngineInfo> = {}): EngineInfo => ({
  label,
  minVersion: "1.0.0",
  check: { ok: true, version: "1.2.3" },
  capabilities: FULL,
  signedIn: true,
  modelsReadAt: 1,
  ...extra,
})

function topic(agents: EngineTopic["agents"] = { momentum: { engine: "claude-code", from: "config" } }): EngineTopic {
  return {
    agents,
    engines: {
      "claude-code": info("Claude Code"),
      codex: info("Codex", { capabilities: { ...FULL, webFetch: false, files: "write", shellList: false, deltas: false }, defaultModel: "gpt-5.6" }),
      grok: info("Grok", { check: { ok: false, message: "Grok isn't installed. Install it from x.ai/grok-cli." }, signedIn: null, modelsReadAt: null }),
      opencode: info("OpenCode", { signedIn: false, needsModel: true, signIn: "opencode auth login, for an API key or OpenRouter" }),
      pi: info("Pi", { capabilities: { ...FULL, webSearch: false }, needsModel: true, signIn: "run pi, then /login" }),
    },
  }
}

/** The model rows only: the preset rows above them are tested on their own. */
const modelRows = (rows: readonly PickerRow[]) => pickable(rows).filter((r): r is Extract<PickerRow, { kind: "model" }> => r.kind === "model")

const modelAt = (rows: readonly PickerRow[], index: number) => {
  const row = pickable(rows)[index]
  return row?.kind === "model" ? row.model : undefined
}

const read = (models: EngineModel[], extra: Partial<ModelsRead> = {}): ModelsRead => ({ models, notes: [], reading: false, ...extra })
const LISTS = {
  "claude-code": read([
    { id: "opus", label: "Opus (newest)" },
    { id: "sonnet", label: "Sonnet (newest)" },
  ]),
  codex: read([
    { id: "gpt-5.6-mini", label: "gpt-5.6-mini" },
    { id: "gpt-5.6", label: "gpt-5.6", isDefault: true },
  ]),
  opencode: read([]),
  pi: read(
    [
      { id: "openrouter/~anthropic/claude-haiku-latest", label: "openrouter/~anthropic/claude-haiku-latest" },
      { id: "openrouter/deepseek/deepseek-v4.1-flash", label: "openrouter/deepseek/deepseek-v4.1-flash" },
    ],
    { notes: ["Your ChatGPT sign-in in Pi isn't offered here: pick Codex for it."] },
  ),
}
const texts = (rows: ReturnType<typeof pickerRows>) => rows.map((r) => `${r.kind}: ${r.text}${(r.kind === "model" || r.kind === "preset") && r.current ? " ●" : ""}`)

describe("what the picker lists", () => {
  test("every engine in the seam's order: its heading, its gaps, its models with the default first; one that can't run says what to do and offers none", () => {
    expect(texts(pickerRows(topic(), LISTS, "", "momentum", "darwin"))).toEqual([
      "presets: preset",
      "preset: Quant · an analyst as well as a trader: reads Candle's data first and uses Candle's skills ●",
      "preset: Trader · the plain trading prompt, without the analyst's rules or Candle's skills",
      "preset: Bare · the essentials only: light, or for your own skills",
      "engine: Claude Code 1.2.3 (needs 1.0.0+) · signed in",
      "model: Claude Code's own default ●",
      "model: Opus (newest) · opus",
      "model: Sonnet (newest) · sonnet",
      "engine: Codex 1.2.3 (needs 1.0.0+) · signed in",
      "info: no web fetch · replies arrive whole",
      "model: gpt-5.6 · default",
      "model: gpt-5.6-mini",
      "engine: Grok · can't run here",
      "info: Grok isn't installed. Install it from x.ai/grok-cli. Installed since the app started? Restart it from a shell where grok runs.",
      "engine: OpenCode 1.2.3 (needs 1.0.0+) · no models",
      "info: no models here: opencode auth login, for an API key or OpenRouter",
      "engine: Pi 1.2.3 (needs 1.0.0+) · ready",
      "info: no web search on Pi",
      "info: Your ChatGPT sign-in in Pi isn't offered here: pick Codex for it.",
      "model: openrouter/~anthropic/claude-haiku-latest",
      "model: openrouter/deepseek/deepseek-v4.1-flash",
    ])
  })

  test("a list not yet answered shows reading…, and one that failed says so", () => {
    expect(texts(pickerRows(topic(), { ...LISTS, codex: undefined }, "codex", "momentum"))).toContain("info: reading…")
    const failed = texts(pickerRows(topic(), { ...LISTS, pi: read(LISTS.pi.models, { error: "pi --list-models timed out" }) }, "pi", "momentum"))
    expect(failed).toContain("info: couldn't read its models: pi --list-models timed out")
    expect(failed).toContain("model: openrouter/deepseek/deepseek-v4.1-flash")
  })

  test("typing narrows to the models whose words hold every word; an engine's name shows all of its", () => {
    expect(modelRows(pickerRows(topic(), LISTS, "deepseek", "momentum")).map((r) => r.model)).toEqual(["openrouter/deepseek/deepseek-v4.1-flash"])
    expect(modelRows(pickerRows(topic(), LISTS, "codex", "momentum")).map((r) => r.model ?? "default")).toEqual(["default", "gpt-5.6-mini"])
    expect(pickerRows(topic(), LISTS, "zzzz", "momentum")).toEqual([])
  })

  test("the agent's choice is marked: a model by name, or the default when none is picked", () => {
    const onPi = topic({ momentum: { engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", from: "saved" } })
    expect(modelRows(pickerRows(onPi, LISTS, "", "momentum")).filter((r) => r.current).map((r) => r.model)).toEqual(["openrouter/deepseek/deepseek-v4.1-flash"])
    const onCodex = topic({ momentum: { engine: "codex", from: "saved" } })
    expect(modelRows(pickerRows(onCodex, LISTS, "", "momentum")).filter((r) => r.current).map((r) => r.text)).toEqual(["gpt-5.6 · default"])
  })

  test("a signed-out harness can't be picked, and says how to sign in", () => {
    const t = topic()
    t.engines["claude-code"] = info("Claude Code", { signedIn: false, signIn: "run claude, then /login" })
    const rows = pickerRows(t, LISTS, "claude code", "momentum")
    expect(texts(rows)).toEqual(["engine: Claude Code 1.2.3 (needs 1.0.0+) · not signed in", "info: sign in: run claude, then /login"])
  })

  test("the gaps: no web search on Pi, a shell list means off, no file tools where the read canary fails", () => {
    expect(gapsOf("pi", { ...FULL, webSearch: false })).toEqual(["no web search on Pi"])
    expect(gapsOf("grok", { ...FULL, shellList: false })).toEqual([])
    expect(gapsOf("grok", { ...FULL, shellList: false }, "linux", { shell: ["ls"], deny: [] })).toEqual(["a shell list means off"])
    // How Grok's list and Codex's everything differ.
    expect(gapsOf("grok", FULL, "linux", { shell: ["ls"], deny: [] })).toEqual(["Grok also runs its own read-only commands (ls, cat, grep…), and can't list rm, chmod, kill or git push"])
    expect(gapsOf("codex", { ...FULL, shellList: false }, "linux", { shell: "everything", deny: [] })).toEqual(["Codex's shell writes only in the research folder, with no network"])
    expect(gapsOf("codex", { ...FULL, files: "none" }, "darwin")).toEqual(["no file tools on macOS"])
  })

  test("an agent with the shell on is told, on each engine it's on for, that reads aren't held and cards don't cover it", () => {
    const listed = topic({ momentum: { engine: "claude-code", from: "config", tools: { shell: ["ls", "git log"], deny: [] } } })
    const rows = texts(pickerRows(listed, LISTS, "", "momentum", "darwin"))
    expect(rows).toContain("info: shell on for ls, git log: reads aren't held to the research folder, and cards and limits don't cover what the shell runs")
    // Codex can't hold the list, so it's off there, and the line says so instead.
    expect(rows).toContain("info: no web fetch · a shell list means off · replies arrive whole")
    expect(rows.filter((r) => r.startsWith("info: shell on"))).toHaveLength(2) // Claude Code and Pi
    const everything = topic({ momentum: { engine: "claude-code", from: "config", tools: { shell: "everything", deny: [] } } })
    expect(texts(pickerRows(everything, LISTS, "codex", "momentum"))).toContain("info: shell on: reads aren't held to the research folder, and cards and limits don't cover what the shell runs")
    const look = pickerRows(everything, LISTS, "codex", "momentum").find((r) => r.kind === "info" && r.text.startsWith("shell on"))
    expect(look).toMatchObject({ tone: "look" })
  })

  test("a Pi with several models and no default of the user's needs one picked before a turn; one picked, or a default, doesn't", () => {
    const onPi = topic({ momentum: { engine: "pi", from: "saved" } })
    expect(needsModel(onPi, "momentum")).toBe(true)
    expect(needsModel(topic({ momentum: { engine: "pi", model: "openrouter/a", from: "saved" } }), "momentum")).toBe(false)
    onPi.engines.pi!.defaultModel = "openrouter/a"
    expect(needsModel(onPi, "momentum")).toBe(false)
    // Claude Code runs its own default; and before the list is read, nothing is known.
    expect(needsModel(topic(), "momentum")).toBe(false)
    const unread = topic({ momentum: { engine: "pi", from: "saved" } })
    unread.engines.pi!.modelsReadAt = null
    expect(needsModel(unread, "momentum")).toBe(false)
  })
})

describe("the engine chip", () => {
  test("only what the next turn runs on: the engine, and its model, picked or last answered or the default", () => {
    // Claude Code with nothing picked and no turn yet: the engine alone; Codex's default by name.
    expect(engineChipText(topic(), "momentum")).toBe("Claude Code ▾")
    expect(engineChipText(topic({ momentum: { engine: "codex", from: "saved", preset: "trader", presetFrom: "saved" } }), "momentum")).toBe("Codex · gpt-5.6 ▾")
    const ran = { engine: "claude-code" as const, model: null, answeredModel: "claude-opus-5-5" }
    // A default that answered says which model it was; a pick says the pick.
    expect(engineChipText(topic({ momentum: { engine: "claude-code", from: "saved", last: ran } }), "momentum")).toBe("Claude Code · claude-opus-5-5 ▾")
    expect(engineChipText(topic({ momentum: { engine: "claude-code", model: "sonnet", from: "saved", last: ran } }), "momentum")).toBe("Claude Code · sonnet ▾")
    // A switch shows only where the next turn goes, the model without its provider's path.
    expect(engineChipText(topic({ momentum: { engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", from: "saved", last: ran } }), "momentum")).toBe("Pi · deepseek-v4.1-flash ▾")
    expect(engineChipText(undefined, "momentum")).toBeUndefined()
  })

})

function ctx(t: EngineTopic = topic(), lists = LISTS): UiContext {
  return {
    cards: [],
    seenAt: {},
    mode: "live",
    agents: ["momentum"],
    activeAgent: "momentum",
    commands: { agents: ["momentum"], knownTokens: new Map() },
    engines: { rows: (q, agent) => pickerRows(t, lists, q, agent), needsModel: (agent) => needsModel(t, agent) },
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
const type = (text: string): UiAction[] => [...text].map((ch) => ({ type: "key", key: { name: ch === " " ? "space" : ch, sequence: ch }, now: 1_000 }))

describe("the picker's keys", () => {
  test("ctrl-g opens it for the agent in view, on its choice, and asks the core for the lists; ctrl-g again closes it", () => {
    const { state, effects } = run([ctrl("g")])
    // On its model, below the three presets.
    expect(state.overlay).toEqual({ kind: "engines", agent: "momentum", query: "", index: 3 })
    expect(effects).toEqual([{ type: "readModels" }])
    expect(run([ctrl("g"), ctrl("g")]).state.overlay).toBeUndefined()
    // On Pi's DeepSeek, it opens there.
    const onPi = ctx(topic({ momentum: { engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", from: "saved" } }))
    const at = run([ctrl("g")], INITIAL_UI, onPi).state.overlay as { index: number }
    expect(modelAt(onPi.engines!.rows("", "momentum"), at.index)).toBe("openrouter/deepseek/deepseek-v4.1-flash")
  })

  test("a bare g types into the line: no bare-letter keys", () => {
    const { state, effects } = run(type("g"))
    expect(state.input).toBe("g")
    expect(state.overlay).toBeUndefined()
    expect(effects).toEqual([])
  })

  test("the arrows move through the models only, typing searches, and Enter picks from the next turn", () => {
    const { state, effects } = run([ctrl("g"), key("down"), key("down"), key("down"), key("return")])
    expect(state.overlay).toBeUndefined()
    expect(effects).toEqual([{ type: "readModels" }, { type: "chooseEngine", agent: "momentum", engine: "codex" }])
    const searched = run([ctrl("g"), ...type("deep"), key("return")])
    expect(searched.effects.at(-1)).toEqual({ type: "chooseEngine", agent: "momentum", engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash" })
    expect(run([ctrl("g"), ...Array(50).fill(key("down"))]).state.overlay).toMatchObject({ index: pickable(ctx().engines!.rows("", "momentum")).length - 1 })
  })

  test("Esc leaves it as it was, and Enter with nothing found picks nothing", () => {
    expect(run([ctrl("g"), key("down"), key("escape")]).effects).toEqual([{ type: "readModels" }])
    expect(run([ctrl("g"), ...type("zzzz"), key("return")]).effects).toEqual([{ type: "readModels" }])
  })

  test("the chip and a click: the chip opens it; a model clicked picks it", () => {
    const opened = run([{ type: "clickEngineChip", now: 0 }])
    expect(opened.state.overlay).toMatchObject({ kind: "engines", agent: "momentum" })
    const picked = run([{ type: "pickEngine", engine: "pi", model: "openrouter/a", now: 0 }], opened.state)
    expect(picked.effects).toEqual([{ type: "chooseEngine", agent: "momentum", engine: "pi", model: "openrouter/a" }])
    expect(picked.state.overlay).toBeUndefined()
  })

  test("a list that answers moves an untouched picker to the agent's choice; one the user moved stays", () => {
    const onPi = topic({ momentum: { engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", from: "saved" } })
    const before = run([ctrl("g")], INITIAL_UI, ctx(onPi, { ...LISTS, pi: read([], { reading: true }) }))
    const after = run([{ type: "modelsRead", now: 0 }], before.state, ctx(onPi)).state.overlay as { index: number }
    expect(modelAt(ctx(onPi).engines!.rows("", "momentum"), after.index)).toBe("openrouter/deepseek/deepseek-v4.1-flash")
    const moved = run([key("down"), { type: "modelsRead", now: 0 }], before.state, ctx(onPi)).state.overlay
    expect(moved).toMatchObject({ index: 4, moved: true })
  })

  test("a message to an agent whose engine needs a model first opens the picker, and stays on the line", () => {
    const onPi = ctx(topic({ momentum: { engine: "pi", from: "saved" } }))
    const { state, effects } = run([...type("what's moving?"), key("return")], INITIAL_UI, onPi)
    expect(state.input).toBe("what's moving?")
    expect(state.overlay).toMatchObject({ kind: "engines", agent: "momentum" })
    expect(state.message?.text).toContain("Pick a model for momentum first")
    expect(effects).toEqual([{ type: "readModels" }])
    // With a model, it goes to the agent.
    const ok = run([...type("what's moving?"), key("return")])
    expect(ok.effects).toEqual([{ type: "command", command: { kind: "agent", text: "what's moving?" } }])
  })

  test("the commands pane's model row opens it", () => {
    const { state, effects } = run([key("?"), key("c"), ...type("model"), key("return")])
    expect(state.overlay).toMatchObject({ kind: "engines", agent: "momentum" })
    expect(effects).toEqual([{ type: "readModels" }])
  })

  test("the kill switch still works over it", () => {
    expect(run([ctrl("g"), ctrl("x"), ctrl("x")]).effects).toEqual([{ type: "readModels" }, { type: "kill" }])
  })
})

class FakeSession implements Session {
  requests: { method: string; params: Record<string, unknown> }[] = []
  used = 0
  private listeners: ((e: CoreEventParams) => void)[] = []
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // The view saying it was used is counted apart: it carries no change.
    if (method === "view.active") {
      this.used++
      return {} as T
    }
    this.requests.push({ method, params })
    if (method === "engine.models") return { engine: params.engine, ...(LISTS as Record<string, ModelsRead | undefined>)[String(params.engine)], readAt: 1 } as T
    return {} as T
  }
  onEvent(listener: (e: CoreEventParams) => void): void {
    this.listeners.push(listener)
  }
  push(topicName: string, data: unknown): void {
    for (const l of this.listeners) l({ topic: topicName, seq: 1, data, snapshot: true })
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

async function mounted(width: number, height: number, t: EngineTopic): Promise<FakeSession> {
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
  await input(() => session.push("engine", t))
  return session
}

describe("on screen", () => {
  const ran = topic({ momentum: { engine: "claude-code", model: "opus", from: "saved", last: { engine: "claude-code", model: "opus", answeredModel: "claude-opus-5-5" } } })

  for (const [width, height] of [
    [140, 40],
    [80, 24],
  ] as const) {
    test(`at ${width}×${height}: the chip on the agent pane's border, ctrl-g, the picker, and a pick sent to the core`, async () => {
      const session = await mounted(width, height, ran)
      const top = frame().split("\n").find((r) => r.startsWith("╭─ momentum"))!
      expect(top).toContain("momentum")
      // What the next turn runs on: the engine and the model picked.
      expect(top).toContain("─ Claude Code · opus ▾ ─")
      await input(() => setup!.mockInput.pressKey("g", { ctrl: true }))
      await input(async () => await Bun.sleep(5))
      expect(frame()).toContain(" preset, engine and model for momentum ")
      expect(frame()).toContain("Claude Code 1.2.3 (needs 1.0.0+) · signed in")
      // At 80×24 Grok's two lines of what to do push Pi's below the fold.
      if (width >= 140) expect(frame()).toContain("no web search on Pi")
      expect(frame()).toContain("Grok isn't installed")
      expect(frame()).toContain("Restart it from a shell where grok runs.")
      expect(session.requests.filter((r) => r.method === "engine.models").map((r) => `${r.params.engine}${r.params.fresh ? " fresh" : ""}`).sort()).toEqual(
        ["claude-code", "claude-code fresh", "codex", "codex fresh", "pi", "pi fresh"],
      )
      await input(async () => {
        await setup!.mockInput.typeText("deepseek")
      })
      await input(() => setup!.mockInput.pressEnter())
      expect(frame()).not.toContain(" preset, engine and model for momentum ")
      expect(session.requests.find((r) => r.method === "engine.choose")?.params).toEqual({ agent: "momentum", engine: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash" })
      // Under the agent pane, wrapped at its width at 80×24, so read in pieces.
      for (const piece of ["momentum is on Pi ·", "openrouter/deepseek/deepseek-v4.1-flash", "its next turn."]) expect(frame()).toContain(piece)
    })
  }

  test("a preset picked by search and Enter goes to the core, from the next turn", async () => {
    const session = await mounted(140, 40, ran)
    await input(() => setup!.mockInput.pressKey("g", { ctrl: true }))
    await input(async () => await Bun.sleep(5))
    expect(frame()).toContain("── preset ──")
    expect(frame()).toContain("● Quant · an analyst as well as a trader")
    await input(async () => {
      await setup!.mockInput.typeText("trader")
    })
    await input(() => setup!.mockInput.pressEnter())
    expect(session.requests.find((r) => r.method === "preset.choose")?.params).toEqual({ agent: "momentum", preset: "trader" })
    expect(session.requests.some((r) => r.method === "engine.choose")).toBe(false)
    expect(frame().replace(/\s+/g, " ")).toContain("momentum runs as Trader from its next turn.")
  })

  test("a click on the chip opens the picker", async () => {
    await mounted(140, 40, ran)
    const rows = frame().split("\n")
    const y = rows.findIndex((r) => r.includes("Claude Code · opus"))
    const x = rows[y]!.indexOf("Claude Code · opus")
    await input(() => setup!.mockMouse.click(x + 2, y))
    expect(frame()).toContain(" preset, engine and model for momentum ")
  })
})

test("opened on a model deep in a long list, the presets still show at the top (744 models had hidden them)", async () => {
  const many = read(Array.from({ length: 400 }, (_, i) => ({ id: `openrouter/m${i}`, label: `m${i}` })))
  const t = topic({ momentum: { engine: "pi", model: "openrouter/m300", from: "saved" } })
  const rows = pickerRows(t, { ...LISTS, pi: many }, "", "momentum")
  const index = pickable(rows).findIndex((r) => r.kind === "model" && r.current)
  setup = await testRender(<EnginePicker agent="momentum" rows={rows} query="" index={index} width={80} height={24} onPick={() => {}} onPickPreset={() => {}} onScroll={() => {}} />, { width: 80, height: 24 })
  await setup.renderOnce()
  const f = frame()
  expect(f).toContain("── preset ")
  expect(f).toContain("Quant · ")
  expect(f).toContain("▸ ● m300")
})
