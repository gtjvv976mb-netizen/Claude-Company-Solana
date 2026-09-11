/**
 * THE SNIPER'S OWN EXIT DETERMINER.
 *
 * The desk-led executor holds unconditionally: strategy.mjs stepPosition() returns
 * `{action:"hold"}` unless the DESK supplies a deskExit, and the shared pricePolicy is
 * reached only through that branch or desk-mirror.mjs. That is a deliberate owner
 * decision taken after a measured incident, and nothing here touches it.
 *
 * But a sniper has no desk. There is no time to think in a launch — the paid seats cost
 * ~$1.12 and many seconds — so the lane is deterministic and free, and it must therefore
 * carry its own exit. This module is that exit, kept in a SEPARATE FILE from
 * trade-policy.mjs on purpose: the desk path must remain byte-identical, and a shared
 * file is how a "small change for the sniper" becomes a change to how the desk exits.
 *
 * ── THE ASYMMETRY THAT RUNS THROUGH ALL OF IT ────────────────────────────────────────
 *
 * BE SLOW TO ARM, FAST TO EXIT.
 *
 * Arming breakeven or a trail is IRREVERSIBLE — the stops it sets can never come back
 * down — so it must never happen on a mark that was not real. Selling is not: the desk's
 * own note makes the point exactly right, that a sell executes at a REAL re-quoted price,
 * so acting on a bad mark costs a premature exit at the true market, never a manufactured
 * loss. Therefore every ARM here reads a CONFIRMED mark and every SELL reads the RAW one.
 *
 * ── WHY NOT THE DESK'S TWO-WITNESS RULE ──────────────────────────────────────────────
 *
 * trade-policy.mjs commits a new high only when the mark clears the old high on TWO
 * CONSECUTIVE ticks, taking the lower of the two. It exists for a real, measured reason:
 * a one-block WSOL-heavy pool read a sell quote rich at 1.9x, armed breakeven and the
 * trail on a position whose true price was 1.1x, and the next honest tick force-sold it
 * as a ratcheted stop. That rule is correct where it lives, and its own justification
 * says so: "the trail is 25%, a 15s tick costs it nothing."
 *
 * It is the wrong ruler HERE, and the reason is worth stating precisely rather than
 * retuning it by feel. The rule conflates two different things:
 *
 *     (a) confirming that a mark is REAL, and
 *     (b) waiting a fixed number of CONSECUTIVE ticks.
 *
 * Only (a) is the safety property. (b) is an implementation of it that happens to be
 * free when a tick is 15 seconds and a hold is hours.
 *
 * BE PRECISE ABOUT WHAT ACTUALLY BREAKS, because the sloppy version of this argument
 * would justify arming on one print. A genuinely single-observation run arms under
 * NEITHER rule, and it should not: one print is not confirmation, and that is the whole
 * incident. What breaks is INTERLEAVED prints. A launch quotes irregularly across two
 * pools, so a real run reads 5.0, 1.0, 5.0 far more often than it reads 5.0, 5.0 — and
 * "two CONSECUTIVE clearing ticks" rejects the first sequence while accepting the second,
 * though both contain two independent observations of the same high. The rule that
 * protects the desk from a glitch therefore drops real runs in this lane while leaving
 * every loser intact. That is not conservatism; it is a biased ruler.
 *
 * SO CONFIRMATION HERE IS A ROLLING MEDIAN, NOT A RUN OF CONSECUTIVE TICKS. The high-water
 * candidate is the median of the last `confirmWindow` observations (default 3). It keeps
 * the safety property exactly — a lone spike between ordinary ticks cannot move a median,
 * so it commits nothing, which is the incident the desk's rule was written for — while
 * dropping the requirement that the clearing ticks be consecutive. It also has three
 * properties the consecutive rule does not:
 *
 *   - it accepts two independent observations whether or not they are adjacent, which is
 *     the actual failure above, while still rejecting any lone outlier;
 *   - it is tick-rate agnostic: it behaves the same at 200ms and at 15s;
 *   - it degrades honestly on a short history (fewer than `confirmWindow` marks confirms
 *     nothing, so a position that has just opened cannot arm on its first print);
 *   - it needs no notion of "consecutive", which is meaningless when marks arrive from a
 *     stream at irregular intervals.
 *
 * The desk's recorded incident is a test case here, not a footnote: t1 glitch 1.9 then t2
 * real 1.1 must arm nothing. test-snipe-policy.mjs drives exactly that sequence.
 *
 * ── AND THE TRIGGER THE DESK DOES NOT HAVE ───────────────────────────────────────────
 *
 * A launch has one signal no later market does: THE CREATOR SELLING. Nothing else on a
 * one-minute-old coin is as informative, and it is observable — the deployer's wallet is
 * known at t=0. `creatorSold` is a first-class trigger here and it outranks everything
 * except the hard stop.
 *
 * PURE. No I/O, no provider, no clock of its own, no mutation of its argument. Everything
 * it needs arrives as arguments, which is what makes the whole thing testable against
 * sequences whose right answer is known in advance.
 */

export const SNIPE_POLICY_VERSION = "snipe-v1";

/**
 * THE ROUND TRIP IS THE DOMINANT TERM AT LIVE SIZE, AND IT REWRITES TWO DEFAULTS.
 *
 * Measured against the repo's own frozen rails, not chosen:
 *   LIVE_LIMITS.maxSolPerTrade        = 0.005   SOL   (poller.mjs:155)
 *   expectedNetworkFeeLamports        = 500_000       (poller.mjs:199) = 0.0005 SOL
 *
 * So a live position pays 0.0005 SOL to get in and again to get out: 0.001 SOL of
 * friction on a 0.005 SOL position. TWENTY PERCENT, round trip.
 *
 * TWO CONSEQUENCES, both of which broke the first version of this file:
 *
 * 1. THE STOP CANNOT BE TIGHT, BECAUSE A TIGHT ONE CANNOT BE FUNDED.
 *    strategy.mjs minViableSolPerTrade() caps fees at maxFeeShareOfStop (0.25) of the
 *    STOP DISTANCE, so a tighter stop demands a LARGER position to stay inside that
 *    share. Bisected against the real function: the tightest stop distance a 0.005 SOL
 *    position can carry is 0.80 — a stop at 0.20x entry. A stop at 0.70x entry needs
 *    0.0133 SOL, which is 2.7x the live cap, so it is not fundable at all.
 *    THEREFORE THE PRICE STOP HERE IS A CATASTROPHE BACKSTOP, NOT A RISK CONTROL. The
 *    real controls on this lane are the clock, the structural tripwires (creator sold,
 *    hostile chain fact, collapsed sell side) and the size. Do not "tighten the stop"
 *    to feel safer; it makes the position unfundable, which is not the same as safe.
 *
 * 2. "BREAKEVEN" IS NOT 1.0x. Selling at entry realises (s-f)/(s+f) - 1 = -18.18% at
 *    live size. The true breakeven multiple is (size + fee) / (size - fee) = 1.2222x,
 *    and it MOVES with fill size and observed fee, so it is computed per position by
 *    frictionX() rather than stored as a constant. The first version of this file armed
 *    a stop at entry and called it breakeven; it would have realised an 18% loss on
 *    every position it "protected".
 */
export const SNIPE_DEFAULTS = Object.freeze({
  /* A stop at 0.20x entry. Wide because the fee rail forces it — see above. */
  stopFrac: 0.20,
  /* Multiple of entry at which the stop is lifted to TRUE breakeven. Expressed as a
     multiple of frictionX, not of entry: arming below friction arms a loss. */
  armBreakevenAtFrictionX: 1.15,
  /* Multiple of frictionX at which a trailing stop starts following the confirmed high. */
  armTrailAtFrictionX: 1.30,
  /* Used only when the caller supplies no fill economics. It is the live-cap friction
     (0.005 SOL at a 0.0005 SOL fee each way) and is deliberately NOT 1.0: a default of
     1.0 is the bug this constant exists to prevent. */
  fallbackFrictionX: 1.2222,
  /* How far below the confirmed high the trail sits. */
  trailFrac: 0.25,
  /* A sniper must not become a bag holder by inaction. If none of the triggers has
     fired by here, leave: the thesis of a launch entry is measured in minutes, and a
     position still open long after has stopped being the trade that was entered. */
  timeStopMs: 10 * 60_000,
  /* Observations used to confirm an irreversible arm. Three is the smallest window in
     which a single outlier cannot move the median. */
  confirmWindow: 3,
  /* A sell quote that has collapsed relative to the buy side is the shape of a honeypot
     or a pulled pool. Expressed as a fraction of the mark the position was entered at. */
  liquidityFloorFrac: 0.10,
});

/**
 * THE TRUE BREAKEVEN MULTIPLE for a fill: what the mark must reach for the position to
 * return what it cost, once both legs of network fee are paid.
 *
 *   proceeds(m) = size*m - fee        outlay = size + fee
 *   breakeven   => m = (size + fee) / (size - fee)
 *
 * At live size (0.005 SOL, 0.0005 SOL a leg) that is 1.2222x. A fill so small that the
 * fee equals or exceeds it has NO breakeven multiple, and that is reported as Infinity
 * rather than as a number that would let the caller arm something.
 */
export function frictionX({ sizeSol, feeSolPerLeg }) {
  const s = Number(sizeSol), f = Number(feeSolPerLeg);
  if (!Number.isFinite(s) || !Number.isFinite(f) || s <= 0 || f < 0) return null;
  if (s <= f) return Infinity;
  return (s + f) / (s - f);
}

/**
 * The tightest stop DISTANCE a given position size can carry under the desk's own fee
 * rail, by inversion of strategy.mjs minViableSolPerTrade():
 *   minViable = 2*feeReserve / (maxFeeShareOfStop * stopDistance)  <=  size
 * Returned as the stop LEVEL (fraction of entry), which is what this module uses.
 */
export function tightestFundableStopFrac({ sizeSol, feeReserveSol = 0.0005, maxFeeShareOfStop = 0.25 }) {
  const s = Number(sizeSol);
  if (!Number.isFinite(s) || s <= 0) return null;
  const distance = (2 * feeReserveSol) / (maxFeeShareOfStop * s);
  if (!Number.isFinite(distance) || distance >= 1) return 0;   // nothing is fundable
  return 1 - distance;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A fresh position. `marks` is the confirmation window's rolling history. */
export const freshSnipe = ({ entry, openedAt, creator = null,
  sizeSol = null, feeSolPerLeg = null }) => Object.freeze({
  entry: Number(entry),
  openedAt: Number(openedAt),
  creator,
  /* The fill's own economics, so breakeven is this position's breakeven and not a
     constant that was true of some other fill. Null means the caller did not supply
     them and the conservative fallback is used. */
  sizeSol: sizeSol === null ? null : Number(sizeSol),
  feeSolPerLeg: feeSolPerLeg === null ? null : Number(feeSolPerLeg),
  high: 0,              // the CONFIRMED high-water, never lowered
  marks: [],            // rolling raw observations, newest last
  armedBreakeven: false,
  armedTrail: false,
  policyVersion: SNIPE_POLICY_VERSION,
});

const sell = (fraction, reason, position) =>
  ({ action: "sell", fraction, reason, position, policyVersion: SNIPE_POLICY_VERSION });
const hold = (reason, position) =>
  ({ action: "hold", fraction: 0, reason, position, policyVersion: SNIPE_POLICY_VERSION });

/**
 * Decide what to do with an open sniped position.
 *
 * @param {object}  position    from freshSnipe(), never mutated
 * @param {number}  mark        the raw observation now, in the same units as `entry`
 * @param {number}  nowMs       caller's clock
 * @param {object}  config      SNIPE_DEFAULTS patch
 * @param {boolean} creatorSold the deployer has sold, if known
 * @param {boolean} rugFlag     a chain fact turned hostile since entry (authority
 *                              appeared, pool pulled) — the caller's determination
 */
export function snipePolicy({
  position, mark, nowMs, config = {}, creatorSold = false, rugFlag = false,
} = {}) {
  const cfg = { ...SNIPE_DEFAULTS, ...config };
  const p = position;
  if (!p || !(p.entry > 0)) throw new Error("snipePolicy: a position with an entry is required");

  /* This position's own breakeven multiple. Every arm and the breakeven stop are
     expressed against it, so a change in fill size or fee moves them together. */
  const measured = frictionX({ sizeSol: p.sizeSol, feeSolPerLeg: p.feeSolPerLeg });
  const fx = Number.isFinite(measured) && measured > 1 ? measured : cfg.fallbackFrictionX;

  /* A mark that is not a usable number decides nothing. It is not an exit signal — an
     unreadable price is the absence of information, not bad news — and it must not enter
     the confirmation window, where it would corrupt the median. */
  const usable = Number.isFinite(mark) && mark > 0;
  const marks = usable ? [...p.marks, Number(mark)].slice(-cfg.confirmWindow) : p.marks;
  const next = { ...p, marks };

  /* ── THE FAST HALF: every one of these reads the RAW mark and needs no confirmation.
     Being wrong here costs a premature exit at the true market. Being slow here costs
     the position. ─────────────────────────────────────────────────────────────────── */

  if (rugFlag) {
    return sell(1, "a chain fact turned hostile after entry — leaving on the fact, not the price", next);
  }
  /* The single most informative event in a launch, and it exists in no later market. */
  if (creatorSold) {
    return sell(1, "the creator sold — the one signal a launch has that no later market does", next);
  }
  if (usable && mark <= p.entry * cfg.liquidityFloorFrac) {
    return sell(1, `the sell side has collapsed to ${(cfg.liquidityFloorFrac * 100).toFixed(0)}% of entry — pulled or unsellable`, next);
  }
  if (usable && mark <= p.entry * cfg.stopFrac) {
    return sell(1, `stop: ${(cfg.stopFrac * 100).toFixed(0)}% of entry`, next);
  }
  /* AT frictionX, NOT AT ENTRY. Selling at entry returns less than the position cost,
     because both legs of network fee are already spent. At live size that error is
     -18.18%, and calling it "breakeven" is what makes it dangerous. */
  if (p.armedBreakeven && usable && mark <= p.entry * fx) {
    return sell(1, `breakeven stop at ${fx.toFixed(4)}x entry — the true round-trip cost, not 1.0x`, next);
  }
  if (p.armedTrail && p.high > 0 && usable && mark <= p.high * (1 - cfg.trailFrac)) {
    return sell(1, `trailing stop: ${(cfg.trailFrac * 100).toFixed(0)}% below a confirmed high of ${p.high}`, next);
  }
  /* Inaction is a decision, and on a launch it is usually the wrong one. */
  if (nowMs - p.openedAt >= cfg.timeStopMs) {
    return sell(1, `time stop at ${Math.round(cfg.timeStopMs / 1000)}s — the entry thesis has expired`, next);
  }

  /* ── THE SLOW HALF: arming is irreversible, so it reads a CONFIRMED mark.
     Fewer than `confirmWindow` observations confirms nothing, which is why a position
     cannot arm on its own first print. ────────────────────────────────────────────── */

  if (marks.length >= cfg.confirmWindow) {
    const confirmed = median(marks);
    if (confirmed > next.high) next.high = confirmed;

    /* Arming below friction arms a loss, so both thresholds are multiples of fx. */
    if (!next.armedBreakeven && next.high >= p.entry * fx * cfg.armBreakevenAtFrictionX) {
      next.armedBreakeven = true;
    }
    if (!next.armedTrail && next.high >= p.entry * fx * cfg.armTrailAtFrictionX) {
      next.armedTrail = true;
    }
  }

  const armed = [next.armedBreakeven && "breakeven", next.armedTrail && "trail"].filter(Boolean);
  return hold(
    armed.length
      ? `holding — ${armed.join(" and ")} armed against a confirmed high of ${next.high} ` +
        `(breakeven is ${fx.toFixed(4)}x)`
      : `holding — nothing confirmed yet (breakeven is ${fx.toFixed(4)}x)`,
    next);
}
