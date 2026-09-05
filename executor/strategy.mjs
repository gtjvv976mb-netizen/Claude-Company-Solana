/**
 * THE RISK ENGINE — pure decision logic for the Claude Company executor.
 *
 * Deliberately free of network, wallet and clock: every input is passed in and
 * every output is a plain intent ({action, reason, ...}). That is what makes it
 * simulatable — simulate.mjs runs this exact code over tens of thousands of
 * synthetic price paths, so the numbers you see are produced by the same
 * function shared with the server and executor, not by a separate toy model.
 *
 * WHAT THIS ENGINE DECIDES, and what it deliberately no longer decides:
 *   ENTRY SIZING — risk-at-stop, the Kelly rails, the fee floors, the book heat and
 *   the two portfolio brakes (DAILY LOSS LIMIT and MAX CONCURRENT POSITIONS) that
 *   decide whether a bot survives a bad week. All of that is still here, untouched.
 *
 *   EXITS — none of its own. Until desk-led-v4 (2026-09-05) this file ran a full
 *   bracket on every held position: a local stop, a 1.35x breakeven and 1.5x/25%
 *   trail ratchet, a 2x take-profit, the authored target, a band clock and an age
 *   exit, each on the bot's OWN ruler (a chain-simulated Jupiter sell quote against
 *   its own fill) and the bot's OWN clock (every poll, two witnesses). The desk ran
 *   the same policy on ITS ruler (DexScreener consensus vs entry_ref) and ITS clock.
 *   Two engines that agree on levels and disagree on moments: Shrek, call 55 — the
 *   bot sold 03:01:42Z on its own normalised stop at -13.5%; the desk's determined
 *   stop_hit came 03:10:24Z, and the desk's exit row arrived to a position that no
 *   longer existed. The owner's rule is verbatim: "all exits should be followed not
 *   after or before, but as exactly as it was determined."
 *
 *   So stepPosition HOLDS unless the desk has published an exit for this call, and
 *   then it sells everything (DESK EXIT — the desk knows things the price alone does
 *   not: creator sold, LP pulled, thesis dead). The pure pricePolicy still exists in
 *   trade-policy.mjs, shared byte-for-byte with the desk's evaluateExit; the bot runs
 *   it only in MIRROR mode (executor/desk-mirror.mjs) when the desk has been
 *   unreachable for DESK_UNREACHABLE_MS, on the desk's absolute levels with the
 *   desk's ruler, so that the determination is still the desk's even when the desk
 *   cannot speak.
 *
 * None of this manufactures an edge — the edge is the quality of the desk's
 * calls. This engine exists so a real edge is not destroyed by one bad night,
 * and so a bad streak cannot compound into a blown account.
 */
import { POLICY_DEFAULTS, POLICY_VERSION, pricePolicy } from "./trade-policy.mjs";

export { POLICY_VERSION };

export const DEFAULTS = {
  maxSolPerTrade: 0.05,      // hard ceiling; Kelly may size well under it
  dailySolCap: 0.5,          // total SOL deployed per rolling day
  dailyLossLimitSol: 0.15,   // realized losses that stop new entries for the day
  maxOpenPositions: 24,      // a sentinel; risk decides, not a count (see poller LIVE_LIMITS)

  /* ── SIZING: risk-at-stop, not notional ──────────────────────────────────
     Adopted from the GROKSTREET operating thesis. f is the fraction of equity
     lost IF THE STOP HITS — never the amount deployed. Every rail here exists
     because raw Kelly on a short sample is a drawdown machine: at a 77% claimed
     hit rate and R=1.25, full Kelly wants 59% of equity on one stop.

       R_net = (target - costs) / (stop + costs)
       W_min = 1 / (1 + R_net)          — below this, the trade is -EV, skip it
       f*    = W - (1 - W) / R_net
       f     = clip(kappa * f*, 0, fNameMax), or fDefault while n < nMin  */
  costPct: 0.06,             // round-trip: slippage both ways, spread, priority fee
  kappa: 0.5,                // half-Kelly. Full Kelly is a coin-flip away from ruin

  /* THESE TWO ARE DELIBERATELY LOOSER THAN THE THESIS PRESCRIBES, and the reason
     is arithmetic, not courage. Priority fees are a FIXED ~0.0004 SOL per round
     trip, so on a small wallet a textbook 0.75% risk produces a position the fees
     eat: at 0.32 SOL equity that is 0.0063 SOL of position and 6.3% in fees.
     Raising the risk fraction is the only lever that makes a small book tradeable
     at all — it buys the closed sample the engine needs before Kelly is even
     allowed to fire. It is a real loosening of the rails: 2% of equity per name
     rather than 0.75%. Dial back toward 0.0075 as equity grows, or set
     F_DEFAULT / F_NAME_MAX in the environment. */
  fNameMax: 0.025,           // most equity one name may risk at its stop
  fDefault: 0.02,            // what to risk while the sample is too small to trust
  nMin: 12,                  // closed trades before an estimated W is usable at all
  /* TOTAL RISK ACROSS THE BOOK — and the number that actually decided how many
     memecoins could run at once. With the position count removed, this bound the book
     at 5. Measured at the live 0.3366 SOL wallet: 8% allows 5 positions, 16% allows 10,
     and 24% allows 14 — at which point the WALLET saturates and raising it further
     changes nothing, which is what makes 24% the landing point rather than a taste.
     Worst case if every position stopped out at once is 0.071 SOL, under half the
     0.15 SOL rolling realized-loss brake the owner already runs. Note memecoins are
     correlated: this is the control for all of them dumping together, which is the
     other half of "they all pump together". */
  /* Matched to the loss brake below, deliberately. A book allowed to carry MORE risk
     than the day is allowed to lose is incoherent: it would guarantee tripping the
     brake if the book stopped out together, which for correlated memecoins is the
     normal case rather than the tail. At 20% the live 0.3366 SOL wallet supports about
     twelve simultaneous positions, against four before. */
  bookHeatMax: 0.20,         // sum of f across open positions — correlated names share it
  /* Stop for the day after losing this share of the bankroll. Applied as the TIGHTER of
     this and dailyLossLimitSol, so it can only ever brake sooner. */
  dailyLossPctOfEquity: 0.20,
  maxAgeHours: POLICY_DEFAULTS.maxAgeHours,
  // Kept as a compatibility field for old env/config files. Snipe-v2 never emits
  // sell_part: the authored target and configured multiple both close in full.
  scaleOutPct: 0,
  trailPct: POLICY_DEFAULTS.trailPct,
  honorDeskTarget: POLICY_DEFAULTS.honorDeskTarget,
  stopBufferPct: 0,          // widen the desk's stop by this much (0 = obey exactly)
  /* SNIPE-HOLD-SELL: take the whole position at this multiple of entry. 2 = sell at a
   * double. Checked before the trail arms, so a trail can never intercept the double
   * first. Set to 0 to disable and ride the trail instead. */
  takeProfitX: POLICY_DEFAULTS.takeProfitX,
  /* THE FIXED FUND: the operator's per-trade CEILING (0 = size by Kelly/flat risk).
   * It bounds how much is ever bet on one call; the risk rails below may size UNDER
   * it, and Kelly's skip verdicts still decide whether to bet at all. */
  fixedSol: 0.02,
  /* THE SMALLEST SHARE OF THE CEILING THE TEAM'S CONFIDENCE CAN REDUCE A TRADE TO.
   * Live conviction runs 20-51 out of 100, so an unfloored scale would put almost
   * every trade at a fifth of size and the fees would eat the book. */
  convictionFloor: 0.35,
  /* The most of the STOP DISTANCE the round trip's network fees may be. Judged against
     the risk taken rather than the position, so a wide stop may carry more fee in
     absolute terms and still be worth taking — see the note in planEntry. */
  maxFeeShareOfStop: 0.25,
  /* The smallest position worth opening at all: below this the round trip is mostly
   * fees, so the trade is refused rather than sized into noise. */
  minSolPerTrade: 0.005,
};

/** Should we take this entry at all, and at what size? */
export function planEntry({ call, cfg = DEFAULTS, state }) {
  const c = { ...DEFAULTS, ...cfg };
  if (state.openCount >= c.maxOpenPositions)
    return { action: "skip", reason: `already holding ${state.openCount} of max ${c.maxOpenPositions}` };
  /* THE BRAKE IS A SHARE OF THE BANKROLL, NOT ONLY A NUMBER OF SOL.
   *
   * Owner's rule: stop for the day after losing 20% of the original SOL. An absolute
   * figure goes stale the moment the wallet changes — 0.15 SOL was 45% of the live
   * 0.3366 SOL balance, which is a far looser brake than intended — so the effective
   * brake is whichever is TIGHTER: the operator's absolute cap, or the percentage.
   * Taking the minimum means this can only ever stop trading sooner, never later, and
   * an operator lowering the absolute cap still wins. */
  const equityBrake = Number(c.dailyLossPctOfEquity) > 0 && Number(state.equitySol) > 0
    ? Number(c.dailyLossPctOfEquity) * Number(state.equitySol)
    : Infinity;
  const lossBrake = Math.min(Math.abs(c.dailyLossLimitSol), equityBrake);
  if (state.realizedTodaySol <= -lossBrake)
    return { action: "skip",
      reason: `rolling 24h realized-loss entry brake hit (${state.realizedTodaySol.toFixed(3)} of ` +
        `${lossBrake.toFixed(4)} SOL — ${equityBrake < Math.abs(c.dailyLossLimitSol)
          ? `${(Number(c.dailyLossPctOfEquity) * 100).toFixed(0)}% of a ${Number(state.equitySol).toFixed(4)} SOL bankroll`
          : "the operator's absolute cap"})` };

  // A call with no stop cannot be risk-managed; refuse it rather than hold
  // something with no floor under it.
  if (call.stop == null || !(Number(call.stop) > 0))
    return { action: "skip", reason: "call has no stop — refusing an unmanageable position" };

  // ── the bracket, as fractions of entry ──
  const entry = Number(call.entry_ref) > 0 ? Number(call.entry_ref) : 1;
  const stopFrac = (entry - Number(call.stop)) / entry;
  const targetFrac = call.target != null ? (Number(call.target) - entry) / entry : null;
  if (!(stopFrac > 0)) return { action: "skip", reason: "stop is at or above entry" };
  const observedFriction = Math.max(0, Number(c.measuredRoundTripLossPct) || 0) / 100;
  const effectiveStopFrac = Math.min(1, stopFrac + observedFriction);

  // ── R_net, with costs on BOTH sides. A bracket that looks like 1.25R gross is
  //    often under 1.0 once the round trip is paid for. ──
  const cost = c.costPct;
  const rNet = targetFrac != null ? (targetFrac - cost) / (stopFrac + cost) : null;
  if (rNet != null && !(rNet > 0))
    return { action: "skip", reason: `costs eat the target: R_net ${rNet.toFixed(2)}` };

  // ── the break-even hit rate this bracket demands ──
  const wMin = rNet != null ? 1 / (1 + rNet) : null;
  const n = (state.wins ?? 0) + (state.losses ?? 0);
  const W = n > 0 ? (state.wins ?? 0) / n : null;

  // ── Kelly, then the rails. Below nMin closed trades an estimated W is noise,
  //    so we ignore it entirely and risk a small constant instead. ──
  let f, why;
  if (n < c.nMin || W == null || rNet == null) {
    f = c.fDefault;
    why = `small sample (n=${n}) — flat ${(f * 100).toFixed(2)}% risk`;
  } else if (W <= wMin) {
    return { action: "skip",
      reason: `hit rate ${(W * 100).toFixed(0)}% is under the ${(wMin * 100).toFixed(0)}% this bracket needs` };
  } else {
    const fStar = W - (1 - W) / rNet;
    f = Math.max(0, Math.min(c.kappa * fStar, c.fNameMax));
    why = `half-Kelly ${(f * 100).toFixed(2)}% (W ${(W * 100).toFixed(0)}%, R_net ${rNet.toFixed(2)})`;
  }

  // ── translate risk into position size, then obey the flat caps ──
  const equity = state.equitySol ?? c.dailySolCap;
  if (!Number.isFinite(Number(equity)) || Number(equity) <= 0)
    return { action: "skip", reason: "equity is unavailable for risk sizing" };
  const feeReserve = Math.max(0, Number(c.networkFeeReserveSol) || 0);
  const heat = state.bookHeat ?? 0;

  /* THE TEAM'S OWN CONFIDENCE, PRICED INTO THE SIZE.
   *
   * Every call already carries the desk's conviction out of 100, and the bot had never
   * once read it — the feed sends it, and nothing here looked. The owner's rule is
   * "more risk, less size", and the team's uncertainty IS risk, so a call the desk is
   * lukewarm about gets a smaller position than one it argues for.
   *
   * Floored deliberately. Live conviction runs 20 to 51 out of 100, so an unfloored
   * scale would put nearly every trade at a fifth of size, where the round trip is
   * mostly fees. A call with no conviction stated is not scaled at all — the desk's
   * silence is not evidence, and the rails below still bound it. */
  /* THE SMALLEST POSITION WORTH OPENING, in SOL rather than as a fraction.
   *
   * Network fees are fixed per trade, so below this size the round trip costs more than
   * maxFeeShareOfTrade of the position and the trade is mostly fees. It is hoisted here
   * because it must bound EVERY sizing path, not only the conviction haircut: the risk
   * rails could still clamp a position under it, and then the fee share exceeded what
   * the desk assumes when it decides whether to publish a call at all. That gap broke
   * the contract the desk and the executor are supposed to keep — the desk published a
   * 16% stop on a rough coin and the bot refused it, because the rails had sized to
   * 0.0309 SOL where fees are 3.2% rather than the 2.5% the desk had assumed.
   *
   * With the floor applied everywhere, a trade the executor takes ALWAYS costs at most
   * maxFeeShareOfTrade in fees, which is exactly what the desk assumes. What remains is
   * not a disagreement but a money fact: a wallet too small to fund a viable position
   * gets a refusal, and no cost model can wish that away. */
  /* FEES ARE JUDGED AGAINST THE RISK BEING TAKEN, NOT AGAINST THE TRADE.
   *
   * A flat share of the position was wrong in both directions. It let a 5% stop pay 2.5%
   * in fees — half the whole stop — while refusing a 30% stop that could comfortably
   * carry more, because the per-name risk cap correctly sizes a wide-stop position
   * SMALLER and that pushed it under a fixed floor. Measured at the live 0.3366 SOL
   * wallet: 20%, 30% and 38% stops all refused at 0.0337, 0.0232 and 0.0185 SOL — the
   * exact calls the desk had just been fixed to publish.
   *
   * So the cap is a share of the STOP. Fees may be at most maxFeeShareOfStop of the
   * distance being risked, which is the ratio that actually decides whether costs eat
   * the trade: a quarter of a 10% stop is 2.5%, a quarter of a 30% stop is 7.5%, and
   * the minimum viable size falls as the stop widens instead of rising. */
  const stopForFees = Math.max(effectiveStopFrac, 0.01);
  const feeFloorSol = feeReserve > 0 && c.maxFeeShareOfStop > 0
    ? (2 * feeReserve) / (c.maxFeeShareOfStop * stopForFees)
    : 0;

  const conviction = Number(call.conviction);
  const convictionScale = Number.isFinite(conviction) && conviction > 0
    ? Math.max(c.convictionFloor, Math.min(1, conviction / 100))
    : 1;

  /* THE CEILING, then the rails. `fixedSol` is what the OPERATOR permits on one trade,
   * not an instruction to bet exactly that: the risk rails may size under it and never
   * over it. Kelly's own skip verdicts above still decide WHETHER to bet. */
  let want = (f * equity) / effectiveStopFrac;
  if (c.fixedSol > 0) { want = c.fixedSol; why = `operator ceiling ${c.fixedSol} SOL`; }
  want = Math.min(want, c.maxSolPerTrade);
  if (call.size_sol != null) want = Math.min(want, Number(call.size_sol));
  if (convictionScale < 1) {
    /* SCALING DOWN STOPS HELPING ONCE FEES DOMINATE.
     *
     * Network fees are FIXED per trade, so halving the position doubles them as a share
     * of it. Measured against the desk's eight most recent published calls: at the full
     * 0.05 SOL the fee is 2.0% of the trade and four were tradeable; scaled to 0.0175
     * by a conviction of 30 the fee becomes 5.7% and only ONE was. Shrinking the
     * position did not reduce risk — it converted the trade into fees and then failed
     * the executor's own cost guard.
     *
     * So conviction may scale down only to the point where the round trip still costs
     * less than maxFeeShareOfTrade. Below that a smaller trade is strictly worse: the
     * same lamports of fee against less upside. This does not overrule the owner's
     * "more risk, less size" — it stops that rule running past the point where it
     * inverts. */
    const scaled = want * convictionScale;
    if (scaled >= feeFloorSol) {
      want = scaled;
      why += `; conviction ${conviction}/100 sizes to ${(convictionScale * 100).toFixed(0)}%`;
    } else if (want > feeFloorSol) {
      want = feeFloorSol;
      why += `; conviction ${conviction}/100 would size to ${scaled.toFixed(4)} SOL, held at ` +
        `${feeFloorSol.toFixed(4)} where fees are ${(c.maxFeeShareOfTrade * 100).toFixed(1)}% of the trade`;
    }
    // If even the ceiling is under the fee floor, leave it alone — the rails below and
    // the minimum-size check decide, and they already refuse a position of pure fees.
  }

  /* SIZE DOWN TO EACH RAIL RATHER THAN REFUSING THE CALL.
   *
   * Every one of these was a `return skip`, so a fixed size one basis point over the
   * per-name risk cap threw the whole trade away instead of buying slightly less —
   * measured in the live log as "SKIP NATIX: actual stop risk 3.22% exceeds per-name
   * cap 2.50%", which is a trade the bot could have taken at 78% of the size. Refusing
   * on size is only correct when NO size fits, and that is the one case still refused
   * below. Clamping is strictly the safer direction: every rail here can only make the
   * position smaller, never larger, and the operator's ceiling is applied above. */
  let boundBy = null;
  const bind = (limitSol, label) => {
    if (Number.isFinite(limitSol) && limitSol < want) { want = limitSol; boundBy = label; }
  };
  // Per-name stop risk: want * stopFrac + both fees <= fNameMax * equity.
  bind((c.fNameMax * equity - 2 * feeReserve) / effectiveStopFrac, `per-name risk cap ${(c.fNameMax * 100).toFixed(2)}%`);
  // Aggregate book heat, on the room this call actually has left.
  bind(((c.bookHeatMax - heat) * equity - 2 * feeReserve) / effectiveStopFrac,
    `book heat (${(heat * 100).toFixed(1)}% of ${(c.bookHeatMax * 100).toFixed(0)}% used)`);
  bind(c.dailySolCap - state.deployedTodaySol - feeReserve,
    `rolling 24h deploy cap (${state.deployedTodaySol.toFixed(3)}/${c.dailySolCap} SOL)`);
  if (state.spendableSol != null) bind(state.spendableSol - feeReserve, "spendable balance after the fee reserve");

  /* The floor is the LARGER of the configured minimum and the size at which fees stop
     dominating. A position under it is not a smaller bet, it is the same fees against
     less upside — and it is the case the desk cannot see when it publishes. */
  const minSize = Math.max(0.0005, Number(c.minSolPerTrade) || 0, feeFloorSol);
  if (!(want >= minSize))
    return { action: "skip",
      reason: boundBy
        ? `${boundBy} leaves ${Math.max(0, want).toFixed(4)} SOL, under the ${minSize.toFixed(4)} SOL minimum ` +
          `(below it the round trip is mostly fees)`
        : "the sized position rounds to nothing" };

  const actualF = (want * effectiveStopFrac + 2 * feeReserve) / Number(equity);
  if (!Number.isFinite(actualF) || actualF < 0)
    return { action: "skip", reason: "actual risk fraction is invalid" };
  /* The rails above already bound this, so a breach here would mean the arithmetic
     disagrees with itself. Refuse rather than trust it. */
  if (actualF > c.fNameMax + 1e-9)
    return { action: "skip", reason: `actual stop risk ${(actualF * 100).toFixed(2)}% exceeds per-name cap ${(c.fNameMax * 100).toFixed(2)}%` };
  if (heat + actualF > c.bookHeatMax + 1e-9)
    return { action: "skip", reason: `book heat ${(heat * 100).toFixed(1)}% + ${(actualF * 100).toFixed(1)}% exceeds ${(c.bookHeatMax * 100).toFixed(0)}%` };

  return { action: "buy", sol: want, f: actualF, estimatedF: f, rNet, wMin,
    convictionScale, boundBy,
    reason: `${why}${boundBy ? `; sized down by ${boundBy}` : ""}; actual stop risk ${(actualF * 100).toFixed(2)}%` };
}

/** Fresh position record, created after a fill.
 *
 * Two families of numbers live on it. The RATIO fields (entry=1, stop, target, high)
 * are dimensionless off the bot's own fill and remain for VALUATION — heartbeat, monitor,
 * the board's P&L. The DESK fields (deskEntryRef, deskStop, deskTarget, deskOpenedAt)
 * are the desk's ABSOLUTE USD levels and the desk's clock, copied verbatim from the
 * feed's entry event at fill time; they exist so mirror mode can evaluate exactly the
 * levels the desk would have evaluated, never a ratio off our fill. A caller may pass
 * them explicitly (desk* keys) or let them fall out of the raw feed event's entry_ref /
 * opened_at / ts. */
export function openPosition({ call, sol, fillPrice, cfg = DEFAULTS }) {
  const c = { ...DEFAULTS, ...cfg };
  const stop = Number(call.stop) * (1 - c.stopBufferPct);
  const positive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    mint: call.mint, symbol: call.symbol,
    entry: fillPrice, sol, qty: sol / fillPrice,
    stop, initialStop: stop,
    target: call.target != null ? Number(call.target) : null,
    high: fillPrice, scaled: false, openedAt: call.ts ?? 0,
    openedAtMs: call.openedAtMs ?? Date.now(),
    /* THE BAND'S CLOCK, carried from the call. Null on a legacy call or an unreadable
       market cap. The bot itself never acts on it any more — the desk does, and the
       mirror does when the desk cannot — but it travels with the position so both of
       those evaluate the window the call was published with. */
    holdBand: call.hold_band ?? call.holdBand ?? null,
    holdMaxMs: Number(call.hold_max_ms ?? call.holdMaxMs) > 0
      ? Number(call.hold_max_ms ?? call.holdMaxMs) : null,
    /* THE DESK'S OWN LEVELS, absolute, for the mirror. entry_ref here is the desk's
       (a caller normalising the bracket to ratios passes the raw values as desk*). */
    deskEntryRef: positive(call.deskEntryRef ?? call.entry_ref),
    deskStop: positive(call.deskStop),
    deskTarget: positive(call.deskTarget),
    deskOpenedAt: positive(call.deskOpenedAt ?? call.opened_at ?? call.ts),
    riskF: null,
  };
}

/**
 * The per-tick decision for ONE open position. `mark` is the current valuation;
 * `deskExit` is set when the desk has published an exit for this call.
 * Returns {action: hold|sell, fraction, reason}.
 *
 * desk-led-v4: HOLD unless the desk said sell. The mark is accepted so callers keep a
 * single call site for valuation, but no price, level, ratchet or clock in this
 * function can produce a sell — that is the whole change. The shared pricePolicy is
 * reached only through the deskExit branch (which sells 1.0 unconditionally) and, in
 * mirror mode, through desk-mirror.mjs on the desk's own inputs.
 */
export function stepPosition({ pos, mark, deskExit = null, cfg = DEFAULTS, nowMs = Date.now() }) {
  if (deskExit) {
    const d = pricePolicy({ position: pos, mark, deskExit, nowMs, config: cfg });
    // Preserve the existing API while ensuring both server and executor use the exact
    // same pure policy. Mutation is limited to an accepted policy state transition.
    Object.assign(pos, d.position);
    return { action: d.action, fraction: d.fraction, reason: d.reason,
      policyVersion: d.policyVersion };
  }
  return { action: "hold", fraction: 0,
    reason: "desk-led: holding for the desk's determination (no local exit policy)",
    policyVersion: POLICY_VERSION };
}

export const freshState = (now = 0) => ({
  // These compatibility names are rolling 24-hour values derived from the durable
  // risk_events ledger. They are never reset at a day boundary.
  dayStart: now, deployedTodaySol: 0, realizedTodaySol: 0,
  openCount: 0, spendableSol: null,
  // the sizing inputs: the closed sample, the equity Kelly is a fraction OF,
  // and how much risk the open book is already carrying
  wins: 0, losses: 0, equitySol: null, bookHeat: 0,
});
