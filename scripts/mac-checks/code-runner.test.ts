import { expect, test } from "bun:test"
import { holdSupport } from "../../src/core/hold"
import { selfCommand } from "../../src/engine/registry"
import { checksSelf, codeRunnerCheck } from "./code-runner"

const support = await holdSupport()

test.skipIf(!support.ok)("every runtime found is held to the research folder, through research_run, by the Candle Harness's own stage", async () => {
  const r = await codeRunnerCheck({ self: selfCommand() })
  for (const rt of r.runtimes.filter((x) => x.ran)) {
    expect(rt.leaked).toEqual([])
    expect(rt.controls).toBe(true)
    expect(rt.held.length).toBeGreaterThanOrEqual(12)
    // A child that tried to take a session of its own went with the run.
    expect(rt.leftRunning).toEqual([])
    expect(rt.held.some((l) => l.startsWith("held a unix socket at a path outside"))).toBe(true)
    if (rt.program === "python3" && process.platform === "linux") {
      for (const route of ["a UDP send", "a session of its own", "a process group of its own", "socket() by another calling convention's number"]) expect(rt.held.some((l) => l.startsWith(`held ${route}`))).toBe(true)
    }
  }
  expect(r.outside).toEqual([])
  expect(r.runtimes.some((x) => x.ran)).toBe(true)
  expect(r.pass).toBe(true)
}, 60_000)

test.skipIf(!support.ok)("the mac-checks binary's own stage holds the same", async () => {
  const r = await codeRunnerCheck({ self: checksSelf(), runtimes: ["python3"] })
  expect(r.pass).toBe(true)
}, 30_000)

test.skipIf(!support.ok || process.platform !== "linux")("the check catches a broken hold: a stage that runs the program unheld leaks, and fails", async () => {
  // run-held <folder> <reads> -- <program> [args…], entered as the real stage enters it and run with no hold at all.
  const r = await codeRunnerCheck({ self: ["/bin/sh", "-c", 'cd "$2"; shift 4; exec "$@"', "stage"], runtimes: ["python3"] })
  expect(r.pass).toBe(false)
  expect(r.runtimes[0]!.leaked.length).toBeGreaterThan(5)
  // Unheld, the child that took a session of its own outlives its run, and the check sees it (and ends it).
  expect(r.runtimes[0]!.leftRunning?.length).toBeGreaterThan(0)
}, 30_000)
