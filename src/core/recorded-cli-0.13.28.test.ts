// The released CLI's Read-key handshake checks the source fixture without pretending that the
// four profile-edit tools, which this key was not eligible to list, were observed in the capture.
import { expect, test } from "bun:test"
import released from "../../test/fixtures/candle-cli-release/cli-v0.13.28-read-handshake.json"
// What the published CLI 0.13.28 ships is MCP 0.10.33: the source at that release, kept as it was. The current
// source (candle-tools.json: MCP 0.10.34's per-order hide, then builder-dex perps and three keyless perps reads)
// is checked against it in the last test below.
import source from "../../test/fixtures/candle-cli-release/source-mcp-0.10.33-tools.json"
import current from "../../test/fixtures/candle-tools.json"
import { LISTED_AFTER_KEY_CHECK } from "../../scripts/scrub-recordings"
import { MIN_CANDLE_CLI } from "./cli-table"
import { argumentDrift, CARD_TOOL_ARGS, classificationDrift, TOOL_CLASSES, unclassifiedTools } from "./classify"
import { canonicalJson } from "../shared/canonical-json"

/** The keyless perps reads the source lists after the released CLI 0.13.28 (MCP 0.10.33). */
const NEWER_THAN_RELEASE = ["candle_get_agent_open_orders", "candle_get_agent_perp_round", "candle_get_perp_candles"] as const

test("the released Read-key recording pins the CLI and MCP versions separately", () => {
  expect(released.cliVersion).toBe("0.13.28")
  expect(released.cliVersion).toBe(MIN_CANDLE_CLI)
  expect(released.serverInfo).toEqual({ name: "candle-mcp", version: "0.10.33" })
  expect(released.serverInfo).toEqual(source.serverInfo)
  expect(released.recording.route).toBe("cli")
  expect(released.recording.status).toEqual({ state: "ready", version: released.serverInfo.version })
  expect(released.provenance.argv).toEqual(["mcp"])
  expect(released.provenance.requests).toEqual(["initialize", "tools/list"])
  expect(released.provenance.apiHost).toBe("staging.api.candle.tv")
})

test("all 96 released definitions match their source schemas, descriptions and annotations", () => {
  expect(released.recording.tools).toHaveLength(96)
  const names = released.recording.tools.map((t) => t.name)
  expect(new Set(names).size).toBe(names.length)
  expect(unclassifiedTools(names)).toEqual([])
  for (const tool of released.recording.tools) {
    const expected = source.tools.find((t) => t.name === tool.name)
    expect(expected).toBeDefined()
    expect(canonicalJson(tool)).toBe(canonicalJson(expected))
  }
  for (const name of ["candle_signal_records", "candle_signal_record", "candle_signal_scorecard"]) {
    expect(names).toContain(name)
  }
})

test("only the four conditional profile tools remain source-only, with no classification or card-argument drift", () => {
  const names = new Set(released.recording.tools.map((t) => t.name))
  const sourceOnly = source.tools.filter((t) => !names.has(t.name))
  expect(sourceOnly.map((t) => t.name).sort()).toEqual([...LISTED_AFTER_KEY_CHECK].sort())
  for (const tool of sourceOnly) expect(tool).toMatchObject({ listedAfterKeyCheck: true })
  const reconciled = [...released.recording.tools, ...sourceOnly]
  // The table also holds the three perp-page reads that came after 0.10.33 (BE-3756); the released CLI has none.
  const perpPages = ["candle_get_agent_perp_round", "candle_get_agent_open_orders", "candle_get_perp_candles"]
  const releasedTable = Object.fromEntries(Object.entries(TOOL_CLASSES).filter(([tool]) => !perpPages.includes(tool)))
  expect(classificationDrift(reconciled.map((t) => t.name), releasedTable)).toEqual([])
  // The table already lists `hide` for the CLI release to come (MCP 0.10.34); the released 0.10.33 has none.
  const released0_10_33 = Object.fromEntries(Object.entries(CARD_TOOL_ARGS).map(([tool, args]) => [tool, args.filter((a) => a !== "hide")]))
  expect(argumentDrift(reconciled, released0_10_33)).toEqual([])
})

test("the current source differs from the released 0.10.33 by per-order hide, builder-dex perps and three new reads", () => {
  expect(current.serverInfo).toEqual({ name: "candle-mcp", version: "0.10.35" })
  expect(current.tools.map((t) => t.name).filter((n) => !source.tools.some((t) => t.name === n)).sort()).toEqual([...NEWER_THAN_RELEASE].sort())
  expect(current.tools).toHaveLength(source.tools.length + NEWER_THAN_RELEASE.length)
  // The atomic launch dry run is a read and takes hide too, to check the echo before a hidden launch.
  const withHide = ["candle_atomic_launch_dry_run", "candle_launch_and_seed", "candle_launch_token", "candle_swap", "candle_trade"]
  for (const tool of current.tools) {
    const before = source.tools.find((t) => t.name === tool.name)
    if (!before) continue
    const props = Object.keys(tool.inputSchema.properties)
    const was = Object.keys(before.inputSchema.properties)
    if (withHide.includes(tool.name)) expect(props.filter((p) => !was.includes(p))).toEqual(["hide"])
    // Builder-deployed (HIP-3) markets: the market list takes a dex filter; every other perps tool keeps its arguments.
    else if (tool.name === "candle_perps_markets") expect(props.filter((p) => !was.includes(p))).toEqual(["dex"])
    else expect(props).toEqual(was)
    expect(was).not.toContain("hide")
    expect(was).not.toContain("dex")
  }
  // The released CLI's tools/list has no hide: the Harness's argument table already allows it for the release to come.
  for (const tool of released.recording.tools) expect(Object.keys(tool.inputSchema.properties)).not.toContain("hide")
})
