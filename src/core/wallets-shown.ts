// Which wallets the Wallets and Positions panes show, so inactive wallets needn't crowd them, and the agent
// can be asked to show the active ones. It only changes what's shown: paying, limits and refusals read every
// wallet as before.
//
// - "active" (the default): wallets a Candle Harness agent can pay from. That's the embedded wallet when
//   an agent here is allowed it, and each TEE wallet bound to a configured agent's key, unless Candle has
//   stopped it. Wallets of keys outside the Candle Harness, and stopped ones, are hidden.
// - "all": every wallet on the account.
// - a list: the wallets named, by "embedded", a TEE wallet's label, or an address.
// - "group:<name>": the wallets in one of the person's groups (wallet-groups.ts).
//
// config.toml's `[wallets] show` is where a fresh install starts; the choice last made (a click, or the
// agent's harness_show_wallets) is kept in `state/wallets-shown.json`, as the mode is.
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import { groupNameProblem } from "./wallet-groups"
import { fold } from "./wallet-names"

export type WalletsShown = "active" | "all" | `group:${string}` | string[]

/** A group as the filter needs it: its name and its wallets' addresses. */
export interface ShownGroup {
  name: string
  members: readonly string[]
}

/** The group a choice names, or undefined when it names none. */
export const shownGroup = (shown: WalletsShown): string | undefined => (typeof shown === "string" && shown.startsWith("group:") ? shown.slice(6) : undefined)

/** At most this many wallets in a list: more than any pane shows. */
const MAX_NAMED = 20

/** A wallet as the filter sees it: the panes' PortfolioView wallets have these fields. */
export interface ShownWallet {
  address: string
  kind: "embedded" | "tee"
  label?: string
  agents: readonly string[]
  active?: boolean
  stopped?: true
}

/** The choice from a config value or a tool's argument, or why it isn't one. */
export function parseShown(value: unknown): { ok: true; shown: WalletsShown } | { ok: false; message: string } {
  if (value === "active" || value === "all") return { ok: true, shown: value }
  if (typeof value === "string" && value.startsWith("group:")) {
    const why = groupNameProblem(value.slice(6))
    return why ? { ok: false, message: `group:<name> names one of your groups, and ${why}` } : { ok: true, shown: value as `group:${string}` }
  }
  if (Array.isArray(value) && value.length > 0 && value.length <= MAX_NAMED && value.every((v) => typeof v === "string" && v.trim() !== "" && v.length <= 64)) {
    return { ok: true, shown: [...new Set(value.map((v: string) => v.trim()))] }
  }
  return { ok: false, message: `it's "active", "all", "group:<name>", or a list of 1 to ${MAX_NAMED} wallets by "embedded", label or address` }
}

// A wallet by its name (the embedded wallet's own too), "embedded", or its address.
const nameMatches = (w: ShownWallet, name: string) =>
  name === w.address || (w.kind === "embedded" && fold(name) === "embedded") || (w.label !== undefined && fold(name) === fold(w.label))

/** Whether a wallet is active: a Candle Harness agent can pay from it, and Candle hasn't stopped it. */
export const isActive = (w: ShownWallet) => w.agents.length > 0 && w.active !== false

/** The wallets shown, in their order, and how many are hidden. */
export function shownWallets<W extends ShownWallet>(wallets: readonly W[], shown: WalletsShown, groups: readonly ShownGroup[] = []): { shown: W[]; hidden: number } {
  const groupName = shownGroup(shown)
  const members = groupName !== undefined ? new Set(groups.find((g) => fold(g.name) === fold(groupName))?.members ?? []) : undefined
  // A wallet the Candle Harness stopped always shows: its funds are still in it, and only the user can sweep them home.
  const keep = wallets.filter((w) => w.stopped === true || (members ? members.has(w.address) : shown === "all" ? true : shown === "active" ? isActive(w) : Array.isArray(shown) && shown.some((name) => nameMatches(w, name))))
  return { shown: keep, hidden: wallets.length - keep.length }
}

/** Names in a list that match no wallet, or a group that isn't one, so the agent can be told which it got wrong. */
export function unknownNames(wallets: readonly ShownWallet[], shown: WalletsShown, groups: readonly ShownGroup[] = []): string[] {
  const groupName = shownGroup(shown)
  if (groupName !== undefined) return groups.some((g) => fold(g.name) === fold(groupName)) ? [] : [`the group ${groupName}`]
  return Array.isArray(shown) ? shown.filter((name) => !wallets.some((w) => nameMatches(w, name))) : []
}

export function readSavedShown(path: string): WalletsShown | undefined {
  try {
    const parsed = parseShown((JSON.parse(readFileSync(path, "utf8")) as { show?: unknown }).show)
    return parsed.ok ? parsed.shown : undefined
  } catch {
    return undefined
  }
}

export async function saveShown(path: string, shown: WalletsShown, now: number): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
  await writeFile(temp, `${JSON.stringify({ show: shown, at: new Date(now).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
  await chmod(temp, 0o600)
  await rename(temp, path)
}
