# Tiny Bot — Beat Buy-and-Hold on Solana

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/zxpast/makefun-tiny-bot-gorun-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/zxpast/makefun-tiny-bot-gorun-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for make.fun's **u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1**
bounty ("Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana"). One program, Node 22
stdlib only, no network, fully deterministic: the same hourly bars give the same
orders, run after run.

## The one idea

Buy the dip, ride the trend, never ride a downtrend. Two engines share 7 slots:

- **Mean reversion:** buy a symbol whose close fell at least 3.5% over the last
  12 bars — a sharp dip in a Solana memecoin usually bounces within a day.
- **Trend:** buy while EMA(8) sits above EMA(21), 12-bar momentum is positive,
  and SOL itself is in an uptrend (EMA(8) above EMA(21)). The SOL regime filter
  keeps the bot out of broad downtrends, where trend entries bled on dev.
- **Exits, for every position:** EMA(21) crosses back above EMA(8), or +3.5%
  take profit, or −3.5% stop, or 2% give-back from the position's peak
  (trailing stop), or 24 bars held. Sizing is equity / 7 per buy, capped at
  25% of equity. From bar 48 on, if fewer than 12 orders have been sent, the
  SOL regime filter is dropped so a quiet window still clears the 8-trade
  minimum.

## Dev results (grade-local, `--driver process`)

| Bot | Net PnL | Trades | Max drawdown |
| --- | --- | --- | --- |
| Buy-and-hold (house baseline) | −$869.34 | 7 | 10.92% |
| EMA-cross (house baseline) | −$173.04 | 28 | 2.51% |
| ADX-momentum (house baseline, best) | −$114.42 | 11 | 1.38% |
| **This bot** | **+$183.67** | **80** | **3.26%** |

On every 72-bar slice of the dev window (the final window is 72 bars) the
worst result is −$18.19 with at least 14 trades — still far above
buy-and-hold, with max drawdown 3.26% against the 25% guardrail.

## Run it

```sh
node main.ts   # speaks agent-fun/bars-replay/v1 on stdin/stdout
```

Grade it on the dev kit (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6hmpy1rq&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
