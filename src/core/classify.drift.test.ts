// The drift check: a tool Candle adds fails this until someone decides what it is. The same check runs
// against the real server's tools/list when the core starts (unclassifiedTools).
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-tools.json"
import { classificationDrift, classify, unclassifiedTools } from "./classify"

const names = fixture.tools.map((t) => t.name)

test("the recorded tool list and the table agree", () => {
  expect(classificationDrift(names)).toEqual([])
})

test("the check fails when Candle's list gains a tool, or the table names one Candle doesn't have", () => {
  expect(classificationDrift([...names, "candle_new_tool"])).toEqual(["unclassified: candle_new_tool"])
  expect(classificationDrift(names.filter((n) => n !== "candle_get_feed"))).toEqual(["not a Candle tool: candle_get_feed"])
})

test("at core start, the tools the server lists that the table doesn't know are named", () => {
  expect(unclassifiedTools([...names, "candle_new_tool", "candle_other_new"])).toEqual(["candle_new_tool", "candle_other_new"])
  expect(unclassifiedTools(names)).toEqual([])
})

test("server 0.10.25's new tools: the token card and events are reads, the profile image a public card", () => {
  for (const tool of ["candle_token_card", "candle_token_events"]) {
    expect(names).toContain(tool)
    expect(classify(tool, { mint: "x" }, "live")).toEqual({ class: "read" })
    expect(classify(tool, {}, "paper")).toEqual({ class: "read" })
  }
  expect(names).toContain("candle_upload_profile_image")
  expect(classify("candle_upload_profile_image", { kind: "avatar", imageUrl: "https://example.com/a.png" }, "live")).toEqual({ class: "card", kind: "public", idKey: "coreOpId" })
  expect(classify("candle_upload_profile_image", {}, "paper")).toMatchObject({ class: "refused", code: "NO_PAPER_FORM" })
})

test("server 0.10.28's new tools: keyless reads, the token edit a public card, token pages' scoped calls and the lab hidden", () => {
  for (const tool of ["candle_get_agent_positions", "candle_token_clusters", "candle_token_history", "candle_token_page_about", "candle_token_page_burns", "candle_token_page_history", "candle_token_page_comments", "candle_token_page_updates"]) {
    expect(names).toContain(tool)
    expect(classify(tool, {}, "live")).toEqual({ class: "read" })
  }
  expect(classify("candle_token_edit", { chain: "solana", mint: "x", description: "y" }, "live")).toEqual({ class: "card", kind: "public", idKey: "coreOpId" })
  expect(classify("candle_token_edit", {}, "paper")).toMatchObject({ class: "refused", code: "NO_PAPER_FORM" })
  const hidden = names.filter((n) => /^candle_(token_page_(capabilities|seen|creator_challenge|claim|section_set|section_restore|update|post_delete|comment|mark_seen|flag)$|lab_)/.test(n))
  expect(hidden).toHaveLength(16)
  for (const tool of hidden) {
    const verdict = classify(tool, {}, "live")
    expect(verdict).toMatchObject({ class: "refused", listed: false, code: tool.startsWith("candle_lab_") ? "USE_HACC_LAB" : "NEEDS_TOKEN_PAGES_SCOPE" })
  }
})
