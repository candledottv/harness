// The Build pane: the person's own coding harness in a terminal, opened in the bots folder. Before it runs, the pane
// draws its own screens: the first open (where the bots live, and which harness), the files written, "not started",
// and "it exited". The harness's process lives in the view for as long as the view does, so a tab switch keeps its
// scrollback; its terminal is drawn by the frame over the pane's inside (app.tsx). The pane's build token is minted
// by the core when the harness first starts, handed to this view alone, and put in the harness's environment and a
// 0600 file of this view's. When the view reattaches to a core that restarted, the old token is gone with the old core:
// a new one is opened at once and written to the file, so the harness already running keeps working.
//
// What it never does: start a harness unasked, stop a daemon a harness left behind unasked, or write over a file in
// the bots folder the person changed (build/folder.ts).
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { useCallback, useEffect, useRef, useState } from "react"
import { botsFolderPath, folderWriteWords, type FolderWrite, writeBotsFolder } from "../build/folder"
import { commandArgv, DEFAULT_FOLDER, folderProblem, isEngineHarness } from "../core/build-prefs"
import { ENGINE_IDS, ENGINE_LABELS, type EngineId } from "../engine/engine"
import { type BuildSpawner, buildTokenFile, forgetBuildToken, keepBuildToken } from "./build-process"
import type { BuildFolder } from "./build-view"
import { wrap } from "./format"
import type { Rect } from "./layout"
import type { PaneProcess } from "./pane-process"
import { blank, chip, type Line, line, type Seg } from "./panes/lines"
import type { EngineTopic } from "./panes/engines"
import { innerCols, innerRows } from "./panes/pane"
import { C } from "./theme"
import { TEST_PREFIX } from "../shared/bot-name"

/** What the core answers for the pane's choices: build-prefs.ts's, with each engine's binary as config names it. */
export interface BuildPrefsAnswer {
  folder: string
  harness?: string
  opened: boolean
  /** The saved folder is one the core won't open (/, the home, or one of the Candle Harness's own): asked for again. */
  folderRefused?: string
  bins: Partial<Record<EngineId, string>>
}

/** Where the pane is: asking (first open), the files written, ready to start, started and not drawn yet, running, or exited. */
export type BuildStage = "loading" | "ask" | "written" | "ready" | "starting" | "running" | "exited"

/** The harness rows that are engines. */
const engineRows = (): EngineId[] => HARNESS_ROWS.filter((r): r is EngineId => r !== "command")

/** Each engine checked again, its version and sign-in read afresh, in the background: the picker follows the topic. */
function recheckEngines(request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>, ids: readonly EngineId[]): void {
  for (const engine of ids) void request("engine.check", { engine, again: true }).catch(() => {})
}

/** How long the pane says "Starting…" for a harness that draws nothing: then its terminal shows anyway. */
export const STARTING_MAX_MS = 30_000

/** The first open's form: the folder typed, which line has the keys, the harness highlighted, and a command typed. */
export interface BuildAsk {
  folder: string
  field: "folder" | "harness" | "command"
  index: number
  command: string
  error?: string
  /** Opened again from harness ▾: a harness's choice, not the first open. */
  again?: boolean
}

/** A process a harness left running after it exited (Codex's app-server): listed with a stop chip, never stopped unasked. */
export interface Daemon {
  pid: number
  what: string
}

/** The harness rows of the first open: each engine, then "another command…". */
export const HARNESS_ROWS: readonly (EngineId | "command")[] = [...ENGINE_IDS, "command"]

/** A harness's name as the pane shows it: an engine's label, or the command's first word. */
export function harnessLabel(harness: string | undefined): string {
  if (!harness) return "your harness"
  if (isEngineHarness(harness)) return ENGINE_LABELS[harness]
  return commandArgv(harness)[0]?.split("/").at(-1) ?? harness
}

/** The argv a harness starts with: an engine's binary as config names it, or the command's words. */
export function harnessArgv(harness: string, bins: Partial<Record<EngineId, string>>): string[] {
  if (isEngineHarness(harness)) return [bins[harness] ?? ENGINE_BIN[harness]]
  return commandArgv(harness)
}

const ENGINE_BIN: Record<EngineId, string> = { "claude-code": "claude", codex: "codex", grok: "grok", opencode: "opencode", pi: "pi" }

const tilde = (path: string, home = process.env.HOME || homedir()) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** The engine's state as the picker reads it, in a few words. */
function engineWords(id: EngineId, engine: EngineTopic | undefined): { version: string; words: string; fg: string; runs: boolean } {
  const info = engine?.engines[id]
  if (!info) return { version: "", words: "checking…", fg: C.dim, runs: false }
  if (!info.check) return { version: "", words: "checking…", fg: C.dim, runs: false }
  if (!info.check.ok) return { version: "", words: info.check.message ? `not here · ${info.check.message}` : "not installed", fg: C.dim, runs: false }
  const version = info.check.version ?? ""
  if (info.signedIn === false) return { version, words: "not signed in · it asks when it starts", fg: C.dim, runs: true }
  return { version, words: info.signedIn ? "signed in" : "", fg: C.dim, runs: true }
}

/** The pane's lines before its harness runs, for each stage. Chips carry what they do on `ref`, with the act "build". */
export function buildScreenLines(input: {
  stage: BuildStage
  ask: BuildAsk
  write?: FolderWrite
  prefs?: BuildPrefsAnswer
  engine?: EngineTopic
  exited?: number
  /** On Free: the plan's words, and the command that upgrades it. */
  gate?: { words: string; fix?: string }
  width: number
  focused: boolean
  /** The harness that ran, for "it exited". */
  ran?: string
}): Line[] {
  const { stage, ask, width } = input
  const w = Math.max(10, width)
  const out: Line[] = []
  const para = (text: string, fg = C.ink) => out.push(...wrap(text, w).map((t) => line(t, fg)))
  const harness = input.prefs?.harness
  if (stage === "loading") return [line("Reading the Build tab's folder and harness…", C.dim)]
  if (stage === "ask") {
    const box = Math.min(46, w - 2)
    const caret = input.focused && ask.field === "folder" ? "█" : ""
    out.push(blank(), line("Where should your bots live?", C.head))
    out.push(line(`╭${"─".repeat(box)}╮`, ask.field === "folder" ? C.focus : C.edge))
    out.push({ segs: [{ text: "│ ", fg: ask.field === "folder" ? C.focus : C.edge }, { text: `${ask.folder}${caret}`.slice(-(box - 2)).padEnd(box - 2), fg: C.hi }, { text: " │", fg: ask.field === "folder" ? C.focus : C.edge }] })
    out.push(line(`╰${"─".repeat(box)}╯`, ask.field === "folder" ? C.focus : C.edge))
    para("Each bot is a folder in it. Your editor, git and backups find it there.", C.dim)
    if (ask.error) para(ask.error, C.bad)
    out.push(blank(), line("Which coding harness?", C.head))
    HARNESS_ROWS.forEach((id, i) => {
      const on = i === ask.index
      const mark = on ? (ask.field === "folder" ? "› " : "▸ ") : "  "
      if (id === "command") {
        const typing = ask.field === "command" && on
        out.push({ segs: [{ text: mark, fg: C.focus }, { text: typing ? `${ask.command}${input.focused ? "█" : ""}` : ask.command ? `another command: ${ask.command}` : "another command…", fg: on ? C.hi : C.ink }], ref: `harness:${i}` })
        return
      }
      const e = engineWords(id, input.engine)
      out.push({ segs: [{ text: mark, fg: C.focus }, { text: ENGINE_LABELS[id].padEnd(13), fg: on ? C.hi : e.runs ? C.ink : C.dim }, { text: e.version.padEnd(10), fg: C.dim }, { text: e.words, fg: e.fg }], ref: `harness:${i}` })
    })
    para("Over SSH or on a VPS, each one signs in by a code in the pane; the docs give each one's command.", C.dim)
    out.push(blank())
    const next: Seg[] = [{ text: " ", fg: C.ink }, { ...chip(`⏎ start in ${ask.folder.trim() || DEFAULT_FOLDER}`, "build"), ref: "submit" }, { text: "  tab next  ↑/↓ harness", fg: C.dim }]
    out.push({ segs: next })
    return out
  }
  if (input.gate) {
    para(`${input.gate.words.replace(/\.$/, "")}. Your harness and the bots folder still work here; a bot can't be tested on paper or proposed until then.`, C.ink)
    if (input.gate.fix) out.push({ segs: [{ text: " ", fg: C.ink }, { ...chip(input.gate.fix, "fill"), ref: input.gate.fix }, { text: "  goes on the input line", fg: C.dim }] })
    out.push(blank())
  }
  if (stage === "written" && input.write) {
    const changed = input.write.written.length + input.write.updated.length
    out.push(blank(), line(`${tilde(input.write.folder)} is ready · ${changed ? `${changed} files written` : "nothing needed writing"}`, C.head), blank())
    const rows: [string, string][] = [
      ["AGENTS.md", "the rules every bot runs under, and how to propose one"],
      ["CLAUDE.md", "@AGENTS.md, so Claude Code reads the same"],
      ["harness-client.ts", "the client a bot trades through (MIT)"],
      [".gitignore", "keeps each bot's token file out of git"],
      [".claude/skills/", "Candle's bot-building skills"],
      [".agents/skills/", "the same skills, for Codex, Pi and OpenCode"],
    ]
    for (const [path, why] of rows) {
      const kept = input.write.kept.some((k) => k === path || k.startsWith(path))
      out.push({ segs: [{ text: kept ? "· " : "✓ ", fg: kept ? C.dim : C.good }, { text: path.padEnd(20), fg: C.ink }, { text: kept ? "yours, kept as it is" : why, fg: C.dim }] })
    }
    out.push(blank())
    for (const l of folderWriteWords(input.write).slice(1)) para(l, C.dim)
    para("Nothing here trades. A bot runs only after you approve its card. An update never writes over a file you changed: it says so, and leaves yours.", C.dim)
    out.push(blank(), { segs: [{ text: " ", fg: C.ink }, { ...chip(`⏎ start ${harnessLabel(harness)}`, "build"), ref: "start" }, { text: "  ", fg: C.ink }, { ...chip("open the folder", "build"), ref: "openFolder" }] })
    return out
  }
  const folder = input.prefs?.folder ?? DEFAULT_FOLDER
  if (stage === "starting") {
    out.push(blank(), line(`Starting ${harnessLabel(input.ran ?? harness)} in ${folder}…`, C.ink))
    para("A harness can take 10 to 30 seconds to draw the first time. Its screen shows here as soon as it does.", C.dim)
    return out
  }
  if (stage === "exited") {
    out.push(blank(), line(`${harnessLabel(input.ran ?? harness)} exited${input.exited ? ` (status ${input.exited})` : ""}.`, C.ink))
    para("Your bots and the folder are as it left them. A paper test it started has ended with it.", C.dim)
    out.push(blank(), { segs: [{ text: " ", fg: C.ink }, { ...chip(`⏎ start ${harnessLabel(harness)} again`, "build"), ref: "start" }, { text: "  ", fg: C.ink }, { ...chip("harness ▾", "build"), ref: "harness" }] })
    return out
  }
  out.push(blank(), line(`${harnessLabel(harness)} opens in ${folder}, signed in as you.`, C.ink))
  para("It reads the folder's AGENTS.md: the rules every bot runs under, the client, and Candle's bot-building skills. It can test a bot on paper and propose it; a bot runs only once you approve its card.", C.dim)
  out.push(blank(), { segs: [{ text: " ", fg: C.ink }, { ...chip(`⏎ start ${harnessLabel(harness)}`, "build"), ref: "start" }, { text: "  ", fg: C.ink }, { ...chip("harness ▾", "build"), ref: "harness" }] })
  return out
}

/** What a selection says: in the Build pane's harness ctrl-c is the harness's own key (it quits some), so only a right-click copies. */
export function selectionHint(inHarness: boolean): string {
  return inHarness ? "Selected: a right-click copies it." : "Selected: ctrl-c or a right-click copies it."
}

/** The pane's title: what runs, and where. */
/** `agent`: the agent the running harness's bots are built for, named so a bot is never proposed for one unseen. */
export function buildTitle(stage: BuildStage, prefs: BuildPrefsAnswer | undefined, ran: string | undefined, agent?: string, again?: boolean): string {
  if (stage === "ask" || stage === "written") return again ? "Build · harness" : "Build · first open"
  const where = prefs?.folder ?? DEFAULT_FOLDER
  if (stage === "running" || stage === "starting") return `Build · ${harnessLabel(ran ?? prefs?.harness)}${agent ? ` · for ${agent}` : ""} · ${where}`
  if (stage === "exited") return `Build · ${harnessLabel(ran ?? prefs?.harness)} exited`
  return "Build · not started"
}

/** Where the harness's terminal goes: inside the pane's border, its padding left out. */
export function terminalRect(pane: Rect): Rect {
  const pad = Math.max(0, (pane.w - 2 - innerCols(pane)) / 2)
  return { x: pane.x + 1 + pad, y: pane.y + 1, w: innerCols(pane), h: innerRows(pane) }
}

/** The bots folder's own folders, by name: each a bot's, hidden ones and dependencies left out. */
export async function readBuildFolder(folder: string): Promise<BuildFolder | undefined> {
  const path = botsFolderPath(folder)
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const subs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).sort()
    return { path, shown: tilde(path), subs }
  } catch {
    return undefined
  }
}

/** Seconds from `ps`'s elapsed time, `[[dd-]hh:]mm:ss`. */
export function elapsedSeconds(etime: string): number {
  const [days, rest] = etime.includes("-") ? (etime.split("-") as [string, string]) : ["0", etime]
  const parts = rest.split(":").map(Number)
  while (parts.length < 3) parts.unshift(0)
  return Number(days) * 86_400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
}

/** What a harness is known to leave running: Codex's app-server, reparented to init. */
const LEFTOVERS: readonly { what: string; match: RegExp }[] = [{ what: "Codex's app-server", match: /\bcodex\b.*\bapp-server\b/ }]

/** The daemons a harness left: a known leftover, its parent gone (parent pid 1), started since the pane opened. */
export function daemonsIn(ps: string, sinceSeconds: number): Daemon[] {
  const out: Daemon[] = []
  for (const row of ps.split("\n")) {
    const m = row.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, etime, args] = m
    if (ppid !== "1" || elapsedSeconds(etime!) > sinceSeconds) continue
    const known = LEFTOVERS.find((l) => l.match.test(args!))
    if (known) out.push({ pid: Number(pid), what: known.what })
  }
  return out
}

async function readDaemons(openedAt: number, now: number): Promise<Daemon[]> {
  try {
    const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,etime=,args="], { stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return daemonsIn(text, Math.ceil((now - openedAt) / 1000) + 5)
  } catch {
    return []
  }
}

/** What the core's `build.open` answers this view: the pane's token, here alone. */
interface Opened {
  tokenId: string
  token: string
  socketPath: string
  agent: string
  gate: { words: string; fix?: string } | null
}

export interface UseBuild {
  stage: BuildStage
  ask: BuildAsk
  write?: FolderWrite
  prefs?: BuildPrefsAnswer
  proc?: PaneProcess
  exited?: number
  ran?: string
  /** The agent the harness's bots are built for: the one active when it was started. */
  agent?: string
  folder?: BuildFolder
  daemons: Daemon[]
  /** A key on the pane's own screens; true when it took it. */
  key(key: { name: string; ctrl?: boolean; meta?: boolean; sequence?: string }): boolean
  /** A chip on the pane's screens or its side column, by its ref. */
  act(ref: string): void
  /** Starts the harness (asked for by ⏎ or the chip). */
  start(): void
  /** The pane's inside, as last drawn: where the harness's terminal goes, and its size. */
  place(rect: Rect | undefined): void
  stopDaemon(pid: number): void
  endTest(name: string): void
}

/**
 * The Build pane's state, held by the frame for as long as the view lives. `shown`: the Build pane is on screen now,
 * which is when its choices are first read. `agent`: the agent the bots are built for, the active one.
 */
export function useBuild(input: {
  shown: boolean
  agent: string | undefined
  /** Attached to a core now: a reattach (to a core that restarted) opens the pane's session again. */
  connected?: boolean
  engine: EngineTopic | undefined
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  spawn: BuildSpawner | undefined
  say: (text: string, level?: "info" | "error") => void
  now: () => number
  /** Moves focus into the pane when the harness starts. */
  focus: () => void
}): UseBuild {
  const [stage, setStage] = useState<BuildStage>("loading")
  const [prefs, setPrefs] = useState<BuildPrefsAnswer>()
  const [ask, setAsk] = useState<BuildAsk>({ folder: DEFAULT_FOLDER, field: "folder", index: 0, command: "" })
  const [write, setWrite] = useState<FolderWrite>()
  const [proc, setProc] = useState<PaneProcess>()
  const [exited, setExited] = useState<number>()
  const [ran, setRan] = useState<string>()
  const [agent, setAgent] = useState<string>()
  const [folder, setFolder] = useState<BuildFolder>()
  const [daemons, setDaemons] = useState<Daemon[]>([])
  const daemonsRef = useRef<Daemon[]>([])
  daemonsRef.current = daemons
  const opened = useRef<Opened | undefined>(undefined)
  const openedAt = useRef(0)
  const rect = useRef<Rect | undefined>(undefined)
  const procRef = useRef<PaneProcess | undefined>(undefined)
  const asked = useRef(false)
  const live = useRef(input)
  live.current = input
  /** The file this view keeps its pane's current token in, once a session has opened. */
  const tokenFile = useRef<string | undefined>(undefined)
  const keep = (o: Opened): string | undefined => {
    const file = buildTokenFile(o.socketPath)
    if (!keepBuildToken(file, o.token)) return undefined
    tokenFile.current = file
    return file
  }

  // A reattach: the core that minted the pane's token is gone (or let this view's sessions go when it detached), so
  // a session that was open is opened again for the same agent, and its token written where the harness reads it.
  const wasConnected = useRef(input.connected)
  useEffect(() => {
    const was = wasConnected.current
    wasConnected.current = input.connected
    if (input.connected !== true || was !== false) return
    const o = opened.current
    if (!o) return
    void live.current
      .request<Opened>("build.open", { agent: o.agent, ...(ran ? { harness: harnessLabel(ran) } : {}) })
      .then((next) => {
        opened.current = next
        keep(next)
      })
      .catch((error: unknown) => {
        // A pane with no session gets a new one at its next start.
        opened.current = undefined
        live.current.say(`The Build pane couldn't open again after the core restarted: ${error instanceof Error ? error.message : String(error)}. Start the harness again with ⏎ once it has exited.`, "error")
      })
  }, [input.connected])

  // The pane's choices, read the first time it's on screen.
  useEffect(() => {
    if (!input.shown || asked.current) return
    asked.current = true
    void input
      .request<BuildPrefsAnswer>("build.prefs", {})
      .then((p) => {
        setPrefs(p)
        const index = p.harness ? Math.max(0, HARNESS_ROWS.indexOf(isEngineHarness(p.harness) ? p.harness : "command")) : 0
        setAsk({ folder: p.folder, field: "folder", index, command: p.harness && !isEngineHarness(p.harness) ? p.harness : "", ...(p.folderRefused ? { error: p.folderRefused } : {}) })
        setStage(p.opened && p.harness ? "ready" : "ask")
        if (!(p.opened && p.harness)) recheckEngines(live.current.request, engineRows())
        // The first open takes the keys as it shows, so what's typed goes into its folder.
        if (!(p.opened && p.harness)) live.current.focus()
      })
      .catch((error: unknown) => {
        asked.current = false
        live.current.say(`The Build tab couldn't read its folder and harness: ${error instanceof Error ? error.message : String(error)}`, "error")
      })
  }, [input.shown, input.request])

  // The bots folder's own folders, every 3 s while the pane is on screen.
  useEffect(() => {
    if (!input.shown || !prefs?.opened) return
    let gone = false
    const read = () => void readBuildFolder(prefs.folder).then((f) => !gone && setFolder(f))
    read()
    const timer = setInterval(read, 3_000)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [input.shown, prefs?.opened, prefs?.folder])

  // The harness is hung up, and the pane's token closed, when the view goes.
  useEffect(
    () => () => {
      procRef.current?.close()
      const o = opened.current
      if (o) void live.current.request("build.close", { tokenId: o.tokenId }).catch(() => {})
      if (tokenFile.current) forgetBuildToken(tokenFile.current)
    },
    [],
  )

  const start = useCallback(() => {
    const i = live.current
    const p = prefs
    if (!p?.harness) return setStage("ask")
    if (procRef.current && exited === undefined) return i.focus()
    if (!i.spawn) return i.say("This view can't open a terminal, so the harness can't start here.", "error")
    if (!i.agent) return i.say("No agent with a key yet: the Build tab builds bots for an agent. Set one up with candle-harness setup.", "error")
    const argv = harnessArgv(p.harness, p.bins)
    if (argv.length === 0) return i.say("The harness's command is empty: pick one with harness ▾.", "error")
    const r = rect.current
    const size = r ? terminalRect(r) : { w: 80, h: 24 }
    const go = (o: Opened) => {
      let started: PaneProcess
      const file = keep(o)
      try {
        started = i.spawn!({ argv, cwd: botsFolderPath(p.folder), token: o.token, socketPath: o.socketPath, ...(file ? { tokenFile: file } : {}), cols: size.w, rows: size.h })
      } catch (error) {
        return i.say(`${harnessLabel(p.harness)} couldn't start: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
      openedAt.current = i.now()
      procRef.current = started
      setProc(started)
      setExited(undefined)
      setRan(p.harness)
      setAgent(o.agent)
      setDaemons([])
      // "Starting…" until the harness draws (some take 10 to 30 s), so a pane that looks empty isn't pressed again.
      setStage("starting")
      let drawn = false
      const running = () => {
        if (drawn || procRef.current !== started) return
        drawn = true
        setStage((s) => (s === "starting" ? "running" : s))
      }
      started.onData(running)
      setTimeout(running, STARTING_MAX_MS)
      i.focus()
      void started.exited.then(async (code) => {
        // A harness may have updated itself while it ran: its version and sign-in are read again.
        if (isEngineHarness(p.harness!)) recheckEngines(live.current.request, [p.harness as EngineId])
        if (procRef.current !== started) return
        setExited(code)
        setStage("exited")
        setDaemons(await readDaemons(openedAt.current, live.current.now()))
      })
    }
    // The session is the agent's: started again after the active agent changed, it's a new one for the new agent.
    if (opened.current && opened.current.agent !== i.agent) {
      void i.request("build.close", { tokenId: opened.current.tokenId }).catch(() => {})
      opened.current = undefined
    }
    if (opened.current) return go(opened.current)
    void i
      .request<Opened>("build.open", { agent: i.agent, harness: harnessLabel(p.harness) })
      .then((o) => {
        opened.current = o
        go(o)
      })
      .catch((error: unknown) => i.say(`The Build pane couldn't open: ${error instanceof Error ? error.message : String(error)}`, "error"))
  }, [prefs, exited])

  /** The first open's answer: the folder written, the choices kept, then "⏎ start". */
  const submit = useCallback(async () => {
    const i = live.current
    const problem = folderProblem(ask.folder)
    if (problem) return setAsk((a) => ({ ...a, field: "folder", error: problem }))
    const row = HARNESS_ROWS[ask.index]!
    if (row === "command" && !ask.command.trim()) return setAsk((a) => ({ ...a, field: "command", error: "Type the command that starts your harness, such as aider." }))
    const harness = row === "command" ? ask.command.trim() : row
    if (row !== "command" && i.engine?.engines[row]?.check?.ok === false) return setAsk((a) => ({ ...a, field: "harness", error: `${ENGINE_LABELS[row]} isn't on this machine: install it, or pick another.` }))
    // The core checks where the folder really is before anything is written there: never /, the home, or its own folders.
    try {
      await i.request<BuildPrefsAnswer>("build.prefs", { set: { folder: ask.folder.trim(), harness } })
    } catch (error) {
      return setAsk((a) => ({ ...a, field: "folder", error: error instanceof Error ? error.message : String(error) }))
    }
    let written: FolderWrite
    try {
      written = await writeBotsFolder(botsFolderPath(ask.folder))
    } catch (error) {
      return setAsk((a) => ({ ...a, field: "folder", error: error instanceof Error ? error.message : String(error) }))
    }
    try {
      const p = await i.request<BuildPrefsAnswer>("build.prefs", { set: { opened: true } })
      setPrefs(p)
    } catch (error) {
      return i.say(`The Build pane's choices couldn't be kept: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    setWrite(written)
    setStage("written")
  }, [ask])

  const key = useCallback(
    (k: { name: string; ctrl?: boolean; meta?: boolean; sequence?: string }): boolean => {
      if (k.ctrl || k.meta) return false
      const enter = k.name === "return" || k.name === "enter" || k.name === "kpenter"
      if (stage === "ask") {
        if (k.name === "tab") return setAsk((a) => ({ ...a, field: a.field === "folder" ? "harness" : "folder", error: undefined })), true
        if (k.name === "up" || k.name === "down") {
          // From the folder, the arrows go to the harness list first, its pick as it was.
          if (ask.field === "folder") return setAsk((a) => ({ ...a, field: HARNESS_ROWS[a.index] === "command" ? "command" : "harness", error: undefined })), true
          setAsk((a) => {
            const index = (a.index + (k.name === "up" ? HARNESS_ROWS.length - 1 : 1)) % HARNESS_ROWS.length
            return { ...a, index, field: HARNESS_ROWS[index] === "command" ? "command" : "harness", error: undefined }
          })
          return true
        }
        // ⏎ does what its chip says from any line: starts in the folder typed, with the harness highlighted.
        if (enter) return void submit(), true
        const typing = ask.field === "folder" ? "folder" : ask.field === "command" ? "command" : undefined
        if (!typing) return false
        if (k.name === "backspace") return setAsk((a) => ({ ...a, [typing]: a[typing].slice(0, -1), error: undefined })), true
        const ch = k.sequence ?? ""
        if (ch.length === 1 && ch >= " " && ch !== "\u007f") return setAsk((a) => ({ ...a, [typing]: (a[typing] + ch).slice(0, 400), error: undefined })), true
        return false
      }
      if ((stage === "written" || stage === "ready" || stage === "exited") && enter) {
        start()
        return true
      }
      // Started, not drawn yet: a second ⏎ is the same press again, not one for the harness.
      if (stage === "starting" && enter) return true
      return false
    },
    [stage, ask, submit, start],
  )

  const act = useCallback(
    (ref: string) => {
      const i = live.current
      if (ref === "submit") return void submit()
      if (ref === "start") return start()
      if (ref === "harness") {
        // Back to the choice, the folder as it is: the folder's files are written again only if it changes.
        setAsk((a) => ({ ...a, again: true, error: undefined }))
        recheckEngines(i.request, engineRows())
        return setStage("ask")
      }
      if (ref.startsWith("harness:")) {
        const index = Number(ref.slice(8))
        return setAsk((a) => ({ ...a, index, field: HARNESS_ROWS[index] === "command" ? "command" : "harness", error: undefined }))
      }
      if (ref === "openFolder" && prefs) {
        const path = botsFolderPath(prefs.folder)
        const opener = process.platform === "darwin" ? "open" : "xdg-open"
        // Over SSH, or a Linux box with no desktop, there's nothing to open it in: the path is what helps.
        const desktop = process.platform === "darwin" ? !process.env.SSH_CONNECTION : !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
        if (!desktop) return i.say(`Your bots folder is ${tilde(path)}.`)
        try {
          Bun.spawn([opener, path], { stdout: "ignore", stderr: "ignore" })
          return i.say(`Opened ${tilde(path)}.`)
        } catch {
          return i.say(`Your bots folder is ${tilde(path)}.`)
        }
      }
      if (ref.startsWith("daemon:")) return stopDaemon(Number(ref.slice(7)))
      if (ref.startsWith("stopTest:")) return endTest(ref.slice(9))
    },
    [submit, start, prefs],
  )

  const stopDaemon = (pid: number) => {
    const d = daemonsRef.current.find((x) => x.pid === pid)
    if (!d) return
    try {
      process.kill(pid, "SIGTERM")
      live.current.say(`Stopped ${d.what} (pid ${pid}).`)
    } catch (error) {
      live.current.say(`${d.what} (pid ${pid}) couldn't be stopped: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    setDaemons((all) => all.filter((x) => x.pid !== pid))
  }

  // A paper test is the Build pane's to end: its token's. Ending the harness ends it too.
  const endTest = (name: string) => {
    const o = opened.current
    if (!o) return live.current.say("This view didn't start that test; it ends with its own pane, or in 30 minutes.")
    void live.current.request("build.endTest", { name }).then(
      () => live.current.say(`Ended the paper test ${name.slice(TEST_PREFIX.length)}.`),
      (error: unknown) => live.current.say(`The test couldn't be ended here: ${error instanceof Error ? error.message : String(error)}`, "error"),
    )
  }

  return {
    stage,
    ask,
    ...(write ? { write } : {}),
    ...(prefs ? { prefs } : {}),
    ...(proc ? { proc } : {}),
    ...(exited !== undefined ? { exited } : {}),
    ...(ran ? { ran } : {}),
    ...(agent ? { agent } : {}),
    ...(folder ? { folder } : {}),
    daemons,
    key,
    act,
    start,
    place: (r) => {
      rect.current = r
    },
    stopDaemon,
    endTest,
  }
}
