// The Candle sign-in onboarding uses: the CLI profile the Candle Harness acts as, recorded
// as `candle.profile` in config.toml and handed to every `candle` run as CANDLE_PROFILE, so a later switch
// of the CLI's active profile never moves the Candle Harness's owner steps to another account while its agents' keys
// stay on the first. A new profile signs in on Candle's production host, by the CLI's own device code.
//
// Read here: `candle profile list --json` (each profile's name, whether it's active, its account and host;
// never its key, which is dropped) and `candle auth status --json`. Written here: one line of config.toml,
// added, never changed: a config that names another profile is the person's, and is left as it is.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { ConfigError, isProfileName, parseConfig } from "../config"
import { isAddressShaped } from "../core/wallet-names"
import type { Paths } from "../paths"

/** Candle's production API, as its docs name it ("production is https://api.alpha.candle.tv"). A new profile needs `--api-url` from CLI 0.13.5. */
export const PRODUCTION_API = "https://api.alpha.candle.tv"
/** What onboarding names a new profile, then `candle-harness-2`, …: never one that's on the machine. */
export const NEW_PROFILE = "candle-harness"

export interface ProfileRow {
  name: string
  active: boolean
  /** The account's wallet, where the CLI has it cached. */
  account?: string
  apiUrl?: string
}

/** `profile list --json`'s rows, kept to what onboarding shows: a key prefix is never kept. */
export function profilesFrom(run: { exitCode: number; json: unknown } | undefined): ProfileRow[] | undefined {
  if (!run || run.exitCode !== 0 || !Array.isArray(run.json)) return undefined
  return (run.json as Record<string, unknown>[]).flatMap((r) => {
    if (!r || typeof r !== "object" || typeof r.name !== "string" || !isProfileName(r.name)) return []
    const account = typeof r.account === "string" && isAddressShaped(r.account) ? r.account : undefined
    const apiUrl = typeof r.apiUrl === "string" && /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?\/?$/.test(r.apiUrl) ? r.apiUrl : undefined
    return [{ name: r.name, active: r.active === true, ...(account ? { account } : {}), ...(apiUrl ? { apiUrl } : {}) }]
  })
}

/** The first of `candle-harness`, `candle-harness-2`, … that no profile on the machine has. */
export function newProfileName(existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  if (!taken.has(NEW_PROFILE)) return NEW_PROFILE
  for (let n = 2; ; n++) if (!taken.has(`${NEW_PROFILE}-${n}`)) return `${NEW_PROFILE}-${n}`
}

/** What Candle TUI 0.2's setup named its profile. */
export const OLD_PROFILE = "candle-tui"

/**
 * The profile setup signs in with when config.toml names none: 0.2's `candle-tui` when it's on the machine and
 * no `candle-harness` one is (the same account, signed in again rather than a second profile beside it);
 * otherwise a new name.
 */
export function setupProfile(existing: readonly (string | Pick<ProfileRow, "name" | "apiUrl">)[]): { profile: string; reused: boolean; warning?: string } {
  const rows = existing.map((r) => (typeof r === "string" ? { name: r } : r))
  const names = rows.map((r) => r.name.toLowerCase())
  const harnessOne = names.some((n) => n === NEW_PROFILE || new RegExp(`^${NEW_PROFILE}-\\d+$`).test(n))
  if (!harnessOne && names.includes(OLD_PROFILE)) {
    // Signed in again as it is, so it keeps its own host: said when that isn't Candle's production API.
    const host = rows.find((r) => r.name.toLowerCase() === OLD_PROFILE)?.apiUrl?.replace(/\/+$/, "")
    const warning = host === PRODUCTION_API ? undefined : `The profile candle-tui (from Candle TUI 0.2) is signed in again as it is, and it names ${host ? host : "no host Candle's CLI shows"}, not Candle's production API (${PRODUCTION_API}). If that isn't the account you mean, quit and make a new profile with candle auth login --profile candle-harness --api-url ${PRODUCTION_API}.`
    return { profile: OLD_PROFILE, reused: true, ...(warning ? { warning } : {}) }
  }
  return { profile: newProfileName(rows.map((r) => r.name)), reused: false }
}

/** The profile config.toml names, if it parses that far; undefined when there's no file or no `candle.profile`. */
export function recordedProfile(p: Paths): string | undefined {
  if (!existsSync(p.configFile)) return undefined
  try {
    return parseConfig(readFileSync(p.configFile, "utf8"), p.configFile).config.candle.profile
  } catch (error) {
    if (error instanceof ConfigError && error.code === "no_agents") return profileLine(readFileSync(p.configFile, "utf8"))
    return undefined
  }
}

/** `profile = "…"` inside the `[candle]` table, read by hand when the rest of the file has no agents yet. */
function profileLine(text: string): string | undefined {
  let inCandle = false
  for (const line of text.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line)
    if (header) {
      inCandle = header[1]!.trim() === "candle"
      continue
    }
    const m = inCandle ? /^\s*profile\s*=\s*"([^"]*)"\s*(#.*)?$/.exec(line) : null
    if (m && isProfileName(m[1])) return m[1]
  }
  return undefined
}

const HEAD = `# Candle Harness config: https://github.com/candledottv/harness
# A fresh install starts in this mode; after that, the Candle Harness keeps the mode you last picked.
mode = "live"
`
const NOTE = `# The Candle CLI profile the Candle Harness acts as, recorded by setup: every candle run gets it, so switching
# the CLI's active profile doesn't move the Candle Harness to another account.
`

/**
 * Records the profile in config.toml, adding one line and changing nothing else: a new file when there's
 * none; `profile = "…"` under an existing `[candle]` table; else a `[candle]` table at the end. A config
 * that already names this profile is left as it is; one naming another is the person's choice, and is
 * refused with why. The result must parse to the same profile, or nothing is written.
 */
export async function recordProfile(p: Paths, profile: string): Promise<{ ok: true; wrote: boolean } | { ok: false; why: string }> {
  if (!isProfileName(profile)) return { ok: false, why: `"${String(profile).slice(0, 40)}" isn't a CLI profile's name` }
  const existing = existsSync(p.configFile) ? readFileSync(p.configFile, "utf8") : undefined
  const already = existing === undefined ? undefined : recordedProfile(p)
  if (already === profile) return { ok: true, wrote: false }
  if (already !== undefined) return { ok: false, why: `config.toml already names the profile ${already}: change candle.profile there by hand to use ${profile}` }
  let next: string
  if (existing === undefined) next = `${HEAD}\n[candle]\n${NOTE}profile = "${profile}"\n`
  else {
    const lines = existing.split("\n")
    const at = lines.findIndex((l) => /^\s*\[candle\]\s*(#.*)?$/.test(l))
    if (at >= 0) {
      lines.splice(at + 1, 0, ...NOTE.trimEnd().split("\n"), `profile = "${profile}"`)
      next = lines.join("\n")
    } else next = `${existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`}\n[candle]\n${NOTE}profile = "${profile}"\n`
  }
  try {
    const parsed = parseConfig(next, p.configFile).config.candle.profile
    if (parsed !== profile) return { ok: false, why: "config.toml wouldn't hold the profile as it's written" }
  } catch (error) {
    if (!(error instanceof ConfigError && error.code === "no_agents") || profileLine(next) !== profile) return { ok: false, why: `config.toml wouldn't hold the profile as it's written: ${(error as Error).message}` }
  }
  // 0700, as everywhere else the config folder is made: it holds config.toml and the keys.
  await mkdir(p.configDir, { recursive: true, mode: 0o700 })
  const temp = `${p.configFile}.tmp-${randomBytes(6).toString("base64url")}`
  const mode = existing === undefined ? 0o600 : statSync(p.configFile).mode & 0o777
  await writeFile(temp, next, { mode, flag: "wx" })
  await chmod(temp, mode)
  await rename(temp, p.configFile)
  return { ok: true, wrote: true }
}

/**
 * The CLI profile a core's `candle` run acts as, and its `rpcUrl`, read from the CLI's config.json: config.toml's
 * `candle.profile` where it's recorded (every run gets it as CANDLE_PROFILE), else the CLI's own pick.
 * `missing` is a recorded profile the file doesn't hold; a file that can't be read says nothing.
 */
export function actingProfile(env: Record<string, string | undefined>, recorded?: string): { name?: string; rpcUrl?: string; unresolved?: string[]; missing?: true; names?: string[] } {
  const dir = env.CANDLE_CONFIG_DIR?.trim() || join(env.HOME ?? homedir(), ".config", "candle")
  let config: { profiles?: Record<string, { rpcUrl?: unknown }>; activeProfile?: unknown }
  try {
    config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))
  } catch {
    return recorded ? { name: recorded } : {}
  }
  const profiles = config.profiles && typeof config.profiles === "object" ? config.profiles : {}
  const names = Object.keys(profiles)
  if (recorded !== undefined && !Object.hasOwn(profiles, recorded)) return { name: recorded, missing: true, names }
  const active = typeof config.activeProfile === "string" && Object.hasOwn(profiles, config.activeProfile) ? config.activeProfile : undefined
  const name = recorded ?? active ?? (names.length === 1 ? names[0] : undefined)
  if (name === undefined) return names.length > 1 ? { unresolved: names } : {}
  const rpcUrl = profiles[name]?.rpcUrl
  return { name, names, ...(typeof rpcUrl === "string" && rpcUrl.trim() ? { rpcUrl: rpcUrl.trim() } : {}) }
}
