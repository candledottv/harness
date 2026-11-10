// The drift check: a tool Candle adds fails this until someone decides what it is. The same check runs
// against the real server's tools/list when the core starts (unclassifiedTools).
import { expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-tools.json"
import { DESCRIPTION_BASIS, GET_OPERATION_DESCRIPTION, withReason } from "./tool-face"
import { argumentDrift, CARD_TOOL_ARGS, classificationDrift, classify, HARNESS_TOOL_ARGS, unclassifiedTools, unknownArgument } from "./classify"

const names = fixture.tools.map((t) => t.name)

test("the recorded tool list and the table agree", () => {
  expect(classificationDrift(names)).toEqual([])
})

test("the check fails when Candle's list gains a tool, or the table names one Candle doesn't have", () => {
  expect(classificationDrift([...names, "candle_new_tool"])).toEqual(["unclassified: candle_new_tool"])
  expect(classificationDrift(names.filter((n) => n !== "candle_get_feed"))).toEqual(["not a Candle tool: candle_get_feed"])
})

test("every card tool's argument list equals its recorded schema, so a new argument fails here as a new tool does", () => {
  expect(argumentDrift(fixture.tools)).toEqual([])
})

test("the argument check fails when Candle adds an argument, drops one, or a card tool has no list", () => {
  const grown = fixture.tools.map((t) => (t.name === "candle_trade" ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, payer: { type: "string" } } } } : t))
  expect(argumentDrift(grown)).toEqual(["unlisted argument: candle_trade.payer"])
  expect(argumentDrift(fixture.tools, { ...CARD_TOOL_ARGS, candle_swap: [...CARD_TOOL_ARGS.candle_swap!, "gone"] })).toEqual(["not an argument of candle_swap: gone"])
  const { candle_create_post: _dropped, ...missing } = CARD_TOOL_ARGS
  expect(argumentDrift(fixture.tools, missing)).toEqual(["no argument list: candle_create_post"])
})

test("the Candle Harness's own arguments never shadow one of Candle's, and an unlisted one is named", () => {
  for (const [tool, own] of Object.entries(HARNESS_TOOL_ARGS)) for (const arg of own) expect(CARD_TOOL_ARGS[tool]).not.toContain(arg)
  expect(unknownArgument("candle_trade", { mint: "x", side: "buy", amountUsd: "5", wallet: "embedded" })).toBeUndefined()
  expect(unknownArgument("candle_trade", { mint: "x", payer: "linked" })).toBe("payer")
  expect(unknownArgument("harness_bots", { anything: 1 })).toBeUndefined()
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

test("each description the Candle Harness answers still says what the answer was written against", () => {
  for (const [name, phrases] of Object.entries(DESCRIPTION_BASIS)) {
    const recorded = fixture.tools.find((t) => t.name === name)?.description ?? ""
    for (const phrase of phrases) expect([name, phrase, recorded.includes(phrase)]).toEqual([name, phrase, true])
  }
})

test("the agent is offered Candle's trade tool without the arguments the Candle Harness sets or refuses, and the read in its own states", () => {
  const offered = withReason(fixture.tools as never) as { name: string; description?: string; inputSchema: { properties?: Record<string, unknown> } }[]
  const trade = offered.find((t) => t.name === "candle_trade")!
  expect(Object.keys(trade.inputSchema.properties!)).not.toContain("paper")
  expect(Object.keys(trade.inputSchema.properties!)).not.toContain("deferExecution")
  expect(Object.keys(trade.inputSchema.properties!)).toEqual(expect.arrayContaining(["mint", "side", "amount", "percent", "amountUsd", "wallet", "reason"]))
  expect(trade.description).toContain("In the Candle Harness, where this differs from the above")
  expect(trade.description).toContain("there is no `paper` argument")
  const read = offered.find((t) => t.name === "candle_get_operation")!
  expect(read.description).toBe(GET_OPERATION_DESCRIPTION)
  for (const word of ["awaiting_approval", "APPROVAL_REQUIRED", "OPERATION_PENDING", "CARD_REJECTED", "OUTCOME_UNKNOWN", "OPERATION_NOT_HELD"]) expect(read.description).toContain(word)
  expect(read.description).not.toContain("job.outcome")
  expect(offered.find((t) => t.name === "candle_swap")!.description).toContain("kind: swap")
  // A tool with nothing to add keeps Candle's words.
  expect(offered.find((t) => t.name === "candle_stake")!.description).toBe(fixture.tools.find((t) => t.name === "candle_stake")!.description!)
})
