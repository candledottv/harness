import { describe, expect, test } from "bun:test"
import { SHELL_CASES } from "../../test/shell-cases"
import { shellAllows as piShellAllows } from "./pi-gate"
import { researchCan, shellAllows, shellEntryFault, shellFor, toolAllowed, toolNameFault } from "./tools"

describe("tool names", () => {
  test("research names, Candle's tools and patterns are names; the shell and anything else aren't", () => {
    for (const ok of ["web_search", "web_fetch", "read", "write", "candle_trade", "candle_get_*", "web_*", "research_read", "harness_show_wallets", "hacc_lab", "hacc_*", "*"]) expect(toolNameFault(ok)).toBeUndefined()
    expect(toolNameFault("shell")).toContain("tools.shell")
    expect(toolNameFault("bash")).toContain("tools.shell")
    expect(toolNameFault("Bash")).toContain("isn't a tool name")
    expect(toolNameFault("view_image")).toContain("names no tool")
    expect(toolNameFault("x*")).toContain("names no tool")
    expect(toolNameFault(3)).toContain("isn't a tool name")
  })

  test("deny hides by name or pattern; allow, when set, hides everything it doesn't name", () => {
    const deny = { shell: "off" as const, deny: ["web_search", "candle_launch*"] }
    expect(toolAllowed(deny, "web_search")).toBe(false)
    expect(toolAllowed(deny, "web_fetch")).toBe(true)
    expect(toolAllowed(deny, "candle_launch_token")).toBe(false)
    expect(toolAllowed(deny, "candle_trade")).toBe(true)
    const allow = { shell: "off" as const, allow: ["candle_get_*", "read"], deny: ["candle_get_feed"] }
    expect(toolAllowed(allow, "candle_get_market")).toBe(true)
    expect(toolAllowed(allow, "candle_get_feed")).toBe(false)
    expect(toolAllowed(allow, "candle_trade")).toBe(false)
    expect(toolAllowed(allow, "web_fetch")).toBe(false)
    // The core's research tools are reading notes.
    expect(toolAllowed(allow, "research_read")).toBe(true)
    expect(toolAllowed({ shell: "off", deny: ["read"] }, "research_list")).toBe(false)
    expect(toolAllowed({ shell: "off", deny: ["research_list"] }, "research_list")).toBe(false)
    expect(toolAllowed({ shell: "off", deny: ["research_list"] }, "research_read")).toBe(true)
  })
})

describe("the shell", () => {
  test("a list entry is a command and its first arguments, plain words only", () => {
    for (const ok of ["ls", "git log", "python3", "jq -r", "head -n"]) expect(shellEntryFault(ok)).toBeUndefined()
    for (const bad of ["", "ls;rm", "ls && rm", "rm -rf $HOME", "ls|head", "`id`", " ls", "ls  -la", "echo 'x'", 3]) expect(shellEntryFault(bad)).toBeString()
  })

  test("a list on Codex or Grok means off", () => {
    expect(shellFor({ shell: ["ls"], deny: [] }, { shellList: false })).toBe("off")
    expect(shellFor({ shell: ["ls"], deny: [] }, { shellList: true })).toEqual(["ls"])
    expect(shellFor({ shell: "everything", deny: [] }, { shellList: false })).toBe("everything")
  })

  test("a listed command runs alone, with nothing that joins, redirects or substitutes", () => {
    for (const [s, command, want] of SHELL_CASES) expect([s, command, shellAllows(s, command)]).toEqual([s, command, want])
  })

  test("Pi's gate holds a list by the same rule (OpenCode's: opencode.test.ts)", () => {
    for (const [s, command, want] of SHELL_CASES) expect([s, command, piShellAllows(s, command)]).toEqual([s, command, want])
  })
})

test("what a turn can research with, after the agent's settings", () => {
  const claude = { webSearch: true, webFetch: true, files: "own" as const, shellList: true }
  const codex = { webSearch: true, webFetch: false, files: "write" as const, shellList: false }
  expect(researchCan(claude)).toEqual({ webSearch: true, webFetch: true, read: "own", write: true, shell: "off" })
  expect(researchCan(codex, { shell: ["ls"], deny: ["write"] })).toEqual({ webSearch: true, webFetch: false, read: "core", write: false, shell: "off" })
  expect(researchCan(claude, { shell: "everything", allow: ["web_fetch"], deny: [] })).toEqual({ webSearch: false, webFetch: true, read: false, write: false, shell: "everything" })
  expect(researchCan({ ...claude, files: "none" })).toMatchObject({ read: "core", write: false })
})
