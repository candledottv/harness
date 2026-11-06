// What an engine adapter turns its harness's output into, so the rest of the app
// never sees a harness-specific format.
import type { Source } from "./gate"

export type EngineEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** `failed` when the harness marked the call an error: a gate's refusal, a tool that failed. */
  | { type: "tool_result"; id: string; name: string; output: string; source: Source; failed?: true }
  | { type: "done"; text: string }
  | { type: "error"; message: string }
  /** The model that answered, where the harness's stream names it (all but Codex). */
  | { type: "model"; model: string }

export type Turn = { events: AsyncIterable<EngineEvent>; cancel(): Promise<void> }

/**
 * A `model` event for each model the stream names that it hasn't named before, so a parser reports the
 * answering model once. `skip` holds the stand-ins a harness names when no model answered.
 */
export function modelOnce(skip: readonly string[] = []): (model: unknown) => EngineEvent[] {
  let last: string | undefined
  return (model) => {
    if (typeof model !== "string" || model === "" || skip.includes(model) || model === last) return []
    last = model
    return [{ type: "model", model }]
  }
}

/** Where a tool's result came from, for the address gate's labels. */
export function sourceOf(tool: string): Source {
  const t = tool.toLowerCase()
  // The core's own tools come through the Candle MCP server, but what they return is the Candle Harness's: the
  // agent's notes (research_*), its past turns and the person's messages (harness_history), skill files
  // (skill_*), and the Candle Harness's state, which can echo what the agent itself passed in (a pin, a wallet's
  // name). None is Candle's data, so they count as files, by every engine's naming of them.
  if (/^(?:mcp__candle__|candle__?|candle\.|candle\/)?(?:research|harness|skill)_[a-z_]+$/.test(t)) return "file"
  // Hacc's reads come through the same server, but the person should know which data showed an address
  // (Hacc's mints were once labelled "from candle"). Pi names them bare.
  if (/(^|_)hacc_[a-z]+$/.test(t)) return "hacc"
  if (t.startsWith("mcp__") || t.startsWith("candle_") || t.startsWith("candle.") || t.startsWith("candle/")) return "candle"
  if (/web|fetch|search|browse/.test(t)) return "web"
  if (/bash|shell|exec|command|terminal/.test(t)) return "shell"
  return "file"
}
