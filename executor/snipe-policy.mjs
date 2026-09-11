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
  /* THE OWNER'S UPSIDE EXIT: sell the whole position when the mark reaches N x entry.
   *
   * NAMED takeAtEntryX AND NOT takeProfitX ON PURPOSE, for two separate reasons.
   *
   * First, strategy.mjs DEFAULTS already owns a key called takeProfitX, and
   * test-snipe-separation.mjs clause 6 pins that these two namespaces share no key —
   * because one shared name is one dial that moves both lanes. A near-miss spelling
   * (takeProfitAtX) would pass that test and still read, to a human scanning two files,
   * as the same setting. So the name is different in kind, not in punctuation.
   *
   * Second, it states its own BASIS. The mark this lane works in is a round-trip
   * multiple: markX 1.0 already means "the sell returns what the buy paid at the venue".
   * "2x" against ENTRY is therefore what an owner means by doubling their money, but it
   * is NOT the realized return, because both legs of NETWORK fee sit outside the mark.
   * Realized = takeAtEntryX / frictionX - 1. At a 0.4 SOL ticket that is +99.5%; at the
   * frozen 0.005 SOL canary the SAME dial pays +63.6%, because friction there is 22% of
   * the position. The dial does not change; what it is worth changes with size, and
   * takeRealizedFrac() below exists so every surface prints the honest number. */
  takeAtEntryX: 2,
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

/**
 * WHAT A TAKE ACTUALLY PAYS, which is not what the dial says.
 *
 * The mark is a round-trip multiple at the VENUE; both legs of network fee sit outside
 * it. So a take at N x entry realizes N / frictionX - 1, and the gap between those two
 * numbers is entirely a function of position size:
 *
 *     0.400 SOL   frictionX 1.0025   a 2x take realizes  +99.50%
 *     0.050 SOL   frictionX 1.0202   a 2x take realizes  +96.04%
 *     0.005 SOL   frictionX 1.2222   a 2x take realizes  +63.64%
 *
 * This is the same class of error as arming a "breakeven" stop at 1.0x, which this file
 * already carries a scar from: a number that reads like profit and is not. Every surface
 * that shows the owner their take — the ceremony, the dashboard, the journal reason —
 * prints through here rather than repeating the dial back at them.
 */
export function takeRealizedFrac({ takeAtEntryX, frictionX: fx }) {
  const t = Number(takeAtEntryX), f = Number(fx);
  if (!Number.isFinite(t) || !Number.isFinite(f) || t <= 0 || f <= 0) return null;
  return t / f - 1;
}

/**
 * REFUSE A TAKE THAT IS INSIDE FRICTION, at config time, loudly.
 *
 * A take at or below frictionX is an instruction to sell at a loss the moment the
 * position is briefly up — the exact shape of the bug that shipped a "breakeven" at
 * entry and realized -18.18% on every position it claimed to protect. It is refused
 * rather than clamped: clamping would move the owner's number silently, and the whole
 * point of a dial is that the owner knows what it is set to.
 *
 * Returns the economics so the caller can PRINT them; throws only on a bad dial.
 */
export function assertTakeFundable({ takeAtEntryX, sizeSol, feeSolPerLeg,
  fallbackFrictionX = SNIPE_DEFAULTS.fallbackFrictionX } = {}) {
  const t = Number(takeAtEntryX);
  if (!Number.isFinite(t) || t <= 1)
    throw new Error(`takeAtEntryX must be a finite multiple above 1; got ${JSON.stringify(takeAtEntryX)}`);
  const measured = frictionX({ sizeSol, feeSolPerLeg });
  const fx = Number.isFinite(measured) && measured > 1 ? measured : Number(fallbackFrictionX);
  if (!(t > fx))
    throw new Error(
      `a take at ${t}x entry is INSIDE this fill's round-trip cost of ${fx.toFixed(4)}x — ` +
      `it would realize ${(takeRealizedFrac({ takeAtEntryX: t, frictionX: fx }) * 100).toFixed(2)}%, ` +
      "which is an instruction to sell at a loss on the way up. Raise the take or raise the size.");
  return Object.freeze({ frictionX: fx, realizedFrac: takeRealizedFrac({ takeAtEntryX: t, frictionX: fx }) });
}

/**
 * REFUSE A STOP THE POSITION CANNOT FUND, and refuse a FROZEN stop at a raised size.
 *
 * stopFrac 0.20 is not a risk appetite — it is the tightest stop a 0.005 SOL ticket can
 * carry under the desk's own fee rail, derived in the header above. At 0.4 SOL the
 * tightest FUNDABLE stop is 0.99x entry, so carrying 0.20 to a raised size means an 80%
 * drawdown before the stop speaks, on a position eighty times larger. That is not a
 * setting anyone chose; it is a default outliving the arithmetic that produced it.
 *
 * So: a size at or below the canary keeps the default silently, and any size above it
 * must state its stop explicitly. Fail-closed, and it makes the owner look at the number
 * — the same job LIVE_CAPS_ACK does for the caps.
 */
export const SNIPE_CANARY_SIZE_SOL = 0.005;

export function assertStopFundable({ stopFrac, sizeSol, explicit = false,
  feeReserveSol = 0.0005, maxFeeShareOfStop = 0.25 } = {}) {
  const s = Number(sizeSol), lvl = Number(stopFrac);
  if (!Number.isFinite(lvl) || lvl < 0 || lvl >= 1)
    throw new Error(`stopFrac must be a stop LEVEL in [0,1); got ${JSON.stringify(stopFrac)}`);
  const tightest = tightestFundableStopFrac({ sizeSol: s, feeReserveSol, maxFeeShareOfStop });
  if (tightest === null) throw new Error(`stopFrac needs a positive sizeSol; got ${JSON.stringify(sizeSol)}`);
  /* AN EPSILON, AND THE REASON FOR IT IS NOT TIDINESS. The tightest fundable level at the
     canary is computed as 1 - (2*0.0005)/(0.25*0.005) = 1 - 0.8, which in binary floating
     point is 0.19999999999999996. Without a tolerance this guard refuses SNIPE_DEFAULTS
     .stopFrac 0.20 at the very size it was derived for — the live configuration, rejected
     by its own fundability check. Caught by running it, not by reading it. */
  if (lvl > tightest + 1e-9)
    throw new Error(
      `a stop at ${lvl}x entry is TIGHTER than a ${s} SOL position can fund — the fee rail ` +
      `caps it at ${tightest.toFixed(4)}x. A tighter stop needs a larger position, not a smaller one.`);
  if (s > SNIPE_CANARY_SIZE_SOL && !explicit)
    throw new Error(
      `the default stop of ${lvl}x entry was derived for a ${SNIPE_CANARY_SIZE_SOL} SOL ticket; at ` +
      `${s} SOL it is a ${((1 - lvl) * 100).toFixed(0)}% drawdown before it speaks. Set the stop ` +
      `explicitly for this size (the tightest fundable here is ${tightest.toFixed(4)}x entry).`);
  return Object.freeze({ tightestFundableStopFrac: tightest, stopFrac: lvl });
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
  position, mark, nowMs, config = {}, creatorSold = false, rugFlag = false, hardStop = false,
  creatorSoldDetail = null,
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

  /* THE OPERATOR'S HAND, AND IT REACHES THE OPEN POSITION.
   *
   * Until 2026-09-11 the hard stop was an ENTRY gate only: snipe-lane.mjs read control()
   * inside handleNotice and never inside stepOne, so dropping the stop file stopped new
   * snipes and did precisely nothing to a position already held. That cost nothing while
   * nothing could be held. With a real bag it is the worst possible reading of a switch
   * whose whole purpose is to be understood correctly by a worried person at 3am.
   *
   * IT SELLS AT THE NEXT USABLE MARK, not blindly. The desk's hard stop freezes automatic
   * selling because the desk still has a desk behind it to decide; this lane has none, so
   * freezing it would mean the stop switch CREATES an unmanaged position — the opposite of
   * what the person dropping the file wants. But an unreadable mark is still not a sell
   * signal: `usable` is required here exactly as it is everywhere else in the fast half,
   * so a stop pressed during an RPC outage waits for a real price rather than firing into
   * the dark. */
  if (hardStop === true && usable) {
    return sell(1, "hard stop: the operator's switch is down — leaving at the next usable mark", next);
  }
  if (rugFlag) {
    return sell(1, "a chain fact turned hostile after entry — leaving on the fact, not the price", next);
  }
  /* The single most informative event in a launch, and it exists in no later market.
   *
   * THE REASON CARRIES WHAT WAS MEASURED, not what it is called. The caller detects this
   * by watching the deployer's token balance, and on chain a sale and a transfer to a
   * fresh wallet are indistinguishable — on a launch the second is the first with an extra
   * step. Calling it "sold" in the record would be a narrower claim than the evidence
   * supports, so the detail the caller measured is appended verbatim when it has one. */
  if (creatorSold) {
    return sell(1, "the creator is out — the one signal a launch has that no later market does" +
      (creatorSoldDetail ? `: ${creatorSoldDetail}` : ""), next);
  }
  /* THE OWNER'S TAKE, and the only exit on this lane that fires on good news.
   *
   * IT READS THE RAW MARK, like every other branch in the fast half, and the asymmetry
   * justifies it: a take fired on one corrupt print does not REALIZE that print — it
   * submits a sell, which fills at whatever the curve actually pays. So a false take
   * costs opportunity. A missed take, on a launch that round-trips 2x to 1x inside a
   * minute, costs the trade. Slow is the expensive failure here.
   *
   * IT SITS ABOVE THE TRAIL, which is also where it would fire chronologically: a
   * position reaching 2x passes the take on the way UP, before any high is confirmed
   * high enough for the trail to be following it down through the same level.
   *
   * AND IT REFUSES ITSELF rather than throwing when the dial is inside THIS fill's
   * friction. assertTakeFundable() refuses that at config time, but friction is a
   * property of the fill and not of the config, so a fill smaller than planned can
   * arrive under a take that was fundable when it was set. Declining to sell is safe;
   * a throw here would latch laneFaulted and strand an open position with no determiner. */
  const takeX = Number(cfg.takeAtEntryX);
  const takeIsFundable = Number.isFinite(takeX) && takeX > fx;
  if (takeIsFundable && usable && mark >= p.entry * takeX) {
    const realized = takeRealizedFrac({ takeAtEntryX: takeX, frictionX: fx });
    return sell(1, `take: ${takeX}x entry reached — realizes ${(realized * 100).toFixed(2)}% ` +
      `after a round-trip cost of ${fx.toFixed(4)}x`, next);
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
  /* A take the fill cannot fund must never be silent: it is the difference between "not
     there yet" and "this dial can never fire", and only one of those is worth waiting on. */
  const takeNote = takeIsFundable
    ? ` — take at ${takeX}x`
    : ` — TAKE DISABLED: ${JSON.stringify(cfg.takeAtEntryX)}x is inside this fill's ${fx.toFixed(4)}x round trip`;
  return hold(
    armed.length
      ? `holding — ${armed.join(" and ")} armed against a confirmed high of ${next.high} ` +
        `(breakeven is ${fx.toFixed(4)}x)${takeNote}`
      : `holding — nothing confirmed yet (breakeven is ${fx.toFixed(4)}x)${takeNote}`,
    next);
}
