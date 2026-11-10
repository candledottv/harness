import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { FFIType } from "bun:ffi"
import { appleShimWithoutTools, CLONE_NAMESPACES, HOLD_PROC_HEADROOM, heldByMark, heldCommand, holdMark, installReads, OTHER_ABI_BIT, RuntimePlaceRefused, SECCOMP, sandboxCheckArgs, seatbeltProfile, seccompFilter, userTasks } from "./hold"

const profile = seatbeltProfile("/opt/person/research", ["/opt/person/.bun"], "/opt/person/.bun/bin/bun")

test("the Seatbelt profile lets a program read the root folder itself, which macOS 27 needs to start anything", () => {
  expect(profile).toContain('(allow file-read* (literal "/"))')
  // Only the root's own entry: nothing under it beyond the paths named elsewhere.
  expect(profile).not.toContain('(subpath "/")')
  expect(profile).not.toContain("(allow file-read*)")
})

test("the Seatbelt profile allows the sysctls uname reads, so node's os module answers rather than aborting", () => {
  for (const name of ["kern.hostname", "kern.ostype", "kern.osrelease", "kern.version", "hw.machine"]) expect(profile).toContain(`(sysctl-name "${name}")`)
  expect(profile).not.toContain("kern.proc")
})

test("the Seatbelt profile lets Apple's python3 shim find the Command Line Tools' real path, and no more of /Library", () => {
  expect(profile).toContain('(literal "/Library") (literal "/Library/Developer")')
  // Their metadata only: nothing else under /Library is readable.
  expect(profile).not.toContain('(subpath "/Library")')
  expect(profile).not.toContain('(subpath "/Library/Developer")')
})

test("the held command on macOS runs the program's real path, never the link that found it", () => {
  const cmd = heldCommand("darwin", "/r", ["/opt/person/.bun"], "/opt/person/.bun/bin/bun", ["x.ts"], ["self"])
  expect(cmd.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"])
  expect(cmd.slice(3)).toEqual(["/opt/person/.bun/bin/bun", "x.ts"])
  expect(heldCommand("linux", "/r", ["/a", "/b"], "/opt/bun/bin/bun", ["x.ts"], ["self"])).toEqual(["self", "run-held", "/r", "/a,/b", "--", "/opt/bun/bin/bun", "x.ts"])
})

test("each run's hold carries a mark of its own: two files that exist, at their real paths, of which its profile allows one", () => {
  const a = holdMark()
  const b = holdMark()
  try {
    // macOS answers a path check for a path that exists: a path that doesn't is refused to every process, held or not.
    for (const p of [a.allowed, a.denied, b.allowed, b.denied]) {
      expect(existsSync(p)).toBe(true)
      // No link on the way: the path the profile names is the one macOS resolves.
      expect(realpathSync(p)).toBe(p)
    }
    expect(a.allowed).not.toBe(b.allowed)
    expect(dirname(a.denied)).toBe(dirname(a.allowed))
    expect(dirname(a.allowed)).not.toBe(dirname(b.allowed))
    expect(a.denied).not.toBe(a.allowed)
    const marked = seatbeltProfile("/opt/person/research", ["/opt/person/.bun"], "/opt/person/.bun/bin/bun", a)
    expect(marked).toContain(`(allow file-read-metadata (literal "${a.allowed}"))`)
    // The other is refused by the profile's default, so no rule names it.
    expect(marked).not.toContain(a.denied)
    expect(marked.replace(`\n(allow file-read-metadata (literal "${a.allowed}"))`, "")).toBe(profile)
    const cmd = heldCommand("darwin", "/r", [], "/usr/bin/python3", ["x.py"], ["self"], a)
    expect(cmd[2]).toContain(a.allowed)
  } finally {
    a.remove()
    b.remove()
  }
  // Removed with its folder once the run is over.
  expect(existsSync(dirname(a.allowed))).toBe(false)
  expect(existsSync(dirname(b.allowed))).toBe(false)
})

test("a process is the run's own only where macOS allows the mark's one path and refuses the other", () => {
  const mark = { allowed: "/private/var/empty/a-in", denied: "/private/var/empty/a-out" }
  // sandbox_check: 0 allowed, 1 refused, -1 couldn't ask.
  const ask = (answers: Record<string, number>) => (_pid: number, path: string) => answers[path] ?? -1
  expect(heldByMark(7, mark, ask({ [mark.allowed]: 0, [mark.denied]: 1 }))).toBe(true)
  // Outside any sandbox, both are allowed.
  expect(heldByMark(7, mark, ask({ [mark.allowed]: 0, [mark.denied]: 0 }))).toBe(false)
  // Another sandbox that refuses by default refuses both.
  expect(heldByMark(7, mark, ask({ [mark.allowed]: 1, [mark.denied]: 1 }))).toBe(false)
  // Where macOS can't be asked, nothing is the run's.
  expect(heldByMark(7, mark, ask({}))).toBe(false)
  expect(heldByMark(7, mark, ask({ [mark.allowed]: 0 }))).toBe(false)
})

test("the path reaches sandbox_check as its first variadic argument: on the stack on Apple silicon, in a register on Intel", () => {
  // Apple's arm64 calls pass every variadic argument on the stack, after the eight argument registers.
  const arm = sandboxCheckArgs("arm64")
  expect(arm).toHaveLength(9)
  expect(arm[8]).toBe(FFIType.ptr)
  expect(arm.slice(3, 8).every((t) => t === FFIType.i64)).toBe(true)
  expect(sandboxCheckArgs("x64")).toEqual([FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr])
})

test("Apple's python3 shim counts as no runtime on a Mac with no Command Line Tools", () => {
  expect(appleShimWithoutTools("/usr/bin/python3", "darwin", () => false)).toBe(true)
  expect(appleShimWithoutTools("/usr/bin/python3", "darwin", () => true)).toBe(false)
  expect(appleShimWithoutTools("/opt/homebrew/bin/python3", "darwin", () => false)).toBe(false)
  expect(appleShimWithoutTools("/usr/bin/python3", "linux", () => false)).toBe(false)
})

/** The kernel's reading of a classic BPF program over one call: seccomp_data's nr at offset 0, arch at 4, the first argument's low half at 16. */
function runFilter(filter: [number, number, number, number][], arch: number, nr: number, arg0 = 0): number {
  let acc = 0
  for (let pc = 0; pc < filter.length; ) {
    const [op, jt, jf, k] = filter[pc]!
    if (op === 0x20) {
      acc = k === 0 ? nr : k === 4 ? arch : k === 16 ? arg0 : Number.NaN
      pc++
    } else if (op === 0x15) pc += 1 + (acc >>> 0 === k >>> 0 ? jt : jf)
    else if (op === 0x35) pc += 1 + (acc >>> 0 >= k >>> 0 ? jt : jf)
    else if (op === 0x45) pc += 1 + ((acc & k) >>> 0 !== 0 ? jt : jf)
    else if (op === 0x06) return k >>> 0
    else throw new Error(`an instruction the filter shouldn't hold: ${op}`)
  }
  throw new Error("the filter ran off its end")
}

const X64 = 0xc000003e
const ARM64 = 0xc00000b7
const I386 = 0x40000003

test("the seccomp filter refuses the network and leaving the process group, by each architecture's own numbers", () => {
  const x64 = seccompFilter("x64")
  const arm64 = seccompFilter("arm64")
  // socket, io_uring_setup, setsid, setpgid
  for (const nr of [41, 425, 112, 109]) expect(runFilter(x64, X64, nr)).toBe(SECCOMP.EPERM)
  for (const nr of [198, 425, 157, 154]) expect(runFilter(arm64, ARM64, nr)).toBe(SECCOMP.EPERM)
  // read, write, openat, execve, clone, fork-like calls run.
  for (const nr of [0, 1, 257, 59, 56, 57, 39]) expect(runFilter(x64, X64, nr)).toBe(SECCOMP.ALLOW)
  for (const nr of [63, 64, 56, 221, 220, 172]) expect(runFilter(arm64, ARM64, nr)).toBe(SECCOMP.ALLOW)
  // One architecture's refused number is another call on the other: arm64's 41 isn't socket.
  expect(runFilter(arm64, ARM64, 41)).toBe(SECCOMP.ALLOW)
})

test("the seccomp filter refuses every call numbered for another calling convention, and kills a foreign architecture", () => {
  const x64 = seccompFilter("x64")
  // x86-64's x32 table: the same calls under their numbers with the bit set, socket and io_uring_setup among them.
  for (const nr of [OTHER_ABI_BIT | 41, OTHER_ABI_BIT | 425, OTHER_ABI_BIT | 0, OTHER_ABI_BIT | 112, 0x400001a9, 0xffffffff]) expect(runFilter(x64, X64, nr)).toBe(SECCOMP.EPERM)
  expect(runFilter(x64, X64, OTHER_ABI_BIT - 1)).toBe(SECCOMP.ALLOW)
  expect(runFilter(seccompFilter("arm64"), ARM64, OTHER_ABI_BIT | 198)).toBe(SECCOMP.EPERM)
  // 32-bit calls on a 64-bit kernel, and the other 64-bit architecture's filter.
  expect(runFilter(x64, I386, 359)).toBe(SECCOMP.KILL)
  expect(runFilter(x64, ARM64, 0)).toBe(SECCOMP.KILL)
  expect(runFilter(seccompFilter("arm64"), X64, 0)).toBe(SECCOMP.KILL)
  // Every jump lands inside the program.
  for (const f of [x64, seccompFilter("arm64")]) f.forEach(([op, jt, jf], i) => (op === 0x15 || op === 0x35 || op === 0x45) && expect(i + 1 + Math.max(jt, jf)).toBeLessThan(f.length))
})

test("the seccomp filter keeps the kernel's wider surfaces shut: namespaces, bpf, perf, userfaultfd and keys get EPERM, clone3 ENOSYS", () => {
  const x64 = seccompFilter("x64")
  const arm64 = seccompFilter("arm64")
  // unshare, bpf, perf_event_open, userfaultfd, add_key, request_key, keyctl
  for (const nr of [272, 321, 298, 323, 248, 249, 250]) expect(runFilter(x64, X64, nr)).toBe(SECCOMP.EPERM)
  for (const nr of [97, 280, 241, 282, 217, 218, 219]) expect(runFilter(arm64, ARM64, nr)).toBe(SECCOMP.EPERM)
  // clone3's flags sit in memory the filter can't read: ENOSYS, and the C library falls back to clone().
  expect(runFilter(x64, X64, 435)).toBe(SECCOMP.ENOSYS)
  expect(runFilter(arm64, ARM64, 435)).toBe(SECCOMP.ENOSYS)
  // clone() as fork and pthread_create make it runs; with any namespace flag it's refused.
  const SIGCHLD = 17
  const forkFlags = 0x01200000 | SIGCHLD // CLONE_CHILD_SETTID | CLONE_CHILD_CLEARTID
  const threadFlags = 0x003d0f00 // VM, FS, FILES, SIGHAND, THREAD, SYSVSEM, SETTLS, PARENT_SETTID, CHILD_CLEARTID
  for (const [f, clone] of [[x64, 56], [arm64, 220]] as const) {
    const arch = f === x64 ? X64 : ARM64
    expect(runFilter(f, arch, clone, forkFlags)).toBe(SECCOMP.ALLOW)
    expect(runFilter(f, arch, clone, threadFlags)).toBe(SECCOMP.ALLOW)
    for (const ns of [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000]) {
      expect(CLONE_NAMESPACES & ns).toBe(ns)
      expect(runFilter(f, arch, clone, forkFlags | ns)).toBe(SECCOMP.EPERM)
    }
  }
})

test("the process cap counts the person's own tasks, threads included, and allows a fixed number more", () => {
  const status = (uid: number, threads: number) => `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nThreads:\t${threads}\n`
  expect(userTasks([status(501, 1), status(501, 12), status(0, 40), "Name:\tgone\n"], 501)).toBe(13)
  expect(HOLD_PROC_HEADROOM).toBeLessThanOrEqual(256)
})

describe("a runtime's read-only grant", () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  /** A home with a runtime at each of `places` (paths under it). */
  const home = (...places: string[]) => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), "chrn-hold-home-")))
    dirs.push(h)
    for (const place of places) {
      mkdirSync(dirname(join(h, place)), { recursive: true })
      writeFileSync(join(h, place), "#!/bin/sh\n", { mode: 0o755 })
    }
    return h
  }

  test("the usual installs: the binary's folder under ~/.bun, a version's own folder two down, a system prefix", () => {
    const h = home(".bun/bin/bun", ".nvm/versions/node/v22.0.0/bin/node", ".pyenv/versions/3.12.1/bin/python3")
    expect(installReads(join(h, ".bun/bin/bun"), h)).toEqual([join(h, ".bun/bin")])
    expect(installReads(join(h, ".nvm/versions/node/v22.0.0/bin/node"), h)).toEqual([join(h, ".nvm/versions/node/v22.0.0")])
    expect(installReads(join(h, ".pyenv/versions/3.12.1/bin/python3"), h)).toEqual([join(h, ".pyenv/versions/3.12.1")])
    // Outside the home: the prefix above the binary's real folder (`/usr` for a program in `/usr/bin`).
    const sh = dirname(realpathSync("/bin/sh"))
    expect(installReads("/bin/sh", h)).toEqual([dirname(sh) === "/" ? sh : dirname(sh)])
  })

  test("never the home: a runtime sitting right in it is refused, not granted with everything beside it", () => {
    const h = home("node")
    expect(() => installReads(join(h, "node"), h)).toThrow(RuntimePlaceRefused)
  })

  test("a runtime in a folder right under the home (Downloads, Desktop) is granted alone, never with the files beside it", () => {
    const h = home("Downloads/node", "Desktop/bun", "Downloads/node-v22.0.0/bin/node")
    expect(installReads(join(h, "Downloads/node"), h)).toEqual([join(h, "Downloads/node")])
    expect(installReads(join(h, "Desktop/bun"), h)).toEqual([join(h, "Desktop/bun")])
    // Unpacked into a folder of its own, that folder is its install.
    expect(installReads(join(h, "Downloads/node-v22.0.0/bin/node"), h)).toEqual([join(h, "Downloads/node-v22.0.0")])
    // The file alone, in both holds' terms.
    expect(seatbeltProfile(join(h, "work"), [join(h, "Downloads/node")], join(h, "Downloads/node"))).not.toContain(`(subpath "${join(h, "Downloads")}")`)
  })

  test("never a folder that holds the Harness's own: only the binary's folder, and a runtime inside the Harness's folder is refused", () => {
    const h = home(".config/candle/bin/node", ".config/bin/node", ".config/candle/harness/state/node", "elsewhere/harness-home/tools/bin/node", "elsewhere/harness-home/node", ".config/node")
    // The prefix would be ~/.config/candle, which holds the keys and the view token.
    expect(installReads(join(h, ".config/candle/bin/node"), h)).toEqual([join(h, ".config/candle/bin")])
    expect(installReads(join(h, ".config/bin/node"), h)).toEqual([join(h, ".config/bin")])
    // Right in ~/.config: the one file, which opens nothing beside it.
    expect(installReads(join(h, ".config/node"), h)).toEqual([join(h, ".config/node")])
    expect(() => installReads(join(h, ".config/candle/harness/state/node"), h)).toThrow(RuntimePlaceRefused)
    // A Harness home moved elsewhere is closed the same way, once it's named.
    const moved = join(h, "elsewhere/harness-home")
    expect(() => installReads(join(moved, "tools/bin/node"), h, [moved])).toThrow(RuntimePlaceRefused)
    expect(() => installReads(join(moved, "node"), h, [moved])).toThrow(RuntimePlaceRefused)
  })
})

test("the Seatbelt profile opens Homebrew only for Homebrew's own runtime, and never its etc or var beyond OpenSSL's public settings", () => {
  // Apple's python, or one in the home: no line names Homebrew at all.
  for (const p of [seatbeltProfile("/r", ["/usr"], "/usr/bin/python3"), profile]) expect(p).not.toContain("/opt/homebrew")
  const brew = seatbeltProfile("/r", ["/opt/homebrew/Cellar/python@3.12/3.12.4"], "/opt/homebrew/Cellar/python@3.12/3.12.4/bin/python3.12")
  expect(brew).not.toContain('(subpath "/opt/homebrew")')
  expect(brew).not.toContain("/opt/homebrew/var")
  for (const dir of ["Cellar", "opt", "lib", "share"]) expect(brew).toContain(`(subpath "/opt/homebrew/${dir}")`)
  // etc: read only, and only these.
  const etc = [...brew.matchAll(/\(subpath "\/opt\/homebrew\/etc[^"]*"\)/g)].map((m) => m[0])
  expect(etc).toEqual(['(subpath "/opt/homebrew/etc/openssl@3")', '(subpath "/opt/homebrew/etc/openssl@1.1")', '(subpath "/opt/homebrew/etc/ca-certificates")'])
  for (const line of brew.split("\n").filter((l) => l.includes("process-exec") || l.includes("file-map-executable"))) expect(line).not.toContain("/opt/homebrew/etc")
})
