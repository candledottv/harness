import { expect, test } from "bun:test"
import { botName } from "../core/trade-log"
import { firingMark } from "../view/format"
import { sharedWithWords, shownBotName } from "./bot-name"
import { botLines } from "./notify"

test("a Build pane's paper test is said as the bot's paper test, never by its kept name; a bot as itself", () => {
  expect(shownBotName("test:moon-dip")).toBe("moon-dip's paper test")
  expect(shownBotName("moon-dip")).toBe("moon-dip")
  expect(firingMark({ name: "test:moon-dip", bot: true })).toBe("moon-dip's paper test")
  expect(firingMark({ name: "moon-dip", bot: true })).toBe("bot moon-dip")
  expect(botName("test:moon-dip")).toBe("moon-dip's paper test")
  expect(botLines([{ bot: "test:moon-dip", verb: "bought", token: "MOON", paper: true }])).toEqual(["moon-dip's paper test · bought MOON"])
  expect(botLines([{ bot: "grid", verb: "bought", token: "MOON", paper: true }])).toEqual(["grid (paper) · bought MOON"])
})

test("a busy wallet's sharers: three named, past that the ones that aren't bots and a count of the rest", () => {
  expect(sharedWithWords(["you and every agent", 'the bot "a"'])).toBe('you and every agent and the bot "a"')
  const many = ["you and every agent", ...Array.from({ length: 19 }, (_, i) => `the bot "b${i}"`)]
  expect(sharedWithWords(many)).toBe("you and every agent and 19 other bots")
  expect(sharedWithWords(["agent-b", 'the bot "a"', 'the bot "b"', 'the bot "c"'], ", ")).toBe("agent-b, 3 other bots")
})
