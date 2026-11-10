// A scripted stand-in for Claude Code, for tests through a real core: each engine run plays the next
// script, and cancel ends the run with Claude Code's own error. `scriptedEngine` wraps one as a whole
// engine behind the seam, registered by id beside or in place of the real ones.
import { ENGINE_LABELS, type Engine, type EngineCapabilities, type EngineCheck, type EngineId, type EngineModel, type EngineTurn } from "../src/engine/engine"
import type { EngineEvent, Turn } from "../src/engine/events"
import { eventQueue } from "../src/engine/spawn"

export type Script = (turn: EngineTurn, push: (e: EngineEvent) => void, cancelled: Promise<void>) => Promise<void>

/** A stand-in engine: each run plays the next script; cancel ends the run with Claude Code's own error. */
export function scripted(scripts: Script[]) {
  const runs: EngineTurn[] = []
  const start = (turn: EngineTurn): Turn => {
    runs.push(turn)
    const script = scripts[Math.min(runs.length - 1, scripts.length - 1)]!
    const q = eventQueue()
    let cancel!: () => void
    const cancelled = new Promise<void>((resolve) => (cancel = resolve))
    let over = false
    const finish = (e?: EngineEvent) => {
      if (over) return
      over = true
      if (e) q.push(e)
      q.end()
    }
    void script(turn, (e) => !over && q.push(e), cancelled).then(() => finish())
    void cancelled.then(() => finish({ type: "error", message: "Claude Code turn cancelled" }))
    return {
      events: q.iterate(),
      cancel: async () => cancel(),
    }
  }
  return { start, runs }
}

/** A whole engine behind the seam, each run playing the next script. */
export function scriptedEngine(
  id: EngineId,
  scripts: Script[],
  o: { check?: EngineCheck; models?: EngineModel[]; capabilities?: Partial<EngineCapabilities>; explain?: (m: string | undefined) => string } = {},
) {
  const s = scripted(scripts)
  const engine: Engine = {
    id,
    label: ENGINE_LABELS[id],
    minVersion: "1.0.0",
    checkedVersion: "1.2.3",
    capabilities: () => ({ webSearch: true, webFetch: true, files: "own", shellList: true, deltas: true, ...o.capabilities }),
    check: async () => o.check ?? { ok: true, version: "1.2.3" },
    models: async () => o.models ?? [{ id: `${id}-model`, label: `${ENGINE_LABELS[id]} model`, isDefault: true }],
    start: (turn) => s.start(turn),
    explain: o.explain ?? ((m) => m ?? `${ENGINE_LABELS[id]} ended without a reply.`),
  }
  return { engine, runs: s.runs }
}
