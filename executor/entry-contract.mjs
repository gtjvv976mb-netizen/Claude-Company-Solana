/**
 * THE ENTRY CONTRACT — one definition of "tradeable", read by both processes.
 *
 * "Published" and "tradeable" are two different definitions living in two different
 * processes today. The desk decides to publish a call from what it knows; the bot
 * decides to sign from what it can verify, and its refusals on these facts are
 * DETERMINISTIC — poller.mjs answers them at once and never retries (the retry
 * allowlist in isTransientEntryFailure is transport only). So a call the desk was
 * happy with and the bot's geometry refuses is not a delayed trade, it is a dead one,
 * and neither side ever learns the other's threshold moved.
 *
 * This module is the structural fix: ONE pure function, no clock of its own beyond the
 * `now` you hand it, no network, no wallet, no config file. It composes the two tests
 * that already exist —
 *
 *   validateEntryReference (trade-policy.mjs) — the live mark must be fresh, inside the
 *     authored zone, above the stop and below the target; and
 *   planEntry's geometry (strategy.mjs) — a call needs a stop, the stop must sit under
 *     the entry, and the target must clear the round-trip cost —
 *
 * plus the poller's inline call-age test, which was the third definition and lived
 * nowhere but inside onEntry. The gates are evaluated in ONE declared order so the
 * refusal always carries the same code on both sides, and when every gate passes the
 * returned reference is literally validateEntryReference's own output: the contract
 * cannot pass something the binder the bot signs against would refuse.
 *
 * Precedent for the direction of the import (src/ reading executor/): src/calls.js:4
 * already imports ../executor/trade-policy.mjs, and src/manifest.js ships that file in
 * the decision manifest. strategy.mjs imports only trade-policy.mjs, so pulling in its
 * DEFAULTS here costs the desk no @solana/web3.js — the root node_modules lacks it.
 *
 * A LEAF ON THE BOT'S SIDE OF THE FENCE. It deliberately does NOT import src/bands.js
 * for the band windows, even though that is where the six sleeves live: this file ships
 * to every operator's box through install.sh, and dragging a src/ module across that
 * boundary would put the desk's taxonomy on a machine that has no other part of it. The
 * call already carries hold_min_ms (calls.js writes it from bands.js), and that one
 * number is what both sides read.
 */
import { DEFAULTS } from "./strategy.mjs";
import { validateEntryReference } from "./trade-policy.mjs";

/* HOW LONG AN ENTRY IS STILL AN ENTRY, at the short end — NOW MEASURED (2026-09-08).
 *
 * This was 60_000 and said so itself: a POLL-RATE argument ("a call must survive
 * several polls"), never a measurement of the pipeline the window has to cover.
 * executor/test-entry-window.mjs times that pipeline — 50 runs of the paper preflight
 * against a local Jupiter stub and dummy RPCs — and the measurement moved the number:
 *
 *   · the bot's own code costs p50 ~5ms, p95 ~6ms. The window pays for the network,
 *     not for us.
 *   · the path issues 28 requests but is only 12 DEEP. That depth is the slope of wall
 *     time against injected per-request latency, which is the only ruler that survives
 *     the Promise.all fan-out here — counting requests over-prices the path more than
 *     twice over, and dividing a single small-latency reading by its own latency
 *     over-counted it by one whole hop (timer overshoot).
 *   · those 12 hops priced at THIS executor's own per-request deadlines, one attempt
 *     each — Jupiter /order 12s x3, RPC transport 4s, processed-slot anchor 2s,
 *     snapshot 4s, epoch fence 2s — come to 68_000ms, before POLL_MS is spent reaching
 *     the alert row at all.
 *
 * So 60_000 could not cover its own pipeline. A nano call (hold_min_ms 60_000) could
 * expire while the bot was still inside the fences that protect it, and that refusal
 * is deterministic and never retried — a dead call, not a slow one. 90_000 covers the
 * deadline-priced path at the 5s POLL_MS default (73s) and still at the 15s poll this
 * comment used to assume (83s), and stays an order of magnitude under the micro band's
 * 20-minute window, so the ladder is unchanged everywhere else. The bands themselves
 * are the owner's and did not move (src/bands.js).
 *
 * NOT a p95 of live RPC latency: that cannot be measured from a stub, and the number
 * the window has to survive is not the typical hop anyway — it is the slowest hop this
 * executor still waits for before it gives up. poller.mjs's own solBalance note records
 * "Solana RPC HTTP request timed out after 4000ms" appearing throughout the live log. */
export const ENTRY_WINDOW_FLOOR_MS = 90_000;

/* A call with no band falls back to a flat window. Matches poller.mjs's MAX_CALL_AGE_MIN
 * default (45m); a caller with its own knob passes windowFallbackMs and that wins. */
export const DEFAULT_ENTRY_WINDOW_MS = 45 * 60_000;

/* Trade-policy.mjs hardcodes both of these inside validateEntryReference. They are
 * mirrored — not re-decided — here, because this module calls that function for the
 * reference it returns and a looser value here would only produce a contract that
 * passes what the binder then throws on. */
export const MARK_MAX_AGE_MS = 15 * 60_000;
export const MARK_FUTURE_SKEW_MS = 5 * 60_000;
export const DEFAULT_ZONE_DEVIATION_PCT = 10;

/* HOW FAR A DECISION SITE MAY SIT FROM THIS FILE, counted in INTERMEDIATE modules: a
 * direct import is 0 hops, one re-export shim is 1, and 1 is the ceiling. Two is where
 * the second copy of the geometry gets written — someone wraps the contract, then
 * someone else "inlines just this one check" into the wrapper, and the two processes are
 * back to two definitions with a shared module in the middle pretending otherwise.
 * test-entry-contract-parity.mjs enforces it. */
export const CONTRACT_MAX_HOPS = 1;

/** The gates, in the order they are evaluated. The first one that fails names the refusal.
 *
 *  no_entry_ref / invalid_zone / invalid_target are not in the plan's list of eight and
 *  are not new policy: validateEntryReference refuses all three ("entry reference or stop
 *  is invalid", "authored entry zone is invalid", "authored target is invalid") and each
 *  is a precondition of the named gate that follows it, so leaving them unnamed would
 *  have meant reporting a malformed input under a geometry code. reference_refused is the
 *  dead-man's handle described at deriveReference below.
 *
 *  TWO OF THESE CODES ARE THE DESK'S ALREADY. src/calls.js's GATE_CLASS has classified
 *  `no_stop` and `stop_at_or_above_entry` SAFETY since before this file existed, and
 *  gateFailures() computes the same two facts off the record. Same name, same fact, same
 *  class — deliberately, so the two vocabularies stay one. The other ten are NOT in that
 *  table, and gateClass() answers SAFETY for anything it has not heard of: whoever wires
 *  a desk-side withhold under one of these codes must register it there EXPLICITLY first,
 *  or a live-mark refusal becomes an un-waivable rug-check. test-entry-contract-parity.mjs
 *  asserts exactly that, and turns the requirement on the moment the desk is wired. */
export const ENTRY_GATES = Object.freeze([
  "no_stop",
  "no_entry_ref",
  "stop_at_or_above_entry",
  "mark_stale",
  "invalid_zone",
  "mark_outside_zone",
  "mark_breached_stop",
  "invalid_target",
  "mark_at_target",
  "target_inside_cost",
  "window_expired",
  "reference_refused",
]);

/** The window a published call stays enterable for — poller.mjs's callExpiryMs, hoisted.
 *  The band's own MINIMUM HOLD is the window: if more time has passed than you would
 *  have held the position for, the entry idea is gone. `holdBand` is carried for the
 *  detail only; the number is hold_min_ms, which every call row already stores. */
export function entryWindowMs({
  holdMinMs, floorMs = ENTRY_WINDOW_FLOOR_MS, fallbackMs = DEFAULT_ENTRY_WINDOW_MS,
} = {}) {
  const fallback = Number(fallbackMs) > 0 ? Number(fallbackMs) : DEFAULT_ENTRY_WINDOW_MS;
  const floor = Number(floorMs) > 0 ? Number(floorMs) : ENTRY_WINDOW_FLOOR_MS;
  const hold = Number(holdMinMs);
  if (!Number.isFinite(hold) || hold <= 0) return fallback;
  return Math.max(floor, Math.min(hold, fallback * 8));
}

const num = (value) => (value == null ? NaN : Number(value));

/** validateEntryReference's own output, or the reason it refused.
 *  Every gate above has already passed when this runs, so a throw here means the gate
 *  list has drifted from the binder the bot signs against — which is exactly the
 *  condition this module exists to make impossible, so it is reported as a refusal with
 *  its own code rather than swallowed. The parity sweep asserts it never fires. */
function deriveReference(event, { now, maxMarkAgeMs, maxDeviationPct }) {
  try {
    return { reference: validateEntryReference(event, {
      nowMs: now, maxMarkAgeMs, maxDeviationPct,
    }), error: null };
  } catch (error) { return { reference: null, error }; }
}

/**
 * Is this call enterable right now, and if not, which gate says no?
 *
 * @returns {{ok: boolean, gate: string|null, detail: object}} — on a pass, `detail`
 *   carries validateEntryReference's six fields (marketMark, marketMarkAt, stopRatio,
 *   targetRatio, entryLow, entryHigh) so a caller that used to call that function can
 *   read the same numbers straight off it.
 */
export function entryContract({
  entryRef, entryLo, entryHi, stop, target, mark, markAt,
  now = Date.now(), holdBand = null, holdMinMs = null, alertTs = null,
  costPct = DEFAULTS.costPct,
  maxMarkAgeMs = MARK_MAX_AGE_MS,
  maxDeviationPct = DEFAULT_ZONE_DEVIATION_PCT,
  windowFloorMs = ENTRY_WINDOW_FLOOR_MS,
  windowFallbackMs = DEFAULT_ENTRY_WINDOW_MS,
} = {}) {
  const nowMs = Number(now) > 0 ? Number(now) : Date.now();
  const stopNum = num(stop);
  const refNum = num(entryRef);
  const markNum = num(mark);
  const markAtNum = num(markAt);
  const targetNum = target == null ? null : Number(target);
  const cost = Number.isFinite(Number(costPct)) ? Number(costPct) : DEFAULTS.costPct;
  const windowMs = entryWindowMs({ holdMinMs, floorMs: windowFloorMs, fallbackMs: windowFallbackMs });
  const alertNum = num(alertTs);
  const ageMs = Number.isFinite(alertNum) && alertNum > 0 ? nowMs - alertNum : null;

  const base = { holdBand, windowMs, ageMs, costPct: cost, now: nowMs };
  const no = (gate, message, extra = {}) => ({ ok: false, gate, detail: { ...base, message, ...extra } });

  // ── the authored bracket (planEntry, strategy.mjs) ──
  if (!(stopNum > 0))
    return no("no_stop", "call has no stop — refusing an unmanageable position");
  if (!(refNum > 0))
    return no("no_entry_ref", "entry reference or stop is invalid");
  /* planEntry's literal test, on the AUTHORED numbers: (entry - stop) / entry > 0. It is
     not the same fact as mark_breached_stop below — this one says the bracket the desk
     wrote is incoherent (a stop at or above its own entry reference can never be a stop),
     the other says the live price has already fallen through a perfectly coherent one. */
  if (!((refNum - stopNum) / refNum > 0))
    return no("stop_at_or_above_entry", "stop is at or above entry", { entryRef: refNum, stop: stopNum });

  // ── the live mark (validateEntryReference, trade-policy.mjs) ──
  if (!(markNum > 0) || !Number.isFinite(markAtNum) || markAtNum <= 0)
    return no("mark_stale", "entry has no current monitored market mark");
  if (markAtNum > nowMs + MARK_FUTURE_SKEW_MS || nowMs - markAtNum > Number(maxMarkAgeMs))
    return no("mark_stale", "entry market mark is stale",
      { markAgeMs: nowMs - markAtNum, maxMarkAgeMs: Number(maxMarkAgeMs) });

  const fallbackBand = Math.max(0, Number(maxDeviationPct)) / 100;
  const low = num(entryLo) > 0 ? Number(entryLo) : refNum * (1 - fallbackBand);
  const high = num(entryHi) > 0 ? Number(entryHi) : refNum * (1 + fallbackBand);
  if (!(high >= low && low > 0))
    return no("invalid_zone", "authored entry zone is invalid", { entryLow: low, entryHigh: high });
  if (markNum < low || markNum > high)
    return no("mark_outside_zone", `current mark ${markNum} is outside authored entry zone ${low}-${high}`,
      { entryLow: low, entryHigh: high, marketMark: markNum });
  if (markNum <= stopNum)
    return no("mark_breached_stop", `current mark ${markNum} has already breached stop ${stopNum}`,
      { marketMark: markNum, stop: stopNum });
  if (targetNum != null && !(targetNum > 0))
    return no("invalid_target", "authored target is invalid");
  if (targetNum != null && targetNum <= markNum)
    return no("mark_at_target", `current mark ${markNum} has already reached authored target ${targetNum}`,
      { marketMark: markNum, target: targetNum });

  /* ── R_net, ANCHORED ON THE PRICE THE MONEY ACTUALLY PAYS ──────────────────────
     planEntry's R_net test, on the same normalisation poller.mjs:1232 already feeds it:
     entry_ref 1, stop and target as ratios of the LIVE MARK. Anchoring it on the
     authored entry_ref instead would refuse the good half of the drift — a mark below
     the authored reference is a CHEAPER entry with a wider target and a tighter stop,
     i.e. a better bracket than the one the desk published — and the mark is what the
     round trip is actually paid on. The authored bracket is not unjudged:
     stop_at_or_above_entry above tests it on the desk's own numbers. */
  const stopFrac = (markNum - stopNum) / markNum;
  const targetFrac = targetNum == null ? null : (targetNum - markNum) / markNum;
  const rNet = targetFrac == null ? null : (targetFrac - cost) / (stopFrac + cost);
  if (rNet != null && !(rNet > 0))
    return no("target_inside_cost", `costs eat the target: R_net ${rNet.toFixed(2)}`, { rNet });

  /* ── the call's own clock (poller.mjs onEntry) ────────────────────────────────
     A call with no alert timestamp has no clock to be judged against — the desk runs
     the contract BEFORE anything is raised — so the window is simply not tested there,
     and detail.windowChecked says so rather than leaving the caller to infer it. */
  if (ageMs != null && ageMs > windowMs)
    return no("window_expired",
      `call is ${Math.round(ageMs / 60_000)}m old — the ${holdBand || "default"} band ` +
      `holds for at least ${Math.round(windowMs / 60_000)}m, so the entry is past`,
      { windowChecked: true });

  const { reference, error } = deriveReference(
    { current_mark: markNum, current_mark_at: markAtNum, entry_ref: refNum, stop: stopNum,
      entry_lo: entryLo, entry_hi: entryHi, target: targetNum },
    { now: nowMs, maxMarkAgeMs, maxDeviationPct });
  if (error) return no("reference_refused", error.message);

  return { ok: true, gate: null,
    detail: { ...base, message: "entry is inside the contract", windowChecked: ageMs != null,
      rNet, stopFrac, targetFrac, ...reference } };
}
