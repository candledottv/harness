// This build's engines, each binary from config: built in one place so the core and
// the doctor run the same harnesses the same way.
import { join } from "node:path"
import type { Config } from "../config"
import { claudeEngine } from "./claude"
import { codexEngine } from "./codex"
import { type Engine, type EngineId, engineRegistry } from "./engine"
import { grokEngine } from "./grok"
import { opencodeEngine } from "./opencode"
import { piEngine } from "./pi"

/** This program, as an engine's MCP config runs it: the compiled binary itself, or Bun running main.ts. */
export function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, join(import.meta.dir, "../main.ts")]
}

export function buildEngines(
  config: Pick<Config, "engine">,
  /** Where turns' private homes go, and the state folder OpenCode's kept config folder sits in. */
  dirs: { homesDir: string; stateDir: string },
  env: Record<string, string | undefined>,
): Map<EngineId, Engine> {
  return new Map(
    engineRegistry([
      claudeEngine(config.engine.claude.path),
      codexEngine(config.engine.codex.path, { homesDir: dirs.homesDir, ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}) }),
      grokEngine(config.engine.grok.path, { homesDir: dirs.homesDir, ...(env.GROK_HOME ? { grokHome: env.GROK_HOME } : {}) }),
      opencodeEngine(config.engine.opencode.path, { folder: join(dirs.stateDir, "opencode"), xdg: env }),
      piEngine(config.engine.pi.path, { homesDir: dirs.homesDir, ...(env.PI_CODING_AGENT_DIR ? { agentDir: env.PI_CODING_AGENT_DIR } : {}) }),
    ]),
  )
}
