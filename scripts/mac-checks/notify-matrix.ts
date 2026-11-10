// The notification matrix: which notifications reach the person from this terminal, and whether it reports
// focus. Run it bare and inside tmux or cmux, in each terminal to check.
//
//   notify-matrix [--out <file.jsonl>]
//   keys: 1 the terminal's own (OSC, as OpenTUI picks), 2 the bell, 3 the computer's own, 4 the Candle Harness's own path
//   (what the main view sends in the background, by `auto`), a all four in turn after 5 s, q quit
//
// Each firing is a JSON line in --out: the terminal, tmux or cmux, our remote check, OpenTUI's capability report,
// the focus state then, and what each kind answered. Whether it showed is the person's to say, by the number on it.
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core"
import { cleanNotificationText, isRemote, noticeOf, osNotifyCommand, pickNotifier } from "../../src/shared/notify"
import { ViewNotifier } from "../../src/view/notify-view"

const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const C = { dim: "#7a8194", text: "#d8dce6", focus: "#ffaa3c", ok: "#5fd38d", bad: "#ff6b6b" }
/** A name that carries what a token's name could: quotes, a backslash, an escape. */
const HOSTILE = 'MOON "pump" \\ \u001b]0;x\u0007'

export async function main(): Promise<void> {
  const out = resolve(flag("--out") ?? `notify-matrix-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}.jsonl`)
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: false })
  const root = new BoxRenderable(renderer, { id: "root", width: "100%", height: "100%", flexDirection: "column", padding: 1 })
  const line = (id: string, fg = C.text) => {
    const t = new TextRenderable(renderer, { id, content: "", fg })
    root.add(t)
    return t
  }
  const title = line("title", C.focus)
  const ident = line("ident")
  const remoteLine = line("remote")
  const caps = line("caps")
  const focusLine = line("focus")
  const pick = line("pick", C.dim)
  line("gap1")
  const help = line("help", C.dim)
  line("gap2")
  const log: TextRenderable[] = Array.from({ length: 10 }, (_, i) => line(`log${i}`))
  renderer.root.add(root)

  const remote = isRemote(process.env)
  const remoteWhy = process.env.SSH_CONNECTION || process.env.SSH_TTY ? "SSH" : process.env.SANDBOX_VM_ID ? "a sandbox VM" : remote ? "container marker" : "none"
  let focused: boolean | null = null
  let focusEvents = 0
  const entries: { text: string; fg: string }[] = []
  const terminal = { program: process.env.TERM_PROGRAM ?? null, version: process.env.TERM_PROGRAM_VERSION ?? null, term: process.env.TERM ?? null, tmux: !!process.env.TMUX, cmux: Object.keys(process.env).some((k) => k.startsWith("CMUX_")) }

  const record = (text: string, fg = C.text) => {
    entries.unshift({ text: `${new Date().toLocaleTimeString()}  ${text}`, fg })
    entries.length = Math.min(entries.length, log.length)
    log.forEach((t, i) => {
      t.content = entries[i]?.text ?? ""
      t.fg = entries[i]?.fg ?? C.text
    })
  }
  const write = (kind: string, answer: Record<string, unknown>) => {
    const c = renderer.capabilities
    appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), n, kind, terminal, remote, focused, focusEvents, opentui: c ? { terminal: c.terminal, notifications: c.notifications, focus_tracking: c.focus_tracking, remote: c.remote, multiplexer: c.multiplexer } : null, ...answer })}\n`, { mode: 0o600 })
  }

  const draw = () => {
    title.content = "Candle Harness: the notification matrix"
    ident.content = `TERM_PROGRAM=${terminal.program ?? "-"} ${terminal.version ?? ""}   TERM=${terminal.term ?? "-"}   tmux=${terminal.tmux ? "yes" : "no"}   cmux=${terminal.cmux ? "yes" : "no"}`
    remoteLine.content = `remote (ours): ${remote} (${remoteWhy})`
    const c = renderer.capabilities
    caps.content = c
      ? `OpenTUI: terminal=${c.terminal?.name ?? "?"} ${c.terminal?.version ?? ""}  notifications=${c.notifications}  focus_tracking=${c.focus_tracking}  remote=${c.remote}  multiplexer=${JSON.stringify(c.multiplexer)}`
      : "OpenTUI: capabilities not reported yet"
    focusLine.content = `focus: ${focused === null ? "unknown (no event yet)" : focused ? "FOCUSED" : "in the background"}   focus events so far: ${focusEvents}`
    focusLine.fg = focused === null ? C.dim : focused ? C.ok : C.focus
    pick.content = `auto would send: ${pickNotifier("auto", { remote, focused }) ?? "nothing (focused)"}   log: ${out}`
    help.content = "1 terminal's own (OSC)   2 bell   3 computer's own   4 the Candle Harness's own path   a all four in turn after 5 s   q quit"
  }

  // The Candle Harness's own path, as the main view runs it: never while focused, then its fallbacks.
  const view = new ViewNotifier({
    env: process.env,
    platform: process.platform,
    now: Date.now,
    spawn: async (argv) => ({ exitCode: await Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited }),
    osc: (t, b) => renderer.triggerNotification(b, t),
    bell: () => void process.stdout.write("\x07"),
  })

  renderer.on("focus", () => {
    focused = true
    focusEvents++
    view.focus(true)
    draw()
  })
  renderer.on("blur", () => {
    focused = false
    focusEvents++
    view.focus(false)
    draw()
  })
  renderer.on("capabilities", () => draw())

  let n = 0
  const fire = async (kind: "terminal" | "bell" | "os" | "harness") => {
    n++
    const label = `#${n} ${kind}`
    if (kind === "terminal") {
      const ok = renderer.triggerNotification(cleanNotificationText(`Candle matrix: ${label} ${HOSTILE}`), "Candle Harness")
      record(`${label}: OpenTUI ${ok ? "accepted it" : "refused it (no supported protocol?)"}`, ok ? C.text : C.bad)
      write(kind, { accepted: ok })
    } else if (kind === "bell") {
      process.stdout.write("\x07")
      record(`${label}: BEL written`)
      write(kind, { written: true })
    } else if (kind === "os") {
      const platform = process.platform === "darwin" ? "darwin" : "linux"
      const argv = osNotifyCommand(platform, `Candle Harness ${HOSTILE}`, `Candle matrix: ${label}`)
      try {
        const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" })
        const err = r.stderr.toString().trim().split("\n")[0] ?? ""
        record(`${label}: ${argv[0]} exit ${r.exitCode}${err ? `: ${err.slice(0, 90)}` : ""}`, r.exitCode === 0 ? C.text : C.bad)
        write(kind, { via: argv[0], exitCode: r.exitCode, error: err })
      } catch (error) {
        record(`${label}: ${argv[0]} couldn't start: ${(error as Error).message}`, C.bad)
        write(kind, { via: argv[0], error: (error as Error).message })
      }
    } else {
      await view.event({ notice: noticeOf("triggers", `Candle matrix: ${label}, the Candle Harness's own path`) })
      const last = view.sent.at(-1)
      const sent = last?.notice.body.includes(label) ? last.via : "nothing (focused)"
      record(`${label}: the Candle Harness's path sent ${sent}`, sent === "none" ? C.bad : C.text)
      write(kind, { sent })
    }
  }

  let busy = false
  const allInTurn = async () => {
    if (busy) return
    busy = true
    for (let s = 5; s > 0; s--) {
      record(`firing all four in ${s} s: switch to another window now to test the background`, C.dim)
      await Bun.sleep(1000)
    }
    for (const kind of ["terminal", "bell", "os", "harness"] as const) {
      await fire(kind)
      await Bun.sleep(3000)
    }
    busy = false
  }

  await new Promise<void>((done) => {
    const quit = () => {
      renderer.destroy()
      done()
    }
    renderer.prependInputHandler((seq) => {
      if (seq === "q" || seq === "\x03") quit()
      else if (seq === "1") void fire("terminal")
      else if (seq === "2") void fire("bell")
      else if (seq === "3") void fire("os")
      else if (seq === "4") void fire("harness")
      else if (seq === "a") void allInTurn()
      else return false
      return true
    })
    for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, quit)
    setInterval(draw, 1000).unref()
    draw()
  })
  console.log(`notify-matrix: ${n} firings logged to ${out}`)
}

if (import.meta.main) await main()
