// The commands pane's catalogue: every row of the parity table, grouped as the
// CLI's own help groups it, described in the CLI's own words (help.ts, read by
// scripts/read-cli-source.ts), with the rule the agent meets, whether it can do it now, and the
// plain-English request the pane puts on the input line. The docs site's reference/cli-parity page is written from it too.
import { paneRowNow } from "./owner-rows"
import { CLI_ROWS, type CliRow, type CliRule, type HelpTopic, PANE_RULES, SOURCE, unlocksFor } from "./cli-table"

export type Availability = "now" | "coming" | "never"

export interface CatalogueEntry {
  path: string
  group: string
  /** The CLI's own line for it, first sentence. */
  description: string
  rule: CliRule
  ruleLabel: string
  availability: Availability
  /** How its flags change that ("--access read (narrows): now"). */
  partly?: string
  /** Why a card row is still coming: Candle or an owner step blocks it, or it waits for a live check. */
  why?: string
  /** Why the agent never runs it. */
  note?: string
  /** A row that runs in the prompt pane, now: its rule in words. */
  how?: string
  /** The CLI's own prompts it meets in the pane, in the card's words. */
  asks?: string[]
  /** What a ceremony shows or takes, in the card's words. */
  shows?: string
  /** What Enter puts on the input line, for the user to finish; none when the agent never runs it. */
  request?: string
  /** Whether the CLI's help documents this exact path (otherwise the line is its parent's). */
  documented: boolean
}

export const RULE_LABELS: Record<CliRule, string> = {
  read: "read",
  mcp: "read",
  "less-access": "narrows access",
  card: "card",
  owner: "owner step",
  ceremony: "in the terminal",
  "funds-out": "funds out",
  never: "not in the Candle Harness",
}

/** A word in an invocation, or alternatives of one ("show|set", "[on|off]"); not a placeholder or a flag. */
const WORD = /^\[?([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)\]?$/
const alternatives = (token: string | undefined): string[] => (token ? (WORD.exec(token)?.[1]?.split("|") ?? []) : [])

/**
 * The word paths each help row documents, below its command word:
 * - "signer approve <code>" is `signer` and `signer approve`;
 * - "  move <prefix>", indented under it, is `signer move`;
 * - "post create|delete|list" is `post`, `post create`, `post delete` and `post list`;
 * - "deposit <amount> | deposit status <id>" is `deposit` and `deposit status`;
 * - "factor list | add <kind> | remove <id>" is `factor list`, `factor add` and `factor remove`.
 */
function documentedPaths(topic: HelpTopic): { paths: string[]; description: string }[] {
  let parent: string | undefined
  return topic.rows.map((row) => {
    const paths: string[] = []
    const [first = "", ...more] = row.invocation.trim().split(" | ")
    const words = first.split(/\s+/)
    const heads = alternatives(words[0])
    if (row.invocation.startsWith("  ") && parent) {
      // `  signer remove` under `signer new` (tee, 0.13.9) repeats the parent's word before its own.
      if (heads.includes(parent) && words[1]) for (const w of alternatives(words[1])) paths.push(`${parent} ${w}`)
      else for (const w of heads) paths.push(`${parent} ${w}`)
    } else {
      parent = heads[0] ?? parent
      for (const w of heads) {
        paths.push(w)
        for (const second of alternatives(words[1])) paths.push(`${w} ${second}`)
      }
      for (const segment of more) {
        const [w0, w1] = segment.split(/\s+/)
        if (heads.includes(w0!)) for (const second of alternatives(w1)) paths.push(`${w0} ${second}`)
        else for (const w of heads) for (const second of alternatives(w0)) paths.push(`${w} ${second}`)
      }
    }
    return { paths, description: row.description }
  })
}

/** The CLI's help line for a command path: the topic's summary for a bare command word, else the row
 * that documents it (falling back to its parent's row, then the summary, with `exact` false). */
export function helpLine(help: Readonly<Record<string, HelpTopic>>, path: string): { description: string; exact: boolean } {
  const [word, ...rest] = path.split(" ")
  const topic = help[word!]
  if (!topic) return { description: "", exact: false }
  if (rest.length === 0) return { description: topic.summary, exact: true }
  const rows = documentedPaths(topic)
  const find = (p: string) => rows.find((r) => r.paths.includes(p))
  const exact = find(rest.join(" "))
  if (exact) return { description: exact.description, exact: true }
  const parent = rest.length > 1 ? find(rest[0]!) : undefined
  return { description: parent?.description ?? topic.summary, exact: false }
}

/** The first sentence, on one line: up to the first ". " or "; " outside parentheses, less a computed tail (": …"). */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ")
  let depth = 0
  let end = flat.length
  for (let i = 1; i < flat.length - 1; i++) {
    const c = flat[i]!
    if (c === "(") depth++
    else if (c === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === "." || c === ";") && flat[i + 1] === " ") {
      end = i
      break
    }
  }
  return flat.slice(0, end).replace(/\.$/, "").replace(/:? …$/, "")
}

/** Lower-cases a sentence's first letter, but not an acronym's ("API keys", "CNDL"). */
const lowerFirst = (text: string): string => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text)

/** Why a perps write is still coming: perps reads are in, perps trading isn't yet. */
export const PERPS_LATER = "Perps trading comes in a later release. For now the Candle Harness reads perps markets, positions and risk, and doesn't trade them."

/**
 * A prompt-pane row's rule in words: the factor step first (an owner row the CLI runs without
 * unlocking), the CLI asking for the factor itself, the user completing it at the CLI's own prompts,
 * or funds moving out. Undefined for a row that doesn't run in the pane as listed.
 */
function howOf(row: CliRow): string | undefined {
  if (!row.pane || !(PANE_RULES.has(row.rule) || row.pane.needsPrompt)) return undefined
  if (row.rule === "funds-out") return "moves funds"
  if (row.pane.factorFirst) return "owner: the factor first"
  if (row.rule === "ceremony" || unlocksFor(row.path) === "never") return "you complete it in the pane"
  return "the CLI asks for the factor"
}

/** Now: a CLI read or narrowing, done another way (`via`), a CLI card row that isn't held, or an owner row in the prompt pane. */
function availability(row: CliRow): Availability {
  if (row.rule === "never") return "never"
  return row.route === "cli" || row.via !== undefined || (row.card !== undefined && row.card.held === undefined) || paneRowNow(row.rule, row.route) ? "now" : "coming"
}

/** A held row's reason, or perps trading's; every row still coming says why. */
function whyComing(row: CliRow): { why?: string } {
  const held = row.held ?? row.card?.held ?? (row.route === "later" && row.path.startsWith("perps ") ? PERPS_LATER : undefined)
  return held ? { why: held } : {}
}

function build(): CatalogueEntry[] {
  const entries = CLI_ROWS.map((row): CatalogueEntry => {
    const word = row.path.split(" ")[0]!
    const line = helpLine(SOURCE.help, row.path)
    const description = firstSentence(line.description)
    const when = availability(row)
    return {
      path: row.path,
      group: SOURCE.help[word]?.group ?? "",
      description,
      rule: row.rule,
      ruleLabel: RULE_LABELS[row.rule],
      availability: when,
      ...(row.partly ? { partly: row.partly } : {}),
      ...(when === "coming" ? whyComing(row) : {}),
      ...(when === "now" && howOf(row) ? { how: howOf(row)! } : {}),
      ...(when === "now" && row.pane?.confirms.length ? { asks: row.pane.confirms } : {}),
      ...(when === "now" && row.pane?.shows ? { shows: row.pane.shows } : {}),
      // A row the Candle Harness never runs as written but whose narrowing it does (`keys wallets scope`) can still be picked.
      ...(when === "never" ? { note: row.note } : {}),
      ...(when !== "never" || row.byFlags ? { request: row.ask ?? `${lowerFirst(description)} ` } : {}),
      documented: line.exact,
    }
  })
  // The help's group order, and the table's order within each group.
  const rank = (e: CatalogueEntry) => SOURCE.groups.indexOf(e.group)
  return entries.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map(({ e }) => e)
}

export const CATALOGUE: readonly CatalogueEntry[] = build()

/** The entries matching every word of the search, in the path, the line, the group, the rule (in words too) or when. */
export function searchCatalogue(query: string): readonly CatalogueEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return CATALOGUE
  return CATALOGUE.filter((e) => {
    const text = `${e.path} ${e.description} ${e.group} ${e.ruleLabel} ${e.how ?? ""} ${e.availability}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}
