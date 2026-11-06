// Pop-out's route: tmux with the command as separate arguments, cmux with every word
// quoted for the split's shell, else the command to copy. And the popped view's pane, checked.
import { expect, test } from "bun:test"
import { poppedPane } from "../main"
import { POPPABLE } from "../shared/panes"
import { AGENT_FIRST, COCKPIT, panesOf } from "./layout"
import { withoutPanes } from "./layout-edit"
import { PANES } from "./panes/registry"
import { copyCommand, makePopper, popRoute, type RunTool, viewArgv } from "./popout"

const SELF = ["/opt/candle harness/candle-harness"]

test("the panes that pop are the registry's: every one but the conversation, and the core's list is the same", () => {
  expect(Object.values(PANES).filter((p) => p.pops).map((p) => p.id).sort()).toEqual([...POPPABLE].sort())
  expect(POPPABLE).not.toContain("agent")
})

test("inside tmux: split-window beside this view's own pane, the command as separate arguments (no shell), the home carried", () => {
  const route = popRoute({ pane: "positions", self: SELF, env: { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", CANDLE_HARNESS_HOME: "/srv/my harness" } })
  expect(route).toEqual({ kind: "tmux", file: "tmux", args: ["split-window", "-h", "-t", "%3", "-e", "CANDLE_HARNESS_HOME=/srv/my harness", "/opt/candle harness/candle-harness", "view", "--pane", "positions"] })
  // No shell anywhere: nothing is joined into one string for sh -c.
  if (route.kind === "tmux") expect(route.args.some((a) => /^(sh|bash|zsh)$|-c$/.test(a) && a !== "-h")).toBe(false)
  // tmux inside cmux: tmux, the innermost, splits.
  expect(popRoute({ pane: "feed", self: SELF, env: { TMUX: "x", CMUX_SURFACE_ID: "S1" } }).kind).toBe("tmux")
  // Without TMUX_PANE, tmux's own current pane.
  expect(popRoute({ pane: "feed", self: SELF, env: { TMUX: "x" } })).toEqual({ kind: "tmux", file: "tmux", args: ["split-window", "-h", "/opt/candle harness/candle-harness", "view", "--pane", "feed"] })
})

test("inside cmux: new-split right beside this surface, every word single-quoted for the split's shell, exec'd so the split closes with the view", () => {
  const route = popRoute({ pane: "signals", self: [...SELF, "/src/main.ts"], env: { CMUX_SURFACE_ID: "SURF-1", CANDLE_HARNESS_HOME: "/srv/.harness" } })
  expect(route).toEqual({
    kind: "cmux",
    file: "cmux",
    args: ["new-split", "right", "--surface", "SURF-1", "--command", " exec env CANDLE_HARNESS_HOME=/srv/.harness '/opt/candle harness/candle-harness' /src/main.ts view --pane signals"],
  })
  // A word a shell can't be trusted to read back as itself: the copy route, never a guess at quoting.
  for (const odd of ["/opt/it's/candle-harness", "/opt/back\\slash/candle-harness", "/opt/new\nline/candle-harness"]) {
    const r = popRoute({ pane: "feed", self: [odd], env: { CMUX_SURFACE_ID: "S" } })
    expect(r.kind).toBe("copy")
  }
})

test("anywhere else, the command to copy, quoted for a shell", () => {
  const input = { pane: "activity" as const, self: SELF, env: { CANDLE_HARNESS_HOME: "/h" } }
  expect(popRoute(input)).toEqual({ kind: "copy", why: "this terminal isn't inside tmux or cmux" })
  expect(copyCommand(input)).toBe("env CANDLE_HARNESS_HOME=/h '/opt/candle harness/candle-harness' view --pane activity")
  expect(copyCommand({ ...input, self: ["/opt/it's/x"], env: {} })).toBe("'/opt/it'\\''s/x' view --pane activity")
  expect(viewArgv(SELF, "token")).toEqual([...SELF, "view", "--pane", "token"])
})

test("the conversation never pops, and a pane is checked against the registry", () => {
  expect(() => popRoute({ pane: "agent", self: SELF, env: { TMUX: "x" } })).toThrow()
  expect(poppedPane(["--pane", "positions"])).toBe("positions")
  expect(poppedPane(["--pane", "agent"])).toEqual({ problem: expect.stringContaining("stays in the main window") })
  expect(poppedPane(["--pane", "chart; rm -rf ~"])).toEqual({ problem: expect.stringContaining("No pane") })
  expect(poppedPane(["--pane"])).toBeUndefined()
  expect(poppedPane(["--pane", "feed", "--extra"])).toBeUndefined()
})

test("the popper: a split when the multiplexer takes it; the copy route, with why, when it refuses or isn't there", async () => {
  const calls: { file: string; args: readonly string[] }[] = []
  const ok: RunTool = async (file, args) => {
    calls.push({ file, args })
    return { code: 0, said: "" }
  }
  expect(await makePopper({ self: SELF, env: { TMUX: "x", TMUX_PANE: "%1" }, run: ok })("wallets")).toEqual({ kind: "split", where: "tmux" })
  expect(calls[0]!.file).toBe("tmux")

  const refused: RunTool = async () => ({ code: 1, said: "unknown flag -e\nusage: …" })
  const r = await makePopper({ self: SELF, env: { TMUX: "x", CANDLE_HARNESS_HOME: "/h" }, run: refused })("wallets")
  expect(r).toEqual({ kind: "copy", command: "env CANDLE_HARNESS_HOME=/h '/opt/candle harness/candle-harness' view --pane wallets", why: "tmux refused the split: unknown flag -e" })

  const missing: RunTool = async () => undefined
  expect(await makePopper({ self: SELF, env: { CMUX_SURFACE_ID: "S" }, run: missing })("feed")).toMatchObject({ kind: "copy", why: "cmux couldn't be started from here" })

  let ran = false
  const none: RunTool = async () => ((ran = true), { code: 0, said: "" })
  expect((await makePopper({ self: SELF, env: {}, run: none })("feed")).kind).toBe("copy")
  expect(ran).toBe(false)
})

test("a tiled view leaves popped panes out, the panes beside taking their place, and keeps the layout's name", () => {
  const out = withoutPanes(AGENT_FIRST, ["positions", "wallets"])!
  expect(panesOf(out.root)).toEqual(["agent", "token", "activity"])
  expect(out.name).toBe("Agent-first")
  expect(out.collapse.below).toBe(AGENT_FIRST.collapse.below)
  // A pane the layout hasn't got changes nothing.
  expect(withoutPanes(AGENT_FIRST, ["feed"])).toBe(AGENT_FIRST)
  // The Cockpit without its whole left column: the token takes the top row.
  expect(panesOf(withoutPanes(COCKPIT, ["feed", "signals"])!.root)).toEqual(["token", "positions", "activity", "agent"])
  // Every pane out: nothing left to draw.
  const own = { ...AGENT_FIRST, root: { dir: "row" as const, weight: 1, children: [{ pane: "feed" as const, weight: 1 }] }, collapse: { ...AGENT_FIRST.collapse, keep: "feed" as const } }
  expect(withoutPanes(own, ["feed"])).toBeUndefined()
})
