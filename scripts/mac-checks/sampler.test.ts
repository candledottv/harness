// The resource sampler's reading and summing.
import { expect, test } from "bun:test"
import { cpuSeconds, descendants, intervals, isView, midnights, parsePs, type Sample, slopePerHour, summarise } from "./sampler"

test("ps's CPU time, as macOS and Linux print it", () => {
  expect(cpuSeconds("0:01.50")).toBeCloseTo(1.5)
  expect(cpuSeconds("12:03.25")).toBeCloseTo(723.25)
  expect(cpuSeconds("1:02:03")).toBe(3723)
  expect(cpuSeconds("00:00:07")).toBe(7)
  expect(cpuSeconds("2-01:00:00")).toBe(2 * 86_400 + 3600)
})

test("the Candle Harness's views are told from its core, its MCP shim and its pane runs, from the binary or from source", () => {
  expect(isView("/usr/local/bin/candle-harness")).toBe(true)
  expect(isView("candle-harness view --pane wallets")).toBe(true)
  expect(isView("candle-harness setup")).toBe(true)
  expect(isView("/opt/bun/bin/bun /opt/src/candle-harness-app/src/main.ts view")).toBe(true)
  expect(isView("/usr/local/bin/candle-harness core --exit-when-idle")).toBe(false)
  expect(isView("candle-harness mcp --token-file /x")).toBe(false)
  expect(isView("candle-harness cli-pane")).toBe(false)
  expect(isView("bun /opt/src/candle-harness-app/scripts/mac-checks/sampler.ts")).toBe(false)
  expect(isView("bun test /opt/src/candle-harness-app/src")).toBe(false)
})

test("ps's lines, and every descendant of the core", () => {
  const procs = parsePs("  10     1 204800  0:05.00 /bin/candle-harness core --exit-when-idle\n  11    10  51200  0:01.00 candle mcp\n  12    11  10240  0:00.10 helper\n  13     1 307200  1:00.00 /bin/candle-harness\n")
  expect(procs.map((p) => p.pid)).toEqual([10, 11, 12, 13])
  expect(descendants(procs, 10).map((p) => p.pid).sort()).toEqual([11, 12])
})

const at = (min: number) => Date.UTC(2026, 10, 1, 22, 0) + min * 60_000
const usage = (since: number, calls: number, bytes: number, hacc: number) => ({ since, at: 0, candle: { "agent-a": { calls, bytes } }, hacc: { requests: hacc, bytes: hacc * 1024 }, stream: { frames: 0, bytes: 0 }, reading: { lists: ["onfire"], stream: "closed", pnlPerMin: 1, research: 0, budget: [] } })
const sample = (min: number, o: { cpuS?: number; rssKb?: number; pid?: number; calls?: number; since?: number } = {}): Sample => ({
  at: at(min),
  awake: true,
  core: { pid: o.pid ?? 10, rssKb: o.rssKb ?? 100 * 1024, cpuS: o.cpuS ?? min * 0.6 },
  children: { count: 1, rssKb: 50 * 1024, cpuS: 0 },
  views: [{ pid: 20, rssKb: 150 * 1024, cpuS: min * 1.2, command: "candle-harness" }],
  usage: usage(o.since ?? 1, o.calls ?? min * 6, (o.calls ?? min * 6) * 512, min),
  journalBytes: 1024 * (100 + min),
})

test("each minute's CPU and fetches, and nothing across a gap or a new core", () => {
  const ivs = intervals([sample(0), sample(1), sample(2), sample(10), sample(11, { pid: 99, since: 2, calls: 3 })])
  // 2 to 10 is a gap; 10 to 11 is a new core, so only the views' CPU counts there.
  expect(ivs).toHaveLength(3)
  expect(ivs[2]!.coreCpu).toBeUndefined()
  expect(ivs[2]!.candle).toEqual({})
  expect(ivs[2]!.viewCpu).toBeCloseTo(2)
  expect(ivs[0]!.coreCpu).toBeCloseTo(1)
  expect(ivs[0]!.viewCpu).toBeCloseTo(2)
  expect(ivs[0]!.candle["agent-a"]!.calls).toBeCloseTo(6)
  expect(ivs[0]!.candle["agent-a"]!.kb).toBeCloseTo(3)
  expect(ivs[0]!.hacc!.requests).toBeCloseTo(1)
})

test("the climb an hour, and the midnights a window crosses", () => {
  expect(slopePerHour([{ at: 0, y: 100 }, { at: 1_800_000, y: 110 }, { at: 3_600_000, y: 120 }])).toBeCloseTo(20)
  const m = midnights(Date.UTC(2026, 10, 1, 20), Date.UTC(2026, 10, 2, 8))
  expect(m.utc).toEqual([Date.UTC(2026, 10, 2)])
  expect(m.local).toHaveLength(1)
})

test("the summary names every gap over two minutes, the hours covered and the day's boundaries", () => {
  const samples = [0, 1, 2, 3, 30, 31, 32].map((m) => sample(m, { rssKb: (100 + m) * 1024 }))
  const text = summarise(samples, { file: "x.jsonl", host: "test", plannedHours: 12 })
  expect(text).toContain("**0.53 hours covered** of 12 planned, 7 samples")
  expect(text).toContain("Gaps over two minutes (1):")
  expect(text).toContain("(27 min)")
  expect(text).toContain("00:00 UTC **not crossed**")
  expect(text).toMatch(/\| core \| 1\.00% \|/)
  expect(text).toContain("| Candle, agent-a | 6.0 |")
  expect(summarise([0, 1, 2].map((m) => sample(m)), { file: "y" })).toContain("**No gap over two minutes.**")
})
