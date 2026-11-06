// Private homes. A harness that reads the user's own
// setup from its home folder whatever the flags (Codex, Grok) gets a private home per turn holding only
// the sign-in, so the user's instructions, skills, plugins and sessions stay out of the turn and the
// turn stays out of theirs.
//
// The sign-in reaches the home one of two ways:
//   - a symlink to the real file, so a token refresh written in place lands in it (Codex);
//   - a copy carrying the real file's times, for a harness whose sandbox won't follow a link out of its
//     home (Grok under `strict`).
// After the turn, a sign-in the harness refreshed is handed back over the real one, unless the real one
// is newer (the user signed in again meanwhile). A home a dead core left is handed back and removed on
// the next start, from the record kept beside it.
//
// Homes live under the core's state folder, never /tmp: Codex refuses its helper binaries there, and
// every Grok profile leaves /tmp readable.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface PrivateHome {
  home: string
  /** Hands a refreshed sign-in back and removes the home. Safe to call twice. */
  close(): void
}

interface Record {
  realAuth: string
  /** The sign-in's name inside the home. */
  authName: string
}

/** The record kept beside a home, naming the real sign-in, for recovery after a dead core. */
const recordOf = (base: string, name: string) => join(base, `${name}.home.json`)

export function privateHome(o: { base: string; name: string; realAuth: string; copy?: boolean; authName?: string }): PrivateHome {
  mkdirSync(o.base, { recursive: true, mode: 0o700 })
  chmodSync(o.base, 0o700)
  const home = join(o.base, o.name)
  mkdirSync(home, { mode: 0o700 })
  const record = recordOf(o.base, o.name)
  const authName = o.authName ?? "auth.json"
  writeFileSync(record, `${JSON.stringify({ realAuth: o.realAuth, authName } satisfies Record)}\n`, { mode: 0o600, flag: "wx" })
  const link = join(home, authName)
  if (existsSync(o.realAuth)) {
    if (o.copy) {
      copyFileSync(o.realAuth, link)
      chmodSync(link, 0o600)
      const st = statSync(o.realAuth)
      utimesSync(link, st.atime, st.mtime)
    } else symlinkSync(o.realAuth, link)
  }
  let closed = false
  return {
    home,
    close() {
      if (closed) return
      closed = true
      try {
        handBack(link, o.realAuth)
      } finally {
        removeAll(home)
        rmSync(record, { force: true })
      }
    },
  }
}

/** A sign-in the harness replaced or refreshed goes back over the real one, unless the real one is newer. */
function handBack(link: string, real: string): boolean {
  if (!existsSync(link) || lstatSync(link).isSymbolicLink()) return false
  if (existsSync(real) && statSync(link).mtimeMs <= statSync(real).mtimeMs) return false
  mkdirSync(dirname(real), { recursive: true })
  const temp = `${real}.candle-${process.pid}`
  copyFileSync(link, temp)
  chmodSync(temp, 0o600)
  renameSync(temp, real)
  return true
}

/** Removes a folder a harness wrote in, owner permissions restored first if a remove is refused (Grok's sandbox start leaves a mode-000 probe folder). */
export function removeAll(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    const open = (p: string) => {
      chmodSync(p, 0o700)
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) open(join(p, e.name))
        else if (!e.isSymbolicLink()) chmodSync(join(p, e.name), 0o600)
      }
    }
    open(path)
    rmSync(path, { recursive: true, force: true })
  }
}

/** On the core's start: every home a dead core left, its sign-in handed back where refreshed, then removed. */
export function recoverHomes(base: string): { handedBack: string[]; removed: string[] } {
  const handedBack: string[] = []
  const removed: string[] = []
  if (!existsSync(base)) return { handedBack, removed }
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const record = recordOf(base, e.name)
    try {
      const { realAuth, authName } = JSON.parse(readFileSync(record, "utf8")) as Record
      if (typeof realAuth === "string" && typeof authName === "string" && !authName.includes("/") && handBack(join(base, e.name, authName), realAuth)) handedBack.push(realAuth)
    } catch {
      // No record, or an unreadable one: nothing to hand back.
    }
    removeAll(join(base, e.name))
    rmSync(record, { force: true })
    removed.push(e.name)
  }
  return { handedBack, removed }
}
