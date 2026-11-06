// The model picker (ctrl-g, or the agent pane's chip): the agent's preset first, Quant or Trader, then each
// engine as a heading, with whether it's installed and signed in, its version against the minimum and its
// gaps in a line, and its models under it, the harness's default first. Typing searches, as the palette does.
// Enter or a click picks for the agent in view, from its next turn; Esc leaves it as it was. An engine that
// can't run here is shown with what to do, and can't be picked. The lists come from the core, read in the
// background; one not yet answered shows "reading…". The agent can't switch engines: it's the person's
// choice, since it spends their subscription or credit.
import type { MouseEvent } from "@opentui/core"
import { ENGINE_IDS, ENGINE_LABELS, type EngineCapabilities, type EngineId, type EngineModel } from "../../engine/engine"
import { gapsOf } from "../../engine/gaps"
import { type Preset, PRESET_DESCRIPTIONS, PRESET_LABELS, PRESETS } from "../../engine/preset"
import { SHELL_ON_NOTE, shellFor, type ToolSettings } from "../../engine/tools"
import { usePointer } from "../chip"
import { wrap } from "../format"
import { C, fit, OVERLAY_Z } from "../theme"

export { gapsOf }

/** What the `engine` topic says (docs.candle.tv/harness/developers/attach-protocol). */
export interface EngineTopic {
  agents: Record<string, AgentEngine>
  engines: Partial<Record<EngineId, EngineInfo>>
}

export interface AgentEngine {
  engine: EngineId
  model?: string
  from: "saved" | "config"
  /** Its preset: Quant unless config or the person picked Trader. */
  preset?: Preset
  presetFrom?: "saved" | "config"
  /** What the agent's last turn ran on. */
  last?: { engine: EngineId; model: string | null; answeredModel: string | null }
  /** Its shell and tool settings, when config sets any. */
  tools?: ToolSettings
}

export interface EngineInfo {
  label: string
  minVersion: string
  check: { ok: boolean; version?: string; message?: string } | null
  capabilities: EngineCapabilities
  signedIn: boolean | null
  signIn?: string
  defaultModel?: string
  needsModel?: boolean
  modelsReadAt: number | null
}

/** One engine's models as the core last answered, and whether a fresh read is out. */
export interface ModelsRead {
  models: EngineModel[]
  notes: string[]
  reading: boolean
  error?: string
}

export type PickerRow =
  /** The preset section's heading. */
  | { kind: "presets"; text: string }
  | { kind: "preset"; preset: Preset; text: string; current: boolean }
  | { kind: "engine"; engine: EngineId; text: string; can: boolean }
  /** A line under a heading: its gaps, a held-back sign-in, what to do, "reading…". */
  | { kind: "info"; engine: EngineId; text: string; tone: "dim" | "look" }
  /** `model` undefined runs the harness's own default. */
  | { kind: "model"; engine: EngineId; model?: string; text: string; current: boolean }

/** Whether the engine can be picked here: checked, and not known to be signed out. */
export const canRun = (info: EngineInfo | undefined): boolean => info?.check?.ok === true && info.signedIn !== false

function heading(id: EngineId, info: EngineInfo): string {
  const version = info.check?.version ? ` ${info.check.version} (needs ${info.minVersion}+)` : ""
  if (!info.check) return `${info.label} · checking…`
  if (!info.check.ok) return `${info.label}${version} · can't run here`
  const signed = info.signedIn === true ? (info.needsModel ? " · ready" : " · signed in") : info.signedIn === false ? (info.needsModel ? " · no models" : " · not signed in") : ""
  return `${info.label}${version}${signed}`
}

/** What a model row is called: its label, and "default" for the harness's own. */
const modelText = (m: EngineModel): string => `${m.label === m.id ? m.id : `${m.label} · ${m.id}`}${m.isDefault ? " · default" : ""}`

/**
 * The picker's rows for `agent`: every engine in the build, in the seam's order, with its models under
 * it when it can run. `query` narrows to the models (and engines) whose words hold every word typed.
 */
export function pickerRows(topic: EngineTopic | undefined, lists: Partial<Record<EngineId, ModelsRead>>, query: string, agent: string, platform: NodeJS.Platform = process.platform): PickerRow[] {
  if (!topic) return []
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  const choice = topic.agents[agent]
  const out: PickerRow[] = []
  // The preset, above the engines, under its own heading; search finds it by its name or "preset".
  const presets = PRESETS.filter((p) => matches(`preset ${PRESET_LABELS[p]}`))
  if (presets.length && choice) {
    out.push({ kind: "presets", text: "preset" })
    for (const p of presets) out.push({ kind: "preset", preset: p, text: `${PRESET_LABELS[p]} · ${PRESET_DESCRIPTIONS[p]}`, current: (choice.preset ?? "quant") === p })
  }
  for (const id of ENGINE_IDS) {
    const info = topic.engines[id]
    if (!info) continue
    const can = canRun(info)
    const read = lists[id]
    // The harness's default first; an engine whose list names none runs its own when nothing is picked,
    // unless it needs a model by name (OpenCode, Pi).
    const listed = read ? [...read.models.filter((m) => m.isDefault), ...read.models.filter((m) => !m.isDefault)] : []
    const ownDefault = can && !info.needsModel && !listed.some((m) => m.isDefault) ? [{ id: undefined, model: undefined, text: `${info.label}'s own default` }] : []
    // The default is picked as no model, so the agent follows the user's own default as it changes.
    const models = [...ownDefault, ...listed.map((m) => ({ id: m.id as string | undefined, model: m.isDefault ? undefined : m.id, text: modelText(m) }))]
    const engineHit = matches(`${info.label} ${id}`)
    const shown = can ? models.filter((m) => engineHit || matches(`${info.label} ${m.text}`)) : []
    if (words.length && !engineHit && shown.length === 0) continue
    out.push({ kind: "engine", engine: id, text: heading(id, info), can })
    if (!can) {
      // The core looks on the PATH it started with: one installed since, into a folder added to the PATH later, isn't seen.
      const missing = info.check && !info.check.ok && info.check.version === undefined && /isn't installed/.test(info.check.message ?? "")
      const fix = !info.check ? undefined : missing ? `${info.check.message} Installed since the app started? Restart it from a shell where ${id === "claude-code" ? "claude" : id} runs.` : !info.check.ok ? info.check.message : info.signIn ? `${info.needsModel ? "no models here" : "sign in"}: ${info.signIn}` : "not signed in"
      if (fix) out.push({ kind: "info", engine: id, text: fix, tone: "look" })
      continue
    }
    const gaps = gapsOf(id, info.capabilities, platform, choice?.tools)
    if (gaps.length) out.push({ kind: "info", engine: id, text: gaps.join(" · "), tone: "dim" })
    // The shell on this engine for this agent: said plainly, in amber.
    const shell = choice?.tools ? shellFor(choice.tools, info.capabilities) : "off"
    if (shell !== "off") out.push({ kind: "info", engine: id, text: `shell on${shell === "everything" ? "" : ` for ${shell.join(", ")}`}: ${SHELL_ON_NOTE}`, tone: "look" })
    for (const note of read?.notes ?? []) out.push({ kind: "info", engine: id, text: note, tone: "dim" })
    if (read?.error) out.push({ kind: "info", engine: id, text: `couldn't read its models: ${read.error}`, tone: "look" })
    if (!read || (read.reading && listed.length === 0)) out.push({ kind: "info", engine: id, text: "reading…", tone: "dim" })
    else if (listed.length === 0 && !read.error && info.signIn) out.push({ kind: "info", engine: id, text: `no models here: ${info.signIn}`, tone: "look" })
    for (const m of shown) {
      const current = choice?.engine === id && (choice.model === undefined ? m.model === undefined : choice.model === m.id)
      out.push({ kind: "model", engine: id, ...(m.model !== undefined ? { model: m.model } : {}), text: m.text, current })
    }
  }
  return out
}

export type PickableRow = Extract<PickerRow, { kind: "model" | "preset" }>

/** The rows Enter and the arrows move through: the presets, and models of engines that can run. */
export const pickable = (rows: readonly PickerRow[]): PickableRow[] => rows.filter((r): r is PickableRow => r.kind === "model" || r.kind === "preset")

/** Where the picker opens: on the agent's model now, else the first model, else the first row. */
export function startIndex(rows: readonly PickerRow[]): number {
  const all = pickable(rows)
  const current = all.findIndex((r) => r.kind === "model" && r.current)
  return Math.max(0, current >= 0 ? current : all.findIndex((r) => r.kind === "model"))
}

/**
 * Whether the agent's next turn can't run until a model is picked: its engine needs one by name, none is
 * picked, and the user's own harness has no default (a Pi user with several models and none set).
 */
export function needsModel(topic: EngineTopic | undefined, agent: string): boolean {
  const choice = topic?.agents[agent]
  const info = choice ? topic?.engines[choice.engine] : undefined
  return !!choice && !!info?.needsModel && canRun(info) && choice.model === undefined && info.defaultModel === undefined && info.modelsReadAt !== null
}

/** A heading drawn as a rule across the pane: cut only when its words don't fit. */
export function ruleLine(text: string, width: number): string {
  const head = `── ${text} `
  return head.length >= width ? fit(head, width) : head + "─".repeat(width - head.length)
}

export interface EnginePickerProps {
  agent: string
  rows: readonly PickerRow[]
  query: string
  index: number
  width: number
  height: number
  onPick: (engine: EngineId, model: string | undefined) => void
  onPickPreset: (preset: Preset) => void
  onScroll: (delta: number) => void
}

export function EnginePicker(props: EnginePickerProps) {
  const pointer = usePointer()
  // Over everything but the status bar and the input line, as the palette.
  const width = props.width
  const height = props.height - 2
  const inner = width - 4
  const models = pickable(props.rows)
  const selected = models[props.index]
  // A long line under a heading (a held-back sign-in, what to do) wraps rather than being cut at 80 columns.
  const lines = props.rows.flatMap((r): PickerRow[] => (r.kind === "info" ? wrap(r.text, Math.max(10, inner - 3)).map((text) => ({ ...r, text })) : [r]))
  const rows = Math.max(1, height - 4)
  // The presets hold the top while the engines' models scroll under them: opened on a model deep in a
  // long list (744 on OpenRouter), the presets had scrolled out of sight.
  const presets = lines.findIndex((r) => r.kind !== "presets" && r.kind !== "preset")
  const pinned = lines.length > rows && presets > 0 ? lines.slice(0, presets) : []
  const body = lines.slice(pinned.length)
  const room = Math.max(1, rows - pinned.length)
  const at = selected ? body.indexOf(selected) : 0
  const start = Math.max(0, Math.min(body.length - room, at - Math.floor(room / 2)))
  const shown = [...pinned, ...body.slice(start, start + room)]
  const keys = inner >= 100 ? `↑/↓ · type to search · ⏎ picks for ${props.agent}'s next turn · esc leaves it as it was` : "↑/↓ · type to search · ⏎ picks · esc leaves it as it was"
  const modelCount = models.filter((r) => r.kind === "model").length
  const count = `${modelCount} model${modelCount === 1 ? "" : "s"}`
  return (
    <box
      position="absolute" zIndex={OVERLAY_Z}
      left={0}
      top={1}
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={C.focus}
      backgroundColor={C.term}
      titleColor={C.head}
      title={` preset, engine and model for ${props.agent} `}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={(e: MouseEvent) => props.onScroll(e.scroll?.direction === "up" ? -1 : 1)}
    >
      <box flexDirection="row" height={1}>
        <text fg={C.hi}>{"search › "}</text>
        <text fg={C.hi}>{fit(`${props.query}▏`, inner - 10 - count.length - 1)}</text>
        <box flexGrow={1} />
        <text fg={C.dim}>{count}</text>
      </box>
      {shown.map((row, i) => {
        if (row.kind === "presets") {
          return (
            <text key="presets" fg={C.head}>
              {ruleLine(row.text, inner)}
            </text>
          )
        }
        if (row.kind === "engine") {
          return (
            <text key={`e-${row.engine}`} fg={row.can ? C.head : C.dim}>
              {ruleLine(row.text, inner)}
            </text>
          )
        }
        if (row.kind === "info") {
          return (
            <text key={`i-${row.engine}-${i}`} fg={row.tone === "look" ? C.look : C.dim}>
              {fit(`   ${row.text}`, inner)}
            </text>
          )
        }
        // A preset or a model: a click picks it, as Enter does.
        const on = row === selected
        const key = row.kind === "preset" ? `p-${row.preset}` : `m-${row.engine}-${row.model ?? ""}-${i}`
        return (
          <box key={key} flexDirection="row" height={1} backgroundColor={on ? C.sel : C.term} onMouseDown={() => (row.kind === "preset" ? props.onPickPreset(row.preset) : props.onPick(row.engine, row.model))} {...pointer}>
            <text fg={on ? C.hi : C.dim}>{on ? "▸ " : "  "}</text>
            <text fg={row.current ? C.good : C.dim}>{row.current ? "● " : "  "}</text>
            <text fg={C.ctl}>{fit(row.text, inner - 4)}</text>
          </box>
        )
      })}
      <box flexGrow={1} />
      <text fg={C.dim}>{fit(keys, inner)}</text>
    </box>
  )
}
