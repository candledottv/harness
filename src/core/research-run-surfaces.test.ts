// The Linux hold's caps and the kernel surfaces it shuts, from inside a held script. Linux only (a 6.12 kernel with
// Landlock and python3): on macOS and elsewhere it's skipped, and the filter itself is checked in hold.test.ts.
import { afterAll, expect, test } from "bun:test"
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selfCommand } from "../engine/registry"
import { HOLD_FILE_LIMIT, holdSupport } from "./hold"
import { researchRun } from "./research-run"

const support = await holdSupport()
const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-surfaces-")))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PROBE = `import ctypes, errno, os, resource, threading
libc = ctypes.CDLL(None, use_errno=True)
NR = {"x86_64": dict(unshare=272, bpf=321, perf=298, uffd=323, keyctl=250, clone3=435),
      "aarch64": dict(unshare=97, bpf=280, perf=241, uffd=282, keyctl=219, clone3=435)}[os.uname().machine]
def call(name, *args):
    r = libc.syscall(NR[name], *args)
    return "ok" if r >= 0 else errno.errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))
print("unshare", call("unshare", 0x10000000))
print("bpf", call("bpf", 0, 0, 0))
print("perf", call("perf", 0, 0, -1, -1, 0))
print("uffd", call("uffd", 0))
print("keyctl", call("keyctl", 0, 0))
print("clone3", call("clone3", 0, 0))
try:
    os.unshare(os.CLONE_NEWUSER)
    print("os.unshare ok")
except OSError as e:
    print("os.unshare", errno.errorcode[e.errno])
print("fsize", resource.getrlimit(resource.RLIMIT_FSIZE)[0])
print("nproc", resource.getrlimit(resource.RLIMIT_NPROC)[0])
t = threading.Thread(target=lambda: None); t.start(); t.join()
pid = os.fork()
if pid == 0:
    os._exit(7)
print("fork", os.waitpid(pid, 0)[1] >> 8)
`

test.skipIf(!support.ok || process.platform !== "linux" || !Bun.which("python3"))(
  "a held script can't unshare, reach bpf, perf, userfaultfd or keys, gets ENOSYS from clone3, and has its file size and processes capped; threads and fork still work",
  async () => {
    const research = join(dir, "research")
    const home = join(dir, "home")
    for (const d of [research, home]) await Bun.$`mkdir -p ${d}`.quiet()
    const r = await researchRun({ root: research, programs: ["python3"], args: { program: "python3", code: PROBE }, path: process.env.PATH, home, self: selfCommand() })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = Object.fromEntries(String(r.body.stdout).trim().split("\n").map((l) => l.split(" ") as [string, string]))
    for (const call of ["unshare", "bpf", "perf", "uffd", "keyctl", "os.unshare"]) expect(out[call]).toBe("EPERM")
    expect(out.clone3).toBe("ENOSYS")
    expect(Number(out.fsize)).toBe(HOLD_FILE_LIMIT)
    expect(Number(out.nproc)).toBeGreaterThan(0)
    expect(Number(out.nproc)).toBeLessThan(1_000_000)
    expect(out.fork).toBe("7")
  },
  30_000,
)

test.skipIf(!support.ok || process.platform !== "linux")(
  "a held program starts with only its three standard streams: a file the stage was handed or opened is closed at exec",
  async () => {
    const held = join(dir, "held-fds")
    await Bun.$`mkdir -p ${held}`.quiet()
    const extra = openSync("/etc/hostname", "r")
    try {
      const stage = Bun.spawn([...selfCommand(), "run-held", held, "", "--", "/bin/ls", "/proc/self/fd"], { cwd: "/", stdio: ["ignore", "pipe", "pipe", extra] })
      const [out, err] = await Promise.all([new Response(stage.stdout).text(), new Response(stage.stderr).text()])
      expect(await stage.exited).toBe(0)
      expect(err).toBe("")
      // 0, 1 and 2, and the one ls opened to read the folder.
      expect(out.trim().split("\n").map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    } finally {
      closeSync(extra)
    }
  },
  30_000,
)
