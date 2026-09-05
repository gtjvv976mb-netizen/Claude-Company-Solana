// v3: the high-water mark requires two consecutive witnesses before it ratchets a stop.
// v4 (desk-led, 2026-09-05): the executor no longer runs this policy on its own inputs.
// The DESK determines every exit and the bot sells what it hears; the bot evaluates this
// function only in MIRROR mode, on the desk's absolute levels with the desk's ruler.
// Shrek, call 55: bot sold 03:01:42Z on its own normalised stop at -13.5%; the desk's
// determined stop_hit came 03:10:24Z. The function is unchanged; who runs it is not.
export const POLICY_VERSION = "desk-led-v4";

export const POLICY_DEFAULTS = Object.freeze({
  takeProfitX: 2,
  /* THE BACKSTOP, not the policy. Each call now carries its own band window (nano half
     an hour, very high a day) and that is what closes a position; this is only the
     ceiling for a call that carried none, and it matches the longest band so it can
     never cut a very-high hold short. An operator setting MAX_AGE_HOURS lower still
     wins everywhere: the shorter of the two governs. */
  maxAgeHours: 24,
  trailPct: 0.25,
  breakevenArmX: 1.35,
  trailArmX: 1.5,
  honorDeskTarget: true,
});

/** Resolve the floor dial once, when the position opens. */
export function resolveTakeProfitRule(rawValue, fallback = POLICY_DEFAULTS.takeProfitX) {
  const raw = Number(rawValue);
  const explicit = Number.isFinite(raw) && raw > 0;
  const fallbackNumber = Number(fallback);
  return {
    takeProfitX: explicit ? raw
      : (Number.isFinite(fallbackNumber) && fallbackNumber > 0
        ? fallbackNumber : POLICY_DEFAULTS.takeProfitX),
    honorDeskTarget: !explicit,
  };
}

/** Restore the immutable rule saved on an open position. */
export function policyConfigForPosition(position, baseConfig = {}) {
  const savedTakeProfit = Number(position?.takeProfitX);
  return {
    ...baseConfig,
    takeProfitX: Number.isFinite(savedTakeProfit) && savedTakeProfit > 0
      ? savedTakeProfit : (baseConfig.takeProfitX ?? POLICY_DEFAULTS.takeProfitX),
    // Old state has no boolean. Honor the authored target in that ambiguous case;
    // exiting earlier is the conservative migration and new positions always persist it.
    honorDeskTarget: typeof position?.honorDeskTarget === "boolean"
      ? position.honorDeskTarget
      : (baseConfig.honorDeskTarget ?? POLICY_DEFAULTS.honorDeskTarget),
  };
}

/** Bind an entry to a recent independently monitored USD mark before local signing.
 * The position policy itself remains dimensionless; ratios are anchored to this
 * verified mark so an old authored stop cannot silently widen after a price gap. */
export function validateEntryReference(event, {
  nowMs = Date.now(), maxMarkAgeMs = 15 * 60_000, maxDeviationPct = 10,
} = {}) {
  const mark = Number(event?.current_mark);
  const markAt = Number(event?.current_mark_at);
  const reference = Number(event?.entry_ref);
  const stop = Number(event?.stop);
  if (!(mark > 0) || !Number.isFinite(markAt) || markAt <= 0)
    throw new Error("entry has no current monitored market mark");
  if (markAt > nowMs + 5 * 60_000 || nowMs - markAt > maxMarkAgeMs)
    throw new Error("entry market mark is stale");
  if (!(reference > 0) || !(stop > 0)) throw new Error("entry reference or stop is invalid");
  const fallbackBand = Math.max(0, Number(maxDeviationPct)) / 100;
  const low = Number(event?.entry_lo) > 0 ? Number(event.entry_lo) : reference * (1 - fallbackBand);
  const high = Number(event?.entry_hi) > 0 ? Number(event.entry_hi) : reference * (1 + fallbackBand);
  if (!(high >= low && low > 0)) throw new Error("authored entry zone is invalid");
  if (mark < low || mark > high)
    throw new Error(`current mark ${mark} is outside authored entry zone ${low}-${high}`);
  if (mark <= stop) throw new Error(`current mark ${mark} has already breached stop ${stop}`);
  const target = event?.target == null ? null : Number(event.target);
  if (target != null && !(target > 0)) throw new Error("authored target is invalid");
  if (target != null && target <= mark)
    throw new Error(`current mark ${mark} has already reached authored target ${target}`);
  return {
    marketMark: mark,
    marketMarkAt: markAt,
    stopRatio: stop / mark,
    targetRatio: target == null ? null : target / mark,
    entryLow: low,
    entryHigh: high,
  };
}

/** Pure price-policy decision shared byte-for-byte by the server record and executor. */
export function pricePolicy({ position, mark, deskExit = null, nowMs = Date.now(), config = {} }) {
  const c = { ...POLICY_DEFAULTS, ...config };
  const p = { ...position };
  if (deskExit) return { action: "sell", fraction: 1,
    reason: `desk exit: ${deskExit.code || "exit"}`, position: p, policyVersion: POLICY_VERSION };

  /* THE CLOCK RUNS BEFORE THE PRICE. This desk buys low to sell high inside a session,
   * so the sell is decided when the call is: each market-cap band carries the window it
   * deserves — half an hour at $9k, a day at $5m — and the position closes on it whether
   * or not the target printed. The window travels with the call; the bot's own
   * maxAgeHours remains the backstop and the shorter of the two always wins, so a
   * conservative operator can shorten every hold but a call can never extend one. */
  const bandHoldMs = Number(p.holdMaxMs) > 0 ? Number(p.holdMaxMs) : null;
  const configuredHoldMs = c.maxAgeHours > 0 ? c.maxAgeHours * 3600e3 : null;
  const holdMs = bandHoldMs != null && configuredHoldMs != null
    ? Math.min(bandHoldMs, configuredHoldMs) : (bandHoldMs ?? configuredHoldMs);
  if (p.openedAtMs != null && holdMs > 0) {
    const heldMs = nowMs - p.openedAtMs;
    if (heldMs >= holdMs) {
      const mins = Math.round(heldMs / 60_000);
      const onBand = bandHoldMs != null && holdMs === bandHoldMs;
      return { action: "sell", fraction: 1,
        reason: onBand
          ? `the ${p.holdBand || "band"} window closed after ${mins}m — this desk sells on the clock`
          : `age exit — ${Math.round(heldMs / 3600e3)}h with no resolution`,
        position: p, policyVersion: POLICY_VERSION };
    }
  }
  if (!(mark > 0)) return { action: "hold", reason: "no readable mark", position: p, policyVersion: POLICY_VERSION };

  /* THE HIGH-WATER MARK NEEDS TWO WITNESSES.
   * The high used to ratchet on any single sample, and the stops it arms can never
   * come back down — so one anomalous quote (a one-block WSOL-heavy pool reads the
   * sell quote rich) at 1.9x armed breakeven AND the trail on a position whose real
   * price was 1.1x, and the very next honest tick force-sold it as a "ratcheted
   * stop". Measured with this exact policy: t1 glitch 1.9 → hold, stop 1.425; t2
   * real 1.1 → sell. An irreversible state change now requires the mark to clear the
   * OLD high on two consecutive ticks; the committed value is the LOWER of the two
   * samples, both real observations, taken conservatively. A genuine run commits one
   * tick late — the trail is 25%, a 15s tick costs it nothing — while a lone spike
   * between two ordinary ticks leaves no trace. Downstream sells still read the raw
   * mark: a sell decision executes at a REAL re-quoted price, so a glitch there
   * costs a premature exit at the true market, never a manufactured loss. */
  const prevHigh = Number(p.high) || 0;
  if (mark > prevHigh) {
    const staged = Number(p.pendingHigh) || 0;
    if (staged > prevHigh) p.high = Math.min(staged, mark);   // second consecutive witness
    p.pendingHigh = mark;                                     // stage this sample for the next tick
  } else {
    p.pendingHigh = 0;                                        // the spike had no second witness
  }
  if (p.entry > 0 && p.high >= p.entry * c.breakevenArmX)
    p.stop = Math.max(Number(p.stop) || 0, p.entry);
  if (p.entry > 0 && p.high >= p.entry * c.trailArmX)
    p.stop = Math.max(Number(p.stop) || 0, p.high * (1 - c.trailPct));

  if (mark <= p.stop) return { action: "sell", fraction: 1,
    reason: p.stop >= p.entry ? "ratcheted stop" : "stop loss", position: p, policyVersion: POLICY_VERSION };
  if (c.takeProfitX > 0 && p.entry > 0 && mark >= p.entry * c.takeProfitX)
    return { action: "sell", fraction: 1,
      reason: `take profit: ${(mark / p.entry).toFixed(2)}x at or above the ${c.takeProfitX}x rule`,
      position: p, policyVersion: POLICY_VERSION };
  if (c.honorDeskTarget !== false && p.target != null && mark >= p.target)
    return { action: "sell", fraction: 1, reason: "desk target hit", position: p, policyVersion: POLICY_VERSION };
  return { action: "hold", reason: "in trade", position: p, policyVersion: POLICY_VERSION };
}
