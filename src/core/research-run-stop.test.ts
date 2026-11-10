// The code runner's stop, and the calls its hold refuses, run for real: a script that tries to leave its process
// group can't outlive the stop, a pipe left open never holds the agent's next run, and no socket of any kind is
// made, by the usual call numbers or another calling convention's.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selfCommand } from "../engine/registry"
import { holdSupport } from "./hold"
import { elapsed, parsePs, parseStrayPs, ProcessTree, researchRun, RUN_OUTPUT_GRACE_MS, sandboxStrays } from "./research-run"

const held = (await holdSupport()).ok && process.platform === "linux" && Bun.which("python3") !== null
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const folder = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "chrn-run-stop-")))
  dirs.push(d)
  return d
}
const run = (root: string, code: string, timeoutMs = 3000) =>
  researchRun({ root, programs: ["python3"], args: { program: "python3", code }, path: process.env.PATH, home: process.env.HOME, self: selfCommand(), timeoutMs })

/** The pids of processes whose command line names `marker`, by /proc. */
function running(marker: string): number[] {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,args="]).stdout.toString()
  return out
    .split("\n")
    .filter((l) => l.includes(marker) && !l.includes("ps -A"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
}

// A child that tries to take a session and a group of its own, then sleeps under a name the test can find.
const ESCAPE = (marker: string, keepPipe: boolean) => `import os, sys, time
if os.fork() == 0:
    for leave in (os.setsid, lambda: os.setpgid(0, 0)):
        try:
            leave()
            print("left", flush=True)
        except OSError as e:
            print("refused", e.errno, flush=True)
    ${keepPipe ? "pass" : "os.close(1); os.close(2)"}
    os.execv(sys.executable, [sys.executable, "-c", "import time; time.sleep(25) # ${marker}"])
time.sleep(0.3)
`

test.skipIf(!held)("a script's child can't leave the process group, so it's gone when the run ends", async () => {
  const marker = `chrn-escape-${process.pid}-a`
  const r = await run(folder(), ESCAPE(marker, false))
  if (!r.ok) throw new Error(r.message)
  // Both ways out are refused with EPERM (1).
  expect(r.body.stdout).toBe("refused 1\nrefused 1\n")
  await Bun.sleep(200)
  expect(running(marker)).toEqual([])
}, 20_000)

test.skipIf(!held)("a child that keeps the output pipe open doesn't hold the run, or the agent's next one", async () => {
  const marker = `chrn-escape-${process.pid}-b`
  const root = folder()
  const started = Date.now()
  const r = await run(root, ESCAPE(marker, true), 10_000)
  const took = Date.now() - started
  if (!r.ok) throw new Error(r.message)
  // The script itself ended after 0.3 s: the answer comes then, not when the sleeping child lets the pipe go.
  expect(took).toBeLessThan(3000 + RUN_OUTPUT_GRACE_MS)
  expect(r.body.exitCode).toBe(0)
  expect(r.body.stopped).toBeUndefined()
  await Bun.sleep(200)
  expect(running(marker)).toEqual([])
  const next = await run(root, "print('next')")
  expect(next.ok && next.body.stdout).toBe("next\n")
}, 30_000)

test.skipIf(!held)("no socket by any route: UDP, a unix socket for a path, or socket() under another calling convention's number", async () => {
  const code = `import ctypes, os, socket
def t(name, f):
    try:
        f()
        print("LEAK", name)
    except OSError as e:
        print("held", name, e.errno)
t("udp", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
t("unix", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
r = libc.syscall(ctypes.c_long(0x40000029), ctypes.c_long(2), ctypes.c_long(2), ctypes.c_long(0))
print("other-abi", r, ctypes.get_errno())
`
  const r = await run(folder(), code)
  if (!r.ok) throw new Error(r.message)
  // EPERM (1) from the filter each time: never ENOSYS (38) from the kernel, which would mean the call got through.
  expect(r.body.stdout).toBe("held udp 1\nheld unix 1\nother-abi -1 1\n")
}, 20_000)

test("following what a program started: its group, its children's children, and one that took its own session", () => {
  const tree = new ProcessTree(100)
  const ps = (text: string) => parsePs(text)
  // 100 is the program; 101 its child in the group; 102 took its own group and session; 103 is 102's child.
  const first = ps("  1 0 1 900\n 50 1 50 100\n100 50 100 2000\n101 100 100 1000\n102 100 102 3000\n103 102 102 500\n 77 1 77 9999\n")
  tree.see(first)
  expect(tree.alive(first).sort()).toEqual([100, 101, 102, 103])
  expect(tree.rss(first)).toBe((2000 + 1000 + 3000 + 500) * 1024)
  // The program and 102 have gone: 103 was handed to the first process, and is still followed.
  const later = ps("  1 0 1 900\n 50 1 50 100\n103 1 102 500\n 77 1 77 9999\n")
  expect(tree.alive(later)).toEqual([103])
  tree.see(later)
  expect(tree.alive(later)).toEqual([103])
  // 101's number, given later to some other process's child, isn't taken for it; nor is one never followed.
  const reused = ps("  1 0 1 900\n101 77 77 400\n 77 1 77 9999\n")
  expect(tree.alive(reused)).toEqual([])
  tree.see(reused)
  expect(tree.alive(reused)).toEqual([])
})

test("ps's rows are read as numbers, and anything else is left out", () => {
  expect(parsePs(" 12  1 12 340\nheader line\n 13 12 12 x\n\n")).toEqual([{ pid: 12, ppid: 1, pgid: 12, rssKb: 340 }])
})

test("the macOS sweep: a process of the person's in this run's sandbox, started during the run, from a folder the hold runs, its parent gone, and its children", async () => {
  expect(elapsed("05")).toBeNaN()
  expect(elapsed("00:07")).toBe(7)
  expect(elapsed("01:02:03")).toBe(3723)
  expect(elapsed("2-00:00:01")).toBe(172801)
  const rows = parseStrayPs(
    [
      "  1     0   0 04-21:24:56 /sbin/launchd",
      // The double fork's sleeper: handed to the first process, in a sandbox, a runtime the hold runs.
      "300     1 501       00:03 /opt/py/bin/python3.12",
      // What it started.
      "301   300 501       00:02 /bin/sleep",
      // Started before the run began.
      "310     1 501       09:00 /opt/py/bin/python3.12",
      // Another user's.
      "320     1   0       00:03 /usr/libexec/something",
      // Not in a sandbox: the person's own shell, started meanwhile.
      "330     1 501       00:01 /bin/zsh",
      // In a sandbox, but a program the hold never runs (an app's own helper).
      "340     1 501       00:02 /System/Library/Frameworks/X.framework/helper",
      // Its parent alive and not a stray: the tree's business, not the sweep's.
      "350   999 501       00:02 /usr/bin/python3",
      // A path with a space, under the folder.
      "360     1 501       00:01 /Users/you/research folder/link to python",
      // In another sandbox (a decoy started by hand with sandbox-exec, another run's), though it fits every other rule.
      "370     1 501       00:02 /bin/sleep",
      // What that one started.
      "371   370 501       00:01 /bin/sleep",
      "header line",
    ].join("\n"),
  )
  // The processes macOS says are held by this run's profile; 370 and 371 are in a sandbox, but another's.
  const ours = new Set([300, 301, 310, 320, 340, 350, 360])
  const strays = await sandboxStrays(rows, { uid: 501, ranSeconds: 5, roots: ["/usr/bin", "/bin", "/usr/libexec", "/Users/you/research folder", "/opt/py"], self: 50 }, async (pid) => ours.has(pid))
  expect(strays.sort()).toEqual([300, 301, 360])
  // A root names a folder, not a prefix of one.
  expect(await sandboxStrays(rows, { uid: 501, ranSeconds: 5, roots: ["/opt/p"], self: 50 }, async (pid) => ours.has(pid))).toEqual([])
})
