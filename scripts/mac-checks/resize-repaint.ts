// The resize repaint (a narrowed split once kept stale cells): a split holding the Candle Harness is
// narrowed in steps, and at each step the frame is captured twice, half a second and two seconds after the
// resize, so a cell the terminal kept and the view didn't repaint shows as a difference, or as text past a
// border. The view forces a full repaint 250 ms after a resize settles, so both captures should match.
//
//   resize-repaint --via tmux --target <pane> [--from 140] [--to 40] [--step 10] [--out <folder>]
//   resize-repaint --via cmux --pane <ref> --surface <ref> [--direction L|R] [--amount 5] [--steps 12] [--to 40] [--out <folder>]
// tmux sets each width itself (reference frames, for comparing). cmux's resize-pane moves the split by an
// amount, so the width at each step is read from the screen; a screenshot of the window is kept at each
// step too (`cmux shot`), since stale cells are easiest to see. Which way narrows the Candle Harness depends on which side
// of the split it sits, so a step that widens it turns the split the other way, and the run ends once the Candle Harness
// stops narrowing or reaches --to. An index.md lists every step.
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function run(cmd: string[]): string {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`)
  return r.stdout
}

/**
 * The two captures' first differing line, digits aside (a clock or an age ticking isn't a repaint), with
 * both versions to read; and lines whose text runs past the frame's width.
 */
export function compare(early: string, late: string, width: number): { same: boolean; firstDiff?: number; lines?: [string, string]; tooWide: number[] } {
  const a = early.split("\n")
  const b = late.split("\n")
  const shape = (l: string | undefined) => (l ?? "").trimEnd().replace(/\d+/g, "0").replace(/ +/g, " ")
  let firstDiff: number | undefined
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (shape(a[i]) !== shape(b[i])) {
    firstDiff = i + 1
    break
  }
  const tooWide = b.flatMap((line, i) => ([...line.trimEnd()].length > width ? [i + 1] : []))
  if (firstDiff === undefined) return { same: true, tooWide }
  return { same: false, firstDiff, lines: [(a[firstDiff - 1] ?? "").trimEnd(), (b[firstDiff - 1] ?? "").trimEnd()], tooWide }
}

/**
 * After a cmux step, which way the split moves next: a step that widened the Candle Harness turns it the other way (once);
 * a step that left it no narrower after that, or at `to` columns or fewer, ends the run.
 */
export function steer(was: number, now: number, direction: "L" | "R", turned: boolean, to: number): { direction: "L" | "R"; turned: boolean; note?: string; stop?: string } {
  const other = direction === "L" ? "R" : "L"
  if (now > was && !turned) return { direction: other, turned: true, note: `-${direction} widened the Candle Harness (${was} to ${now} columns), so the split moves -${other} from here` }
  if (now >= was) return { direction, turned, stop: `the Candle Harness stopped narrowing at ${now} columns` }
  if (now <= to) return { direction, turned, stop: `the Candle Harness is at ${now} columns, --to ${to}` }
  return { direction, turned }
}

export async function main(): Promise<void> {
  const via = flag("--via") ?? "tmux"
  const out = resolve(flag("--out") ?? `resize-repaint-${via}-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}`)
  mkdirSync(out, { recursive: true })
  const rows: string[] = []
  const notes: string[] = []
  const step = async (n: number, setWidth: () => void, read: () => string, width: () => number, shot?: (file: string) => void): Promise<number> => {
    setWidth()
    await Bun.sleep(500)
    const early = read()
    await Bun.sleep(1500)
    const late = read()
    const w = width()
    writeFileSync(join(out, `${String(n).padStart(2, "0")}-w${w}-early.txt`), early)
    writeFileSync(join(out, `${String(n).padStart(2, "0")}-w${w}-late.txt`), late)
    if (shot) shot(join(out, `${String(n).padStart(2, "0")}-w${w}.png`))
    const c = compare(early, late, w)
    const cell = (t: string) => `\`${t.trim().replaceAll("|", "\\|").replaceAll("`", "'")}\``
    rows.push(`| ${n} | ${w} | ${c.same ? "yes" : `**no**, from line ${c.firstDiff}: ${cell(c.lines![0])} then ${cell(c.lines![1])}`} | ${c.tooWide.length ? `**lines ${c.tooWide.join(", ")}**` : "none"} |`)
    console.log(`step ${n}: ${w} columns, ${c.same ? "repainted by 0.5 s" : `changed after 0.5 s from line ${c.firstDiff}`}${c.tooWide.length ? `, text past the width on ${c.tooWide.length} lines` : ""}`)
    return w
  }
  if (via === "tmux") {
    const target = flag("--target")
    if (!target) throw new Error("--via tmux takes --target <pane>")
    const from = Number(flag("--from") ?? 140)
    const to = Number(flag("--to") ?? 40)
    const by = Number(flag("--step") ?? 10)
    let n = 0
    for (let w = from; w >= to; w -= by) {
      await step(++n, () => run(["tmux", "resize-pane", "-t", target, "-x", String(w)]), () => run(["tmux", "capture-pane", "-p", "-t", target]), () => Number(run(["tmux", "display", "-p", "-t", target, "#{pane_width}"]).trim()))
    }
  } else if (via === "cmux") {
    const pane = flag("--pane")
    const surface = flag("--surface")
    if (!pane || !surface) throw new Error("--via cmux takes --pane <ref> (the split to resize) and --surface <ref> (the Candle Harness's terminal)")
    let direction: "L" | "R" = flag("--direction") === "L" ? "L" : "R"
    let turned = false
    const amount = flag("--amount") ?? "5"
    const steps = Number(flag("--steps") ?? 12)
    const to = Number(flag("--to") ?? 40)
    const read = () => run(["cmux", "read-screen", "--surface", surface])
    const width = () => Math.max(...read().split("\n").map((l) => [...l.trimEnd()].length))
    let was = width()
    for (let n = 1; n <= steps; n++) {
      const dir = direction
      const now = await step(n, () => run(["cmux", "resize-pane", "--pane", pane, `-${dir}`, "--amount", amount]), read, width, (file) => {
        // A screenshot is a help, not the check: by --out, else wherever cmux puts it (it prints the path).
        try {
          run(["cmux", "shot", "--out", file])
        } catch {
          try {
            writeFileSync(`${file}.where.txt`, run(["cmux", "shot"]))
          } catch {}
        }
      })
      const next = steer(was, now, direction, turned, to)
      if (next.note) {
        notes.push(`After step ${n}: ${next.note}.`)
        console.log(next.note)
      }
      if (next.stop) {
        notes.push(`Ended after step ${n}: ${next.stop}.`)
        console.log(next.stop)
        break
      }
      ;({ direction, turned } = next)
      was = now
    }
  } else throw new Error("--via takes tmux or cmux")
  writeFileSync(
    join(out, "index.md"),
    [`# Resize repaint, by ${via}`, "", `${new Date().toISOString()}. Each step's frame half a second and two seconds after the resize; they should match (digits aside, since ages and clocks tick), and no text should run past the width. A line that differs is shown both ways: new data arriving is fine, a fragment of an old frame is the bug`, "", "| Step | Columns | Same at 0.5 s and 2 s | Text past the width |", "|---|---|---|---|", ...rows, "", ...notes, ...(notes.length ? [""] : [])].join("\n"),
  )
  console.log(`\nWritten: ${join(out, "index.md")}`)
}

if (import.meta.main) await main()
