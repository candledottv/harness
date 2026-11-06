// The parity check: the table (src/core/cli-table.ts) and the public page (the docs
// site's reference/cli-parity, written from the table by scripts/docs-pages.ts) each hold one row for every
// command the CLI routes, and name nothing it doesn't. A command and subcommand comes from the CLI's
// dispatch table; a third word ("keys signer move") from its help. Both were read from the CLI's source
// into src/core/cli-source.json, which scripts/read-cli-source.ts refreshes when the pinned CLI moves.
//
//   bun scripts/cli-parity.ts            lists what's out of step, and exits 1 if anything is
import { CATALOGUE, type CatalogueEntry, helpLine } from "../src/core/cli-catalogue"
import { CLI_ROWS, type HelpTopic, SOURCE, type SourceEntry } from "../src/core/cli-table"

const PAGE = "the docs page"

/** The command paths the page lists, from its rows' first column. */
export function docPaths(doc: string): string[] {
  return [...doc.matchAll(/^\| `candle ([a-z0-9 -]+)` \|/gm)].map((m) => m[1]!)
}

export function parityProblems(source: { commands: readonly SourceEntry[]; help: Readonly<Record<string, HelpTopic>> }, rows: readonly { path: string }[], doc: string): string[] {
  const routed = source.commands.map((c) => (c.subcommand ? `${c.command} ${c.subcommand}` : c.command))
  const routedSet = new Set(routed)
  // A third word exists when its command and subcommand route and the help documents it.
  const exists = (path: string) => {
    if (routedSet.has(path)) return true
    const words = path.split(" ")
    return words.length === 3 && routedSet.has(words.slice(0, 2).join(" ")) && helpLine(source.help, path).exact
  }
  const table = rows.map((r) => r.path)
  const page = docPaths(doc)
  const problems: string[] = []
  for (const path of routed) {
    if (!table.includes(path)) problems.push(`${path}: no row in the table`)
    if (!page.includes(path)) problems.push(`${path}: not in ${PAGE}`)
  }
  for (const path of table) if (!exists(path)) problems.push(`${path}: the table names a command the CLI doesn't have`)
  for (const path of page) if (!exists(path)) problems.push(`${path}: ${PAGE} names a command the CLI doesn't have`)
  const twice = (paths: string[]) => [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))]
  for (const path of twice(table)) problems.push(`${path}: more than one row in the table`)
  for (const path of twice(page)) problems.push(`${path}: more than one row in ${PAGE}`)
  return problems
}

const cell = (text: string) => text.replace(/\|/g, "\\|")

function when(e: CatalogueEntry): string {
  if (e.availability === "never") return cell(e.note ?? "")
  if (e.why) return `${e.availability}: ${cell(e.why)}`
  // The rule in words, less what the rule column already says ("owner step", "funds out").
  const how = e.rule === "funds-out" ? undefined : e.how?.replace(/^owner: /, "")
  const now = how ? `${e.availability} (${how})` : e.availability
  return e.partly ? `${now}; ${cell(e.partly)}` : now
}

/** The docs site's page, from the table and the CLI's help, less its title (scripts/docs-pages.ts gives it one). Written for anyone: no internal names or plans. */
export function parityBody(): string {
  const out: string[] = [
    "The Candle Harness does everything the `candle` CLI does. Ask your agent in plain English (\"revoke the key ending ab12\", \"what are my LP positions?\") and it carries the command out under the rule below. It uses Candle's MCP tools where one fits, and otherwise runs the real `candle` CLI through the Candle Harness's core, which checks every command against this table first.",
    "",
    "In the Candle Harness, `ctrl-k` opens the palette, which lists the same commands after the Candle Harness's own (`?` then `c` opens it at them). Pick a command, and a request for it lands on the input line for you to finish and send.",
    "",
    `This page covers \`candle\` ${SOURCE.source.cliVersion}, grouped as \`candle help\` groups its commands.`,
    "",
    "## How each kind of command runs",
    "",
    "| Rule | What happens |",
    "|---|---|",
    "| read | Runs at once, and the agent sees the output. |",
    "| narrows access | It only ever takes access away: revoking a key, taking a key off a wallet, untrusting a wallet. Typed by you (`candle keys revoke …` on the input line), it runs at once. Proposed by the agent, it's a card you approve with one key press. |",
    "| card | The agent's request becomes a card you approve with one key press. Then it runs with that agent's key. |",
    "| owner step | It changes what your keys and wallets can do. It becomes a card (typed, it opens at once), and runs in a prompt pane the agent can't see, where you give your vault factor and answer the CLI's own prompts. |",
    "| in the terminal | It needs the CLI's own prompts: a passphrase, a recovery phrase, a typed confirmation. It runs in a terminal pane inside the Candle Harness that the agent can't see, and the agent learns only whether it finished. |",
    "| funds out | It moves funds out, signed from this machine's vault, in the same prompt pane: the CLI asks for your vault passphrase and a typed `confirm`. The agent proposes one only when your own message names where it goes and how much. An address that looks like one of yours but isn't is refused, and one that isn't yours shows in amber, approved only by a click. |",
    "| not in the Candle Harness | Shell setup, or something the Candle Harness does itself. |",
    "",
    "**now:** the agent can do it today. **coming:** it's on the way, and until then the agent says so.",
    "",
    "Whatever the rule, the agent never sees a passphrase, a recovery phrase or a key. It can't pass the flags that change who or where a command runs (`--profile`, `--api-url`), point a command at a file (except `candle image upload`, for a file in its own research folder), or chain a second command.",
  ]
  let group = ""
  for (const e of CATALOGUE) {
    if (e.group !== group) {
      group = e.group
      out.push("", `## ${group}`, "", "| Command | What it does | Rule | When |", "|---|---|---|---|")
    }
    out.push(`| \`candle ${e.path}\` | ${cell(e.description)} | ${e.ruleLabel} | ${when(e)} |`)
  }
  return `${out.join("\n")}\n`
}

if (import.meta.main) {
  const problems = parityProblems(SOURCE, CLI_ROWS, parityBody())
  for (const p of problems) console.error(p)
  if (problems.length) process.exit(1)
}
