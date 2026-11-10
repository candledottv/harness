// The bots folder: where the person's code bots live, one folder each, written once by the Build tab's first open or
// `candle-harness bots init`. What the Candle Harness writes there: AGENTS.md (the rules every bot runs under, the
// client, the commands, and its notes on Candle's skills), CLAUDE.md importing it, the client, a .gitignore for each
// bot's token file, and Candle's bot-building skills in both places harnesses read a project's skills.
//
// The person's files are theirs. `.harness/written.json` keeps the hash of each file as the Candle Harness last wrote
// it, so a later write (a newer Candle Harness) updates a file only while it's still exactly as written. One the person
// changed, or one that was there before, is kept and named, never written over. A link is never written through.
import { createHash, randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { HARNESS_CLIENT_FILE, HARNESS_CLIENT_SOURCE } from "../shared/harness-client-source"
import { agentsMd, CLAUDE_MD, GITIGNORE } from "./agents-md"
import { BUILD_SKILL_FILES, BUILD_SKILLS_LICENSE } from "./skill-files"

/** Where bots live when the person names nowhere else. */
export const DEFAULT_BOTS_FOLDER = "~/candle-bots"
/** What the Candle Harness last wrote, by hash: so a file the person changed is never written over. */
export const WRITTEN_FILE = ".harness/written.json"

export interface FolderFile {
  /** Relative to the bots folder. */
  path: string
  text: string
  /** What it's for, in a few words, for the list the Build tab shows. */
  why: string
}

/** Every file the bots folder gets, in the order they're listed. */
export function botsFolderFiles(): FolderFile[] {
  const skills = Object.entries(BUILD_SKILL_FILES).flatMap(([name, files]) =>
    Object.entries(files).flatMap(([file, text]) => [
      { path: `.claude/skills/${name}/${file}`, text, why: "Candle's bot-building skills" },
      { path: `.agents/skills/${name}/${file}`, text, why: "the same skills, for Codex, Pi and OpenCode" },
    ]),
  )
  return [
    { path: "AGENTS.md", text: agentsMd(), why: "the rules every bot runs under, and how to propose one" },
    { path: "CLAUDE.md", text: CLAUDE_MD, why: "@AGENTS.md, so Claude Code reads the same" },
    { path: HARNESS_CLIENT_FILE, text: HARNESS_CLIENT_SOURCE, why: "the client a bot trades through (MIT)" },
    { path: ".gitignore", text: GITIGNORE, why: "keeps each bot's token file out of git" },
    ...skills,
    { path: ".claude/skills/LICENSE", text: BUILD_SKILLS_LICENSE, why: "Candle's licence for its skills (MIT)" },
    { path: ".agents/skills/LICENSE", text: BUILD_SKILLS_LICENSE, why: "Candle's licence for its skills (MIT)" },
  ]
}

/** The folder as the person typed it, absolute: `~` is their home (HOME, as their shell has it). */
export function botsFolderPath(typed: string, home = process.env.HOME || homedir()): string {
  const t = typed.trim()
  if (t === "~") return home
  if (t.startsWith("~/")) return join(home, t.slice(2))
  return resolve(t)
}

/** What a write did, file by file. */
export interface FolderWrite {
  folder: string
  /** New here. */
  written: string[]
  /** Still exactly as the Candle Harness last wrote it, so brought up to date. */
  updated: string[]
  /** Already as it should be. */
  same: string[]
  /** Changed by the person, there before, or a link: left as it is. */
  kept: string[]
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")

async function readWritten(folder: string): Promise<Record<string, string>> {
  // A link in its place, or a .harness that's one, is never read through.
  if (await blocked(folder, WRITTEN_FILE)) return {}
  try {
    const raw = JSON.parse(await readFile(join(folder, WRITTEN_FILE), "utf8")) as { files?: unknown }
    if (raw && typeof raw.files === "object" && raw.files !== null) {
      return Object.fromEntries(Object.entries(raw.files as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
    }
  } catch {}
  return {}
}

/** A path inside the folder that isn't a plain file or folder (a link, say): never written through. */
async function blocked(folder: string, path: string): Promise<boolean> {
  let at = folder
  for (const part of path.split("/")) {
    at = join(at, part)
    try {
      const st = await lstat(at)
      if (st.isSymbolicLink()) return true
      if (at !== join(folder, path) && !st.isDirectory()) return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Writes the bots folder's files into `folder` (made if missing): each new one written, each still as last written
 * brought up to date, and each the person changed kept. Throws when the folder can't be one.
 */
export async function writeBotsFolder(folder: string, files: readonly FolderFile[] = botsFolderFiles()): Promise<FolderWrite> {
  try {
    const st = await lstat(folder)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${folder} is there already and isn't a folder, so the bots folder can't go there.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(folder, { recursive: true, mode: 0o755 })
  }
  const was = await readWritten(folder)
  const out: FolderWrite = { folder, written: [], updated: [], same: [], kept: [] }
  const now: Record<string, string> = { ...was }
  for (const f of files) {
    const path = join(folder, f.path)
    const want = sha(f.text)
    if (await blocked(folder, f.path)) {
      out.kept.push(f.path)
      continue
    }
    let have: string | undefined
    try {
      have = sha(await readFile(path))
    } catch {}
    if (have === want) {
      out.same.push(f.path)
      now[f.path] = want
      continue
    }
    if (have !== undefined && have !== was[f.path]) {
      out.kept.push(f.path)
      continue
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o755 })
    // A new name of its own, made fresh (wx): never a file or link someone left under the name.
    const tmp = `${path}.harness-${process.pid}-${randomBytes(4).toString("hex")}`
    await writeFile(tmp, f.text, { mode: 0o644, flag: "wx" })
    await rename(tmp, path)
    now[f.path] = want
    ;(have === undefined ? out.written : out.updated).push(f.path)
  }
  // Its record is written beside it and renamed over it, never through a link at .harness or at written.json:
  // where either is a link (or not a plain folder and file), the record is left as it is.
  if (await blocked(folder, WRITTEN_FILE)) return out
  await mkdir(join(folder, ".harness"), { recursive: true, mode: 0o755 })
  if (await blocked(folder, WRITTEN_FILE)) return out
  const record = join(folder, WRITTEN_FILE)
  const tmp = `${record}.harness-${process.pid}-${randomBytes(4).toString("hex")}`
  await writeFile(tmp, `${JSON.stringify({ note: "What the Candle Harness last wrote here, by sha256: a file you change is never written over.", files: now }, null, 2)}\n`, { mode: 0o644, flag: "wx" })
  await rename(tmp, record)
  return out
}

/** What a write did, in a few lines: the files listed by what they're for, and any kept. */
export function folderWriteWords(w: FolderWrite): string[] {
  const changed = w.written.length + w.updated.length
  const lines = [changed ? `${w.folder} is ready: ${changed} file${changed === 1 ? "" : "s"} written.` : `${w.folder} is ready: nothing needed writing.`]
  if (w.kept.length) lines.push(`Kept as they are (you changed them, or they were there before): ${w.kept.join(", ")}.`)
  return lines
}

/** The bots folder as it stands, read only: what a write would add, bring up to date, or keep as the person's. */
export interface FolderLook {
  folder: string
  exists: boolean
  /** Not there: a write adds them. */
  missing: string[]
  /** Still exactly as an older Candle Harness wrote them: a write brings them up to date. */
  older: string[]
  /** Changed by the person, there before, or a link: a write keeps them as they are. */
  kept: string[]
  /** Already as this Candle Harness writes them. */
  same: string[]
}

/** Reads the bots folder against the files this Candle Harness writes, by the same rules a write follows, writing nothing. */
export async function lookAtBotsFolder(folder: string, files: readonly FolderFile[] = botsFolderFiles()): Promise<FolderLook> {
  const out: FolderLook = { folder, exists: false, missing: [], older: [], kept: [], same: [] }
  try {
    const st = await lstat(folder)
    if (st.isSymbolicLink() || !st.isDirectory()) return out
  } catch {
    return out
  }
  out.exists = true
  const was = await readWritten(folder)
  for (const f of files) {
    if (await blocked(folder, f.path)) {
      out.kept.push(f.path)
      continue
    }
    let have: string | undefined
    try {
      have = sha(await readFile(join(folder, f.path)))
    } catch {}
    if (have === sha(f.text)) out.same.push(f.path)
    else if (have === undefined) out.missing.push(f.path)
    else if (have !== was[f.path]) out.kept.push(f.path)
    else out.older.push(f.path)
  }
  return out
}
