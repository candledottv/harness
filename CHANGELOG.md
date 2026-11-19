# Changelog

What changed in each version of Candle Harness (called the Candle TUI before 0.3.0). Versions follow [semantic versioning](https://semver.org), and each release is listed on [GitHub](https://github.com/candledottv/harness/releases).

## 0.6.7 (unreleased)

Perps position webhooks and the owner's perps reads (BE-3758), as Candle's API, CLI, MCP server and SDK now carry them. Source is candle-monorepo `c22def120` (#3925), a **staging build** that moves the CLI to 0.13.32, MCP to 0.10.37 and the SDK to 0.6.26; npm doesn't carry those yet. This section is a draft until a release does; the fixtures are re-read then. The source/build version is 0.6.7; publishing remains a separate release step.

### Perps position webhooks

- **Forty-nine offline scenarios** (`scripts/read-perps-webhook-source.ts`, `test/fixtures/candle-perps-webhook-source.json`) run Candle's own webhook policy, perps fill-event code, emit, delivery and signing, and the SDK's webhook module, against stand-ins for the owner lookup, the enqueue and the endpoint. Every fetch is refused; the made-up wallet, owners and fill hash are replaced by their role in every row, and no secret or signature is kept.
- **Three new events** an endpoint may register beside the three risk events: `perps.position_opened`, `perps.position_closed` and `perps.liquidated`. The SDK's `PERPS_POSITION_EVENT_NAMES` is the same three; an unknown perps event is refused at registration.
- **Which fill is an event:** an open from flat (long or short), a close that takes the position to exactly zero (a buy closes a short), and a liquidation whose liquidated user is this wallet (the address's case doesn't matter). An increase, a partial close, a flip through zero and a liquidator's own fill send nothing. Builder-dex coins keep `dex:COIN`.
- **What each carries:** `candle.perps.position_event/1` with `event`, `network`, `address`, `coin`, `dex` (null on the default dex), `side`, `dir`, `size`, `price`, `startPosition`, `closedPnl`, `fee`, `fillId`, `hash`, the exchange's `fillTime` and `source: "ingest"`; a liquidation adds `liquidation: { markPx, method }`. No leverage: a fill doesn't carry one. The SDK's `isPerpsPositionEventPayload` accepts each and refuses a risk event, another source and an unknown event.
- **When it is sent:** once per new fill and owner of the wallet (each live EVM link), so two owners get two. A re-ingest inserts no fill and sends nothing, an unlinked wallet has nobody to tell, and a fill more than 24 hours old when first recorded (a wallet's first scan) is history, not news. Two hours late is still sent: the events come from the perps ingest, not a stream, and Candle's docs say so.
- **One delivery each:** signed like every Candle webhook (`x-candle-signature: t=<seconds>,v1=<hmac>`, `x-candle-event`, an `{id, event, createdAt, data}` envelope), and the SDK's `verifyWebhookSignature` checks exactly what arrived; a tampered body, a timestamp six minutes off and another secret fail. Delivered two hours after the fill, `fillTime` is still the fill's.
- **What Candle's docs say:** the webhooks page's three rows and its lateness line, and the SDK changelog entry for 0.6.26, recorded as text.
- **What the Candle Harness does:** nothing new. It registers no webhook and receives none; the recording is for the owner's endpoint and the SDK it uses.

### The owner's perps reads

- **`candle perps activity` and `candle_perps_activity`:** one EVM TEE wallet's resting orders on the default and every builder dex (each row names its dex) and the key's withdrawals in flight. Both are reads: the command is in the table as Candle's MCP tool, the tool is classified as a read in live and paper. The CLI, the MCP tool and the SDK's `perpsOverviewActivity()` make the same reads and give the same answer on three stand-in answers; a failed read is null and the CLI says "not read", never "none".
- **`candle perps thresholds --key <prefix|label>`** now reads another key's thresholds and stored perps limits with the owner's device token. The key's own thresholds stay Candle's MCP read; another key's is the owner's, and the Candle Harness doesn't run it for the agent ("another key's: coming").
- **Every source fixture is re-read at `c22def120`:** the CLI table (175 commands, `perps activity` new), tools/list (105 tools, `candle_perps_activity` new), the 94 MCP/SDK scenarios, the 25 perps, the 59 spot, the 67 transfer and the 67 freshness rows. Apart from the new command and tool, the `perps transfer` and `perps thresholds` help lines and the versions and commit they name, they are unchanged.
- Not here: the owner console's web panels (a later web change), the risk monitor's real-time alerts (off in production), and any live webhook delivery. The signed CLI release pin (`install.sh`) and the runtime minimum (0.13.28) don't move.

## 0.6.6 (unreleased)

Perps fills in Candle's public activity stream, and `hide` on perps orders (BE-3769), as Candle's API now runs them: a published agent's Hyperliquid fill goes to the site banner's and the Discord announcer's feed as `perp_open`, `perp_add`, `perp_reduce` or `perp_close`, under the same rule as a token trade. Source is candle-monorepo `ba1be9ffa` (#3935), a **staging build** that changes no CLI, MCP or SDK file: the CLI there says 0.13.31, MCP 0.10.36 and SDK 0.6.25, the versions npm already has, and none of them takes `hide` on a perps order yet. This section is a draft until a release carries the client side; the fixtures are re-read then. The source/build version is 0.6.6; publishing remains a separate release step.

### Perps in the activity stream

- **Eighty-six offline scenarios** (`scripts/read-perps-stream-source.ts`, `test/fixtures/candle-perps-stream-source.json`) run the API's own eligibility rule, perps event code and broadcaster against a stand-in venue and a stand-in published-agent lookup, subscribed to the stream itself. Every fetch is refused; no address, key or figure is real.
- **The one rule:** each of the five perps types (`perp_liquidation` included) gives the same answer as a `buy` on the same facts, in nine cases. A fill goes out only while `AGENT_TRADES_IN_STREAM_ENABLED` is `true` or `1`, only for a published agent's key, and never for an order placed with `hide`. A private agent, a blank name, a human's order with no agent key, and a missing or blank key all stay out.
- **The kind** comes from the position's size before and after the fill: from flat, or flipped through zero, it is an open; growing is an add, shrinking a reduce, to flat a close.
- **On the wire:** the agent's name, `coin` (`dex:COIN` for a builder dex), the side held, the leverage, the notional in dollars and, on a close only, the realized P&L in cents. A reduce carries no P&L. A closed position's leverage is read from the account's asset setting and is left out when that read fails. No owner, wallet, key, member handle or agent marker is sent.
- **Nothing is sent** for a hidden order, a private agent, the switch off, a failed agent lookup, a blank key, a failed venue read or an unreadable size, and none of them throws. A hidden order and the switch off stop before the agent lookup is made.
- **Each fill increase goes out once:** the settle transaction claims it (`streamedSz`) and reconcile announces only that claim, for open, close, modify and TP/SL rows. An increase is priced from the order's own fills by cloid (volume-weighted; bad sizes skipped). Pinned as source text, with the schema fields.
- **`hide` on perps orders:** `open`, `close`, `modify` and `tpsl` parse it as a trade does (`true`, `"true"`, `1`, `"1"`; anything unreadable is a 400 naming `hide`), store it as `streamHidden`, echo `hide: true`, carry it in the client-id fingerprint and answer a replay from the stored flag. A modify of a hidden order stays hidden. The Candle Harness's own reading of `hide` agrees with Candle's on every recorded value, except `null`, which the Candle Harness refuses as unreadable rather than read as public.
- **No hide switch:** at this commit `AGENT_HIDE_ENABLED` is deleted (BE-3734) and no API code reads it, so `hide` is always taken. The card's "400 while the switch is off" doesn't exist any more and isn't recorded.
- **What the Candle Harness does:** it refuses `--hide` on `candle perps open`, `close`, `modify` and `tpsl` (`FLAG_NOT_ALLOWED`, nothing sent), because the pinned CLI has no such flag, and it refuses every MCP perps write (`NOT_YET_SUPPORTED`, as before). An agent can't send a perps order it believes is hidden. When a CLI release takes `--hide` on perps, the command table is re-read and the cards carry it as they do for a trade.
- Not here: liquidation events (the type and the rule exist; the ingest doesn't emit yet), the CLI, MCP and SDK `hide` with its fail-closed echo check, the banner and the Discord bot. The signed CLI release pin (`install.sh`) and the runtime minimum (0.13.28) don't move.

## 0.6.5 (unreleased)

How fresh an agent's public Hyperliquid figures are (BE-3767), as Candle's CLI, MCP server and SDK now say it. Between certified hours Candle reads each perps wallet again every board build (about 10 minutes), marks those figures provisional and gives the hourly certified cutoff under them; the hourly certified snapshot stays underneath, and replaces the provisional figures when it certifies the hour. Source is candle-monorepo `df74deb0d` (#3929 and #3962), a **staging build**: the CLI there still says 0.13.30, its MCP server 0.10.35 and the SDK 0.6.24, the same versions as npm, which doesn't carry the change yet. Every recording below is made against that commit, not a published package. When Candle publishes versions that carry it, the fixtures are re-read at that release and these numbers move. The source/build version is 0.6.5; publishing remains a separate release step.

### Perps freshness in an agent's positions

- **`candle_get_agent_positions` says which kind of figures it gives.** With `perpsProvisional: true`, `perpsAsOfMs` is the time of a provisional read made that board build and `perpsCertifiedAsOfMs` is the hourly certified cutoff under it; without it the figures are certified, about an hour behind. The Candle Harness passes the read through unchanged, so the agent sees the three fields as Candle sent them, and `candle agent positions` through `candle_cli` still points at that tool. Nothing in the Candle Harness changes how the read runs: it is a keyless read, as before.
- **Sixty-seven offline scenarios** (`scripts/read-freshness-source.ts`, `test/fixtures/candle-freshness-source.json`) follow one made-up wallet through one made-up day, thirteen board builds in all. Each positions answer is built by Candle's own pure source (the perps profile, the board's publish over the build before it, and the positions and record answers) from stored facts the recorder writes, then read through the registered MCP tool, the SDK's `getAgentPositions()`, `candle agent positions` and `candle agent positions --json`. The four give the same answer each time, each in one read with no key sent by the tool or the CLI.
- **Between certified hours:** certified figures carry the certified cutoff and no mark; a provisional read carries its own time, the mark and the certified cutoff under it, and a close made since the cutoff is already in the figures; the time moves about 10 minutes with each build while the certified cutoff stays; one missed refresh (12 minutes) is still provisional; past 15 minutes the read is dropped and the certified figures come back at their real age.
- **The certified hour underneath:** when the next hour certifies it replaces the provisional figures with the same realized figure and fees, and a read still standing on the older cutoff is not used, however new; the next provisional read stands on the new cutoff. While certification lags, a fresh provisional read keeps the figures served and says how far behind the certified cutoff is. A provisional read alone never makes figures: not over a certified cutoff more than 6 hours under it, and not for a wallet with no certified hour.
- **Delayed and unavailable perps at the new cadence:** past 2 hours with no fresh read of either kind the certified figures are served partial, still valued; past 3 hours the perps are unavailable, with no perp rows, no combined portfolio value and no perps time, never a flat book. An agent with no perps answers null perps times and no flag.
- **What the CLI prints.** Under `Updated`, `Perps as of <time> (certified hourly)` or `Perps as of <time> (provisional; certified to <time>, corrected hourly)`, and no such line without a perps time; `Portfolio unavailable (perps not reconciled yet)` and `; perps partial` are recorded for the unavailable and delayed builds.
- **What Candle's docs say.** The public agent-trading page's freshness line is recorded from its three copies, which agree: the 10-minute cadence, the certified snapshot as the backstop, the 15-minute and 3-hour limits. The re-read tools/list carries the positions tool's new description, and the SDK's changelog entry is recorded beside it.
- **Every source fixture is re-read at `df74deb0d`:** the CLI table (174 commands), tools/list (104 tools), the 94 MCP/SDK scenarios, the 25 perps, the 59 spot and the 67 transfer rows. Apart from the positions tool's description and the commit they name, they are unchanged.
- The recording holds no wallet address, key or account value: the made-up wallet's address goes into Candle's source, which hashes it, and is in no row. No database, perps job, venue, signature or network was used, and the keyed API route isn't run. No staging or production read was made.
- Not here: a read of the agent record through the CLI, the MCP server or the SDK. They have none at this commit; the SDK's `AgentPublicRecord` type gains the two fields, and the record answer Candle's source builds is recorded with them. Also not here: the corrections Candle writes when a certified hour differs from the provisional figures it replaces, builder-dex figures in the public record, and any live read of a wallet that has the provisional job on. The signed CLI release pin (`install.sh`) and the runtime minimum (0.13.28) don't move.

### The CLI's swap fast path

Candle's CLI (BE-3923) now starts `candle swap`'s three independent reads together, remembers a passed execute probe for a day, and says in its README to point a TEE swap's local simulation at a private RPC. Source is candle-monorepo `ebaf6b883` (#3983), a **staging build**: the CLI there says 0.13.31, MCP 0.10.36 and SDK 0.6.25, which npm doesn't carry the change in yet; this section is a draft until a release does, and the pin moves with it.

- **Twenty-one offline scenarios** (`scripts/read-swap-source.ts`, `test/fixtures/candle-swap-source.json`) run the CLI's own source against stand-ins for the API, the relay and the RPC. Every fetch is intercepted; nothing is signed with a real key and no address, key or figure is real.
- **Parallel reads:** the job lookup, the wallet read and the mint-decimals read are all on the wire before any is answered (the recorder holds each until the three have arrived, and fails if one never does), and the build comes after.
- **The same outcomes in the same order:** a job already stored under the id is printed as it is even when the wallet read failed; with several reads failing, the job's error comes first, then the wallet's, then the decimals'. Nothing is built in any of them.
- **The execute probe:** an embedded wallet's first trade probes and executes; the next, within the day, only executes; after 25 hours or against another API URL it probes again. Declining the quote leaves the pass cached. A deployment that fails the probe is refused before any build and is never cached as supported.
- **A private RPC:** a TEE swap's local simulation reads only from the RPC the flag, then the variable, then the profile names (the public endpoint only when none is set), and only its host is shown; an RPC that isn't https is refused as usage before any request is built, and is never echoed.
- Every code in the recording is one the trade path already maps. Nothing in the Candle Harness changes: it runs `candle swap` as before, and the CLI release pin and the runtime minimum don't move.


### The web swap's second RPC and quick-buy prefetch

Candle's web app (BE-3925) now presses the quick-buy quote early and sends a signed swap through more than one RPC. Neither is a CLI, MCP or SDK change: source is candle-monorepo `be55c5f90` (#3989), a **staging build** whose CLI says 0.13.31, MCP 0.10.36 and SDK 0.6.25, the versions npm already has. There is no release to pin; this section is a draft, and says so, until Candle ships the change to production.

- **Forty offline scenarios** (`scripts/read-fanout-source.ts`, `test/fixtures/candle-fanout-source.json`) run the API's own send fan-out module against stand-ins for every endpoint. Every fetch is intercepted; no address, key, endpoint or signature is real.
- **Which endpoints:** unset on a deployed instance is Solana's public endpoint, unset locally is none, blank is none; an entry that is not https, carries userinfo, repeats or is the primary is dropped, and the list stops at four.
- **With preflight, the primary first:** copies leave only after the primary answered with a signature, with the same bytes and no second simulation, so a refused send still means nothing was sent. An error, an unreadable answer or no answer sends no copy.
- **A resend that skips preflight goes everywhere at once.** The caller's answer is always the primary's, unchanged; a copy never delays it, and one that fails is reported by a short class (`http 429`, `rpc -32002`, `timeout`, `network`), never an endpoint or an error text.
- **One plain `sendTransaction` only:** a batch, a read or a simulation never fans out, and no tip-paid sender is a target.
- **The web side is pinned as source text:** the proxy is asked for by address, only the send is redirected, and a signed-in press on an unarmed row starts the quote but never buys. A browser run is not part of this.

### The swap build's cached reads and parallel checks

Candle's API (BE-3920) now keeps a fresh blockhash and the route's lookup tables in memory between builds, starts the trade build's independent checks together, and gives DFlow 400 ms to quote instead of 800. None of it is a CLI, MCP or SDK change: source is candle-monorepo `d47d37404` (#3984), a **staging build** whose CLI says 0.13.31, MCP 0.10.36 and SDK 0.6.25, the versions npm already has. There is no release to pin; this section is a draft, and says so, until Candle ships the change to production.

- **Thirty-seven offline scenarios** (`scripts/read-build-cache-source.ts`, `test/fixtures/candle-build-cache-source.json`) run the API's own build caches and the composer behind the web's `POST /jupiter/swap` against a stand-in connection and a stand-in Jupiter. Every fetch and RPC is intercepted; no address, key, hash or signature is real.
- **The warm blockhash:** a hash younger than 1.5 s is served as is and one 1.5 s old is read again; a burst of callers shares one read; each connection keeps its own. A failed read is never kept, and an expired hash is never served in place of one.
- **The lookup tables:** a table younger than 10 s is served as is, per address and per connection. A table the RPC can't read, or fails to read, is never kept; a dropped table alone is read again.
- **The web's buy:** a second buy inside both windows reads neither and still carries the fee, on the RPC's own hash and height. Past a window, only that read is made again. An agent build on the same connection warms the web's buy; three buys at once share one hash read, while each reads the table (the table cache has no shared read). A buy whose table can't be read composes without it, and the next buy reads it again. A failed hash read builds nothing to sign.
- **A table that grew since it was cached:** the message overflows, the composer reads the tables again once and keeps the fee; when the route still doesn't fit, it falls back to Jupiter's own fee-free transaction exactly as before (`input_fee_packet_limit`).
- **Pinned as source text,** since the handlers sit behind auth, Convex and the database: the web buy uses the process's one connection and no priority cap; the trade build starts the route breaker's read and the linked payer's read together, still answers `SWAP_ROUTE_FAILING` before the payer is used, starts the feed read early, and reads wallets on the fresh path; DFlow's quote budget is 400 ms.
- **Mapped codes only:** the build's checks answer `SWAP_ROUTE_FAILING`, `AGENT_WALLET_MISSING` and `VALIDATION_FAILED`, each of which the Candle Harness reads as refused with nothing sent. Nothing in the Candle Harness changes, and the CLI release pin and the runtime minimum don't move.

## 0.6.4 (unreleased)

Own-balance transfers on Hyperliquid (BE-3765), as Candle's CLI, MCP server and SDK take them: USDC between a wallet's main perps balance and a builder dex, never to another address. Source is candle-monorepo `ceda02328` (#3928), a **staging build**: the CLI there still says 0.13.30, its MCP server 0.10.35 and the SDK 0.6.24, the same versions as npm, which doesn't have the transfer commands yet. Every recording below is made against that commit, not a published package. When Candle publishes versions that carry it, the fixtures are re-read at that release and these numbers move. The source/build version is 0.6.4; publishing remains a separate release step.

### `candle perps transfer`

- **It is in the command table, and the user runs it in their own terminal.** `perps transfer --to-dex <dex> <amount>`, `--from-dex <dex> <amount>` and `--from-dex <dex> --all` move the key's own USDC and need `perps:write`, but they sign a typed action, which isn't a card in the Candle Harness yet. The commands pane and the agent say so (the row is held "coming", as `perps deposit` is). `perps transfer status <id>` is a read and runs at once. The agent can't pass `--yes` or `--no-submit` to the command.
- **`candle_perps_transfer` is classified with the perps writes:** refused here, with the pointer to `candle_cli`. It's in the re-read tools/list (now 104 tools): `toDex` and `fromDex` only, and no destination, token or sub-account field.
- **Sixty-seven offline scenarios** (`scripts/read-transfer-source.ts`, `test/fixtures/candle-transfer-source.json`) on made-up addresses and a stand-in for every request. Seventeen run the transfer check through its SDK, MCP and CLI copies, which give the same answer each time: honest moves into a dex, out of it and out of it for all pass; another destination (in the typed data or only in the action), another token, a sub-account, another dex or direction, a changed amount or id, a testnet chain, a foreign domain, a differing action, a missing nonce and missing typed data are each refused with their reason. Twenty-seven run `candle perps transfer`: the id, amount and both balances are shown before the prompt (and a declined prompt builds nothing); with `--yes` the request names the wallet and no destination, and the run stops before the relay is asked to sign; `--no-submit` builds and checks only; a hostile build is refused before the relay; perps to spot (`--to-spot`, `--from-spot`), two directions or none, `--all` into a dex or with an amount, `spot` as a dex name, a malformed dex, amount or id are refused with nothing requested; and the API's refusals for an unknown dex, a dex not collateralised in USDC, more than the source can release and nothing to move come through with their codes. Twenty-three run the MCP tool and the SDK's `perpsTransfer()` on the same builds: to a dex, from a dex and all, checked without signing; one whole MCP flow against stand-ins for the relay and venue; and the same refusals. Candle's refusals are response stubs carrying the route's own codes; the keyed API route isn't run. No funded balance, signature, transfer or network was used, and the recording holds no wallet, key or account figure.
- **Every source fixture is re-read at `ceda02328`:** the CLI table (174 commands), tools/list, the 94 MCP/SDK scenarios, the 25 perps and the 59 spot rows. Apart from the transfer command and tool and the commit they name, they are unchanged.
- Not here: perps <-> spot moves (BE-3864, still building, and refused by this release's CLI, MCP and API); a withdrawal's sweep of builder-dex balances before it goes out, and its retry under the same client id; and any live or staging transfer. The signed CLI release pin (`install.sh`) and the runtime minimum (0.13.28) don't move.

## 0.6.3 (unreleased)

Hyperliquid spot, as Candle's CLI, API and pre-sign check take it (candle-monorepo `0b0ecb5b0`; the CLI there is 0.13.30, its MCP server 0.10.35 and the SDK 0.6.24). The source/build version is 0.6.3; publishing remains a separate release step.

### Published CLI 0.13.30, MCP 0.10.35 and SDK 0.6.24

- **Every source fixture is re-read at `0b0ecb5b0`**, the commit that bumped the three packages for builder-deployed (HIP-3) markets and is now live on npm (`@candledottv/cli` 0.13.30, `@candledottv/mcp` 0.10.35, `@candledottv/agent-sdk` 0.6.24). Between `7916d4836` and it the CLI, MCP and SDK source changed only in their version strings and the SDK changelog, so the command table, the 103-tool list and the launch pairs differ only in the commit and versions they name.
- **The builder-dex scenarios run again at that commit:** the MCP/SDK contracts (94 offline scenarios, the `dex:COIN` ones among them), the 25 refusal and disclosure rows (`dex:COIN` names, per-dex universes, the terms before each order), and the 59 spot rows all pass against the released source. They are offline, against synthetic venue data; nothing is sent to production, whose API takes `dex:COIN` only from the 09:00Z promote.
- The signed CLI release pin (`install.sh`) and the runtime minimum (0.13.28) don't move: they follow the signed native release, not npm. Candle's transfer commands (#3928) aren't in this release, so they aren't covered here.

### Hyperliquid spot

- **`candle perps spot` is in the command table.** `markets` (with `--all` and `--limit`) and `balances` run at once as reads with the agent's key; bare `perps spot` prints its usage. `buy`, `sell` and `cancel` are coming: they aren't cards in the Candle Harness yet, so the commands pane and the agent say the user runs them in their own terminal, where the CLI shows the pair, Hyperliquid's spot fee and Candle's builder fee (on sells only) before it asks. The agent can't pass `--yes`, `--no-submit` or `--sign-only` to any of them.
- **The CLI source table follows `7916d4836`.** The reader now takes `case "buy": case "sell":` falling through to one handler as two words, so the table records all five of spot's words. The parity check and the commands pane count a word as documented when the subcommand's handler dispatches it and its help row lists it among `<markets|balances|buy|sell|cancel>`.
- **Fifty-nine offline spot scenarios** (`scripts/read-spot-source.ts`) read a made-up spot book in Hyperliquid's shape: sparse pair indexes and reversed contexts with a decoy, so a pair is found by its coin, never its position. Twenty-four rows run the API's own spot gate: a pair resolves by name, case-folded name, `@index` or canonical name to asset `10000 + index`; delisted (no longer listed), below the $100k daily volume floor, one-sided, unpriced, non-USDC, ambiguous and malformed markets are refused, each naming its rule; an exit isn't held to the floor and a cancel needs no book; size, price, slippage and free-balance rules. Nineteen rows run the pre-sign check through its SDK, MCP and CLI copies, which give the same answer each time: honest buys, sells and cancels pass; a builder on a buy, a builder above 0.1% or not Candle's, another pair's or a perp's asset, a non-USDC or delisted pair, a price outside slippage, a changed size or side, a buy from a reduce-only key, typed data for another action, and a cancel of another order are refused. Sixteen rows run `candle perps spot`: the pair, the spot fee and the builder fee (none on a buy, Candle's on a sell) are shown before the prompt and, with `--yes`, before the relay is asked to sign; a hostile build is refused before the relay; the embedded wallet, a malformed pair and a resting order without a price are refused with nothing requested; Candle's refusals for delisted, below-floor, one-sided and non-USDC markets come through with their code; the market list leaves refused pairs out unless `--all`. Candle's refusals and the market list are response stubs made by the pure gate; the keyed API route isn't run. No funded balance, signature, order or network was used, and the recording holds no wallet, key or account figure.
- **Every source fixture is re-read at `7916d4836`.** The tools/list (still 103 tools: spot has no MCP tool yet), the MCP/SDK contracts, the perps contracts and the launch quote pairs are unchanged but for the commit they name.
- **`candle_cli`'s description stays inside its size.** The reads line names a command once for its subcommands that run the same way, and the later line says a command's words once for siblings (`spot buy, sell, cancel`).
- Not here: spot's MCP tools and SDK methods, spot holdings and realized P&L in the agent record and positions (with the venue tag), `--hide` on spot orders and its echo check, and moving USDC between the perps and spot balances. Candle hasn't shipped them yet; each comes with its own source re-read.

## 0.6.2 (unreleased)

Builder-deployed (HIP-3) perps markets on Hyperliquid, as Candle's CLI, MCP and SDK source take them (candle-monorepo `578db6462`; the CLI there is 0.13.29 and its MCP server still says 0.10.34). The source/build version is 0.6.2; publishing remains a separate release step.

### Builder-deployed perps markets

- **Markets on a builder dex are named `dex:COIN`** (`xyz:TSLA`), as the CLI takes them. `candle perps close` and `candle perps tpsl` cards accept such a name, and the journal's perps entry keeps it; a malformed name (an empty side, a second colon, a dash, a dex over 12 characters) is refused before a card, and nothing is sent. Main-exchange names are unchanged. Flatten still reaches the main exchange only, and its card says so.
- **`candle_perps_markets` takes `dex`** (a builder dex such as `xyz`, or `all`), which reaches Candle unchanged as any perps read does; `candle perps markets` through `candle_cli` points at that tool. `candle_perps_market` takes `dex:COIN` and answers the market's terms: its dex, who deployed it and who sets its oracle, cross or isolated only, its own maximum leverage, its collateral and its fee, with a warning when the fee is above 2x the main exchange's.
- **Three new keyless reads are classified as reads:** `candle_get_perp_candles` (Candle's cached perp candles, builder dexes included), `candle_get_agent_perp_round` and `candle_get_agent_open_orders` (a published agent's perps round and open orders).
- **Source contracts follow `578db6462`.** The tools/list fixture is re-read (103 tools: `dex` on the market list, the three reads, and the perps tools' new words). Twenty-six offline MCP/SDK scenarios read a synthetic Hyperliquid with made-up dexes and addresses: per-dex asset ids (`100000 + dex * 10000 + index`), the dex list with deployer, oracle setters and collateral, the terms and the fee warning, and the refusals (delisted, a dex not collateralised in USDC, the per-dex kill switch, an unknown dex, a malformed name or filter). MCP and the SDK agree on each. Sixteen rows run the API's own perps gate on the same universes: the kill switch refuses an open on its dex and a close still resolves there; delisted, non-USDC and malformed names are refused either way; an isolated-only market carries its own leverage cap and margin mode into the build.
- **The CLI source table now follows 0.13.29 at the same exact commit.** Typed `candle perps markets --dex xyz` and `--dex all` are accepted as reads. The complete source refresh also records `agent round`, `agent positions --orders`, and the source's hide flags; the signed release capture and runtime minimum remain pinned separately.
- **Twenty-five additional offline scenarios** cover CLI/MCP/SDK refusal envelopes, CLI market disclosures before the confirmation prompt and with `--yes` before the intercepted signing relay, and MCP/SDK TP/SL attachment and replacement dry runs. Cross-margin and market leverage-cap answers are explicitly labelled response stubs; the keyed API route is not executed. Delisted, collateral and halted-open refusal responses come from the pure API gate. No transaction signature, submission or funded balance is used.
- Not here: a recording that needs a funded builder-dex balance (that waits on moving funds between dexes).

## 0.6.1 (unreleased)

The command table and source contracts follow Candle CLI 0.13.28 and MCP 0.10.33. The source/build version is 0.6.1; publishing remains a separate release step.

### Candle CLI

- **A sell that quotes zero is refused, not unknown.** The CLI now fails a Hood sell whose build pays zero with `SELL_PAYS_ZERO` before signing; Harness reports it as refused, with nothing sent, instead of reading the trade back.
- **The table was read again from the CLI's source** (0.13.28, up from 0.13.20), and `candle_cli` now knows seven more commands: `swap receipt` (re-reads a one-shot swap's settlement from chain, a read), `signals scorecard`, `signals records` and `signals record` (hacc's daily scorecard and each signal's record, reads), and `lp status` (an LP operation's state by its client trade id, a read). `swap recover` and `swap cancel` are held with why: each moves a Hood TEE operation's state on Candle's side, so you run them in your own terminal (cancel exits 0 released, 3 a leg may have been signed, 1 refused).
- **`swap status --operation <id>`** reads a Hood TEE guard's operation, and `--wait` follows every leg for up to ten minutes (exit 0 completed, 1 failed, 3 partial or unresolved).
- **Flags and words the CLI changed.** `launch` takes `--quote`; `tee check` takes `--chain solana|hood`; LP's add, positions, remove and claim take `--wallet embedded`; `keys stop`, `resume` and `revoke` take a prefix or a label; `vault promote` takes `--to-key`; `transfer` from the embedded wallet takes `--client-id`. A resumed key is resumed in the signed-in console, since the server refuses a device token there.
- **Launch quote selection and checks.** Both launch tools accept `check: true` as a read, in live or paper mode, without creating a card. Fixed quote symbols and addresses bind the seed's asset and chain; unsupported quotes and conflicting selections refuse before a preview or card. An older server that does not list these controls is refused before forwarding them.
- **Current MCP contracts.** The offline source recorder refreshes all 100 tools, including signal scorecard/records/record and swap receipt reads. Hood guard operations can be read with `operationId`, preserving held reasons; recovery stays an owner step. Twenty-two local MCP/SDK scenarios cover quote admission, paused/split and old-server answers, fixed quote selection, and perps wallet selection before signer checks. Perps writes keep the Harness's existing TEE-only policy.
- **Reference update prepared.** The generated reference pages and docs version pin are supplied as a tested patch in `test/fixtures/parity-0.13.28/`, with the remaining docs owner recorded. The runtime minimum and installer requirement are 0.13.28, verified against the published npm package (registry signature, tarball integrity, CLI version and MCP 0.10.33 public tool definitions). The separately signed native bootstrap remains 0.13.24 while its 0.13.28 binary manifest is unavailable; it is offered explicitly as a file-signature verifier, with the npm 0.13.28 runtime requirement stated. It is never described as sufficient to run the Harness. The released CLI's staging Read-key tools/list recording now verifies 96 definitions against the source fixture, with separate CLI 0.13.28 and MCP 0.10.33 pins. The four conditional profile-edit tools remain marked source-only. No tool calls or transactions were used for that capture.

### Per-order hide (SDK 0.6.23, MCP 0.10.34)

- **Source contracts follow MCP 0.10.34** (candle-monorepo `a6a801ac6`; `candle_trade`, `candle_swap`, `candle_launch_token` and `candle_launch_and_seed` take `hide`, which keeps one order out of Candle's public activity stream; the SDK's `swap`, `trade`, `launch` and the build calls take it too). The CLI is still 0.13.28 and ships MCP 0.10.33: that release's recording is checked against the 0.10.33 source it was built from, kept in `test/fixtures/candle-cli-release/`, and the new source is checked to differ from it by `hide` alone.
- **The agent may pass `hide`.** It is in the argument table for the four tools, and reaches Candle unchanged on a card. On a server that predates it the field would be stripped and the order public, so the Harness refuses with `UPDATE_CANDLE` before anything is sent (`hide: false` needs nothing).
- **Eighteen offline MCP/SDK scenarios** record the echo check and the refusals: a hidden order must come back with Candle's `hide: true`, else MCP answers an error and the SDK throws `HIDE_NOT_CONFIRMED`; a hidden launch is dry-run first, and a dry run without the echo stops it before anything is launched; an unreadable `hide` and `hide` with paper are refused before any request; a public launch and swap send no `hide` and no extra dry run.
- **Relay's Hood router swap calldata pin** (candle-monorepo #3880) lives in the API and the CLI's `relay-constants.ts`; the Harness holds no copy of that calldata, so no assertion changed.
- **A hidden order says so on its card.** A trade, sell or launch that carries `hide` shows an amber line before the press: it stays out of Candle's public activity stream, still counts in the agent's own record, and the trade is on chain; a hidden launch adds that Candle shows no name on it and the creator wallet is still public on chain (design D1 = A). Details show it as `hidden`. Display only: the params, or a TEE card's argv, carry it into the hash.
- **A TEE wallet's hidden trade keeps `--hide`.** `candle_trade` with `hide` from a TEE wallet used to become `candle swap … --yes` without it, which would have placed the order publicly. The card's argv now carries `--hide` (bound by the hash). A `candle` older than the swap that takes the flag refuses it as an unknown flag, so nothing is sent and nothing goes public; the card says to update the Candle CLI, and it isn't logged as the Harness's bug. An unreadable `hide` is refused before the card, and a TEE swap between base assets with `hide` is refused here, as the CLI refuses it.
- Not here yet: the CLI table re-read with `launch --hide` and `swap --hide`, the CLI minimum, `harness-version.json` and the four generated docs pages. They wait for a published Candle CLI whose `swap` takes `--hide` (candle-monorepo #3873 merged after 0.13.29 was published; BE-3699).

### Perp position pages (candle-monorepo #3922, BE-3756)

- **Source contracts follow candle-monorepo `7354c785a`** (MCP 0.10.34 with three new keyless reads; CLI source 0.13.29): `candle_get_agent_perp_round` (one perp round of a published agent, open as `open:COIN` or closed: fills, funding, Hyperliquid and Candle builder fees apart, return on margin, outcome), `candle_get_agent_open_orders` (its open limit and take-profit / stop orders with their trigger prices, `[]` with none) and `candle_get_perp_candles` (a perp coin's cached candles, builder dexes as `dex:COIN`). The tool table classes all three as reads, and the 103-tool source list is re-recorded.
- **Twelve offline MCP/SDK scenarios** record each read through the real MCP server and SDK client against local stubs: one GET each, the same path from both, no credential from the MCP tool, a closed and an open builder-dex round, open orders with and without any, default and builder-dex candles with `interval`, `count` and `end`. The fixtures are invented values; nothing in an answer or recording carries a wallet, order id or cloid, and no network, tool call or order was used.
- **The released CLI 0.13.28 has none of the three.** Its recording is still checked against the 0.10.33 source it was built from, and a test pins that the current source differs from it by `hide` and these three tools only.
- Not here: the `candle agent round` command row. The CLI table is not re-read (it follows 0.13.28), so `candle_cli` does not list `agent round` or `agent positions --orders` until the CLI release (and its re-read, which also brings `swap --hide`). The agent reaches the same reads through the three MCP tools above. The Harness version stays 0.6.1, unreleased.

## 0.6.0 (unreleased)

Robinhood Chain, and the Harness starts live.

### Robinhood Chain

- **Both of Hood's wallets trade.** The account's embedded wallet on Hood is listed, valued and traded like Solana's, percent sells included. Each agent can have Hood TEE wallets of its own: the `add a Hood wallet` chip makes an EVM vault key where there's none and promotes it to the agent's key, then offers ETH to fund it (a bridge, `vault fund`, or its address). A Hood TEE wallet trades one at a time: a second approved trade waits in the Harness and is sent when the first settles. Stop and sweep take its `0x` address.
- **Bridges, on a card.** `bridge 0.5 sol to eth`, or the agent's `candle_bridge`, moves funds between Solana and Hood: embedded to embedded, or between one key's own TEE wallets (`from <wallet> into <wallet>`). The card says the route, "less Relay's fee", and the arrival, followed by Candle's status. A bridge isn't spend, a fill or P&L.
- **Typed trades on Hood:** `eth` and `usdg` spend on Hood (a dollar buy pays in ETH). A token name seen on both chains isn't traded by name: chips on the message line put either address on the line.
- **A chain filter.** `all chains ▾` beside the agent chip shows Solana, Hood or both, once the account has wallets on both chains; every listing pane follows it. Wallets and Positions go under chain headings, each wallet in its own asset, and a Hood card says "· on Hood". Trending lists New, Graduated and On Fire on Hood.
- **Hacc's safety check on Hood** in the token pane (Pro and Max), each field said as Hacc's.
- **Approvals on Hood:** the embedded wallet on Hood has its own two figures in `settings ▾` → approvals; ETH and USDG buys count at their dollar value, USDG at Candle's $1.
- **A default wallet per chain:** `[agents.<name>.wallet] solana = …, hood = …`; the single `wallet` line still works. `candle.evmRpcUrl` sets the Hood RPC.
- **Bots and triggers on Hood:** `chain = "hood"` in `bots.toml`, code bots' trades with their chain, and price, market-cap and tape triggers on Hood. A trigger records the signals it skipped, and why ("not on Candle", "no market cap").
- **EVM private keys** pasted into the input line are refused when they belong to one of your wallets, or sit next to words like "private key". The diagnostic paste log keeps no text of any paste holding a bare 32-byte hex value.

### Fixes

- **A key whose prefix starts with "-"** (about 1 in 32) no longer stops setup at the wallet step: the Harness reads such a prefix as the CLI does, and names the key by its label where `vault promote` needs it.
- **The fund step** says it's reading the wallet's balance until it has, rather than "0 SOL".
- **ctrl-] in the Build tab** always leaves the harness, even with an ended command pane left.
- **A code bot that ended by itself** stays ended across a restart.
- **A percent sell right after a buy** is sized from what the wallet holds now; a filled sell or swap shows what Candle's answer gave back.
- **`⧉ copy it`** copies a CLI answer that parses as JSON; a refused `vault status` says why in its pane.
- **The go-live check and the doctor count Hood wallets.** A key denied the embedded wallet that holds an active Hood TEE wallet isn't told it can't pay; a Hood TEE wallet, or the embedded wallet on Hood, set to trade inside limits is shown with the agents that pay from it.
- **LP's hold reason** says what still blocks it: Candle serves LP, but no key preset grants `lp:write` yet.

### Setup

- **Setup ends in live on a fresh install.** Funded at the deposit step, or going on with **Fund it later**, the Harness opens live; so does Straight in. A fresh `config.toml` says `mode = "live"`. A trade from a wallet that can't cover it is refused before anything is sent: it says the wallet doesn't hold enough SOL (ETH on Hood), and to send some to its address in the Wallets pane, or trade less. A trade from a key not yet allowed a wallet is refused with the line that allows it. Paper is still there, from the status bar or by typing `paper`.
- **Running setup again keeps your mode.** Adding an agent, guided or Straight in, never switches the Harness to live: paper picked from the status bar or by typing `paper` (during a first setup too, even while already on paper), or an older install's `config.toml` that says `mode = "paper"`, stays paper, for every agent. The fund step and the summary after setup say so, and how to go live from the status bar.
- **The summary after setup** says "a card per trade" only when the wallet asks every time.
- **The agent's greeting doesn't suggest paper.** Its examples and its first lines are about trading; paper is still in help and the status bar.
- **The agent doesn't steer you to paper.** Live, its instructions say the Harness is live and not to suggest paper trading or a rehearsal unless you ask; they explain paper only when you've switched to it. A strategy-lab or backtest pass is read as "not proof it will pay live", never as a reason to paper-trade.

## 0.5.6 (2026-11-10)

Fixes from Candle's review of 0.5.5, and Hood TEE wallets trade. The review's fixes change what can pay only to narrow it (the second below); Hood TEE wallets, below, are a new wallet an agent can pay from.

### Safety and correctness

- **The confirm link is shown only on Candle's site.** For an owner step whose answer the Harness reads (making a key), the prompt pane shows the browser confirm's link only when it's on `candle.tv` over https, or on this machine. Any other link is withheld: the pane names its host and says not to approve, and the step ends unapproved when its code expires. Other owner steps print the CLI's own words as they are.
- **Candle's trading-wallets read is read to its last page, and decides.** Where the agent's MCP server has it, every page is read (up to ten). A complete read is the whole list of what may trade, so a wallet it leaves out can't pay, whatever the key's own list says. A read cut short leaves the wallets it didn't reach as the key's list says.
- **A Solana wallet is never taken for a Hood one** when the key's list and the portfolio are matched by address.

### Tests

- The wallet join by address has tests that fail if it's reverted to ids: another id with no trading read, a Hood address in another letter case, and a Solana address in another case, which is another wallet.
- The trade-path bench is held to 50 ms again, and isn't part of the release gate: on a shared CI runner it measured the runner rather than the code.

### Hood TEE wallets trade

- **An agent trades from its Hood TEE wallet.** A Hood TEE wallet bound to an agent's key was listed and refused every trade with "trades from Hood TEE wallets come in a later release". Now a buy or sell of a Hood token, against ETH or USDG, and a swap between ETH and USDG, pays from it, through your own `candle swap` with the agent's key, as a Solana TEE wallet's trades do. The CLI signs it one leg at a time; the card binds the same words, and an unclear answer is read back under the same id, never sent twice.
- **Which wallet a Hood trade pays from.** Named, a Hood TEE wallet pays only for a Hood trade: named for a Solana token it's refused as the wrong chain, as a Solana wallet is for a Hood token. Naming no wallet, a Hood trade pays from the EVM embedded wallet where the key is allowed it, else from the key's one Hood TEE wallet, as `candle swap` picks. With more than one, name it or set `agents.<name>.wallet`. As a default, a Hood TEE wallet is kept by address, so a rename doesn't lose it.
- **Candle's RPC setting stays on Solana trades.** `candle.rpcUrl` is a Solana endpoint, so a Hood TEE card runs without `--rpc-url` and the CLI reads Hood over its own.
- **A busy Hood TEE wallet is refused, nothing sent.** A Hood TEE wallet runs one operation at a time: while another is open on Candle (`WALLET_BUSY`), or when Candle answers without a sequenced leg, the card is refused and says so.
- **Percent sells see a Hood wallet's holding.** The card's estimate reads the wallet under the portfolio's `hood`, its address and token in any case.
- **The doctor checks a Hood TEE wallet's signer**, as it does a Solana one's, instead of saying it comes later. The kill switch lists Hood TEE wallets with `candle tee disable <address>`, and autonomy and the agent's wallet note count them.

## 0.5.5 (2026-11-10)

The first release since 0.3.0, and it carries everything in 0.5.2, 0.5.3 and 0.5.4 below. **Update from 0.3.0:** see the first line under 0.5.2's "Safety and correctness".

### Candle CLI 0.13.20

- **Owner steps wait for your approval in the browser.** Candle is turning on a browser confirm for owner steps that widen a key's reach: making a key, allowing the embedded wallet, rebinding or promoting a wallet to a key, raising a cap. An older CLI can't finish those steps once it's on. The Harness now needs CLI 0.13.20, and its installer installs it. The prompt pane shows what you're approving, the link and the code, and waits up to 5 minutes. A card for such a step says so before you start. Denied or expired, nothing changes, and the card says which, in plain words.

### Safety and correctness

- **`restart it` starts the login service's core only for the service's own home.** With the service installed for one Harness home and a view open on another (`CANDLE_HARNESS_HOME`), `restart it` stopped the view's core and started the service's, for the other home: the view's home was left with no core, and the other home's triggers and bots started. Now a view on another home restarts a core of its own.
- **On a Mac, the code runner stops only its own run's processes.** At the end of a run, it stops anything the script left behind in its sandbox, a double fork included. It used to take a process in any sandbox that started during the run, so another app's sandboxed helper could be stopped. Now each run's sandbox carries a mark of its own, and only processes macOS says are held by that mark are stopped.
- **A default of `embedded` pays on either chain.** Set as an agent's default, `embedded` was pinned to the Solana embedded address, so every Hood trade that named no wallet was refused. Now it pays from the embedded wallet on the trade's chain. On paper, the input line takes either embedded address too.
- **A click right after a Build card closes approves nothing.** After a Build card closes, by a click, ⏎ or ctrl-n, clicks on cards wait 300 ms, so the second half of a double click can't approve or reject the card beneath.
- **An edit to `bots.toml`, `triggers.toml` or `wallets.toml` right after the Harness wrote it is read.** Each file was read again only when its modified time, size or inode changed. Two writes of the same size within one tick of the clock (a few milliseconds) looked like one, so a quick edit by a script or an agent, such as a bot paused in its file just after it was approved, could go unseen. Now a file changed in the last two seconds is always read again.
- **A TEE wallet made by `vault promote --to-key` can trade.** Such a wallet signs and trades, but the key's wallet list says it can't (`spendCapable: false`) and gives it another id than the portfolio does. The Harness took the list at its word and refused every trade from it with "Candle doesn't list it as able to sign yet". Now, where your agent's Candle MCP server has `candle_get_trading_wallets` (CLI 0.13.19 and later), that read decides whether a wallet can trade, and the wallets are matched to the portfolio by address, not id. With an older CLI, the key's list decides as before.

## 0.5.4 (2026-11-10)

### Safety and correctness

- **`restart it` keeps the login service's core.** After an update, the status bar's `restart it` stopped the old core and started one of the view's own, which exits a minute after the view quits. With the login service installed, that left no core, and no triggers or bots, until the next login. Now, with the service loaded, the new core is the service's (`launchctl kickstart` on macOS, `systemctl --user start` on Linux), and it runs on after you quit. The installer and `candle-harness doctor` now point to `restart it`.
- **One click approves once.** One click on a card's `approve` could reach the core twice; the second was refused, and its red "This card is being approved." stayed on the message line. Now, while a card's approval is on its way, another click or ⏎ on it sends nothing.
- **A click on a bot's card closes it, as ⏎ does.** A code bot's card from the Build tab, approved or rejected by a click, stayed open but drew nothing. It held the keys from your harness, and your harness's next bot card went to the strip instead of opening over the frame.

### Bots

- **A bot that crashed and isn't started again no longer shows as on.** Its dot is red, and the Bots heading counts it as crashed ("1 on · 1 crashed"), not on.
- **The bots folder's AGENTS.md says never to write a mint from memory.** A harness should look a token up through the client and check it before the code uses it. Existing folders get the new file unless you've changed yours.

### Words

- **"Too small" says when the kill switch is on.** With the window too small to draw, the first ctrl-x says "ctrl-x again to kill", and once the switch is on, the screen says so.
- **The doctor names the login service's core** as the service's, not as "headless".

## 0.5.3 (2026-11-10)

### Safety and correctness

- **A trade pays from a wallet on its own chain.** A Solana TEE wallet, named or set as the agent's default, was taken to pay for a Hood token: the card could be approved, checked against that wallet's figures, and Candle's CLI refused it only after the press. Now it's refused before any card, saying the wallet's chain and the trade's. The embedded wallet's Solana address named for a Hood trade, or its Hood address for a Solana trade, is refused too, never swapped for the other. `from embedded` still takes the embedded wallet on the trade's chain, and on paper either address is the embedded wallet.

## 0.5.2 (2026-11-10)

Triggers, rules bots, code bots with the Build tab, and the code runner, each through independent code and security reviews. **Update from any earlier version:** see the first line under "Safety and correctness".

### Triggers

- "When this happens, do that", run by the core with its window open or closed: a price or market-cap level (from your entry too), your P&L, Hacc's tape or your own signals, a schedule, a fill, or a call from a script. It trades, notifies you, or wakes an agent. Pro and Max.
- The agent writes each one with you, asking what your words leave open, and proposes it as a card that says whether it runs on its own or asks you each time. Your press saves it.
- A trigger's trades go through the wallet's figures, the agent's limits and the kill switch, which holds its buys and wakes and lets its sells go.
- Triggers keep the core running after you quit; `candle-harness stop` ends it, `candle-harness service install` starts it at login, and keep-awake keeps a Mac from sleeping.
- Notifications while its window isn't in front, and from the core with no window open on a Mac or a Linux desktop.
- `candle-harness ask` sends an agent a message from a script, and `candle-harness trigger` fires an `on call` trigger.

### Rules bots

- A Hacc strategy definition the core runs for you: it buys on Hacc's full tape when its pattern and filters match, and sells each position by its take profit, stop, max hold or trailing exit, with its window open or closed. Pro and Max.
- The agent writes each one with you, offers a wallet of its own first, and proposes it as a card with its worst case and the backtest of its exact definition. Your press starts it, on paper or live, whatever the app's own mode.
- Its buys go through the wallet's figures; its exits sell without a card on any wallet. It keeps its own book from its own fills and sells only its own.
- Pause, stop, flatten and remove, the kill switch holding its entries, and a pace that keeps bots and triggers clear of Candle's circuit breaker.
- The Bots tab, a Bots section in the note when you come back, and notifications: one a bot every 5 minutes at most, folding what it bought and sold, and at once for a stop or a sell that failed or is held.
- A bot buys only on a signal at most 2 minutes old, and takes a slot only once a signal passes its checks.
- Its exits judge only a price read after its buy filled. A token Candle stops pricing says so, its stop and target wait, and its max hold still sells. A sell that fails or is refused, flatten's included, is tried again, and says why once.
- A wallet of its own from the Bots tab, as from the bot's card. A fresh TEE wallet Candle can't sign for yet stays listed, marked, and is refused in those words.

### Code bots and the Build tab

- The Build tab runs your own coding harness (Claude Code, Codex, Grok, OpenCode, Pi or any command), unmodified and signed in as you, in a terminal pane in your bots folder, `~/candle-bots` unless you pick another. The folder holds `AGENTS.md` with the rules every bot runs under, the client, and nine of Candle's bot-building skills; a file you change is never written over.
- A code bot is a program of yours that trades through the core with a token of its own, never a key. Your press on its card saves it; the card approves its run settings and three figures (a trade's, a day's, open at most), not its code, and the core holds every trade to them whatever the code does.
- Its buys go through its figures and the wallet's; its sells of its own run without a card. A buy may carry exits the core holds, which keep selling while the bot is paused, crashed or held by the kill switch.
- The core runs each code bot, restarts it after a crash, gives up after five in ten minutes, keeps its last 5 MB of log with keys taken out, and starts it again with the core. A bot can also run elsewhere on the machine with `candle-harness bots token`.
- `candle-harness build` lets the Build tab's harness read every bot's book, test a bot on paper for up to 30 minutes, and propose one. `candle-harness bots` lists, starts, stops and restarts code bots, and prints their logs.
- Code bots on the Bots tab: their process, figures and today's use, held exits, what the bot says beside the core's count, and their log. A bot's word can fire a trigger: `on bot "<name>" says "<word>"`.
- The bot protocol, and `harness-client.ts`, one file with no dependencies, for Bun or Node 20 and later.

### The code runner

- Off until you turn it on for an agent: then it runs a short script with `python3`, `bun` or `node` in its research folder, held there by the operating system (macOS's sandbox, or Landlock on Linux 6.12 or later), with no network, for 60 seconds at most.

### Safety and correctness

- **Update from any earlier version.** A built binary read `bunfig.toml` and `.env` from the folder it was started in. It reads neither now, the release build checks that, and the code runner's hold starts outside the agent's folder.
- What trades spend (SOL, USDC, ETH, USDG) can't be a trade's token, live or on paper, so a "sell" can't be an unlimited conversion.
- A bot's change takes at once only when it truly narrows: an emptied filter list is wider, a slippage bound under the route's default is a card (and under 0.1% is refused), and an exit change that would sell an open position now is a card.
- A code bot's sells asked for together can't sell more than its own; a request that lands on another's card ends rather than waits; a new bot with a removed bot's name starts with an empty book and day.
- A buy read back by its id sells about what the bot's own spend bought, not the wallet's whole holding.
- A trigger keeps the mode it was approved in: switching to paper leaves a live stop live and says so. A `pnl` trigger carries its own window. A trigger that can't be read shows as not watching, with why, and reads again when it can. A woken turn switches off only its own agent's triggers.
- A stopped turn's calls make no card, and a turn that began on paper is refused once you've gone live under it.
- Enter never approves a card you can't see: not while the screen is too small, and a card that arrives under another waits 1.5 s. A Build card proposed while you type opens without the keys. `ctrl-x` twice kills from the Build tab's terminal and a prompt pane.
- A trade card and its receipt show the token's short address, in amber when that name has been another token here. A bot's card at 80×24 keeps what the press approves. A launch card says what it publishes.
- The kill switch stops first and saves after, and says when its state couldn't be saved. Re-sending a trade is the main window's alone.
- A core that has run for days still opens: closed cards are pruned, lists are bounded, and a window that stops reading is dropped rather than buffered.
- After a restart, a re-sent trade through the CLI runs with your RPC address, which no longer enters cards, operations or the Journal.
- Text from Candle, Hacc, code bots and fetched pages reaches an engine cleaned; a bot's log has control sequences and multi-line keys taken out; the paste log keeps no wallet key or recovery phrase. A pasted hex or base64 keypair, or a labelled recovery phrase, is refused.
- Activity shows the full address of every page an agent fetches.
- The code runner refuses 32-bit-table system calls and new sessions inside a held script, and never grants your home or the Harness's folder to a runtime.
- After an update, the installer, the doctor and the status bar say when the running core is still the old version. `install.sh` can't run half-downloaded. Engines and `candle` are started by full path.
- `candle-harness ask --json`, and a read-only `candle-harness cards` with `--wait`, for scripts and outside agents.
- The agent's memory view shows every line that reaches its prompt, headings included.
- A code bot that fails as it starts no longer takes the core down with it.
- A held exit and a code bot's own sell can't both sell one position. A buy read back by its id is sized only from a price within a minute of it, never past its quote with the slippage bound; with no such price the position is left to you.
- A code bot's folder and the bots folder can't be `/`, your home or the Harness's own folders. A sell trigger's smaller amount or harder-to-reach level is a card. SOL, USDC, ETH, USDG and CNDL only ever name their real mints.
- The core sends one sell of a token at a time per key, counts sells in flight toward Candle's failed-sells stop, and warns you when your sell could be the one that stops the key. Its re-send of a lost exit waits behind the same holds.
- More secret shapes are kept out of logs and the Journal, and the CLI's keyring passphrase is never written or shown.
- In a Build pane, `ask`, `trigger` and attaching as a view are refused, and bot logs reach the harness marked as untrusted data.
- Bun's own variables never reach what the Harness starts. The code runner caps a script's file size and processes and refuses namespaces and other kernel surfaces on Linux; on macOS it stops everything a script started. A held script gets only its three standard streams, and a runtime in a home folder is granted as that file alone. `ps` and `git` are started by full path.
- Triggers' and memory's text reaches the agent fenced, and a trigger's line is part of what you approved. Smaller hardening: `notify-send`, the bots folder's record, the login service's unit and the config folder's permissions.
- Every "sells run with no card" line names the exception, a looser slippage bound; a card behind a pane no longer shows `⏎`.

### Also

- A fresh install shows five tabs: Trade, Cockpit, Research, Bots and Build. Trending, Signals, P&L, Journal and Perps are one tick away in `settings ▾`.
- The agent acts when you message it, and a trigger can wake it, within caps of its own, when something needs its judgment.
- Memory lines you pin are kept word for word.
- Up to three token panes side by side.
- A token name mixing look-alike letters from other scripts carries its short address wherever it's shown, and a stray zero-width joiner no longer shows as a letter.
- A new agent's key on Free is no longer rate-limited by setup's own reads: the core counts Candle's status read and its MCP server's own start as Candle does at CLI 0.13.18, and doesn't read a new key twice in a row. A paper trade Candle refuses says why in words.
- `candle-harness service install` stops and removes the Candle TUI 0.2's login service first, if it's there, so a 0.2 core never runs on the old home; `service status` and the doctor name it. The agent's `tui_triggers` and `tui_bots` are still taken as `harness_triggers` and `harness_bots`, never listed, as the other `tui_*` names are.

## 0.3.0 (2026-11-06)

The Candle TUI is now **Candle Harness**, and its repository is [candledottv/harness](https://github.com/candledottv/harness). The guide moved to [docs.candle.tv/harness](https://docs.candle.tv/harness).

### The new name

- The binary is `candle-harness` (was `candle-tui`), and the release files are `candle-harness-<os>-<arch>`. The installer comes from `https://github.com/candledottv/harness/releases/latest/download/install.sh` and checks each file's signature against `candledottv/harness`'s release workflow at the exact tag. Run `candle-harness` to open it.
- Config and state live in `~/.config/candle/harness` (was `~/.config/candle/tui`). On the first start, an existing `~/.config/candle/tui` is copied there whole: `config.toml`, your agents' keys, the journal and every state file, each with its own permissions. The copy is checked file by file against the old folder. Once a start on the new folder has gone well, the old folder is renamed to `~/.config/candle/tui.migrated-<date>`, never deleted, and a line says you may delete it. If 0.2 wrote to the old folder after the copy, it's left exactly as it is. The copy waits while a 0.2 core is still running on the old folder.
- `CANDLE_HARNESS_HOME` names another home folder, and every other `CANDLE_TUI_*` variable is now `CANDLE_HARNESS_*`. Through 0.3.x an old name is still read when the new one isn't set (the new one wins), and the start says once which old names are in use: they're deprecated. The installer does the same for its own.
- The agent's own tools are `harness_history`, `harness_limits`, `harness_view`, `harness_pnl`, `harness_show_wallets`, `harness_name_wallets`, `harness_group_wallets` and `harness_teleport` (were `tui_*`), and its own skills are `harness-memory` and `harness-view`. The old `tui_*` names are still taken on a call through 0.3.x, deprecated and never listed to the agent, and a `tui_*` entry in an agent's `allow` or `deny` list still names the same tools.
- Setup names the Candle CLI profile it makes `candle-harness`; a profile you already use keeps its name, and 0.2's `candle-tui` profile, when no `candle-harness` one exists, is signed in again rather than a second profile made.

### Fixes

- A portfolio read whose wallet list Candle cut off (`walletsComplete: false`, or `complete: false` from a server that doesn't send `walletsComplete`) no longer marks a live TEE wallet as stopped outside the app.
- The kill switch pressed while a re-send is being written down stops the re-send: nothing is sent, and the operation is still read back.
- A CLI card row read back by running it again (`stake add`, `lp add`) is held while the kill switch stops its kind, and run after a resume inside the card's lifetime, as a swap's replay is.
- A card the kill switch stops at approval whose journal row can't be written no longer leaves its operation stuck as submitting, and the day's spend goes back.
- A stopped wallet's on-chain balance read keeps a good SOL balance when the RPC refuses the token read (the public endpoint's rate limit), and says the tokens weren't read.
- An RPC's error text reaches the Wallets pane only as plain text, never with terminal escape sequences.
- A slippage bound that isn't a whole number of basis points from 0 to 10000 is always a card.
- An address from Candle's portfolio that isn't a Solana address is never kept as a stopped wallet or put in a sweep command.
- A trade or swap error with no stage whose code says nothing was sent, but which Candle marks retryable, is read back by its id with the day's spend held, since Candle uses some of those codes for a generic server error too. A rate limit and a key limit stay refused.
- The installer links `candle-tui` only over a link or Candle TUI 0.2's own binary, never through a link to a folder, and names another `candle-tui` that comes first on your PATH.
- An old home folder with no state folder is copied too, and a copy left half-made by a start that died is removed.
- A reused `candle-tui` profile on a host other than Candle's production API is named at sign-in.
- The prompt pane drops 0.2's `CANDLE_TUI_*` variables as it does its own.
- A portfolio read counts its wallet list as whole only when `walletsComplete` is exactly `true`.

## 0.2.10 (2026-11-05)

The first public version. The guide at [docs.candle.tv/tui](https://docs.candle.tv/tui) covers all of it.

### Your agent

- Runs on a coding agent you already use and are signed in to: Claude Code, Codex, Grok, OpenCode or Pi, each held to its own research folder, with your own setup of it kept out. One engine and model per agent, picked with `ctrl-g`.
- Three presets: Quant (Candle's analyst prompt and ten of Candle's skills), Trader, and Bare. Skills of your own, and memory each agent keeps across turns and engines.
- Reads Candle and Hacc for you: the feed, the signal tape, token checks, wallets worth watching, your positions and P&L, plus your follows on Pro and the strategy lab on Max.
- Acts when you message it, and never starts a turn on its own.

### Trading

- Every trade the agent proposes is a card, priced fresh and checked against your limits; one press approves it.
- Typed trades on the input line (`buy $5 of JUP`, `sell 50% JUP`), aliases, and chains of up to five parts, each sent once the one before has filled.
- Paper and live, from the embedded wallet or a TEE wallet, and Candle's CLI commands through the agent or typed, each under its own rule.
- Owner steps and anything that asks for a passphrase run in a prompt pane the agent can't see. Funds go out only on your own word, with a destination check.

### Limits and safety

- Each agent's own limits, held by the TUI, beside Candle's caps on each key, each labelled with who holds it.
- A wallet can trade inside two figures of its own with no card, and a note says what happened while you were away. A trade with a slippage bound looser than the default is always a card.
- The kill switch (`ctrl-x` twice) stops the agent and pauses buys, and keeps your sells one press away.
- The journal records every step, and a trade whose answer was lost is read back, never sent twice.

### The screen

- Eight tabs, each a setting: Trade, Cockpit, Trending, Signals, P&L, Research, Journal and Perps.
- Layouts of your own, linked panes and pins, pop-out into tmux or cmux, the palette (`ctrl-k`), and themes, including one drawn from your terminal's own colours.
- Wallets by name and in groups, and empty token accounts closed from the Wallets pane. A stopped TEE wallet stays on it with what the chain says is still in it, until you sweep it home.

### Setup

- A one-line installer that checks each file's checksum and signature, and offers to install Candle's CLI.
- Guided setup on first run: signing in to Candle, connecting your agent, a vault or the embedded wallet only, the agent's key, limits, and a short tour.
- `candle-tui doctor` checks everything and says what to fix.
