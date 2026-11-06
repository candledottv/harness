// The agent's memory: `memory/index.md` in the agent's research folder, one line a memory (a name and a
// hook, or a pointer), and any files beside it. The agent writes them with its engine's own file tools;
// there's no core write tool, no cap and no lock (every coding agent's memory files are easily edited, a
// problem they all share and not one the Candle Harness can solve).
// What the core does:
//   - reads the index fresh into every turn's prompt (engine/prompt.ts's memorySection), so an edit made
//     on one engine shows on the next turn on any other;
//   - notes each turn's change in Activity and the journal (`memory.change`), from a snapshot taken as
//     the turn starts;
//   - serves the person's view (the `memory` topic) and their deletes, journalled as theirs.
// One memory per agent, nothing shared: each agent's folder is its own, as its key is.
//
// The core reads with the agent's own hold, never further: the folder and the index must be real files
// in the research folder, not links (a link would hand the prompt a file the agent's tools can't read),
// and a file with a second hard link is read as none.
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join, normalize, sep } from "node:path"

export const MEMORY_DIR = "memory"
export const MEMORY_INDEX = "index.md"
/** Past this, the prompt asks the agent to merge or prune (about 1,500 tokens a turn on an API-key engine, half the Quant prompt again). Nothing is refused. */
export const LONG_INDEX_CHARS = 6_000
/** The most of an index a prompt carries: a ceiling against a runaway file, far past where the agent is asked to merge. */
export const INDEX_READ_MAX = 64 * 1024
/** The most files the view lists. */
const FILES_MAX = 500
/** One line as the journal and Activity carry it. */
const LINE_MAX = 300
/** The most lines one memory.change row names; the rest are counted. */
const LINES_LISTED = 20
/** How much of a remembered line Activity shows. */
const WORDS_LINE_MAX = 60

export interface MemoryFile {
  /** Relative to memory/, with "/". */
  path: string
  bytes: number
  /** A link is listed, never read. */
  link?: true
}

export interface MemoryRead {
  /** memory/index.md's text, cut at INDEX_READ_MAX; undefined when there's none. */
  index?: string
  /** The index's whole length, in characters. */
  chars: number
  /** Set when the index was longer than INDEX_READ_MAX and the prompt carries its start. */
  cut?: true
  /** Why the index wasn't read, when one is there: a link, or a hard link. */
  unread?: string
  /** Its memories: the lines that aren't blank or headings. */
  entries: string[]
  /** Everything else in memory/. */
  files: MemoryFile[]
}

/** The lines of an index that are memories: not blank, not headings, not a fence. */
export function indexEntries(index: string | undefined): string[] {
  if (!index) return []
  return index
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```") && l !== "---")
}

type Lstat = import("node:fs").Stats
const lstat = (path: string): Lstat | undefined => {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

function walk(dir: string, rel: string, out: MemoryFile[], snapshot: Map<string, string>): void {
  let entries
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= FILES_MAX) return
    const path = rel ? `${rel}/${e.name}` : e.name
    const info = lstat(join(dir, path))
    if (!info) continue
    if (info.isSymbolicLink()) {
      out.push({ path, bytes: 0, link: true })
      snapshot.set(path, "link")
    } else if (info.isDirectory()) walk(dir, path, out, snapshot)
    else if (info.isFile()) {
      if (path !== MEMORY_INDEX) out.push({ path, bytes: info.size })
      snapshot.set(path, `${info.size}:${info.mtimeMs}`)
    }
  }
}

/** The agent's memory as it is now, read with the agent's own hold, and a snapshot of its files for the turn's diff. */
export function readMemory(researchDir: string): MemoryRead & { snapshot: Map<string, string> } {
  const dir = join(researchDir, MEMORY_DIR)
  const snapshot = new Map<string, string>()
  const none = { chars: 0, entries: [], files: [], snapshot }
  const info = lstat(dir)
  if (!info) return none
  if (!info.isDirectory()) return { ...none, unread: info.isSymbolicLink() ? "memory/ is a link, and memory is read only from the research folder itself" : "memory isn't a folder" }
  const files: MemoryFile[] = []
  walk(dir, "", files, snapshot)
  const at = join(dir, MEMORY_INDEX)
  const idx = lstat(at)
  if (!idx) return { ...none, files }
  if (idx.isSymbolicLink()) return { ...none, files, unread: "memory/index.md is a link, and memory is read only from files in the research folder" }
  if (!idx.isFile()) return { ...none, files, unread: "memory/index.md isn't a file" }
  if (idx.nlink > 1) return { ...none, files, unread: "memory/index.md has another hard link, so it's read as none" }
  const buf = readFileSync(at)
  if (buf.includes(0)) return { ...none, files, unread: "memory/index.md isn't a text file" }
  const whole = buf.toString("utf8")
  const index = whole.length > INDEX_READ_MAX ? whole.slice(0, INDEX_READ_MAX) : whole
  return { index, chars: whole.length, ...(whole.length > INDEX_READ_MAX ? { cut: true as const } : {}), entries: indexEntries(whole), files, snapshot }
}

const clip = (s: string) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s)

/** What changed between two reads: the index's lines added and removed, and the other files written or removed. */
export interface MemoryDiff {
  added: string[]
  removed: string[]
  written: string[]
  deleted: string[]
}

export function diffMemory(before: { entries: string[]; snapshot: Map<string, string> }, after: { entries: string[]; snapshot: Map<string, string> }): MemoryDiff {
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>())
  const was = count(before.entries)
  const now = count(after.entries)
  const added = after.entries.filter((l) => {
    const n = was.get(l) ?? 0
    if (n > 0) {
      was.set(l, n - 1)
      return false
    }
    return true
  })
  const removed = before.entries.filter((l) => {
    const n = now.get(l) ?? 0
    if (n > 0) {
      now.set(l, n - 1)
      return false
    }
    return true
  })
  const others = (m: Map<string, string>) => [...m.keys()].filter((p) => p !== MEMORY_INDEX)
  const written = others(after.snapshot).filter((p) => before.snapshot.get(p) !== after.snapshot.get(p))
  const deleted = others(before.snapshot).filter((p) => !after.snapshot.has(p))
  return { added, removed, written, deleted }
}

export const isEmptyDiff = (d: MemoryDiff) => d.added.length + d.removed.length + d.written.length + d.deleted.length === 0

/** A diff as a journal row's fields: lines clipped and listed up to a count, the rest counted. */
export function diffFields(d: MemoryDiff): Record<string, unknown> {
  const lists = { added: d.added.map(clip), removed: d.removed.map(clip), written: d.written, deleted: d.deleted }
  const more = Object.values(lists).reduce((n, l) => n + Math.max(0, l.length - LINES_LISTED), 0)
  return { ...Object.fromEntries(Object.entries(lists).map(([k, l]) => [k, l.slice(0, LINES_LISTED)])), ...(more ? { more } : {}) }
}

/**
 * A memory.change row in words, for Activity, in a line or two: the first line remembered, clipped, and
 * counts for the rest ("remembered: … (+2 more) · wrote memory/x.md"). Otherwise every index rewrite
 * fills Activity with five lines or more, pushing older lines out of sight. The memory overlay has the rest.
 */
export function memoryWords(row: { added?: unknown; removed?: unknown; written?: unknown; deleted?: unknown; more?: unknown; cleared?: unknown }): string {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [])
  if (row.cleared === true) return "cleared the memory"
  const short = (line: string) => {
    const s = line.replace(/^-\s+/, "")
    return s.length > WORDS_LINE_MAX ? `${s.slice(0, WORDS_LINE_MAX - 1)}…` : s
  }
  const more = (n: number) => (n > 1 ? ` (+${n - 1} more)` : "")
  const files = (verb: string, list: string[]) => (list.length ? [`${verb} memory/${list[0]}${more(list.length)}`] : [])
  const extra = typeof row.more === "number" && row.more > 0 ? row.more : 0
  const added = strings(row.added)
  const removed = strings(row.removed)
  const parts = [
    ...(added.length ? [`remembered: ${short(added[0]!)}${more(added.length + extra)}`] : []),
    // A rewrite takes lines out as it puts lines in; only a removal on its own is worth a line.
    ...(removed.length && !added.length ? [`forgot: ${short(removed[0]!)}${more(removed.length + extra)}`] : []),
    ...files("wrote", strings(row.written)),
    ...files("deleted", strings(row.deleted)),
  ]
  return parts.length ? parts.join(" · ") : "changed the memory"
}

/** A content hash of an index line, for the view to name one to delete without sending it back whole. */
export const entryId = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 12)

/** What the `memory` topic carries for one agent. */
export interface MemoryView {
  /** The folder, for the person to open in their own editor. */
  dir: string
  entries: { id: string; text: string }[]
  files: MemoryFile[]
  chars: number
  long: boolean
  unread?: string
}

export function memoryView(researchDir: string, read: MemoryRead): MemoryView {
  return {
    dir: join(researchDir, MEMORY_DIR),
    entries: read.entries.map((text) => ({ id: entryId(text), text })),
    files: read.files,
    chars: read.chars,
    long: read.chars > LONG_INDEX_CHARS,
    ...(read.unread ? { unread: read.unread } : {}),
  }
}

type Done = { ok: true; diff: MemoryDiff; cleared?: true } | { ok: false; code: string; message: string }
const no = (code: string, message: string): Done => ({ ok: false, code, message })

/** The files in memory/ an index line points to ("→ memory/sizing.md"), relative to memory/. */
export const pointedFiles = (line: string): string[] => [...line.matchAll(/(?<![\w./-])memory\/([\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+)/g)].map((m) => m[1]!).filter((p) => p !== MEMORY_INDEX)

/** A path inside memory/ the person named: relative, with no way out, never through a link. */
function memoryPath(dir: string, path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.includes("\0")) return undefined
  const rel = normalize(path).replace(/^(\.\/)+/, "")
  if (rel === "." || rel === "" || rel.startsWith("..") || rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) return undefined
  // Every folder on the way must be a real folder, not a link.
  const parts = rel.split(sep)
  for (let i = 1; i < parts.length; i++) {
    const info = lstat(join(dir, ...parts.slice(0, i)))
    if (!info?.isDirectory()) return undefined
  }
  return join(dir, rel)
}

/**
 * The person's changes, from the memory overlay (the core never changes memory for the agent): one index
 * line by its id, one file, or everything. A line goes from the index as it is on disk now; a file is
 * unlinked (a link itself, never what it points to).
 */
export function deleteFromMemory(researchDir: string, what: { entry?: unknown; file?: unknown; all?: unknown }): Done {
  const dir = join(researchDir, MEMORY_DIR)
  const info = lstat(dir)
  if (!info?.isDirectory()) return no("NO_MEMORY", "This agent has no memory yet.")
  const before = readMemory(researchDir)
  if (what.all === true) {
    for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true })
    const after = readMemory(researchDir)
    return { ok: true, diff: diffMemory(before, after), cleared: true }
  }
  if (typeof what.entry === "string") {
    if (before.index === undefined || before.unread) return no("NO_INDEX", before.unread ?? "This agent's memory has no index.")
    const at = join(dir, MEMORY_INDEX)
    const whole = readFileSync(at, "utf8")
    const lines = whole.split(/(?<=\n)/)
    const i = lines.findIndex((l) => indexEntries(l)[0] !== undefined && entryId(l.trim()) === what.entry)
    if (i < 0) return no("NO_ENTRY", "That line isn't in the index any more: it may have changed since you looked.")
    const [gone] = lines.splice(i, 1)
    writeFileSync(at, lines.join(""))
    // The files the line pointed to go with it, unless another line still points to them: deleting the
    // line read as forgetting it, but the file stayed for the agent to find.
    const kept = new Set(lines.flatMap(pointedFiles))
    for (const path of pointedFiles(gone!).filter((p) => !kept.has(p))) {
      const file = memoryPath(dir, path)
      if (file && lstat(file)?.isFile()) unlinkSync(file)
    }
    return { ok: true, diff: diffMemory(before, readMemory(researchDir)) }
  }
  if (what.file !== undefined) {
    const at = memoryPath(dir, what.file)
    if (!at) return no("BAD_PATH", "That isn't a file in this agent's memory folder.")
    const file = lstat(at)
    if (!file) return no("NO_FILE", "That file isn't there any more.")
    if (file.isDirectory()) rmSync(at, { recursive: true, force: true })
    else unlinkSync(at)
    return { ok: true, diff: diffMemory(before, readMemory(researchDir)) }
  }
  return no("INVALID_ARGS", "Name an entry, a file, or all.")
}

/**
 * Each agent's memory as the core last saw it: the snapshot a turn's diff starts from. The person's
 * deletes move it on, so a turn running meanwhile isn't credited with them.
 */
export class MemoryBook {
  private readonly last = new Map<string, { entries: string[]; snapshot: Map<string, string> }>()

  constructor(
    private readonly deps: {
      researchDir: (agent: string) => string
      journal: { append(row: Record<string, unknown>): Promise<unknown> }
      mode: () => string
      /** The `memory` topic changed for this agent. */
      changed?: (agent: string) => void
    },
  ) {}

  /** The memory a turn starts on: read fresh for its prompt, and kept as the turn's starting point. */
  forTurn(agent: string): MemoryRead {
    const read = readMemory(this.deps.researchDir(agent))
    this.last.set(agent, { entries: read.entries, snapshot: read.snapshot })
    return read
  }

  /** After a turn: what the agent changed, journalled as `memory.change` (Activity reads it). */
  async afterTurn(agent: string, turnId: string): Promise<MemoryDiff | undefined> {
    const before = this.last.get(agent) ?? { entries: [], snapshot: new Map() }
    const after = readMemory(this.deps.researchDir(agent))
    this.last.set(agent, { entries: after.entries, snapshot: after.snapshot })
    const diff = diffMemory(before, after)
    if (isEmptyDiff(diff)) return undefined
    await this.deps.journal.append({ type: "memory.change", mode: this.deps.mode(), agent, by: "agent", turnId, ...diffFields(diff) })
    this.deps.changed?.(agent)
    return diff
  }

  view(agent: string): MemoryView {
    const dir = this.deps.researchDir(agent)
    return memoryView(dir, readMemory(dir))
  }

  /** The person's delete, journalled as theirs. */
  async delete(agent: string, by: string, what: { entry?: unknown; file?: unknown; all?: unknown }): Promise<Done> {
    const done = deleteFromMemory(this.deps.researchDir(agent), what)
    if (!done.ok) return done
    // A turn running now has its starting point moved on by the person's change alone, so the turn
    // isn't credited with it and its own changes still show.
    const kept = this.last.get(agent)
    if (kept) {
      const entries = [...kept.entries]
      for (const line of done.diff.removed) {
        const i = entries.indexOf(line)
        if (i >= 0) entries.splice(i, 1)
      }
      const snapshot = new Map(kept.snapshot)
      for (const path of done.diff.deleted) snapshot.delete(path)
      this.last.set(agent, done.cleared ? { entries: [], snapshot: new Map() } : { entries, snapshot })
    }
    if (!isEmptyDiff(done.diff) || done.cleared) {
      await this.deps.journal.append({ type: "memory.change", mode: this.deps.mode(), agent, by: "you", byClient: by, ...diffFields(done.diff), ...(done.cleared ? { cleared: true } : {}) })
    }
    this.deps.changed?.(agent)
    return done
  }
}
