// A bot's name as the person reads it. A Build pane's paper test run is kept under its folder's name after
// `test:`, so it never takes a bot's own name; on screen and in notices it's "grid's paper test".

/** A paper test run's name: its folder's last part, after this. */
export const TEST_PREFIX = "test:"
export const isTestName = (name: string): boolean => name.startsWith(TEST_PREFIX)

/** `grid` as itself; `test:grid` as `grid's paper test`. */
export const shownBotName = (name: string): string => (isTestName(name) ? `${name.slice(TEST_PREFIX.length)}'s paper test` : name)

/**
 * Who else a bot's wallet serves, in words: up to three named, joined with `join`; past that, the ones that aren't
 * bots, then how many other bots ("you and every agent and 19 other bots"), so a busy wallet never runs on for a line.
 */
export function sharedWithWords(names: readonly string[], join = " and "): string {
  if (names.length <= 3) return names.join(join)
  const bots = names.filter((n) => n.startsWith("the bot "))
  const rest = names.filter((n) => !n.startsWith("the bot "))
  return [...rest, `${bots.length} other ${bots.length === 1 ? "bot" : "bots"}`].join(join)
}
