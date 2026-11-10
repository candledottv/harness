import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILT_IN_RULES, identEmail, identityFindings, parsePersonalPatterns, scanText } from "./scrub-check"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const hits = (text: string, rules = BUILT_IN_RULES) => scanText("f.ts", text, rules).map((f) => f.rule)

test("home paths", () => {
  expect(hits("see /Users/alice/projects/x")).toEqual(["home-path"]) // scrub-ok
  expect(hits("/home/bob/.config")).toEqual(["home-path"]) // scrub-ok
  expect(hits("/Users/you/ and /Users/Shared/ and /home/user/ and /home/agent/")).toEqual([])
})

test("IPv4 outside loopback and documentation ranges", () => {
  expect(hits("host 192.168.1.20")).toEqual(["ipv4"]) // scrub-ok
  expect(hits("100.101.102.103")).toEqual(["ipv4"]) // scrub-ok
  expect(hits("127.0.0.1 0.0.0.0 192.0.2.7 198.51.100.7 203.0.113.7")).toEqual([])
})

test("private keys, Candle keys, tailnet names", () => {
  expect(hits("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["private-key"]) // scrub-ok
  expect(hits("key cndl_live_abcDEF123456")).toEqual(["candle-key"]) // scrub-ok
  expect(hits("box.tail1a2b3c.ts.net")).toEqual(["tailnet"]) // scrub-ok
})

test("scrub-ok skips built-in rules only, never personal ones", () => {
  expect(hits('const k = "cndl_test_abcdefgh12" // scrub-ok')).toEqual([])
  expect(hits("ssh myhost // scrub-ok", parsePersonalPatterns("MyHost"))).toEqual(["personal:1"])
})

test("personal patterns: comments, literals case-insensitive, regexes", () => {
  const rules = parsePersonalPatterns("# hosts\nMyHost\n/bot-\\d+/i\n")
  expect(rules).toHaveLength(2)
  expect(hits("ssh myhost", rules)).toEqual(["personal:1"])
  expect(hits("BOT-7 is up", rules)).toEqual(["personal:2"])
})

test("an invalid personal regex names its line", () => {
  expect(() => parsePersonalPatterns("ok\n/([/\n")).toThrow(/line 2/)
})

test("personal findings never echo the match", () => {
  const [f] = scanText("f.ts", "ssh myhost", parsePersonalPatterns("MyHost"))
  expect(f?.excerpt).toBeUndefined()
  expect(scanText("f.ts", "/Users/alice/x", BUILT_IN_RULES)[0]?.excerpt).toContain("/Users/alice/") // scrub-ok
})

test("binary content is skipped", () => {
  expect(hits("abc\u0000/Users/alice/")).toEqual([]) // scrub-ok
})

test("commit messages ignore scrub-ok", () => {
  const msg = "Fix path /Users/alice/x // scrub-ok"
  expect(scanText("COMMIT_EDITMSG", msg, BUILT_IN_RULES, { honourScrubOk: false }).map((f) => f.rule)).toEqual([
    "home-path",
  ])
})

test("findings carry 1-based line numbers", () => {
  expect(scanText("f.ts", "ok\nok\n/home/bob/x", BUILT_IN_RULES)[0]?.line).toBe(3) // scrub-ok
})

test("a big text file is read, staged or tracked, so a key in it is still found", () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-scrub-"))
  dirs.push(dir)
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, encoding: "utf8" })
  git("init", "-q")
  // Built at run time, so this file holds no key of its own; over 2 MB of text after it.
  const key = ["cndl", "live", "abcDEF123456"].join("_")
  writeFileSync(join(dir, "big.txt"), `${key}\n${`${"x".repeat(80)}\n`.repeat(30_000)}`)
  git("add", "big.txt")
  const check = (...args: string[]) =>
    spawnSync("bun", [join(import.meta.dir, "scrub-check.ts"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, CANDLE_HARNESS_SCRUB_PATTERNS: join(dir, "none") } })
  const staged = check("--staged")
  expect(staged.status).toBe(1)
  expect(staged.stdout).toContain("big.txt:1: candle-key")
  git("commit", "-q", "--no-verify", "-m", "one")
  const tracked = check()
  expect(tracked.status).toBe(1)
  expect(tracked.stdout).toContain("big.txt:1: candle-key")
})

test("who a commit is made as: only a no-reply address passes, for the author and the committer alike, and the address is never echoed", () => {
  const noreply = "Dev One <1234+dev-one@users.noreply.github.com> 1700000000 +0000"
  const own = "Dev One <dev.one@mail.example> 1700000000 +0000"
  expect(identEmail(noreply)).toBe("1234+dev-one@users.noreply.github.com")
  expect(identityFindings({ author: noreply, committer: noreply })).toEqual([])
  expect(identityFindings({ author: "Helper <noreply@anthropic.com>", committer: noreply })).toEqual([])
  const author = identityFindings({ author: own, committer: noreply })
  expect(author).toHaveLength(1)
  expect(author[0]).toStartWith("commit author: its email isn't a no-reply address")
  expect(author[0]).not.toContain("mail.example")
  expect(identityFindings({ author: noreply, committer: own })[0]).toStartWith("commit committer:")
  // A look-alike domain, or no address at all.
  expect(identityFindings({ author: "X <x@users.noreply.github.com.example>", committer: "X <>" })).toEqual([
    "commit author: its email isn't a no-reply address (set one with: git config user.email <id>+<login>@users.noreply.github.com)",
    "commit committer: no email could be read",
  ])
})

test("the hooks refuse a commit made as a personal address, before the commit and at its message; a scan of the tree doesn't ask", () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-scrub-id-"))
  dirs.push(dir)
  spawnSync("git", ["init", "-q"], { cwd: dir })
  writeFileSync(join(dir, "a.txt"), "fine\n")
  spawnSync("git", ["add", "a.txt"], { cwd: dir })
  writeFileSync(join(dir, "msg"), "A change\n")
  const check = (email: { author: string; committer: string }, ...args: string[]) =>
    spawnSync("bun", [join(import.meta.dir, "scrub-check.ts"), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, CANDLE_HARNESS_SCRUB_PATTERNS: join(dir, "none"), GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: email.author, GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: email.committer },
    })
  const ok = "1234+dev@users.noreply.github.com"
  const own = "dev@mail.example"
  for (const args of [["--staged"], ["--message", join(dir, "msg")]]) {
    expect(check({ author: ok, committer: ok }, ...args).status).toBe(0)
    const author = check({ author: own, committer: ok }, ...args)
    expect(author.status).toBe(1)
    expect(author.stdout).toContain("commit author: its email isn't a no-reply address")
    expect(`${author.stdout}${author.stderr}`).not.toContain(own)
    expect(check({ author: ok, committer: own }, ...args).stdout).toContain("commit committer:")
  }
  // With no personal patterns file the check still runs, and only warns about the file.
  const warned = check({ author: ok, committer: ok }, "--staged")
  expect(warned.status).toBe(0)
  expect(warned.stderr).toContain("no personal patterns file")
  // The tracked tree's scan makes no commit, so it asks nothing of the identity.
  expect(check({ author: own, committer: own }).status).toBe(0)
})
