// The long paste (a long paste once lost 78 characters in five gaps):
// a fixed 4 KB line pasted ten times into the shipped binary's input line, each paste as the view received
// it diffed against the line. The view logs what arrives when started with CANDLE_HARNESS_PASTE_LOG (run.tsx),
// so nothing is sent to the agent and no turn runs.
//
// Start the view with the log on, in the terminal under test:
//   CANDLE_HARNESS_PASTE_LOG=<abs path> candle-harness
// Then, from another terminal:
//   long-paste --log <abs path> --via tmux --target <pane>      tmux's bracketed paste-buffer
//   long-paste --log <abs path> --via cmux --surface <ref>      cmux's Cmd+V path (`cmux paste`)
//   long-paste --log <abs path> --via clipboard                  the clipboard: you press Cmd+V each time
// It clears the line between pastes (Esc twice; by hand on the clipboard route), and writes a report
// beside the log. Exit 0 when all ten arrived whole.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { createInterface } from "node:readline/promises"

/** The line: 4096 printable ASCII characters with no stretch repeating nearby, so a dropped run shows where it was. */
export const LINE = Array.from({ length: 4096 }, (_, i) => String.fromCharCode(33 + ((i * 7 + Math.floor(i / 94)) % 94))).join("")

/** Where `got` differs from `want`: the stretches of `want` missing from it, and anything added. */
export function gaps(want: string, got: string): { at: number; missing: number }[] {
  const out: { at: number; missing: number }[] = []
  let i = 0
  let j = 0
  const KEY = 12
  while (i < want.length && j < got.length) {
    if (want[i] === got[j]) {
      i++
      j++
      continue
    }
    // The next stretch of what arrived, found further on in the line: what's between was dropped.
    const next = want.indexOf(got.slice(j, j + KEY), i)
    if (next < 0) {
      out.push({ at: i, missing: -1 })
      return out
    }
    out.push({ at: i, missing: next - i })
    i = next
  }
  if (i < want.length) out.push({ at: i, missing: want.length - i })
  if (j < got.length) out.push({ at: want.length, missing: -(got.length - j) })
  return out
}

interface Logged {
  at: number
  length: number
  sha256: string
  text: string
}

function readLog(file: string): Logged[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Logged)
}

const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function run(cmd: string[], input?: string): void {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { input, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`)
}

/** A cmux call, once more if its socket closed before it replied. */
function retried(cmd: string[], input?: string): void {
  try {
    run(cmd, input)
  } catch {
    run(cmd, input)
  }
}

export async function main(): Promise<void> {
  const log = flag("--log")
  const via = flag("--via") ?? "tmux"
  const count = Number(flag("--count") ?? 10)
  if (!log || !isAbsolute(log)) throw new Error("--log takes the absolute path the view was started with, as CANDLE_HARNESS_PASTE_LOG")
  const target = flag("--target")
  const surface = flag("--surface")
  if (via === "tmux" && !target) throw new Error("--via tmux takes --target <pane>, the view's tmux pane")
  if (via === "cmux" && !surface) throw new Error("--via cmux takes --surface <ref>, the view's cmux surface")
  const lineFile = join(dirname(log), "long-paste-line.txt")
  writeFileSync(lineFile, LINE)
  const rl = via === "clipboard" ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
  const clear = () => {
    if (via === "tmux") run(["tmux", "send-keys", "-t", target!, "Escape", "Escape"])
    if (via === "cmux") for (let k = 0; k < 2; k++) retried(["cmux", "send-key", "--surface", surface!, "escape"])
  }
  const results: { n: number; length?: number; whole: boolean; gaps: { at: number; missing: number }[]; ms?: number }[] = []
  for (let n = 1; n <= count; n++) {
    const before = readLog(log).length
    const sent = Date.now()
    if (via === "tmux") {
      run(["tmux", "load-buffer", "-b", "chrn-long-paste", lineFile])
      run(["tmux", "paste-buffer", "-p", "-b", "chrn-long-paste", "-t", target!])
    } else if (via === "cmux") {
      // cmux's socket can close before it replies ("Socket closed before reply"): once more, then it's the result.
      try {
        run(["cmux", "paste", "--surface", surface!], LINE)
      } catch {
        await Bun.sleep(1_000)
        if (readLog(log).length === before) run(["cmux", "paste", "--surface", surface!], LINE)
      }
    } else {
      // Copied again each time, in case anything else was copied between pastes.
      run(["pbcopy"], LINE)
      await rl!.question(`Paste ${n} of ${count}: in the Candle Harness, click its input line and press Cmd+V, then Esc twice there. Then come back here and press Enter. `)
    }
    let got: Logged | undefined
    while (!(got = readLog(log)[before]) && Date.now() - sent < (via === "clipboard" ? 60_000 : 10_000)) await Bun.sleep(100)
    if (!got && n === 1) console.log(`Nothing reached ${log}: was the Candle Harness started with CANDLE_HARNESS_PASTE_LOG=${log}, and did the paste go into its input line?`)
    if (!got) results.push({ n, whole: false, gaps: [{ at: 0, missing: LINE.length }] })
    else results.push({ n, length: got.text.length, whole: got.text === LINE, gaps: got.text === LINE ? [] : gaps(LINE, got.text), ms: got.at - sent })
    const r = results.at(-1)!
    console.log(`paste ${n}: ${r.length === undefined ? "nothing arrived" : r.whole ? "whole" : `${r.length} of ${LINE.length} characters, ${r.gaps.map((g) => (g.missing < 0 ? `${-g.missing} extra at ${g.at}` : `${g.missing} missing at ${g.at}`)).join(", ")}`}`)
    if (via !== "clipboard") {
      await Bun.sleep(500)
      clear()
      await Bun.sleep(500)
    }
  }
  rl?.close()
  const whole = results.filter((r) => r.whole).length
  const report = [
    `# Long paste: ${whole} of ${count} whole`,
    "",
    `${new Date().toISOString()}, by ${via}. The line is ${LINE.length} characters (long-paste-line.txt); each paste as the view received it is in ${log}.`,
    "",
    "| Paste | Arrived | Whole | Gaps |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.n} | ${r.length ?? "nothing"} | ${r.whole ? "yes" : "**no**"} | ${r.gaps.map((g) => (g.missing < 0 ? `${-g.missing} extra at ${g.at}` : `${g.missing} missing at ${g.at}`)).join(", ") || "—"} |`),
    "",
  ].join("\n")
  const out = join(dirname(log), "long-paste-report.md")
  writeFileSync(out, report)
  console.log(`\n${whole} of ${count} whole. Written: ${out}`)
  process.exit(whole === count ? 0 : 1)
}

if (import.meta.main) await main()
