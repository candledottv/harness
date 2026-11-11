import { expect, test } from "bun:test"
import { botLines, botVerb, canNotifyNative, cleanNotificationText, fallbacks, isRemote, joinNotices, noticeOf, noticeText, osNotifyCommand, pickNotifier, quantHeadline } from "./notify"

test("darwin uses osascript with text passed as arguments, never spliced into the script", () => {
  const argv = osNotifyCommand("darwin", 'MOON "pump"', "line1\nline2 \\ end")
  expect(argv[0]).toBe("osascript")
  expect(argv.slice(-2)).toEqual(['MOON "pump"', "line1 line2 \\ end"]) // cleaned, read as `item 1 of argv`
  const script = argv.slice(1, -2).filter((a) => a !== "-e").join("\n")
  expect(script).not.toContain("MOON")
})
test("linux uses notify-send with plain args", () => {
  expect(osNotifyCommand("linux", "t", "b")).toEqual(["notify-send", "--", "t", "b"])
  // A token named like an option is text.
  expect(osNotifyCommand("linux", "--app-name=x", "-u critical")).toEqual(["notify-send", "--", "--app-name=x", "-u critical"])
})
test("pickNotifier follows the mode, remoteness and focus", () => {
  expect(pickNotifier("auto", { remote: false, focused: false })).toBe("native")
  expect(pickNotifier("auto", { remote: true, focused: false })).toBe("osc")
  expect(pickNotifier("auto", { remote: true, focused: null })).toBe("osc") // can't tell: send
  expect(pickNotifier("bell", { remote: false, focused: true })).toBeNull() // focused: never
  expect(pickNotifier("off", { remote: false, focused: false })).toBeNull()
})
test("every mode follows focus and off", () => {
  for (const mode of ["auto", "native", "osc", "bell"] as const) {
    expect(pickNotifier(mode, { remote: false, focused: true })).toBeNull()
    expect(pickNotifier(mode, { remote: true, focused: null })).not.toBeNull()
  }
  expect(pickNotifier("native", { remote: true, focused: false })).toBe("native")
  expect(pickNotifier("osc", { remote: false, focused: false })).toBe("osc")
  expect(pickNotifier("bell", { remote: false, focused: null })).toBe("bell")
})
test("what's tried after a kind fails: the OS, then the terminal's sequence, then the bell", () => {
  expect(fallbacks("native")).toEqual(["native", "osc", "bell"])
  expect(fallbacks("osc")).toEqual(["osc", "bell"])
  expect(fallbacks("bell")).toEqual(["bell"])
})
test("controls stripped, newlines collapsed, capped", () => {
  expect(cleanNotificationText("a\u001b[31mb\u0007\nc")).toBe("a[31mb c")
  expect(cleanNotificationText("x".repeat(300))).toHaveLength(200)
})
test("direction controls and DEL stripped; emoji never cut in half", () => {
  expect(cleanNotificationText("MOON‮eht⁦\u007f")).toBe("MOONeht")
  const capped = cleanNotificationText("🚀".repeat(300))
  expect([...capped]).toHaveLength(200)
  expect(capped.endsWith("🚀")).toBe(true)
})
test("C1 controls, including the 8-bit string terminator, are stripped", () => {
  expect(cleanNotificationText("a\u009cb\u0085c\u009bd")).toBe("abcd")
})
test("remote: SSH, a container marker, or a Docker Sandboxes VM", () => {
  const none = () => false
  expect(isRemote({}, none)).toBe(false)
  expect(isRemote({ SSH_CONNECTION: "192.0.2.1 50000 198.51.100.2 22" }, none)).toBe(true)
  expect(isRemote({ SSH_TTY: "/dev/pts/1" }, none)).toBe(true)
  expect(isRemote({}, (p) => p === "/.dockerenv")).toBe(true)
  expect(isRemote({ SANDBOX_VM_ID: "tui-build" }, none)).toBe(true)
})
test("a native notification needs a local Mac, or a Linux desktop session; a VPS has neither", () => {
  const none = () => false
  expect(canNotifyNative("darwin", {}, none)).toBe(true)
  expect(canNotifyNative("darwin", { SSH_CONNECTION: "x" }, none)).toBe(false)
  expect(canNotifyNative("linux", {}, none)).toBe(false) // a VPS's service: no display, no bus
  expect(canNotifyNative("linux", { DISPLAY: ":0" }, none)).toBe(true)
  expect(canNotifyNative("linux", { WAYLAND_DISPLAY: "wayland-0" }, none)).toBe(true)
  expect(canNotifyNative("linux", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", SANDBOX_VM_ID: "v" }, none)).toBe(false)
  expect(canNotifyNative("win32", {}, none)).toBe(false)
})

const MINT = "MoonFake11111111111111111111111111111111111"
const fakeKey = () => ["cndl", "live", "abcdefghijklmnop0123456789"].join("_")

test("a notice has no address and no key: an address shows short, a key is redacted", () => {
  const n = noticeOf("triggers", `trigger "MOON stop" proposed SELL 50% of ${MINT} with ${fakeKey()}`)
  expect(n.title).toBe("Candle Harness · trigger")
  expect(n.body).not.toContain(MINT)
  expect(n.body).toContain("Moon…1111")
  expect(n.body).not.toContain("cndl_live_")
  expect(n.body).toContain("[redacted]")
  // An EVM address keeps `0x` and four characters each end.
  expect(noticeText(`0x${"ab".repeat(20)} paid`)).toBe("0xabab…abab paid")
})
test("notices that come together are one: how many, then each line, capped", () => {
  const a = noticeOf("triggers", "trigger \"x\": filled SELL 50% of MOON")
  const b = noticeOf("triggers", "trigger \"x\": filled BUY $5 of JUP")
  expect(joinNotices([a])).toBe(a)
  expect(joinNotices([])).toBeUndefined()
  const both = joinNotices([a, b])!
  expect(both.title).toBe("Candle Harness · trigger · 2 updates")
  expect(both.body).toBe('trigger "x": filled SELL 50% of MOON · trigger "x": filled BUY $5 of JUP')
  const mixed = joinNotices([a, noticeOf("cards", "agent-a proposed BUY $5 of JUP")])!
  expect(mixed.title).toBe("Candle Harness · 2 updates")
  expect(mixed.kinds).toEqual(["triggers", "cards"])
  expect([...joinNotices(Array.from({ length: 30 }, () => a))!.body]).toHaveLength(200)
})
test("Quant's headline is the same words on one line, with no address, key or control", () => {
  const n = noticeOf("cards", `agent-a proposed BUY $5 of ${MINT}\n\u001b]0;x\u0007`)
  const h = quantHeadline(n)
  expect(h).toBe("Candle Harness · a card waits for you: agent-a proposed BUY $5 of Moon…1111 ]0;x")
  expect(h).not.toMatch(/[\u0000-\u001f]/)
  expect(h).not.toContain(MINT)
})

test("a bot's exit verbs read with the token where it belongs: sold Jose at its max hold, took profit on APU", () => {
  expect(botLines([
    { bot: "conf", verb: botVerb("exit", "max_hold"), token: "Jose", paper: true },
    { bot: "conf", verb: botVerb("exit", "take_profit"), token: "APU", paper: true },
    { bot: "conf", verb: botVerb("exit", "trailing_stop"), token: "MOON", paper: true },
  ])).toEqual(["conf (paper) · sold Jose at its max hold · took profit on APU · sold MOON at its trailing stop"])
})
