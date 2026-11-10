// install.sh, run under a scratch home against a release folder. A fake `candle`
// stands in for the user's: it logs its argv and "verifies" a bundle that names the file's SHA-256 and
// the identity it was signed as. install.live.test.ts runs the same script with Candle's real CLI.
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { MIN_CANDLE_CLI } from "../src/setup/doctor"
import { testCopy, testRelease } from "./install-switch"
import { binaryName, PLATFORMS, RELEASE_ASSETS, writeReleaseFiles } from "./release-files"

const ROOT = join(import.meta.dir, "..")
const SHIPPED = readFileSync(join(ROOT, "install.sh"), "utf8")
// The test copy: the shipped script with its unsigned switch reading CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING.
const SCRIPT = testCopy(SHIPPED)
const ISSUER = "https://token.actions.githubusercontent.com"
const PREFIX = "https://github.com/candledottv/harness/.github/workflows/release.yaml@refs/tags/v"
const CLI_IDENTITY = `https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/cli-v${MIN_CANDLE_CLI}`
const PLATFORM = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`
const ASSET = binaryName(PLATFORM)
// What install.sh runs from the system, linked into the tests' PATH so no real candle, cosign or gh is found.
const TOOLS = ["bash", "env", "uname", "sha256sum", "awk", "sed", "grep", "tr", "head", "mktemp", "cp", "mv", "ln", "chmod", "mkdir", "rmdir", "rm", "dirname", "readlink", "cat", "touch", "date"]

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", dir])
    rmSync(dir, { recursive: true, force: true })
  }
})

// The fake candle: --version from $FAKE_CANDLE_VERSION (or a version file beside it, which `update`
// writes), and verify against a bundle shaped {"sha256", "identity"}. With no --identity it takes the
// version from a latest.json beside the bundle, as the real one does.
const FAKE_CANDLE = `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
echo "$*" >> "\${FAKE_CANDLE_LOG:-/dev/null}"
case "$1" in
  --version) if [ -f "$here/.fake-version" ]; then cat "$here/.fake-version"; else echo "\${FAKE_CANDLE_VERSION:-${MIN_CANDLE_CLI}}"; fi ;;
  update) echo "$3" | sed 's/^cli-v//' > "$here/.fake-version"; echo "Updated" ;;
  verify)
    file="$2"; shift 2; bundle=""; identity=""
    while [ $# -gt 0 ]; do case "$1" in --bundle) bundle="$2"; shift 2 ;; --identity) identity="$2"; shift 2 ;; *) shift 2 ;; esac; done
    if [ -z "$identity" ]; then
      v="$(tr -d '[:space:]' < "$(dirname "$bundle")/latest.json" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')"
      identity="${PREFIX}$v"
    fi
    want="$(tr -d '[:space:]' < "$bundle" | sed -n 's/.*"sha256":"\\([0-9a-f]*\\)".*/\\1/p')"
    signer="$(tr -d '[:space:]' < "$bundle" | sed -n 's/.*"identity":"\\([^"]*\\)".*/\\1/p')"
    [ "$(sha256sum "$file" | awk '{print $1}')" = "$want" ] || { echo "digest mismatch" >&2; exit 1; }
    [ "$signer" = "$identity" ] || { echo "identity: expected $identity, got $signer" >&2; exit 1; }
    echo "ok Release signature verified" ;;
  *) exit 2 ;;
esac
`

// The fake candle-harness: its version line, and for `version --core` the running core's, from a file beside it.
const fakeHarness = (version: string) =>
  `#!/usr/bin/env bash\nif [ "$*" = "version --core" ]; then cat "$(dirname "$0")/.fake-core" 2>/dev/null; exit 0; fi\necho "candle-harness ${version} (abc1234)"\n`
const bundle = (bytes: string, identity: string) => JSON.stringify({ sha256: sha256(bytes), identity })

interface Scene {
  dir: string
  home: string
  release: string
  sysbin: string
  log: string
}

function scene(): Scene {
  const dir = mkdtempSync(join(tmpdir(), "chrn-install-"))
  dirs.push(dir)
  const home = join(dir, "home")
  const sysbin = join(dir, "sysbin")
  mkdirSync(home)
  mkdirSync(sysbin)
  for (const tool of TOOLS) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()
    if (found) symlinkSync(found, join(sysbin, tool))
  }
  return { dir, home, release: join(dir, "release"), sysbin, log: join(dir, "candle.log") }
}

/** A release folder for `version`, its binary signed as `signedAs` (the release's own identity by default). */
function release(s: Scene, version: string, opts: { signedAs?: string; tag?: string; bytes?: string; noBundle?: boolean } = {}): void {
  mkdirSync(s.release, { recursive: true })
  const assets: Record<string, { name: string; sha256: string; size: number }> = {}
  const sums: string[] = []
  for (const platform of PLATFORMS) {
    const name = binaryName(platform)
    const bytes = fakeHarness(version)
    writeFileSync(join(s.release, name), bytes)
    assets[platform] = { name, sha256: sha256(bytes), size: bytes.length }
    sums.push(`${sha256(bytes)}  ${name}`)
    if (!opts.noBundle) writeFileSync(join(s.release, `${name}.sigstore.json`), bundle(bytes, opts.signedAs ?? `${PREFIX}${version}`))
  }
  writeFileSync(join(s.release, "SHA256SUMS"), `${sums.join("\n")}\n`)
  writeFileSync(join(s.release, "latest.json"), JSON.stringify({ version, tag: opts.tag ?? `v${version}`, assets }, null, 2))
  if (opts.bytes !== undefined) writeFileSync(join(s.release, ASSET), opts.bytes)
}

function candleIn(dir: string, version?: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "candle")
  writeFileSync(path, FAKE_CANDLE)
  chmodSync(path, 0o755)
  if (version) writeFileSync(join(dir, ".fake-version"), `${version}\n`)
  return path
}

interface Run {
  code: number
  out: string
}

function run(s: Scene, args: string[], opts: { path?: string[]; tty?: string; env?: Record<string, string>; script?: string; shell?: string } = {}): Run {
  const script = join(s.dir, "install.sh")
  writeFileSync(script, opts.script ?? SCRIPT)
  const result = spawnSync(join(s.sysbin, "bash"), [script, ...args], {
    cwd: s.dir,
    encoding: "utf8",
    env: {
      HOME: s.home,
      PATH: [...(opts.path ?? []), s.sysbin].join(":"),
      SHELL: opts.shell ?? "/bin/zsh",
      TMPDIR: s.dir,
      FAKE_CANDLE_LOG: s.log,
      CANDLE_HARNESS_INSTALL_TTY: opts.tty ?? join(s.dir, "no-terminal"),
      ...opts.env,
    },
  })
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` }
}

function answer(s: Scene, text: string): string {
  const path = join(s.dir, "answer")
  writeFileSync(path, `${text}\n`)
  return path
}

/** Every path under the scratch home, with its mode and size: a refusal must leave it as it was. */
function snapshot(home: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const st = lstatSync(path)
      out.push(`${relative(home, path)} ${st.mode.toString(8)} ${st.isDirectory() ? "" : st.size}`)
      if (st.isDirectory()) walk(path)
    }
  }
  walk(home)
  return out
}

const verifyCalls = (s: Scene) => (existsSync(s.log) ? readFileSync(s.log, "utf8").split("\n").filter((l) => l.startsWith("verify")) : [])

const tmpFile = (s: Scene) => {
  const tmp = readdirSync(s.dir).find((d) => d.startsWith("tmp."))
  return tmp === undefined ? "" : join(s.dir, tmp)
}

test("a test run's release folder can be read by the separate user the install route runs as", () => {
  const release = mkdtempSync(join(tmpdir(), "chrn-rel-src-"))
  writeFileSync(join(release, "install.sh"), SHIPPED)
  const dir = testRelease(release, mkdtempSync(join(tmpdir(), "chrn-rel-test-")))
  expect(statSync(dir).mode & 0o777).toBe(0o755)
  expect(statSync(join(dir, "install.sh")).mode & 0o777).toBe(0o755)
  rmSync(release, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("a good install", () => {
  test("from a release folder: the checksum, then the user's own candle verify pinned to the exact tag, then into place", () => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    const r = run(s, ["--from", s.release], { path: [bin] })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Installed candle-harness 1.2.3 to ${bin}/candle-harness, signature checked by candle verify.`)
    expect(r.out).toContain("candle-harness 1.2.3 (abc1234)")
    // It says what it's doing before anything slow, and names a CLI that's already there.
    expect(r.out.startsWith("Checking this machine for the Candle CLI…")).toBe(true)
    expect(r.out).toMatch(/The Candle CLI \S+ is already installed, at .*\/bin\/candle\./)
    expect(r.out.trimEnd().endsWith("Next: candle-harness")).toBe(true)
    expect(r.out).not.toContain("isn't on your PATH")
    expect(statSync(join(bin, "candle-harness")).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(bin, "candle-harness"), "utf8")).toBe(fakeHarness("1.2.3"))
    // --identity and --issuer always, so a latest.json beside the bundle never decides the identity.
    const calls = verifyCalls(s)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEndWith(`--identity ${PREFIX}1.2.3 --issuer ${ISSUER}`)
    // Nothing else in the home: no shell file edited, no staging file left, the temporary folder gone.
    expect(snapshot(s.home).map((l) => l.split(" ")[0])).toEqual(["bin", "bin/candle", "bin/candle-harness", "bin/candle-tui"])
    expect(tmpFile(s)).toBe("")
  })

  test("candle-tui, the name the CLI's candle tui runs, is linked to candle-harness beside it, a 0.2 binary there replaced", () => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    // A 0.2 install left its own binary under the old name.
    writeFileSync(join(bin, "candle-tui"), "#!/bin/sh\necho candle-tui 0.2.10\n", { mode: 0o755 })
    const r = run(s, ["--from", s.release], { path: [bin] })
    expect(r.code).toBe(0)
    expect(lstatSync(join(bin, "candle-tui")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(bin, "candle-tui"))).toBe("candle-harness")
    expect(readFileSync(join(bin, "candle-tui"), "utf8")).toBe(fakeHarness("1.2.3"))
    expect(r.out).toContain(`Linked ${bin}/candle-tui to candle-harness, so candle tui opens it. The candle-tui name is deprecated`)
    // Run again: the link is replaced by the same link, and nothing else is left behind.
    expect(run(s, ["--from", s.release], { path: [bin] }).code).toBe(0)
    expect(readlinkSync(join(bin, "candle-tui"))).toBe("candle-harness")
    expect(readdirSync(bin).sort()).toEqual(["candle", "candle-harness", "candle-tui"])
  })

  test("another candle-tui first on PATH (a 0.2 binary elsewhere) is named, since candle tui would open it", () => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    const elsewhere = join(s.home, "old")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "candle-tui"), "#!/bin/sh\necho candle-tui 0.2.10\n", { mode: 0o755 })
    const r = run(s, ["--from", s.release], { path: [elsewhere, bin] })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Note: another candle-tui comes first on PATH, at ${elsewhere}/candle-tui, so candle tui opens that one, not Candle Harness.`)
    expect(readlinkSync(join(bin, "candle-tui"))).toBe("candle-harness")
    // With the link first, nothing is said.
    const s2 = scene()
    release(s2, "1.2.3")
    const bin2 = join(s2.home, "bin")
    candleIn(bin2)
    expect(run(s2, ["--from", s2.release], { path: [bin2] }).out).not.toContain("another candle-tui")
  })

  test("candle-tui: a link to a folder is replaced, never followed; a file that isn't 0.2's and a folder are left, and said", () => {
    // A link to someone else's folder: mv must not drop the new link inside it.
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    const foreign = join(s.home, "foreign")
    mkdirSync(foreign)
    symlinkSync(foreign, join(bin, "candle-tui"))
    expect(run(s, ["--from", s.release], { path: [bin] }).code).toBe(0)
    expect(readlinkSync(join(bin, "candle-tui"))).toBe("candle-harness")
    expect(readdirSync(foreign)).toEqual([])
    expect(readdirSync(bin).sort()).toEqual(["candle", "candle-harness", "candle-tui"])

    // A script of the person's own under that name: left, run only for its version, and said.
    const s2 = scene()
    release(s2, "1.2.3")
    const bin2 = join(s2.home, "bin")
    candleIn(bin2)
    const mine = "#!/bin/sh\necho my own thing\n"
    writeFileSync(join(bin2, "candle-tui"), mine, { mode: 0o755 })
    const r2 = run(s2, ["--from", s2.release], { path: [bin2] })
    expect(r2.code).toBe(0)
    expect(lstatSync(join(bin2, "candle-tui")).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(bin2, "candle-tui"), "utf8")).toBe(mine)
    expect(r2.out).toContain(`Left ${bin2}/candle-tui as it is: it isn't Candle TUI 0.2's binary`)
    expect(r2.out).not.toContain("Linked ")

    // A folder of that name: left, and said.
    const s3 = scene()
    release(s3, "1.2.3")
    const bin3 = join(s3.home, "bin")
    candleIn(bin3)
    mkdirSync(join(bin3, "candle-tui"))
    const r3 = run(s3, ["--from", s3.release], { path: [bin3] })
    expect(r3.code).toBe(0)
    expect(readdirSync(join(bin3, "candle-tui"))).toEqual([])
    expect(r3.out).toContain(`Left ${bin3}/candle-tui as it is: it's a folder`)
  })

  test("a folder as scripts/build.ts --release writes it: install.sh reads its SHA256SUMS and latest.json", () => {
    const s = scene()
    mkdirSync(s.release)
    for (const platform of PLATFORMS) writeFileSync(join(s.release, binaryName(platform)), fakeHarness("2.0.0"))
    writeFileSync(join(s.release, "install.sh"), SCRIPT)
    writeReleaseFiles(s.release, "2.0.0")
    writeFileSync(join(s.release, `${ASSET}.sigstore.json`), bundle(fakeHarness("2.0.0"), `${PREFIX}2.0.0`))
    const bin = join(s.home, "bin")
    candleIn(bin)
    const r = run(s, ["--from", s.release], { path: [bin] })
    expect(r.out).toContain("Installed candle-harness 2.0.0")
    expect(r.code).toBe(0)
  })

  test("--to a tag installs that release", () => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    expect(run(s, ["--from", s.release, "--to", "v1.2.3"], { path: [bin] }).code).toBe(0)
  })

  test("a candle that isn't the user's own (Homebrew's, npm's) doesn't decide the folder: ~/.local/bin", () => {
    const s = scene()
    release(s, "1.2.3")
    const cellar = join(s.dir, "Cellar", "candle", "0.13.5", "bin")
    candleIn(cellar)
    const brewBin = join(s.dir, "brewbin")
    mkdirSync(brewBin)
    symlinkSync(join(cellar, "candle"), join(brewBin, "candle"))
    const r = run(s, ["--from", s.release], { path: [brewBin] })
    expect(r.code).toBe(0)
    expect(existsSync(join(s.home, ".local", "bin", "candle-harness"))).toBe(true)
    expect(existsSync(join(brewBin, "candle-harness"))).toBe(false)
  })

  test("on WSL, Windows' candle under /mnt/c is skipped, said, and never updated", () => {
    const s = scene()
    release(s, "1.2.3")
    const mnt = join(s.dir, "mnt")
    // npm's Windows shim: a sh script, not node's, so only where it lives says it's Windows'.
    const shim = join(mnt, "c", "Users", "t", "AppData", "Roaming", "npm")
    mkdirSync(shim, { recursive: true })
    writeFileSync(join(shim, "candle"), '#!/bin/sh\necho "0.12.0"\n')
    chmodSync(join(shim, "candle"), 0o755)
    const env = { WSL_DISTRO_NAME: "Ubuntu", CANDLE_HARNESS_INSTALL_WINDOWS_MOUNT: mnt }
    const r = run(s, ["--from", s.release], { path: [shim], env, tty: answer(s, "n") })
    expect(r.out).toContain(`Skipping Windows' candle at ${shim}/candle: on WSL the Candle Harness needs the Linux CLI.`)
    expect(r.out).toContain("The Candle CLI isn't installed")
    expect(r.out).not.toContain("candle update")
    expect(existsSync(join(shim, "candle-harness"))).toBe(false)
    // With the Linux CLI on PATH as well, that one is used and decides the folder.
    const s2 = scene()
    release(s2, "1.2.3")
    const linux = join(s2.home, "bin")
    candleIn(linux)
    const shim2 = join(s2.dir, "mnt", "c", "npm")
    mkdirSync(shim2, { recursive: true })
    writeFileSync(join(shim2, "candle"), '#!/bin/sh\necho "0.12.0"\n')
    chmodSync(join(shim2, "candle"), 0o755)
    const r2 = run(s2, ["--from", s2.release], { path: [shim2, linux], env: { WSL_DISTRO_NAME: "Ubuntu", CANDLE_HARNESS_INSTALL_WINDOWS_MOUNT: join(s2.dir, "mnt") } })
    expect(r2.code).toBe(0)
    expect(r2.out).toContain(`Installed candle-harness 1.2.3 to ${linux}/candle-harness, signature checked by candle verify.`)
    // Off WSL the same folder is an ordinary one.
    const s3 = scene()
    release(s3, "1.2.3")
    const r3 = run(s3, ["--from", s3.release], { path: [shim2], env: { CANDLE_HARNESS_INSTALL_WINDOWS_MOUNT: join(s2.dir, "mnt") }, tty: answer(s3, "n") })
    expect(r3.out).not.toContain("Skipping Windows'")
  })

  test("a download says so first, and a binary shows curl's progress on a terminal", () => {
    expect(SCRIPT).toContain('echo "Downloading the Candle CLI ${CLI_VERSION} (about 100 MB)…"')
    expect(SCRIPT).toContain('echo "Downloading candle-harness ${version} (about 100 MB)…"')
    expect(SCRIPT).toMatch(/fetch "\$cli_source" "\$name" "\$tmp\/\$name" big/)
    expect(SCRIPT).toMatch(/fetch "\$release_source" "\$asset" "\$tmp\/\$asset" big/)
    // From a folder nothing downloads, so nothing says it does.
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    expect(run(s, ["--from", s.release], { path: [bin] }).out).not.toContain("Downloading")
  })

  test("off PATH, the one line to add is printed for the user's shell, and no shell file is touched", () => {
    for (const [shell, line] of [
      ["/bin/zsh", `echo 'path=(~/apps $path)' >> ~/.zshrc && source ~/.zshrc`],
      ["/bin/bash", `echo 'export PATH=~/apps:$PATH' >> ~/.bashrc && source ~/.bashrc`],
      ["/usr/bin/fish", "fish_add_path "],
    ] as const) {
      const s = scene()
      release(s, "1.2.3")
      const bin = join(s.home, "bin")
      candleIn(bin)
      const r = run(s, ["--from", s.release, "--bin-dir", "~/apps"], { path: [bin], shell })
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${s.home}/apps isn't on your PATH. Add it with:`)
      expect(r.out).toContain(line)
      expect(snapshot(s.home).map((l) => l.split(" ")[0])).toEqual(["apps", "apps/candle-harness", "apps/candle-tui", "bin", "bin/candle"])
    }
  })

  test("the printed line has one $ only, and run as printed it puts the folder first on PATH", () => {
    for (const [shell, rc, dir] of [
      ["/bin/zsh", ".zshrc", "~/apps"],
      ["/bin/bash", ".bashrc", "~/apps"],
      ["/bin/bash", ".bashrc", "~/my apps"],
    ] as const) {
      const s = scene()
      release(s, "1.2.3")
      const bin = join(s.home, "bin")
      candleIn(bin)
      const r = run(s, ["--from", s.release, "--bin-dir", dir], { path: [bin], shell })
      expect(r.code).toBe(0)
      const line = r.out.split("\n").find((l) => l.includes(`>> ~/${rc}`))!.trim()
      expect(line.split("$").length - 1).toBe(1)
      // Run the printed line's echo as the user would, then a new shell reading that file.
      const runner = shell === "/bin/zsh" ? Bun.which("zsh") : "/bin/bash"
      if (!runner) continue
      const wrote = Bun.spawnSync([runner, "-c", line.replace(/ && source .*$/, "")], { env: { HOME: s.home, PATH: "/usr/bin:/bin" } })
      expect(wrote.exitCode).toBe(0)
      const seen = Bun.spawnSync([runner, "-c", `source ~/${rc}; printf '%s' "$PATH"`], { env: { HOME: s.home, PATH: "/usr/bin:/bin" } })
      expect(seen.stdout.toString()).toBe(`${join(s.home, dir.slice(2))}:/usr/bin:/bin`)
    }
  })

  test("the shipped script never installs an unsigned file, whatever the environment says", () => {
    const s = scene()
    release(s, "1.2.3", { noBundle: true })
    const r = run(s, ["--from", s.release, "--no-cli"], { env: { CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING: "1" }, script: SHIPPED })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain("the release has no signature for")
    expect(existsSync(join(s.home, ".local", "bin", "candle-harness"))).toBe(false)
    // No line of it reads the variable: only the test copy does.
    expect(SHIPPED.includes("${CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING")).toBe(false)
    expect(SCRIPT.includes("${CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING")).toBe(true)
  })

  test("the testing switch installs an unsigned file, says so, and is named for testing only", () => {
    const s = scene()
    release(s, "1.2.3", { noBundle: true })
    const r = run(s, ["--from", s.release, "--no-cli"], { env: { CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING: "1" } })
    expect(r.code).toBe(0)
    expect(r.out).toContain("signature wasn't checked (CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING=1, for testing only)")
    expect(existsSync(join(s.home, ".local", "bin", "candle-harness"))).toBe(true)
    // No CLI: the way to one is this installer's own checked route, never a pipe to another script.
    expect(r.out).toContain("run this installer again with --yes, which installs Candle's CLI")
    expect(r.out).not.toContain("| bash")
  })
})

describe("a core the old version left running", () => {
  const install = (core: string | undefined) => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    if (core !== undefined) writeFileSync(join(bin, ".fake-core"), core)
    return run(s, ["--from", s.release], { path: [bin] })
  }

  test("is named with its version and how to restart it, and is never stopped from here", () => {
    const r = install("core 1.2.2\n")
    expect(r.code).toBe(0)
    expect(r.out).toContain("A core from 1.2.2 is still running, with its triggers and bots. It carries on as 1.2.2 until it's restarted: open candle-harness and choose restart it in its status bar.")
  })

  test("nothing is said with no core running, with one already on this version, or when the answer isn't a version", () => {
    for (const core of [undefined, "core 1.2.3\n", "candle-harness 1.2.2 (abc1234)\n", "core $(reboot)\n"]) {
      const r = install(core)
      expect(r.code).toBe(0)
      expect(r.out).not.toContain("still running")
    }
  })
})

describe("a download cut short", () => {
  // Piped from curl, bash runs what it has read so far. Cut anywhere, the script must do nothing at all.
  const cutAt = (script: string, s: Scene, bin: string, before: string[], at: number) => {
    const r = run(s, ["--from", s.release], { path: [bin], script: script.slice(0, at) })
    expect({ at, files: snapshot(s.home), out: r.out.includes("Installed") || r.out.includes("Checking this machine") }).toEqual({ at, files: before, out: false })
  }

  test("at any line's end, or anywhere in the last line, installs nothing and starts nothing", () => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin)
    const before = snapshot(s.home)
    const whole = SCRIPT.trimEnd()
    let at = -1
    while ((at = whole.indexOf("\n", at + 1)) >= 0) cutAt(whole, s, bin, before, at + 1)
    const lastLine = whole.lastIndexOf("\n") + 1
    for (let i = lastLine; i < whole.length; i++) cutAt(whole, s, bin, before, i)
    // The whole script, with no newline at its end, still installs.
    expect(run(s, ["--from", s.release], { path: [bin], script: whole }).out).toContain("Installed candle-harness 1.2.3")
  }, 120_000)

  test("the pins and constants stay at the top level, one to a line, where the workflow and the pin script read them", () => {
    const top = SHIPPED.slice(0, SHIPPED.indexOf("\nmain() {\n"))
    for (const line of ["REPOSITORY='candledottv/harness'", "TAG_PREFIX='v'", `IDENTITY_PREFIX='${PREFIX}'`, "UNSIGNED_OK=0", "# BEGIN CLI PINS", `CLI_TAG='cli-v${MIN_CANDLE_CLI}'`, `CLI_IDENTITY='${CLI_IDENTITY}'`, "# END CLI PINS"]) {
      expect(top.split("\n")).toContain(line)
    }
    expect(top).toMatch(/\n    candle-linux-x64\) echo '[0-9a-f]{64}' ;;\n/)
    expect(SHIPPED.trimEnd().endsWith('\n{ main "$@"; }')).toBe(true)
  })
})

/** Runs install.sh expecting a refusal, and checks the home is exactly as it was. */
function refused(s: Scene, args: string[], opts: Parameters<typeof run>[2] = {}): Run {
  const before = snapshot(s.home)
  const r = run(s, args, opts)
  expect(r.code).not.toBe(0)
  expect(r.out).toContain("nothing")
  expect(snapshot(s.home)).toEqual(before)
  expect(tmpFile(s)).toBe("")
  return r
}

describe("refusals leave the machine unchanged", () => {
  const withCandle = (s: Scene) => {
    const bin = join(s.home, "bin")
    candleIn(bin)
    return [bin]
  }

  test("a binary whose checksum doesn't match SHA256SUMS", () => {
    const s = scene()
    release(s, "1.2.3", { bytes: fakeHarness("6.6.6") })
    expect(refused(s, ["--from", s.release], { path: withCandle(s) }).out).toContain("but SHA256SUMS says")
  })

  test("SHA256SUMS and latest.json disagreeing", () => {
    const s = scene()
    release(s, "1.2.3")
    const sums = readFileSync(join(s.release, "SHA256SUMS"), "utf8")
    const swapped = fakeHarness("6.6.6")
    writeFileSync(join(s.release, ASSET), swapped)
    writeFileSync(join(s.release, "SHA256SUMS"), sums.replace(new RegExp(`^[0-9a-f]+  ${ASSET}$`, "m"), `${sha256(swapped)}  ${ASSET}`))
    expect(refused(s, ["--from", s.release], { path: withCandle(s) }).out).toContain("but latest.json says")
  })

  test("a signature for another tag", () => {
    const s = scene()
    release(s, "1.2.3", { signedAs: `${PREFIX}1.2.2` })
    expect(refused(s, ["--from", s.release], { path: withCandle(s) }).out).toContain(`isn't signed by ${PREFIX}1.2.3`)
  })

  test("a signature from another workflow or repository, whatever latest.json beside it says", () => {
    const s = scene()
    // Signed by another repository's release workflow at the same tag: the fake candle would accept it
    // if it were left to work the identity out from latest.json; install.sh never lets it.
    release(s, "1.2.3", { signedAs: "https://github.com/someone/else/.github/workflows/release.yaml@refs/tags/v1.2.3" })
    refused(s, ["--from", s.release], { path: withCandle(s) })
    expect(verifyCalls(s).every((c) => c.includes(`--identity ${PREFIX}1.2.3 --issuer ${ISSUER}`))).toBe(true)
  })

  test("an older signed release offered for the tag asked for", () => {
    const s = scene()
    release(s, "1.2.2")
    expect(refused(s, ["--from", s.release, "--to", "v1.2.3"], { path: withCandle(s) }).out).toContain("asked for v1.2.3, but the release found is v1.2.2")
  })

  test("a version that isn't three numbers, or a tag that doesn't match it", () => {
    const s = scene()
    release(s, "1.2.3|")
    expect(refused(s, ["--from", s.release], { path: withCandle(s) }).out).toContain("isn't a version")
    const s2 = scene()
    release(s2, "1.2.3", { tag: "v9.9.9" })
    expect(refused(s2, ["--from", s2.release], { path: withCandle(s2) }).out).toContain("but tag v9.9.9")
  })

  test("a release with no signature", () => {
    const s = scene()
    release(s, "1.2.3", { noBundle: true })
    expect(refused(s, ["--from", s.release], { path: withCandle(s) }).out).toContain("has no signature")
  })

  test("no candle, and no yes: nothing verified, the CLI offered, nothing installed", () => {
    const s = scene()
    release(s, "1.2.3")
    const r = refused(s, ["--from", s.release])
    expect(r.out).toContain(`The Candle CLI isn't installed, and the Candle Harness needs it (${MIN_CANDLE_CLI}).`)
    expect(r.out).toContain("Install the Candle CLI now?")
    expect(r.out).toContain("No: there's no terminal to answer on")
    expect(r.out).toContain("The Candle CLI wasn't installed, and nothing else here can check")
    const s2 = scene()
    release(s2, "1.2.3")
    expect(refused(s2, ["--from", s2.release], { tty: answer(s2, "n") }).out).toContain("Install the Candle CLI now? [y/N]")
  })

  test("a folder that isn't the user's", () => {
    const s = scene()
    release(s, "1.2.3")
    const path = withCandle(s)
    const locked = join(s.home, "locked")
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    expect(refused(s, ["--from", s.release, "--bin-dir", locked], { path }).out).toContain("isn't yours to write to")
    if (process.getuid?.() !== 0) expect(refused(s, ["--from", s.release, "--bin-dir", "/usr/lib/candle"], { path }).out).toContain("isn't yours to write to")
  })

  test("a release over plain http", () => {
    const s = scene()
    const r = refused(s, [], { path: withCandle(s), env: { CANDLE_HARNESS_RELEASE_BASE_URL: "http://example.invalid/releases" } })
    expect(r.out).toContain("must come over https")
  })

  test("a folder made for the install is removed again", () => {
    const s = scene()
    release(s, "1.2.3", { signedAs: `${PREFIX}1.2.2` })
    refused(s, ["--from", s.release, "--bin-dir", "~/new/deeper/bin"], { path: withCandle(s) })
    expect(existsSync(join(s.home, "new"))).toBe(false)
  })
})

// The CLI's files, faked: the fake candle as candle-<platform>, a helper, their bundles signed as
// Candle's CLI, and a copy of install.sh pinned to their sums (the real pins are Candle's real files).
function cliRelease(s: Scene, opts: { signedAs?: string; tamper?: boolean } = {}): { dir: string; script: string } {
  const dir = join(s.dir, "cli-release")
  mkdirSync(dir)
  const files = { [`candle-${PLATFORM}`]: FAKE_CANDLE, [`candle-fido2-${PLATFORM}`]: "fido2 helper\n" }
  let pins = ""
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(dir, name), opts.tamper && name.startsWith("candle-fido2") ? "something else\n" : bytes)
    writeFileSync(join(dir, `${name}.sigstore.json`), bundle(bytes, opts.signedAs ?? CLI_IDENTITY))
    pins += `    ${name}) echo '${sha256(bytes)}' ;;\n`
  }
  const script = SCRIPT.replace(/cli_pin\(\) \{\n  case "\$1" in\n[\s\S]*?    \*\) echo '' ;;/, `cli_pin() {\n  case "$1" in\n${pins}    *) echo '' ;;`)
  expect(script).not.toBe(SCRIPT)
  return { dir, script }
}

describe("the Candle CLI first", () => {
  test("none, and a yes: Candle's files checked against the pins, installed, then the Candle Harness verified by that candle", () => {
    const s = scene()
    release(s, "1.2.3")
    const cli = cliRelease(s)
    const r = run(s, ["--from", s.release], { tty: answer(s, "y"), script: cli.script, env: { CANDLE_HARNESS_CLI_RELEASE_DIR: cli.dir } })
    expect(r.code).toBe(0)
    const bin = join(s.home, ".local", "bin")
    expect(r.out).toContain(`Installed the Candle CLI ${MIN_CANDLE_CLI} to ${bin}/candle, checked against the SHA-256s this installer carries for Candle's release.`)
    // It never claims a signature check the candle made of itself.
    expect(r.out).not.toContain("Candle's signature")
    expect(r.out).not.toContain("Candle's own signature")
    expect(r.out).toContain("signature checked by candle verify")
    expect(readFileSync(join(bin, "candle"), "utf8")).toBe(FAKE_CANDLE)
    expect(readFileSync(join(bin, "candle-fido2"), "utf8")).toBe("fido2 helper\n")
    const calls = verifyCalls(s)
    expect(calls.slice(0, 2).every((c) => c.endsWith(`--identity ${CLI_IDENTITY} --issuer ${ISSUER}`))).toBe(true)
    expect(calls[2]).toEndWith(`--identity ${PREFIX}1.2.3 --issuer ${ISSUER}`)
    expect(snapshot(s.home).map((l) => l.split(" ")[0])).toEqual([".local", ".local/bin", ".local/bin/candle", ".local/bin/candle-fido2", ".local/bin/candle-harness", ".local/bin/candle-tui"])
  })

  test("0.2's CANDLE_TUI_ names are still read when the new ones aren't set, said once as deprecated; the new name wins", () => {
    const s = scene()
    release(s, "1.2.3")
    const cli = cliRelease(s)
    const r = run(s, ["--from", s.release], { script: cli.script, env: { CANDLE_HARNESS_INSTALL_TTY: "", CANDLE_TUI_INSTALL_TTY: answer(s, "y"), CANDLE_TUI_CLI_RELEASE_DIR: cli.dir } })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Installed the Candle CLI ${MIN_CANDLE_CLI}`)
    expect(r.out.split("\n").filter((l) => l.includes("deprecated") && l.includes("CANDLE_TUI_"))).toEqual(["Note: CANDLE_TUI_CLI_RELEASE_DIR CANDLE_TUI_INSTALL_TTY read under the CANDLE_HARNESS_ name; the CANDLE_TUI_ names are deprecated."])
    // Set both ways, the new one is read and nothing is said.
    const s2 = scene()
    release(s2, "1.2.3")
    const r2 = run(s2, ["--from", s2.release], { tty: answer(s2, "n"), env: { CANDLE_TUI_INSTALL_TTY: answer(s2, "y") } })
    expect(r2.out).not.toContain("deprecated")
    expect(r2.out).not.toContain(`Installed the Candle CLI`)
  })

  test("--yes is the yes", () => {
    const s = scene()
    release(s, "1.2.3")
    const cli = cliRelease(s)
    const r = run(s, ["--from", s.release, "--yes"], { script: cli.script, env: { CANDLE_HARNESS_CLI_RELEASE_DIR: cli.dir } })
    expect(r.code).toBe(0)
    expect(r.out).toContain("Install the Candle CLI now? yes (--yes)")
  })

  test("a CLI file that isn't the one pinned installs nothing, the CLI included", () => {
    const s = scene()
    release(s, "1.2.3")
    const cli = cliRelease(s, { tamper: true })
    const r = refused(s, ["--from", s.release, "--yes"], { script: cli.script, env: { CANDLE_HARNESS_CLI_RELEASE_DIR: cli.dir } })
    expect(r.out).toContain(`isn't the file Candle released as cli-v${MIN_CANDLE_CLI}`)
  })

  test("a CLI file signed as anything but Candle's release installs nothing", () => {
    const s = scene()
    release(s, "1.2.3")
    const cli = cliRelease(s, { signedAs: "https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/cli-v0.13.4" })
    const r = refused(s, ["--from", s.release, "--yes"], { script: cli.script, env: { CANDLE_HARNESS_CLI_RELEASE_DIR: cli.dir } })
    expect(r.out).toContain("doesn't carry Candle's signature")
  })

  test("a release refused after the CLI went in says the CLI stays, and never that nothing was installed", () => {
    const s = scene()
    release(s, "1.2.3", { signedAs: `${PREFIX}1.2.2` })
    const cli = cliRelease(s)
    const r = run(s, ["--from", s.release, "--yes"], { script: cli.script, env: { CANDLE_HARNESS_CLI_RELEASE_DIR: cli.dir } })
    expect(r.code).not.toBe(0)
    const bin = join(s.home, ".local", "bin")
    expect(r.out).toContain(`isn't signed by ${PREFIX}1.2.3; candle-harness wasn't installed. The Candle CLI ${MIN_CANDLE_CLI} this run installed stays at ${bin}/candle`)
    expect(r.out.toLowerCase()).not.toContain("nothing installed")
    expect(r.out.toLowerCase()).not.toContain("nothing was installed")
    expect(snapshot(s.home).map((l) => l.split(" ")[0])).toEqual([".local", ".local/bin", ".local/bin/candle", ".local/bin/candle-fido2"])
  })

  test("the shipped script's pins carry no copy of the fake's: they're Candle's own", () => {
    const s = scene()
    const cli = cliRelease(s)
    release(s, "1.2.3")
    const r = refused(s, ["--from", s.release, "--yes"], { env: { CANDLE_HARNESS_CLI_RELEASE_DIR: cli.dir } })
    expect(r.out).toContain("isn't the file Candle released")
  })

  test("an older CLI: candle update --to the pinned tag on a yes, then it verifies", () => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin, "0.12.0")
    const r = run(s, ["--from", s.release], { path: [bin], tty: answer(s, "y") })
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Your Candle CLI (${bin}/candle) is 0.12.0; the Candle Harness needs ${MIN_CANDLE_CLI}.`)
    expect(readFileSync(s.log, "utf8")).toContain(`update --to cli-v${MIN_CANDLE_CLI}`)
    expect(r.out).toContain("signature checked by candle verify")
  })

  test("an older CLI and a no: it isn't asked to verify, and with nothing else to, nothing is installed", () => {
    const s = scene()
    release(s, "1.2.3")
    const bin = join(s.home, "bin")
    candleIn(bin, "0.12.0")
    const r = refused(s, ["--from", s.release], { path: [bin], tty: answer(s, "n") })
    expect(r.out).toContain(`The Candle CLI here is 0.12.0, older than ${MIN_CANDLE_CLI}, and nothing else here can check`)
    expect(verifyCalls(s)).toEqual([])
  })
})

describe("what install.sh is pinned to", () => {
  test("the Candle Harness's release workflow on a v<version> tag, which the workflow checks it signs as", () => {
    expect(SCRIPT).toContain(`IDENTITY_PREFIX='${PREFIX}'`)
    expect(SCRIPT).toContain("TAG_PREFIX='v'")
    expect(SCRIPT).toContain(`ISSUER='${ISSUER}'`)
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yaml"), "utf8")
    expect(workflow).toContain('tags: ["v*"]')
    expect(workflow).toContain("IDENTITY_PREFIX=")
  })

  test("the workflow: every action pinned by commit, every release file signed, publishing only from a tag in candledottv/harness", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "release.yaml"), "utf8")
    const workflow = Bun.YAML.parse(text) as {
      jobs: Record<string, { if?: string; environment?: string; permissions?: Record<string, string>; steps: { uses?: string; run?: string }[] }>
    }
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps)
    for (const { uses } of steps) if (uses) expect(uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
    const signing = steps.find((step) => step.run?.includes("cosign sign-blob"))?.run ?? ""
    const signed = /for f in ([^;]+);/.exec(signing)?.[1]?.trim().split(/\s+/).sort()
    expect(signed).toEqual([...RELEASE_ASSETS, "SHA256SUMS", "latest.json"].sort())
    const publish = workflow.jobs.publish
    expect(publish?.if).toBe("github.event_name == 'push' && github.repository == 'candledottv/harness'")
    expect(publish?.environment).toBe("production")
    expect(workflow.jobs.build?.permissions?.contents).toBe("read")
    // A rehearsal's version reaches the shell through env, never pasted into the script.
    for (const { run } of steps) expect(run ?? "").not.toContain("${{")
  })

  test("the release identity is held by one job, which runs no project code and signs only a folder it has checked", () => {
    const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yaml"), "utf8")) as {
      jobs: Record<string, { needs?: string[]; permissions?: Record<string, string>; steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }>
    }
    const holding = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.["id-token"] !== undefined)
    expect(holding.map(([name]) => name)).toEqual(["sign"])
    expect(workflow.jobs.sign?.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" })
    // The install, typecheck, tests and build run with read access only.
    expect(workflow.jobs.build?.permissions).toEqual({ contents: "read" })
    expect(workflow.jobs.build?.steps.some((step) => step.run?.includes("bun test"))).toBe(true)
    const steps = workflow.jobs.sign?.steps ?? []
    for (const step of steps) {
      expect(step.uses ?? "").not.toContain("setup-bun")
      // No bun, no install.sh and no built binary run beside the release identity.
      expect(step.run ?? "").not.toMatch(/\bbun\b|bash |install\.sh --|"\$bin"|candle-harness-[a-z0-9-]+"? --version/)
    }
    // Its checkout is read, never run, and leaves no token behind.
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(false)
    const at = (text: string) => steps.findIndex((step) => step.run?.includes(text))
    expect(at("sha256sum -c SHA256SUMS")).toBeGreaterThanOrEqual(0)
    expect(at("cmp install.sh")).toBeGreaterThanOrEqual(0)
    expect(at("sha256sum -c SHA256SUMS")).toBeLessThan(at("cosign sign-blob"))
    expect(at("cmp install.sh")).toBeLessThan(at("cosign sign-blob"))
    // install.sh and the binary run in a job of their own, after the signing, with read access only.
    expect(workflow.jobs.install?.permissions).toEqual({ contents: "read" })
    expect(workflow.jobs.install?.needs).toContain("sign")
    expect(workflow.jobs.install?.steps.some((step) => step.run?.includes("install.sh --from"))).toBe(true)
    expect(workflow.jobs.publish?.needs).toEqual(expect.arrayContaining(["sign", "verify", "install"]))
    // Candle's CLI is a download: it runs in a job of its own with read access only, on a release and on
    // a rehearsal, and never in the job that holds the release identity.
    for (const step of steps) expect(step.run ?? "").not.toMatch(/candle\/candle|curl /)
    const verifyJob = workflow.jobs.verify as { if?: string; needs?: string[]; permissions?: Record<string, string>; steps: { run?: string }[] } | undefined
    expect(verifyJob?.permissions).toEqual({ contents: "read" })
    expect(verifyJob?.needs).toContain("sign")
    expect(verifyJob?.if).toBeUndefined()
    // The candle it verifies with is checked by cosign against Candle's own signature before it's run.
    const verify = verifyJob?.steps.find((step) => step.run?.includes('/candle/candle" verify'))?.run ?? ""
    const cosignCandle = verify.indexOf('--certificate-identity "${cli_identity}"')
    expect(cosignCandle).toBeGreaterThan(0)
    expect(cosignCandle).toBeLessThan(verify.indexOf('/candle/candle" verify'))
    expect(verify).toContain('[ "${cli_identity}" = "https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/${cli_tag}" ]')
  })

  test("a release is a draft until every file is up, and a published one is never written to again", () => {
    const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yaml"), "utf8")) as {
      jobs: Record<string, { steps: { run?: string }[] }>
    }
    const publish = workflow.jobs.publish?.steps.find((step) => step.run?.includes("gh release create"))?.run ?? ""
    expect(publish).not.toContain("--clobber")
    const create = publish.indexOf('gh release create "$TAG" --draft')
    const upload = publish.indexOf('gh release upload "$TAG" ./*')
    const live = publish.indexOf('gh release edit "$TAG" --draft=false')
    expect(create).toBeGreaterThan(0)
    expect(upload).toBeGreaterThan(create)
    expect(live).toBeGreaterThan(upload)
    // The step itself, against a stand-in gh: a tag that's already published stops before anything is sent.
    const dir = mkdtempSync(join(tmpdir(), "chrn-publish-"))
    dirs.push(dir)
    const log = join(dir, "gh.log")
    writeFileSync(join(dir, "file"), "bytes")
    writeFileSync(join(dir, "SHA256SUMS"), `${sha256("bytes")}  file\n`)
    const gh = join(dir, "gh")
    writeFileSync(gh, `#!/usr/bin/env bash\necho "$*" >> "${log}"\nif [ "$2" = view ]; then [ -n "$GH_STATE" ] || exit 1; echo "$GH_STATE"; fi\n`)
    chmodSync(gh, 0o755)
    const publishWith = (state: string) => {
      writeFileSync(log, "")
      const r = spawnSync("bash", ["-c", publish], { cwd: dir, encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH ?? ""}`, RUNNER_TEMP: dir, TAG: "v1.2.3", VERSION: "1.2.3", GH_STATE: state } })
      return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ").slice(0, 2).join(" ")) }
    }
    const fresh = publishWith("")
    expect(fresh.code).toBe(0)
    expect(fresh.calls).toEqual(["release view", "release create", "release upload", "release edit"])
    const published = publishWith("false")
    expect(published.code).not.toBe(0)
    expect(published.out).toContain("v1.2.3 is already published")
    expect(published.calls).toEqual(["release view"])
    // A draft an earlier run left behind is started again, so no file is uploaded over another.
    expect(publishWith("true").calls).toEqual(["release view", "release delete", "release create", "release upload", "release edit"])
  })

  test("a rehearsal started from a tag is refused, since it would sign exactly as a release", () => {
    const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yaml"), "utf8")) as {
      jobs: Record<string, { steps: { id?: string; run?: string }[] }>
    }
    const resolve = workflow.jobs.build?.steps.find((step) => step.id === "tag")?.run ?? ""
    const dir = mkdtempSync(join(tmpdir(), "chrn-workflow-"))
    dirs.push(dir)
    const output = join(dir, "output")
    const resolveWith = (env: Record<string, string>) => {
      writeFileSync(output, "")
      const r = spawnSync("bash", ["-e", "-c", resolve], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, ...env } })
      return { code: r.status, out: `${r.stdout}${r.stderr}`, output: readFileSync(output, "utf8") }
    }
    const fromTag = resolveWith({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/v1.2.3", REHEARSAL_VERSION: "1.2.3" })
    expect(fromTag.code).not.toBe(0)
    expect(fromTag.output).toBe("")
    expect(resolveWith({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", REHEARSAL_VERSION: "0.0.0" }).output).toBe("tag=v0.0.0\nversion=0.0.0\n")
    expect(resolveWith({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", GITHUB_REF_NAME: "v1.2.3" }).output).toBe("tag=v1.2.3\nversion=1.2.3\n")
  })

  test("the CLI the doctor needs, at the SHA-256s Candle published for it", () => {
    expect(SCRIPT).toContain(`CLI_TAG='cli-v${MIN_CANDLE_CLI}'`)
    expect(SCRIPT).toContain(`CLI_IDENTITY='${CLI_IDENTITY}'`)
    const latest = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "candle-cli-release", `cli-v${MIN_CANDLE_CLI}-latest.json`), "utf8")) as {
      tag: string
      assets: Record<string, { name: string; sha256: string }>
      helpers: Record<string, { name: string; sha256: string }>
    }
    expect(latest.tag).toBe(`cli-v${MIN_CANDLE_CLI}`)
    for (const platform of PLATFORMS) {
      for (const file of [latest.assets[platform], latest.helpers[platform]]) {
        expect(file).toBeDefined()
        expect(SCRIPT).toContain(`    ${file?.name}) echo '${file?.sha256}' ;;`)
      }
    }
  })
})
