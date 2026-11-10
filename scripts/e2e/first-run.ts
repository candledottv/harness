// The first-run script: the shipped binary driven through install and setup against real Candle, step by step,
// checking each screen for the words the code draws (screens.ts). It stops at the first step whose screen doesn't
// come, with the screen kept, so a build is run end to end before a person tries it.
//
//   bun scripts/e2e/first-run.ts start --route install|main [--release <folder>] [--size 120x34] [--account <address>]
//   first-run start --route mac --surface <ref> --release <folder> --out <folder> [--account <address>]   (the compiled binary, on the Mac)
//   bun scripts/e2e/first-run.ts resume --run <folder> [--at <step>]
//   first-run probe --surface <ref>   (cmux's words and keys, before anything is installed)
//
// Routes:
//   install  (tmux, Linux) a new Linux user with nothing: install.sh from the release folder, the CLI on a
//            yes, the PATH line as printed, then setup up to its engine step, where the harness isn't installed;
//            it's installed while setup is open and must be found within 3 s.
//   main     (tmux, Linux) this user's own Claude Code, signed in, with a fresh Candle Harness home and CLI profile
//            folder: all of setup, then the Candle Harness.
//   mac      (cmux, a Mac) a fresh macOS user's terminal: both of the above in one, with the harness's
//            real installer and its own sign-in a person's step. scripts/e2e/mac/ starts it: see its go.sh.
//
// A person's step (a device code to approve, the Agent Console, a deposit) ends the run with exit 3 and says what
// to do, in the terminal and in the run's pause.md; `resume` carries on from the next step once it's done. Every run
// writes run.md (each step, its time, pass or fail) and each step's screen beside it, in the run's folder under
// test/fixtures/raw/e2e/ (git-ignored: it holds an account's addresses).
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { MIN_CANDLE_CLI } from "../../src/setup/doctor"
import { testRelease } from "../install-switch"
import { PICKS, SCREENS } from "./screens"
import { CmuxTerm, type KeyName, type Term, TmuxTerm } from "./term"

type Route = "install" | "main" | "mac"

interface RunState {
  route: Route
  via: "tmux" | "cmux"
  /** The tmux target or cmux surface the Candle Harness runs in. */
  target: string
  /** A second terminal for side commands, on the tmux routes. */
  side?: string
  release?: string
  /** The new Linux user, on the install route. */
  user?: string
  /** Where the Candle Harness's home and the CLI's profiles are, on the main route. */
  home?: string
  next: number
  /** What steps read off the screen for later ones: a device code, a key prefix, an address. */
  data: Record<string, string>
  startedAt: string
}

class Paused extends Error {}
class StepFailed extends Error {}

const APP = resolve(import.meta.dir, "../..")
const PROMPT = "e2e$ "
/** How this script is started again: the compiled binary on the Mac (no Bun or repo there), else from the repo. */
const SELF = import.meta.path.startsWith("/$bunfs") ? process.execPath : "bun scripts/e2e/first-run.ts"

function sh(cmd: string[], opts: { input?: string; allowFail?: boolean } = {}): string {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { input: opts.input, encoding: "utf8" })
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`)
  return r.stdout
}

/** The step's working context: the terminal, the run's folder, and the checks a step is made of. */
class Ctx {
  constructor(
    readonly term: Term,
    readonly dir: string,
    readonly state: RunState,
    readonly stepId: string,
  ) {}

  get data(): Record<string, string> {
    return this.state.data
  }
  type(text: string): void {
    this.term.type(text)
  }
  key(name: KeyName, times = 1): void {
    this.term.key(name, times)
  }
  /** A shell line, typed and sent. */
  line(text: string): void {
    this.term.type(text)
    this.term.key("enter")
  }
  screen(): string {
    return this.term.screen()
  }
  keep(suffix: string, screen = this.screen()): string {
    const file = join(this.dir, `${String(this.state.next).padStart(2, "0")}-${this.stepId}${suffix ? `-${suffix}` : ""}.txt`)
    writeFileSync(file, screen)
    return file
  }

  /** Waits until the screen holds every word (and none of `absent`), or fails with the screen kept. */
  async expect(words: readonly string[], opts: { timeout?: number; absent?: readonly string[]; what?: string } = {}): Promise<string> {
    const until = Date.now() + (opts.timeout ?? 20_000)
    let screen = ""
    while (Date.now() < until) {
      screen = this.screen()
      if (words.every((w) => screen.includes(w)) && !(opts.absent ?? []).some((w) => screen.includes(w))) return screen
      await Bun.sleep(250)
    }
    const missing = words.filter((w) => !screen.includes(w))
    const present = (opts.absent ?? []).filter((w) => screen.includes(w))
    throw new StepFailed(`${opts.what ?? "the screen"} didn't come in ${((opts.timeout ?? 20_000) / 1000).toFixed(0)} s: ${missing.length ? `missing ${missing.map((w) => JSON.stringify(w)).join(", ")}` : ""}${present.length ? `${missing.length ? "; " : ""}still showing ${present.map((w) => JSON.stringify(w)).join(", ")}` : ""}`)
  }

  /** Waits for a pattern, and returns its first group (or the match). */
  async match(re: RegExp, opts: { timeout?: number; what?: string } = {}): Promise<string> {
    const until = Date.now() + (opts.timeout ?? 20_000)
    while (Date.now() < until) {
      const m = re.exec(this.screen())
      if (m) return m[1] ?? m[0]
      await Bun.sleep(250)
    }
    throw new StepFailed(`${opts.what ?? String(re)} didn't show in ${((opts.timeout ?? 20_000) / 1000).toFixed(0)} s`)
  }

  /**
   * Picks a menu row by its words: ↓ until the highlighted row ("▸ " then the words) is it, then ⏎. The Setup
   * rail marks its step with ▸ too, so on a wide screen only the step box (from column 30) counts.
   */
  async pick(label: string, opts: { enter?: boolean } = {}): Promise<void> {
    let missingSince: number | undefined
    for (let i = 0; i < 60; i++) {
      const screen = this.screen()
      const wide = screen.split("\n").some((l) => [...l].length >= 100)
      const on = screen.split("\n").some((l) => {
        const at = [...l].join("").indexOf(`▸ ${label}`)
        return at >= 0 && (!wide || [...l.slice(0, at)].length >= 29)
      })
      if (on) {
        if (opts.enter !== false) this.key("enter")
        return
      }
      // Rows still landing (a model list being read) can hide the one wanted for a moment.
      if (!screen.includes(label)) {
        missingSince ??= Date.now()
        if (Date.now() - missingSince > 5_000) throw new StepFailed(`no row "${label}" to pick`)
        await Bun.sleep(250)
        continue
      }
      missingSince = undefined
      this.key("down")
      await Bun.sleep(150)
    }
    throw new StepFailed(`the highlight never reached "${label}"`)
  }

  /** A person's step: said here and in pause.md, then the run stops (exit 3) until `resume`. */
  pause(words: string): never {
    writeFileSync(join(this.dir, "pause.md"), `# Waiting for a person\n\n${words}\n\nThen: ${SELF} resume --run ${this.dir}\n`)
    throw new Paused(words)
  }

  /** The core's journal, read from its file: what really went through, whatever the screen says. */
  journal(): Record<string, unknown>[] {
    const file = join(this.state.home ? join(this.state.home, "harness") : join(homedir(), ".config/candle/harness"), "state/journal.jsonl")
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  /** A shell command run beside the Candle Harness, as the user under test. */
  side(cmd: string): string {
    if (this.state.user) return sh(["sudo", "-u", this.state.user, "-i", "bash", "-c", cmd])
    return sh(["bash", "-lc", cmd])
  }
}

interface Step {
  id: string
  title: string
  run: (c: Ctx) => Promise<void>
}

/**
 * How the Candle Harness is started. `candle tui` is the shipped line, but the CLI builds its environment from empty and proxy
 * settings aren't among what it keeps (commands/tui.ts PASSED). Behind a proxy the sign-in works only through the
 * proxy, and a Claude Code turn without it wipes the login, so the main route starts `candle-harness` itself. The install
 * route sends no model turn, and the Mac has no proxy, so both keep the shipped line.
 */
const startLine = (state: RunState): string => (state.route === "main" ? "candle-harness" : "candle tui")

// --- The steps -------------------------------------------------------------------------------------------------

/** An account as setup's rail shortens it, from a full address or `ABCD…WXYZ` (or `...`). */
export function shortAccount(a: string): string {
  const s = a.trim().replace("...", "…")
  return s.includes("…") ? s : `${s.slice(0, 4)}…${s.slice(-4)}`
}

/** The account setup's rail says it signed in as: `Made…Wxyz · candle-harness` under "Sign in to Candle". */
export function signedInAs(screen: string): string | undefined {
  const m = /\b([1-9A-HJ-NP-Za-km-z]{4})…([1-9A-HJ-NP-Za-km-z]{4}) · /.exec(screen)
  return m ? `${m[1]}…${m[2]}` : undefined
}

/** The line install.sh prints: `export PATH=…` for bash, `path=(…)` for zsh, the Mac's shell. */
export const PATH_LINE = /^echo '(export PATH=|path=\().*' >> ~\/\.(bashrc|zshrc)/

const installSteps: Step[] = [
  {
    id: "install",
    title: "install.sh from the release folder, the CLI on a yes",
    async run(c) {
      const rel = c.state.release!
      c.line(`CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING=1 bash ${rel}/install.sh --from ${rel}`)
      await c.expect(["This can install Candle's CLI"], { timeout: 60_000, what: "the offer to install the CLI" })
      c.keep("offer")
      c.line("y")
      await c.expect(["isn't on your PATH. Add it with:"], { timeout: 180_000, what: "the PATH line" })
    },
  },
  {
    id: "path-line",
    title: "the PATH line run exactly as printed",
    async run(c) {
      const printed = c.screen().split("\n").map((l) => l.trim()).find((l) => PATH_LINE.test(l))
      if (!printed) throw new StepFailed("no PATH line to copy on the screen")
      c.data.pathLine = printed
      c.line(printed)
      // Between markers the typed line doesn't hold, so text left from the install can't pass for the answer.
      c.line(`clear; export PS1='${PROMPT}'; echo "E2E""-A"; candle-harness version; candle --version; echo "E2E""-B"`)
      // 60 s: macOS scans a new binary the first time it runs.
      const between = await c.match(/^E2E-A$([\s\S]*?)^E2E-B$/m, { timeout: 60_000, what: "the two versions" })
      c.data.versions = between.trim().replace(/\s*\n\s*/g, " · ")
      if (!/candle-harness/.test(between) || !between.includes(MIN_CANDLE_CLI)) throw new StepFailed(`expected candle-harness's version and candle ${MIN_CANDLE_CLI}, got: ${c.data.versions}`)
    },
  },
]

const launch: Step = {
  id: "launch",
  title: "candle tui opens setup's welcome",
  async run(c) {
    c.line(`clear; ${startLine(c.state)}`)
    await c.expect(SCREENS.welcome, { timeout: 60_000 })
  },
}

const signInSteps: Step[] = [
  {
    id: "guided",
    title: "guided setup, to the sign-in",
    async run(c) {
      await c.pick(PICKS.guided)
      await c.expect([SCREENS.signIn[0]])
    },
  },
  {
    id: "device-code",
    title: "Candle's device code in the pane",
    async run(c) {
      // The CLI already signed in here (a fresh Candle Harness home on a profile of its own): the account is offered instead.
      await Bun.sleep(1_500)
      if (c.screen().includes(PICKS.useAccount)) {
        await c.pick(PICKS.useAccount)
        c.data.usedProfile = "yes"
        return
      }
      // A code that expired leaves its pane finished: closed, and a fresh one asked for.
      if (c.screen().includes(SCREENS.paneDone[0]) || c.screen().includes("⏎ or Esc closes")) {
        c.key("enter")
        await c.expect(SCREENS.signIn, { absent: ["Device code"], what: "the sign-in step, the pane closed" })
      }
      // A resume after a fix finds the pane already open: it isn't opened twice.
      if (!c.screen().includes(SCREENS.signInPane[0])) await c.pick(PICKS.signIn)
      await c.expect(SCREENS.signInPane, { timeout: 30_000 })
      const code = await c.match(/Device code\s+([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/, { timeout: 30_000, what: "the device code" })
      const url = /Approve at\s+(https:\/\/\S+)/.exec(c.screen())?.[1]
      c.data.code = code
      if (url) c.data.codeUrl = url.replace(/[│|]+$/, "")
    },
  },
  {
    id: "approve-device",
    title: "[person] approve the device code",
    async run(c) {
      if (c.data.usedProfile) return
      const account = c.state.data.account ? ` (${c.state.data.account}): check it's that account before you approve` : ""
      c.pause(`Approve Candle's device code **${c.data.code}**${c.data.codeUrl ? ` at ${c.data.codeUrl}` : ""}, in the private window signed in to the account this run uses${account}.`)
    },
  },
  {
    id: "signed-in",
    title: "signed in: the engine step",
    async run(c) {
      const until = Date.now() + 15 * 60_000
      while (Date.now() < until) {
        const screen = c.screen()
        if (screen.includes("device code expired")) throw new StepFailed(`the device code expired: resume --at ${c.state.next - 1} for a fresh one`)
        if (SCREENS.engine.every((w) => screen.includes(w)) && !screen.includes(SCREENS.signInPane[0])) {
          // A device code approved on another account (a browser already signed in to a different one) is caught
          // here, before any agent key is made or anything trades. Only the sign-in's own key exists by now.
          const want = c.state.data.account
          const shown = signedInAs(screen)
          if (want && shown !== want) throw new StepFailed(`signed in as ${shown ?? "an account the rail doesn't name"}, not this run's ${want}. Stop here: no agent key is made and nothing has traded`)
          return
        }
        await Bun.sleep(500)
      }
      throw new StepFailed("not signed in after 15 minutes")
    },
  },
]

// Linux with no keychain: the CLI's sign-in is an encrypted file locked by a passphrase from the environment.
// Setup shows only the fix, the line to add; then that line is run.
const keyringSteps: Step[] = [
  {
    id: "keyring-missing",
    title: "no keychain: setup shows the line to add, and nothing that can't work",
    async run(c) {
      await c.pick(PICKS.guided)
      await c.expect(SCREENS.noKeychain, { absent: ["Read it again"], timeout: 20_000 })
    },
  },
  {
    id: "keyring-set",
    title: "the passphrase set as setup's line says, and setup started again",
    async run(c) {
      c.key("ctrl-c")
      await Bun.sleep(300)
      c.key("ctrl-c")
      await c.expect([PROMPT.trim()], { absent: SCREENS.setupBar, timeout: 10_000, what: "the shell" })
      c.line(`echo 'export CANDLE_KEYRING_PASSPHRASE="${c.data.keyring}"' >> ~/.bashrc && exec bash`)
      // A person takes longer than this to open a new terminal; the core with no agents goes 2 s after the view.
      await Bun.sleep(3_000)
      c.line(`export PS1='${PROMPT}'; clear; candle tui`)
      await c.expect(SCREENS.signIn, { timeout: 30_000, what: "setup at its sign-in, readable now" })
    },
  },
]

const harnessMissing: Step[] = [
  {
    id: "harness-missing",
    title: "Claude Code not installed",
    async run(c) {
      await c.expect(["Claude Code · not installed"], { timeout: 20_000 })
    },
  },
  {
    id: "harness-installed",
    title: "Claude Code installed while setup is open, found within 3 s",
    async run(c) {
      if (c.state.via === "tmux") {
        // A stand-in for Claude Code's installer where claude.ai isn't reachable: its own binary,
        // copied into the new user's ~/.local/bin. What's checked is the Candle Harness's re-check, not the installer.
        const bin = sh(["readlink", "-f", join(homedir(), ".local/bin/claude")]).trim()
        const stage = join("/tmp", `e2e-claude-${process.pid}`)
        cpSync(bin, stage)
        chmodSync(stage, 0o755)
        sh(["sudo", "install", "-o", c.state.user!, "-m", "0755", stage, `/home/${c.state.user}/.local/bin/claude`])
      } else {
        // The rehearsal's stand-in for the real line, where claude.ai can't be reached.
        c.side(process.env.E2E_HARNESS_INSTALL ?? "curl -fsSL https://claude.ai/install.sh | bash")
      }
      const t0 = Date.now()
      await c.expect(["Claude Code "], { timeout: 10_000, absent: ["Claude Code · not installed"], what: "Claude Code found" })
      c.data.foundMs = String(Date.now() - t0)
      if (Date.now() - t0 > 3_500) throw new StepFailed(`found in ${Date.now() - t0} ms, not within 3 s`)
    },
  },
]

// The Mac's fresh user has no sign-in: picked from setup's row, it runs in the pane, and the person finishes it in
// a browser. The Linux routes never meet this, since their Claude Code is signed in or stops before it.
const harnessSignIn: Step[] = [
  {
    id: "harness-signin",
    title: "Claude Code's own sign-in, in the pane",
    async run(c) {
      await c.expect(SCREENS.harnessRow, { timeout: 30_000, what: "Claude Code's row, not signed in" })
      await c.pick(PICKS.claudeCode)
      await c.expect(SCREENS.harnessPane, { timeout: 30_000 })
    },
  },
  {
    id: "harness-person",
    title: "[person] sign in to Claude Code",
    async run(c) {
      c.pause("Sign in to Claude Code with your own subscription, in the browser that opened. If it gives you a code, paste it into the pane in the top split. The pane closes by itself when it's done.")
    },
  },
  {
    id: "harness-signed-in",
    title: "Claude Code signed in, and the pane closed",
    async run(c) {
      const until = Date.now() + 5 * 60_000
      while (Date.now() < until) {
        const screen = c.screen()
        if (/Claude Code \S+ · signed in/.test(screen) && !screen.includes(SCREENS.harnessPane[0])) return
        // A pane left open after it ended: closed, as a person would.
        if (screen.includes("⏎ or Esc closes")) c.key("enter")
        await Bun.sleep(500)
      }
      throw new StepFailed("Claude Code wasn't signed in after 5 minutes")
    },
  },
]

const quitSetup: Step = {
  id: "quit",
  title: "ctrl-c twice leaves setup",
  async run(c) {
    c.key("ctrl-c")
    await Bun.sleep(300)
    c.key("ctrl-c")
    await c.expect([PROMPT.trim()], { absent: SCREENS.setupBar, timeout: 10_000, what: "the shell" })
  },
}

const engineSteps: Step[] = [
  {
    id: "engine",
    title: "Claude Code picked, and its test message answered",
    async run(c) {
      await c.expect(["Claude Code "], { absent: ["Claude Code · checking…"] })
      // A failed test leaves Try again on the screen, with the engine still picked.
      if (c.screen().includes(`▸ ${PICKS.tryAgain}`)) c.key("enter")
      else {
        await c.pick(PICKS.claudeCode)
        await c.pick(PICKS.test)
      }
      await c.expect(SCREENS.testAnswered, { timeout: 120_000, what: "the test message's answer" })
      c.key("enter")
      await c.expect(SCREENS.vault)
    },
  },
]

const quitAndResume: Step = {
  id: "quit-resume",
  title: "quit at the vault step, and resumed there",
  async run(c) {
    c.key("ctrl-c")
    await Bun.sleep(300)
    c.key("ctrl-c")
    await c.expect([PROMPT.trim()], { absent: SCREENS.setupBar, timeout: 10_000, what: "the shell" })
    c.line(`clear; ${startLine(c.state)}`)
    await c.expect(SCREENS.vault, { timeout: 30_000, what: "setup picked up at the vault step" })
  },
}

const keySteps: Step[] = [
  {
    id: "vault-later",
    title: "the embedded wallet only, for now",
    async run(c) {
      await c.pick(PICKS.embeddedOnly)
      await c.expect(SCREENS.key)
    },
  },
  {
    id: "key",
    title: "Make the key, in the pane",
    async run(c) {
      await c.pick(PICKS.makeKey)
      // A new account: Candle refuses until the wallet is authorized. Else the key's made and stored.
      const until = Date.now() + 90_000
      while (Date.now() < until) {
        const s = c.screen()
        if (s.includes("AGENT_WALLET_NOT_DELEGATED") || s.includes(SCREENS.keyNotAuthorized[0])) {
          c.data.keyRefused = "AGENT_WALLET_NOT_DELEGATED"
          c.keep("refused", s)
          if (s.includes(SCREENS.paneDone[0])) c.key("enter")
          await c.expect(SCREENS.keyNotAuthorized, { timeout: 15_000, what: "setup's not-authorized screen" })
          return
        }
        if (s.includes(SCREENS.wallet[1]) && s.includes(SCREENS.wallet[0])) return
        await Bun.sleep(250)
      }
      throw new StepFailed("the key was neither made nor refused in 90 s")
    },
  },
  {
    id: "authorize",
    title: "[person] authorize the wallet in the Agent Console",
    async run(c) {
      if (!c.data.keyRefused) return
      c.pause("In the private window, open https://alpha.candle.tv/agents?tab=keys, make a key with **Create key and authorize** and approve what Candle asks. Revoke that key afterwards if you like.")
    },
  },
  {
    id: "key-again",
    title: "Try again: the key made and stored, one press only",
    async run(c) {
      if (!c.data.keyRefused) return
      await c.pick(PICKS.tryAgain, { enter: false })
      // Two presses, as a person might: setup must make one key.
      c.key("enter")
      await Bun.sleep(100)
      c.key("enter")
      await c.expect(SCREENS.wallet, { timeout: 90_000, what: "the wallet step after the key" })
    },
  },
  {
    id: "wallet",
    title: "the embedded wallet allowed, its prefix typed back",
    async run(c) {
      const prefix = await c.match(/key's prefix, ([A-Za-z0-9_-]{8}),/, { what: "the key's prefix" })
      c.data.prefix = prefix
      await c.pick(PICKS.embedded)
      await c.expect([`type ${prefix} at the CLI's prompt`], { timeout: 30_000 })
      // The CLI's own prompt asks for it: give it a moment to draw.
      await Bun.sleep(1500)
      c.line(prefix)
      await c.expect(SCREENS.limits, { timeout: 60_000, what: "the limits step" })
    },
  },
  {
    id: "limits",
    title: "the Candle Harness's limits kept",
    async run(c) {
      await c.pick(PICKS.keepLimits)
      await c.expect(SCREENS.approvals)
    },
  },
  {
    id: "approvals",
    title: "approvals: ask every time",
    async run(c) {
      await c.expect(["ask every time"], { timeout: 20_000 })
      await c.pick(PICKS.continue)
      await c.expect(SCREENS.fund)
    },
  },
  {
    id: "fund",
    title: "the wallet funded",
    async run(c) {
      const address = await c.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/, { timeout: 20_000, what: "the wallet's address" })
      c.data.address = address
      // The rail's ✓s aren't this: the wallet's own line says funded, or that it waits.
      if (!c.screen().includes("waiting for a deposit")) return
      c.pause(`Send about 0.05 SOL to the embedded wallet **${address}**. Setup moves on by itself when it lands.`)
    },
  },
  {
    id: "funded",
    title: "funded: on to the tour",
    async run(c) {
      await c.expect(SCREENS.funded, { timeout: 10 * 60_000, what: "the deposit" })
      await c.pick(PICKS.continue)
      await c.expect(SCREENS.tour, { timeout: 20_000 })
    },
  },
  {
    id: "tour",
    title: "the tour, every stop",
    async run(c) {
      for (let i = 0; i < 10 && !c.screen().includes(SCREENS.tourLast[0]); i++) {
        c.key("right")
        await Bun.sleep(300)
      }
      await c.expect(SCREENS.tourLast)
      c.key("enter")
      await c.expect(SCREENS.start)
    },
  },
  {
    id: "start",
    title: "Trade, then the Candle Harness",
    async run(c) {
      await c.pick(PICKS.trade)
      await c.expect(SCREENS.setUp, { timeout: 20_000, absent: SCREENS.setupBar })
    },
  },
]

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"

/** A trade typed on the input line, its card approved by Enter, and Candle's answer read from the journal. */
function liveTrade(id: string, title: string, line: string, headline: string): Step {
  return {
    id,
    title,
    async run(c) {
      const seen = c.journal().length
      c.line(line)
      // The headline alone can be a card that ended before (a resume after a refusal shows it still): the hint
      // line's "⏎ approve" is there only while a card is waiting for Enter.
      await c.expect([headline, ...SCREENS.cardWaiting], { timeout: 30_000, what: "the card" })
      // Enter approves a card only once it's been on screen 300 ms.
      await Bun.sleep(500)
      c.key("enter")
      const until = Date.now() + 60_000
      while (Date.now() < until) {
        const rows = c.journal().slice(seen)
        if (rows.some((r) => r.type === "operation.succeeded")) return
        // Candle's refusal (a pre-sign check, a limit) or a failure ends the step at once, in its words.
        const ended = rows.find((r) => r.type === "operation.failed" || r.type === "operation.refused" || r.type === "card.expired")
        if (ended) throw new StepFailed(`the trade ${String(ended.type).split(".")[1]}: ${JSON.stringify(ended).slice(0, 300)}`)
        await Bun.sleep(500)
      }
      throw new StepFailed("no fill in 60 s")
    },
  }
}

const afterSteps: Step[] = [
  {
    id: "paper-buy",
    title: "a paper buy, no card",
    async run(c) {
      c.line(`buy $1 ${JUP}`)
      // Recorded in Activity, not just echoed on the message line: a refusal names the token too, and Activity says
      // "paper candle_trade refused" for it.
      await c.expect(["paper buy JUP"], { absent: ["(paper): refused"], timeout: 30_000, what: "the paper buy in Activity, naming its token" })
      await Bun.sleep(1_500)
    },
  },
  {
    id: "restart",
    title: "quit and started again: the token still named",
    async run(c) {
      c.key("ctrl-c")
      await Bun.sleep(300)
      c.key("ctrl-c")
      await c.expect([PROMPT.trim()], { timeout: 10_000, what: "the shell" })
      c.line(`clear; ${startLine(c.state)}`)
      await c.expect(["agent-a", "JUP"], { timeout: 30_000, what: "the Candle Harness, naming the paper trade's token" })
    },
  },
  {
    id: "go-live",
    title: "live mode, on a yes",
    async run(c) {
      c.line("live")
      await Bun.sleep(600)
      c.type("y")
      await c.expect(["LIVE"], { timeout: 10_000 })
    },
  },
  liveTrade("live-buy", "a live $1 JUP buy on a card", `buy $1 ${JUP}`, "BUY $1.00 of JUP"),
  liveTrade("live-sell", "the JUP sold on a card", `sell 100% ${JUP}`, "SELL 100%"),
  liveTrade("live-swap", "a live swap on a card", "swap 0.002 SOL USDC", "SWAP"),
]

/** The agent setup makes the second time, with the factor; the vault passphrase is the run's own, in state.json (0600). */
const vaultSteps: Step[] = [
  {
    id: "vault-init",
    title: "a vault from the input line, with a passphrase of its own",
    async run(c) {
      // Letters and digits to start: `cmux send` would read a leading - as a flag.
      c.data.vaultPass = `v${randomBytes(18).toString("base64url")}`
      c.line("candle vault init")
      await c.expect(["Press Enter to have one generated"], { timeout: 30_000, what: "the CLI's passphrase choice" })
      c.line("own")
      await c.expect(["Choose a vault passphrase"], { timeout: 10_000 })
      c.line(c.data.vaultPass)
      await c.expect(["Type it again"], { timeout: 10_000 })
      c.line(c.data.vaultPass)
      await c.expect(["Show the recovery phrase now?"], { timeout: 60_000, what: "the phrase's question" })
      c.line("no")
      // Only a Mac asks about iCloud Drive.
      const until = Date.now() + 30_000
      while (Date.now() < until) {
        const s = c.screen()
        if (s.includes("Back up your encrypted vault to iCloud")) c.line("no")
        if (s.includes("⏎ or Esc closes")) {
          c.key("enter")
          break
        }
        await Bun.sleep(500)
      }
      await Bun.sleep(1_000)
      const vault = c.journal().filter((r) => r.type === "operation.succeeded").at(-1)
      if (!JSON.stringify(vault).includes("finished")) throw new StepFailed(`vault init didn't finish: ${JSON.stringify(vault).slice(0, 200)}`)
    },
  },
  {
    id: "setup-again",
    title: "candle-harness setup for a second agent, to the key step",
    async run(c) {
      c.key("ctrl-c")
      await Bun.sleep(300)
      c.key("ctrl-c")
      await c.expect([PROMPT.trim()], { timeout: 10_000, what: "the shell" })
      c.line("clear; candle-harness setup")
      await c.expect(SCREENS.welcome, { timeout: 30_000 })
      await c.pick(PICKS.guided)
      // Sign-in is read back; the engine asks for its test on a new run. Each is met as it comes.
      const until = Date.now() + 120_000
      while (Date.now() < until) {
        const s = c.screen()
        if (s.includes(SCREENS.key[0])) return
        if (s.includes(PICKS.useAccount)) await c.pick(PICKS.useAccount)
        else if (s.includes(SCREENS.engine[0]) && s.includes(PICKS.continue)) await c.pick(PICKS.continue)
        else if (s.includes(SCREENS.engine[0]) && s.includes(PICKS.test)) await c.pick(PICKS.test)
        else if (s.includes(SCREENS.engine[0]) && !s.includes(SCREENS.engine[1])) await Bun.sleep(100)
        else if (s.includes(SCREENS.engine[0]) && !s.includes("⠋")) await c.pick(PICKS.claudeCode)
        await Bun.sleep(1_000)
      }
      throw new StepFailed("never reached the key step")
    },
  },
  {
    id: "second-key",
    title: "the second agent's key, taking the factor",
    async run(c) {
      await c.expect(["your vault's factor first, in the pane"], { timeout: 10_000, what: "the factor named" })
      c.data.secondAgent = await c.match(/candle keys create --label (\S+)/, { what: "the new agent's name" })
      await c.pick(PICKS.makeKey)
      await c.expect(["passphrase"], { timeout: 30_000, what: "the factor's prompt" })
      await Bun.sleep(500)
      c.line(c.data.vaultPass!)
      await c.expect(SCREENS.wallet, { timeout: 60_000, what: "the wallet step" })
    },
  },
  {
    id: "quit-at-wallet",
    title: "quit at the wallet step, and resumed there",
    async run(c) {
      c.key("ctrl-c")
      await Bun.sleep(300)
      c.key("ctrl-c")
      await c.expect([PROMPT.trim()], { timeout: 10_000, what: "the shell" })
      c.line(`clear; ${startLine(c.state)}`)
      await c.expect(SCREENS.wallet, { timeout: 30_000, what: "setup picked up at the wallet step" })
    },
  },
  {
    id: "second-wallet",
    title: "the second agent's wallet allowed, with the factor, and setup moves on by itself",
    async run(c) {
      const prefix = await c.match(/key's prefix, ([A-Za-z0-9_-]{8}),/, { what: "the key's prefix" })
      c.data.prefix2 = prefix
      await c.pick(PICKS.embedded)
      await c.expect(["passphrase"], { timeout: 30_000, what: "the factor's prompt" })
      await Bun.sleep(500)
      c.line(c.data.vaultPass!)
      await c.expect([`Type the key prefix ${prefix}`], { timeout: 30_000 })
      c.line(prefix)
      // No key pressed: the fix under test.
      await c.expect(SCREENS.limits, { timeout: 20_000, what: "the limits step, by itself" })
    },
  },
  {
    id: "second-rest",
    title: "limits, approvals, fund, tour and where to start",
    async run(c) {
      await c.pick(PICKS.keepLimits)
      await c.expect(["ask every time"], { timeout: 20_000 })
      await c.pick(PICKS.continue)
      await c.expect(SCREENS.fund)
      await c.expect(SCREENS.funded, { timeout: 30_000 })
      await c.pick(PICKS.continue)
      await c.expect(SCREENS.tour, { timeout: 20_000 })
      for (let i = 0; i < 10 && !c.screen().includes(SCREENS.tourLast[0]); i++) {
        c.key("right")
        await Bun.sleep(300)
      }
      c.key("enter")
      await c.expect(SCREENS.start)
      await c.pick(PICKS.trade)
      // Setup ends on the agent it just made, with what was set up.
      await c.expect([...SCREENS.setUp, `${c.data.secondAgent} ▾`], { timeout: 20_000, absent: SCREENS.setupBar })
    },
  },
]

const ROUTES: Record<Route, Step[]> = {
  install: [...installSteps, launch, ...keyringSteps, ...signInSteps.slice(1), ...harnessMissing, quitSetup],
  main: [launch, ...signInSteps, ...engineSteps, quitAndResume, ...keySteps, ...afterSteps, ...vaultSteps],
  mac: [...installSteps, launch, ...signInSteps, ...harnessMissing, ...harnessSignIn, ...engineSteps, quitAndResume, ...keySteps, ...afterSteps, ...vaultSteps],
}

// --- Set-up of each route's terminal --------------------------------------------------------------------------

const E2E_USER = "chrn-e2e"

function setUpTmux(state: RunState, size: string): void {
  const [x, y] = size.split("x")
  const session = state.target.split(":")[0]!
  sh(["tmux", "kill-session", "-t", session], { allowFail: true })
  if (state.route === "install") {
    // A core left from a run before still runs as the user, and userdel won't remove a user with processes.
    sh(["sudo", "pkill", "-KILL", "-u", E2E_USER], { allowFail: true })
    Bun.sleepSync(500)
    sh(["sudo", "userdel", "-r", E2E_USER], { allowFail: true })
    sh(["sudo", "useradd", "-m", "-s", "/bin/bash", E2E_USER])
    // The proxy's settings carried in, as this machine's own shell has them; nothing else of this user's.
    const keep = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"].join(",")
    sh(["tmux", "new-session", "-d", "-s", session, "-x", x!, "-y", y!, `sudo --preserve-env=${keep} -u ${E2E_USER} -i`])
    state.user = E2E_USER
  } else {
    const home = state.home!
    mkdirSync(join(home, "harness"), { recursive: true })
    mkdirSync(join(home, "candle"), { recursive: true })
    mkdirSync(join(home, "bin"), { recursive: true })
    // The Candle Harness and the CLI, from the same release, into this run's own bin folder: never on this machine's PATH.
    const env = { ...process.env, CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING: "1" }
    const r = spawnSync("bash", [join(state.release!, "install.sh"), "--from", state.release!, "--bin-dir", join(home, "bin"), "--yes"], { env, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`install.sh into ${home}/bin failed: ${r.stderr || r.stdout}`)
    sh([
      "tmux", "new-session", "-d", "-s", session, "-x", x!, "-y", y!,
      "-e", `CANDLE_KEYRING_PASSPHRASE=${state.data.keyring}`,
      "-e", `CANDLE_HARNESS_HOME=${join(home, "harness")}`, "-e", `CANDLE_CONFIG_DIR=${join(home, "candle")}`, "-e", `PATH=${join(home, "bin")}:${process.env.PATH}`,
      "bash --noprofile --norc",
    ])
  }
}

// --- The runner ------------------------------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function newRunDir(route: Route): string {
  const base = flag("--out") ?? join(APP, "test/fixtures/raw/e2e")
  mkdirSync(base, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const n = readdirSync(base).filter((d) => d.startsWith(`${day}-${route}-`)).length + 1
  const dir = join(base, `${day}-${route}-${n}`)
  mkdirSync(dir)
  return dir
}

function save(dir: string, state: RunState): void {
  writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

async function go(dir: string, state: RunState): Promise<number> {
  const term: Term = state.via === "cmux" ? new CmuxTerm(state.target) : new TmuxTerm(state.target)
  const steps = ROUTES[state.route]
  const md = join(dir, "run.md")
  if (!existsSync(md)) writeFileSync(md, `# First run: ${state.route}, by ${state.via}\n\nStarted ${state.startedAt}.\n\n| # | Step | Time | Result |\n|---|---|---|---|\n`)
  while (state.next < steps.length) {
    const step = steps[state.next]!
    const c = new Ctx(term, dir, state, step.id)
    const t0 = Date.now()
    process.stdout.write(`${String(state.next + 1).padStart(2)}/${steps.length} ${step.title} … `)
    try {
      await step.run(c)
      const s = ((Date.now() - t0) / 1000).toFixed(1)
      c.keep("")
      appendFileSync(md, `| ${state.next + 1} | ${step.title} | ${s} s | pass |\n`)
      console.log(`pass (${s} s)`)
      state.next++
      save(dir, state)
    } catch (error) {
      const s = ((Date.now() - t0) / 1000).toFixed(1)
      const file = c.keep(error instanceof Paused ? "paused" : "failed")
      if (error instanceof Paused) {
        appendFileSync(md, `| ${state.next + 1} | ${step.title} | | **waiting for a person** |\n`)
        console.log(`waiting for a person:\n\n${error.message}\n\nThen: ${SELF} resume --run ${dir}`)
        state.next++
        save(dir, state)
        return 3
      }
      const words = error instanceof Error ? error.message : String(error)
      appendFileSync(md, `| ${state.next + 1} | ${step.title} | ${s} s | **fail**: ${words.replace(/\|/g, "\\|")} |\n`)
      console.log(`FAIL (${s} s): ${words}\n  screen: ${file}`)
      save(dir, state)
      return 1
    }
  }
  appendFileSync(md, `\nFinished ${new Date().toISOString()}.\n`)
  console.log(`\nAll ${steps.length} steps passed. ${md}`)
  return 0
}

const MIN_COLS = 120
const MIN_ROWS = 30

/**
 * cmux's words and keys, on the idle shell the Candle Harness will run in, before a fresh user's install is spent on them: the
 * mac route has only ever run through this probe's stand-in. Then it waits for the split to be big enough, since a
 * narrower one wraps the words the steps read.
 */
async function probe(surface: string): Promise<number> {
  const term = new CmuxTerm(surface)
  const seen = async (re: RegExp, what: string): Promise<RegExpExecArray> => {
    const until = Date.now() + 10_000
    while (Date.now() < until) {
      const m = re.exec(term.screen())
      if (m) return m
      await Bun.sleep(200)
    }
    throw new StepFailed(`${what}. The screen:\n${term.screen()}`)
  }
  term.type(`clear; echo PROBE""-OK`)
  term.key("enter")
  await seen(/^PROBE-OK$/m, "typing, Enter and reading the screen didn't work")
  term.type("clear; cat -v")
  term.key("enter")
  await Bun.sleep(500)
  term.key("down")
  term.key("right")
  term.key("enter")
  await seen(/\^\[(\[|O)B\^\[(\[|O)C/, "the arrow keys didn't arrive")
  term.key("ctrl-c")
  await Bun.sleep(300)
  console.log("cmux types, presses keys and reads the screen.")
  let said = ""
  for (;;) {
    term.type("clear; stty size")
    term.key("enter")
    const m = await seen(/^(\d+) (\d+)$/m, "stty size didn't answer")
    const [rows, cols] = [Number(m[1]), Number(m[2])]
    if (cols >= MIN_COLS && rows >= MIN_ROWS) {
      term.type("clear")
      term.key("enter")
      console.log(`The top split is ${cols}×${rows}.`)
      return 0
    }
    const words = `The top split is ${cols}×${rows}, and the run needs at least ${MIN_COLS}×${MIN_ROWS}. Make the window bigger, or drag the divider down.`
    if (words !== said) console.log(words)
    said = words
    await Bun.sleep(2_000)
  }
}

export async function main(): Promise<number> {
  const cmd = process.argv[2]
  if (cmd === "probe") {
    const surface = flag("--surface")
    if (!surface) throw new Error("probe takes --surface <ref>")
    return probe(surface)
  }
  if (cmd === "resume") {
    const dir = flag("--run")
    if (!dir) throw new Error("resume takes --run <folder>")
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as RunState
    // `--at <n>` runs again from step n (1-based), after a fix.
    // `--at` takes a step's number or its id; anything else is refused, never read as "nothing left to run".
    const at = flag("--at")
    if (at) {
      const steps = ROUTES[state.route]
      const byId = steps.findIndex((s) => s.id === at)
      const index = byId >= 0 ? byId : /^\d+$/.test(at) ? Number(at) - 1 : -1
      if (index < 0 || index >= steps.length) {
        console.error(`--at ${at}: not a step of the ${state.route} route (1 to ${steps.length}, or an id: ${steps.map((s) => s.id).join(", ")})`)
        return 2
      }
      state.next = index
    }
    return go(dir, state)
  }
  if (cmd !== "start") {
    console.error("first-run start --route install|main [--release <folder>] [--size 120x34] [--account <address>]\nfirst-run start --route mac --surface <ref> --release <folder> --out <folder> [--account <address>]\nfirst-run probe --surface <ref>\nfirst-run resume --run <folder> [--at <step>]")
    return 2
  }
  const route = flag("--route") as Route | undefined
  if (!route || !(route in ROUTES)) throw new Error("--route takes install, main or mac")
  const via = route === "mac" ? "cmux" : "tmux"
  const release = flag("--release") ? resolve(flag("--release")!) : undefined
  if (!release || !existsSync(join(release, "install.sh"))) throw new Error("--release takes a release folder holding install.sh (bun scripts/build.ts --release v<x>)")
  const dir = newRunDir(route)
  // The CLI's file-store passphrase for this run's Linux homes (no keychain on Linux); state.json is 0600.
  const keyring = randomBytes(18).toString("base64url")
  // `--account`: the account the device code must be approved on, checked once signed in.
  const account: Record<string, string> = flag("--account") ? { account: shortAccount(flag("--account")!) } : {}
  // The release's install.sh never installs an unsigned build; the run uses its test copy, beside links to the rest.
  const tested = testRelease(release, mkdtempSync(join(tmpdir(), "first-run-release-")))
  const state: RunState = { route, via, target: via === "cmux" ? flag("--surface")! : `e2e-${route}:0`, release: tested, next: 0, data: { keyring, ...account }, startedAt: new Date().toISOString() }
  if (via === "cmux" && !flag("--surface")) throw new Error("--route mac takes --surface <ref>, the terminal the Candle Harness runs in")
  if (via === "tmux") {
    if (route === "main") state.home = `/tmp/chrn-e2e-${dir.split("/").at(-1)!.slice(5).replace("main-", "")}`
    setUpTmux(state, flag("--size") ?? "120x34")
    await Bun.sleep(800)
    const term = new TmuxTerm(state.target)
    // A shell's start-up can set PATH over tmux's -e, so the run's bin folder goes first here.
    term.type(`export PS1='${PROMPT}'${state.home ? `; export PATH=${join(state.home, "bin")}:$PATH` : ""}; clear`)
    term.key("enter")
  }
  save(dir, state)
  console.log(`Run folder: ${dir}`)
  return go(dir, state)
}

if (import.meta.main) process.exit(await main())
