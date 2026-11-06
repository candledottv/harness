// Each engine's models, read in the background: when the core starts, every 10
// minutes, and when the picker opens. Never on a turn's path. A read in flight is shared, and a list
// read in the last 30 s is answered as it is, so opening the picker twice doesn't read twice.
//
// An engine's `models()` also sets its `defaultModel()` and `modelNotes()` as a side effect, so a turn
// with no model picked runs the default by name once any read has answered.
import type { Engine, EngineId, EngineModel } from "../engine/engine"

export const MODELS_EVERY_MS = 10 * 60_000
export const FRESH_FOR_MS = 30_000

export interface ModelList {
  models: EngineModel[]
  /** Models held back (a Claude, ChatGPT or Grok subscription runs only through its own harness), with the harness to use instead. */
  notes: string[]
  readAt: number
  /** The read failed: its words, and the last good list (if any) kept. */
  error?: string
}

export class EngineModels {
  private readonly lists = new Map<EngineId, ModelList>()
  private readonly reading = new Map<EngineId, Promise<ModelList>>()

  constructor(
    private readonly engines: ReadonlyMap<EngineId, Engine>,
    private readonly env: () => Record<string, string>,
    private readonly now: () => number,
    /** Called after each read lands, so the `engine` topic can say when. */
    private readonly onRead: (id: EngineId) => void = () => {},
  ) {}

  /** The last list read, if any. */
  get(id: EngineId): ModelList | undefined {
    return this.lists.get(id)
  }

  isReading(id: EngineId): boolean {
    return this.reading.has(id)
  }

  /**
   * The list: the last one read, unless `fresh` asks for one newer than 30 s, or `force` (the timer)
   * for a new read whatever the age. A read already in flight is joined.
   */
  async read(id: EngineId, o: { fresh?: boolean; force?: boolean } = {}): Promise<ModelList> {
    const last = this.lists.get(id)
    if (last && !last.error && !o.force && (!o.fresh || this.now() - last.readAt < FRESH_FOR_MS)) return last
    const inFlight = this.reading.get(id)
    if (inFlight) return inFlight
    const engine = this.engines.get(id)
    if (!engine) throw new Error(`No engine ${id} in this build`)
    const p = (async (): Promise<ModelList> => {
      try {
        const models = await engine.models(this.env())
        return { models, notes: engine.modelNotes?.() ?? [], readAt: this.now() }
      } catch (error) {
        return { models: last?.models ?? [], notes: last?.notes ?? [], readAt: this.now(), error: error instanceof Error ? error.message : String(error) }
      }
    })()
    this.reading.set(id, p)
    try {
      const list = await p
      this.lists.set(id, list)
      return list
    } finally {
      this.reading.delete(id)
      this.onRead(id)
    }
  }
}
