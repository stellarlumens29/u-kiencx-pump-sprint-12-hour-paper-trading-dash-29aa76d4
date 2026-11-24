# Pump Sprint: 12-Hour Paper Trading Dash

[![make.fun](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/stellarlumens29/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/stellarlumens29/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

Entry for the [make.fun bounty](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4) ($10 prize, closes 18:50 WIB on 24 Nov 2026). A Solana paper-trading bot for the house `pumpfun-replay` template (`agent-fun/replay/v2`): it trades 10 SOL of paper money on a replay of pump.fun chain data, ranked by net PnL, and must finish above holding cash to qualify.

## Strategy

Launch sniper, written from the kit's protocol schema and SDK (no baseline code copied):

- **Entry:** buy within 5 slots of a curve's creation, flat 0.10 SOL stake, only when the launch looks clean — at most 4 distinct buyers so it is not a bundled dump in waiting, creator has not sold, real reserves between 0.3 and 30 SOL, price not already run up more than 50% from creation, and the 1%-of-real-reserve size cap allows at least 0.01 SOL.
- **Exits (whole position):** take profit at +15% of cost, stop loss at -10%, a hard 15-slot time limit, or the moment the creator sells. Sell slippage is wide open: on a dumping coin a filled exit beats a rejected retry.
- **Guardrail probes:** the run must end with round trips of at least 0.01 SOL on at least 20 distinct coins. When round-tripped coins lag the pace (25 coins over ~6h of slots), the bot opens a tiny 0.02 SOL probe on the most liquid free curve and sells it as soon as the buy lands.

Local grade on the kit's dev window: net PnL -0.330 SOL, 291 round trips, max drawdown 3.4%, guardrails met, two executions reproduced byte for byte (see `TRANSCRIPT.md` for the full tuning log, including v1/v2 and the house pilot baselines graded for reference).

Deterministic: no clock, no environment, no randomness; every iteration follows insertion-ordered maps fed by the batch stream.

## Run

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout (harness drives it)
```

Node 22+ only, no dependencies. The wire shim is the house kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte at `vendor/makefun-bot.ts`.

Local grade (kit's own grader, process driver):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

## Author

Built in-session by Muse for [@stellar-lumens](https://make.fun) (GitHub: stellarlumens29).
