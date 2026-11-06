// Where the view keeps layouts: layouts.toml beside config.toml, written whole and 0600 by a rename so a
// crash never leaves half a file; and which layout each tab shows, last chosen, in state/layout.json (0600),
// as the mode and the engine choice are kept. The core reads neither. The same file keeps which new tabs the
// view has said are there to tick on, so it says it once, and each tab's own adjustments: a resize or a pane
// opened changes the tab, not layouts.toml, until it's saved by name. And the tab the Candle Harness opens on, picked at
// setup's last step.
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type { Paths } from "../paths"

export interface LayoutStore {
  /** Where layouts.toml is, to show. */
  path: string
  /** The file's text, or undefined when there's none. */
  read(): string | undefined
  write(text: string): void
  /** Each tab's last chosen layout, by the tab's name. */
  choices(): Record<string, string>
  saveChoices(choices: Record<string, string>): void
  /** The new tabs the view has told of: a file that lists tabs gets them unticked, said once. */
  told(): string[]
  saveTold(names: readonly string[]): void
  /** Each tab's adjustments to its layout, by the tab's name: the layout it started from and the tree as adjusted. */
  adjusted(): Record<string, Adjusted>
  saveAdjusted(adjusted: Record<string, Adjusted>): void
  /** A preset's new panes the person left out of a layout of theirs, by the layout's name (new-panes.ts): not offered again. */
  dismissedPanes(): Record<string, string[]>
  saveDismissedPanes(dismissed: Record<string, string[]>): void
  /** The tab the Candle Harness opens on, by its name; unset, the first. */
  opensOn(): string | undefined
  saveOpensOn(tab: string): void
}

/** A tab's layout as adjusted on it: `base` names the layout it started from; `tree` is the file's array form. */
export interface Adjusted {
  base: string
  tree: unknown
}

function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

export function fileStore(p: Paths): LayoutStore {
  const state = (): Record<string, unknown> => {
    try {
      const raw = JSON.parse(readFileSync(p.layoutChoice, "utf8")) as unknown
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  // Each part is written with the others as they are, so a choice kept never drops what was told.
  const saveState = (part: Record<string, unknown>) => writeWhole(p.layoutChoice, `${JSON.stringify({ ...state(), ...part }, null, 2)}\n`)
  return {
    path: p.layoutsFile,
    read() {
      try {
        return readFileSync(p.layoutsFile, "utf8")
      } catch {
        return undefined
      }
    },
    write(text) {
      // Text TOML won't read back would put every layout and tab of yours back to the presets on the next start.
      try {
        Bun.TOML.parse(text)
      } catch (error) {
        throw new Error(`the change wouldn't read back (${(error as Error).message}), so layouts.toml is left as it was`)
      }
      writeWhole(p.layoutsFile, text)
    },
    choices() {
      const tabs = state().tabs
      const record = tabs && typeof tabs === "object" && !Array.isArray(tabs) ? (tabs as Record<string, unknown>) : {}
      return Object.fromEntries(Object.entries(record).filter((e): e is [string, string] => typeof e[1] === "string"))
    },
    saveChoices: (choices) => saveState({ tabs: choices }),
    told() {
      const told = state().toldNewTabs
      return Array.isArray(told) ? told.filter((t): t is string => typeof t === "string") : []
    },
    saveTold: (names) => saveState({ toldNewTabs: [...names] }),
    adjusted() {
      const raw = state().adjusted
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).flatMap(([tab, v]) => {
          const a = v as Partial<Adjusted> | null
          return a && typeof a === "object" && typeof a.base === "string" && Array.isArray(a.tree) ? [[tab, { base: a.base, tree: a.tree }]] : []
        }),
      )
    },
    saveAdjusted: (adjusted) => saveState({ adjusted }),
    dismissedPanes() {
      const raw = state().dismissedPanes
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
      return Object.fromEntries(Object.entries(raw as Record<string, unknown>).flatMap(([name, v]) => (Array.isArray(v) ? [[name, v.filter((x): x is string => typeof x === "string")]] : [])))
    },
    saveDismissedPanes: (dismissedPanes) => saveState({ dismissedPanes }),
    opensOn() {
      const tab = state().opensOn
      return typeof tab === "string" ? tab : undefined
    },
    saveOpensOn: (opensOn) => saveState({ opensOn }),
  }
}

/** A store held in memory: for tests, and a view with nowhere to write. */
export function memoryStore(text?: string, choices: Record<string, string> = {}, told: string[] = [], adjusted: Record<string, Adjusted> = {}): LayoutStore & { written: string[] } {
  let file = text
  let chosen = { ...choices }
  let toldOf = [...told]
  let held = { ...adjusted }
  let dismissed: Record<string, string[]> = {}
  let opens: string | undefined
  const written: string[] = []
  return {
    path: "layouts.toml",
    written,
    read: () => file,
    write(t) {
      file = t
      written.push(t)
    },
    choices: () => ({ ...chosen }),
    saveChoices(c) {
      chosen = { ...c }
    },
    told: () => [...toldOf],
    saveTold(names) {
      toldOf = [...names]
    },
    adjusted: () => ({ ...held }),
    saveAdjusted(a) {
      held = { ...a }
    },
    dismissedPanes: () => structuredClone(dismissed),
    saveDismissedPanes(d) {
      dismissed = structuredClone(d)
    },
    opensOn: () => opens,
    saveOpensOn(tab) {
      opens = tab
    },
  }
}
