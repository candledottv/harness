// The mode the user last picked (paper or live) survives a restart. It's
// kept in `state/mode.json` (0600), written whenever the mode changes. config.toml's `mode` is only
// where a core starts when nothing has been picked yet, such as a fresh install. A file that's missing
// or unreadable falls back to the config's mode.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import type { Mode } from "../config"

export function readSavedMode(path: string): Mode | undefined {
  try {
    const mode = (JSON.parse(readFileSync(path, "utf8")) as { mode?: unknown }).mode
    return mode === "paper" || mode === "live" ? mode : undefined
  } catch {
    return undefined
  }
}

/** The mode a core starts in, and where it came from. */
export function startingMode(path: string, configured: Mode): { mode: Mode; from: "saved" | "config" } {
  const saved = readSavedMode(path)
  return saved ? { mode: saved, from: "saved" } : { mode: configured, from: "config" }
}

export async function saveMode(path: string, mode: Mode, now: number): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
  await writeFile(temp, `${JSON.stringify({ mode, at: new Date(now).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

/**
 * The agent last made active survives a restart too (otherwise a reopened view comes up on config.toml's
 * agent, and the person's next turns go to it unnoticed). Kept in `state/active.json`; one no longer
 * configured falls back to config.toml's `activeAgent`.
 */
export function startingAgent(path: string, configured: string, agents: readonly string[]): string {
  try {
    const agent = (JSON.parse(readFileSync(path, "utf8")) as { agent?: unknown }).agent
    return typeof agent === "string" && agents.includes(agent) ? agent : configured
  } catch {
    return configured
  }
}

export async function saveAgent(path: string, agent: string, now: number): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
  await writeFile(temp, `${JSON.stringify({ agent, at: new Date(now).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
  await chmod(temp, 0o600)
  await rename(temp, path)
}
