// The released CLI's Read-key handshake checks the source fixture without pretending that the
// four profile-edit tools, which this key was not eligible to list, were observed in the capture.
import { expect, test } from "bun:test"
import released from "../../test/fixtures/candle-cli-release/cli-v0.13.28-read-handshake.json"
import source from "../../test/fixtures/candle-tools.json"
import { LISTED_AFTER_KEY_CHECK } from "../../scripts/scrub-recordings"
import { MIN_CANDLE_CLI } from "./cli-table"
import { argumentDrift, classificationDrift, unclassifiedTools } from "./classify"
import { canonicalJson } from "../shared/canonical-json"

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
  expect(classificationDrift(reconciled.map((t) => t.name))).toEqual([])
  expect(argumentDrift(reconciled)).toEqual([])
})
