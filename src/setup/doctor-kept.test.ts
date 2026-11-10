// The doctor on keeping the core up: triggers on with no core to watch them, what holds a running core, each
// level's pace, the login service and lingering, and keep-awake on macOS and off it.
import { expect, test } from "bun:test"
import { NOTIFY_KINDS } from "../shared/notify"
import { type Check, keptRunningWords, MAC_BANNER_WORDS, notifyWords } from "./doctor"

const texts = (checks: Check[]) => checks.map((c) => `${c.state} ${c.area}: ${c.text}`)

test("triggers on and no core: none is watched, and how to start one", () => {
  const checks = keptRunningWords({ platform: "linux", on: ["a", "b"], keepAwake: false, service: { installed: false, file: "/h/.config/systemd/user/candle-harness-core.service" } })
  expect(texts(checks)).toEqual([
    "warn trigger: 2 triggers on in triggers.toml, and no core is running, so none is watched",
    "ok core: the login service isn't installed; `candle-harness service install` starts the core at login, so triggers run with no terminal open",
  ])
  expect(checks[0]!.fix).toContain("candle-harness service install")
})

test("a running core: what holds it, the triggers keeping it up, and each trigger's pace, a slow level named", () => {
  const checks = keptRunningWords({
    platform: "linux",
    on: ["MOON < $0.40"],
    keepAwake: false,
    core: {
      pid: 900,
      headless: false,
      holds: ["2 triggers on", "1 view attached"],
      triggersOn: 2,
      triggers: {
        problems: [],
        triggers: [
          { name: "MOON < $0.40", class: "level", on: true, live: true, watching: "checked about every 5 s · MOON $0.4312", paceMs: 5_000 } as never,
          { name: "JUP > $2", class: "level", on: true, live: true, watching: "checked about every 45 s · JUP $1.20", paceMs: 45_000 } as never,
          { name: "nightly", class: "schedule", on: false, live: false } as never,
          { name: "edited", class: "level", on: true, live: false, held: { code: "CHANGED_OUTSIDE", words: "It was changed in triggers.toml since it was approved." } } as never,
        ],
      },
    },
    service: { installed: true, file: "/h/.config/systemd/user/candle-harness-core.service", loaded: true, words: "enabled, active (pid 900)" },
    linger: false,
  })
  expect(texts(checks)).toEqual([
    "ok core: the running core (pid 900) was started by a view, and is held up by: 2 triggers on, 1 view attached",
    "ok trigger: 2 triggers on keep the core running after the view quits; `candle-harness stop` ends it",
    'ok trigger: trigger "MOON < $0.40": checked about every 5 s · MOON $0.4312',
    'warn trigger: trigger "JUP > $2": checked about every 45 s · JUP $1.20, slower than the 5 s it aims for',
    'warn trigger: trigger "edited" is on and held: It was changed in triggers.toml since it was approved.',
    "ok core: the login service is installed (/h/.config/systemd/user/candle-harness-core.service): enabled, active (pid 900)",
    "warn core: lingering is off for your user, so the service's core stops when you log out",
  ])
})

test("a headless core runs until it's stopped; keep-awake on macOS, and set where it does nothing", () => {
  expect(texts(keptRunningWords({ platform: "darwin", on: [], keepAwake: true, core: { pid: 9, headless: true, holds: [], keepAwake: { on: true, available: true, active: true } } }))).toEqual([
    "ok core: the running core (pid 9) is headless: it runs until `candle-harness stop`",
    "ok trigger: no trigger is on",
    "ok core: keep-awake is on: the Mac is kept from sleeping while a trigger or bot is on (now); a closed lid still sleeps it on battery",
  ])
  expect(texts(keptRunningWords({ platform: "darwin", on: ["x"], keepAwake: false }))[1]).toBe("ok core: keep-awake is off: the Mac may sleep while triggers or bots are on, and they wait for it (ctrl-k's palette: keep the Mac awake)")
  expect(texts(keptRunningWords({ platform: "darwin", on: [], keepAwake: true, core: { keepAwake: { on: true, available: true, active: false, failed: "caffeinate ended as it started (exit 1)" } } }))).toContain("warn core: keep-awake is on, and caffeinate ended as it started (exit 1)")
  expect(texts(keptRunningWords({ platform: "linux", on: [], keepAwake: true }))).toEqual(["ok trigger: no trigger is on", "warn core: config.toml sets [core] keepAwake, which is macOS only: it does nothing here"])
  expect(texts(keptRunningWords({ platform: "linux", on: [], keepAwake: false }))).toEqual(["ok trigger: no trigger is on"])
})

test("the login service's own core is called the service's, not headless; another core beside a loaded service is still headless", () => {
  const service = (running?: number) => ({ installed: true as const, file: "/h/Library/LaunchAgents/tv.candle.harness.core.plist", loaded: true, ...(running ? { running } : {}), words: running ? `loaded, its core running (pid ${running})` : "loaded, its core not running now" })
  const words = texts(keptRunningWords({ platform: "linux", on: [], keepAwake: false, core: { pid: 450, headless: true, holds: [] }, service: service(450) }))
  expect(words[0]).toBe("ok core: the running core (pid 450) is the login service's: it runs until `candle-harness stop`, and starts again at your next login")
  expect(words.join("\n")).not.toContain("headless")
  expect(texts(keptRunningWords({ platform: "linux", on: [], keepAwake: false, core: { pid: 9, headless: true, holds: [] }, service: service() }))[0]).toBe("ok core: the running core (pid 9) is headless: it runs until `candle-harness stop`")
})

test("triggers.toml's problems and a line that reads differently now are named", () => {
  const checks = keptRunningWords({
    platform: "linux",
    on: [],
    keepAwake: false,
    problems: ["triggers.toml line 4: again is \"yes\"; it's true or false"],
    core: {
      triggers: {
        problems: [],
        triggers: [{ name: "b5 nightly", class: "schedule", on: true, live: true, watching: "next run 09:00 tomorrow", readsNow: "This line reads differently now (an alias or a token name changed since it was approved). It still does what it was approved to do." } as never],
      },
    },
  })
  expect(texts(checks)).toEqual([
    "warn trigger: triggers.toml line 4: again is \"yes\"; it's true or false",
    "ok core: the running core was started by a view, and nothing holds it: it exits within a minute",
    'ok trigger: trigger "b5 nightly": next run 09:00 tomorrow',
    'warn trigger: trigger "b5 nightly": This line reads differently now (an alias or a token name changed since it was approved). It still does what it was approved to do.',
  ])
})

test("notifications: what a view sends, and what reaches you with no window open, by machine", () => {
  const all = { mode: "auto" as const, on: [...NOTIFY_KINDS] }
  // A Mac at its own screen.
  expect(texts(notifyWords({ settings: all, remote: false, native: true, triggersOn: 2 }))).toEqual([
    "ok notify: with a Candle Harness window open, the main view tells you while its window isn't in front: your computer's own notification, else the terminal's own notification, else the terminal's bell",
    "ok notify: with no Candle Harness window open, a core started here shows your computer's own notification",
  ])
  // A VPS over SSH, with triggers on: nothing reaches you without a window, said as a warning.
  const vps = notifyWords({ settings: all, remote: true, native: false, triggersOn: 1, core: { native: false } })
  expect(texts(vps)).toEqual([
    "ok notify: with a Candle Harness window open, the main view tells you while its window isn't in front: the terminal's own notification, else the terminal's bell",
    "warn notify: with no Candle Harness window open, nothing reaches you: the running core has no screen to show a notification on (over SSH, on a VPS or in a container), and a trigger is on",
  ])
  expect(vps[1]!.fix).toContain("tmux")
  // The same with no trigger on is only said; a running core's own answer wins over this shell's.
  expect(notifyWords({ settings: all, remote: true, native: false, triggersOn: 0 })[1]!.state).toBe("ok")
  // On a Mac, where the computer's own notification is used, where it's filed and how to see its banner.
  expect(texts(notifyWords({ settings: all, remote: false, native: true, triggersOn: 0, platform: "darwin" }))).toContain(`ok notify: ${MAC_BANNER_WORDS}`)
  expect(texts(notifyWords({ settings: all, remote: false, native: true, triggersOn: 0, platform: "linux" })).join("\n")).not.toContain("Script Editor")
  expect(texts(notifyWords({ settings: all, remote: true, native: false, triggersOn: 0, core: { native: true } }))[1]).toBe("ok notify: with no Candle Harness window open, the running core shows your computer's own notification")
  // Settings: off, an empty list, and only some kinds.
  expect(texts(notifyWords({ settings: { mode: "off", on: all.on }, remote: false, native: true, triggersOn: 3 }))).toEqual(['ok notify: notifications are off (config.toml\'s [notify] mode = "off"): nothing is sent, with a Candle Harness window open or not'])
  expect(texts(notifyWords({ settings: { mode: "auto", on: [] }, remote: false, native: true, triggersOn: 0 }))).toEqual(["ok notify: nothing notifies: config.toml's [notify] on is an empty list"])
  expect(texts(notifyWords({ settings: { mode: "bell", on: ["cards", "kill"] }, remote: false, native: true, triggersOn: 0 }))[0]).toBe("ok notify: with a Candle Harness window open, the main view tells you while its window isn't in front: the terminal's bell (only cards, kill, by [notify] on)")
})

test("on Linux, a shell that unlocks the CLI's file store by passphrase: the service carries none, so its core can't sign for a TEE wallet", () => {
  const service = { installed: true, file: "/h/.config/systemd/user/candle-harness-core.service", loaded: true, words: "enabled, active" }
  const checks = keptRunningWords({ platform: "linux", on: [], keepAwake: false, service, keyringPassphrase: true })
  expect(texts(checks)).toContain("warn core: this shell opens the CLI's store with CANDLE_KEYRING_PASSPHRASE, which the login service doesn't carry, so a TEE wallet's trades from the service's core are refused")
  expect(checks.find((c) => c.text.includes("KEYRING"))!.fix).toContain("embedded wallet")
  // Nothing said without the service, or with a keychain (no passphrase in the shell).
  expect(texts(keptRunningWords({ platform: "linux", on: [], keepAwake: false, service: { ...service, installed: false }, keyringPassphrase: true })).join()).not.toContain("KEYRING")
  expect(texts(keptRunningWords({ platform: "linux", on: [], keepAwake: false, service })).join()).not.toContain("KEYRING")
})
