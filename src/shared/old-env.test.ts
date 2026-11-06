// 0.2's CANDLE_TUI_* variables, still read under their CANDLE_HARNESS_* names through 0.3.x.
import { expect, test } from "bun:test"
import { adoptOldEnv, oldEnvNotice } from "./old-env"

test("an old name is copied to the new one where that isn't set; the new name wins; a child finds both and adopts nothing", () => {
  const env: Record<string, string | undefined> = { CANDLE_TUI_HOME: "/h/old", CANDLE_TUI_PASTE_LOG: "/p", CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY: "1", CANDLE_TUI_DEBUG_LOSE_NEXT_REPLY: "0", CANDLE_TUI_: "x", PATH: "/bin" }
  expect(adoptOldEnv(env)).toEqual(["CANDLE_TUI_HOME", "CANDLE_TUI_PASTE_LOG"])
  expect(env.CANDLE_HARNESS_HOME).toBe("/h/old")
  expect(env.CANDLE_HARNESS_PASTE_LOG).toBe("/p")
  expect(env.CANDLE_HARNESS_DEBUG_LOSE_NEXT_REPLY).toBe("1")
  expect(env.CANDLE_HARNESS_).toBeUndefined()
  // The child process the core starts inherits both: nothing to adopt, nothing said.
  expect(adoptOldEnv({ ...env })).toEqual([])
  expect(adoptOldEnv({ PATH: "/bin" })).toEqual([])
})

test("the notice names each old variable and its new name, as deprecated", () => {
  expect(oldEnvNotice(["CANDLE_TUI_HOME"])).toBe("CANDLE_TUI_HOME is Candle TUI 0.2's name, read for now as CANDLE_HARNESS_HOME. The old names are deprecated: rename them.")
  expect(oldEnvNotice(["CANDLE_TUI_HOME", "CANDLE_TUI_PASTE_LOG"])).toContain("are Candle TUI 0.2's names, read for now as CANDLE_HARNESS_HOME, CANDLE_HARNESS_PASTE_LOG.")
})
