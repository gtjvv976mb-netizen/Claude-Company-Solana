/**
 * MIRROR MODE — the bot evaluates the DESK's levels with the DESK's ruler, only while
 * the desk cannot be heard.
 *
 * Under desk-led-v4 the bot has no exit policy of its own: it sells exactly what the
 * desk determined, when it hears it. Shrek, call 55, 2026-09-05 is why — the bot sold
 * at 03:01:42Z on its own normalised stop (stop / current_mark-at-fill, measured on a
 * chain-simulated Jupiter quote against its own fill) at -13.5%, while the desk's
 * determined stop_hit (stop vs the DexScreener consensus mark against entry_ref, on the
 * desk's own witness clock) came at 03:10:24Z. Same policy function, different inputs,
 * a nine-minute disagreement the owner called out verbatim: "all exits should be
 * followed not after or before, but as exactly as it was determined".
 *
 * But a bot whose only exit is the desk's word is naked when the desk is silent. So
 * after DESK_UNREACHABLE_MS of consecutive feed failure the bot MIRRORS the desk: it
 * runs the SAME shared pricePolicy the desk's evaluateExit runs (src/calls.js), on
 * POLICY_DEFAULTS plus whatever dials the DESK has restated about itself (never the
 * bot's own operator dials — see DESK_POLICY_FIELDS), on the desk's own ABSOLUTE levels
 * stored on the position at fill (entry_ref, stop, target, opened_at, band window,
 * and the desk's restated high-water mark), against the
 * desk's own ruler (executor/dexscreener-consensus.mjs), and maps the sell reason to the
 * desk's close code with the exact expression evaluateExit uses. Same levels, same
 * ruler, same clock, same code — the determination the desk would have made, produced
 * by the only party still awake.
 *
 * The high-water mark is the desk's two-witness high, carried mirror-side as
 * mirrorHigh / mirrorPendingHigh so a lone spike can never arm a stop here either.
 */
import { POLICY_DEFAULTS, POLICY_VERSION, pricePolicy } from "./trade-policy.mjs";

/** The desk's own mapping from a pricePolicy sell reason to a close code. Copied
 *  from src/calls.js evaluateExit verbatim; test-policy-parity asserts the two agree. */
export function deskCodeForReason(reason) {
  const text = String(reason || "");
  return text.startsWith("take profit") ? "take_profit"
    : text.startsWith("age exit") || / window closed /.test(text) ? "thesis_expired"
    : text === "desk target hit" ? "target_hit" : "stop_hit";
}

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The desk's view of this position: absolute USD levels and the desk's clock. */
export function mirrorPosition(pos) {
  const entry = positive(pos?.deskEntryRef);
  const stop = positive(pos?.deskStop);
  const target = positive(pos?.deskTarget);
  /* The desk's clock, or — on a position filled before desk-led-v4, which carries no
   * desk levels — the bot's own fill time. That anchor is LATER than the desk's opened_at
   * by construction (the desk publishes, then the bot fills), so a window measured from
   * it can only close later than the desk's, never earlier: conservative in the one
   * direction that matters. The price lane gets no such fallback (mirrorPriceable). */
  const openedAtMs = positive(pos?.deskOpenedAt) ?? positive(pos?.openedAtMs);
  const mirrorHigh = Number(pos?.mirrorHigh) || 0;
  /* THE DESK'S RATCHET IS CARRIED, NOT RE-EARNED. The desk's high-water mark is the
   * confirmed high of every mark it has taken since the call opened (calls.js
   * highWaterMark), and it is what has already moved the desk's breakeven and trailing
   * stops. Seeding the mirror at entry_ref alone threw that away: a call the desk had
   * run to 2x — its stop trailed to 1.5x — reverted to the AUTHORED stop the moment the
   * mirror took over, and the mirror then held through a level the desk had already
   * moved. That is "not as determined" in the same direction as Shrek, call 55, only
   * later instead of earlier. The desk restates it as high_water on the call-state route
   * and refreshDeskLevels stores it as deskHigh. */
  const deskHigh = Number(pos?.deskHigh) || 0;
  return {
    entry, stop, target,
    /* The desk seeds its high at max(highWaterMark, entry_ref) — calls.js policyHwm.
     * Plus the mirror's own two-witness high, which only ever ratchets upward. */
    high: Math.max(mirrorHigh, deskHigh, entry || 0),
    pendingHigh: Number(pos?.mirrorPendingHigh) || 0,
    openedAtMs,
    holdBand: pos?.holdBand ?? null,
    holdMaxMs: positive(pos?.holdMaxMs),
  };
}

/* THE DESK'S DIALS, NOT THE BOT'S. evaluateExit builds its config as
 * `{...POLICY_DEFAULTS, takeProfitX: DESK_TAKE_PROFIT_X || default, maxAgeHours: …,
 * trailPct: …}` (src/calls.js), so an operator who tunes the desk moves the desk's
 * determination and nothing else — the mirror kept running POLICY_DEFAULTS and silently
 * desynchronised from the very determination it exists to reproduce. The mirror cannot
 * read the desk's environment, so the desk must RESTATE the dials the way it restates a
 * stop; these are consumed here the moment it does, and until then every one of them is
 * absent and POLICY_DEFAULTS stands. Same rule as the levels: only a positive finite
 * restatement counts, and 0 is ignored exactly as `|| POLICY_DEFAULTS` ignores it. */
export const DESK_POLICY_FIELDS = Object.freeze([
  ["deskTakeProfitX", "take_profit_x", "takeProfitX"],
  ["deskMaxAgeHours", "max_age_hours", "maxAgeHours"],
  ["deskTrailPct", "trail_pct", "trailPct"],
]);

/** The desk's restated policy dials carried on `pos`, as a pricePolicy config patch. */
export function deskPolicyConfig(pos) {
  const config = {};
  for (const [field, , key] of DESK_POLICY_FIELDS) {
    const value = positive(pos?.[field]);
    if (value != null) config[key] = value;
  }
  return config;
}

/** Can the price lane run at all? Without the desk's absolute entry and stop the
 *  mirror can only run the clock — a legacy position filled before desk-led-v4 has
 *  ratios off its own fill, and those are exactly the numbers this mode must not use. */
export function mirrorPriceable(pos) {
  const m = mirrorPosition(pos);
  return m.entry != null && m.stop != null;
}

/**
 * Evaluate the desk's determination for one held position.
 * `mark` is the DexScreener consensus priceUsd (or null: clock lane only).
 * Returns {action:'sell'|'hold', code, reason, position, policyVersion} and writes the
 * two-witness high back onto `pos` (mirrorHigh / mirrorPendingHigh) exactly as
 * stepPosition used to persist pricePolicy's state transition.
 */
export function evaluateMirror(pos, { mark = null, now = Date.now(), config = null } = {}) {
  const position = mirrorPosition(pos);
  const priceable = position.entry != null && position.stop != null;
  const usableMark = priceable && Number(mark) > 0 ? Number(mark) : null;
  const decision = pricePolicy({
    position, mark: usableMark, deskExit: null,
    nowMs: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    /* Defaults, then whatever the DESK has restated about its own dials, then an
     * explicit caller override (tests and replays only). The middle term is the one
     * that keeps a tuned desk and its mirror on the same policy. */
    config: { ...POLICY_DEFAULTS, ...deskPolicyConfig(pos),
      ...(config && typeof config === "object" ? config : {}) },
  });
  if (pos && typeof pos === "object") {
    // Only the confirmed high and its staged witness are carried; the ratcheted stop
    // is re-derived from the high on every pass, exactly as the desk re-derives it.
    if (Number(decision.position?.high) > 0) pos.mirrorHigh = Number(decision.position.high);
    pos.mirrorPendingHigh = Number(decision.position?.pendingHigh) || 0;
  }
  if (decision.action !== "sell") {
    return { action: "hold", code: null, reason: decision.reason,
      priceable, position: decision.position, policyVersion: POLICY_VERSION };
  }
  return { action: "sell", code: deskCodeForReason(decision.reason), reason: decision.reason,
    priceable, position: decision.position, policyVersion: POLICY_VERSION };
}

/** Matches the desk's PENTHOUSE_SUBMARK_SECS default (45s): the mirror's price lane
 *  cadence. The clock lane runs every tick with a null mark. */
export const MIRROR_MARK_MS = 45_000;

/* ── WAVE 2: THE EXIT THAT NEVER ARRIVED ────────────────────────────────────────────
 *
 * Wave 1 made the desk the sole author of exits, so the bot's ONLY exit path while the
 * desk is REACHABLE is a single type:"exit" row on the executor feed — and that row is
 * delivered once, ever. `alerts` has UNIQUE(floor_no, call_id, kind), the feed serves
 * rows strictly after a durable cursor, and the cursor advances per event: a restart, an
 * error on that row, or a frozen-book advance past it and the desk never re-sends it.
 * reconcileMissingExitAlerts repairs a missing alert ROW; nothing re-delivers a row the
 * bot's cursor has already passed. Worse, a desk whose penthouse loop is wedged answers
 * a perfectly healthy 200 with no exit events — byte-for-byte identical to "the desk
 * looked and decided to hold" — and mirror mode never engages because the feed is not
 * unreachable at all.
 *
 * Removing the bot's own stop is what the owner asked for (Shrek, call 55, 2026-09-05:
 * the bot sold at 03:01:42Z on its own normalised stop at -13.5%, the desk's determined
 * stop_hit landed 03:10:24Z). It is also exactly why a missed or undelivered desk exit is
 * now UNSURVIVABLE rather than merely late: there is no second opinion left underneath.
 * "As exactly as it was determined" is not satisfied by holding forever when the
 * determination never arrives — it is satisfied by noticing and acting.
 *
 * So the bot ASKS about the calls it is actually holding (GET /executor/calls?ids=…), a
 * bounded state read rather than a bigger event stream, and the pure functions below
 * decide what the answer means. Nothing here fetches, sells, logs or touches the
 * journal: poller.mjs owns every side effect, and keeping the verdict pure is what lets
 * both halves of this wave be tested without a desk and without a wallet.
 */

/** The desk's route accepts at most 25 ids; anything more is a 400, not a truncation. */
export const RECONCILE_MAX_IDS = 25;

/* THE DEDUPE KEY. A recovered exit is executed through the SAME desk-exit path as a
 * delivered one, so its intent id is `desk-exit:<this>` and the journal's own
 * one-intent-per-id rule makes a repeated reconcile pass a no-op. That only holds while
 * this string is a pure function of facts the desk will restate verbatim — floor, call,
 * and the desk's own closed_at. Never Date.now(): a clock in the key would sell the
 * position again on every single pass. */
export const reconcileExitEventId = (floorNo, callId, closedAt) =>
  `reconcile:${floorNo}:${callId}:${closedAt}`;

/**
 * DOES THIS ROW EVEN DESCRIBE THE COIN THE BOT HOLDS?
 *
 * The delivered-event path has always asked this FIRST — `if (String(event.mint || "")
 * !== position.mint) return {action:"ignore", reason:"different-mint"}` (journal.mjs
 * deskExitDecisionForPosition), commented there as "mint equality alone is never
 * sufficient". The reconcile path binds on the call id alone, and a call id is not an
 * identity: `calls.id` is INTEGER PRIMARY KEY AUTOINCREMENT, so a desk database restored
 * from a backup re-issues ids the bot is already holding — the exact condition the feed's
 * own "CRITICAL FEED ROLLBACK" branch exists to detect — and a bot restarted with a
 * different CC_FLOOR reaches the same wrong answer with no rollback to detect at all.
 * Binding on the id alone, the bot would adopt another coin's stop and sell the whole
 * position on another coin's close.
 *
 * A row that CONTRADICTS the held mint is an integrity alarm, not a hold: something has
 * gone wrong at the desk or in the bot's floor identity, and the operator has to know.
 * A row that simply carries NO mint proves nothing either way (an older desk build that
 * does not serve the field yet) and is refused quietly — no sell, no level refresh, hold.
 */
export function callIdentityVerdict(position, call) {
  const held = typeof position?.mint === "string" ? position.mint : "";
  const answered = typeof call?.mint === "string" ? call.mint : "";
  if (!held)
    return { ok: false, mismatch: false, heldMint: held, answeredMint: answered,
      reason: "the held position carries no mint to compare" };
  if (!answered)
    return { ok: false, mismatch: false, heldMint: held, answeredMint: answered,
      reason: "the desk's answer carries no mint for this call id" };
  if (answered !== held)
    return { ok: false, mismatch: true, heldMint: held, answeredMint: answered,
      reason: `the desk's row for this call id is about ${answered}, not the held ${held}` };
  return { ok: true, mismatch: false, heldMint: held, answeredMint: answered,
    reason: "the desk's row is about the held mint" };
}

/**
 * What the desk's answer about ONE held call means. Pure; no clock of its own beyond
 * the `now` it is handed (the route returns the DESK's clock so staleness is measured
 * against the desk's own time rather than the bot's, which is the whole point of asking).
 *
 * closed              → the desk HAS determined the exit and the bot missed the event.
 * live + long unmarked→ the desk is answering but not watching this call.
 * live + fresh        → the normal path. Silent.
 * absent              → NEVER an exit signal: it may be an id this desk never heard of,
 *                       or a delivery that was re-verdicted. Hold.
 * identity_mismatch   → the row is about a DIFFERENT coin. Integrity alarm; hold.
 * identity_unproven   → the row named no mint, so it proves nothing. Hold.
 *
 * `position` is the held position the row is supposed to describe. It is optional only
 * so the status logic above can be exercised on its own; the poller always passes it,
 * and without it NOTHING here has checked that the row is about the held coin.
 */
export function reconcileVerdict({ call = null, position = null, now = Date.now(),
  deskSilentMs = 600_000, floorNo = "" } = {}) {
  if (!call || typeof call !== "object")
    return { action: "absent", reason: "the desk's answer does not carry this call" };
  /* IDENTITY BEFORE ANYTHING THE ROW SAYS — before its levels are adopted and before its
   * close is executed. See callIdentityVerdict: a call id is not an identity. */
  if (position != null) {
    const identity = callIdentityVerdict(position, call);
    if (!identity.ok)
      return { action: identity.mismatch ? "identity_mismatch" : "identity_unproven",
        heldMint: identity.heldMint, answeredMint: identity.answeredMint, reason: identity.reason };
  }
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const status = String(call.status || "").trim().toLowerCase();
  if (status === "closed") {
    /* close_reason is the desk's code and rides all the way to the fill report. A desk
     * that closed a call without stamping one gets the same neutral "exit" the delivered
     * event path uses (handleDeskExitEvent: `ev.code || "exit"`) — inventing a specific
     * code here would put a determination in the desk's mouth. */
    const code = String(call.close_reason || "").trim() || "exit";
    const closedAt = positive(call.closed_at) ?? 0;
    return {
      action: "desk_exit", code, closedAt, closeMark: positive(call.close_mark),
      eventId: reconcileExitEventId(floorNo, Number(call.call_id), closedAt),
      reason: `the desk closed this call (${code}) and the bot still holds it`,
    };
  }
  if (status !== "live")
    return { action: "unknown", status,
      reason: `desk status "${status || "(none)"}" is neither live nor closed` };
  /* Staleness needs a baseline. last_mark_ts is the real one; opened_at is the honest
   * fallback, because a call the desk opened and has NEVER marked is the exact condition
   * this case exists to catch — reading "never marked" as "fresh" would hide it. With
   * neither, staleness is unmeasurable and the bot holds rather than guessing. */
  const markedAt = positive(call.last_mark_ts) ?? positive(call.opened_at);
  if (markedAt == null)
    return { action: "unmeasurable", reason: "the desk gave neither last_mark_ts nor opened_at" };
  const staleMs = Math.max(0, nowMs - markedAt);
  if (staleMs > Number(deskSilentMs))
    return { action: "engage_mirror", staleMs, markedAt,
      reason: `the desk last marked this call ${(staleMs / 60_000).toFixed(1)} minutes ago` };
  return { action: "watch", staleMs, markedAt,
    reason: `the desk marked this call ${Math.round(staleMs / 1000)}s ago` };
}

/* THE DESK'S LEVELS ARE THE DESK'S TO RESTATE. The position stores them at fill; this
 * route serves them live, and a desk that has moved a stop must be followed for the same
 * reason the mirror uses the desk's levels at all. Only a positive finite restatement
 * counts — an absent or zero field is a route that did not say, never an instruction to
 * forget a level the bot already holds. */
const DESK_LEVEL_FIELDS = Object.freeze([
  ["deskEntryRef", "entry_ref"], ["deskStop", "stop"], ["deskTarget", "target"],
  ["deskOpenedAt", "opened_at"], ["holdMaxMs", "hold_max_ms"],
  /* The desk's own high-water mark — the same highWaterMark(c.id) its evaluateExit seeds
   * policyHwm from. It is a LEVEL in every sense that matters here: it is what has
   * already moved the desk's breakeven and trailing stops, and a mirror that starts from
   * entry_ref instead holds through a stop the desk had ratcheted. */
  ["deskHigh", "high_water"],
]);

/** Write the desk's restated levels onto `pos`; returns what actually changed. */
export function refreshDeskLevels(pos, call) {
  const changes = [];
  if (!pos || typeof pos !== "object" || !call || typeof call !== "object") return changes;
  for (const [field, key] of [...DESK_LEVEL_FIELDS,
    // The dials ride with the levels: same restatement rule, same "absent says nothing".
    ...DESK_POLICY_FIELDS.map(([field_, key_]) => [field_, key_])]) {
    const next = positive(call[key]);
    if (next == null) continue;
    const previous = positive(pos[field]);
    if (previous === next) continue;
    pos[field] = next;
    changes.push({ field, from: previous, to: next });
  }
  const band = typeof call.hold_band === "string" && call.hold_band.trim()
    ? call.hold_band.trim() : null;
  if (band && band !== pos.holdBand) {
    changes.push({ field: "holdBand", from: pos.holdBand ?? null, to: band });
    pos.holdBand = band;
  }
  return changes;
}

/**
 * MAY A RECONCILIATION PASS RUN? Pure, so the gates are executed by a test rather than
 * read off the source. Every one of them is in the contract, and each earns its place:
 *
 *  - EXECUTE only. In paper there is no position to recover and no sell to dedupe; a
 *    paper pass would log a recovered exit every minute for a book that does not exist.
 *  - a positive callId. The route is keyed by call id; a legacy position that cannot
 *    prove which call it came from has nothing to ask about (and asking under a guessed
 *    id could return another call's state).
 *  - the feed must be currently REACHABLE. Mirror mode already owns the unreachable
 *    case, and a desk that cannot be reached cannot answer this route either.
 *  - the authenticated feed must NOT be in rollback. When latest_id has fallen behind
 *    the durable cursor the desk's database is not the one the bot has been trading
 *    against, and entries are frozen for exactly that reason (poller.mjs, the SKIP on
 *    feedRollbackActive). The call-state route reads the SAME suspect database, and its
 *    ids are AUTOINCREMENT — a restored backup re-issues ids the bot is holding — so a
 *    rollback is the moment its answers are least worth acting on and most likely to be
 *    about another coin. Note the mirror's clock keeps running: consumeFeed calls
 *    noteDeskReachable() BEFORE the rollback branch on purpose (a desk that answers is
 *    reachable, and mirroring a talking desk would be the bot second-guessing it), which
 *    is why this gate reads the rollback flag itself rather than unreachability.
 *  - at most once per RECONCILE_MS, and never overlapping itself.
 *
 * Returns {run, why} — `why` names the gate, so a caller and a transcript can say which.
 */
export function reconcileGate({ execute = false, inFlight = false, deskUnreachableSince = null,
  feedRollback = false, now = Date.now(), lastReconcileAt = 0, reconcileMs = 60_000,
  heldCallIds = [] } = {}) {
  if (!execute) return { run: false, why: "paper" };
  if (inFlight) return { run: false, why: "in-flight" };
  if (deskUnreachableSince != null) return { run: false, why: "desk-unreachable" };
  if (feedRollback === true) return { run: false, why: "feed-rollback" };
  if (Number(now) - Number(lastReconcileAt) < Number(reconcileMs)) return { run: false, why: "throttled" };
  const ids = [];
  for (const value of heldCallIds) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return { run: false, why: "nothing-held" };
  return { run: true, why: "reconcile", ids: ids.slice(0, RECONCILE_MAX_IDS) };
}

/* ── A STAND-IN DETERMINATION MUST EXPIRE ───────────────────────────────────────────
 *
 * A latched exit is retried ahead of all other work on every pass (manageOpen) and
 * nothing ever cancelled it, which is right for a determination: a desk_exit is the
 * desk's word and a risk_exit is a custody/legacy path that already crossed the durable
 * boundary. A mirror_exit is neither. It is the bot's OWN stand-in, produced only
 * because the desk could not be heard — and once latched it survived the desk coming
 * back and reporting the call LIVE, so the bot would liquidate on a stale reading of a
 * position the real determiner had since said to hold. That is a bot exiting "not as it
 * was determined" (Shrek, call 55, 2026-09-05) with an extra step.
 *
 * So a mirror determination expires the moment the party it stood in for is determining
 * again: the desk is reachable AND is not silent on this particular call. Nothing else
 * expires — a desk_exit or a risk_exit latch is never droppable here — and a latch whose
 * sell has already crossed the signing boundary is never droppable either, because at
 * that point the position may already be gone and bounded recovery owns the outcome.
 */
export const MIRROR_LATCH_UNDROPPABLE_STATES = Object.freeze([
  "signed", "submitted", "ambiguous", "confirmed", "accounted",
]);

/** What kind of exit a latch carries. Stamped at latch time; a latch persisted by an
 *  older journal carries no stamp, so fall back to the intent-id prefix sellAll itself
 *  uses — `mirror-exit:` ids are produced by mirrorTick and by nothing else. */
export function exitLatchKind(pos) {
  const stamped = String(pos?.exitExecutionKind || "").trim();
  if (stamped) return stamped;
  const id = String(pos?.exitExecutionIntentId || "");
  if (id.startsWith("desk-exit:")) return "desk_exit";
  if (id.startsWith("mirror-exit:")) return "mirror_exit";
  return id ? "risk_exit" : "";
}

/** May this latch be dropped? Pure, so every clause is executed by a test rather than
 *  read off poller.mjs. Returns {drop, why} — `why` names the clause that decided. */
export function mirrorLatchExpiry({ position = null, deskReachable = false,
  deskSilent = false, intentState = null } = {}) {
  if (!position || position.exitExecutionRequired !== true) return { drop: false, why: "no-latch" };
  const kind = exitLatchKind(position);
  if (kind !== "mirror_exit") return { drop: false, why: `${kind || "unknown"}-is-a-determination` };
  /* Stamped false only where the latch is provably NOT the mirror's stand-in. Absent is
   * read as a stand-in: every mirror-exit id in existence was written by mirrorTick,
   * which runs only while the desk is unreachable or silent on that call. */
  if (position.exitExecutionStandIn === false) return { drop: false, why: "not-a-stand-in" };
  if (!deskReachable) return { drop: false, why: "desk-still-unreachable" };
  if (deskSilent) return { drop: false, why: "desk-still-silent-on-this-call" };
  const state = String(intentState || "");
  if (MIRROR_LATCH_UNDROPPABLE_STATES.includes(state)) return { drop: false, why: `intent-${state}` };
  return { drop: true, why: "the-desk-determines-this-exit-again",
    observedAt: Number(position.exitExecutionObservedAt) || 0, kind };
}
