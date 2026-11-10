// `candle-harness bots …`: code bots' processes from a terminal, for the person who builds them.
//
// - `list` names every bot: a code bot with its state, its figures and how its process stands.
// - `start`, `stop` and `restart` run, end and run again a code bot's process. Stopping its process leaves the bot on,
//   so the exits the core holds on its positions still run; the Bots tab's stop, in the main window, stops its trades
//   too. None of them approves anything: a bot runs only as its card was approved.
// - `token` is for a bot run elsewhere (launchd, tmux, a debugger): its token is written to a 0600 file in its folder,
//   never printed, and it shows as running outside the Candle Harness until `start` runs it here again.
// - `logs` prints the end of its log, which works with no core running: the log was redacted when it was kept.
//
// Each attaches to the running core with the view token in the state folder, as `ask` does, and none starts a core.
// Exit codes are `ask`'s: 0 done; 2 usage; 3 no core running; 4 refused.
import { BOTS_CLIENT, connectView, type CoreConnection } from "../core/client"
import type { CodeBotView } from "../core/code-bots"
import type { BotsTopic } from "../core/bots"
import { readLogTail } from "../core/supervisor"
import { type Paths, paths as pathsOf, PathsError } from "../paths"
import { EXIT, type OutsideDeps, type OutsideIo, reach, refusal } from "./ask"

const USAGE = `Usage: candle-harness bots <command>
  list               every bot: each code bot's state, figures and process
  start <name>       run a code bot's process here: after it crashed too often, was stopped, or ran outside
  stop <name>        end a code bot's process; the bot stays on, and the exits the core holds still run
  restart <name>     end its process and run it again, with its code as it is now
  token <name>       for a bot run elsewhere: its token, written to .harness-bot.json in its folder (0600), never shown
  logs <name> [-n N] the end of its log (200 lines, or N), redacted when it was kept
  init [folder]      a bots folder (~/candle-bots by default): AGENTS.md with the rules every bot runs under,
                     the client, and Candle's bot-building skills. A file you changed is never written over.
  Exit codes: 0 done; 2 usage; 3 no core running; 4 refused.
`

const VERBS = new Set(["start", "stop", "restart", "token"])

const realConnect = (p: Paths, clientName: string) => connectView({ socketPath: p.socket, viewTokenPath: p.viewToken, clientName })

/** One code bot as a line or two. */
function codeLines(c: CodeBotView): string[] {
  const state = c.state === "on" ? (c.buys ? "on" : "on, buys held") : c.state
  const proc = c.process ? c.process.words : "its process isn't run by this core"
  return [
    `  ${c.name}  code · ${c.agent} · ${c.mode} · ${state} · ${c.connected ? "connected" : "not connected"}`,
    `      ${c.commandShown} in ${c.folderShown} · ${c.figures}`,
    `      ${proc}${c.process?.warning ? ` · ${c.process.warning}` : ""}`,
    ...(c.held ? [`      ${c.held.words}`] : []),
  ]
}

/** `bots init [folder]`: the bots folder written, with no core needed. */
async function init(args: string[], io: OutsideIo, d: OutsideDeps): Promise<number> {
  if (args.length > 1) {
    io.err(`init takes at most one folder.\n\n${USAGE}`)
    return EXIT.usage
  }
  const { botsFolderPath, DEFAULT_BOTS_FOLDER, folderWriteWords, writeBotsFolder } = await import("../build/folder")
  const folder = botsFolderPath(args[0] ?? DEFAULT_BOTS_FOLDER, d.env.HOME)
  try {
    const done = await writeBotsFolder(folder)
    io.out(`${folderWriteWords(done).join("\n")}\n`)
    return EXIT.done
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return EXIT.failed
  }
}

export async function botsCommand(args: string[], io: OutsideIo, d: OutsideDeps): Promise<number> {
  const [verb, ...rest] = args
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    ;(verb ? io.out : io.err)(USAGE)
    return verb ? EXIT.done : EXIT.usage
  }
  if (verb === "logs") return logs(rest, io, d)
  if (verb === "init") return init(rest, io, d)
  if (verb !== "list" && !VERBS.has(verb)) {
    io.err(`Unknown bots command ${verb.slice(0, 40)}.\n\n${USAGE}`)
    return EXIT.usage
  }
  const name = rest.join(" ").trim()
  if (verb !== "list" && !name) {
    io.err(`${verb} needs a code bot's name.\n\n${USAGE}`)
    return EXIT.usage
  }
  const p = await reach(io, d)
  if (typeof p === "number") return p
  let connection: CoreConnection
  try {
    ;({ connection } = await (d.connect ?? realConnect)(p, BOTS_CLIENT))
  } catch (error) {
    return refusal(io, error)
  }
  try {
    if (verb === "list") {
      const t = (await connection.request("bots.list", {})) as BotsTopic
      const lines: string[] = []
      if (t.gate) lines.push(t.gate.words)
      for (const c of t.code ?? []) lines.push(...codeLines(c))
      for (const b of t.bots) lines.push(`  ${b.name}  rules · ${b.agent} · ${b.mode} · ${b.state}`)
      io.out(lines.length ? `${lines.join("\n")}\n` : "No bots yet. A code bot is made from the Build tab; a rules bot by asking the agent.\n")
      return EXIT.done
    }
    const method = verb === "token" ? "bots.token" : `bots.process.${verb}`
    const done = (await connection.request(method, { name })) as { said?: unknown }
    io.out(`${String(done.said ?? "Done.")}\n`)
    return EXIT.done
  } catch (error) {
    return refusal(io, error)
  } finally {
    connection.close()
  }
}

/** The end of a bot's log, read from the state folder: no core needed. */
async function logs(args: string[], io: OutsideIo, d: OutsideDeps): Promise<number> {
  let lines = 200
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "-n" || a === "--lines") {
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 1) {
        io.err(`${a} needs a number of lines.\n\n${USAGE}`)
        return EXIT.usage
      }
      lines = Math.min(n, 5_000)
    } else words.push(a)
  }
  const name = words.join(" ").trim()
  if (!name) {
    io.err(`logs needs a code bot's name.\n\n${USAGE}`)
    return EXIT.usage
  }
  let p: Paths
  try {
    p = pathsOf(d.env)
  } catch (error) {
    if (error instanceof PathsError) {
      io.err(`${error.message}\n`)
      return EXIT.failed
    }
    throw error
  }
  const tail = await readLogTail(p.botLogsDir, name, lines)
  if (!tail.lines.length) {
    io.err(`No log for "${name}" yet: a code bot's log starts when the Candle Harness first runs it. (${tail.file})\n`)
    return EXIT.refused
  }
  io.out(`${tail.lines.join("\n")}\n`)
  io.err(`(${tail.file}; \`tail -f\` follows it)\n`)
  return EXIT.done
}
