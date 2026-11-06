// What an engine can't do here, in words: the picker shows it under each
// engine's heading, and the doctor beside its version.
import { ENGINE_LABELS, type EngineCapabilities, type EngineId } from "./engine"
import type { ToolSettings } from "./tools"

const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux" }

/**
 * What an engine can't do here, in a line. A shell list meaning off is said only to an agent that has one.
 */
export function gapsOf(id: EngineId, caps: EngineCapabilities, platform: NodeJS.Platform = process.platform, tools?: ToolSettings): string[] {
  const label = ENGINE_LABELS[id]
  return [
    !caps.webSearch && `no web search on ${label}`,
    !caps.webFetch && "no web fetch",
    caps.files === "none" && `no file tools on ${PLATFORMS[platform] ?? platform}`,
    !caps.shellList && Array.isArray(tools?.shell) && "a shell list means off",
    // How this engine's shell differs, said to an agent whose shell is on (docs.candle.tv/harness/engines).
    id === "grok" && caps.shellList && Array.isArray(tools?.shell) && "Grok also runs its own read-only commands (ls, cat, grep…), and can't list rm, chmod, kill or git push",
    id === "codex" && tools?.shell === "everything" && "Codex's shell writes only in the research folder, with no network",
    !caps.deltas && "replies arrive whole",
  ].filter((g): g is string => typeof g === "string")
}
