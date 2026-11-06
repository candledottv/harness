// The resource sampler: once a minute for a set number
// of hours, the core's, the views' and the core's children's CPU and memory; what the core fetched from
// Candle (calls and bytes, by key) and Hacc (reads, bytes, stream frames) and which background reads were
// live; and the journal's size. One JSON line a sample; a summary beside it every hour and at the end,
// naming every gap over two minutes, so a sleep or a stall is never read as a quiet stretch.
//
//   sampler [--hours 12] [--every 60] [--out <file.jsonl>]     run, then stop by itself
//   sampler --summarise <file.jsonl>                           summarise a file again (a run cut short)
// On macOS it holds the machine awake with `caffeinate -dimsu -w <its pid>` for as long as it runs, and
// each sample says whether that still held. It reads the core as a view that only reads (SAMPLER_CLIENT),
// which never opens or closes a session or keeps an idle core running. It reads totals only: no keys, no rows.
// CANDLE_HARNESS_HOME is honoured as the Candle Harness honours it.
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { hostname, platform, userInfo } from "node:os"
import { resolve } from "node:path"
import { type CoreConnection, connectView, SAMPLER_CLIENT } from "../../src/core/client"
import type { UsageTotals } from "../../src/core/usage"
import { paths } from "../../src/paths"

export const GAP_MS = 2 * 60_000

export interface Proc {
  pid: number
  ppid: number
  rssKb: number
  /** CPU time used so far, in seconds. */
  cpuS: number
  command: string
}

export interface Sample {
  at: number
  /** Whether caffeinate was still holding the machine awake (macOS); null where there's none. */
  awake: boolean | null
  core?: { pid: number; rssKb: number; cpuS: number }
  /** The core's descendants: Candle's MCP servers, engine turns, the prompt pane's runs. */
  children: { count: number; rssKb: number; cpuS: number }
  views: { pid: number; rssKb: number; cpuS: number; command: string }[]
  usage?: UsageTotals & { at: number; reading: Reading }
  usageError?: string
  journalBytes?: number
  pnlSamplesBytes?: number
}

export interface Reading {
  lists: string[]
  stream: string
  pnlPerMin: number
  research: number
  budget: { agent: string; used: number; background: number }[]
}

/** `ps`'s CPU time: macOS's `m:ss.cc` or `h:mm:ss`, Linux's `[d-]hh:mm:ss`. */
export function cpuSeconds(text: string): number {
  const [days, rest] = text.includes("-") ? [Number(text.split("-")[0]), text.split("-")[1]!] : [0, text]
  const parts = rest.split(":").map(Number)
  let s = 0
  for (const p of parts) s = s * 60 + p
  return days * 86_400 + s
}

/** Linux's own count of a process's CPU time, finer than ps's whole seconds: utime + stime, in clock ticks (100 a second). */
function procCpuSeconds(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return (Number(fields[11]) + Number(fields[12])) / 100
  } catch {
    return undefined
  }
}

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpuS: (platform() === "linux" ? procCpuSeconds(Number(m[1])) : undefined) ?? cpuSeconds(m[4]!), command: m[5]! })
  }
  return procs
}

/** Every descendant of `root`. */
export function descendants(procs: Proc[], root: number): Proc[] {
  const out: Proc[] = []
  const frontier = [root]
  while (frontier.length) {
    const parent = frontier.pop()!
    for (const p of procs) if (p.ppid === parent && !out.includes(p)) {
      out.push(p)
      frontier.push(p.pid)
    }
  }
  return out
}

/** A view of the Candle Harness's: `candle-harness`, `candle-harness view …` or `candle-harness setup`, from the binary or from source. */
export function isView(command: string): boolean {
  const m = /(?:^|\/)(?:candle-harness|main\.ts)(?=\s|$)(?:\s+(\S+))?/.exec(command)
  if (!m) return false
  const sub = m[1]
  return sub === undefined || sub === "view" || sub === "setup" || sub.startsWith("--")
}

function corePid(lockFile: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown }).pid
    return typeof pid === "number" ? pid : undefined
  } catch {
    return undefined
  }
}

const size = (file: string) => statSync(file, { throwIfNoEntry: false })?.size

// --- The summary ---

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : NaN)
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN)
const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—")
const clock = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z"

/** The least-squares slope of y over time, a unit an hour. */
export function slopePerHour(points: { at: number; y: number }[]): number {
  if (points.length < 2) return NaN
  const t0 = points[0]!.at
  const xs = points.map((p) => (p.at - t0) / 3_600_000)
  const mx = mean(xs)
  const my = mean(points.map((p) => p.y))
  let num = 0
  let den = 0
  points.forEach((p, i) => {
    num += (xs[i]! - mx) * (p.y - my)
    den += (xs[i]! - mx) ** 2
  })
  return den ? num / den : NaN
}

/** Each pair of samples a core apart: CPU a share of one core, and what was fetched a minute. */
interface Interval {
  minutes: number
  coreCpu?: number
  viewCpu?: number
  childCpu?: number
  candle: Record<string, { calls: number; kb: number }>
  hacc?: { requests: number; kb: number }
  stream?: { frames: number; kb: number }
}

export function intervals(samples: Sample[]): Interval[] {
  const out: Interval[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!
    const b = samples[i]!
    const ms = b.at - a.at
    if (ms <= 0 || ms > GAP_MS) continue
    const minutes = ms / 60_000
    const share = (x?: number, y?: number) => (x !== undefined && y !== undefined && y >= x ? ((y - x) / (ms / 1000)) * 100 : undefined)
    const sameCore = a.core && b.core && a.core.pid === b.core.pid
    const viewsA = a.views.reduce((n, v) => n + v.cpuS, 0)
    const viewsB = b.views.reduce((n, v) => n + v.cpuS, 0)
    const sameViews = a.views.map((v) => v.pid).join() === b.views.map((v) => v.pid).join()
    const iv: Interval = { minutes, candle: {} }
    if (sameCore) {
      const c = share(a.core!.cpuS, b.core!.cpuS)
      if (c !== undefined) iv.coreCpu = c
      const ch = share(a.children.cpuS, b.children.cpuS)
      if (ch !== undefined) iv.childCpu = ch
    }
    if (sameViews && b.views.length) {
      const v = share(viewsA, viewsB)
      if (v !== undefined) iv.viewCpu = v
    }
    // Totals restart with a new core: only a pair from one core counts.
    if (a.usage && b.usage && a.usage.since === b.usage.since) {
      for (const [agent, u] of Object.entries(b.usage.candle)) {
        const before = a.usage.candle[agent] ?? { calls: 0, bytes: 0 }
        iv.candle[agent] = { calls: (u.calls - before.calls) / minutes, kb: (u.bytes - before.bytes) / 1024 / minutes }
      }
      iv.hacc = { requests: (b.usage.hacc.requests - a.usage.hacc.requests) / minutes, kb: (b.usage.hacc.bytes - a.usage.hacc.bytes) / 1024 / minutes }
      iv.stream = { frames: (b.usage.stream.frames - a.usage.stream.frames) / minutes, kb: (b.usage.stream.bytes - a.usage.stream.bytes) / 1024 / minutes }
    }
    out.push(iv)
  }
  return out
}

/** Each midnight inside the window, local and UTC: the day's boundaries the run crossed. */
export function midnights(from: number, to: number): { local: number[]; utc: number[] } {
  const local: number[] = []
  const utc: number[] = []
  const d = new Date(from)
  d.setHours(24, 0, 0, 0)
  for (let t = d.getTime(); t <= to; d.setDate(d.getDate() + 1), t = d.getTime()) local.push(t)
  const u = new Date(from)
  u.setUTCHours(24, 0, 0, 0)
  for (let t = u.getTime(); t <= to; u.setUTCDate(u.getUTCDate() + 1), t = u.getTime()) utc.push(t)
  return { local, utc }
}

export function summarise(samples: Sample[], meta: { file: string; host?: string; plannedHours?: number; binaryBytes?: number; ended?: string }): string {
  if (!samples.length) return `# Resource sample: no samples\n\n${meta.file} holds none.\n`
  const first = samples[0]!.at
  const last = samples.at(-1)!.at
  const hours = (last - first) / 3_600_000
  const gaps: { from: number; to: number }[] = []
  for (let i = 1; i < samples.length; i++) if (samples[i]!.at - samples[i - 1]!.at > GAP_MS) gaps.push({ from: samples[i - 1]!.at, to: samples[i]!.at })
  const ivs = intervals(samples)
  const coreCpu = ivs.flatMap((i) => (i.coreCpu === undefined ? [] : [i.coreCpu]))
  const viewCpu = ivs.flatMap((i) => (i.viewCpu === undefined ? [] : [i.viewCpu]))
  const childCpu = ivs.flatMap((i) => (i.childCpu === undefined ? [] : [i.childCpu]))
  const mb = (kb: number) => kb / 1024
  const coreRss = samples.flatMap((s) => (s.core ? [{ at: s.at, y: mb(s.core.rssKb) }] : []))
  const viewRss = samples.flatMap((s) => (s.views.length ? [{ at: s.at, y: mb(s.views.reduce((n, v) => n + v.rssKb, 0)) }] : []))
  const childRss = samples.map((s) => ({ at: s.at, y: mb(s.children.rssKb) }))
  const memRow = (name: string, pts: { at: number; y: number }[], cpu: number[]) =>
    `| ${name} | ${f(mean(cpu), 2)}% | ${f(pct(cpu, 0.95), 2)}% | ${f(max(cpu), 2)}% | ${f(pts[0]?.y ?? NaN, 0)} | ${f(pts.at(-1)?.y ?? NaN, 0)} | ${f(max(pts.map((p) => p.y)), 0)} | ${f(slopePerHour(pts), 1)} |`
  const agents = [...new Set(ivs.flatMap((i) => Object.keys(i.candle)))].sort()
  const fetchRow = (name: string, xs: number[], kb: number[]) => `| ${name} | ${f(mean(xs), 1)} | ${f(max(xs), 1)} | ${f(mean(kb), 2)} | ${f(mean(kb) * 60 / 1024, 2)} |`
  const journal = samples.flatMap((s) => (s.journalBytes === undefined ? [] : [{ at: s.at, y: s.journalBytes / 1024 }]))
  const pnlFile = samples.flatMap((s) => (s.pnlSamplesBytes === undefined ? [] : [{ at: s.at, y: s.pnlSamplesBytes / 1024 }]))
  const withUsage = samples.filter((s) => s.usage)
  const share = (pred: (s: Sample) => boolean) => (withUsage.length ? `${Math.round((withUsage.filter(pred).length / withUsage.length) * 100)}%` : "—")
  const days = midnights(first, last)
  const awake = samples.filter((s) => s.awake !== null)
  const cores = [...new Set(samples.flatMap((s) => (s.core ? [s.core.pid] : [])))]
  const noCore = samples.filter((s) => !s.core).length
  const noView = samples.filter((s) => !s.views.length).length
  const lines = [
    `# Resource sample${meta.host ? `: ${meta.host}` : ""}, ${clock(first)} to ${clock(last)}`,
    "",
    `**${f(hours, 2)} hours covered**${meta.plannedHours ? ` of ${meta.plannedHours} planned` : ""}, ${samples.length} samples${meta.ended ? `, ${meta.ended}` : ""}. From \`${meta.file}\`.`,
    "",
    gaps.length ? `**Gaps over two minutes (${gaps.length}):** ${gaps.map((g) => `${clock(g.from)} to ${clock(g.to)} (${f((g.to - g.from) / 60_000, 0)} min)`).join("; ")}. Nothing was measured in them.` : "**No gap over two minutes.**",
    "",
    `- **The day's boundaries crossed:** local midnight ${days.local.length ? days.local.map(clock).join(", ") : "**not crossed**"}; 00:00 UTC ${days.utc.length ? days.utc.map(clock).join(", ") : "**not crossed**"}.`,
    `- **Kept awake:** ${awake.length ? `caffeinate held in ${awake.filter((s) => s.awake).length} of ${awake.length} samples` : "no caffeinate here (not macOS)"}.`,
    `- **The core:** ${cores.length === 1 ? "one core throughout" : `${cores.length} cores (pids ${cores.join(", ")}), so it restarted`}${noCore ? `; none running in ${noCore} samples` : ""}. **Views:** ${noView ? `none open in ${noView} samples` : "open throughout"}.`,
    ...(meta.binaryBytes ? [`- **The binary:** ${f(meta.binaryBytes / 1024 / 1024, 1)} MB.`] : []),
    "",
    "## CPU and memory",
    "",
    "CPU is a share of one core over each minute; MB is resident memory. The slope is the least-squares climb over the whole run.",
    "",
    "| Process | CPU mean | CPU p95 | CPU max | MB first | MB last | MB max | MB an hour |",
    "|---|---|---|---|---|---|---|---|",
    memRow("core", coreRss, coreCpu),
    memRow("views", viewRss, viewCpu),
    memRow("core's children", childRss, childCpu),
    "",
    "## What the core fetched",
    "",
    "A minute, over the minutes measured; MB a day is the mean carried over 24 hours.",
    "",
    "| From | Calls a minute, mean | max | KB a minute | MB a day |",
    "|---|---|---|---|---|",
    ...agents.map((a) => fetchRow(`Candle, ${a}`, ivs.flatMap((i) => (i.candle[a] ? [i.candle[a]!.calls] : [])), ivs.flatMap((i) => (i.candle[a] ? [i.candle[a]!.kb] : [])))),
    fetchRow("Hacc reads", ivs.flatMap((i) => (i.hacc ? [i.hacc.requests] : [])), ivs.flatMap((i) => (i.hacc ? [i.hacc.kb] : []))),
    fetchRow("Hacc stream (frames)", ivs.flatMap((i) => (i.stream ? [i.stream.frames] : [])), ivs.flatMap((i) => (i.stream ? [i.stream.kb] : []))),
    "",
    `**What was live** (share of samples): Candle lists beyond On Fire ${share((s) => s.usage!.reading.lists.some((l) => l !== "onfire"))}; Hacc's stream open ${share((s) => s.usage!.reading.stream === "open")}; Research reading ${share((s) => s.usage!.reading.research > 0)}. P&L planned ${f(mean(withUsage.map((s) => s.usage!.reading.pnlPerMin)), 1)} reads a minute on average.`,
    ...(samples.some((s) => s.usageError) ? ["", `The core's totals couldn't be read in ${samples.filter((s) => s.usageError).length} samples (${[...new Set(samples.flatMap((s) => (s.usageError ? [s.usageError] : [])))].slice(0, 3).join("; ")}).`] : []),
    "",
    "## Files",
    "",
    `- **The journal:** ${f(journal[0]?.y ?? NaN, 0)} KB to ${f(journal.at(-1)?.y ?? NaN, 0)} KB, ${f(slopePerHour(journal), 1)} KB an hour.`,
    `- **P&L samples:** ${f(pnlFile[0]?.y ?? NaN, 0)} KB to ${f(pnlFile.at(-1)?.y ?? NaN, 0)} KB, ${f(slopePerHour(pnlFile), 1)} KB an hour.`,
    "",
  ]
  return lines.join("\n")
}

function readSamples(file: string): Sample[] {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).flatMap((l) => {
    try {
      const s = JSON.parse(l) as Sample & { kind?: string }
      return s.kind === undefined ? [s] : []
    } catch {
      return []
    }
  })
}

/** The run's own lines: what it planned, and the binary's size once a core was seen. */
function readMeta(file: string): { host?: string; plannedHours?: number; binaryBytes?: number } {
  const out: { host?: string; plannedHours?: number; binaryBytes?: number } = {}
  for (const l of readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(l) as { kind?: string; host?: string; hours?: number; binaryBytes?: number }
      if (r.kind === "meta") Object.assign(out, r.host ? { host: r.host } : {}, r.hours ? { plannedHours: r.hours } : {})
      if (r.kind === "binary" && r.binaryBytes) out.binaryBytes = r.binaryBytes
    } catch {}
  }
  return out
}

// --- Main ---

const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export async function main(): Promise<void> {
  const again = flag("--summarise")
  if (again) {
    const file = resolve(again)
    const out = file.replace(/\.jsonl$/, "") + "-summary.md"
    writeFileSync(out, summarise(readSamples(file), { file, ...readMeta(file), ended: "summarised again" }))
    console.log(`written: ${out}`)
    process.exit(0)
  }
  const hours = Number(flag("--hours") ?? 12)
  const everyMs = Number(flag("--every") ?? 60) * 1000
  if (!(hours > 0) || !(everyMs >= 5000)) throw new Error("--hours takes a positive number, --every at least 5 seconds")
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")
  const file = resolve(flag("--out") ?? `resource-sample-${hostname().split(".")[0]}-${stamp}.jsonl`)
  const summaryFile = file.replace(/\.jsonl$/, "") + "-summary.md"
  const p = paths(process.env)
  const startedAt = Date.now()
  const endAt = startedAt + hours * 3_600_000

  // Held awake for as long as this process lives (macOS). caffeinate ends by itself when it does.
  let caffeinate: ReturnType<typeof spawn> | undefined
  if (platform() === "darwin") {
    caffeinate = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore", detached: false })
    caffeinate.on("error", () => (caffeinate = undefined))
  }
  const awake = () => (caffeinate ? caffeinate.exitCode === null && caffeinate.signalCode === null : platform() === "darwin" ? false : null)

  let binaryBytes: number | undefined
  let conn: CoreConnection | undefined
  let connCore: number | undefined
  const usage = async (pid: number | undefined): Promise<{ usage?: Sample["usage"]; usageError?: string }> => {
    if (pid === undefined) return { usageError: "no core running" }
    try {
      if (!conn || connCore !== pid) {
        conn?.close()
        conn = (await connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName: SAMPLER_CLIENT })).connection
        connCore = pid
      }
      return { usage: (await conn.request("core.usage", {})) as Sample["usage"] }
    } catch (error) {
      conn?.close()
      conn = undefined
      return { usageError: error instanceof Error ? error.message : String(error) }
    }
  }

  const sample = async (): Promise<Sample> => {
    const procs = parsePs(spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8" }).stdout ?? "")
    const pid = corePid(p.lock)
    const core = procs.find((q) => q.pid === pid)
    const kids = core ? descendants(procs, core.pid) : []
    const views = procs.filter((q) => q.pid !== pid && q.pid !== process.pid && !kids.includes(q) && isView(q.command))
    if (core && binaryBytes === undefined) {
      const bin = core.command.split(/\s+/)[0]!
      binaryBytes = existsSync(bin) && !bin.endsWith("bun") ? statSync(bin).size : undefined
      if (binaryBytes) appendFileSync(file, `${JSON.stringify({ kind: "binary", binaryBytes })}\n`)
    }
    const u = await usage(core?.pid)
    return {
      at: Date.now(),
      awake: awake(),
      ...(core ? { core: { pid: core.pid, rssKb: core.rssKb, cpuS: core.cpuS } } : {}),
      children: { count: kids.length, rssKb: kids.reduce((n, k) => n + k.rssKb, 0), cpuS: kids.reduce((n, k) => n + k.cpuS, 0) },
      views: views.map((v) => ({ pid: v.pid, rssKb: v.rssKb, cpuS: v.cpuS, command: v.command.slice(0, 80) })),
      ...u,
      ...(size(p.journal) !== undefined ? { journalBytes: size(p.journal)! } : {}),
      ...(size(p.pnlSamples) !== undefined ? { pnlSamplesBytes: size(p.pnlSamples)! } : {}),
    }
  }

  // The user it ran as, on its machine: a test machine has a user for each pass.
  const host = `${userInfo().username}@${hostname().split(".")[0]!}`
  appendFileSync(file, `${JSON.stringify({ kind: "meta", host, platform: platform(), arch: process.arch, hours, everyMs, startedAt, configDir: p.configDir })}\n`, { mode: 0o600 })
  const summary = (ended?: string) => writeFileSync(summaryFile, summarise(readSamples(file), { file, host, plannedHours: hours, ...(binaryBytes ? { binaryBytes } : {}), ...(ended ? { ended } : {}) }))
  let stopping = false
  const finish = (why: string) => {
    if (stopping) return
    stopping = true
    summary(why)
    conn?.close()
    caffeinate?.kill()
    console.log(`\n${why}. Written: ${file}\n         ${summaryFile}`)
    process.exit(0)
  }
  process.on("SIGINT", () => finish("stopped by ctrl-c"))
  process.on("SIGTERM", () => finish("stopped"))
  process.on("SIGHUP", () => finish("its terminal closed"))

  console.log(`Sampling every ${everyMs / 1000} s until ${new Date(endAt).toLocaleString()} (${hours} h)${caffeinate ? ", holding the Mac awake" : ""}.\n  ${file}\n  ${summaryFile} (written every hour and at the end)`)
  let lastSummary = startedAt
  for (let next = startedAt; ; ) {
    const s = await sample()
    appendFileSync(file, `${JSON.stringify(s)}\n`)
    const viewMb = s.views.reduce((n, v) => n + v.rssKb, 0) / 1024
    process.stdout.write(`\r${new Date(s.at).toLocaleTimeString()}  core ${s.core ? `${(s.core.rssKb / 1024).toFixed(0)} MB` : "none"}  views ${s.views.length ? `${viewMb.toFixed(0)} MB` : "none"}${s.usageError ? `  (${s.usageError})` : ""}   `)
    if (s.at - lastSummary >= 3_600_000) {
      summary("still running")
      lastSummary = s.at
    }
    next += everyMs
    if (next > endAt) break
    // Sleep to the next slot; a slot missed (the machine slept) shows as a gap, not as a burst.
    while (next < Date.now()) next += everyMs
    await Bun.sleep(next - Date.now())
  }
  finish(`finished after ${hours} h`)
}

if (import.meta.main) await main()
