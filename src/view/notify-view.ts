// The view's notifier: the main view sends what the core hands it (`notices`) through its own terminal, only while
// the person isn't looking at it.
//
// - Looking: the terminal says it's focused (OpenTUI's focus events). Where it says nothing, or last said blurred
//   and a key or a click has come since, one in the last minute counts as looking; otherwise it's sent (a terminal
//   with no focus reporting still notifies).
// - How (`[notify] mode`, from the core): `auto` is the computer's own notification locally and the terminal's
//   (OSC 9, 777 or 99, as OpenTUI picks) over SSH; each falls back to the next, then the bell, where it fails.
// - The core stopping when nobody asked: the view is what's left to say so. A planned stop (`candle-harness stop`,
//   a signal, the idle rule) is said to every view first, and isn't told.
// - A popped view never notifies: one window tells the person once.
import { DEFAULT_NOTIFY, fallbacks, isRemote, type Notice, type Notifier, noticeOf, type NotifySettings, osNotifyCommand, pickNotifier } from "../shared/notify"

/** A key or a click this recent counts as looking, where the terminal reports no focus. */
export const LOOKING_MS = 60_000

export const CORE_LOST_WORDS = "the core stopped when nobody asked it to, so nothing is watched or traded until it's back. Quit the Candle Harness and start it again to start one."

export interface ViewNotifierDeps {
  env: Record<string, string | undefined>
  platform: string
  now(): number
  /** Runs an OS notification's argv, with no shell. */
  spawn: (argv: string[]) => Promise<{ exitCode: number }>
  /** The terminal's own notification (OpenTUI's triggerNotification): false where the terminal has none. */
  osc(title: string, body: string): boolean
  bell(): void
  /** Tests only: whether this machine counts as remote. */
  remote?: boolean
}

export class ViewNotifier {
  private settings: NotifySettings = DEFAULT_NOTIFY
  private focused: boolean | null = null
  private lastInput = Number.NEGATIVE_INFINITY
  private focusAt = Number.NEGATIVE_INFINITY
  private planned = false
  /** What was sent, and how, newest last: for the tests and the Mac check. */
  readonly sent: { notice: Notice; via: Notifier | "none" }[] = []

  constructor(private readonly deps: ViewNotifierDeps) {}

  /** An event on `notices`: the settings (its snapshot), a notice to send, or the core's planned stop. */
  event(data: unknown): Promise<void> | undefined {
    const d = data as { settings?: NotifySettings; notice?: Notice; stopping?: unknown } | null
    if (!d || typeof d !== "object") return undefined
    if (d.settings && typeof d.settings.mode === "string" && Array.isArray(d.settings.on)) this.settings = d.settings
    if (d.stopping !== undefined) this.planned = true
    if (d.notice && typeof d.notice.title === "string" && typeof d.notice.body === "string") return this.send(d.notice)
    return undefined
  }

  focus(on: boolean): void {
    this.focused = on
    this.focusAt = this.deps.now()
  }

  /** A key, a paste or a click: the person is here. */
  input(): void {
    this.lastInput = this.deps.now()
  }

  /** Attached to a core again: a stop after this one is judged afresh. */
  attached(): void {
    this.planned = false
  }

  /** The core went away with the view open. */
  lost(): Promise<void> | undefined {
    if (this.planned || !this.settings.on.includes("core")) return undefined
    return this.send(noticeOf("core", CORE_LOST_WORDS))
  }

  /** Focused, not, or can't tell (null). */
  looking(): boolean | null {
    const recent = this.deps.now() - this.lastInput < LOOKING_MS
    // A key or a click after the last blur means the window is in front again, whatever the terminal last
    // said: in cmux over a remote desktop, a card the person had just asked for was notified 5 s after they typed.
    if (this.focused === false && recent && this.lastInput > this.focusAt) return true
    if (this.focused !== null) return this.focused
    return recent ? true : null
  }

  private async send(notice: Notice): Promise<void> {
    const remote = this.deps.remote ?? isRemote(this.deps.env)
    const first = pickNotifier(this.settings.mode, { remote, focused: this.looking() })
    if (!first) return
    for (const via of fallbacks(first)) {
      if (await this.try(via, notice)) {
        this.sent.push({ notice, via })
        return
      }
    }
    this.sent.push({ notice, via: "none" })
  }

  private async try(via: Notifier, notice: Notice): Promise<boolean> {
    if (via === "bell") {
      this.deps.bell()
      return true
    }
    if (via === "osc") return this.deps.osc(notice.title, notice.body)
    if (this.deps.platform !== "darwin" && this.deps.platform !== "linux") return false
    try {
      return (await this.deps.spawn(osNotifyCommand(this.deps.platform, notice.title, notice.body))).exitCode === 0
    } catch {
      return false
    }
  }
}
