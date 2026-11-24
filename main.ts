// Pump Sprint launch sniper — agent-fun/replay/v2, Node 22, no dependencies.
//
// Idea: on pump.fun the cheapest price a coin ever has is at launch, and the
// first minutes decide almost everything. This bot buys within a few slots of
// a curve's creation — small, flat stake, only when the launch looks clean
// (few distinct buyers so it is not a bundled dump in waiting, creator has
// not sold, real reserves in range, price not already run up) — and exits
// fast: take profit at +15%, stop loss at -10%, a hard time limit, or the
// moment the creator sells. A separate probe lane guarantees the guardrail
// (20 distinct coins with a round trip of at least 0.01 SOL) even on a quiet
// window: when round-tripped coins lag the pace, it opens a tiny probe on the
// most liquid curve and sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no environment, no randomness;
// every iteration follows insertion-ordered maps fed by the batch stream.
//
// The wire shim is the house kit's sdk/ts/makefun-bot.ts, vendored byte for
// byte at vendor/makefun-bot.ts.

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// --- entry ---------------------------------------------------------------
const MAX_AGE_SLOTS = 5; // oldest age (slots since create) for a first buy
const STAKE_SOL = 100_000_000n; // flat stake per coin (0.1 SOL)
const MIN_BUY_SOL = 10_000_000n; // smallest buy worth sending (== round-trip bar)
const MAX_BUYERS = 4; // distinct buyers seen: more means a bundled launch
const MIN_RQ_SOL = 300_000_000n; // curve real SOL at entry, lower bound
const MAX_RQ_SOL = 30_000_000_000n; // curve real SOL at entry, upper bound
const MAX_RUNUP = 0.5; // price now over create price, at most +50%
const BUY_SLIP_BPS = 500;

// --- exits -----------------------------------------------------------------
const TAKE_PROFIT = 1.15; // sell when value >= cost * TAKE_PROFIT
const STOP_LOSS = 0.9; // sell when value < cost * STOP_LOSS
const MAX_HOLD_SLOTS = 15; // exit after this many slots held, whatever the price
const SELL_SLIP_BPS = 10_000; // wide open: on a dumping coin a filled exit beats a rejected retry

// --- guardrail probes -------------------------------------------------------
const PROBE_SOL = 20_000_000n; // probe buy size (0.02 SOL, above the 0.01 bar)
const TARGET_COINS = 25; // round-tripped coins to aim for (bar is 20)
const PACE_SLOTS = 54_000; // slots the pace is spread over (~6h at 0.4s/slot)

interface Launch {
  createSlot: number;
  creator: string;
  createPrice: number; // quote lamports per token at creation
  devSold: boolean;
  buyers: Set<string>;
  buyCount: number;
}

interface Pos {
  entrySlot: number;
}

const launches = new Map<string, Launch>();
const positions = new Map<string, Pos>();
const probeMints = new Set<string>(); // mints bought as probes: sell on sight
const boughtCoins = new Set<string>(); // mints with a buy fill >= 0.01 SOL
const soldCoins = new Set<string>(); // mints with a sell fill
const roundTripped = new Set<string>(); // mints with both: the guardrail count
let firstSlot = -1;

function priceOf(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function valueOf(state: BotState, mint: string): bigint {
  const h = state.positions.get(mint);
  if (!h) return 0n;
  const p = priceOf(state, mint);
  if (p <= 0) return 0n;
  return (h.token_amount * BigInt(Math.floor(p * 1e12))) / 1_000_000_000_000n;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  if (firstSlot < 0) firstSlot = batch.slot;
  const orders: OrderInput[] = [];
  const caps = state.hello.caps;
  const tx = state.txFeeLamports();
  let free = state.freeCashLamports();

  // Fold fills: track round trips for the guardrail pace.
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy' && BigInt(f.quote_lamports) >= MIN_BUY_SOL) {
      boughtCoins.add(f.mint);
    }
    if (f.side === 'sell') soldCoins.add(f.mint);
    if (boughtCoins.has(f.mint) && soldCoins.has(f.mint)) roundTripped.add(f.mint);
  }

  // Fold this batch's events: record launches, watch for creator sells.
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const createPrice =
        Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      launches.set(e.mint, {
        createSlot: e.slot,
        creator: e.creator,
        createPrice,
        devSold: false,
        buyers: new Set<string>(),
        buyCount: 0,
      });
    } else if (e.event === 'TradeEvent') {
      const launch = launches.get(e.mint);
      if (launch !== undefined) {
        if (!e.is_buy && e.user === launch.creator) launch.devSold = true;
        if (e.is_buy) {
          launch.buyers.add(e.user);
          launch.buyCount += 1;
        }
      }
    }
  }

  const buysThisBatch = () => orders.filter((o) => o.side === 'buy').length;

  // --- exits first: sell whole positions on the first trigger --------------
  for (const [mint, holding] of state.positions) {
    const pos = positions.get(mint);
    const price = priceOf(state, mint);
    if (price <= 0) continue;
    const value = valueOf(state, mint);
    const cost = holding.cost_lamports;
    let sell = false;
    if (probeMints.has(mint)) {
      sell = true;
    } else if (pos !== undefined && cost > 0n) {
      const launch = launches.get(mint);
      if (value * 100n >= cost * BigInt(Math.floor(TAKE_PROFIT * 100))) sell = true;
      else if (value * 100n < cost * BigInt(Math.floor(STOP_LOSS * 100))) sell = true;
      else if (state.slot - pos.entrySlot >= MAX_HOLD_SLOTS) sell = true;
      else if (launch !== undefined && launch.devSold) sell = true;
    }
    if (sell) {
      if (orders.length >= caps.max_orders_per_batch) continue;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      probeMints.delete(mint);
    }
  }

  // --- entries: buy clean launches within MAX_AGE_SLOTS of creation --------
  for (const e of batch.events) {
    if (orders.length >= caps.max_orders_per_batch) break;
    if (e.event !== 'TradeEvent') continue;
    const mint = e.mint;
    if (state.positions.has(mint)) continue;
    let pendingBuy = false;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) pendingBuy = true;
    }
    if (pendingBuy) continue;
    if (positions.has(mint)) continue; // one entry per coin, ever
    const launch = launches.get(mint);
    if (launch === undefined) continue;
    if (state.slot - launch.createSlot > MAX_AGE_SLOTS) continue;
    if (launch.devSold) continue;
    if (launch.buyers.size > MAX_BUYERS) continue;
    if (launch.buyCount < 1) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.real_quote_reserves < MIN_RQ_SOL || curve.real_quote_reserves > MAX_RQ_SOL) continue;
    const price = priceOf(state, mint);
    if (launch.createPrice > 0 && price > launch.createPrice * (1 + MAX_RUNUP)) continue;
    const cap = state.maxBuyLamports(mint);
    const amount = cap < STAKE_SOL ? cap : STAKE_SOL;
    if (amount < MIN_BUY_SOL) continue;
    if (state.committedPositionCount() + buysThisBatch() >= caps.max_open_positions) continue;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
    free -= amount + tx;
    positions.set(mint, { entrySlot: state.slot });
  }

  // --- guardrail probes: keep round-tripped coins on pace ------------------
  const elapsed = Math.max(0, state.slot - firstSlot);
  const expected = Math.min(TARGET_COINS, Math.floor((TARGET_COINS * elapsed) / PACE_SLOTS));
  if (roundTripped.size < expected && orders.length < caps.max_orders_per_batch) {
    let best: string | null = null;
    let bestRq = 0n;
    for (const [mint, curve] of state.curves) {
      if (curve.complete) continue;
      if (state.positions.has(mint)) continue;
      if (boughtCoins.has(mint) && !soldCoins.has(mint)) continue;
      if (roundTripped.has(mint)) continue;
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) pendingBuy = true;
      }
      if (pendingBuy) continue;
      if (curve.real_quote_reserves > bestRq && state.maxBuyLamports(mint) >= PROBE_SOL) {
        best = mint;
        bestRq = curve.real_quote_reserves;
      }
    }
    if (
      best !== null &&
      state.committedPositionCount() + buysThisBatch() < caps.max_open_positions &&
      free >= PROBE_SOL + tx
    ) {
      orders.push({ side: 'buy', mint: best, quote_lamports: PROBE_SOL, max_slippage_bps: BUY_SLIP_BPS });
      probeMints.add(best);
      free -= PROBE_SOL + tx;
    }
  }

  return orders;
}

await runBot({
  onBatch,
  onDone(state) {
    const cash = state.cash;
    const start = BigInt(state.hello.capital.lamports);
    console.error(
      `done: batches=${state.seq + 1} cash=${cash} start=${start} ` +
        `pnl_lamports=${cash - start} coins_bought=${boughtCoins.size} ` +
        `round_tripped=${roundTripped.size}`,
    );
  },
});
