// Keep-awake: a macOS setting, off by default, that keeps the Mac from sleeping while a trigger or bot is on, so a level
// or a schedule isn't missed because the machine slept. It's `caffeinate -i -w <the core's pid>`: -i holds off idle
// sleep only (a closed lid still sleeps a Mac on battery), and -w ends caffeinate with the core, however the core
// ends. It runs while the setting is on and a trigger keeps the core up, and ends with the last one.
//
// config.toml's `[core] keepAwake` is where a fresh install starts; the choice last made is kept in
// state/keep-awake.json.
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"

export interface Caffeinated {
  kill(): void
  /** Resolves with the exit code when it ends, by itself or killed. */
  exited: Promise<number | null>
}

export type CaffeinateSpawn = (argv: string[]) => Caffeinated

export interface KeepAwakeView {
  /** The setting: on keeps the Mac awake while a trigger or bot is on. */
  on: boolean
  /** Whether this machine has it: macOS only. */
  available: boolean
  /** caffeinate is running now. */
  active: boolean
  /** Why it isn't running though it should be, in words. */
  failed?: string
}

/** A caffeinate that ends within this of starting failed to start, and isn't tried again until the setting is switched. */
const FAILED_WITHIN_MS = 2_000

export const defaultCaffeinate: CaffeinateSpawn = (argv) => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  return { kill: () => child.kill(), exited: child.exited }
}

export class KeepAwake {
  private setting: boolean
  private child: { proc: Caffeinated; startedAt: number } | undefined
  private failed: string | undefined
  private wanted = false
  private stopped = false

  constructor(
    private readonly deps: {
      file: string
      /** config.toml's `[core] keepAwake`. */
      initial: boolean
      platform: NodeJS.Platform
      pid: number
      now: () => number
      spawn?: CaffeinateSpawn
      /** Told when caffeinate starts or ends, with why. */
      onChange?: (active: boolean, why: string) => void
    },
  ) {
    this.setting = deps.initial
    try {
      const raw = JSON.parse(readFileSync(deps.file, "utf8")) as { on?: unknown }
      if (typeof raw.on === "boolean") this.setting = raw.on
    } catch {
      // No choice kept yet: config.toml's.
    }
  }

  available(): boolean {
    return this.deps.platform === "darwin"
  }

  /** The person's choice, kept across restarts. Switching it clears a failure, so it's tried again. */
  set(on: boolean): void {
    this.setting = on
    this.failed = undefined
    const temp = `${this.deps.file}.tmp-${randomBytes(6).toString("base64url")}`
    writeFileSync(temp, `${JSON.stringify({ on })}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, this.deps.file)
    this.update(this.wanted)
  }

  /** `triggersOn`: whether a trigger keeps the core up now. caffeinate runs while that and the setting are both true. */
  update(triggersOn: boolean): void {
    this.wanted = triggersOn
    const should = !this.stopped && this.setting && this.available() && triggersOn && this.failed === undefined
    if (should && !this.child) this.start()
    else if (!should && this.child) this.end(this.stopped ? "the core stopped" : !this.setting ? "keep-awake was switched off" : "no trigger or bot is on")
  }

  /** The core is stopping: caffeinate ends with it (-w would end it anyway, a moment later). */
  stop(): void {
    this.stopped = true
    this.update(false)
  }

  view(): KeepAwakeView {
    return { on: this.setting, available: this.available(), active: this.child !== undefined, ...(this.failed ? { failed: this.failed } : {}) }
  }

  private start(): void {
    const argv = ["caffeinate", "-i", "-w", String(this.deps.pid)]
    let proc: Caffeinated
    try {
      proc = (this.deps.spawn ?? defaultCaffeinate)(argv)
    } catch (error) {
      this.failed = `caffeinate didn't start: ${(error as Error).message.slice(0, 120)}`
      return
    }
    const child = { proc, startedAt: this.deps.now() }
    this.child = child
    this.deps.onChange?.(true, "a trigger or bot is on")
    void proc.exited.then((code) => {
      if (this.child !== child) return // ended by us
      this.child = undefined
      if (this.deps.now() - child.startedAt < FAILED_WITHIN_MS) this.failed = `caffeinate ended as it started (exit ${code ?? "by a signal"})`
      this.deps.onChange?.(false, this.failed ?? "caffeinate ended by itself")
      // Ended later by itself (killed from outside): started again while it's still wanted.
      if (!this.failed) this.update(this.wanted)
    })
  }

  private end(why: string): void {
    const child = this.child
    this.child = undefined
    child?.proc.kill()
    this.deps.onChange?.(false, why)
  }
}
