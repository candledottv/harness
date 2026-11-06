// The scorecard's table, from the live runs' results (test/scorecard/results/*.json), in Markdown for
// docs.candle.tv/harness/engines: a column per engine and model, a row per case, then each failure's reason.
//   bun test/scorecard/report.ts
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ENGINE_LABELS, isEngineId } from "../../src/engine/engine"
import { CASES } from "./cases"
import type { CaseResult } from "./run-case"

interface Run {
  engine: string
  model: string | null
  ran: { engineVersion: unknown; model: unknown; answeredModel: unknown } | null
  at: string
  results: CaseResult[]
}

// A run's file, then any `--only` rerun of some of its cases (named "<run> only-<ids>"), newest last: a
// rerun's result for a case replaces the run's. Reruns are for a case whose scoring changed.
const dir = join(import.meta.dir, "results")
const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Run
const runs: Run[] = files
  .filter((f) => !f.includes(" only-"))
  .map((f) => {
    const run = read(f)
    const reruns = files.filter((g) => g.startsWith(`${f.slice(0, -5)} only-`)).map(read).sort((a, b) => a.at.localeCompare(b.at))
    // A case added since the run joins it from the rerun that first ran it.
    for (const rerun of reruns)
      for (const r of rerun.results)
        run.results = run.results.some((x) => x.id === r.id) ? run.results.map((x) => (x.id === r.id ? { ...r, rerun: true } : x)) : [...run.results, { ...r, rerun: true }]
    run.results.sort((x, y) => CASES.findIndex((c) => c.id === x.id) - CASES.findIndex((c) => c.id === y.id))
    // Scored again by the cases as they are now, from the record the run kept.
    run.results = run.results.map((x) => {
      const c = CASES.find((k) => k.id === x.id)
      if (!c || !x.record) return x
      const checks = c.score(x.record)
      return { ...x, checks, pass: checks.every((k) => k.pass) }
    })
    return run
  })
  .sort((a, b) => Object.keys(ENGINE_LABELS).indexOf(a.engine) - Object.keys(ENGINE_LABELS).indexOf(b.engine) || String(a.model).localeCompare(String(b.model)))

const label = (r: Run) => {
  const engine = isEngineId(r.engine) ? ENGINE_LABELS[r.engine] : r.engine
  // The model that answered, as the journal has it; Codex's stream names none, so it's the one asked for.
  const model = String(r.ran?.answeredModel ?? r.ran?.model ?? r.model ?? "its default").replace(/^openrouter\//, "")
  return `${engine} ${r.ran?.engineVersion ?? ""}<br>${model}`
}
const cell = (r: Run, id: string) => {
  const res = r.results.find((x) => x.id === id)
  const mark = !res ? "–" : res.error ? "✗ (didn't run)" : res.pass ? "✓" : "✗"
  return res && (res as { rerun?: boolean }).rerun ? `${mark}¹` : mark
}

const out: string[] = []
out.push(`| Case | ${runs.map(label).join(" | ")} |`)
out.push(`|---|${runs.map(() => "---").join("|")}|`)
for (const c of CASES) out.push(`| ${c.title} | ${runs.map((r) => cell(r, c.id)).join(" | ")} |`)
out.push(`| **Passed** | ${runs.map((r) => `**${r.results.filter((x) => x.pass).length} of ${r.results.length}**`).join(" | ")} |`)
out.push(`| Figures stated, and marked | ${runs.map((r) => `${r.results.reduce((n, x) => n + x.notes.figures, 0)}, ${r.results.reduce((n, x) => n + x.notes.marked, 0)}`).join(" | ")} |`)
out.push(`| Read a skill unprompted (any case) | ${runs.map((r) => r.results.filter((x) => x.notes.skillRead).map((x) => x.id).join(", ") || "no").join(" | ")} |`)
out.push("")
if (runs.some((r) => r.results.some((x) => (x as { rerun?: boolean }).rerun))) {
  out.push("¹ Run again on its own after the Candle Harness or the case's scoring changed; docs.candle.tv/harness/engines says what changed.")
  out.push("")
}
for (const r of runs) {
  const failed = r.results.filter((x) => !x.pass)
  if (!failed.length) continue
  out.push(`**${label(r).replace("<br>", " · ")}:**`)
  out.push("")
  for (const x of failed) {
    const title = CASES.find((c) => c.id === x.id)?.title ?? x.id
    const why = x.error ? `couldn't run: ${x.error}` : x.checks.filter((k) => !k.pass).map((k) => `${k.name} (${k.why})`).join("; ")
    out.push(`- ${title}: ${why}`)
  }
  out.push("")
}
console.log(out.join("\n"))
