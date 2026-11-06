// Refuses personal details in the repo: home paths, private IPs, keys, tailnet names, plus a private
// patterns file kept outside the repo. Runs over tracked files, staged files (pre-commit) or a commit
// message and its author line (commit-msg).
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ScrubRule {
  name: string
  pattern: RegExp
  personal: boolean
  /** A match this returns true for isn't a finding (documentation ranges, placeholder homes). */
  allow?: (match: string) => boolean
}

export interface ScrubFinding {
  file: string
  line: number
  rule: string
  excerpt?: string
}

const BINARY_SNIFF = 8 * 1024

const PLACEHOLDER_HOMES = new Set(["you", "Shared", "user", "agent"])

function allowedIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number)
  if (octets.some((o) => o > 255)) return true // not an address, e.g. a version string
  const [a, b, c] = octets
  return (
    a === 127 ||
    ip === "0.0.0.0" ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
}

export const BUILT_IN_RULES: readonly ScrubRule[] = [
  {
    name: "home-path",
    pattern: /\/(?:Users|home)\/([A-Za-z0-9._-]+)\//,
    personal: false,
    allow: (m) => PLACEHOLDER_HOMES.has(m.split("/")[2] ?? ""),
  },
  {
    name: "ipv4",
    pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/,
    personal: false,
    allow: allowedIpv4,
  },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, personal: false },
  { name: "candle-key", pattern: /cndl_(?:live|test)_[A-Za-z0-9_-]{8,}/, personal: false },
  { name: "tailnet", pattern: /[a-z0-9-]+\.ts\.net\b/i, personal: false },
]

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One pattern per line: `# comment`, a literal (matched case-insensitively), or `/regex/flags`. */
export function parsePersonalPatterns(text: string): ScrubRule[] {
  const rules: ScrubRule[] = []
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith("#")) return
    const re = /^\/(.*)\/([a-z]*)$/.exec(line)
    let pattern: RegExp
    try {
      pattern = re ? new RegExp(re[1] ?? "", re[2]) : new RegExp(escapeRegExp(line), "i")
    } catch (e) {
      throw new Error(`personal patterns, line ${i + 1}: ${(e as Error).message}`)
    }
    rules.push({ name: `personal:${rules.length + 1}`, pattern, personal: true })
  })
  return rules
}

function firstFinding(rule: ScrubRule, line: string): string | undefined {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g"
  for (const m of line.matchAll(new RegExp(rule.pattern.source, flags))) {
    if (!rule.allow?.(m[0])) return m[0]
  }
  return undefined
}

export function scanText(
  file: string,
  text: string,
  rules: readonly ScrubRule[],
  opts: { honourScrubOk?: boolean } = {},
): ScrubFinding[] {
  if (text.slice(0, BINARY_SNIFF).includes("\u0000")) return []
  const honourScrubOk = opts.honourScrubOk ?? true
  const findings: ScrubFinding[] = []
  text.split("\n").forEach((line, i) => {
    const skipBuiltIn = honourScrubOk && line.includes("scrub-ok")
    for (const rule of rules) {
      if (skipBuiltIn && !rule.personal) continue
      const match = firstFinding(rule, line)
      if (match === undefined) continue
      // Personal findings never echo what matched: the output may end up in a log.
      findings.push(rule.personal ? { file, line: i + 1, rule: rule.name } : { file, line: i + 1, rule: rule.name, excerpt: match })
    }
  })
  return findings
}

function git(args: string[]): { ok: boolean; out: Uint8Array } {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  return { ok: r.exitCode === 0, out: r.stdout }
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b)
const nulList = (b: Uint8Array) => decode(b).split("\u0000").filter(Boolean)

function loadPersonalRules(): ScrubRule[] {
  const path = process.env.CANDLE_HARNESS_SCRUB_PATTERNS || join(homedir(), ".config", "candle-harness-scrub", "patterns.txt")
  if (!existsSync(path)) {
    console.warn(`scrub: no personal patterns file at ${path}; checking built-in rules only`)
    return []
  }
  return parsePersonalPatterns(readFileSync(path, "utf8"))
}

// Every file is read whole, whatever its size: a check that passed a file it never read would call it clean.
// Binary files are dropped by scanText's sniff. A file that can't be read is a finding (undefined text).
function* trackedFiles(): Generator<[string, string | undefined]> {
  for (const file of nulList(git(["ls-files", "-z"]).out)) {
    if (!existsSync(file)) continue
    yield [file, readFileSync(file, "utf8")]
  }
}

function* stagedFiles(): Generator<[string, string | undefined]> {
  for (const file of nulList(git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]).out)) {
    const blob = git(["show", `:${file}`])
    yield [file, blob.ok ? decode(blob.out) : undefined]
  }
}

function* commitMessage(path: string): Generator<[string, string | undefined]> {
  const message = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
  yield ["commit message", message]
  // The author line, without its timestamp.
  const ident = decode(git(["var", "GIT_AUTHOR_IDENT"]).out).replace(/\s+\d+\s+[+-]\d{4}\s*$/, "")
  yield ["commit author", ident]
}

export async function main(argv: string[]): Promise<number> {
  const messageAt = argv.indexOf("--message")
  const messagePath = messageAt >= 0 ? argv[messageAt + 1] : undefined
  if (messageAt >= 0 && !messagePath) {
    console.error("usage: scrub-check.ts [--staged | --message <file>]")
    return 2
  }
  const rules = [...BUILT_IN_RULES, ...loadPersonalRules()]
  const sources = messagePath ? commitMessage(messagePath) : argv.includes("--staged") ? stagedFiles() : trackedFiles()
  const honourScrubOk = !messagePath
  let count = 0
  for (const [file, text] of sources) {
    if (text === undefined) {
      console.log(`${file}: unreadable, so not checked`)
      count++
      continue
    }
    for (const f of scanText(file, text, rules, { honourScrubOk })) {
      console.log(`${f.file}:${f.line}: ${f.rule}${f.excerpt ? `  ${f.excerpt}` : ""}`)
      count++
    }
  }
  if (count) {
    const hint = messagePath ? "Reword the commit message or fix the author." : 'Remove them, or mark a built-in false positive with "scrub-ok".'
    console.error(`scrub: ${count} finding(s). ${hint}`)
  }
  return count ? 1 : 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
