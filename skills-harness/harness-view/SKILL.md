---
name: harness-view
description: How to change what the person's Candle Harness shows with harness_view, when they ask you to: switch tabs or layouts, lay a tab out for them ("put Signals under the chart"), add, rename, remove, show or hide tabs, pin a token pane, filter or pause Signals, search the Journal, and switch or make a theme. Read it before you build a layout or make a theme.
---

# Changing the screen in the Candle Harness

`harness_view` changes what the person sees, and nothing else: no trade, no spend, no key. Use it only when they ask for a change to the screen. It never moves the focus or pops a pane out into its own window; those stay theirs.

**Start with `read`.** It lists the tabs, the layout each shows with its tree, the tabs ticked off the tab bar, the layouts there are, the panes, the pinned token panes, what Signals shows, the Journal's search and the themes. Build on what's there rather than guessing.

## The tabs

A fresh install has eight. The person may have ticked some off the tab bar, renamed them or added their own: `read` says which.

| Tab | What it's for |
|---|---|
| Trade | You and the token, with positions, wallets and activity |
| Cockpit | Feed and Signals beside the token, with you on the right |
| Trending | Candle's four lists: New, Graduated, On Fire and Final Stretch |
| Signals | Hacc's tape at full width, or the person's own rules' signals, filtered by pattern and chain |
| P&L | The window's P&L, Candle's books by agent, the chart, positions and trades |
| Research | One token in depth: its check, top traders, its own signals and posts about it |
| Journal | Everything the Candle Harness recorded, in words, searched |
| Perps | What works for perps now |

Trending, Signals, P&L, Journal and Perps have a short pane of you across the foot, so you answer there; Research has you on the right.

## What happens at once, and what waits for the person

| Action | What it does | When it takes effect |
|---|---|---|
| `tab` | Switches the tab on screen (`tab`: its name or number), or with `pane` alone, to the tab that has that pane, showing it where the tab is narrow | At once |
| `layout` | Shows an existing layout (`layout`: its name) on a tab | At once |
| `open`, `close` | Puts a pane on the tab's layout (`pane`, and `near` to put it beside one) or takes one off | A preview: they keep or discard it |
| `build` | Lays the tab out from a whole tree (`root`), kept under `name` if you give one | A preview: they keep or discard it |
| `add_tab`, `rename_tab`, `remove_tab` | Changes the tabs (`name`; `layout` for a new tab) | At once, with an undo for them |
| `show_tab`, `hide_tab` | Ticks a tab on the tab bar (and switches to it) or off it, as settings ▾ does; its layout is kept | At once, with an undo for them |
| `pin`, `unpin` | Holds a tab's token pane on a token (`mint`, or the one it shows) while the rest follow the link | At once |
| `signals` | What a Signals pane shows: `mine` (their own rules' signals), `pattern`, `chain`, and `paused` | At once |
| `journal` | Puts a search in the Journal (`search`, and `kinds`) | At once |
| `theme` | Switches to a theme that exists (`name`) | At once |
| `make_theme` | Writes a theme of their own (`name`, `base`, `colours`, `reply`) and uses it | At once, once it passes the check, with an undo for them |

Each action acts on the tab on screen unless `tab` names another. When a tab already shows what they ask for ("show me the cockpit", and there's a Cockpit tab), switch to it with `tab` rather than change the tab they're on.

**A preview isn't saved.** The tab draws your layout, and keep and discard show under your reply. Say it's a preview they can keep or discard; never say it's saved. If they ask for another change on the same tab, `open`, `close` or `build` again: it builds on the preview. Kept, a change to a preset (Agent-first, Cockpit) is saved as a copy of theirs, such as "My Cockpit", unless you gave it a `name`.

**A tab ticked off isn't gone.** `tab` refuses it and says so; if they asked to see it, `show_tab` puts it back where it was. Hide one only when they ask.

**Signals and the Journal act where they are.** Each goes to the tab on screen if it has that pane, else the first tab that does, and switches to it; `tab` names another. "Only KOL mentions on Signals" is `signals` with `tab` "Signals" and `pattern` "kol_mention". The patterns: `new_ticker` (a tracked wallet's first buy of a new ticker), `confluence` (several tracked wallets buying the same token), `large_move`, `dormancy` (a wallet moving after weeks still), `deployer`, `distribution` (a wallet selling what it holds), `intra_book`, `kol_mention` (a KOL posting about a token, and a buy); `"all"` clears it. Each filter left out stays as it is.

"Find my last JUP sell in the journal" is `journal` with `search` "JUP sell": a row matches when it holds every word, newest first. You don't see the rows; they do. Your own turns, cards and paper trades are `harness_history`'s to read, and P&L is `harness_pnl`'s.

**A new tab starts on a saved layout.** To make a tab for something ("a tab for watching the tape"): `add_tab` with a name and a layout close to what they want, then `tab` to it, then `build` its layout as a preview for them to keep.

## The panes

| Pane | What it shows | Narrowest |
|---|---|---|
| `agent` | You: the conversation, with cards inline | 36 columns |
| `token` | The linked token: its chart, price, market cap, liquidity, safety check; before one, Candle's trending list | 24 |
| `positions` | What the wallets hold, with value and P&L | 24 |
| `wallets` | The wallets an agent can pay from, with balances | 24 |
| `activity` | What happened: cards, fills, refusals, changes | 24 |
| `feed` | Candle's on-fire list: each token's hour, market cap and price | 24 |
| `signals` | Hacc's signal tape, newest first | 24 |
| `new`, `graduated`, `final-stretch` | Candle's other lists: the newest launches, the latest graduations, the tokens nearest graduating | 24 |
| `pnl` | P&L over the window, Candle's books by agent, fees, swaps, wallets and paper | 24 |
| `pnl-chart` | P&L over time, from the Candle Harness's samples | 24 |
| `pnl-positions`, `trades` | Candle's cost book, and its fills with the Candle Harness's swaps | 24 |
| `journal` | Everything recorded, searched | 24 |
| `check`, `traders`, `token-signals`, `mentions` | Research on the linked token: its check, top traders, its own signals, posts about it | 24 |
| `perps` | What works for perps now | 24 |
| `away` | While they were away: the last gap's summary, from the Candle Harness's records (on no tab until opened; `harness_history` with `since` "last session" is yours to read) | 24 |

Each pane is on a layout once at most. A layout without `agent` still shows waiting cards, in a strip above the input line, so the person never misses one.

## The tree

A layout is a tree, written as layouts.toml writes it. The root is a `"row"` (side by side) or a `"column"` (stacked). Each child is a pane with its weight, such as `"token 60"`, or another row or column with its weight after its kind. Weights share the room in proportion; a column's panes also share rows by what they hold.

Agent-first, the agent on the left and four panes stacked on the right:

```json
["row", "agent 60", ["column", 40, "token 4", "positions 3", "wallets 2", "activity 3"]]
```

Signals under the chart, beside the agent:

```json
["row", "agent 55", ["column", 45, "token 60", "signals 40"]]
```

A tab for watching the tape, with no agent pane:

```json
["row", ["column", 60, "signals 65", "feed 35"], ["column", 40, "token 60", "activity 40"]]
```

Below the width its panes need, a layout collapses to its first column and one switched pane, so a wide layout still works on a small terminal. Keep it to what the person asked for: three to five panes reads well.

## Themes

`theme` switches to one that exists. `make_theme` writes `themes/<name>.toml` for the person, from a base (`"Candle dark"`, or `"Candle light"`) and the colours you change, each `"#rrggbb"`. Name only what you change.

`colours` takes: `page` (behind everything), `bar` (the status bar and input line), `pane` (inside each pane), `border`, `selected` (a highlighted row), `focus` (the focused pane's border), `bright` (names, amounts, headlines), `text`, `dim` (labels, times), `heading` (pane titles), `attention` (look at this: a waiting card, a near limit), `good` (filled, up, LIVE), `bad` (refused, down, the kill switch), `control` (anything clickable), `control_bg`, `control_hover`, `bad_bg` (the kill chip), `paper_bg` (PAPER). `reply` takes the agent's reply colours: `heading`, `bright`, `dim`, `code`, `quote`.

**A theme changes shades, never meanings.** Before it's written it's checked, as every theme is: text at 4.5:1 contrast on what it's drawn on, dim text at 4:1, chips and the status blocks readable, and no two meanings (attention, good, bad, control, heading) alike or like plain text. One that fails isn't written, and the answer says which colours to change: change them and make it again. Keep amber-like for attention, green-like for good, red-like for bad and blue-like for control unless the person asks otherwise (someone colour-blind may want good in blue).

Once written, it's on screen, and an undo under your reply puts the theme before it back. You may write over a theme you made, under the same name, to change it; a theme of their own is never written over, so pick another name.

## What you say

One sentence on what changed, and for a preview, that they keep or discard it. The screen shows the rest, so don't describe the layout back to them, and don't offer anything they didn't ask for.
