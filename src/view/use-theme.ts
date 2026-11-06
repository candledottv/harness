// The theme on screen, for a view: started from the last choice or config.toml's
// [theme] name before the first frame, switched from the palette, and followed when another view switches
// it, so a popped view keeps in step with the main one. A theme picked that can't be drawn leaves the one
// on screen as it was.
import { useEffect, useRef, useState } from "react"
import { applyColours, BUILT_IN, CANDLE_DARK, TERMINAL, type TerminalColours } from "./theme"
import { configTheme, type Loaded, loadTheme, startingTheme, themeNames, type ThemeStore } from "./themes"

export interface ThemeOptions {
  store?: ThemeStore | undefined
  /** config.toml's text, for its [theme] name. */
  config?: (() => string | undefined) | undefined
  /** The terminal's colours, read before the first frame when the view starts on Terminal. */
  terminal?: TerminalColours | undefined
  /** Reads the terminal's colours when Terminal is picked. */
  readTerminal?: (() => Promise<TerminalColours | undefined>) | undefined
}

export interface ThemeOnScreen {
  /** The theme drawn now. */
  name: string
  /** What kept the starting theme from being drawn as asked, or a theme of yours's left-out leaves: said once, when the view starts. */
  startProblems: string[]
  /** Every theme by name, read again when asked (the palette opening). */
  names(): string[]
  /** Switches to `name`, kept for next time; the theme on screen stays when it can't be drawn. */
  pick(name: string): Promise<Loaded>
}

const configName = (config: ThemeOptions["config"]): { name?: string; problem?: string } => {
  try {
    return configTheme(config?.())
  } catch {
    return {}
  }
}

export function useTheme({ store, config, terminal, readTerminal }: ThemeOptions): ThemeOnScreen {
  // Read once: the [theme] name a pick is kept against.
  const [fromConfig] = useState(() => configName(config))
  const [start] = useState(() => {
    const loaded = loadTheme(startingTheme(store, fromConfig.name), store, terminal)
    applyColours(loaded.colours)
    const problems = [...(fromConfig.problem ? [fromConfig.problem] : []), ...(loaded.used ? loaded.problems : [`${loaded.problems[0]}: ${CANDLE_DARK} is drawn instead`, ...loaded.problems.slice(1)])]
    return { name: loaded.used ? loaded.name : CANDLE_DARK, problems }
  })
  const [name, setName] = useState(start.name)
  const nameRef = useRef(name)
  const show = (loaded: Loaded) => {
    applyColours(loaded.colours)
    nameRef.current = loaded.name
    setName(loaded.name)
  }
  const load = async (wanted: string): Promise<Loaded> => loadTheme(wanted, store, wanted.toLowerCase() === TERMINAL.toLowerCase() ? await readTerminal?.().catch(() => undefined) : undefined)

  // Another view's pick: drawn here too, unless it can't be drawn here (Terminal, in a terminal that won't say its colours).
  useEffect(() => {
    if (!store) return
    return store.watch(() => {
      const chosen = store.chosen()
      if (!chosen || chosen.name === nameRef.current) return
      void load(chosen.name).then((loaded) => loaded.used && show(loaded))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])
  // Candle dark again when the view goes, so a test's next frame starts from the default look.
  useEffect(() => () => applyColours(BUILT_IN[CANDLE_DARK]!), [])

  return {
    name,
    startProblems: start.problems,
    names: () => themeNames(store),
    async pick(wanted) {
      const loaded = await load(wanted)
      if (!loaded.used) return loaded
      show(loaded)
      store?.saveChosen({ name: loaded.name, ...(fromConfig.name !== undefined ? { config: fromConfig.name } : {}) })
      return loaded
    },
  }
}
