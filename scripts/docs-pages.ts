// The docs' generated pages: the keys, the typed commands, every setting, and Candle's
// commands in the Candle Harness, written from the code into the docs site's harness/ folder, so they can't drift from it.
// Each page carries the Candle Harness version it was written from; the docs site checks that against the version it pins.
//
//   bun scripts/docs-pages.ts --write <dir> --release v1.2.3   writes the pages into <dir>, the site's harness/ folder
//   bun scripts/docs-pages.ts <dir>                            checks them against the code, and exits 1 if any differs
//
// The release's checklist runs it against a docs checkout, and a change to keys, typed commands or settings
// opens a docs change with it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { SETTINGS, type SettingDef, type SettingsFile } from "../src/config-settings"
import { parseCommand, TYPED_ROWS, type TypedRow } from "../src/shared/commands"
import { KEYMAP } from "../src/view/keymap"
import { parityBody } from "./cli-parity"
import { KINDS, loadMap, TYPED_CONTEXT } from "./docs-map"
import { releaseVersion } from "./release-files"

/** The pages written, by their path under the site's harness/ folder. */
export const GENERATED = ["reference/keys", "reference/typed-commands", "reference/config", "reference/cli-parity"] as const
export type Generated = (typeof GENERATED)[number]

const DESCRIPTIONS: Record<Generated, string> = {
  "reference/keys": "Every key in the Candle Harness, where it works and what it does.",
  "reference/typed-commands": "What you can type on the Candle Harness's input line, with an example of each.",
  "reference/config": "Every setting in config.toml, layouts.toml, wallets.toml, triggers.toml, bots.toml and a theme of your own.",
  "reference/cli-parity": "Every command of Candle's CLI, and how the Candle Harness and its agent run it.",
}

/** The line after a page's frontmatter naming the version it was written from. */
const stamp = (version: string) => `<!-- candle-harness ${version}. Written by scripts/docs-pages.ts in candledottv/harness from its code: don't edit it here, run that again. -->`
const STAMP = /^<!-- candle-harness (\S+)\. Written by scripts\/docs-pages\.ts/m

/** The version a page was written from, from its stamp. */
export const stampOf = (page: string): string | undefined => STAMP.exec(page)?.[1]

const cell = (text: string) => text.replace(/\|/g, "\\|")
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`
/** Quoted values in a setting's type as code: `"paper"` or `"live"`. */
const quotedAsCode = (text: string) => text.replace(/"[^"]*"/g, (q) => `\`${q}\``)

function keysPage(): string {
  const rows = KEYMAP.map((k) => {
    const palette = k.palette && !k.palette.why ? `"${k.palette.label}"` : ""
    return `| \`${cell(k.chord)}\` | ${cell(k.where ?? "anywhere")} | ${cell(sentence(k.words))} | ${cell(palette)} |`
  })
  return [
    "Every key in the Candle Harness, from the table the Candle Harness itself reads to act on them, so this page and the keys can't differ. `?` with the input line empty shows the same list in the Candle Harness, and the hint line beside the input line says what `⏎` and `esc` do where you are.",
    "",
    "Two rules hold whatever is open. `ctrl-x` twice is the kill switch from anywhere, overlays included. And `⏎` approves a card only with the input line empty, once the card has shown for 300 ms; a pick in the palette never approves one.",
    "",
    "Anything drawn as a chip can be clicked. The last column names the key's row in the palette (`ctrl-k`), where it has one.",
    "",
    "| Key | Where | What it does | In the palette |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n")
}

function typedPage(): string {
  const rows = TYPED_ROWS.map((r) => `| \`${cell(r.form)}\` | \`${cell(r.example)}\` | ${cell(r.words)} |`)
  return [
    "What you can type on the input line. A line that's one of these runs as your own request, and anything else goes to the agent, whole. `?` with the input line empty shows the same list in the Candle Harness.",
    "",
    "The examples use MOON for a token the Candle Harness has shown this session, and agent-a and agent-b for two agents.",
    "",
    "| Command | Example | What it does |",
    "|---|---|---|",
    ...rows,
  ].join("\n")
}

const FILES: { file: SettingsFile; heading: string; about: string }[] = [
  {
    file: "config.toml",
    heading: "config.toml",
    about:
      "Your agents, their limits, and how the Candle Harness runs. An agent's settings are in its own table, `[agents.<name>]`, named for the agent. Setup writes this file, and a problem in it is refused with its line, saying why; a setting the Candle Harness doesn't know is only warned of.",
  },
  {
    file: "layouts.toml",
    heading: "layouts.toml",
    about:
      "Your tabs and your own layouts. The layout menu writes it when you save a layout or tick a tab on or off, and a hand edit is read when the file changes. A problem is named with its line and left out, and a file with a problem is never written over, so a hand edit is never lost.",
  },
  {
    file: "wallets.toml",
    heading: "wallets.toml",
    about:
      "The Candle Harness's own names for wallets, and your wallet groups. The Candle Harness writes it whole when you name a wallet or change a group, so a comment of yours below its header won't survive that. A problem is named with its line and left out, and a file with a problem is never written over.",
  },
  {
    file: "triggers.toml",
    heading: "triggers.toml",
    about:
      "Your triggers: when something happens, what to do. The Candle Harness writes it whole when you approve a trigger's card, or switch or remove one. Set `on = false` to switch one off by hand; any other change holds that trigger until its card is approved again, so nothing adds or widens a trigger but your press. A problem is named with its line and left out, and a file with a problem is never written over.",
  },
  {
    file: "bots.toml",
    heading: "bots.toml",
    about:
      "Your rules bots: a Hacc strategy definition each, run by the Candle Harness, with the agent, wallet and mode it runs as. The Candle Harness writes it whole when you approve a bot's card, or narrow, pause, stop, resume or remove one. Set `state = \"paused\"` or `\"stopped\"` to pause or stop one by hand; any other change holds its entries until its card is approved again, while its exits still sell as it was approved. A problem is named with its line and left out, and a file with a problem is never written over.",
  },
  {
    file: "theme",
    heading: "A theme of your own",
    about:
      "A theme of yours is a file in `themes/` beside config.toml, named for the theme: `themes/Night desk.toml` is the theme Night desk. It names only the colours it changes, and the rest come from its base. Each theme is checked when it loads: one that would make text unreadable, or two meanings alike, isn't used, and says why. A colour or key that isn't right is named with its line and left out.",
  },
]

/** A setting's default as written: a value as code, words as they are. */
function defaultText(s: SettingDef): string {
  try {
    Bun.TOML.parse(`v = ${s.default}`)
    return `\`${s.default}\``
  } catch {
    return s.default
  }
}

function configPage(): string {
  const out: string[] = [
    "Every setting in the files you can edit by hand. They live in `~/.config/candle/harness/`, or in the folder `CANDLE_HARNESS_HOME` names: config.toml, layouts.toml, wallets.toml, triggers.toml and bots.toml side by side, and your themes in `themes/`.",
    "",
    "A setting that says it's where a fresh install starts is only a starting point: once you pick something in the Candle Harness, your pick is kept across restarts.",
  ]
  for (const f of FILES) {
    out.push("", `## ${f.heading}`, "", f.about)
    const settings = SETTINGS.filter((x) => x.file === f.file)
    for (const s of settings.filter((x) => !isColour(x))) {
      out.push("", `### \`${s.key}\``, "", `**Takes:** ${quotedAsCode(s.type)} · **Default:** ${defaultText(s)}`, "", s.words, "", "```toml", s.example.trimEnd(), "```")
    }
    // A theme's colours share a type and a default, so they're one table under one example.
    const colours = settings.filter(isColour)
    if (colours.length) {
      const key = (s: SettingDef) => (s.key.startsWith("reply.") ? `\`${s.key.slice(6)}\` under \`[reply]\`` : `\`${s.key}\``)
      out.push(
        "",
        "### The colours",
        "",
        "Each takes `\"#rrggbb\"`, and one you don't set is the base theme's. The agent's reply has colours of its own, under `[reply]`.",
        "",
        "| Key | What it colours |",
        "|---|---|",
        ...colours.map((s) => `| ${key(s)} | ${cell(s.words)} |`),
        "",
        "```toml",
        THEME_EXAMPLE,
        "```",
      )
    }
  }
  return out.join("\n")
}

const isColour = (s: SettingDef) => s.file === "theme" && s.key !== "base"

/** The configuration page's example theme, which the theme reader takes without a word (docs-pages.test.ts). */
export const THEME_EXAMPLE = `base = "Candle dark"\npane = "#101418"\nattention = "#ffb000"\n\n[reply]\ncode = "#9ecbff"`

const BODIES: Record<Generated, () => string> = {
  "reference/keys": keysPage,
  "reference/typed-commands": typedPage,
  "reference/config": configPage,
  "reference/cli-parity": parityBody,
}

/** Each page as written for `version`: its file under harness/, and its text. */
export function renderPages(version: string): Record<`${Generated}.md`, string> {
  const titles = loadMap().pages
  const pages = {} as Record<`${Generated}.md`, string>
  for (const path of GENERATED) {
    const title = titles[path]
    if (!title) throw new Error(`the docs map has no title for ${path}`)
    pages[`${path}.md`] = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(DESCRIPTIONS[path])}\n---\n\n${stamp(version)}\n\n${BODIES[path]().trimEnd()}\n`
  }
  return pages
}

/** Writes every page into `dir`, the docs site's harness/ folder. */
export function writePages(dir: string, version: string): string[] {
  const written: string[] = []
  for (const [path, text] of Object.entries(renderPages(version))) {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    written.push(path)
  }
  return written
}

/** Each page in `dir` that's missing, unstamped, or no longer what the code writes for its version. */
export function pageProblems(dir: string): string[] {
  const problems: string[] = []
  for (const path of GENERATED) {
    const file = join(dir, `${path}.md`)
    if (!existsSync(file)) {
      problems.push(`${path}.md is missing`)
      continue
    }
    const text = readFileSync(file, "utf8")
    const version = stampOf(text)
    if (!version) {
      problems.push(`${path}.md has no candle-harness stamp, so it wasn't written by this script`)
      continue
    }
    if (text !== renderPages(version)[`${path}.md`]) problems.push(`${path}.md isn't what the code writes for candle-harness ${version}: run bun scripts/docs-pages.ts --write`)
  }
  return problems
}

/** Each way the typed rows and the input line disagree: an example that isn't its row's kind, or a kind with no row. */
export function typedProblems(rows: readonly TypedRow[]): string[] {
  const problems: string[] = []
  const covered = new Set<string>()
  for (const r of rows) {
    const command = parseCommand(r.example, TYPED_CONTEXT)
    if (!command || !r.kinds.includes(command.kind)) problems.push(`${r.form}: its example "${r.example}" is ${command ? `a ${command.kind} command${command.kind === "refused" ? ` (${command.message})` : ""}` : "an empty line"}, not ${r.kinds.join(" or ")}`)
    for (const k of r.kinds) covered.add(k)
  }
  for (const kind of Object.keys(KINDS)) if (!covered.has(kind)) problems.push(`the input line takes ${kind} commands, and no typed row covers them`)
  return problems
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf("--release")
  const tag = at >= 0 ? args[at + 1] : undefined
  const write = args.includes("--write")
  const dir = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1))
  if (!dir) {
    console.error("usage: bun scripts/docs-pages.ts [--write --release v1.2.3] <the docs site's harness/ folder>")
    process.exit(2)
  }
  if (write) {
    if (!tag) {
      console.error("--write takes --release v1.2.3, the version the pages are stamped with")
      process.exit(2)
    }
    for (const path of writePages(dir, releaseVersion(tag))) console.log(`wrote ${path}`)
  }
  const problems = [...typedProblems(TYPED_ROWS), ...pageProblems(dir)]
  for (const p of problems) console.error(p)
  if (problems.length) process.exit(1)
}
