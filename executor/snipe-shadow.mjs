/**
 * THE SNIPER'S SHADOW BOOK — one row per notice, and a scorecard that promotes nothing.
 *
 * This is the primary deliverable of the sniper lane, not a stepping stone to it, and the
 * arithmetic says why: `dailySolCap 0.01 / maxSolPerTrade 0.005 = 2`, so a LIVE sniper
 * accrues evidence at two entries a day, maximum (poller.mjs:155-157). Two hundred rows
 * of live evidence is a hundred trading days. Two hundred rows of shadow evidence is a
 * quiet afternoon. Everything that can be learned without signing is learned here.
 *
 * ── WHAT A SHADOW BOOK CANNOT MEASURE, SAID FIRST BECAUSE IT IS THE POINT ────────────
 *
 * A SHADOW BOOK MARKS A FILL IT NEVER HAD TO WIN. That single sentence is the whole
 * limitation and it is not a rounding error on the result — it is a bias whose sign is
 * known in advance and whose magnitude is not.
 *
 * When this lane records "we would have bought at the ceiling", nobody had to lose that
 * race to us. On chain, the launches we would ACTUALLY have been filled on are the subset
 * that faster machines looked at and declined, plus the subset nobody else wanted. Those
 * two subsets are not a random sample of the rows in this book, and they are worse than
 * the rows in this book. So any "hit rate" computed here is a hit rate on a population
 * that would never have been ours, and any "P&L" is the P&L of an imaginary account that
 * won every race for free.
 *
 * THEREFORE THIS MODULE REFUSES TO PRINT EITHER. Not "labels them approximate" — refuses.
 * `assertReportHonest()` throws if a hit rate, a win rate, a P&L, an ROI or an expectancy
 * ever appears as a NUMBER anywhere in a report this file produces, and the renderer
 * prints those names only on a line that has no digits on it at all. A number that would
 * be read as a result has to be impossible to add by accident, because the pressure to
 * add it arrives exactly when the sample looks good.
 *
 * What it CAN measure, and does:
 *
 *   · SELECTION      — which gate refuses what, over the whole ordered trace, with the
 *                      first refusal named. That is a fact about our own rules.
 *   · PATH LATENCY   — hop-decomposed, notice -> would-have-signed, from real notices.
 *   · DETERMINER     — what the exit determiner did, replayably, on real bytes.
 *   · QUEUE DEPTH    — THE SLOT DELTA between the create and our first readable mark.
 *
 * The last one is the honest proxy for the thing the book cannot measure. It does not
 * tell us what we would have been filled at; it tells us HOW FAR BACK IN THE QUEUE THIS
 * MACHINE SITS, in the only unit the chain agrees on. A lane that is consistently eight
 * slots behind the create is a lane whose shadow fills were won by somebody else four
 * seconds earlier, and that is visible in this number long before it is visible in a
 * ledger. It is printed for EVERY entry, never averaged away into one summary figure —
 * the distribution is the finding, and a mean would hide the tail that matters.
 *
 * ── THE SCORECARD, AND WHY IT IS src/launch-shadow.js ────────────────────────────────
 *
 * The desk already answered this exact question once, for the three rug proxies, and the
 * answer is `src/launch-shadow.js`: `PROXIES` (each `{rule, measured, flags}`),
 * `positiveVerdict`, and `proxyScorecard` computing tp/fp/fn/tn over the rows where the
 * proxy was ACTUALLY measured and the answer ACTUALLY known, with a `promotable` flag
 * gated on three numbers stated in advance. Those numbers are REUSED here rather than
 * invented — `PROMOTION_PRECISION_BAR 0.8`, `PROMOTION_MIN_ROWS 200`,
 * `PROMOTION_MIN_FLAGGED 10` (src/launch-shadow.js:112-114) — and its comment about them
 * applies here word for word: none has been tuned on data, there is no data yet, that is
 * what the log is for. Inventing a friendlier floor for a new lane is how a bar stops
 * being a bar.
 *
 * They are RE-DECLARED rather than imported, and the reason is mechanical rather than
 * stylistic: `src/launch-shadow.js` opens a SQLite handle at import (`import db from
 * "./lib/store.js"` and a top-level `db.exec`), and the executor is a separate process
 * with a separate dependency set — importing it here would open the desk's database from
 * the bot. `test-snipe-lane.mjs` reads that file AS TEXT and asserts the three numbers
 * still agree, which is the same mirror technique `test-token2022-mirror.mjs` uses to
 * hold `BOT_ALLOWED_EXTENSIONS` in step with the executor's own copy.
 *
 * THE POSITIVE CLASS IS DEFINED BEFORE ANY ROW IS COLLECTED, which is the only way a
 * precision number means anything: a launch is POSITIVE (the thing a t=0 proxy ought to
 * flag) when the curve's REAL quote reserve never advanced past where it stood at the
 * would-have-fill, anywhere in the forward window. That is "a launch nobody followed" —
 * observable from the same bytes the lane already decodes, on every row, with no paid
 * read and no opinion in it.
 *
 * AND THE SCORECARD PROMOTES NOTHING. As in launch-shadow.js, `promotable` is a report to
 * the owner. Wiring a proxy as a kill is a separate registered change to `GATE_CLASS` —
 * `src/calls.js gateClass()` answers SAFETY for any code it has not heard of, so an
 * unregistered sniper gate silently becomes an un-waivable rug check.
 *
 * PURE, and impure in exactly one place. Every function here is a function of its
 * arguments: no clock, no fs, no network, no randomness, no mutation of an argument.
 * `createSnipeShadow()` holds rows in memory and hands each finished row to an INJECTED
 * `sink` if the caller supplied one; this file never opens a file or a database, so a
 * replay run and an observe run go through identical code.
 */
import { SNIPE_GATES, SNIPE_GATE_COST, SNIPE_PROXY_GATES } from "./snipe-entry.mjs";

export const SNIPE_SHADOW_VERSION = "snipe-shadow-v1";

/* ── the sample floors, reused from src/launch-shadow.js:112-114 ───────────────────── */

/** A proxy earns a kill when four of five coins it flags are ones the answer would have
 *  killed anyway. Not tuned on data; there is no data yet. */
export const PROMOTION_PRECISION_BAR = 0.8;
/** The sample floor under which a precision figure is a handful of coins. */
export const PROMOTION_MIN_ROWS = 200;
/** The flagged-row floor under which precision is one lucky coin. */
export const PROMOTION_MIN_FLAGGED = 10;

/**
 * THE SMALLEST HONEST SAMPLE, as a counting rule rather than a duration.
 *
 * `minRows` is PROMOTION_MIN_ROWS notices that ran the full gate stack to a verdict AND
 * had their forward path captured. `minCleared` is PROMOTION_MIN_FLAGGED of those that
 * cleared EVERY gate — would-have-entered. The second number is the one that governs how
 * long the sample takes, and this file will not estimate it: the log produces its rate.
 */
export const SHADOW_SAMPLE_FLOORS = Object.freeze({
  minRows: PROMOTION_MIN_ROWS,
  minCleared: PROMOTION_MIN_FLAGGED,
  precisionBar: PROMOTION_PRECISION_BAR,
});

/**
 * THE MEASURES THIS BOOK REFUSES TO PRODUCE, by name, each with the reason.
 *
 * The patterns are matched against report KEYS, at any depth, and a match whose value is
 * a number is a throw. Strings are allowed through deliberately: the report SAYS the
 * words (that is how the reader learns what is missing and why), it just never attaches a
 * figure to them.
 */
export const SHADOW_FORBIDDEN_MEASURES = Object.freeze([
  Object.freeze({
    measure: "hit rate",
    pattern: /^(hit|win|success|fill)_?rate$|^hitRate$|^winRate$|^successRate$|^fillRate$/i,
    why: "a shadow book marks a fill it never had to win, so the launches counted here are not the "
      + "launches this machine would have been filled on",
  }),
  Object.freeze({
    measure: "P&L",
    pattern: /^p_?and_?l$|^pnl$|^profit|^loss(Sol|Usd|Pct)$|^netProfit|^gain/i,
    why: "profit requires a fill that was won against somebody, and no race was run",
  }),
  Object.freeze({
    measure: "ROI / return",
    pattern: /^roi$|^return(Pct|X|Sol)?$|^realized|^realised/i,
    why: "the entry price here is a ceiling we would have offered, not a price anyone charged us",
  }),
  Object.freeze({
    measure: "expectancy / edge",
    pattern: /^expectancy$|^edge$|^alpha$|^sharpe$/i,
    why: "an expectancy over a biased population is an expectancy of nothing; adverse selection is "
      + "unmeasured by construction",
  }),
]);

/** The hops a notice passes through on its way to a would-have-signature. Ordered; the
 *  timing decomposition asserts nothing about which of them a given row carries, because
 *  a row refused at gate 0 never reaches the later ones and that is information. */
export const SHADOW_HOPS = Object.freeze([
  "notice",     // the feed's first arrival for this mint
  "accounts",   // both endpoints answered the one getMultipleAccounts
  "decode",     // the curve decoded (or refused to)
  "prepare",    // an armed lane built the instruction the gate stack decodes back (0ms when observing)
  "gate",       // the ordered gate stack ran to a verdict
  "ceiling",    // the exact baseOutRaw / maxQuoteInRaw that would have been signed
  "record",     // the row was closed and handed to the sink
]);

/** How the two endpoints answered at read time. Not a gate — `curve_unreadable` is the
 *  gate — but the row carries the classification because "both nodes said nothing" and
 *  "the two nodes disagreed" are different facts with the same refusal. */
export const ENDPOINT_VERDICTS = Object.freeze([
  "agree",          // both endpoints decoded, and to the same bytes
  "one_missing",    // one endpoint had no account — a node's gap, not a chain fact
  "both_missing",   // neither had it
  "disagree",       // both answered, at the same slot, differently
  "single",         // only one endpoint was configured (the observe book says so out loud)
]);

/** Thrown when a report carries a number this book has refused to produce. */
export class ShadowHonestyError extends Error {
  constructor(measure, where, message) {
    super(message);
    this.name = "ShadowHonestyError";
    this.measure = measure;
    this.where = where;
  }
}

/* ── small helpers, deliberately boring ────────────────────────────────────────────── */

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/** STRICT. `Number(null)` is 0 and `Number(false)` is 0, so the obvious
 *  `Number.isFinite(Number(v))` reports a MISSING slot as slot zero — and the first draft
 *  of this file then printed a queue depth of 446,023,104 slots for a notice that carried
 *  no slot at all, which is the exact shape of the arccos ruler: a number where there
 *  should have been a refusal to answer. Null, undefined, booleans and the empty string
 *  are NOT numbers here; an unmeasured value stays unmeasured. */
const finite = (v) => {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "bigint") return true;
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v));
  return false;
};

/** A raw on-chain amount on its way into a row. Digit strings are the durable form — a
 *  BigInt in a row throws at the first `JSON.stringify`, which on a sink's write path is
 *  a row lost after the decision it recorded. Same rule as snipe-book.mjs. */
function durable(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be a whole amount, got ${value}`);
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  throw new TypeError(`${field} must be an integer raw amount, got ${JSON.stringify(value)}`);
}

const asBig = (v) => (v === null || v === undefined ? null : BigInt(v));

/** Median of a numeric list, by value. Returns null on an empty list rather than 0 — an
 *  empty distribution has no middle, and 0 is a number somebody would read. */
function median(values) {
  const xs = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

function percentile(values, p) {
  const xs = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

/* ── timing ────────────────────────────────────────────────────────────────────────── */

/**
 * HOP-DECOMPOSED TIMING, from stamps the lane took as it went.
 *
 * Decomposed rather than totalled because a single notice-to-decision number cannot be
 * acted on: 40 ms in the RPC read and 40 ms in our own arithmetic are the same total and
 * completely different problems. §7.8 of the spec says the latency budget is unmeasured
 * and claims no slot target; this is the function that eventually replaces the claim with
 * a measurement, so it keeps the parts.
 *
 * `hops` is `[{hop, atMs}]` in the order they happened. Out-of-order stamps are NOT
 * clamped — a negative leg is reported as a negative leg with `clockRegression` raised,
 * for the reason snipe-feed.mjs gives: clamping turns a clock fault into a plausible
 * small number and the fault then never gets found.
 */
export function hopTiming(hops) {
  if (!Array.isArray(hops) || hops.length === 0)
    return Object.freeze({ hops: Object.freeze([]), noticeAtMs: null, decidedAtMs: null,
      noticeToDecisionMs: null, clockRegression: false, unknownHops: Object.freeze([]) });

  const legs = [];
  let prev = null;
  let first = null;
  let clockRegression = false;
  const unknown = [];
  for (const entry of hops) {
    if (!isPlainObject(entry) || !isStr(entry.hop) || !finite(entry.atMs)) continue;
    const hop = entry.hop.trim();
    if (!SHADOW_HOPS.includes(hop)) unknown.push(hop);
    const atMs = Number(entry.atMs);
    if (first === null) first = atMs;
    const msFromPrev = prev === null ? 0 : atMs - prev;
    if (msFromPrev < 0) clockRegression = true;
    legs.push(Object.freeze({ hop, atMs, msFromPrev, msFromNotice: atMs - first }));
    prev = atMs;
  }
  return Object.freeze({
    hops: Object.freeze(legs),
    noticeAtMs: first,
    decidedAtMs: prev,
    /* The headline the report prints beside the slot delta: how long this machine took
       from hearing about a launch to knowing exactly what it would have signed. */
    noticeToDecisionMs: first === null || prev === null ? null : prev - first,
    clockRegression,
    unknownHops: Object.freeze(unknown),
  });
}

/* ── the row ───────────────────────────────────────────────────────────────────────── */

/**
 * ONE ROW PER NOTICE — refused or not, and refused rows are the majority of the value.
 *
 * The gate trace is stored VERBATIM (`snipeContract` returns it already ordered and
 * frozen, ending at the refusal), because the interesting question is not "did it refuse"
 * but "how far down did it get before it refused, and what did the gates above it
 * measure". A row that died at `notice_stale` cost nothing and says something about the
 * feed; a row that died at `impact_over_cap` paid for a decode and says something about
 * the market.
 *
 * Every raw amount is stored as a digit STRING. Every slot is a Number. Nothing in here
 * is a BigInt, so a row survives `JSON.stringify` on any sink the lane hands it to.
 */
export function openShadowRow({
  mint,
  venueId = null,
  notice = {},
  createSlot = null,
  observedSlot = null,
  endpointVerdict = "single",
  endpoints = [],
  curve = null,
  verdict = null,
  hops = [],
  frictionX = null,
  ticketLamports = null,
  laneMode = "observe",
} = {}) {
  if (!isStr(mint)) throw new TypeError("a shadow row needs the mint it is about");
  if (!ENDPOINT_VERDICTS.includes(endpointVerdict))
    throw new TypeError(`endpointVerdict ${JSON.stringify(endpointVerdict)} is not one of ${ENDPOINT_VERDICTS.join(", ")}`);

  const timing = hopTiming(hops);
  const detail = isPlainObject(verdict?.detail) ? verdict.detail : {};
  const trace = Array.isArray(verdict?.trace) ? verdict.trace : [];

  /* THE NUMBER THIS BOOK EXISTS TO PRINT. `createSlot` is the slot the launch notice
     carried; `observedSlot` is the slot of the account read that produced our first
     readable mark. The difference is how far behind the create this machine actually is,
     and it is null — never 0 — when either end is missing, because an unmeasured delta
     and a zero delta are opposite findings. */
  const slotDeltaToFirstMark = finite(createSlot) && finite(observedSlot)
    ? Number(observedSlot) - Number(createSlot) : null;

  const row = {
    shadowVersion: SNIPE_SHADOW_VERSION,
    laneMode,
    mint,
    venueId: venueId ?? notice.venueId ?? null,

    /* WHERE IT CAME FROM AND WHEN — every leg, not just the winner, so the latency table
       can say which source was first and by how much. */
    notice: Object.freeze({
      firstSource: notice.firstSource ?? null,
      firstKind: notice.firstKind ?? null,
      firstSeenAtMs: finite(notice.firstSeenAtMs) ? Number(notice.firstSeenAtMs) : null,
      firstSlot: finite(notice.firstSlot) ? Number(notice.firstSlot) : null,
      creator: notice.creator ?? null,
      corroborations: Number.isInteger(notice.corroborations) ? notice.corroborations : 0,
      sources: Object.freeze((Array.isArray(notice.sources) ? notice.sources : []).map((leg) => Object.freeze({
        source: leg.source ?? null, kind: leg.kind ?? null,
        arrivedAtMs: finite(leg.arrivedAtMs) ? Number(leg.arrivedAtMs) : null,
        slot: finite(leg.slot) ? Number(leg.slot) : null,
        lagMsFromFirst: finite(leg.lagMsFromFirst) ? Number(leg.lagMsFromFirst) : null,
        slotsBehindFirst: finite(leg.slotsBehindFirst) ? Number(leg.slotsBehindFirst) : null,
      }))),
      reemittedAfterEviction: notice.reemittedAfterEviction === true,
      clockRegression: notice.clockRegression === true,
    }),

    createSlot: finite(createSlot) ? Number(createSlot) : null,
    observedSlot: finite(observedSlot) ? Number(observedSlot) : null,
    slotDeltaToFirstMark,

    endpointVerdict,
    endpoints: Object.freeze((Array.isArray(endpoints) ? endpoints : []).map((e) => Object.freeze({
      id: e.id ?? null, slot: finite(e.slot) ? Number(e.slot) : null,
      present: e.present === true, digest: e.digest ?? null, error: e.error ?? null,
    }))),

    /* The decoded state, in durable form. Kept because a refusal that cannot be re-judged
       against the bytes that produced it is an opinion. */
    curve: curve === null ? null : Object.freeze({
      curveType: curve.curveType ?? null,
      complete: curve.complete === true,
      creator: curve.creator ?? null,
      feeBps: finite(curve.feeBps) ? Number(curve.feeBps) : null,
      vBaseRaw: durable(curve.vBaseRaw, "vBaseRaw"),
      vQuoteRaw: durable(curve.vQuoteRaw, "vQuoteRaw"),
      realBaseRaw: durable(curve.realBaseRaw, "realBaseRaw"),
      realQuoteRaw: durable(curve.realQuoteRaw, "realQuoteRaw"),
      quoteToCompleteRaw: durable(curve.quoteToCompleteRaw, "quoteToCompleteRaw"),
      vQuote0Raw: durable(curve.vQuote0Raw, "vQuote0Raw"),
      /* `reserveKnown` is snipeCurveState's own rule — the REAL quote reserve is known iff
         the decoded row carried one — and it is DERIVED here rather than required, because
         an adapter's `curveFromAccount` returns the decoded account and the flag is added
         downstream by `snipeCurveState`. Requiring the flag made every row unjudgeable and
         emptied the scorecard silently, which is worse than an empty scorecard that says
         so: the positive class is read off this field. */
      reserveKnown: curve.reserveKnown === true
        || (curve.realQuoteRaw !== null && curve.realQuoteRaw !== undefined),
    }),

    /* THE EXACT THING IT WOULD HAVE SIGNED. Not a quote, not an estimate with a slippage
       term — the contracted quantity and the absolute lamport ceiling for it. */
    ceiling: Object.freeze({
      ticketLamports: durable(ticketLamports ?? detail.ticketLamports, "ticketLamports"),
      baseOutRaw: durable(detail.baseOutRaw, "baseOutRaw"),
      maxQuoteInRaw: durable(detail.maxQuoteInRaw, "maxQuoteInRaw"),
      impactPct: finite(detail.impactPct) ? Number(detail.impactPct) : null,
      roundTripLossPct: finite(detail.roundTripLossPct) ? Number(detail.roundTripLossPct) : null,
      halvings: Number.isInteger(detail.halvings) ? detail.halvings : null,
      /* Computed per fill by snipe-curve.mjs frictionXFor and frozen here: the mark this
         position must reach to return what it cost. At the live cap it is ~1.20x, and no
         exit logic can improve it — it is a fact about position size. */
      frictionX: finite(frictionX) ? Number(frictionX) : null,
    }),

    /* THE FULL ORDERED TRACE, with the first refusal named. */
    gate: Object.freeze({
      ok: verdict?.ok === true,
      refusedAt: verdict?.gate ?? null,
      refusedAtCost: verdict?.gate ? (SNIPE_GATE_COST[verdict.gate] ?? null) : null,
      gatesRun: trace.length,
      gatesTotal: SNIPE_GATES.length,
      message: isStr(detail.message) ? detail.message : null,
      clause: detail.clause ?? null,
      flag: detail.flag ?? null,
      trace: Object.freeze(trace.map((s) => Object.freeze({ gate: s.gate, ok: s.ok === true, cost: s.cost }))),
      /* The proxy gates are MEASURED on every row whether or not they kill, which is the
         only way their scorecard ever gets a sample. */
      measured: Object.freeze({ ...(isPlainObject(detail.measured) ? detail.measured : {}) }),
      launchSharePct: finite(detail.launchSharePct) ? Number(detail.launchSharePct) : null,
    }),

    wouldHaveSigned: verdict?.ok === true,

    timing: Object.freeze({
      hops: timing.hops,
      noticeToDecisionMs: timing.noticeToDecisionMs,
      clockRegression: timing.clockRegression,
    }),

    /* THE FORWARD PATH, appended by the lane at fixed offsets after the would-have-fill.
       Empty until then. This is where the positive class comes from. */
    forward: Object.freeze([]),
    outcome: null,

    /* STAMPED, AND ASSERTED BY THE TEST. Nothing on this path signs, and a row that
       claimed otherwise would be the only evidence anyone reads later. */
    signed: false,
    sent: false,
  };
  return Object.freeze(row);
}

/**
 * A forward observation, appended WITHOUT mutating the row — a consumer holding the
 * emitted row must not have it change under them, the same rule snipe-feed.mjs's
 * `mergeArrival` follows.
 *
 * `slotDelta` and `msAfterFill` are the offsets from the would-have-fill, supplied by the
 * caller; this module has no clock. `markX` is the simulated sell of the would-have-fill
 * back into the curve as it now stands — a round-trip multiple, so 1.0 means the swap
 * returns the swap input.
 */
export function addForwardSample(row, sample = {}) {
  if (!isPlainObject(row)) throw new TypeError("addForwardSample needs a shadow row");
  const s = Object.freeze({
    atMs: finite(sample.atMs) ? Number(sample.atMs) : null,
    slot: finite(sample.slot) ? Number(sample.slot) : null,
    slotDelta: finite(sample.slotDelta) ? Number(sample.slotDelta) : null,
    msAfterFill: finite(sample.msAfterFill) ? Number(sample.msAfterFill) : null,
    markX: finite(sample.markX) ? Number(sample.markX) : null,
    realQuoteRaw: durable(sample.realQuoteRaw, "realQuoteRaw"),
    complete: sample.complete === true,
    endpointVerdict: ENDPOINT_VERDICTS.includes(sample.endpointVerdict) ? sample.endpointVerdict : "single",
    action: isStr(sample.action) ? sample.action : null,
    reason: isStr(sample.reason) ? sample.reason : null,
    /* THE DEPLOYER'S BALANCE, and the note about it. Added explicitly because this shape is
       a whitelist on purpose — a row that carried whatever a caller passed is how a P&L
       figure ends up in a book that refuses to produce one. These two are observations, not
       outcomes: the balance the exit signal watches, and why it did or did not apply.
       "The creator holds nothing" must be visible in the record, or silence reads as
       reassurance when it actually means the signal could never fire. */
    creatorBaselineRaw: durable(sample.creatorBaselineRaw, "creatorBaselineRaw"),
    creatorNote: isStr(sample.creatorNote) ? sample.creatorNote : null,
  });
  return Object.freeze({ ...row, forward: Object.freeze([...row.forward, s]) });
}

/** Close a row's forward window with the determiner's last word. Still no P&L: `action`
 *  and `reason` are what the determiner SAID, which is a fact about the code under test. */
export function closeForwardWindow(row, { action, reason, atMs = null, slot = null } = {}) {
  if (!isPlainObject(row)) throw new TypeError("closeForwardWindow needs a shadow row");
  return Object.freeze({
    ...row,
    outcome: Object.freeze({
      action: isStr(action) ? action : null,
      reason: isStr(reason) ? reason : null,
      atMs: finite(atMs) ? Number(atMs) : null,
      slot: finite(slot) ? Number(slot) : null,
      samples: row.forward.length,
      followed: followedAfterFill(row),
    }),
  });
}

/* ── the positive class, fixed in advance ──────────────────────────────────────────── */

/**
 * DID ANYBODY FOLLOW THIS LAUNCH?
 *
 * The curve's REAL quote reserve is what the curve actually holds, so it rises if and
 * only if somebody bought. If it never rose above where it stood at the would-have-fill,
 * anywhere in the forward window, then no one followed us in — which is the failure mode
 * a t=0 proxy is supposed to predict.
 *
 * Returns null when it cannot be judged: no forward samples, or a curve whose real
 * reserve was unknown (virtual reserves quote SOL a fresh curve does not hold). An
 * unjudgeable row is EXCLUDED from the scorecard rather than counted as a negative — the
 * launch-shadow rule, and the difference between a precision figure and a flattering one.
 */
export function followedAfterFill(row) {
  if (!isPlainObject(row)) return null;
  const atFill = row.curve?.reserveKnown === true ? asBig(row.curve.realQuoteRaw) : null;
  if (atFill === null) return null;
  const seen = row.forward.map((s) => asBig(s.realQuoteRaw)).filter((v) => v !== null);
  if (!seen.length) return null;
  return seen.some((v) => v > atFill);
}

/** Known iff `followedAfterFill` can answer at all. */
export const outcomeKnown = (row) => followedAfterFill(row) !== null;

/** The POSITIVE class: a launch nobody followed. Stated before any row was collected. */
export const positiveOutcome = (row) => followedAfterFill(row) === false;

/**
 * THE RULERS UNDER TEST — the two gates §5 deliberately puts last and deliberately does
 * not make kills, because nobody has run them against a known answer yet.
 *
 * Each is `{rule, measured, flags}` exactly as `src/launch-shadow.js PROXIES` is, so the
 * scorecard below is the same function over a different row shape. The thresholds in the
 * `flags` rules are the ones a reader would reach for first; they are candidates under
 * measurement, not settings, and nothing reads them as config.
 */
export const SNIPE_PROXIES = Object.freeze({
  creator_profile: Object.freeze({
    rule: "the deployer holds >= 10% of supply at t=0",
    measured: (r) => finite(r.gate?.measured?.creator_profile),
    flags: (r) => Number(r.gate.measured.creator_profile) >= 10,
  }),
  launch_share: Object.freeze({
    rule: "the launch minute has already bought >= 100% of the curve's opening quote",
    measured: (r) => finite(r.gate?.measured?.launch_share),
    flags: (r) => Number(r.gate.measured.launch_share) >= 100,
  }),
});

/* The proxy set and the lane's proxy gates must name the same things, or the scorecard is
   grading a ruler nothing measures. Asserted at import: a mismatch is a boot failure in
   every process that loads this file, not a quiet empty column in a report. */
{
  const mine = Object.keys(SNIPE_PROXIES).sort().join(",");
  const theirs = [...SNIPE_PROXY_GATES].sort().join(",");
  if (mine !== theirs)
    throw new Error(`snipe-shadow SNIPE_PROXIES (${mine}) do not match snipe-entry SNIPE_PROXY_GATES (${theirs})`);
}

/**
 * Precision and recall of every proxy against the realized forward path, over the rows
 * where the proxy was ACTUALLY measured and the outcome ACTUALLY known. Pure reporting,
 * and it promotes nothing: `promotable` is a sentence for the owner to read.
 */
export function snipeScorecard(rows, {
  bar = PROMOTION_PRECISION_BAR, minRows = PROMOTION_MIN_ROWS, minFlagged = PROMOTION_MIN_FLAGGED,
} = {}) {
  const judged = (Array.isArray(rows) ? rows : []).filter(outcomeKnown);
  const positives = judged.filter(positiveOutcome).length;
  const proxies = {};
  for (const [name, p] of Object.entries(SNIPE_PROXIES)) {
    const measured = judged.filter((r) => { try { return p.measured(r); } catch { return false; } });
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of measured) {
      let flagged = false;
      try { flagged = p.flags(r) === true; } catch { flagged = false; }
      const pos = positiveOutcome(r);
      if (flagged && pos) tp++; else if (flagged && !pos) fp++; else if (!flagged && pos) fn++; else tn++;
    }
    const flagged = tp + fp;
    const precision = flagged ? tp / flagged : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const enoughRows = measured.length >= minRows;
    const enoughFlags = flagged >= minFlagged;
    const promotable = enoughRows && enoughFlags && precision != null && precision >= bar;
    proxies[name] = Object.freeze({
      rule: p.rule, n: measured.length, flagged, tp, fp, fn, tn,
      precision: precision == null ? null : Number(precision.toFixed(3)),
      recall: recall == null ? null : Number(recall.toFixed(3)),
      promotable,
      why: promotable
        ? `precision ${precision.toFixed(3)} >= ${bar} over ${measured.length} rows (${flagged} flagged) — `
          + "promotable to a kill, pending the owner and a registered GATE_CLASS entry"
        : !enoughRows ? `${measured.length} of ${minRows} rows judged — not enough sample to judge`
          : !enoughFlags ? `${flagged} of ${minFlagged} flagged rows — precision would be a handful of coins`
            : `precision ${precision.toFixed(3)} < ${bar} — evidence only; it kills nothing`,
    });
  }
  return Object.freeze({
    judged: judged.length,
    positives,
    positiveClass: "the curve's real quote reserve never advanced past the would-have-fill "
      + "within the forward window — a launch nobody followed",
    bar, minRows, minFlagged,
    proxies: Object.freeze(proxies),
    promotes: "nothing — this scorecard reports; wiring a proxy as a kill is a separate registered "
      + "change to GATE_CLASS",
  });
}

/* ── the tables ────────────────────────────────────────────────────────────────────── */

/**
 * THE QUEUE-DEPTH TABLE — the honest proxy for the thing this book cannot measure.
 *
 * One entry per row that has one, never collapsed into a single average: the distribution
 * IS the finding. A mean of 2 over a set that is half 0 and half 4 describes neither half,
 * and the rows that would actually have filled are the slow half.
 */
export function slotDeltaTable(rows) {
  const list = (Array.isArray(rows) ? rows : []);
  const entries = list
    .filter((r) => Number.isFinite(r.slotDeltaToFirstMark))
    .map((r) => Object.freeze({
      mint: r.mint, createSlot: r.createSlot, observedSlot: r.observedSlot,
      slots: r.slotDeltaToFirstMark, wouldHaveSigned: r.wouldHaveSigned === true,
      noticeToDecisionMs: r.timing?.noticeToDecisionMs ?? null,
    }));
  const values = entries.map((e) => e.slots);
  return Object.freeze({
    n: entries.length,
    unmeasured: list.length - entries.length,
    min: values.length ? Math.min(...values) : null,
    median: median(values),
    p90: percentile(values, 90),
    max: values.length ? Math.max(...values) : null,
    negative: values.filter((v) => v < 0).length,
    entries: Object.freeze(entries),
    meaning: "slots between the create and this machine's first readable mark — how far back in "
      + "the queue this box sits. It does not say what we would have been filled at.",
  });
}

/** Where the stack stops, by gate, in gate order. A refusal histogram is a statement about
 *  our own rules, which is the one population a shadow book samples without bias. */
export function gateHistogram(rows) {
  const counts = new Map(SNIPE_GATES.map((g) => [g, 0]));
  let cleared = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r.gate?.ok === true) { cleared++; continue; }
    const g = r.gate?.refusedAt;
    if (g && counts.has(g)) counts.set(g, counts.get(g) + 1);
  }
  return Object.freeze({
    cleared,
    refused: [...counts.values()].reduce((a, b) => a + b, 0),
    byGate: Object.freeze(SNIPE_GATES.map((g) => Object.freeze({
      gate: g, cost: SNIPE_GATE_COST[g], refusals: counts.get(g),
    }))),
  });
}

/** Hop-by-hop latency, over the rows that reached each hop. `n` per hop is the honest
 *  denominator: a row refused at cost 0 never reached `accounts`, and averaging its
 *  absence in as a zero would report a fast lane that never ran. */
export function latencyTable(rows) {
  const buckets = new Map(SHADOW_HOPS.map((h) => [h, []]));
  const totals = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    for (const leg of (r.timing?.hops ?? []))
      if (buckets.has(leg.hop)) buckets.get(leg.hop).push(leg.msFromPrev);
    if (Number.isFinite(r.timing?.noticeToDecisionMs)) totals.push(r.timing.noticeToDecisionMs);
  }
  return Object.freeze({
    hops: Object.freeze(SHADOW_HOPS.map((hop) => {
      const xs = buckets.get(hop);
      return Object.freeze({
        hop, n: xs.length,
        minMs: xs.length ? Math.min(...xs) : null,
        medianMs: median(xs),
        p90Ms: percentile(xs, 90),
        maxMs: xs.length ? Math.max(...xs) : null,
      });
    })),
    noticeToDecision: Object.freeze({
      n: totals.length,
      minMs: totals.length ? Math.min(...totals) : null,
      medianMs: median(totals),
      p90Ms: percentile(totals, 90),
      maxMs: totals.length ? Math.max(...totals) : null,
    }),
  });
}

/* ── the report ────────────────────────────────────────────────────────────────────── */

/**
 * EVERYTHING THE SHADOW BOOK IS WILLING TO SAY.
 *
 * The `sample` block answers the only question that matters before arming: is there
 * enough here to discuss it? Stated as the counting rule from §6 — PROMOTION_MIN_ROWS
 * rows that ran to a verdict with a forward path, and PROMOTION_MIN_FLAGGED of those that
 * cleared every gate — and it reports the shortfall rather than a projection of when it
 * will be met. The log produces that rate; this function will not estimate it.
 */
export function shadowReport(rows, {
  bar = PROMOTION_PRECISION_BAR, minRows = PROMOTION_MIN_ROWS, minFlagged = PROMOTION_MIN_FLAGGED,
} = {}) {
  const list = (Array.isArray(rows) ? rows : []);
  const judged = list.filter(outcomeKnown);
  const cleared = list.filter((r) => r.wouldHaveSigned === true);
  const clearedAndJudged = cleared.filter(outcomeKnown);
  const signedAnything = list.filter((r) => r.signed === true || r.sent === true);

  const report = {
    shadowVersion: SNIPE_SHADOW_VERSION,
    laneMode: list.length ? (list[0].laneMode ?? null) : null,
    rows: list.length,
    judged: judged.length,
    clearedEveryGate: cleared.length,
    clearedAndJudged: clearedAndJudged.length,
    /* A count, asserted zero by the test and by the lane's own boot check. If this is ever
       non-zero the book is not a shadow book and nothing else in the report means what it
       says. */
    signedOrSent: signedAnything.length,
    endpointVerdicts: Object.freeze(ENDPOINT_VERDICTS.map((v) => Object.freeze({
      verdict: v, rows: list.filter((r) => r.endpointVerdict === v).length,
    }))),
    gates: gateHistogram(list),
    queueDepthSlots: slotDeltaTable(list),
    latency: latencyTable(list),
    scorecard: snipeScorecard(list, { bar, minRows, minFlagged }),
    sample: Object.freeze({
      minRows, minCleared: minFlagged,
      rowsShort: Math.max(0, minRows - judged.length),
      clearedShort: Math.max(0, minFlagged - clearedAndJudged.length),
      sufficient: judged.length >= minRows && clearedAndJudged.length >= minFlagged,
      floorsFrom: "src/launch-shadow.js:112-114 — reused, not invented",
      why: judged.length >= minRows && clearedAndJudged.length >= minFlagged
        ? `${judged.length} judged rows and ${clearedAndJudged.length} would-have-entries — the sample floor `
          + "is met; arming live remains a separate owner decision on this evidence"
        : `${judged.length} of ${minRows} judged rows and ${clearedAndJudged.length} of ${minFlagged} `
          + "would-have-entries — not yet a sample anybody should argue from",
    }),
    /* NAMED, WITHOUT NUMBERS. This is the part of the report that is a refusal. */
    doesNotReport: Object.freeze(SHADOW_FORBIDDEN_MEASURES.map((m) => Object.freeze({
      measure: m.measure, why: m.why,
    }))),
    adverseSelection: "UNMEASURED BY CONSTRUCTION. A shadow book marks a fill it never had to win: "
      + "the launches this machine would actually be filled on are the ones faster bots declined. "
      + "Read the queue-depth table instead — it is the honest proxy for how far back this box sits.",
  };
  assertReportHonest(report);
  return Object.freeze(report);
}

/**
 * THE GUARD THAT MAKES THE REFUSAL STRUCTURAL RATHER THAN A PROMISE.
 *
 * Walks the whole report and throws if any KEY names a measure this book refuses AND
 * carries a number. Strings pass, because the report says the words on purpose. Run on
 * every report this module produces, and run again by the test on a report with a hit
 * rate spliced in, so the guard is proved able to say no.
 */
export function assertReportHonest(report, where = "report") {
  const seen = new Set();
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    for (const [key, value] of Object.entries(node)) {
      const at = `${path}.${key}`;
      for (const m of SHADOW_FORBIDDEN_MEASURES) {
        if (m.pattern.test(key) && typeof value === "number")
          throw new ShadowHonestyError(m.measure, at,
            `${at} = ${value} is a ${m.measure} figure, and this book refuses to produce one: ${m.why}`);
      }
      walk(value, at);
    }
  };
  walk(report, where);
  return true;
}

/**
 * The report as text. Every forbidden measure appears here BY NAME on a line that carries
 * no digits at all — that is the shape the test asserts, and it is why the refusal cannot
 * decay into "we printed it with a caveat".
 */
export function renderShadowReport(report) {
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, digits = 0) => (v === null || v === undefined ? "—" : Number(v).toFixed(digits));

  L.push(`SNIPE SHADOW BOOK  ${report.shadowVersion}  lane=${report.laneMode ?? "?"}`);
  L.push(`rows ${report.rows}  judged ${report.judged}  cleared-every-gate ${report.clearedEveryGate}  `
    + `signed-or-sent ${report.signedOrSent}`);
  L.push("");

  L.push("QUEUE DEPTH — slots between the create and this machine's first readable mark");
  const q = report.queueDepthSlots;
  L.push(`  n ${q.n}   min ${num(q.min)}   median ${num(q.median, 1)}   p90 ${num(q.p90)}   max ${num(q.max)}`
    + `   unmeasured ${q.unmeasured}`);
  for (const e of q.entries)
    L.push(`  ${pad(e.mint, 46)} create ${pad(e.createSlot, 11)} read ${pad(e.observedSlot, 11)} `
      + `delta ${pad(e.slots, 5)} slots   decision ${num(e.noticeToDecisionMs)}ms`
      + `${e.wouldHaveSigned ? "   would-have-entered" : ""}`);
  L.push("");

  L.push("GATES — where the stack stops");
  for (const g of report.gates.byGate)
    if (g.refusals) L.push(`  ${pad(g.gate, 26)} cost ${g.cost}   ${g.refusals}`);
  L.push(`  ${pad("CLEARED EVERY GATE", 26)}        ${report.gates.cleared}`);
  L.push("");

  L.push("LATENCY — by hop, over the rows that reached it");
  for (const h of report.latency.hops)
    L.push(`  ${pad(h.hop, 12)} n ${pad(h.n, 5)} min ${pad(num(h.minMs), 7)} median ${pad(num(h.medianMs, 1), 8)} `
      + `p90 ${pad(num(h.p90Ms), 7)} max ${num(h.maxMs)}`);
  const t = report.latency.noticeToDecision;
  L.push(`  notice -> would-have-signed: n ${t.n}  median ${num(t.medianMs, 1)}ms  p90 ${num(t.p90Ms)}ms  `
    + `max ${num(t.maxMs)}ms`);
  L.push("");

  L.push(`PROXY SCORECARD — positive class: ${report.scorecard.positiveClass}`);
  L.push(`  judged ${report.scorecard.judged}   positives ${report.scorecard.positives}`);
  for (const [name, p] of Object.entries(report.scorecard.proxies))
    L.push(`  ${pad(name, 18)} n ${pad(p.n, 5)} flagged ${pad(p.flagged, 5)} tp ${pad(p.tp, 4)} fp ${pad(p.fp, 4)} `
      + `fn ${pad(p.fn, 4)} — ${p.why}`);
  L.push(`  this scorecard promotes ${report.scorecard.promotes}`);
  L.push("");

  L.push(`SAMPLE — ${report.sample.why}`);
  L.push(`  floors: ${report.sample.floorsFrom}`);
  L.push("");

  L.push("WHAT THIS BOOK DOES NOT SAY");
  for (const m of report.doesNotReport)
    L.push(`  ${pad(m.measure, 18)} NOT REPORTED — ${m.why}`);
  L.push(`  adverse selection  ${report.adverseSelection}`);
  return L.join("\n");
}

/* ── the recorder ──────────────────────────────────────────────────────────────────── */

/**
 * The in-memory book. Bounded, because a process that runs for weeks against ~29 launches
 * a minute is otherwise a leak — snipe-feed.mjs's ledger makes the same trade and this one
 * makes it visibly: an evicted row is counted, so a report can never quietly be a report
 * about the last N rows while claiming to be about all of them.
 *
 * `sink` is INJECTED and optional. This module opens nothing. A sink that throws is
 * counted and swallowed: a row that cannot be persisted is a row missing from a scorecard,
 * not a decision that failed — the same rule `recordLaunchShadow` follows.
 */
export function createSnipeShadow({ capacity = 5_000, sink = null, laneMode = "observe" } = {}) {
  if (!Number.isInteger(capacity) || capacity <= 0)
    throw new TypeError(`shadow capacity must be a positive integer, got ${capacity}`);
  if (sink !== null && typeof sink !== "function")
    throw new TypeError("shadow sink must be a function, or null");

  const rows = new Map();          // mint -> frozen row, insertion ordered
  const counters = { recorded: 0, evicted: 0, forwardSamples: 0, sinkErrors: 0, replaced: 0 };

  const put = (row) => {
    if (rows.has(row.mint)) counters.replaced++;
    rows.set(row.mint, row);
    while (rows.size > capacity) {
      const oldest = rows.keys().next().value;
      rows.delete(oldest);
      counters.evicted++;
    }
    if (sink) { try { sink(row); } catch { counters.sinkErrors++; } }
    return row;
  };

  return {
    shadowVersion: SNIPE_SHADOW_VERSION,
    laneMode,

    /** One row per notice. Returns the frozen row so the lane can carry it. */
    record(args) {
      const row = openShadowRow({ laneMode, ...args });
      counters.recorded++;
      return put(row);
    },

    /** A forward observation on a row already recorded. Silent no-op on an unknown mint:
     *  the row may have been evicted, and a sampler that throws on eviction would take the
     *  lane down for a bookkeeping fact. */
    observe(mint, sample) {
      const row = rows.get(mint);
      if (!row) return null;
      counters.forwardSamples++;
      return put(addForwardSample(row, sample));
    },

    /** The determiner's last word on a would-have-position. */
    close(mint, outcome) {
      const row = rows.get(mint);
      if (!row) return null;
      return put(closeForwardWindow(row, outcome));
    },

    row(mint) { return rows.get(mint) ?? null; },
    rows() { return Object.freeze([...rows.values()]); },
    report(opts) { return shadowReport([...rows.values()], opts); },
    render(opts) { return renderShadowReport(this.report(opts)); },
    stats() {
      return Object.freeze({
        shadowVersion: SNIPE_SHADOW_VERSION, laneMode, held: rows.size, capacity, ...counters,
      });
    },
  };
}
