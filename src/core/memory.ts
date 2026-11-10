// The agent's memory: `memory/index.md` in the agent's research folder, one line a memory (a name and a
// hook, or a pointer), and any files beside it. The agent writes them with its engine's own file tools;
// there's no core write tool, no cap and no lock (every coding agent's memory files are easily edited, a
// problem they all share and not one the Candle Harness can solve).
// What the core does:
//   - reads the index fresh into every turn's prompt (engine/prompt.ts's memorySection), so an edit made
//     on one engine shows on the next turn on any other;
//   - notes each turn's change in Activity and the journal (`memory.change`), from a snapshot taken as
//     the turn starts;
//   - serves the person's view (the `memory` topic) and their deletes and pins, journalled as theirs.
// A pinned line sits under a `## Pinned` heading at the top of the index: plain Markdown in the agent's
// own file, so every engine reads it the same way, and the agent is told never to merge one away.
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
  /** Its lines as the person sees them: every line that says something, headings included; not blanks, bare fence marks, rules or the `## Pinned` heading. */
  entries: string[]
  /** Those under the `## Pinned` heading. */
  pinned: string[]
  /** Everything else in memory/. */
  files: MemoryFile[]
}

/** The heading pinned lines sit under, at the top of the index. */
export const PINNED_HEADING = "## Pinned"
const isPinnedHeading = (line: string) => /^#{1,6}\s+pinned\s*$/i.test(line.trim())
const isHeading = (line: string) => line.trim().startsWith("#")
/** A line that only shapes the file: a fence mark with at most a language word, or a rule. Anything with words of its own is a line the person must see. */
const isMarkup = (line: string) => /^(`{3,}|~{3,})[\w+-]*$/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)

/**
 * The lines of an index the person is shown and can delete: every line that says something. The whole
 * index goes into each turn's prompt, so a heading is a row too (a heading can carry a standing
 * instruction as well as a line can); only blanks, bare fence marks, rules and the `## Pinned` heading,
 * which is the pins' own structure, are left out.
 */
export function indexEntries(index: string | undefined): string[] {
  if (!index) return []
  return index
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isMarkup(l) && !isPinnedHeading(l))
}

/** Whether an index line is a heading: shown and deleted as any line, never pinned. */
export const isHeadingEntry = (line: string): boolean => isHeading(line) && !isPinnedHeading(line)

/**
 * Where the `## Pinned` section is in an index's lines: its heading, and the line after its last memory.
 * Its memories run straight on from the heading to the first blank line or heading, so the lines after a
 * blank are the rest of the index, as the Candle Harness writes it.
 */
function pinnedSection(lines: readonly string[]): { head: number; end: number } | undefined {
  const head = lines.findIndex(isPinnedHeading)
  if (head < 0) return undefined
  let end = head + 1
  while (end < lines.length && lines[end]!.trim() !== "" && !isHeading(lines[end]!)) end++
  return { head, end }
}

/** The memories under the `## Pinned` heading. */
export function pinnedEntries(index: string | undefined): string[] {
  if (!index) return []
  const lines = index.split(/\r?\n/)
  const at = pinnedSection(lines)
  return at ? lines.slice(at.head + 1, at.end).flatMap(indexEntries) : []
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
export function readMemory(researchDir: string): MemoryRead & { snapshot: Map<string, string>; hash?: string } {
  const dir = join(researchDir, MEMORY_DIR)
  const snapshot = new Map<string, string>()
  const none = { chars: 0, entries: [], pinned: [], files: [], snapshot }
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
  return { index, chars: whole.length, ...(whole.length > INDEX_READ_MAX ? { cut: true as const } : {}), entries: indexEntries(whole), pinned: pinnedEntries(whole), files, snapshot, hash: createHash("sha256").update(whole).digest("hex") }
}

const clip = (s: string) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s)

/** What changed between two reads: the index's lines added and removed, pinned and unpinned, and the other files written or removed. */
export interface MemoryDiff {
  added: string[]
  removed: string[]
  written: string[]
  deleted: string[]
  /** Lines kept that moved under `## Pinned`, or out from under it. A line added pinned is only added. */
  pinned: string[]
  unpinned: string[]
}

/** A read as a diff compares it: its lines, which are pinned, and its files. */
type Seen = { entries: string[]; pinned?: string[]; snapshot: Map<string, string>; /** The index's text, hashed: a rewrite that keeps every line still shows. Unset once the person changed it under a running turn. */ hash?: string }

export function diffMemory(before: Seen, after: Seen): MemoryDiff {
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
  // A line both reads have, pinned in one and not the other.
  const both = (line: string) => before.entries.includes(line) && after.entries.includes(line)
  const wasPinned = new Set(before.pinned ?? [])
  const nowPinned = new Set(after.pinned ?? [])
  const pinned = [...nowPinned].filter((l) => !wasPinned.has(l) && both(l))
  const unpinned = [...wasPinned].filter((l) => !nowPinned.has(l) && both(l))
  return { added, removed, written, deleted, pinned, unpinned }
}

export const isEmptyDiff = (d: MemoryDiff) => d.added.length + d.removed.length + d.written.length + d.deleted.length + d.pinned.length + d.unpinned.length === 0

/** A diff as a journal row's fields: lines clipped and listed up to a count, the rest counted. */
export function diffFields(d: MemoryDiff): Record<string, unknown> {
  const lists = { added: d.added.map(clip), removed: d.removed.map(clip), written: d.written, deleted: d.deleted, ...(d.pinned.length ? { pinned: d.pinned.map(clip) } : {}), ...(d.unpinned.length ? { unpinned: d.unpinned.map(clip) } : {}) }
  const more = Object.values(lists).reduce((n, l) => n + Math.max(0, l.length - LINES_LISTED), 0)
  return { ...Object.fromEntries(Object.entries(lists).map(([k, l]) => [k, l.slice(0, LINES_LISTED)])), ...(more ? { more } : {}) }
}

/**
 * A memory.change row in words, for Activity, in a line or two: the first line remembered, clipped, and
 * counts for the rest ("remembered: … (+2 more) · wrote memory/x.md"). Otherwise every index rewrite
 * fills Activity with five lines or more, pushing older lines out of sight. The memory overlay has the rest.
 */
export function memoryWords(row: { added?: unknown; removed?: unknown; written?: unknown; deleted?: unknown; pinned?: unknown; unpinned?: unknown; more?: unknown; cleared?: unknown; rewritten?: unknown }): string {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [])
  if (row.cleared === true) return "cleared the memory"
  const short = (line: string) => {
    const s = line.replace(/^-\s+/, "")
    return s.length > WORDS_LINE_MAX ? `${s.slice(0, WORDS_LINE_MAX - 1)}…` : s
  }
  const more = (n: number) => (n > 1 ? ` (+${n - 1} more)` : "")
  const files = (verb: string, list: string[]) => (list.length ? [`${verb} memory/${list[0]}${more(list.length)}`] : [])
  const lines = (verb: string, list: string[]) => (list.length ? [`${verb}: ${short(list[0]!)}${more(list.length)}`] : [])
  const extra = typeof row.more === "number" && row.more > 0 ? row.more : 0
  const added = strings(row.added)
  const removed = strings(row.removed)
  // A memory names the change before a heading does; a change of headings alone names the heading.
  const lead = (list: string[]) => list.find((l) => !isHeadingEntry(l)) ?? list[0]!
  const parts = [
    ...(added.length ? [`remembered: ${short(lead(added))}${more(added.length + extra)}`] : []),
    // A rewrite takes lines out as it puts lines in; only a removal on its own is worth a line.
    ...(removed.length && !added.length ? [`forgot: ${short(lead(removed))}${more(removed.length + extra)}`] : []),
    ...lines("pinned", strings(row.pinned)),
    ...lines("unpinned", strings(row.unpinned)),
    ...files("wrote", strings(row.written)),
    ...files("deleted", strings(row.deleted)),
  ]
  // Every line kept, the file's text not: its order, spacing or marks changed, and that reaches the prompt too.
  return parts.length ? parts.join(" · ") : row.rewritten === true ? "rewrote the memory's index: the same lines, in another order or layout" : "changed the memory"
}

/** A content hash of an index line, for the view to name one to delete without sending it back whole. */
export const entryId = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 12)

/** What the `memory` topic carries for one agent. */
export interface MemoryView {
  /** The folder, for the person to open in their own editor. */
  dir: string
  /** The index's lines, the pinned ones marked (they're first, at the top of the index), and headings marked: deleted as any line, never pinned. */
  entries: { id: string; text: string; pinned?: true; heading?: true }[]
  files: MemoryFile[]
  chars: number
  long: boolean
  unread?: string
}

export function memoryView(researchDir: string, read: MemoryRead): MemoryView {
  return {
    dir: join(researchDir, MEMORY_DIR),
    entries: read.entries.map((text) => ({ id: entryId(text), text, ...(read.pinned.includes(text) ? { pinned: true as const } : {}), ...(isHeadingEntry(text) ? { heading: true as const } : {}) })),
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
    // The last pinned line gone, its heading goes too (the lines here keep their own line ends).
    dropEmptyPinned(lines, lines.map((l) => l.replace(/\r?\n$/, "")))
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

/** A `## Pinned` section with no memory left goes, with the blank line after it. `bare`: the lines without their line ends, where `lines` keeps them. */
function dropEmptyPinned(lines: string[], bare: readonly string[] = lines): void {
  const at = pinnedSection(bare)
  if (!at || bare.slice(at.head + 1, at.end).some((l) => indexEntries(l).length > 0)) return
  lines.splice(at.head, at.end - at.head + (bare[at.end] !== undefined && bare[at.end]!.trim() === "" ? 1 : 0))
}

/**
 * The person's pin or unpin of one index line, by its id. Pinned, the line moves under `## Pinned` at the
 * top of the index (made if it isn't there, under a `#` title if the file opens with one); unpinned, it
 * moves to just under the section, which goes once it's empty. Its words are never changed.
 */
export function pinInMemory(researchDir: string, entry: unknown, pin: boolean): Done {
  const dir = join(researchDir, MEMORY_DIR)
  if (!lstat(dir)?.isDirectory()) return no("NO_MEMORY", "This agent has no memory yet.")
  const before = readMemory(researchDir)
  if (before.index === undefined || before.unread) return no("NO_INDEX", before.unread ?? "This agent's memory has no index.")
  if (typeof entry !== "string") return no("INVALID_ARGS", "Name the line by its entry id.")
  const at = join(dir, MEMORY_INDEX)
  const lines = readFileSync(at, "utf8").split("\n")
  const section = pinnedSection(lines)
  const inside = (i: number) => section !== undefined && i > section.head && i < section.end
  const i = lines.findIndex((l) => indexEntries(l)[0] !== undefined && entryId(l.trim()) === entry)
  if (i < 0) return no("NO_ENTRY", "That line isn't in the index any more: it may have changed since you looked.")
  // A heading under ## Pinned would end the section at itself, and the lines after it would stop being pins.
  if (isHeading(lines[i]!)) return no("HEADING", "A heading can't be pinned: pin the lines under it.")
  // Pinned already, or not pinned: nothing to move.
  if (inside(i) === pin) return { ok: true, diff: diffMemory(before, before) }
  const [line] = lines.splice(i, 1)
  if (pin) {
    const now = pinnedSection(lines)
    if (now) lines.splice(now.end, 0, line!)
    else {
      // At the top, under a title and the blank lines after it.
      let top = lines[0]?.startsWith("# ") ? 1 : 0
      while (top > 0 && top < lines.length && lines[top]!.trim() === "") top++
      lines.splice(top, 0, ...(top > 0 && lines[top - 1]!.trim() !== "" ? [""] : []), PINNED_HEADING, line!, "")
    }
  } else {
    dropEmptyPinned(lines)
    const now = pinnedSection(lines)
    // Just under the section, after its blank line, or where it was.
    if (!now) lines.splice(section!.head, 0, line!)
    else if (lines[now.end]?.trim() === "") lines.splice(now.end + 1, 0, line!)
    else lines.splice(now.end, 0, "", line!)
  }
  writeFileSync(at, lines.join("\n"))
  return { ok: true, diff: diffMemory(before, readMemory(researchDir)) }
}

/**
 * Each agent's memory as the core last saw it: the snapshot a turn's diff starts from. The person's
 * deletes move it on, so a turn running meanwhile isn't credited with them.
 */
export class MemoryBook {
  private readonly last = new Map<string, Seen>()

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
    this.last.set(agent, { entries: read.entries, pinned: read.pinned, snapshot: read.snapshot, ...(read.hash ? { hash: read.hash } : {}) })
    return read
  }

  /** After a turn: what the agent changed, journalled as `memory.change` (Activity reads it). */
  async afterTurn(agent: string, turnId: string): Promise<MemoryDiff | undefined> {
    const before: Seen = this.last.get(agent) ?? { entries: [], snapshot: new Map() }
    const after = readMemory(this.deps.researchDir(agent))
    this.last.set(agent, { entries: after.entries, pinned: after.pinned, snapshot: after.snapshot, ...(after.hash ? { hash: after.hash } : {}) })
    const diff = diffMemory(before, after)
    // Every line kept but the index's text changed (reordered, re-spaced, a fence or rule added): it's what the
    // next prompt carries, so it's a change the person is told of, though no line names it.
    const rewritten = isEmptyDiff(diff) && before.hash !== undefined && after.hash !== undefined && before.hash !== after.hash
    if (isEmptyDiff(diff) && !rewritten) return undefined
    await this.deps.journal.append({ type: "memory.change", mode: this.deps.mode(), agent, by: "agent", turnId, ...diffFields(diff), ...(rewritten ? { rewritten: true } : {}) })
    this.deps.changed?.(agent)
    return diff
  }

  view(agent: string): MemoryView {
    const dir = this.deps.researchDir(agent)
    return memoryView(dir, readMemory(dir))
  }

  /** The person's pin or unpin of an index line, journalled as theirs. */
  async pin(agent: string, by: string, entry: unknown, pin: boolean): Promise<Done> {
    const done = pinInMemory(this.deps.researchDir(agent), entry, pin)
    if (!done.ok) return done
    // A turn running now isn't credited with the person's move, as with a delete.
    const kept = this.last.get(agent)
    if (kept) {
      const pinned = new Set(kept.pinned ?? [])
      for (const l of done.diff.pinned) pinned.add(l)
      for (const l of done.diff.unpinned) pinned.delete(l)
      // The index's text is the person's now: a running turn isn't credited with a rewrite for it.
      this.last.set(agent, { entries: kept.entries, snapshot: kept.snapshot, pinned: [...pinned] })
    }
    if (!isEmptyDiff(done.diff)) await this.deps.journal.append({ type: "memory.change", mode: this.deps.mode(), agent, by: "you", byClient: by, ...diffFields(done.diff) })
    this.deps.changed?.(agent)
    return done
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
      const pinned = (kept.pinned ?? []).filter((l) => !done.diff.removed.includes(l))
      this.last.set(agent, done.cleared ? { entries: [], pinned: [], snapshot: new Map() } : { entries, pinned, snapshot })
    }
    if (!isEmptyDiff(done.diff) || done.cleared) {
      await this.deps.journal.append({ type: "memory.change", mode: this.deps.mode(), agent, by: "you", byClient: by, ...diffFields(done.diff), ...(done.cleared ? { cleared: true } : {}) })
    }
    this.deps.changed?.(agent)
    return done
  }
}
