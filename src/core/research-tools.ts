// The core's research tools: `research_read` and `research_list`, offered to every
// engine through the Candle MCP server and run by the core, held to the agent's research folder. Codex
// has no file-reading tool with the shell off, so it reads its notes through these; any engine
// whose own file tools aren't held on a platform does too. One path rule for every engine: the path is
// resolved (relative to the folder, `~` expanded, every symlink followed) and refused unless where it
// ends is inside the folder.
//
// They read only. An engine writes its notes with its own held tools.
import type { Stats } from "node:fs"
import { type FileHandle, lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const MAX_READ_BYTES = 256 * 1024
const DEFAULT_LINES = 400
const MAX_LINES = 2000
const MAX_ENTRIES = 500

export const RESEARCH_TOOLS = [
  {
    name: "research_read",
    description:
      "Reads a text file in your research folder: your own notes. The path is relative to the folder (or absolute inside it). Anything outside the folder is refused, through links too. Returns the lines asked for, at most 2000 at a time, and the file's line count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "The file, such as notes/moon.md." },
        offset: { type: "integer", minimum: 1, description: "The first line to read (1 is the first). Defaults to 1." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LINES, description: `How many lines. Defaults to ${DEFAULT_LINES}.` },
      },
      required: ["path"],
    },
  },
  {
    name: "research_list",
    description: "Lists a folder inside your research folder: each entry's name and whether it's a file, a folder or a link. Defaults to the research folder itself. Anything outside it is refused.",
    inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "A folder inside your research folder. Defaults to the folder itself." } } },
  },
]
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(RESEARCH_TOOLS.map((t) => t.name))

type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string }
const refuse = (code: string, message: string): Answer => ({ ok: false, code, message })

/** Where `path` really ends, if that's inside `root`: undefined otherwise, or when it doesn't exist. */
async function inside(root: string, path: string): Promise<{ real: string; rel: string; root: string } | { outside: true } | { missing: true }> {
  const realRoot = await realpath(root)
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
  const abs = isAbsolute(expanded) ? expanded : resolve(realRoot, expanded)
  let real: string
  try {
    real = await realpath(abs)
  } catch {
    // A path that doesn't exist: missing if it names a place inside the folder, else outside.
    return abs.startsWith(realRoot + sep) ? { missing: true } : { outside: true }
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { outside: true }
  return { real, rel: relative(realRoot, real) || ".", root: realRoot }
}

/**
 * Whether `real`, with no link anywhere on it, still names the `opened` file. Every component is lstat'ed
 * before and after the last one is, so a folder swapped for a link and back has to land between those
 * stats to pass. Plain fs can't do better: a check with no window needs openat one component at a time.
 */
export async function namesOpened(real: string, opened: Stats): Promise<boolean> {
  const components: string[] = []
  for (let p = real; ; p = dirname(p)) {
    components.unshift(p)
    if (dirname(p) === p) break
  }
  const noLinks = async () => {
    for (const p of components) if ((await lstat(p)).isSymbolicLink()) return false
    return true
  }
  try {
    if (!(await noLinks())) return false
    const last = await lstat(real)
    if (last.dev !== opened.dev || last.ino !== opened.ino) return false
    return await noLinks()
  } catch {
    return false
  }
}

/**
 * Whether the open `handle` is a file inside `realRoot`. Linux names the file a handle has open
 * (/proc/self/fd), which no swap can change; elsewhere, `namesOpened`. Either way a race needs a process
 * swapping links inside the research folder while the read runs, which only an agent with its shell on
 * has, and that agent can read outside the folder anyway.
 */
async function openedInside(handle: FileHandle, opened: Stats, real: string, realRoot: string): Promise<boolean> {
  let at: string | undefined
  try {
    at = await readlink(`/proc/self/fd/${handle.fd}`)
  } catch {}
  if (at !== undefined) return at.startsWith(realRoot + sep)
  return namesOpened(real, opened)
}

/** `afterCheck` runs right after the path's check and `afterOpen` right after the open; tests use them to swap files in those moments. */
export async function researchCall(root: string, name: string, args: Record<string, unknown>, o: { afterCheck?: () => Promise<void>; afterOpen?: () => Promise<void> } = {}): Promise<Answer> {
  const path = args.path === undefined && name === "research_list" ? "." : args.path
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0")) return refuse("INVALID_ARGS", "path must name a file or folder in your research folder.")
  const outside = () => refuse("OUTSIDE_RESEARCH_FOLDER", `${path} is outside your research folder. You can read only your own notes, in the research folder.`)
  let where
  try {
    where = await inside(root, path)
  } catch {
    return refuse("NOT_FOUND", "Your research folder doesn't exist yet: write a note first.")
  }
  if ("outside" in where) return outside()
  if ("missing" in where) return refuse("NOT_FOUND", `There's no ${path} in your research folder.`)
  await o.afterCheck?.()
  const info = await stat(where.real)

  if (name === "research_list") {
    if (!info.isDirectory()) return refuse("NOT_A_FOLDER", `${path} is a file: read it with research_read.`)
    const all = await readdir(where.real, { withFileTypes: true })
    const entries = all.slice(0, MAX_ENTRIES).map((e) => ({ name: e.name, type: e.isSymbolicLink() ? "link" : e.isDirectory() ? "folder" : "file" }))
    return { ok: true, body: { path: where.rel, entries, ...(all.length > MAX_ENTRIES ? { more: all.length - MAX_ENTRIES } : {}) } }
  }

  if (info.isDirectory()) return refuse("NOT_A_FILE", `${path} is a folder: list it with research_list.`)
  // What was opened must be the file the path's check found (its device and inode), and still inside the
  // folder by the path it was opened by: a folder or link swapped in between the check and the open would
  // otherwise be read, wherever it points. Size is the opened file's.
  const handle = await open(where.real, "r")
  let buf: Buffer
  try {
    await o.afterOpen?.()
    const opened = await handle.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino) return outside()
    if (!(await openedInside(handle, opened, where.real, where.root))) return outside()
    if (opened.size > MAX_READ_BYTES) return refuse("TOO_BIG", `${path} is ${Math.round(opened.size / 1024)} KB; research_read reads files up to ${MAX_READ_BYTES / 1024} KB.`)
    buf = await handle.readFile()
  } finally {
    await handle.close()
  }
  if (buf.includes(0)) return refuse("NOT_TEXT", `${path} isn't a text file.`)
  const lines = buf.toString("utf8").split(/(?<=\n)/)
  const offset = Number.isInteger(args.offset) && (args.offset as number) > 0 ? (args.offset as number) : 1
  const limit = Number.isInteger(args.limit) && (args.limit as number) > 0 ? Math.min(args.limit as number, MAX_LINES) : DEFAULT_LINES
  const picked = lines.slice(offset - 1, offset - 1 + limit)
  return { ok: true, body: { path: where.rel, text: picked.join(""), fromLine: offset, toLine: offset - 1 + picked.length, totalLines: lines.length } }
}
