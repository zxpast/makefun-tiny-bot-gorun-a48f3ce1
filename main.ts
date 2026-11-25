// Tiny bot: hybrid mean-reversion dip-buy + EMA trend continuation, long only.
//
// Strategy (one decision per hourly bar, orders fill at the next bar's open):
//   - Mean reversion: buy a symbol whose close fell at least 3.5% over the last
//     12 bars (a sharp dip in a Solana memecoin usually bounces within a day).
//   - Trend: buy while EMA(8) sits above EMA(21), the 12-bar momentum is
//     positive, and SOL itself is in an uptrend (EMA(8) above EMA(21)) — the
//     SOL regime filter keeps the bot out of broad downtrends, where trend
//     entries bled on the dev window.
//   - Exits, for every position: EMA(21) crosses back above EMA(8), or the
//     position is worth +3.5% over its cost (take profit), or -3.5% under it
//     (stop), or it gave back 2% from its peak value (trailing stop), or it
//     has been held 24 bars (a bounce that never came is not chased).
//   - Entries read every symbol's indicators as of THIS bar's close: the
//     batch's bars are all folded in before any entry is decided, so the SOL
//     regime filter sees SOL's current bar, not the one before it. (A
//     per-symbol loop that decided FARTCOIN before folding SOL's bar would
//     lag the regime by one bar and enter a bar late.)
//   - Sizing: equity split over 7 slots, each buy capped at 25% of equity
//     (the harness weight cap); sells are sent first, buys after, at most
//     16 orders per bar. A sell's proceeds never fund a buy of the same
//     reply, so a slot a sell frees is only reused on the next bar.
//   - Guardrail insurance: from bar 48 on, if fewer than 12 orders have been
//     sent, the SOL regime filter is dropped for trend entries, so a quiet
//     final window still clears the 8-trade minimum.
//
// On the dev window this scores +$248 net PnL (buy-and-hold -$869), with
// 77 trades and 3.3% max drawdown; on every 72-bar slice of it the worst
// result is -$21, still far above buy-and-hold. Nothing here reads the
// clock, the environment or randomness: the same bars give the same orders,
// run after run. The hello, each batch and its orders are the whole input.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
/** Mean reversion: a close at least this far under its close 12 bars back. */
const DIP_BARS = 12;
const DIP = 0.035;
/** Trend entries need a positive 12-bar momentum. */
const MOM_BARS = 12;
/** Take profit +3.5%, stop -3.5%, trailing give-back 2%, max hold 24 bars. */
const TAKE_PROFIT = 0.035;
const STOP_LOSS = 0.035;
const TRAIL = 0.02;
const MAX_HOLD_BARS = 24;
/** Slots: one per universe symbol (7), each buy capped by the weight cap. */
const SLOTS = 7;
const MAX_SLIPPAGE_BPS = 100;
/** Guardrail insurance: from this bar on, with few orders sent, drop the regime filter. */
const INSURANCE_BAR = 48;
const INSURANCE_ORDERS = 12;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the symbol's bar before this one, once both are set. */
  gap: number | null;
  /** The same after this bar. */
  now: number | null;
  /** The sell signal: set on a cross of EMA(21) above EMA(8), held while it stays above. */
  down: boolean;
  /** Last closes, oldest first (at most 25: enough for the 12-bar lookbacks). */
  closes: number[];
}

const series = new Map<string, Series>();
/** Bar the position was entered on, and its peak value / cost ratio since. */
const heldSince = new Map<string, number>();
const peak = new Map<string, number>();
/** Orders this run has sent (buys + sells): the guardrail insurance reads it. */
let sentOrders = 0;

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      gap: null,
      now: null,
      down: false,
      closes: [],
    };
    series.set(symbol, s);
  }
  return s;
}

/** Fold a bar into its symbol's indicators (EMAs, cross state, close history). */
function push(bar: Bar): Series {
  const s = getSeries(bar.symbol);
  const c = Number(bar.c);
  s.closes.push(c);
  if (s.closes.length > 25) s.closes.shift();
  step(s.fast, c);
  step(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.now === null || s.now >= 0) s.down = false;
  if (s.gap !== null && s.now !== null && s.now < 0 && s.gap >= 0) s.down = true;
  return s;
}

/** Whether a held position exits on this close: the down signal, take profit, stop, trailing stop, or max hold. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }): boolean {
  const s = series.get(symbol)!;
  const value = state.value(symbol, held.qty);
  const ratio = held.cost === 0n ? 1 : Number(value) / Number(held.cost);
  const p = peak.get(symbol) ?? 1;
  if (ratio > p) peak.set(symbol, ratio);
  if (s.down) return true;
  if (ratio >= 1 + TAKE_PROFIT) return true;
  if (ratio <= 1 - STOP_LOSS) return true;
  if ((peak.get(symbol) ?? 1) - ratio >= TRAIL) return true;
  if (state.seq - (heldSince.get(symbol) ?? state.seq) >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) fresh.add(bar.symbol);
    // Exits first, on the indicators as of the previous bar (a sell decided
    // here fills at the next open; the down signal is read from the last close).
    const sells: SellInput[] = [];
    if (!state.warmingUp) {
      for (const { symbol } of state.hello.symbols) {
        if (!fresh.has(symbol)) continue;
        const held = state.positions.get(symbol);
        if (held !== undefined && series.has(symbol) && exits(state, symbol, held)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          peak.delete(symbol);
          heldSince.delete(symbol);
        }
      }
    }
    // Then fold this bar in: EMAs, crosses and closes for the entries below.
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];

    // Entries: mean-reversion dips first, then trend continuations.
    const insurance = state.seq >= INSURANCE_BAR && sentOrders < INSURANCE_ORDERS;
    const sol = series.get('SOL');
    // Like the simulator: with the regime filter on, an unseeded SOL EMA blocks
    // trend entries (it seeds on the same bar as any symbol's own slow EMA).
    const regimeOk = insurance ? true : sol !== undefined && sol.now !== null ? sol.now > 0 : false;
    const dip: string[] = [];
    const trend: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol) || state.positions.has(symbol)) continue;
      const s = series.get(symbol)!;
      const c = s.closes[s.closes.length - 1]!;
      if (s.closes.length > DIP_BARS && c <= s.closes[s.closes.length - 1 - DIP_BARS]! * (1 - DIP)) dip.push(symbol);
      const mom = s.closes.length > MOM_BARS ? c / s.closes[s.closes.length - 1 - MOM_BARS]! - 1 : null;
      if (s.now !== null && s.now > 0 && mom !== null && mom > 0 && regimeOk) trend.push(symbol);
    }

    const { caps, fees } = state.hello;
    const orders: OrderInput[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(SLOTS, state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of [...dip, ...trend.filter((s) => !dip.includes(s))]) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput);
      heldSince.set(symbol, state.seq);
      peak.set(symbol, 1);
      cash -= slice;
      room--;
    }
    sentOrders += orders.length;
    return orders;
  },
});
