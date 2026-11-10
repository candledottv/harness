// The code runner's hold, checked with no model: each runtime found (python3, node, bun) runs a probe through
// research_run itself, as the core runs it, and the probe aims at everything outside the research folder: a key
// planted beside the folder and one in the real home, links, ../, /proc, another process's environment, a hard
// link, writes outside, a signal to a process outside, TCP, UDP, a unix socket at a path outside, DNS and fetch,
// Homebrew's settings folder and the key by the data volume's path (macOS), and a session of its own or a socket
// by another calling convention's number (Linux). Every route must be held, and the controls (a read and a write
// inside) must work. Then each runtime starts a child that tries to leave its process group and keeps running:
// nothing of it may be left once the run has ended, nor of a double fork whose middle process ends at once.
// Exit 0 when every runtime found was held; 1 otherwise.
//   mac-checks code-runner [--out <file.json>]
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { holdSupport } from "../../src/core/hold"
import { researchRun } from "../../src/core/research-run"

const PY = `import ctypes, os, signal, socket, sys
outside, home_key, other, unix_path = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
def t(name, f):
    try:
        r = f()
        print(f"LEAK {name}: {str(r)[:60]!r}")
    except Exception as e:
        print(f"held {name}: {type(e).__name__}")
t("a key outside, by its full path", lambda: open(outside + "/fake.key").read())
t("a key in the real home", lambda: open(home_key).read())
t("a link in the folder to the key", lambda: open("link.key").read())
t("a key by ../", lambda: open("../outside/fake.key").read())
t("a key through /proc/self/root", lambda: open("/proc/self/root" + outside + "/fake.key").read())
t("another process's environment", lambda: open(f"/proc/{other}/environ").read())
t("the real home's list", lambda: os.listdir(os.path.dirname(home_key)))
t("/etc/passwd", lambda: open("/etc/passwd").read())
t("a write outside", lambda: open(outside + "/written-from-inside", "w").write("x"))
t("a write through a linked folder", lambda: open("outdir/written-through-link", "w").write("x"))
t("a hard link to the key", lambda: os.link(outside + "/fake.key", "hard.key") or open("hard.key").read())
t("a signal to a process outside", lambda: os.kill(other, signal.SIGTERM) or "sent")
t("a TCP connect", lambda: socket.create_connection(("1.1.1.1", 443), timeout=3))  # scrub-ok: a public resolver, refused
t("a DNS lookup", lambda: socket.getaddrinfo("example.com", 443))
t("a UDP send", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("1.1.1.1", 53)))  # scrub-ok: a public resolver, refused
t("a unix socket at a path outside", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).connect(unix_path) or "connected")
t("Homebrew's settings folder", lambda: os.listdir("/opt/homebrew/etc"))
t("the key by the data volume's path", lambda: open("/System/Volumes/Data" + home_key).read())
if sys.platform == "linux":
    t("a session of its own", lambda: os.setsid() or "left")
    def own_group():
        pid = os.fork()
        if pid == 0:
            try:
                os.setpgid(0, 0)
                os._exit(0)
            except OSError:
                os._exit(7)
        if os.waitpid(pid, 0)[1] >> 8 == 7: raise PermissionError("refused")
        return "left"
    t("a process group of its own", own_group)
    def other_abi():
        libc = ctypes.CDLL(None, use_errno=True)
        libc.syscall.restype = ctypes.c_long
        r = libc.syscall(ctypes.c_long(0x40000029), ctypes.c_long(2), ctypes.c_long(2), ctypes.c_long(0))
        # Refused by the hold is EPERM; a kernel answering it at all, or saying it has no such call, got past the hold.
        if r < 0 and ctypes.get_errno() == 1: raise PermissionError("refused")
        return f"answered {r} errno {ctypes.get_errno()}"
    t("socket() by another calling convention's number", other_abi)
print("control inside read:", open("note.md").read().strip())
open("written.txt", "w").write("ok")
print("control inside write ok")
`

const JS = `import fs from "node:fs"
import net from "node:net"
import dns from "node:dns/promises"
import path from "node:path"
const [outside, homeKey, other, unixPath] = process.argv.slice(2)
const t = async (name, f) => {
  try {
    const r = await f()
    console.log(\`LEAK \${name}: \${JSON.stringify(String(r)).slice(0, 60)}\`)
  } catch (e) {
    console.log(\`held \${name}: \${e.code ?? e.name}\`)
  }
}
await t("a key outside, by its full path", () => fs.readFileSync(outside + "/fake.key", "utf8"))
await t("a key in the real home", () => fs.readFileSync(homeKey, "utf8"))
await t("a link in the folder to the key", () => fs.readFileSync("link.key", "utf8"))
await t("a key by ../", () => fs.readFileSync("../outside/fake.key", "utf8"))
await t("a key through /proc/self/root", () => fs.readFileSync("/proc/self/root" + outside + "/fake.key", "utf8"))
await t("another process's environment", () => fs.readFileSync(\`/proc/\${other}/environ\`, "utf8"))
await t("the real home's list", () => fs.readdirSync(path.dirname(homeKey)))
await t("a write outside", () => fs.writeFileSync(outside + "/written-from-inside", "x"))
await t("a write through a linked folder", () => fs.writeFileSync("outdir/written-through-link", "x"))
await t("a hard link to the key", () => { fs.linkSync(outside + "/fake.key", "hard.key"); return fs.readFileSync("hard.key", "utf8") })
await t("a signal to a process outside", () => { process.kill(Number(other), "SIGTERM"); return "sent" })
await t("a TCP connect", () => new Promise((res, rej) => {
  const s = net.connect(443, "1.1.1.1", () => res("connected")) // scrub-ok: a public resolver, refused
  s.on("error", rej)
  setTimeout(() => rej(new Error("timeout")), 3000)
}))
await t("a DNS lookup", () => dns.lookup("example.com"))
await t("a fetch", () => fetch("https://example.com").then((r) => r.status))
await t("a unix socket at a path outside", () => new Promise((res, rej) => {
  const s = net.connect(unixPath, () => res("connected"))
  s.on("error", rej)
  setTimeout(() => rej(new Error("timeout")), 3000)
}))
await t("Homebrew's settings folder", () => fs.readdirSync("/opt/homebrew/etc"))
await t("the key by the data volume's path", () => fs.readFileSync("/System/Volumes/Data" + homeKey, "utf8"))
console.log("control inside read:", fs.readFileSync("note.md", "utf8").trim())
fs.writeFileSync("written.txt", "ok")
console.log("control inside write ok")
`

// A child that tries to leave the process group (a session of its own) and sleeps on under a name the check can
// find. Where the hold refuses that it stays in the group; where it can't (macOS), the runner follows it. Either
// way nothing named so may be running once the run has ended.
const PY_ESCAPE = `import os, sys, time
marker = sys.argv[1]
if os.fork() == 0:
    try:
        os.setsid()
    except OSError:
        pass
    os.close(1); os.close(2)
    os.execv(sys.executable, [sys.executable, "-c", "import time; time.sleep(120) # " + marker])
time.sleep(1.5)
`
// A double fork: the middle process takes a session of its own, starts the sleeper and ends at once, and so does the
// program, before the runner's first look; the sleeper is handed to the system's first process, in no group of the run.
const PY_DOUBLE_FORK = `import os, sys
marker = sys.argv[1]
if os.fork() == 0:
    try:
        os.setsid()
    except OSError:
        pass
    if os.fork() == 0:
        os.close(0); os.close(1); os.close(2)
        os.execv(sys.executable, [sys.executable, "-c", "import time; time.sleep(120) # " + marker])
    os._exit(0)
`
// The same from node or bun: a shell in a session of its own leaves a sleeper behind and ends, and so does the program.
const JS_DOUBLE_FORK = `import { spawn } from "node:child_process"
const marker = process.argv[2]
try {
  const c = spawn("/bin/sh", ["-c", '"$0" -e "setTimeout(() => {}, 120000) // $1" & exit 0', process.execPath, marker], { detached: true, stdio: "ignore" })
  c.on("error", () => {})
  c.unref()
} catch {}
`
const JS_ESCAPE = `import { spawn } from "node:child_process"
const marker = process.argv[2]
const sleeper = ["-e", "setTimeout(() => {}, 120000) // " + marker]
try {
  const c = spawn(process.execPath, sleeper, { detached: true, stdio: "ignore" })
  c.on("error", () => {})
  c.unref()
} catch {}
// Where a session of its own is refused, the same child in the group: it must go with the group.
try {
  const c = spawn(process.execPath, sleeper, { stdio: "ignore" })
  c.on("error", () => {})
  c.unref()
} catch {}
await new Promise((r) => setTimeout(r, 1500))
`

/** The pids of running processes whose command line holds `marker`. */
function runningAs(marker: string): number[] {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,args="]).stdout.toString()
  return out
    .split("\n")
    .filter((l) => l.includes(marker) && !l.includes("ps -A"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => pid > 0 && pid !== process.pid)
}

const SHIM_SKIPPED = "not installed (Apple's shim; no Command Line Tools), skipped"

export interface RuntimeResult {
  program: string
  ran: boolean
  held: string[]
  leaked: string[]
  controls: boolean
  /** Processes the runtime started that were still running after its run ended (the escape run); empty when held. */
  leftRunning?: number[]
  note?: string
}

export interface CodeRunnerResult {
  support: Awaited<ReturnType<typeof holdSupport>>
  runtimes: RuntimeResult[]
  /** Files a probe wrote outside the folder, or the process outside it a signal stopped. */
  outside: string[]
  pass: boolean
}

/** This program, as the Linux exec stage: the mac-checks binary itself, or Bun running its main.ts. */
export function checksSelf(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, join(import.meta.dir, "main.ts")]
}

/** Runs every probe through research_run, as the core does. `self` runs `run-held` on Linux. */
export async function codeRunnerCheck(o: { self: string[]; runtimes?: string[]; home?: string; path?: string }): Promise<CodeRunnerResult> {
  const support = await holdSupport()
  if (!support.ok) return { support, runtimes: [], outside: [], pass: false }
  const home = o.home ?? process.env.HOME ?? "/tmp"
  const work = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "chrn-code-run-")))
  const research = join(work, "research")
  const outside = join(work, "outside")
  const homeKey = join(home, `.chrn-code-run-fake-${process.pid}.key`)
  mkdirSync(research)
  mkdirSync(outside)
  writeFileSync(join(outside, "fake.key"), `FAKE-OUTSIDE-${process.pid}`)
  writeFileSync(homeKey, `FAKE-HOME-${process.pid}`)
  symlinkSync(join(outside, "fake.key"), join(research, "link.key"))
  symlinkSync(outside, join(research, "outdir"))
  writeFileSync(join(research, "note.md"), "a note inside")
  // A unix socket at a path outside the folder, listening: reaching it would reach a local service as the person.
  const unixPath = join(outside, "listening.sock")
  const listener = Bun.listen({ unix: unixPath, socket: { data() {}, open(socket) { socket.end() } } })
  // A process outside the hold, with a fake secret in its environment.
  const other = Bun.spawn(["sleep", "300"], { env: { PATH: "/usr/bin:/bin", CANDLE_API_KEY: `FAKE-ENV-${process.pid}` }, stdout: "ignore", stderr: "ignore" })
  const runtimes: RuntimeResult[] = []
  try {
    for (const program of o.runtimes ?? ["python3", "node", "bun"]) {
      if (!Bun.which(program, { PATH: o.path ?? process.env.PATH ?? "/usr/bin:/bin" })) {
        runtimes.push({ program, ran: false, held: [], leaked: [], controls: false, note: "not installed, skipped" })
        continue
      }
      rmSync(join(research, "written.txt"), { force: true })
      rmSync(join(research, "hard.key"), { force: true })
      const r = await researchRun({
        root: research,
        programs: [program],
        args: { program, code: program === "python3" ? PY : JS, args: [outside, homeKey, String(other.pid), unixPath] },
        path: o.path ?? process.env.PATH,
        home,
        self: o.self,
      })
      if (!r.ok) {
        // Apple's python3 shim with no Command Line Tools is no runtime at all, as if it weren't installed.
        const shim = r.code === "NOT_INSTALLED"
        runtimes.push({ program, ran: false, held: [], leaked: [], controls: false, note: shim ? SHIM_SKIPPED : `${r.code}: ${r.message}` })
        continue
      }
      const lines = String(r.body.stdout).split("\n")
      // The escape run: what it started must be gone when the run is.
      const marker = `chrn-code-run-escape-${process.pid}-${program}`
      const escape = await researchRun({ root: research, programs: [program], args: { program, code: program === "python3" ? PY_ESCAPE : JS_ESCAPE, args: [marker] }, path: o.path ?? process.env.PATH, home, self: o.self })
      // A double fork too: its sleeper's parent is gone before the runner can have seen either.
      const doubleMarker = `chrn-code-run-double-${process.pid}-${program}`
      const double = await researchRun({ root: research, programs: [program], args: { program, code: program === "python3" ? PY_DOUBLE_FORK : JS_DOUBLE_FORK, args: [doubleMarker] }, path: o.path ?? process.env.PATH, home, self: o.self })
      await Bun.sleep(500)
      const leftRunning = [...runningAs(marker), ...runningAs(doubleMarker)]
      for (const pid of leftRunning) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      runtimes.push({
        program,
        ran: true,
        held: lines.filter((l) => l.startsWith("held ")),
        leaked: lines.filter((l) => l.startsWith("LEAK ")),
        controls: lines.includes("control inside write ok") && existsSync(join(research, "written.txt")),
        leftRunning: escape.ok && double.ok ? leftRunning : [-1],
        ...(r.body.stderr ? { note: String(r.body.stderr).slice(0, 400) } : {}),
      })
    }
    const wrote = ["written-from-inside", "written-through-link"].filter((f) => existsSync(join(outside, f))).map((f) => `${f} exists outside`)
    const killed = other.exitCode !== null || other.signalCode !== null ? ["the process outside was stopped"] : []
    const out = [...wrote, ...killed]
    const ranAny = runtimes.some((r) => r.ran)
    const pass = ranAny && out.length === 0 && runtimes.every((r) => r.note === "not installed, skipped" || r.note === SHIM_SKIPPED || (r.ran && r.leaked.length === 0 && r.controls && (r.leftRunning ?? []).length === 0))
    return { support, runtimes, outside: out, pass }
  } finally {
    other.kill()
    listener.stop(true)
    rmSync(work, { recursive: true, force: true })
    rmSync(homeKey, { force: true })
  }
}

export async function main(): Promise<void> {
  const at = process.argv.indexOf("--out")
  const result = await codeRunnerCheck({ self: checksSelf() })
  if (!result.support.ok) {
    console.log(`not held here: ${result.support.why}. Needs ${result.support.fix}.`)
  } else {
    console.log(`held by ${result.support.how}`)
    for (const r of result.runtimes) {
      console.log(`== ${r.program}${r.ran ? "" : `: ${r.note}`}`)
      for (const l of [...r.held, ...r.leaked]) console.log(`   ${l}`)
      if (r.ran) console.log(`   controls ${r.controls ? "ok" : "FAILED"} · ${(r.leftRunning ?? []).length === 0 ? "nothing it started was left running" : `LEFT RUNNING after its run: ${(r.leftRunning ?? []).join(", ")}`}${r.note ? ` · stderr: ${r.note}` : ""}`)
    }
    for (const o of result.outside) console.log(`FAIL: ${o}`)
  }
  console.log(result.pass ? "PASS: every runtime found was held" : "FAIL")
  if (at >= 0) writeFileSync(process.argv[at + 1]!, `${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.pass ? 0 : 1)
}
