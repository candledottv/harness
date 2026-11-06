// The Mac checks, as one binary for a test Mac: mac-checks <check> [flags].
//   hold-check       each engine's own file tools and shell, aimed outside the folder by a scripted model
//   long-paste       a 4 KB line pasted ten times into the view's input line, diffed
//   sampler          CPU, memory, fetches and the journal, once a minute for hours
//   resize-repaint   a split narrowed in steps, each frame captured twice
import { main as holdCheck } from "./hold-check"
import { main as longPaste } from "./long-paste"
import { main as resizeRepaint } from "./resize-repaint"
import { main as sampler } from "./sampler"

const CHECKS: Record<string, { run: () => Promise<void>; usage: string }> = {
  "hold-check": { run: holdCheck, usage: "hold-check [--engines claude-code,codex,grok,opencode,pi] [--out <folder>] [--candle-harness <path>]" },
  "long-paste": { run: longPaste, usage: "long-paste --log <abs path> --via tmux --target <pane> | --via cmux --surface <ref> | --via clipboard" },
  sampler: { run: sampler, usage: "sampler [--hours 12] [--every 60] [--out <file.jsonl>]  |  sampler --summarise <file.jsonl>" },
  "resize-repaint": { run: resizeRepaint, usage: "resize-repaint --via tmux --target <pane> | --via cmux --pane <ref> --surface <ref> [--direction L|R] [--amount 5] [--steps 12]" },
}
const check = process.argv[2]
const entry = check ? CHECKS[check] : undefined
if (!entry) {
  console.error(`mac-checks <check> [flags]:\n${Object.values(CHECKS).map((c) => `  mac-checks ${c.usage}`).join("\n")}`)
  process.exit(2)
}
const run = entry.run
// Each check reads its flags from process.argv, as when it's run on its own.
process.argv.splice(2, 1)
// Any error in one line: uncaught, Bun printed the bundled source around it.
try {
  await run()
} catch (error) {
  console.error(`mac-checks ${check}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
