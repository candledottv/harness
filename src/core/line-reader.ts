// A line read by the core as the view reads it: the same parser (shared/commands.ts), config.toml's
// [aliases] by the same rules, and the core's own token names. A trigger's line is checked when it's saved
// and again when it fires, with no view open, so the core has to read it the way the person's view
// would have, and the two can't disagree about what a line means.
//
// config.toml is only read, never written here. It's read again whenever its modified time or size
// changes, so an alias edited by hand is in use at the next line.
import { readFileSync, statSync } from "node:fs"
import { type Aliases, NO_ALIASES, parseAliases } from "../shared/aliases"
import { type Command, type CommandContext, parseCommand } from "../shared/commands"
import type { WalletsTopic } from "./agent-wallets"
import type { TokenNames } from "./token-names"

/** config.toml's [aliases], read when the file changes. */
export class AliasFile {
  /** The file as last read: undefined before the first read, null when there was none. */
  private seen: { mtimeMs: number; size: number } | null | undefined
  private aliases: Aliases = NO_ALIASES

  constructor(private readonly path: string) {}

  current(): Aliases {
    let now: { mtimeMs: number; size: number } | null
    try {
      const st = statSync(this.path, { throwIfNoEntry: false })
      now = st ? { mtimeMs: st.mtimeMs, size: st.size } : null
    } catch (error) {
      return { map: new Map(), problems: [`config.toml couldn't be read for its aliases: ${(error as Error).message}`] }
    }
    if (this.seen !== undefined && (now === null ? this.seen === null : this.seen !== null && this.seen.mtimeMs === now.mtimeMs && this.seen.size === now.size)) {
      return this.aliases
    }
    this.seen = now
    if (now === null) return (this.aliases = NO_ALIASES)
    try {
      this.aliases = parseAliases(readFileSync(this.path, "utf8"), "config.toml")
    } catch (error) {
      // Not kept as read: the next line tries the file again.
      this.seen = undefined
      this.aliases = { map: new Map(), problems: [`config.toml couldn't be read for its aliases: ${(error as Error).message}`] }
    }
    return this.aliases
  }
}

export interface LineReaderDeps {
  aliases: AliasFile
  names: TokenNames
  agents(): readonly string[]
  /** What each agent can pay from, for `from <wallet>`; undefined before Candle's wallets are read. */
  wallets(): WalletsTopic | undefined
  mode(): "paper" | "live"
}

export class LineReader {
  constructor(private readonly deps: LineReaderDeps) {}

  /**
   * What a line is read against, for `agent`: the view's context, built from the core's state. `mode` is the
   * Candle Harness's unless the line has one of its own (a saved trigger's, set when it was approved).
   */
  context(agent: string, mode: "paper" | "live" = this.deps.mode()): CommandContext {
    const wallets = this.deps.wallets()
    return {
      agents: this.deps.agents(),
      knownTokens: this.deps.names.known(),
      severalTokens: this.deps.names.several(),
      activeAgent: agent,
      mode,
      ...(wallets ? { wallets } : {}),
      aliases: this.deps.aliases.current().map,
    }
  }

  /** The line as the input line would read it, typed as `agent`. */
  read(line: string, agent: string): Command | undefined {
    return parseCommand(line, this.context(agent))
  }

  /** Each alias left out of config.toml's [aliases], with its line. */
  aliasProblems(): string[] {
    return this.deps.aliases.current().problems
  }
}
