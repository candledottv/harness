// Each agent's engine and model. The choice last made survives a restart, as the
// mode does: it's kept in `state/engine.json` (0600), written whenever one changes.
// config.toml's `[engine] default` and `model` are only where an agent starts when nothing has been
// chosen for it. A file that's missing or unreadable, or an entry naming no engine we know, falls back
// to the config.
//
// The agent's preset is kept in the same file, under `presets`: config's
// `[agents.<name>] preset` is where it starts (Quant when unset), and the one last picked wins after that.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import { type EngineId, isEngineId } from "../engine/engine"
import { DEFAULT_PRESET, isPreset, type Preset } from "../engine/preset"

export interface EngineChoice {
  engine: EngineId
  /** Undefined runs the harness's own default. */
  model?: string
}

function parseChoice(raw: unknown): EngineChoice | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const { engine, model } = raw as { engine?: unknown; model?: unknown }
  if (!isEngineId(engine)) return undefined
  return typeof model === "string" && model.length > 0 ? { engine, model } : { engine }
}

export class EngineState {
  private constructor(
    private readonly path: string,
    private readonly fallback: EngineChoice,
    private readonly saved: Map<string, EngineChoice>,
    private readonly presets: Map<string, Preset>,
  ) {}

  static open(path: string, fallback: EngineChoice): EngineState {
    const saved = new Map<string, EngineChoice>()
    const presets = new Map<string, Preset>()
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as { agents?: unknown; presets?: unknown }
      if (file.agents && typeof file.agents === "object") {
        for (const [agent, raw] of Object.entries(file.agents)) {
          const choice = parseChoice(raw)
          if (choice) saved.set(agent, choice)
        }
      }
      if (file.presets && typeof file.presets === "object") {
        for (const [agent, raw] of Object.entries(file.presets)) if (isPreset(raw)) presets.set(agent, raw)
      }
    } catch {
      // Missing or unreadable: every agent starts on the config's default.
    }
    return new EngineState(path, parseChoice(fallback) ?? { engine: "claude-code" }, saved, presets)
  }

  get(agent: string): EngineChoice & { from: "saved" | "config" } {
    const saved = this.saved.get(agent)
    return saved ? { ...saved, from: "saved" } : { ...this.fallback, from: "config" }
  }

  async set(agent: string, choice: EngineChoice, now: number): Promise<void> {
    const parsed = parseChoice(choice)
    if (!parsed) throw new Error(`Not an engine choice: ${JSON.stringify(choice)}`)
    this.saved.set(agent, parsed)
    await this.write(now)
  }

  /** The agent's preset: the one last picked, else config's (`configured`), else Quant. */
  preset(agent: string, configured?: Preset): { preset: Preset; from: "saved" | "config" } {
    const saved = this.presets.get(agent)
    return saved ? { preset: saved, from: "saved" } : { preset: configured ?? DEFAULT_PRESET, from: "config" }
  }

  async setPreset(agent: string, preset: Preset, now: number): Promise<void> {
    if (!isPreset(preset)) throw new Error(`Not a preset: ${JSON.stringify(preset)}`)
    this.presets.set(agent, preset)
    await this.write(now)
  }

  private async write(now: number): Promise<void> {
    const temp = `${this.path}.tmp-${randomBytes(6).toString("base64url")}`
    const body = { agents: Object.fromEntries(this.saved), ...(this.presets.size ? { presets: Object.fromEntries(this.presets) } : {}), at: new Date(now).toISOString() }
    await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.path)
  }
}
