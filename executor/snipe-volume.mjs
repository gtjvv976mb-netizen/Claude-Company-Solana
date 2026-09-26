/**
 * VOLUME SPIKE — "when volume spikes on a token, that's a sign to get in and ride the wave."
 *
 * The owner, 2026-09-26. It is a real signal and a widely traded one, and this desk can
 * measure it honestly without a single new data source: a pump.fun bonding curve holds its
 * SOL in `realQuoteRaw`, the lane already reads that on every tick, and the CHANGE in it
 * over time is money moving. No DexScreener call, no new key, no new dependency.
 *
 * What follows is the measurement, and four things about it that decide whether the signal
 * is worth anything at all.
 *
 * ── 1. A NEW CURVE HAS NO BASELINE, AND THAT IS THE WHOLE TRAP ────────────────────────
 *
 * A spike is a ratio: flow now against flow before. A coin that is ninety seconds old has
 * no before. Divide by it and every brand-new launch reads as an infinite spike — so a
 * naive implementation of this gate would fire on every single fresh launch and call it a
 * signal. It would be "buy everything" wearing a costume.
 *
 * That matters here more than anywhere, because this desk's own record says the fresh
 * launch is the LOSING trade: over 64 real trades, entries under three seconds won 0% of
 * the time for -18.5%, while entries ten seconds and later won 40% for +34.0%. A gate that
 * silently fired hardest on the youngest coins would push the sniper further into exactly
 * the book that lost the money.
 *
 * So: no baseline means `spike: null` and `baselineEmpty: true`. Never Infinity, never a
 * large number, and the gate treats unknown as NOT a spike. Unverified is not safe — the
 * same rule the creator_profile and launch_share gates already follow.
 *
 * ── 2. THIS IS NET INFLOW, NOT GROSS VOLUME ───────────────────────────────────────────
 *
 * The reserve rises on a buy and FALLS on a sell, so what this measures is net SOL into
 * the curve. A coin being churned hard in both directions — a thousand SOL each way — has
 * enormous gross volume and close to zero net flow, and reads quiet here. That is a real
 * limitation and it is stated rather than papered over, because the alternative is a
 * number that looks like volume, is not, and is trusted anyway. Net inflow is arguably the
 * better signal for a buyer regardless: it is the part that actually moves the price.
 *
 * ── 3. A FALLING RESERVE IS INFORMATION, NOT A FLOOR AT ZERO ──────────────────────────
 *
 * Net flow can be negative — that is the coin being sold. It is reported as negative. A
 * module that clamped it to zero would make "everyone is leaving" indistinguishable from
 * "nothing is happening", which is the difference between the two trades a holder cares
 * about most.
 *
 * ── 4. A CLOCK THAT WENT BACKWARDS IS REPORTED, NOT SMOOTHED ──────────────────────────
 *
 * snipe-feed.mjs's rule, and this file keeps it: clamping a fault produces a plausible
 * small number and the fault then never gets found.
 *
 * ── WHAT THIS FILE DOES NOT DECIDE ────────────────────────────────────────────────────
 *
 * It measures. It never buys. The gate in snipe-entry.mjs is registered as a PROXY gate,
 * which means it is measured on every notice and kills only once the operator sets a
 * threshold — and because it is a proxy, `grade-entry-gates.mjs` scores it against known
 * outcomes the same way it scores the other two. In a few days the owner will know whether
 * this signal separates winners from losers on his own book, rather than believing it.
 *
 * Worth knowing while deciding: bagworkagent.fun, whose agents the owner admired, encode
 * the opposite half of this idea in their own strategy parameters — `maxChange5m: 0.12`
 * and `maxSpike5m: 0.2`. They require some momentum and then REFUSE anything already
 * extended, because buying after the wave has broken is how you become the exit liquidity
 * for whoever caught it. `launch_share` is this desk's version of that cap and it is
 * already implemented beside this one.
 */

export const SNIPE_VOLUME_VERSION = "snipe-volume-v1";

/** The recent window: how long "now" is. Short enough to catch a spike while it is still a
 *  spike, long enough that two ticks of jitter do not dominate it. */
export const DEFAULT_WINDOW_MS = 30_000;
/** The baseline window that ends where the recent one begins. Five minutes of ordinary
 *  behaviour is what a spike is a spike against. */
export const DEFAULT_BASELINE_MS = 300_000;
/** Samples kept per mint, bounded because a process that watches launches all day would
 *  otherwise grow a tape per mint forever. */
export const DEFAULT_CAPACITY = 240;
/**
 * HOW MUCH TIME ONE SAMPLE STANDS FOR — and this constant exists because of a bug that
 * would have inverted the entire signal.
 *
 * The tape is fed by trade events, so a HOT coin produces samples far faster than a quiet
 * one. At one sample per trade, 240 samples of a coin doing five trades a second is
 * forty-eight seconds of history — less than the 330 seconds a spike needs — so the coin
 * would evict its own baseline, `measureSpike` would correctly answer `no_baseline`, and
 * with a threshold armed the gate would REFUSE exactly the coins that were spiking hardest
 * while passing the sleepy ones. A volume gate that is blind in proportion to volume.
 *
 * So a sample is a time bucket, not a trade. Within one bucket the newest reading REPLACES
 * the previous one, which loses nothing: the reserve is a level, not an increment, and every
 * number this file computes is a difference between two levels. At two seconds a bucket, 240
 * samples is eight minutes — comfortably more than window plus baseline, for a coin trading
 * once a minute and for one trading fifty times a second alike.
 */
export const DEFAULT_BUCKET_MS = 2_000;

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const asBig = (v) => {
  if (typeof v === "bigint") return v;
  const s = String(v ?? "");
  return /^\d+$/.test(s) ? BigInt(s) : null;
};

/**
 * The spike, from a list of `{atMs, quoteRaw}` samples. Pure: no clock, no state, no I/O,
 * so a replay of a captured tape produces the identical number.
 *
 * Returns `spike: null` whenever the ratio cannot honestly be formed — too few samples,
 * no baseline span, or a baseline that saw no inflow at all. Null is the answer, not a
 * stand-in for one.
 */
export function measureSpike(samples, { nowMs, windowMs = DEFAULT_WINDOW_MS, baselineMs = DEFAULT_BASELINE_MS } = {}) {
  const none = (reason) => Object.freeze({
    spike: null, reason, samples: 0, spanMs: 0,
    recentLamportsPerSec: null, baselineLamportsPerSec: null,
    netInflowLamports: null, baselineEmpty: false, clockRegression: false,
  });
  if (!Array.isArray(samples) || samples.length < 2) return none("not_enough_samples");
  if (!Number.isFinite(nowMs)) return none("no_clock");

  const rows = [];
  let clockRegression = false;
  let last = -Infinity;
  for (const s of samples) {
    if (!isPlainObject(s)) continue;
    const at = Number(s.atMs);
    const q = asBig(s.quoteRaw);
    if (!Number.isFinite(at) || q === null) continue;
    if (at < last) clockRegression = true;
    last = at;
    rows.push({ at, q });
  }
  if (rows.length < 2) return none("not_enough_samples");
  rows.sort((a, b) => a.at - b.at);

  const recentFrom = nowMs - windowMs;
  const baseFrom = recentFrom - baselineMs;

  /* Inflow across a window is the reserve at its end minus the reserve at its start. The
     boundary sample is the LAST one at or before the edge, so a window with no sample of
     its own still measures against the right starting point rather than silently using
     whatever is nearest. */
  const at = (t) => {
    let found = null;
    for (const r of rows) { if (r.at <= t) found = r; else break; }
    return found;
  };
  const latest = rows[rows.length - 1];
  /* A COIN YOUNGER THAN THE RECENT WINDOW STILL HAS A RECENT RATE. It has no sample at the
     30s edge because it did not exist 30 seconds ago, so the numerator is measured over the
     whole life it does have — a RATE, per second, so a 12-second life and a 30-second one
     are directly comparable. The denominator gets no such courtesy: `baseStart` stays strict,
     because falling back there would compute a baseline out of the same samples as the
     numerator and hand back a ratio of a window against itself. That is how this gate would
     quietly become 1.0x on every fresh launch instead of honestly unknown. */
  const recentStart = at(recentFrom) ?? rows[0];
  const baseStart = at(baseFrom);

  /* A RATE IS INFLOW OVER THE WINDOW, NOT OVER THE GAP BETWEEN TWO SAMPLES. The reserve is
     a level that holds between readings, so the level at each edge is exact and the inflow
     across a window is end minus start — but the time that inflow took is the window,
     however far apart the two boundary samples happen to sit. Dividing by the sample gap
     instead made a 5 SOL buy at t-310s get spread across the hour of silence before it (a
     2.7x "spike" on flow that was actually slowing, 0.78x) and made 4.5 SOL in the last ten
     seconds of a quiet coin read 7.9x instead of 90x. A coin trading on a steady tick never
     shows the difference, which is why only an uneven tape exposed it.

     The one exception is the young coin above: its recent span is the life it has had, from
     its first sample to now, because the seconds before it existed are not seconds of zero
     flow. */
  const perSec = (a, b, ms) => {
    if (!a || !b) return null;
    if (!(ms > 0)) return null;
    return Number(b.q - a.q) / (ms / 1000);
  };

  const recentRate = perSec(recentStart, latest, nowMs - Math.max(recentFrom, rows[0].at));
  const baselineRate = perSec(baseStart, recentStart, baselineMs);
  const netInflow = recentStart ? Number(latest.q - recentStart.q) : null;

  /* THE TRAP, handled. A baseline of zero inflow — a curve too young to have one, or one
     that genuinely sat still — cannot be the denominator of a ratio. Infinity is not a
     measurement and a big number is a lie. */
  const baselineEmpty = baselineRate === null || baselineRate <= 0;
  const spike = baselineEmpty || recentRate === null ? null : recentRate / baselineRate;

  return Object.freeze({
    spike,
    reason: spike === null ? (baselineEmpty ? "no_baseline" : "no_recent_window") : null,
    samples: rows.length,
    spanMs: latest.at - rows[0].at,
    recentLamportsPerSec: recentRate,
    baselineLamportsPerSec: baselineRate,
    netInflowLamports: netInflow,
    baselineEmpty,
    clockRegression,
  });
}

/**
 * The tape: a bounded per-mint history of the curve's real quote reserve.
 *
 * The lane calls `observe()` with whatever it already read this tick — this costs one
 * number per mint per tick and no extra RPC. `measure()` turns that into a spike.
 *
 * Bounded twice, because a sniper watches ~29 launches a minute all day: `capacity`
 * samples per mint, and `maxMints` mints, evicting the least recently touched. An evicted
 * mint is COUNTED, so a report can never quietly describe a subset while claiming to
 * describe everything — the same rule snipe-feed.mjs's ledger follows.
 */
export function createFlowTape({
  capacity = DEFAULT_CAPACITY, maxMints = 2_000,
  windowMs = DEFAULT_WINDOW_MS, baselineMs = DEFAULT_BASELINE_MS, bucketMs = DEFAULT_BUCKET_MS,
} = {}) {
  if (!Number.isInteger(capacity) || capacity < 2)
    throw new TypeError(`flow tape capacity must be an integer >= 2, got ${capacity}`);
  if (!Number.isInteger(maxMints) || maxMints < 1)
    throw new TypeError(`flow tape maxMints must be a positive integer, got ${maxMints}`);
  if (!Number.isInteger(bucketMs) || bucketMs < 1)
    throw new TypeError(`flow tape bucketMs must be a positive integer, got ${bucketMs}`);
  /* A TAPE THAT CANNOT HOLD A BASELINE IS A GATE THAT REFUSES EVERYTHING, so the geometry is
     checked here rather than discovered as a stream of `no_baseline` rows in the shadow book. */
  if (capacity * bucketMs < windowMs + baselineMs)
    throw new TypeError(`flow tape geometry cannot hold a baseline: ${capacity} samples x ${bucketMs}ms `
      + `is ${capacity * bucketMs}ms of history, under the ${windowMs + baselineMs}ms a spike needs`);

  const tapes = new Map();          // mint -> array of {atMs, quoteRaw}, insertion ordered
  const counters = { observed: 0, evictedMints: 0, droppedSamples: 0, coalesced: 0, rejected: 0 };

  return {
    version: SNIPE_VOLUME_VERSION,
    windowMs, baselineMs, bucketMs,

    /** One reading. A sample without a usable reserve is REJECTED and counted, never
     *  recorded as a zero — a curve whose reserve could not be decoded has not suddenly
     *  emptied. */
    observe(mint, { atMs, quoteRaw } = {}) {
      const key = String(mint ?? "");
      if (!key || !Number.isFinite(Number(atMs)) || asBig(quoteRaw) === null) { counters.rejected++; return null; }
      let tape = tapes.get(key);
      if (tape) tapes.delete(key);                 // re-insert: Map order is recency
      else tape = [];
      const at = Number(atMs);
      const sample = { atMs: at, quoteRaw: String(quoteRaw) };
      /* One sample per bucket, newest reading wins — see DEFAULT_BUCKET_MS. Only the LAST
         sample is considered, so a reading that arrives out of order is appended rather than
         silently overwriting a newer one; measureSpike sorts, and reports the regression. */
      const last = tape[tape.length - 1];
      if (last && Math.floor(at / bucketMs) === Math.floor(last.atMs / bucketMs) && at >= last.atMs) {
        tape[tape.length - 1] = sample;
        counters.coalesced++;
      } else tape.push(sample);
      while (tape.length > capacity) { tape.shift(); counters.droppedSamples++; }
      tapes.set(key, tape);
      counters.observed++;
      while (tapes.size > maxMints) {
        const oldest = tapes.keys().next().value;
        tapes.delete(oldest);
        counters.evictedMints++;
      }
      return tape.length;
    },

    /** The spike for one mint, or the honest `null` when it cannot be formed. */
    measure(mint, { nowMs, ...opts } = {}) {
      const tape = tapes.get(String(mint ?? ""));
      return measureSpike(tape ?? [], { nowMs, windowMs, baselineMs, ...opts });
    },

    forget(mint) { return tapes.delete(String(mint ?? "")); },
    size() { return tapes.size; },
    stats() { return { ...counters, mints: tapes.size, capacity, maxMints, windowMs, baselineMs, bucketMs }; },
  };
}

/* ── where the samples come from ───────────────────────────────────────────────────────
 *
 * A launch sniper's own curve reads cannot fill this tape. It reads a curve ONCE per
 * notice and then only for coins it already holds, so at the moment the gate runs there is
 * exactly one sample and `measureSpike` correctly answers `not_enough_samples` — a gate
 * that can never measure anything is worse than no gate, because it looks like one.
 *
 * The stream already has the answer. The Geyser/logs subscription filters on the PROGRAM,
 * not on creates, so every buy and sell on every pump.fun curve is already arriving at
 * this process — snipe-feed.mjs counts them as `unparsed` and drops them. Each one carries
 * a `TradeEvent`, and this repo's decoder for it is verified against real mainnet bytes
 * (snipe-venue-pumpfun.mjs, `decodeTradeEvent`), including the field this tape wants:
 * `realQuoteRaw`, the curve's SOL reserve immediately after that trade.
 *
 * So the tape is fed from traffic already being received and thrown away. No new
 * subscription, no new request, no new key, no extra latency on the path that buys.
 */

/**
 * Record decoded trade events against their own mints. Returns how many were recorded.
 *
 * `quoteUsable === false` is SKIPPED, not recorded as a number: that flag means the venue
 * decoder proved the curve is not quoted in SOL (a real mainnet case, see decodeTradeEvent),
 * and a SOL reserve read off a curve that does not hold SOL is not a small reading, it is a
 * meaningless one. Counted, so a tape that is skipping everything says so.
 */
export function observeTradeEvents(tape, events, { atMs } = {}) {
  if (!tape || typeof tape.observe !== "function") throw new TypeError("observeTradeEvents needs a flow tape");
  if (!Array.isArray(events) || !events.length) return 0;
  let recorded = 0;
  for (const e of events) {
    if (!isPlainObject(e)) continue;
    if (e.quoteUsable === false) continue;
    if (tape.observe(e.mint, { atMs, quoteRaw: e.realQuoteRaw }) !== null) recorded++;
  }
  return recorded;
}

/**
 * The tap: one subscription notification in, samples on the tape out.
 *
 * `tradesFrom(notification, context)` is INJECTED and has no default, for the same reason
 * snipe-feed.mjs requires `extractMint` with no default — decoding a program's logs means
 * knowing that program's layout, and the only module allowed to claim that is the adapter
 * that proved it against real bytes.
 *
 * IT NEVER THROWS. It is mounted on the launch feed's hot path, and a volume measurement
 * that can blind the sniper to launches is a strictly worse trade than no volume
 * measurement at all. Every failure is CAUGHT AND COUNTED here — `errors` in stats(), with
 * the last message kept — because the alternative to counting is a tap that is silently
 * recording nothing while the gate above it reports "no spike" with total confidence.
 */
export function createTradeTap({ tape, tradesFrom, clock = () => Date.now() } = {}) {
  if (!tape || typeof tape.observe !== "function") throw new TypeError("createTradeTap needs a flow tape");
  if (typeof tradesFrom !== "function")
    throw new TypeError("createTradeTap needs tradesFrom(notification, context): no log layout is decoded here");
  const counters = { notifications: 0, trades: 0, recorded: 0, skipped: 0, errors: 0 };
  let lastError = null;
  return {
    version: SNIPE_VOLUME_VERSION,
    observe(notification, context = null) {
      counters.notifications++;
      try {
        const events = tradesFrom(notification, context) ?? [];
        const list = Array.isArray(events) ? events : [];
        counters.trades += list.length;
        const atMs = clock();
        const took = observeTradeEvents(tape, list, { atMs });
        counters.recorded += took;
        counters.skipped += list.length - took;
        return took;
      } catch (error) {
        counters.errors++;
        lastError = String(error?.message ?? error).slice(0, 200);
        return 0;
      }
    },
    stats() { return { ...counters, lastError, tape: tape.stats() }; },
  };
}
