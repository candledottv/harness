// The code runner's hold: one program held to one folder by the operating system, so a script the agent runs
// reaches nothing outside its research folder and no network.
//
// - Linux: this program runs itself as an exec stage (`candle-harness run-held`), which sets a Landlock ruleset
//   and a seccomp filter on itself, then becomes the program with execve from the same thread, so the program
//   and its children keep every rule. No root and no user namespace. Landlock (ABI 6 or later, Linux 6.12) allows
//   reads and writes inside the folder, reads and runs in the system's library folders and the runtime's own
//   install, and nothing else; it also scopes TCP, abstract unix sockets and signals to the hold. The seccomp filter
//   refuses socket() and io_uring_setup(), so no network of any kind, UDP included, and no socket to connect to a
//   unix path with; it refuses every call numbered for another calling convention (x86-64's x32 numbers reach the
//   same calls under other numbers); it refuses setsid() and setpgid(), so the program and everything it
//   starts stay in the one process group the runner stops; and it keeps the kernel's wider surfaces shut: unshare(),
//   clone() with any namespace flag, bpf(), perf_event_open(), userfaultfd() and the key calls get EPERM, and clone3()
//   ENOSYS (its flags are in memory a filter can't read; the C library falls back to clone()). Files it writes are
//   capped (RLIMIT_FSIZE) and so is how many more processes it can start (RLIMIT_NPROC).
// - macOS: Seatbelt, through /usr/bin/sandbox-exec, with a profile that denies by default: the system and the
//   runtime read-only, the folder read and write, no network, signals and process information inside the hold only.
//   Seatbelt can't refuse setsid, so there the runner follows the program's descendants itself (research-run.ts).
//
// Where neither holds (an older kernel, Landlock off, another system), the runner isn't offered and the doctor says
// why. A held script's data is capped (1 GB): on Linux by RLIMIT_DATA, on macOS by the runner's watchdog.
import { FFIType } from "bun:ffi"
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

export const MIN_LANDLOCK_ABI = 6
export const HOLD_DATA_LIMIT = 1024 * 1024 * 1024

export type HoldSupport = { ok: true; how: string } | { ok: false; why: string; fix: string }

export type HoldArch = "x64" | "arm64"
/** Each architecture's audit value and the numbers of the calls the filter refuses (the kernel's unistd tables). */
const NR: Record<HoldArch, { audit: number; socket: number; ioUringSetup: number; setsid: number; setpgid: number; unshare: number; bpf: number; perfEventOpen: number; userfaultfd: number; addKey: number; requestKey: number; keyctl: number; clone: number; clone3: number }> = {
  arm64: { audit: 0xc00000b7, socket: 198, ioUringSetup: 425, setsid: 157, setpgid: 154, unshare: 97, bpf: 280, perfEventOpen: 241, userfaultfd: 282, addKey: 217, requestKey: 218, keyctl: 219, clone: 220, clone3: 435 },
  x64: { audit: 0xc000003e, socket: 41, ioUringSetup: 425, setsid: 112, setpgid: 109, unshare: 272, bpf: 321, perfEventOpen: 298, userfaultfd: 323, addKey: 248, requestKey: 249, keyctl: 250, clone: 56, clone3: 435 },
}
/**
 * clone()'s namespace flags (NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET), in its first argument on both
 * architectures. CLONE_NEWTIME (0x80) is left out: in clone() those bits are the exit signal, and only clone3() and
 * unshare(), both refused whole, take it.
 */
export const CLONE_NAMESPACES = 0x7e020000
/** A held script's files are capped at this size; past it a write fails (SIGXFSZ). */
export const HOLD_FILE_LIMIT = 1024 * 1024 * 1024
/** How many processes (threads count) a held script may start beyond those the person already runs: RLIMIT_NPROC counts every one of theirs. */
export const HOLD_PROC_HEADROOM = 128
/** x86-64's x32 calls carry this bit: socket() is 0x40000029 there. No 64-bit program makes a call numbered this high. */
export const OTHER_ABI_BIT = 0x40000000

const BPF = { LD: 0x20, JEQ: 0x15, JGE: 0x35, JSET: 0x45, RET: 0x06 }
export const SECCOMP = { ALLOW: 0x7fff0000, EPERM: 0x00050001, ENOSYS: 0x00050026, KILL: 0x80000000 }
/** seccomp_data's offsets: the call's number, its architecture, and its first argument's low 32 bits (little-endian). */
const DATA = { nr: 0, arch: 4, arg0: 16 }

/**
 * The seccomp program, as [op, jt, jf, k] rows: a foreign architecture is killed; a call numbered for another
 * calling convention, socket(), io_uring_setup(), setsid(), setpgid(), unshare(), bpf(), perf_event_open(),
 * userfaultfd(), add_key(), request_key(), keyctl() and clone() with a namespace flag get EPERM; clone3() gets
 * ENOSYS; everything else runs.
 */
export function seccompFilter(arch: HoldArch): [number, number, number, number][] {
  const nr = NR[arch]
  const refused = [nr.socket, nr.ioUringSetup, nr.setsid, nr.setpgid, nr.unshare, nr.bpf, nr.perfEventOpen, nr.userfaultfd, nr.addKey, nr.requestKey, nr.keyctl]
  const R = refused.length
  // Rows 0-4 read and check the architecture and the other calling convention; then one row per refused number;
  // clone3; clone, whose flags are read and tested; then the three answers.
  const CLONE3 = 5 + R
  const CLONE = CLONE3 + 1
  const FLAGS = CLONE + 2
  const ALLOW = FLAGS + 1
  const EPERM = ALLOW + 1
  const ENOSYS = EPERM + 1
  const to = (from: number, target: number) => target - from - 1
  return [
    [BPF.LD, 0, 0, DATA.arch],
    [BPF.JEQ, 1, 0, nr.audit],
    [BPF.RET, 0, 0, SECCOMP.KILL],
    [BPF.LD, 0, 0, DATA.nr],
    [BPF.JGE, to(4, EPERM), 0, OTHER_ABI_BIT],
    ...refused.map((n, i): [number, number, number, number] => [BPF.JEQ, to(5 + i, EPERM), 0, n]),
    [BPF.JEQ, to(CLONE3, ENOSYS), 0, nr.clone3],
    [BPF.JEQ, 0, to(CLONE, ALLOW), nr.clone],
    [BPF.LD, 0, 0, DATA.arg0],
    [BPF.JSET, to(FLAGS, EPERM), 0, CLONE_NAMESPACES],
    [BPF.RET, 0, 0, SECCOMP.ALLOW],
    [BPF.RET, 0, 0, SECCOMP.EPERM],
    [BPF.RET, 0, 0, SECCOMP.ENOSYS],
  ]
}

/** How many tasks (processes and their threads) belong to real user `uid`, from each /proc/<pid>/status text. */
export function userTasks(statuses: readonly string[], uid: number): number {
  let n = 0
  for (const text of statuses) {
    const real = /^Uid:\s+(\d+)/m.exec(text)
    if (!real || Number(real[1]) !== uid) continue
    const threads = /^Threads:\s+(\d+)/m.exec(text)
    n += threads ? Number(threads[1]) : 1
  }
  return n
}

/** RLIMIT_NPROC for the held program: what the person runs now, and HOLD_PROC_HEADROOM more. */
function procLimit(): number {
  const uid = process.getuid?.() ?? 0
  const statuses: string[] = []
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    try {
      statuses.push(readFileSync(`/proc/${name}/status`, "utf8"))
    } catch {} // gone since the list was read
  }
  return userTasks(statuses, uid) + HOLD_PROC_HEADROOM
}
const LL_CREATE = 444
const LL_ADD = 445
const LL_RESTRICT = 446
/** close_range: the same number on x86-64 and arm64. With CLOSE_RANGE_CLOEXEC it marks the files to close at exec. */
const CLOSE_RANGE = 436
const CLOSE_RANGE_CLOEXEC = 4

type Libc = { symbols: Record<string, (...args: any[]) => any> }
let libcLoaded: Libc | null | undefined

/** glibc, through bun:ffi; null where it can't be loaded (musl, or no FFI). */
async function libc(): Promise<Libc | null> {
  if (libcLoaded !== undefined) return libcLoaded
  try {
    const { dlopen, FFIType } = await import("bun:ffi")
    libcLoaded = dlopen("libc.so.6", {
      syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }) as unknown as Libc
  } catch {
    libcLoaded = null
  }
  return libcLoaded
}

// Every unused argument is passed as 0: libc's syscall reads all of them, and garbage in landlock_add_rule's flags is EINVAL.
const sys = (l: Libc, nr: number, a: number | bigint, b: number | bigint, c: number | bigint): number => Number(l.symbols.syscall!(nr, BigInt(a), BigInt(b), BigInt(c), 0n))

/** The kernel's Landlock ABI, or a negative number when it has none (or it's off). */
export async function landlockAbi(): Promise<number | undefined> {
  const l = await libc()
  return l ? sys(l, LL_CREATE, 0, 0, 1) : undefined
}

const LINUX_FIX = "a Linux 6.12 kernel or later with Landlock on (Debian 13, Fedora 41, Ubuntu 25.04, or Ubuntu 24.04's HWE kernel)"
let supportMemo: HoldSupport | undefined

/** Whether this machine can hold the code runner, and if not, why and what fixes it. */
export async function holdSupport(platform: NodeJS.Platform = process.platform): Promise<HoldSupport> {
  if (platform === process.platform && supportMemo) return supportMemo
  const found = await (async (): Promise<HoldSupport> => {
    if (platform === "darwin") {
      return existsSync("/usr/bin/sandbox-exec")
        ? { ok: true, how: "macOS's Seatbelt" }
        : { ok: false, why: "this Mac has no /usr/bin/sandbox-exec", fix: "a macOS with sandbox-exec, which every release since 10.5 has" }
    }
    if (platform !== "linux") return { ok: false, why: `the code runner can't be held on ${platform}`, fix: "macOS, or Linux 6.12 or later" }
    if (process.arch !== "x64" && process.arch !== "arm64") return { ok: false, why: `the code runner's hold isn't built for ${process.arch}`, fix: "an x64 or arm64 machine" }
    const abi = await landlockAbi()
    if (abi === undefined) return { ok: false, why: "this system's C library can't be loaded (the hold needs glibc)", fix: "a glibc Linux, such as Debian, Ubuntu or Fedora" }
    if (abi < 0) return { ok: false, why: "this kernel has no Landlock, or it's turned off", fix: LINUX_FIX }
    if (abi < MIN_LANDLOCK_ABI) return { ok: false, why: `this kernel's Landlock is ABI ${abi}, and holding signals needs ${MIN_LANDLOCK_ABI}`, fix: LINUX_FIX }
    return { ok: true, how: `Landlock (ABI ${abi}) and seccomp` }
  })()
  if (platform === process.platform) supportMemo = found
  return found
}

/** For tests: forget what holdSupport found. */
export const forgetHoldSupport = () => {
  supportMemo = undefined
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)

/** Thrown for a runtime whose own folder can't be granted without opening the home or the Harness's files. */
export class RuntimePlaceRefused extends Error {}

/**
 * The runtime's own install, read-only: where its binary really is, and the prefix above it (`/usr` for
 * `/usr/bin/python3`, Homebrew's keg for its python), so its libraries load. In the person's home only a prefix
 * two folders down or deeper (`~/.pyenv/versions/3.12`), never one like `~/.local`, which holds other things;
 * there the binary's own folder alone. A binary in a folder right in the home (`~/Downloads/node`) is granted
 * as the one file, never with the files beside it.
 *
 * Never a folder that is the home or holds it, nor one that holds `~/.config`, `~/.config/candle` or any of
 * `keep` (the Harness's own folder, with its keys), nor one inside `keep`: where the prefix would be one, the
 * binary's folder alone is granted, and where that would be one too, the runtime is refused (RuntimePlaceRefused).
 */
export function installReads(program: string, home: string | undefined, keep: readonly string[] = []): string[] {
  const realProgram = realpathSync(program)
  const binDir = dirname(realProgram)
  const prefix = dirname(binDir)
  const realHome = home ? real(home) : undefined
  const kept = keep.map(real)
  const closed = [...(realHome ? [realHome, join(realHome, ".config"), join(realHome, ".config", "candle"), join(realHome, ".config", "candle", "harness")] : []), ...kept]
  // Granting `dir` would open one of the closed folders (it is one, or holds one), or it sits inside the Harness's own.
  const opens = (dir: string) => closed.some((c) => within(c, dir)) || [...kept, ...(realHome ? [join(realHome, ".config", "candle", "harness")] : [])].some((k) => within(dir, k))
  const wanted = (() => {
    if (realHome && within(binDir, realHome)) {
      // A folder right in the home (Downloads, Desktop, Documents, bin) holds the person's other files: the binary alone.
      if (dirname(binDir) === realHome) return realProgram
      const depth = relative(realHome, prefix).split(sep).filter((part) => part && part !== "..").length
      return depth >= 2 ? prefix : binDir
    }
    return prefix === "/" ? binDir : prefix
  })()
  if (!opens(wanted)) return [wanted]
  if (!opens(binDir)) return [binDir]
  throw new RuntimePlaceRefused(`${program} sits in ${binDir}, and running it would let a script read that folder`)
}

// ---------------------------------------------------------------------------------------------------------
// Linux: the exec stage.

const FS = {
  EXECUTE: 1n << 0n,
  WRITE_FILE: 1n << 1n,
  READ_FILE: 1n << 2n,
  READ_DIR: 1n << 3n,
  REMOVE_DIR: 1n << 4n,
  REMOVE_FILE: 1n << 5n,
  MAKE_CHAR: 1n << 6n,
  MAKE_DIR: 1n << 7n,
  MAKE_REG: 1n << 8n,
  MAKE_SOCK: 1n << 9n,
  MAKE_FIFO: 1n << 10n,
  MAKE_BLOCK: 1n << 11n,
  MAKE_SYM: 1n << 12n,
  REFER: 1n << 13n,
  TRUNCATE: 1n << 14n,
  IOCTL_DEV: 1n << 15n,
}
const ALL = Object.values(FS).reduce((a, b) => a | b, 0n)
const FILE_ONLY = FS.EXECUTE | FS.WRITE_FILE | FS.READ_FILE | FS.TRUNCATE | FS.IOCTL_DEV
const READ_RUN = FS.EXECUTE | FS.READ_FILE | FS.READ_DIR
const SYSTEM_READS = ["/usr", "/lib", "/lib64", "/bin", "/etc/ld.so.cache", "/etc/localtime", "/etc/ssl", "/usr/share/zoneinfo"]

/** The held program's environment: nothing of the core's, its home and temporary folder inside the folder. */
export function heldEnv(folder: string, program: string): Record<string, string> {
  const bin = dirname(program)
  const path = ["/usr/bin", "/bin"].includes(bin) ? "/usr/bin:/bin" : `${bin}:/usr/bin:/bin`
  return { PATH: path, HOME: folder, TMPDIR: join(folder, ".tmp"), LANG: "C.UTF-8" }
}

/**
 * `candle-harness run-held <folder> <read-only dirs, comma-separated> -- <program> [args…]`: holds this process,
 * then becomes the program. Never returns when it works; on any failure it says "not held: …" on stderr and
 * exits 126, having run nothing.
 */
export async function runHeldStage(argv: string[], err: (text: string) => void): Promise<number> {
  const fail = (why: string) => {
    err(`not held: ${why}\n`)
    return 126
  }
  if (process.platform !== "linux") return fail("the exec stage is Linux's; macOS holds by sandbox-exec")
  const [folderArg, readArg = "", dashdash, program, ...args] = argv
  if (!folderArg || dashdash !== "--" || !program || !isAbsolute(program)) return fail("usage: run-held <folder> <read-only dirs> -- <program> [args…]")
  const l = await libc()
  if (!l) return fail("this system's C library can't be loaded")
  const { ptr } = await import("bun:ffi")
  let folder: string
  try {
    folder = realpathSync(folderArg)
  } catch {
    return fail(`there's no folder ${folderArg}`)
  }
  // The stage is started outside the folder, so nothing the held program's owner wrote there is read as this
  // binary starts; the program itself runs in it.
  process.chdir(folder)

  const abi = sys(l, LL_CREATE, 0, 0, 1)
  if (abi < MIN_LANDLOCK_ABI) return fail(abi < 0 ? "this kernel has no Landlock" : `Landlock ABI ${abi}, and holding signals needs ${MIN_LANDLOCK_ABI}`)
  // Handled: every file right, TCP bind and connect, and the scopes for abstract unix sockets and signals.
  const attr = new BigUint64Array([ALL, 3n, 3n])
  const ruleset = sys(l, LL_CREATE, ptr(attr), 24, 0)
  if (ruleset < 0) return fail("Landlock refused the ruleset")

  const kept: unknown[] = [attr]
  const allow = (path: string, rights: bigint): string | undefined => {
    let fd: number
    try {
      fd = openSync(path, 0x200000 | 0x80000 /* O_PATH | O_CLOEXEC */)
    } catch {
      return undefined // a folder this system doesn't have
    }
    const rule = new Uint8Array(12)
    kept.push(rule)
    const view = new DataView(rule.buffer)
    view.setInt32(8, fd, true)
    view.setBigUint64(0, rights, true)
    if (sys(l, LL_ADD, ruleset, 1, ptr(rule)) === 0) return undefined
    view.setBigUint64(0, rights & FILE_ONLY, true) // a file takes only a file's rights
    if (sys(l, LL_ADD, ruleset, 1, ptr(rule)) !== 0) return `Landlock refused a rule for ${path}`
    return undefined
  }
  const faults = [
    allow(folder, ALL),
    ...SYSTEM_READS.map((p) => allow(p, READ_RUN)),
    ...readArg
      .split(",")
      .filter(Boolean)
      .map((p) => allow(p, READ_RUN)),
    allow("/dev/null", FS.READ_FILE | FS.WRITE_FILE),
    allow("/dev/zero", FS.READ_FILE),
    allow("/dev/urandom", FS.READ_FILE),
    // exec keeps the pid, so this is the held program's own /proc entry, and no other process's.
    allow(`/proc/${process.pid}`, FS.READ_FILE | FS.READ_DIR),
  ].filter((f): f is string => f !== undefined)
  if (faults.length) return fail(faults[0]!)

  const limit = new BigUint64Array([BigInt(HOLD_DATA_LIMIT), BigInt(HOLD_DATA_LIMIT)])
  if (l.symbols.setrlimit!(2 /* RLIMIT_DATA */, ptr(limit)) !== 0) return fail("setrlimit refused")
  const files = new BigUint64Array([BigInt(HOLD_FILE_LIMIT), BigInt(HOLD_FILE_LIMIT)])
  if (l.symbols.setrlimit!(1 /* RLIMIT_FSIZE */, ptr(files)) !== 0) return fail("setrlimit refused the file size cap")
  const procs = BigInt(procLimit())
  const tasks = new BigUint64Array([procs, procs])
  if (l.symbols.setrlimit!(6 /* RLIMIT_NPROC */, ptr(tasks)) !== 0) return fail("setrlimit refused the process cap")
  kept.push(limit, files, tasks)
  if (l.symbols.prctl!(38 /* PR_SET_NO_NEW_PRIVS */, 1n, 0n, 0n, 0n) !== 0) return fail("no_new_privs refused")
  if (sys(l, LL_RESTRICT, ruleset, 0, 0) !== 0) return fail("Landlock refused to hold")
  closeSync(ruleset)

  const filter = seccompFilter(process.arch === "arm64" ? "arm64" : "x64")
  const code = new Uint8Array(filter.length * 8)
  const cv = new DataView(code.buffer)
  filter.forEach(([op, jt, jf, k], i) => {
    cv.setUint16(i * 8, op, true)
    cv.setUint8(i * 8 + 2, jt)
    cv.setUint8(i * 8 + 3, jf)
    cv.setUint32(i * 8 + 4, k >>> 0, true)
  })
  const fprog = new Uint8Array(16)
  new DataView(fprog.buffer).setUint16(0, filter.length, true)
  new DataView(fprog.buffer).setBigUint64(8, BigInt(ptr(code)), true)
  if (l.symbols.prctl!(22 /* PR_SET_SECCOMP */, 2n /* FILTER */, BigInt(ptr(fprog)), 0n, 0n) !== 0) return fail("seccomp refused")

  const cstr = (s: string) => {
    const b = Buffer.from(`${s}\0`)
    kept.push(b)
    return b
  }
  const vec = (xs: string[]) => {
    const a = new BigUint64Array(xs.length + 1)
    xs.forEach((x, i) => {
      a[i] = BigInt(ptr(cstr(x)))
    })
    kept.push(a)
    return a
  }
  const env = vec(Object.entries(heldEnv(folder, program)).map(([k, v]) => `${k}=${v}`))
  // Whatever this stage holds open past the three streams, handed to it or opened by its own runtime, closes at
  // exec: the program starts with nothing it didn't open itself.
  if (sys(l, CLOSE_RANGE, 3, 0xffffffff, CLOSE_RANGE_CLOEXEC) !== 0) return fail("close_range refused")
  l.symbols.execve!(ptr(cstr(program)), ptr(vec([program, ...args])), ptr(env))
  return fail(`couldn't start ${program}`)
}

// ---------------------------------------------------------------------------------------------------------
// macOS: the Seatbelt profile.

/**
 * A run's own mark: two sibling paths that exist nowhere, of which the run's profile allows only `allowed`. No other
 * profile tells two names it has never heard of apart, and a process in no sandbox is allowed both, so a process that
 * macOS allows `allowed` and refuses `denied` is held by this run's profile and no other. Under /private/var/empty,
 * whose path has no link, so the name checked is the name the profile holds.
 */
export interface HoldMark {
  allowed: string
  denied: string
}

export function holdMark(): HoldMark {
  const id = randomBytes(12).toString("hex")
  return { allowed: `/private/var/empty/.candle-harness-hold-${id}-in`, denied: `/private/var/empty/.candle-harness-hold-${id}-out` }
}

/** sandbox_check's answer for `pid` reading `path`'s metadata: 0 allowed, 1 refused, -1 couldn't ask. */
export type MarkCheck = (pid: number, path: string) => number

/** Whether `pid` is held by the profile that carries `mark`. */
export function heldByMark(pid: number, mark: HoldMark, check: MarkCheck): boolean {
  return check(pid, mark.allowed) === 0 && check(pid, mark.denied) === 1
}

/**
 * sandbox_check(pid, operation, SANDBOX_FILTER_PATH, path) as bun:ffi has to declare it. The path is its first
 * variadic argument: Apple's arm64 calls pass those on the stack, after the eight argument registers, so five unused
 * registers come first; Intel passes it in the fourth register, as any argument.
 */
export function sandboxCheckArgs(arch: string): FFIType[] {
  return arch === "arm64"
    ? [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.ptr]
    : [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr]
}

type PathCheck = { symbols: { sandbox_check: (...args: unknown[]) => number } }
let pathCheckLib: PathCheck | null | undefined
const SANDBOX_FILTER_PATH = 1
const cString = (s: string) => Buffer.from(`${s}\0`)

/** Asks macOS whether `pid` may read `path`'s metadata; -1 where it can't be asked. */
export async function markCheck(): Promise<MarkCheck> {
  if (process.platform !== "darwin") return () => -1
  if (pathCheckLib === undefined) {
    try {
      const { dlopen } = await import("bun:ffi")
      pathCheckLib = dlopen("/usr/lib/libSystem.B.dylib", { sandbox_check: { args: sandboxCheckArgs(process.arch), returns: FFIType.i32 } }) as unknown as PathCheck
    } catch {
      pathCheckLib = null
    }
  }
  const lib = pathCheckLib
  if (!lib) return () => -1
  const { ptr } = await import("bun:ffi")
  const operation = cString("file-read-metadata")
  return (pid, path) => {
    const p = cString(path)
    const answer = process.arch === "arm64" ? lib.symbols.sandbox_check(pid, ptr(operation), SANDBOX_FILTER_PATH, 0, 0, 0, 0, 0, ptr(p)) : lib.symbols.sandbox_check(pid, ptr(operation), SANDBOX_FILTER_PATH, ptr(p))
    return answer === 0 || answer === 1 ? answer : -1
  }
}

/** Whether `pid` is held by this run's profile, the one carrying `mark`; false wherever macOS can't say. */
export async function inThisHold(pid: number, mark: HoldMark): Promise<boolean> {
  return heldByMark(pid, mark, await markCheck())
}

/** The folders a program held by the Seatbelt profile can have been started from: what `(allow process-exec …)` names, and the folder. */
export function seatbeltExecRoots(folder: string, reads: readonly string[], program: string): string[] {
  const shim = program.startsWith("/usr/bin/") ? ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app"] : []
  const brew = within(program, HOMEBREW) ? HOMEBREW_RUN.map((d) => join(HOMEBREW, d)) : []
  return ["/usr/bin", "/bin", "/usr/libexec", folder, ...reads, ...shim, ...brew]
}

/**
 * Apple's `/usr/bin/python3` is a shim that runs the Command Line Tools' python, and with none installed asks to
 * install them in a dialog and runs nothing. Such a python isn't a runtime here.
 */
export function appleShimWithoutTools(bin: string, platform: NodeJS.Platform = process.platform, toolsPath: () => boolean = commandLineTools): boolean {
  return platform === "darwin" && bin === "/usr/bin/python3" && !toolsPath()
}

function commandLineTools(): boolean {
  try {
    return Bun.spawnSync(["/usr/bin/xcode-select", "-p"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}

/**
 * The command that runs `bin` (the program's real path, never a link to it: Seatbelt refuses to start a link outside
 * the paths it allows) held to `folder`.
 */
export function heldCommand(platform: NodeJS.Platform, folder: string, reads: readonly string[], bin: string, argv: readonly string[], self: readonly string[], mark?: HoldMark): string[] {
  return platform === "darwin"
    ? ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(folder, reads, bin, mark), bin, ...argv]
    : [...self, "run-held", folder, reads.join(","), "--", bin, ...argv]
}

const HOMEBREW = "/opt/homebrew"
const HOMEBREW_RUN = ["Cellar", "opt", "lib", "share", "Frameworks", "bin"]
const HOMEBREW_ETC = ["openssl@3", "openssl@1.1", "ca-certificates"]

const sbString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/**
 * The Seatbelt profile for `folder` (its real path) and the runtime's `reads`. Unlike a coding harness's own
 * profile, nothing in the person's home is readable but the folder, and no kern.proc sysctl, which can show
 * another process's arguments and environment.
 */
export function seatbeltProfile(folder: string, reads: readonly string[], program: string, mark?: HoldMark): string {
  // Apple's /usr/bin shims (python3, git) run the Command Line Tools' or Xcode's copy.
  const shim = program.startsWith("/usr/bin/") ? ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app"] : []
  // Homebrew, only for a runtime that is Homebrew's: its kegs and the links to them, which its libraries load
  // through. Never the whole of it: etc and var hold other programs' settings and data.
  const brew = within(program, HOMEBREW) ? HOMEBREW_RUN.map((d) => join(HOMEBREW, d)) : []
  // The settings OpenSSL and its certificates load from, which a Homebrew python reads as it starts: public files.
  const brewEtc = brew.length ? HOMEBREW_ETC.map((d) => `(subpath ${sbString(join(HOMEBREW, "etc", d))})`).join(" ") : ""
  const read = [...reads, ...shim, ...brew].map((p) => `(subpath ${sbString(p)})`).join(" ")
  const f = sbString(folder)
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/libexec") ${read})`,
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow file-read*",
    '  (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/libexec")',
    '  (subpath "/System") (subpath "/Library/Apple") (subpath "/private/etc/ssl") (literal "/private/etc/localtime")',
    '  (subpath "/private/var/db/timezone") (subpath "/private/var/db/dyld")',
    '  (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/zero")',
    `  ${read}${brewEtc ? ` ${brewEtc}` : ""})`,
    // The root folder itself: on macOS 27 every program aborts at start without it. It lists the top-level names only.
    '(allow file-read* (literal "/"))',
    // "/Library" and "/Library/Developer": Apple's python3 shim takes the real path of the Command Line Tools' folder
    // before it runs the real python3, and without them it stops at "realpath: … Operation not permitted".
    '(allow file-read-metadata (literal "/private") (literal "/private/var") (literal "/var") (literal "/etc")',
    `  (literal "/tmp") (literal "/Users") (literal "/Library") (literal "/Library/Developer") (path-ancestors ${f}))`,
    `(allow file-read* file-write* (subpath ${f}))`,
    '(allow file-read* file-write-data (literal "/dev/null"))',
    `(allow file-map-executable (subpath "/usr/lib") (subpath "/System") ${read})`,
    "(allow sysctl-read",
    '  (sysctl-name "hw.activecpu") (sysctl-name "hw.byteorder") (sysctl-name "hw.cachelinesize_compat")',
    '  (sysctl-name "hw.cpufamily") (sysctl-name "hw.cputype") (sysctl-name "hw.logicalcpu") (sysctl-name "hw.logicalcpu_max")',
    '  (sysctl-name "hw.machine") (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu") (sysctl-name "hw.nperflevels")',
    '  (sysctl-name-prefix "hw.optional.") (sysctl-name "hw.pagesize") (sysctl-name "hw.pagesize_compat")',
    '  (sysctl-name "hw.physicalcpu") (sysctl-name "hw.physicalcpu_max") (sysctl-name-prefix "hw.perflevel")',
    '  (sysctl-name "hw.tbfrequency_compat") (sysctl-name "machdep.cpu.brand_string") (sysctl-name "kern.argmax")',
    '  (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease")',
    '  (sysctl-name "kern.ostype") (sysctl-name "kern.osversion") (sysctl-name "kern.osvariant_status")',
    '  (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    "(deny network*)",
    // The run's mark: the runner asks macOS about it to tell this run's processes from any other sandbox's.
    ...(mark ? [`(allow file-read-metadata (literal ${sbString(mark.allowed)}))`] : []),
  ].join("\n")
}
