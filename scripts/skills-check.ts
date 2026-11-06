// The Quant preset's bundled skills are Candle's own, copied unchanged
// from candledottv/agentic at one commit. skills/SOURCE names the commit and each file's sha256. This
// checks that the files in skills/ are exactly the ones SOURCE lists, unchanged.
//
//   bun scripts/skills-check.ts                         the files against SOURCE (offline; a test runs it)
//   bun scripts/skills-check.ts --upstream <checkout>   also against the commit in a checkout of the repo
//   bun scripts/skills-check.ts --write <checkout>      SOURCE written afresh from that checkout's commit,
//                                                       for an update, after reading every changed skill
//
// An update is a Candle Harness release: read each changed skill for anything that tells the agent to act outside
// the core, and give it a Candle Harness note in src/engine/skills.ts where it does.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

export const SKILLS_DIR = join(import.meta.dir, "..", "skills")
const REPO = "https://github.com/candledottv/agentic"

export interface Source {
  repo: string
  commit: string
  date: string
  files: Map<string, string>
}

export function sha256(text: Buffer | string): string {
  return createHash("sha256").update(text).digest("hex")
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/** Every file in the skills folder but SOURCE, relative to it. */
export function bundledFiles(dir = SKILLS_DIR): string[] {
  return walk(dir)
    .map((p) => relative(dir, p))
    .filter((p) => p !== "SOURCE")
    .sort()
}

export function parseSource(text: string): Source {
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(text)?.[1]?.trim() ?? ""
  const files = new Map<string, string>()
  for (const m of text.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)) files.set(m[2]!, m[1]!)
  return { repo: field("repo"), commit: field("commit"), date: field("date"), files }
}

/** What's wrong with the skills folder against SOURCE: empty when nothing is. */
export function checkSkills(dir = SKILLS_DIR): string[] {
  const source = parseSource(readFileSync(join(dir, "SOURCE"), "utf8"))
  const problems: string[] = []
  if (!/^[0-9a-f]{40}$/.test(source.commit)) problems.push("SOURCE names no full commit")
  const present = bundledFiles(dir)
  for (const file of present) {
    const want = source.files.get(file)
    if (!want) problems.push(`${file} is in skills/ but not in SOURCE`)
    else if (sha256(readFileSync(join(dir, file))) !== want) problems.push(`${file} differs from Candle's copy at ${source.commit.slice(0, 7)}`)
  }
  for (const file of source.files.keys()) if (!present.includes(file)) problems.push(`${file} is in SOURCE but missing from skills/`)
  return problems
}

/** A file at the source commit in a checkout: LICENSE at the root, skills under skills/. */
function upstream(checkout: string, commit: string, file: string): Buffer | undefined {
  const path = file === "LICENSE" ? "LICENSE" : `skills/${file}`
  const run = spawnSync("git", ["-C", checkout, "show", `${commit}:${path}`])
  return run.status === 0 ? run.stdout : undefined
}

export function checkUpstream(checkout: string, dir = SKILLS_DIR): string[] {
  const source = parseSource(readFileSync(join(dir, "SOURCE"), "utf8"))
  const problems: string[] = []
  for (const file of source.files.keys()) {
    const theirs = upstream(checkout, source.commit, file)
    if (!theirs) problems.push(`${file} isn't in ${source.repo} at ${source.commit.slice(0, 7)}`)
    else if (sha256(theirs) !== source.files.get(file)) problems.push(`${file} isn't ${source.repo}'s at ${source.commit.slice(0, 7)}`)
  }
  return problems
}

function writeSource(checkout: string, dir = SKILLS_DIR): void {
  const head = spawnSync("git", ["-C", checkout, "log", "-1", "--format=%H %cs"], { encoding: "utf8" })
  const [commit, date] = head.stdout.trim().split(" ")
  if (!commit || !date) throw new Error(`${checkout} isn't a git checkout`)
  const lines = bundledFiles(dir).map((file) => {
    const theirs = upstream(checkout, commit, file)
    if (!theirs) throw new Error(`${file} isn't in the checkout at ${commit}`)
    return `${sha256(theirs)}  ${file}`
  })
  writeFileSync(
    join(dir, "SOURCE"),
    [
      "Candle's skills, copied unchanged for the Candle Harness's Quant preset.",
      `repo: ${REPO}`,
      `commit: ${commit}`,
      `date: ${date}`,
      "licence: MIT, Candle's own (LICENSE, copied unchanged)",
      "",
      "files (sha256):",
      ...lines,
      "",
    ].join("\n"),
  )
}

if (import.meta.main) {
  const at = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  const write = at("--write")
  if (write) writeSource(write)
  const checkout = at("--upstream") ?? write
  const problems = [...checkSkills(), ...(checkout ? checkUpstream(checkout) : [])]
  if (problems.length) {
    for (const p of problems) console.error(`skills: ${p}`)
    process.exit(1)
  }
  console.log(`skills: ${bundledFiles().length} files match SOURCE${checkout ? " and the commit upstream" : ""}`)
}
