/**
 * THE SNIPER'S RULER — constant-product venue math in BigInt, and the floor derived
 * from the desk's own fee rail.
 *
 * Nothing downstream of this file is trustworthy until this file is. The sniper lane has
 * no desk, no DexScreener consensus and no Jupiter preflight one slot after a create —
 * every one of the repo's three existing rulers is unavailable at the moment this lane
 * has to decide. What it has instead is the curve account itself, and the only honest
 * reading of it is a SIMULATED SELL:
 *
 *     markX = sellExactIn(curve, position.qtyRaw) / position.entryInputLamports
 *
 * Four properties earn that ruler its job, and each one is a reason the alternatives were
 * rejected:
 *   - SOL-denominated end to end, so the lane never touches a SOL/USD oracle on the
 *     critical path of a position whose whole life is seconds.
 *   - Executable output, not spot. It charges impact by construction, so a drained curve
 *     collapses the mark without a separate liquidity check.  (`curveExitMarkX` also
 *     refuses to promise more than the curve's REAL quote reserve can actually pay — the
 *     virtual reserves will happily quote SOL that does not exist.)
 *   - markX is already a round-trip multiple: markX = 1.0 means the sell returns the buy
 *     input, so fee friction is INSIDE the number rather than bolted on beside it.
 *   - Deterministic. The same account bytes at the same slot give the same value on two
 *     endpoints, which is what makes a two-endpoint witness rule mean anything at all.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It encodes no instruction, names no discriminator and builds no transaction. No venue
 * instruction layout is verified anywhere in this repo, and a guessed account order is
 * not a best guess, it is a signed mistake. Entry-side code that needs bytes belongs in
 * an adapter that has proved its layout by decoding a REAL on-chain transaction. This is
 * arithmetic only: no I/O, no clock, no keypair, no mutation of its arguments.
 *
 * THE ARITHMETIC IS BIGINT BECAUSE DOUBLES ARE NOT ACCURATE ENOUGH HERE, and that is
 * measured rather than assumed: a standard pump.fun curve holds ~1.07e15 base units, so
 * the product `vBase * quoteIn` is ~4e21 — a hundred thousand times past the 2^53 where
 * a double stops counting by ones. test-snipe-curve.mjs prints a case where the double
 * answer and the exact answer differ by thousands of raw units. Money is integers.
 *
 * THE CURVE STATE IS DERIVED FROM THE ROW, NEVER FROM A CONSTANT. `src/data/pumpfun-live.js`
 * `curveOf()` established the discipline and the reason: "85 SOL to graduate" was a
 * constant, and per coin it is wrong — measured live the graduation total is 85.005 on
 * most rows and 10-345 on boosted and mini curves. So `snipeCurveState()` recovers
 * everything the same way it does: k = vQuote * vBase, held = vBase - realBase, the
 * opening virtual quote as vQuote - realQuote. There is no graduation constant in this
 * file, and test-snipe-curve.mjs asserts the source contains none.
 *
 * THE ONE SANCTIONED DESK IMPORT is `minViableSolPerTrade`. The sniper does not choose a
 * stop floor; it INVERTS the frozen sizing function, so the floor moves when the rails
 * move and no one has to remember to edit it. Nothing else from strategy.mjs,
 * trade-policy.mjs or desk-mirror.mjs may be imported here, and that is asserted from the
 * source text rather than left as a convention.
 */
import { minViableSolPerTrade } from "./strategy.mjs";

export const SNIPE_CURVE_VERSION = "snipe-curve-v1";

/** Basis-point denominator. A venue fee arrives as bps from the adapter; it is never
 *  assumed here, because no venue's fee rate is verified in this repo. */
export const BPS_DENOM = 10_000n;

/** The mark's resolution. 1e-9 of a round-trip multiple against a ~5,000,000-lamport
 *  entry is 0.005 of a lamport — finer than the integer quantity underneath it — and it
 *  is the SAME scale `exit-trigger.mjs executableExitMark` uses. That is deliberate: the
 *  two lanes must not be able to mean different numbers by the word "mark". */
export const MARK_SCALE = 1_000_000_000n;

const MAX_EXACT_NUMBER = BigInt(Number.MAX_SAFE_INTEGER);

/** A raw on-chain amount. Accepts bigint, a digit string (how the journal stores them)
 *  or a safe integer Number, and REFUSES anything else — a float that silently truncates
 *  is the failure mode this guard exists for. */
function rawAmount(value, label, { allowZero = false } = {}) {
  let out;
  if (typeof value === "bigint") out = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer, got ${value}`);
    out = BigInt(value);
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) out = BigInt(value.trim());
  else throw new Error(`${label} must be an integer amount, got ${JSON.stringify(value)}`);
  if (out < 0n) throw new Error(`${label} must not be negative, got ${out}`);
  if (!allowZero && out === 0n) throw new Error(`${label} must be positive, got 0`);
  return out;
}

/** A venue fee in basis points. 10,000 bps is the whole input: an adapter reporting that
 *  has misdecoded something, and a 100% fee is not a venue, so it is refused rather than
 *  quoted. */
function feeBpsOf(value, label = "feeBps") {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0 || n >= 10_000)
    throw new Error(`${label} must be an integer in [0, 10000), got ${value}`);
  return BigInt(n);
}

/** BigInt -> Number where the answer must be EXACT or must not exist. Used only on the
 *  friction arithmetic, where a silently rounded lamport is a money error. */
function exactNumber(value, label) {
  if (value > MAX_EXACT_NUMBER || value < -MAX_EXACT_NUMBER)
    throw new Error(`${label} (${value}) exceeds exact Number range`);
  return Number(value);
}

/** A ratio of two raw amounts, for the price and impact DIAGNOSTICS only.
 *
 *  It goes through BigInt rather than Number(a)/Number(b) on purpose, and the reason is
 *  a defect this nearly shipped with: a nine-decimal token with a ten-billion supply
 *  holds more than 9,007,199,254,740,991 raw units, so an exact-Number conversion of the
 *  base reserve THROWS — and that throw would have travelled up out of `curveExitMarkX`
 *  and turned a perfectly readable mark into an unreadable one, on a held position, over
 *  a number nothing decides anything on. Scaled BigInt division never overflows and
 *  never throws; it costs twelve significant digits, which is ten more than a percentage
 *  is ever printed to. */
const RATIO_SCALE = 1_000_000_000_000n;
const ratioNumber = (num, den) => (den <= 0n ? null : Number((num * RATIO_SCALE) / den) / 1e12);

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Accept either the adapter's `curveFromAccount` shape (vBaseRaw/vQuoteRaw) or the
 *  shorthand used by the quote helpers (vBase/vQuote). One normalizer, so a caller that
 *  passes a decoded curve straight through cannot get a silently undefined reserve. */
function reservesOf(curve, label = "curve") {
  if (!curve || typeof curve !== "object") throw new Error(`${label} must be an object`);
  const vBase = curve.vBaseRaw ?? curve.vBase;
  const vQuote = curve.vQuoteRaw ?? curve.vQuote;
  const realQuote = curve.realQuoteRaw ?? curve.realQuote ?? null;
  return {
    vBase: rawAmount(vBase, `${label}.vBaseRaw`),
    vQuote: rawAmount(vQuote, `${label}.vQuoteRaw`),
    realQuoteRaw: realQuote === null || realQuote === undefined
      ? null : rawAmount(realQuote, `${label}.realQuoteRaw`, { allowZero: true }),
    feeBps: feeBpsOf(curve.feeBps ?? 0, `${label}.feeBps`),
  };
}

/**
 * THE CURVE STATE, RECOVERED FROM THE ROW — the shape of `pumpfun-live.js curveOf()`,
 * in BigInt and quote-asset-agnostic.
 *
 * k = vQuote * vBase is the invariant; `held` = vBase - realBase is the slice reserved
 * for the pool and is why the curve completes when the REAL tokens run out, not when the
 * virtual ones do; `vQuote0` = vQuote - realQuote is the opening virtual quote, recovered
 * because quote enters the virtual and real reserves together.
 *
 * `quoteToCompleteRaw` is k/held - vQuote: what this curve still owes before it
 * graduates, derived per coin. It is the number the "85 SOL" constant used to stand in
 * for, and standing in for it was wrong on every boosted and mini curve.
 */
export function snipeCurveState(decoded, { label = "curve" } = {}) {
  if (!decoded || typeof decoded !== "object") throw new Error(`${label} must be a decoded curve object`);
  const vBase = rawAmount(decoded.vBaseRaw ?? decoded.vBase, `${label}.vBaseRaw`);
  const vQuote = rawAmount(decoded.vQuoteRaw ?? decoded.vQuote, `${label}.vQuoteRaw`);
  const hasRealBase = (decoded.realBaseRaw ?? decoded.realBase) !== undefined
    && (decoded.realBaseRaw ?? decoded.realBase) !== null;
  const hasRealQuote = (decoded.realQuoteRaw ?? decoded.realQuote) !== undefined
    && (decoded.realQuoteRaw ?? decoded.realQuote) !== null;
  const realBaseRaw = hasRealBase
    ? rawAmount(decoded.realBaseRaw ?? decoded.realBase, `${label}.realBaseRaw`, { allowZero: true }) : null;
  const realQuoteRaw = hasRealQuote
    ? rawAmount(decoded.realQuoteRaw ?? decoded.realQuote, `${label}.realQuoteRaw`, { allowZero: true }) : null;
  const feeBps = Number(feeBpsOf(decoded.feeBps ?? 0, `${label}.feeBps`));
  const k = vQuote * vBase;
  /* held is vBase - realBase. A row where realBase >= vBase is not a curve we understand,
     and approximating one is exactly the "curve_type_unsupported" refusal the entry gate
     exists for, so it is reported as null rather than repaired. */
  const heldBaseRaw = realBaseRaw !== null && vBase > realBaseRaw ? vBase - realBaseRaw : null;
  const quoteToCompleteRaw = heldBaseRaw !== null && heldBaseRaw > 0n
    ? (k / heldBaseRaw > vQuote ? k / heldBaseRaw - vQuote : 0n) : null;
  const vQuote0Raw = realQuoteRaw !== null && vQuote > realQuoteRaw ? vQuote - realQuoteRaw : null;
  return Object.freeze({
    kind: decoded.kind ?? null,
    curveType: decoded.curveType ?? null,
    creator: decoded.creator ?? null,
    complete: decoded.complete === true,
    feeBps,
    vBaseRaw: vBase,
    vQuoteRaw: vQuote,
    realBaseRaw,
    realQuoteRaw,
    k,
    heldBaseRaw,
    quoteToCompleteRaw,
    vQuote0Raw,
    /* Whether the executable sell can be capped at what the curve can actually pay. A
       false here means every mark off this state is an UPPER BOUND, and the lane treats
       an upper-bound mark as an entry refusal rather than as a price. */
    reserveKnown: realQuoteRaw !== null,
  });
}

/**
 * BUY, EXACT IN: spend `quoteInRaw` of the quote asset, receive base.
 *
 * The fee is taken off the INPUT before it touches the curve (pump.fun's shape: the fee
 * goes to the fee recipient, never into the reserve, so the invariant only sees the net),
 * and it is rounded UP — every rounding in this file goes against us, because a quote
 * that flatters itself by one raw unit is a quote that fills worse than it promised.
 *
 *     baseOut = floor(vBase * netIn / (vQuote + netIn))
 *
 * which is algebraically vBase - k/(vQuote + netIn) and is strictly less than vBase for
 * any finite input: the curve cannot be drained by a buy, only approached.
 */
export function constantProductExactIn({ vBase, vQuote, quoteInRaw, feeBps = 0 }) {
  const b = rawAmount(vBase, "vBase");
  const q = rawAmount(vQuote, "vQuote");
  const gross = rawAmount(quoteInRaw, "quoteInRaw");
  const bps = feeBpsOf(feeBps);
  const feeRaw = ceilDiv(gross * bps, BPS_DENOM);
  const netIn = gross - feeRaw;
  if (netIn <= 0n) throw new Error(`quoteInRaw ${gross} is entirely fee at ${bps} bps`);
  const baseOutRaw = (b * netIn) / (q + netIn);
  const spotBefore = ratioNumber(q, b);
  const curvePrice = ratioNumber(netIn, baseOutRaw);
  const execPrice = ratioNumber(gross, baseOutRaw);
  return Object.freeze({
    baseOutRaw,
    quoteInRaw: gross,
    quoteInAfterFeeRaw: netIn,
    feeRaw,
    vBaseAfterRaw: b - baseOutRaw,
    vQuoteAfterRaw: q + netIn,
    spotBefore,
    execPrice,
    /* Curve impact alone, fee excluded — the quantity gate 12 compares against
       LIVE_LIMITS.maxPriceImpactPct. The fee is not impact and hiding it in here would
       make one gate answer two questions. */
    impactPct: curvePrice === null || spotBefore === null ? null : (curvePrice / spotBefore - 1) * 100,
    /* What the fill actually cost per base unit against spot, fee included. Diagnostic. */
    execImpactPct: execPrice === null || spotBefore === null ? null : (execPrice / spotBefore - 1) * 100,
  });
}

/**
 * BUY, EXACT OUT: the quote-asset cost of receiving exactly `baseOutRaw`.
 *
 * This is the spine of the entry ceiling, and it is REQUIRED of every adapter: a venue
 * that cannot express an absolute maximum cost in the quote asset cannot be entered
 * safely, because the only alternative is a slippage tolerance, and a tolerance is a
 * permission to fill worse.
 *
 *     netIn = ceil(vQuote * out / (vBase - out)),   grossIn = ceil(netIn * 1e4 / (1e4 - bps))
 *
 * Both ceilings round against us. The fee ceiling can still leave the recovered net one
 * raw unit short of what was needed (ceil(x) - ceil(ceil(x)*bps/1e4) >= x - 1), so the
 * result is VERIFIED by running the forward quote and bumped until it genuinely delivers.
 * An exact-out that is one unit short is a transaction that reverts on the venue's own
 * minimum-out check, which is a wasted fee for no position.
 */
export function constantProductExactOut({ vBase, vQuote, baseOutRaw, feeBps = 0 }) {
  const b = rawAmount(vBase, "vBase");
  const q = rawAmount(vQuote, "vQuote");
  const out = rawAmount(baseOutRaw, "baseOutRaw");
  const bps = feeBpsOf(feeBps);
  if (out >= b) throw new Error(`baseOutRaw ${out} is not deliverable from vBase ${b}`);
  const netIn = ceilDiv(q * out, b - out);
  let grossIn = ceilDiv(netIn * BPS_DENOM, BPS_DENOM - bps);
  let delivered = constantProductExactIn({ vBase: b, vQuote: q, quoteInRaw: grossIn, feeBps: Number(bps) });
  /* Bounded, and it must be: an unbounded correction loop on the money path is a hang.
     One unit is the proven worst case; four is paranoia with a receipt. */
  for (let i = 0; delivered.baseOutRaw < out; i += 1) {
    if (i >= 4) throw new Error(`exact-out did not converge for baseOutRaw ${out}`);
    grossIn += 1n;
    delivered = constantProductExactIn({ vBase: b, vQuote: q, quoteInRaw: grossIn, feeBps: Number(bps) });
  }
  const spotBefore = ratioNumber(q, b);
  const execPrice = ratioNumber(grossIn, out);
  return Object.freeze({
    quoteInRaw: grossIn,
    quoteInAfterFeeRaw: delivered.quoteInAfterFeeRaw,
    feeRaw: delivered.feeRaw,
    baseOutRaw: out,
    /* What the forward quote actually hands back at this cost. It is >= baseOutRaw by
       construction; the surplus is the venue's rounding dust, not a rebate. */
    deliveredBaseOutRaw: delivered.baseOutRaw,
    spotBefore,
    execPrice,
    impactPct: delivered.impactPct,
    execImpactPct: execPrice === null || spotBefore === null ? null : (execPrice / spotBefore - 1) * 100,
  });
}

/**
 * SELL, EXACT IN — the ruler's engine.
 *
 *     grossOut = floor(vQuote * baseIn / (vBase + baseIn)),  fee taken off the OUTPUT
 *
 * and then the part that a purely virtual reading of the curve gets dangerously wrong:
 * THE PAYOUT IS CAPPED AT THE REAL QUOTE RESERVE. Virtual reserves are a pricing device;
 * they are not SOL. A fresh curve quotes against ~30 virtual SOL while holding almost
 * none, so a naive sell simulation of a whole position reports proceeds the curve cannot
 * possibly pay. That number would then become a mark, and the mark would become a
 * decision. When `realQuoteRaw` is supplied the executable answer is min(grossOut-fee,
 * realQuote) and `reserveBound` says so; when it is not supplied the answer is flagged
 * `reserveKnown: false` and every consumer must treat it as an upper bound.
 */
export function constantProductSellExactIn({ vBase, vQuote, baseInRaw, feeBps = 0, realQuoteRaw = null }) {
  const b = rawAmount(vBase, "vBase");
  const q = rawAmount(vQuote, "vQuote");
  const inRaw = rawAmount(baseInRaw, "baseInRaw");
  const bps = feeBpsOf(feeBps);
  const reserve = realQuoteRaw === null || realQuoteRaw === undefined
    ? null : rawAmount(realQuoteRaw, "realQuoteRaw", { allowZero: true });
  const grossOut = (q * inRaw) / (b + inRaw);
  const feeRaw = ceilDiv(grossOut * bps, BPS_DENOM);
  const curveOut = grossOut > feeRaw ? grossOut - feeRaw : 0n;
  const reserveBound = reserve !== null && curveOut > reserve;
  const quoteOutRaw = reserveBound ? reserve : curveOut;
  const spotBefore = ratioNumber(q, b);
  const execPrice = ratioNumber(quoteOutRaw, inRaw);
  return Object.freeze({
    quoteOutRaw,
    uncappedQuoteOutRaw: curveOut,
    grossQuoteOutRaw: grossOut,
    feeRaw,
    baseInRaw: inRaw,
    vBaseAfterRaw: b + inRaw,
    vQuoteAfterRaw: q > grossOut ? q - grossOut : 0n,
    reserveKnown: reserve !== null,
    reserveBound,
    spotBefore,
    execPrice,
    impactPct: execPrice === null || spotBefore === null ? null : (execPrice / spotBefore - 1) * 100,
  });
}

/**
 * THE MARK: what this position is worth as a multiple of what it cost, priced by the
 * sell the lane would actually have to execute.
 *
 * Deliberately divergent from `exit-trigger.mjs executableExitMark` in exactly one place:
 * that function THROWS on a mark of zero, which is right for the desk lane (a zero there
 * means the quote engine failed). Here a zero is a fact — a curve that would return
 * nothing — and it must reach the FLOOR trigger as a number, not as an exception. Every
 * other aspect, including the 1e-9 scale, is identical, and test-snipe-curve.mjs pins the
 * two against each other over 200 random reserve states so the lanes cannot drift apart
 * on what "mark" means.
 *
 * `adapter` is optional and is the venue's own quoting path when one exists; the built-in
 * constant-product math is used when it does not. An adapter whose sell cannot evaluate
 * throws, and that throw is an ENTRY REFUSAL upstream, never a hold: the sniper may not
 * enter a venue it cannot exit.
 */
export function curveExitMarkX({ curve, qtyRaw, entryInputLamports, adapter = null }) {
  const qty = rawAmount(qtyRaw, "qtyRaw");
  const entry = rawAmount(entryInputLamports, "entryInputLamports");
  let outRaw;
  if (adapter && typeof adapter.sellExactIn === "function") {
    const quoted = adapter.sellExactIn(curve, qty);
    outRaw = rawAmount(quoted?.quoteOutRaw, "adapter sellExactIn quoteOutRaw", { allowZero: true });
  } else {
    const r = reservesOf(curve);
    outRaw = constantProductSellExactIn({
      vBase: r.vBase, vQuote: r.vQuote, baseInRaw: qty,
      feeBps: Number(r.feeBps), realQuoteRaw: r.realQuoteRaw,
    }).quoteOutRaw;
  }
  const markX = Number((outRaw * MARK_SCALE) / entry) / Number(MARK_SCALE);
  if (!Number.isFinite(markX) || markX < 0)
    throw new Error(`simulated exit mark is invalid (${markX}) for output ${outRaw} on entry ${entry}`);
  return markX;
}

/**
 * THE ABSOLUTE CEILING ON WHAT AN ENTRY MAY COST, IN LAMPORTS OF THE QUOTE ASSET.
 *
 * This is not a slippage tolerance and the `tolerance` argument exists only to REFUSE
 * one. A tolerance says "fill me up to x% worse than I asked"; against a launch curve
 * that is a standing offer to whoever gets in front of us, since anything that moves the
 * reserve between our decode and our slot moves it in exactly that direction. The ceiling
 * says instead: this many lamports at the state we read, and if the state moved, REVERT.
 * A reverted race costs one network fee (already charged to both daily counters through
 * journal.mjs attempt_fee_events) and buys nothing at a worse price, which is the correct
 * trade.
 */
export function absoluteMaxCostLamports({ curve, baseOutRaw, adapter = null, tolerance = 0 }) {
  if (!(tolerance === 0 || tolerance === 0n))
    throw new Error(`absoluteMaxCostLamports takes no tolerance (got ${tolerance}): a ceiling is not a tolerance`);
  const out = rawAmount(baseOutRaw, "baseOutRaw");
  if (adapter && typeof adapter.quoteExactOut === "function") {
    const quoted = adapter.quoteExactOut(curve, out);
    return rawAmount(quoted?.quoteInRaw, "adapter quoteExactOut quoteInRaw");
  }
  const r = reservesOf(curve);
  return constantProductExactOut({
    vBase: r.vBase, vQuote: r.vQuote, baseOutRaw: out, feeBps: Number(r.feeBps),
  }).quoteInRaw;
}

/**
 * THE FLOOR IS DERIVED, NEVER DIALED.
 *
 * `strategy.mjs minViableSolPerTrade` says the round trip's network fees may be at most
 * `maxFeeShareOfStop` (0.25) of the distance being risked, which makes the smallest
 * fundable position a function of the stop:
 *
 *     minViable(stop) = 2 * feeReserve / (maxFeeShareOfStop * stop)
 *
 * Inverting it for a given ticket gives the TIGHTEST STOP THAT TICKET CAN FUND:
 *
 *     stopFrac = 2 * feeReserve / (maxFeeShareOfStop * sol)
 *
 * At the live cap — maxSolPerTrade 0.005 SOL, expectedNetworkFeeLamports 500,000, i.e.
 * a 0.0005 SOL fee reserve a leg — that is 0.8000, a stop at 0.20x entry. Run a larger
 * ticket and the floor tightens by itself with nobody editing a number.
 *
 * SAY THE CONSEQUENCE OUT LOUD: at the live cap this lane is effectively STOPLESS. The
 * price stop is a catastrophe backstop at a fifth of entry, not a risk control. The real
 * controls are the clock, the structural tripwires and the size. Tightening the stop to
 * feel safer makes the position unfundable, which is not the same thing as safe.
 *
 * TWO GUARDS THE BARE FORMULA NEEDS:
 *
 *  - `stopFrac` is capped at 0.95, because a stop wider than the entry is not a stop.
 *  - A ZERO fee reserve returns a floor of 0, not of 1. `poller.mjs:1407` sets
 *    `networkFeeReserveSol` to 0 whenever EXECUTE is off, which is precisely the observe
 *    configuration this lane ships in first. 1 - 0 = 1 would put the floor AT ENTRY and
 *    fire the FLOOR trigger on every shadow position at its first sample, and the shadow
 *    book would then measure its own arithmetic instead of the market. With no fee rail
 *    there is no derived stop minimum at all, and 0 is the honest statement of that.
 *
 * Returns the tightest stop the ticket can fund and the highest floor that follows from
 * it. A WIDER stop (a LOWER floorMarkX) is always fundable; a tighter one never is.
 */
export function snipeFloor({ cfg, sol }) {
  const size = Number(sol);
  if (!Number.isFinite(size) || size <= 0)
    throw new Error(`snipeFloor needs a positive ticket size, got ${sol}`);
  const share = Number(cfg?.maxFeeShareOfStop);
  if (!Number.isFinite(share) || share <= 0)
    throw new Error(`snipeFloor needs cfg.maxFeeShareOfStop > 0, got ${cfg?.maxFeeShareOfStop}`);
  const feeReserve = Math.max(0, Number(cfg?.networkFeeReserveSol) || 0);
  const stopFrac = feeReserve > 0 ? Math.min(0.95, (2 * feeReserve) / (share * size)) : 0;
  const floorMarkX = stopFrac > 0 ? 1 - stopFrac : 0;
  return { stopFrac, floorMarkX, minViableSol: minViableSolPerTrade(cfg, stopFrac) };
}

/**
 * TRUE BREAKEVEN FOR THIS FILL — computed from the lamports that were actually paid,
 * frozen on the position at open, printed in every log line and every shadow row.
 *
 * markX is gross sell output over swap input, so the wallet is whole when
 *
 *     sellOutput - exitFee = swapInput + entryFee
 *     markX      = 1 + (entryFee + exitFee) / swapInput
 *
 * At the live cap that is 1.2222x when the 0.005 SOL ticket pays its entry fee out of its
 * own budget (4,500,000 lamports reach the swap), and 1.2000x when the fee is carried
 * beside the full 5,000,000. Both numbers are in the record; they are the same formula
 * over two sizing conventions, which is why this is computed per fill and never stored as
 * a constant. The realized fraction at any mark is markX / frictionX - 1 — so selling at
 * markX = 1.0 realizes -18.18% on the first convention and -16.67% on the second. THAT is
 * why a "breakeven" arm at entry is a loss-taking arm on this lane, and why the sniper
 * arms breakeven at frictionX.
 *
 * No exit logic can improve this number. It is a fact about position size.
 */
export function frictionXFor({ entryInputLamports, entryFeeLamports, expectedExitFeeLamports }) {
  const entry = rawAmount(entryInputLamports, "entryInputLamports");
  const entryFee = rawAmount(entryFeeLamports, "entryFeeLamports", { allowZero: true });
  const exitFee = rawAmount(expectedExitFeeLamports, "expectedExitFeeLamports", { allowZero: true });
  const friction = 1 + exactNumber(entryFee + exitFee, "round-trip fee") / exactNumber(entry, "entryInputLamports");
  if (!Number.isFinite(friction) || friction < 1)
    throw new Error(`frictionX is invalid (${friction}) for entry ${entry} and fees ${entryFee}/${exitFee}`);
  return friction;
}
