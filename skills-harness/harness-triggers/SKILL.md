---
name: harness-triggers
description: How to set up the person's triggers in the Candle Harness with harness_triggers ("sell half my JUP if it drops below $0.40", "buy $5 of JUP every morning", "tell me when a confluence signal shows under 500k"): when a trigger beats a turn, what to ask first, the exact line, and the two kinds, one that runs on its own and one that asks the person each time. Read it before you propose a trigger.
---

# Triggers in the Candle Harness

A trigger is "when X, do Y", run by the Candle Harness itself. It needs no model and no turn: it fires in milliseconds, does the same thing every time, and keeps going while the person is away or the Candle Harness's window is closed. You only act when you're messaged, so you can't watch a price yourself. When the person asks you to do something later, when something happens, that's a trigger.

Use `harness_triggers`:

- `read`: every trigger, on or off, what holds one, when it last fired, its next run, how often a level is checked, and how its command runs now.
- `propose` with `line`: a card the person approves with one press. Nothing is saved before the press.
- `off` with `name`, or `all: true`: switched off at once. Only the person switches one back on, in the main window.

## Ask first, then propose the exact line

Never propose a trigger the person's words leave open. Ask, in one short message, for whatever is missing:

- **The token,** by its mint. Read it from their holdings or a Candle or Hacc read; never guess one from a ticker. Write the mint in the line.
- **The level,** and what it's against: the price (`JUP < $0.40`), the market cap (`JUP mcap < 500k`), or what they paid (`JUP down 20%`, from their entry on that wallet).
- **The amount:** a percent of what they hold for a sell, dollars for a buy.
- **The wallet that pays,** if it isn't their default: `from <wallet>`.
- **Once or again.** A level fires once and switches off unless the line ends with `again`, which re-arms it each time the level is crossed back.

"Sell if it dumps" needs all of it: which token, how far, how much. "Sell half my JUP if it drops below $0.40" needs only the mint, if they hold one JUP. Then propose it, and say the card is waiting for their press. Don't propose it twice, and don't wait for the press: end your turn. When a later message asks how it went, read `candle_get_operation` (kind `trigger`).

## The line

```
when <condition> <action>      a level, Hacc's tape, or their personal signals
every <schedule> <action>      this machine's local time
at <HH:MM> <action>            once, at the next HH:MM on this machine's clock, then it switches off
on <event> <action>            a fill, a rules bot's entry, exit or pause, a card expiring, a replay ending, or a call from outside
```

Schedules and `at` run on this machine's clock: the line at the top of your turn says what time it is there and in which zone. Times in the record and the journal are UTC, so never take them for the clock. "At 9 tonight" is `at 21:00`; a time that has passed today runs tomorrow, so say which day it will be.

Then, at the end, in any order: `again`, `cooldown 2h` (a minute to 30 days), and `as "<name>"`. Without a name, it goes by its condition's words. Without a cooldown, an event, the tape, personal signals and a level with `again` wait 30 minutes between firings.

A cooldown changes what the person asked for, so add one only where it serves their words:

- **"Whenever", "every time", "each":** `cooldown 1m`, the shortest there is, since without one it would wait 30 minutes. Say so in a few words: two in the same minute are told as one.
- **Otherwise,** add or change a cooldown only when the person asks for one, or when the trigger could fire in a burst they'd not want (a tape trigger that trades, say). Then say why you added it, in a line.

| Conditions | |
|---|---|
| `<token> < $0.40`, `<token> > $1` | the price, in dollars |
| `<token> mcap < 500k` | the market cap |
| `<token> down 20%`, `<token> up 50%` | from what they paid, on that wallet |
| `pnl today < -$20` | their P&L over a window of its own: `24h`, `today` (since midnight), `session` (since the Candle Harness was last closed) or a time of day such as `18:00`. With none, it takes the window showing now, for good. Ask which they mean, and say that `24h` also moves as older results pass out of it, and that the others start again at their time |
| `confluence mcap < 500k age < 60m` | a Hacc pattern, with filters: `mcap`, `age`, `group <name>`, `chain solana` or `chain hood` |
| `mine`, `mine "<rule>"` | their own Hacc rules' signals |

| Schedules | Events |
|---|---|
| `every day 09:00`, `every weekday 09:00`, `every monday 09:00`, `every 4h`, `every 30m`; once: `at 09:00` | `on fill`, `on fill of <token>`, `on bot "<name>" entered`, `on bot "<name>" exited`, `on bot "<name>" paused`, `on bot "<name>" says "<word>"` (a code bot's own word), `on card expired`, `on replay ended`, `on call` |

**Actions:** a trade, sell or swap as they'd type it (`sell 50% of <mint>`, `buy $5 of <mint>`, `swap 0.5 sol usdc`), or a chain of them with `;`; `notify` or `notify "<words>"`; `wake <agent>` or `wake <agent> "<what to look at>"`. In a tape or `mine` trigger, `it` is the token that fired: `when new_ticker mcap < 200k buy $2 of it`. A trigger never runs a `candle` command, an owner step or funds out.

Examples:

- `when <JUP's mint> < $0.40 sell 50% of <JUP's mint>`: a stop, once.
- `when <JUP's mint> up 50% sell 25% of <JUP's mint> again cooldown 1h`: a take-profit ladder.
- `every day 09:00 buy $5 of <JUP's mint> as "morning JUP"`
- `at 14:30 buy $1 of <JUP's mint>`: once, today at 14:30 if that's still ahead, else tomorrow's.
- `when confluence mcap < 500k notify`
- `when kol_mention group smart_money wake agent-a "check it against my rules"`
- `on bot "conf" exited wake agent-a "say why it sold" cooldown 1m`: each of a bot's exits, not every fill.
- `on bot "grid" says "needs-a-look" wake agent-a "check its spread"`: a code bot asks for judgment with its own word; its line reaches the woken turn as data.

## The two kinds

The card says which it is, before the press:

- **Runs on its own.** Its wallet trades inside limits and the command fits its figures, so each firing trades with a receipt and nobody presses anything. On such a wallet, a sell always fits.
- **Asks you each time.** Its wallet asks every time (then every firing is a card, sells too), or the buy is over its figure, so each firing is a card the person has 60 seconds to approve. That suits a trigger that watches for chances and leaves the decision to them, if they're there.

**Paper or live is the trigger's own.** One proposed while the Candle Harness is on paper is a paper trigger for good: each firing is a paper trade, also after they go live. One proposed live stays live, and its trades are real, while they're on paper. `read` gives each one's `mode`. To take a paper trigger live, propose it again with `replace: true` once they're in live mode: that's a card.

`propose`'s answer carries the card's own words (`trigger.runs`, and a `warning` where it asks). Tell the person, in a line, which kind it is.

For one that asks, the card suggests a wallet of its own: a new TEE wallet just for it, set to trade inside limits. Say so if they want it to run while they're away. Never offer to change their existing wallet's setting: only they do that, in settings ▾ → approvals.

`notify` only tells them. `wake` costs a turn of yours, so use it only where it needs judgment; each agent is woken at most 4 times an hour and 24 a day unless their config says otherwise, and the card says so.

## A trigger or a turn

A trigger when the condition and the action are fixed: the price, the schedule, the amount. A turn (theirs, or a `wake`) when deciding needs reading and judgment. A level is checked about every 5 seconds on Candle's own price, the one a sell fills at. Say plainly that a stop can be passed through in a fast move: it's not an order on Candle's side.

When they want several conditions together, sizing rules or exits, one trigger can't hold it. Say what a trigger can do, and that Hacc's strategy lab (`hacc_lab`) can write and replay it as a definition.

## Changing and stopping one

- **Narrower, at once:** `propose` with `replace: true`, `name` (the saved trigger's, as `read` gives it) and the new line, with a smaller amount, a level harder to reach, a longer cooldown, tighter filters, or `again` dropped. For a trigger that sells, a smaller amount or a level harder to reach protects less, so it's a card, not a narrowing. A narrowing is changed at once, and you're told what changed. That's for your own triggers; another agent's is a card. Paper or live, and a P&L trigger's window, stay as they were.
- **Anything else is a card:** a bigger amount, a level easier to reach, another token, wallet or action, `again` added.
- **Off, at once:** "stop all my triggers" is `off` with `all: true`. Say that only they can switch them back on.

If a trigger woke your turn, you may only read triggers and switch off your own: another agent's stays on, and `off` says which were left. Say what you'd change, and they'll ask for it.

Triggers need a Pro or Max plan: on Free, `harness_triggers` isn't offered.
