import { describe, expect, test } from "bun:test"
import fixture from "../../test/fixtures/candle-tools.json"
import { type CardKind, classify, normaliseForMode, pausedMessage, pausedStops, resultWasPaper, TOOL_CLASSES } from "./classify"
import type { Side } from "./limits"

const READS = [
  "candle_get_market",
  "candle_get_feed",
  "candle_vamp_candidates",
  "candle_token_forensics",
  "candle_get_agent_profile",
  "candle_list_agents",
  "candle_list_agent_posts",
  "candle_get_plans",
  "candle_get_wallets",
  "candle_get_profile_wallets",
  "candle_get_profile_pnl",
  "candle_get_profile_trades",
  "candle_get_portfolio",
  "candle_resolve_token",
  "candle_execution_status",
  "candle_get_operation",
  "candle_get_fees",
  "candle_get_staking",
  "candle_perps_markets",
  "candle_perps_market",
  "candle_perps_book",
  "candle_perps_candles",
  "candle_perps_orders",
  "candle_perps_positions",
  "candle_perps_fills",
  "candle_perps_funding",
  "candle_perps_account",
  "candle_perps_risk",
  "candle_perps_thresholds",
]
const CARD_TOOLS = [
  "candle_launch_token",
  "candle_launch_and_seed",
  "candle_stake",
  "candle_unstake",
  "candle_finish_unstake",
  "candle_claim_fees",
  "candle_claim_staking_reward",
  "candle_update_profile",
  "candle_upload_profile_image",
  "candle_create_post",
  "candle_delete_post",
]
const PERPS_WRITES = [
  "candle_perps_setup",
  "candle_perps_open",
  "candle_perps_close",
  "candle_perps_cancel",
  "candle_perps_leverage",
  "candle_perps_modify",
  "candle_perps_margin",
  "candle_perps_tpsl",
  "candle_perps_schedule_cancel",
  "candle_perps_flatten",
  "candle_perps_reduce_only",
  "candle_perps_deposit",
  "candle_perps_set_thresholds",
]

describe("the table", () => {
  test("every read is a read, in either mode", () => {
    for (const name of READS) {
      expect(classify(name, {}, "live")).toEqual({ class: "read" })
      expect(classify(name, {}, "paper")).toEqual({ class: "read" })
    }
  })

  test("candle_report_activity stays refused: Candle records every trade the Candle Harness runs, TEE ones by candle swap", () => {
    const verdict = classify("candle_report_activity", {}, "live")
    expect(verdict).toMatchObject({ class: "refused", code: "NOT_NEEDED", listed: false })
    expect(verdict.class === "refused" && verdict.reason).toContain("candle swap")
  })

  test("launches, staking, claims, profile edits and posts are one-press cards in live mode", () => {
    const expected: Record<string, [string, string]> = {
      candle_launch_token: ["launch", "clientLaunchId"],
      candle_launch_and_seed: ["launch", "clientLaunchId"],
      candle_stake: ["stake", "clientStakeId"],
      candle_unstake: ["stake", "clientStakeId"],
      candle_finish_unstake: ["stake", "clientStakeId"],
      candle_claim_fees: ["claim", "coreOpId"],
      candle_claim_staking_reward: ["claim", "coreOpId"],
      candle_update_profile: ["public", "coreOpId"],
      candle_upload_profile_image: ["public", "coreOpId"],
      candle_create_post: ["public", "coreOpId"],
      candle_delete_post: ["public", "coreOpId"],
    }
    expect(Object.keys(expected).sort()).toEqual([...CARD_TOOLS].sort())
    for (const name of CARD_TOOLS) {
      const [kind, idKey] = expected[name]!
      expect(`${name}: ${JSON.stringify(classify(name, {}, "live"))}`).toBe(`${name}: ${JSON.stringify({ class: "card", kind, idKey })}`)
    }
  })

  test("in paper mode each of them is refused: none has a paper form", () => {
    for (const name of CARD_TOOLS) {
      const verdict = classify(name, {}, "paper")
      expect(`${name}: ${verdict.class === "refused" ? verdict.code : verdict.class}`).toBe(`${name}: NO_PAPER_FORM`)
      expect(verdict.class === "refused" && verdict.reason).toContain("switch to live")
      expect(verdict.class === "refused" && verdict.listed).toBe(true)
    }
  })

  test("a dry run spends nothing, so it runs at once as a read in either mode; only boolean true is one", () => {
    const dryRunTools = ["candle_launch_token", "candle_launch_and_seed", "candle_stake", "candle_unstake", "candle_finish_unstake", "candle_claim_fees"]
    for (const name of dryRunTools) {
      for (const mode of ["live", "paper"] as const) expect(`${name} ${mode}: ${classify(name, { dryRun: true }, mode).class}`).toBe(`${name} ${mode}: read`)
      for (const dryRun of [false, "true", 1]) expect(`${name} ${String(dryRun)}: ${classify(name, { dryRun }, "live").class}`).toBe(`${name} ${String(dryRun)}: card`)
    }
    // A staking reward claim and the public writes have no dry run: dryRun changes nothing.
    for (const name of ["candle_claim_staking_reward", "candle_create_post", "candle_update_profile", "candle_delete_post"]) {
      expect(classify(name, { dryRun: true }, "live").class).toBe("card")
    }
  })

  test("perps writes come later", () => {
    for (const name of PERPS_WRITES) {
      const verdict = classify(name, {}, "live")
      expect(verdict).toMatchObject({ class: "refused", code: "NOT_YET_SUPPORTED" })
      expect(verdict.class === "refused" && verdict.reason).toContain("perps come later")
    }
  })

  test("transfers and sweeps are refused here: they go through the CLI's funds-out rule", () => {
    for (const name of ["candle_transfer", "candle_sweep"]) {
      const verdict = classify(name, { to: "anywhere", amountRaw: "max" }, "live")
      expect(verdict).toMatchObject({ class: "refused", code: "TRANSFER_USER_ONLY" })
      expect(verdict.class === "refused" && verdict.listed).toBe(false)
    }
  })

  test("live trades and swaps are one-press cards with their own id fields", () => {
    expect(classify("candle_trade", { side: "buy" }, "live")).toEqual({ class: "card", kind: "trade", idKey: "clientTradeId" })
    expect(classify("candle_swap", {}, "live")).toEqual({ class: "card", kind: "swap", idKey: "clientSwapId" })
  })

  test("narrowing a key's wallets is a less-access card in either mode", () => {
    for (const mode of ["live", "paper"] as const) {
      expect(classify("candle_set_profile_wallets", {}, mode)).toEqual({ class: "card", kind: "lessaccess", idKey: "coreOpId" })
    }
  })

  test("a tool the table doesn't know is an unknown card, never a read; prototype names too", () => {
    for (const name of ["candle_future_tool", "toString", "__proto__", "constructor"]) {
      expect(classify(name, {}, "live")).toEqual({ class: "card", kind: "unknown", idKey: "coreOpId" })
      expect(classify(name, {}, "paper")).toEqual({ class: "card", kind: "unknown", idKey: "coreOpId" })
    }
  })
})

describe("paper means paper", () => {
  const values: [string, unknown][] = [
    ["true", "true"],
    ["1", 1],
    ['"1"', "1"],
    ["boolean true", true],
    ["false", false],
    ["absent", undefined],
  ]

  test("in paper mode every trade is paper, whatever the agent sent, and is sent as boolean true", () => {
    for (const [label, paper] of values) {
      const args = paper === undefined ? { side: "buy" } : { side: "buy", paper }
      expect(`${label}: ${JSON.stringify(classify("candle_trade", args, "paper"))}`).toBe(`${label}: {"class":"paper"}`)
      expect(normaliseForMode("candle_trade", args, "paper")).toEqual({ side: "buy", paper: true })
    }
  })

  test("in live mode a truthy paper flag is refused, and anything else is removed before sending", () => {
    for (const [label, paper] of values) {
      const args = paper === undefined ? { side: "buy" } : { side: "buy", paper }
      const verdict = classify("candle_trade", args, "live")
      const truthy = paper === true || paper === "true" || paper === 1 || paper === "1"
      if (truthy) {
        expect(`${label}: ${verdict.class}`).toBe(`${label}: refused`)
        expect(verdict.class === "refused" && verdict.reason).toContain("switch to paper mode")
      } else {
        expect(`${label}: ${verdict.class}`).toBe(`${label}: card`)
        expect(normaliseForMode("candle_trade", args, "live")).toEqual({ side: "buy" })
      }
    }
  })

  test("swaps have no paper mode", () => {
    const verdict = classify("candle_swap", { from: "SOL", to: "USDC", amount: "1" }, "paper")
    expect(verdict).toMatchObject({ class: "refused", code: "NO_PAPER_SWAPS" })
    expect(verdict.class === "refused" && verdict.reason).toContain("swaps have no paper mode")
  })

  test("normalising leaves the agent's object alone and touches only candle_trade", () => {
    const args = { side: "buy", paper: "1" }
    normaliseForMode("candle_trade", args, "paper")
    expect(args).toEqual({ side: "buy", paper: "1" })
    expect(normaliseForMode("candle_swap", { from: "SOL", paper: true }, "live")).toEqual({ from: "SOL", paper: true })
  })

  test("a result the server turned to paper is recognised", () => {
    expect(resultWasPaper({ clientTradeId: "t", resolved: { percent: 50 }, api: { success: true, data: { paper: true } } })).toBe(true)
    expect(resultWasPaper({ clientTradeId: "t", api: { success: true, data: { status: "confirmed", signature: "S" } } })).toBe(false)
    expect(resultWasPaper(undefined)).toBe(false)
  })
})

describe("what the kill switch stops", () => {
  // Paused, it withdraws and refuses what spends or publishes, and keeps what only takes value out or
  // takes something down.
  const rows: [string, { kind: CardKind; tool: string; side?: Side }, boolean][] = [
    ["a buy", { kind: "trade", tool: "candle_trade", side: "buy" }, true],
    ["a sell", { kind: "trade", tool: "candle_trade", side: "sell" }, false],
    ["a swap", { kind: "swap", tool: "candle_swap", side: "swap" }, true],
    ["a launch", { kind: "launch", tool: "candle_launch_token" }, true],
    ["a launch with a seed", { kind: "launch", tool: "candle_launch_and_seed", side: "buy" }, true],
    ["a stake", { kind: "stake", tool: "candle_stake" }, true],
    ["an unstake", { kind: "stake", tool: "candle_unstake" }, false],
    ["finishing an unstake", { kind: "stake", tool: "candle_finish_unstake" }, false],
    ["a fee claim", { kind: "claim", tool: "candle_claim_fees" }, false],
    ["a staking reward claim", { kind: "claim", tool: "candle_claim_staking_reward" }, false],
    ["a profile edit", { kind: "public", tool: "candle_update_profile" }, true],
    ["a new post", { kind: "public", tool: "candle_create_post" }, true],
    ["deleting a post", { kind: "public", tool: "candle_delete_post" }, false],
    ["less access", { kind: "lessaccess", tool: "candle_set_profile_wallets" }, false],
  ]
  for (const [label, card, stops] of rows) {
    test(`${label}: ${stops ? "stopped" : "kept"}`, () => {
      expect(pausedStops(card)).toBe(stops)
      if (stops) expect(pausedMessage(card)).toContain("kill switch")
    })
  }
})

describe("drift against Candle's tools", () => {
  const names = fixture.tools.map((t) => t.name)

  test("every tool in the recorded list is classified, and nothing classified is invented", () => {
    expect(names.filter((n) => !Object.hasOwn(TOOL_CLASSES, n))).toEqual([])
    expect(Object.keys(TOOL_CLASSES).filter((n) => !names.includes(n))).toEqual([])
  })
})
