// Whether the candle CLI will renew the person's Candle plan before the next command it runs at a
// terminal. From CLI 0.13.9, `candle plan auto-renew on` is a flag in the profile's plan state
// (`<config dir>/spend/<profile>.plan.json`), and any command at a terminal (none with --json, and not
// plan, plans, spend, auth, profile or doctor) asks Candle for a renewal quote in the 3 days before the
// period ends and pays it from a vault key, asking only for the vault's passphrase
// (cli/src/commands/plan.ts, maybeAutoRenew). A pane command runs at a terminal, so its card says so
// first. Read only, the way the CLI reads it; a file that can't be read says nothing.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { actingProfile } from "../setup/candle-profile"

/** The CLI's own window and retry gap (commands/plan.ts, AUTO_RENEW_WINDOW_MS and AUTO_RENEW_RETRY_MS). */
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const RETRY_MS = 12 * 60 * 60 * 1000

/** The command words the CLI never renews in front of (commands/plan.ts, AUTO_RENEW_SKIPPED). */
const SKIPPED = new Set(["plan", "plans", "spend", "auth", "profile", "doctor"])

export interface RenewDue {
  plan: string
  periodEnd: string
}

/** The plan state's fields the CLI decides by, and whether it would renew now. */
export function renewDue(state: unknown, now: number): RenewDue | undefined {
  if (typeof state !== "object" || state === null) return undefined
  const s = state as Record<string, unknown>
  if (s.autoRenew !== true || typeof s.plan !== "string" || typeof s.payer !== "string" || typeof s.periodEnd !== "string" || typeof s.renewCeilingRaw !== "string") return undefined
  if (s.pending !== undefined) return undefined
  const end = Date.parse(s.periodEnd)
  if (!Number.isFinite(end) || now < end - WINDOW_MS || now >= end) return undefined
  const last = typeof s.lastRenewAttemptAt === "string" ? Date.parse(s.lastRenewAttemptAt) : Number.NaN
  if (Number.isFinite(last) && now - last < RETRY_MS) return undefined
  return { plan: s.plan, periodEnd: s.periodEnd }
}

/** The renewal the CLI would make in front of `argv` at a terminal, for the profile the Candle Harness acts as. */
export function renewBefore(argv: readonly string[], env: Record<string, string | undefined>, recordedProfile: string | undefined, now: number): RenewDue | undefined {
  if (argv.includes("--json") || SKIPPED.has(argv[0] ?? "")) return undefined
  const profile = actingProfile(env, recordedProfile)
  if (profile.unresolved || profile.missing) return undefined
  const dir = env.CANDLE_CONFIG_DIR?.trim() || join(env.HOME ?? homedir(), ".config", "candle")
  try {
    return renewDue(JSON.parse(readFileSync(join(dir, "spend", `${profile.name ?? "default"}.plan.json`), "utf8")), now)
  } catch {
    return undefined
  }
}

/** The card's line: what the CLI does first, in the pane. */
export function renewWarning(due: RenewDue): string {
  const plan = due.plan === "max" ? "Max" : due.plan === "pro" ? "Pro" : due.plan
  const ends = new Date(due.periodEnd).toISOString().slice(0, 10)
  return `Your Candle ${plan} plan renews first: auto-renew is on and it ends ${ends}, so the CLI pays for the next 30 days before this runs, and asks for your vault passphrase to do it.`
}
