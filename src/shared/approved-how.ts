// How a card was approved, as its `card.approved` row and the view say it. Two of these are the core's own and mean
// nobody pressed anything: `inside-limits`, a trade inside its wallet's figures, and `bot-exit`, a rules bot's sell,
// whose exits the person approved with the bot.

/** Whether the core ran it without a card: the records and the receipt say "without a card". */
export const ranWithoutCard = (how: unknown): boolean => how === "inside-limits" || how === "bot-exit"

/** The core's own ways: a view that says one of them is taken as a plain approval. */
export const CORE_HOWS: readonly string[] = ["instant", "typed", "inside-limits", "bot-exit"]
