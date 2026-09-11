/**
 * THE t=0 GATE, AND THE ENTRY ENVELOPE THAT REPLACES A SLIPPAGE TOLERANCE.
 *
 * One ordered list of gates, cheapest first, first failure names the refusal — the shape
 * `entry-contract.mjs ENTRY_GATES` already established for the desk lane, because a
 * refusal that carries the same code on both sides of a fence is the only kind two
 * processes can argue about later. Everything here is pure: no I/O, no clock of its own,
 * no keypair, no mutation of an argument. The lane hands in the bytes it already read and
 * the clock it already has; this file only judges.
 *
 * ── WHY THE ORDER IS THE DESIGN, NOT THE DECORATION ────────────────────────────────
 *
 * Each gate carries a COST TIER, and the array is asserted (at import, and again in the
 * test) to be non-decreasing in cost:
 *
 *   0  in-process. No network at all — the lane switch, the sentinels, the book, the
 *      clock. A launch refused here costs nothing but the notice that produced it.
 *   1  the ONE getMultipleAccounts the lane makes anyway — curve account + mint account,
 *      both endpoints, one round trip. Nothing below tier 1 issues a second read.
 *   2  pure arithmetic on bytes already fetched. Free once tier 1 has paid.
 *   3  the statistical layer, which may need one or two extra reads and is DELIBERATELY
 *      LAST and deliberately not a kill by default (see `creator_profile` below).
 *   4  pre-signature, no network: the fee budget and our own instruction bytes decoded
 *      back.
 *
 * At a launch the whole budget is the slot. Ordering by cost is not tidiness, it is the
 * difference between refusing a hostile mint for free and refusing it after paying for
 * two reads we were never going to use.
 *
 * ── THE MINT KILL SET IS REUSED, NOT REINVENTED ────────────────────────────────────
 *
 * The desk already derives exactly the facts this gate needs, for free, from the mint
 * account it reads anyway: `src/data/solana.js mintInfo()` reports `mint_authority_live`,
 * `freeze_authority_live` and one `ext_<name>` flag per extension outside
 * `BOT_ALLOWED_EXTENSIONS`, and names transferHook / permanentDelegate /
 * defaultAccountState explicitly. This file does not re-decide any of that. It consumes
 * either shape — the raw account (through the executor's own `auditMintAccount`) or the
 * jsonParsed record `mintInfo()` returns — and refuses under ONE code, `mint_refused`,
 * carrying the desk's own flag names in its detail.
 *
 * The allowlist is DERIVED from `token2022.mjs ALLOWED_MINT_EXTENSIONS` rather than typed
 * out again, because the executor's copy is the one that throws on the money path and
 * `src/data/solana.js:36-40` records why the desk's is a mirror rather than an import
 * (@solana/web3.js is an executor dependency; importing across that boundary breaks the
 * desk's boot). test-snipe-entry.mjs reads src/data/solana.js AS TEXT and asserts the set
 * derived here is character-for-character the same set, so a drift is a red test.
 *
 * MEASURED, THIS PASS, AGAINST MAINNET (free getAccountInfo, three real pump.fun mints —
 * the ruler validated against cases whose answer was not known in advance and then was):
 *
 *   9BB6NFEc…pump   owner Tokenkeg… (classic)  mintAuthority null  freezeAuthority null  decimals 6  ext []
 *   FgJReZeY…pump   owner Tokenz…   (2022)     mintAuthority null  freezeAuthority null  decimals 6  ext [metadataPointer, tokenMetadata]
 *   HRkkxgaF…pump   owner Tokenz…   (2022)     mintAuthority null  freezeAuthority null  decimals 6  ext [metadataPointer, tokenMetadata]
 *
 * Both extensions are inside the allowlist, and both authorities are already renounced.
 * That matters because a kill set that refuses the entire population is indistinguishable
 * from a kill set that works until you count — which is the whole reason the hit-rate
 * assertion at the bottom of the test exists. What is NOT verified: whether a mint looks
 * like this AT t=0, one slot after the create, rather than at the moment it was read
 * here. Only the observe log answers that, and it is listed as such.
 *
 * ── THE CEILING IS NOT A SLIPPAGE TOLERANCE ────────────────────────────────────────
 *
 * `planSnipeCeiling()` reads no slippage term and there is no argument by which one can
 * be introduced (`tolerance` exists only so a caller that passes one gets an exception
 * instead of a fill). A tolerance says "fill me up to x% worse than I asked"; against a
 * launch curve that is a standing offer to whoever lands in front of us, because anything
 * that moves the reserve between our decode and our slot moves it in exactly that
 * direction. The ceiling says instead: this many lamports at the state we read, and if
 * the state moved, REVERT. A reverted race costs one network fee — already charged to
 * BOTH daily counters through `journal.mjs attempt_fee_events` (:302-309, rolled in at
 * :544-550), so a landed-and-reverted race consumes `dailySolCap` and counts against
 * `dailyLossLimitSol` without anything new being built — and it buys nothing at a worse
 * price. That is the correct trade at this size.
 *
 * `jupiterEquivalentWorstCost()` exists ONLY so the test can prove that claim as an
 * inequality rather than assert it as a belief: for the same curve and the same spend,
 * our ceiling is never looser than what Jupiter's own envelope would have permitted at
 * `LIVE_LIMITS.slippageBps` (300). It is not called on any live path and must not be.
 *
 * ── WHAT THIS FILE REFUSES TO DO ───────────────────────────────────────────────────
 *
 * It encodes no instruction, names no discriminator and orders no accounts. NO VENUE
 * INSTRUCTION LAYOUT IS VERIFIED ANYWHERE IN THIS REPO. `assertSnipeInstruction()`
 * therefore REFUSES — every time, in both lanes — until the adapter it is handed carries
 * a layout proof that `snipe-venue.mjs` accepts: `layoutVerified === true` plus a
 * `layoutProof` naming mainnet, the adapter's own program, and a real decode round trip
 * per proved method. An unverified venue is an entry refusal, not a best guess, and the
 * refusal arrives at gate `instruction_mismatch` with the venue clause in its detail.
 *
 * ── GATE CLASS ─────────────────────────────────────────────────────────────────────
 *
 * `src/calls.js gateClass()` answers SAFETY for any code it has not heard of (:579), and
 * the 33 SAFETY gates in that table are FROZEN. Every code here is therefore SAFETY by
 * default-deny, which is the correct direction and costs nothing today because no desk
 * file emits one. The test asserts the codes are DISJOINT from the existing table — if a
 * snipe code ever collided with a desk code it would silently re-point a desk refusal —
 * and re-pins the measured 33/21 split so a sniper change that edits that table is loud.
 */
import { MAX_ROUTE_HALVINGS } from "./entry-sizing.mjs";
import {
  snipeCurveState,
  constantProductExactIn,
  constantProductExactOut,
  constantProductSellExactIn,
  absoluteMaxCostLamports,
  snipeFloor,
} from "./snipe-curve.mjs";
import { venueContract } from "./snipe-venue.mjs";
import { assertNetworkFeeBudget } from "./network-fee-budget.mjs";
import { ALLOWED_MINT_EXTENSIONS, EXTENSION_NAMES, auditMintAccount } from "./token2022.mjs";

export const SNIPE_ENTRY_VERSION = "snipe-entry-v1";

/** The gates, in the order they are evaluated. The first one that fails names the refusal.
 *
 *  §5 of the build spec writes gate 2 as "hard_stop / pause_entries" on one line. It is
 *  TWO CODES here, deliberately: a gate has to name its refusal, and "hard_stop /
 *  pause_entries" is not a code any log line or `GATE_CLASS` entry could carry. The two
 *  sentinels are different owner instructions with different meanings — HARD STOP halts
 *  everything including exits, PAUSE ENTRIES halts only new positions (poller.mjs:139-140,
 *  :334-341) — and collapsing them would report the wrong one. So this list is 22 entries
 *  against the spec's 21 numbered lines; nothing else about the order moves.
 */
export const SNIPE_GATES = Object.freeze([
  // ── COST 0: in-process, no I/O ───────────────────────────────────────────────────
  "lane_off",
  "venue_not_enabled",
  "hard_stop",
  "pause_entries",
  "daily_capacity",
  "notice_stale",
  "already_holding",
  "already_attempted",
  // ── COST 1: the one getMultipleAccounts the lane makes anyway ────────────────────
  "curve_unreadable",
  "curve_type_unsupported",
  "curve_already_complete",
  "exit_route_unimplemented",
  "mint_refused",
  // ── COST 2: pure arithmetic on bytes already fetched ─────────────────────────────
  "impact_over_cap",
  "round_trip_over_cap",
  "stop_floor",
  "size_under_minimum",
  // ── COST 3: the statistical layer, measured before it is ever a kill ─────────────
  "creator_profile",
  "launch_share",
  // ── COST 4: pre-signature, no network ────────────────────────────────────────────
  "network_fee_over_cap",
  "rent_over_cap",
  "instruction_mismatch",
]);

/** What each gate costs to evaluate. Exported so the shadow row can price its own trace,
 *  and so the ordering rule is a testable fact rather than a comment: the array above is
 *  asserted non-decreasing in this map. */
export const SNIPE_GATE_COST = Object.freeze({
  lane_off: 0, venue_not_enabled: 0, hard_stop: 0, pause_entries: 0,
  daily_capacity: 0, notice_stale: 0, already_holding: 0, already_attempted: 0,
  curve_unreadable: 1, curve_type_unsupported: 1, curve_already_complete: 1,
  exit_route_unimplemented: 1, mint_refused: 1,
  impact_over_cap: 2, round_trip_over_cap: 2, stop_floor: 2, size_under_minimum: 2,
  creator_profile: 3, launch_share: 3,
  network_fee_over_cap: 4, rent_over_cap: 4, instruction_mismatch: 4,
});

/** The two gates that are measured on every notice and kill only when the operator has
 *  set a threshold. They are last in the order and lenient by default for one reason:
 *  nobody has run them against a known answer yet. `src/launch-shadow.js` states the
 *  discipline — "a number is not evidence until it has been run against a case whose
 *  answer is already known" — and wiring a proxy as a kill before its scorecard exists is
 *  exactly the move that discipline forbids. When a threshold IS set they refuse, and a
 *  threshold set with no measurement available refuses too: unverified is not safe. */
export const SNIPE_PROXY_GATES = Object.freeze(["creator_profile", "launch_share"]);

/** The mint allowlist, in the desk's camelCase spelling, DERIVED from the executor's own
 *  `ALLOWED_MINT_EXTENSIONS` so there is exactly one authority for it in this process.
 *  jsonParsed spells an extension in camelCase and the TLV enum spells it PascalCase;
 *  that is the only conversion here. */
export const SNIPE_ALLOWED_EXTENSIONS = Object.freeze(new Set(
  [...ALLOWED_MINT_EXTENSIONS]
    .map((type) => EXTENSION_NAMES[type])
    .filter(Boolean)
    .map((name) => name.charAt(0).toLowerCase() + name.slice(1))
    .sort(),
));

/** The structural facts that kill a launch outright, named the way `mintInfo()` names
 *  them so one vocabulary spans both processes. `defaultAccountState` is on the list
 *  because it is a kill ONLY when the default state is not "initialized" — the desk fixed
 *  that false positive and this file inherits the fix rather than re-introducing it. */
export const SNIPE_MINT_KILL_FLAGS = Object.freeze([
  "mint_authority_live",
  "freeze_authority_live",
  "ext_transferHook",
  "ext_permanentDelegate",
  "ext_defaultAccountState",
  "bot_mint_refusal",
]);

/** Thrown by `assertSnipeInstruction`. Carries the gate so a caller branches on the code
 *  rather than on English. */
export class SnipeEntryRefusal extends Error {
  constructor(gate, message, detail = {}) {
    super(message);
    this.name = "SnipeEntryRefusal";
    this.gate = gate;
    this.detail = detail;
  }
}

/* ── small, private, and deliberately boring ───────────────────────────────────────── */

const LAMPORTS_PER_SOL = 1_000_000_000;
const PCT_SCALE = 1_000_000n;         // 1e-4 of a percent, in integers

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/** SOL (a float, because every cap in this repo is authored as one) to lamports (an
 *  integer, because money is integers). A value that is not a whole number of lamports is
 *  refused rather than rounded — a silent half-lamport is how a cap stops meaning what it
 *  says. */
function solToLamports(sol, label) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number of SOL, got ${sol}`);
  const scaled = n * LAMPORTS_PER_SOL;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-3)
    throw new Error(`${label} (${sol} SOL) is not a whole number of lamports`);
  return BigInt(rounded);
}

/** A BigInt ratio as a percentage, through integers the whole way. Never throws, never
 *  overflows: a percentage is a diagnostic and must not be able to break a decision. */
function pctOf(num, den) {
  if (den === 0n) return null;
  return Number((num * 100n * PCT_SCALE) / den) / Number(PCT_SCALE);
}

const toBig = (value, label, { allowZero = true } = {}) => {
  let out;
  if (typeof value === "bigint") out = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer, got ${value}`);
    out = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) out = BigInt(value.trim());
  else throw new Error(`${label} must be an integer amount, got ${JSON.stringify(value)}`);
  if (out < 0n) throw new Error(`${label} must not be negative, got ${out}`);
  if (!allowZero && out === 0n) throw new Error(`${label} must be positive, got 0`);
  return out;
};

/** A program id off an instruction, whatever shape the caller's web3 layer used. */
function programIdOf(ix) {
  if (!isPlainObject(ix)) return null;
  const id = ix.programId ?? ix.program_id ?? null;
  if (id == null) return null;
  if (typeof id === "string") return id;
  if (typeof id.toBase58 === "function") return id.toBase58();
  return String(id);
}

/**
 * THE ENTRY CEILING: how many base units this ticket buys at the state we read, and the
 * ABSOLUTE maximum quote-asset cost we will permit for exactly that many.
 *
 * Steps, in order, all BigInt:
 *
 *   1. quote the buy exact-IN at the ticket. That fixes the QUANTITY.
 *   2. quote the same quantity exact-OUT. That fixes the CEILING, with no slippage term.
 *      For the built-in constant-product math the ceiling provably cannot exceed the
 *      ticket (both roundings go against us, and grossIn <= ticket follows from
 *      net <= ticket*(1e4-bps)/1e4); for an ADAPTER'S OWN quoteExactOut that is a claim
 *      about someone else's arithmetic, so it is checked and the quantity shaved until it
 *      holds. A ceiling above the ticket is not a ceiling.
 *   3. price the immediate round trip by selling the whole fill straight back into the
 *      post-buy curve — including the quote the buy just added to the REAL reserve, since
 *      the sell may only be paid out of what the curve actually holds.
 *   4. if impact or round-trip loss is over cap, HALVE and try again, at most
 *      MAX_ROUTE_HALVINGS times (entry-sizing.mjs's own bound, imported not copied). A
 *      cost-shaped refusal becoming a smaller fill is the desk's rule and it is reused
 *      here unchanged — and at the live 0.005 SOL cap it is inert, because the first
 *      halving already lands under the fee floor. The test prints that.
 *
 * Returns the largest rung that cleared, or — when none did — the LAST rung tried, with
 * `impactOverCap` / `roundTripOverCap` set so the caller's gate can name the refusal.
 */
export function planSnipeCeiling({ curve, adapter = null, solLamports, cfg = {}, tolerance = 0 } = {}) {
  if (!(tolerance === 0 || tolerance === 0n))
    throw new Error(`planSnipeCeiling takes no tolerance (got ${tolerance}): a ceiling is not a slippage tolerance`);
  const ticket = toBig(solLamports, "solLamports", { allowZero: false });
  const maxImpactPct = Number(cfg.maxPriceImpactPct);
  const maxRoundTripPct = Number(cfg.maxEntryRoundTripLossPct);
  const halvings = Number.isInteger(cfg.maxRouteHalvings) && cfg.maxRouteHalvings >= 0
    ? cfg.maxRouteHalvings : MAX_ROUTE_HALVINGS;

  const state = curve && curve.k !== undefined ? curve : snipeCurveState(curve);
  const feeBps = Number(state.feeBps ?? 0);

  const rungs = [];
  let chosen = null;
  for (let i = 0; i <= halvings; i += 1) {
    const spend = ticket >> BigInt(i);
    if (spend <= 0n) break;
    const rung = quoteOneRung({ state, adapter, spend, feeBps });
    const impactOverCap = Number.isFinite(maxImpactPct) && rung.impactPct !== null
      && rung.impactPct > maxImpactPct;
    const roundTripOverCap = Number.isFinite(maxRoundTripPct) && rung.roundTripLossPct !== null
      && rung.roundTripLossPct > maxRoundTripPct;
    const priced = Object.freeze({ ...rung, halvings: i, impactOverCap, roundTripOverCap });
    rungs.push(priced);
    if (priced.deliverable && !impactOverCap && !roundTripOverCap) { chosen = priced; break; }
  }
  const result = chosen ?? rungs[rungs.length - 1] ?? Object.freeze({
    deliverable: false, spendLamports: ticket, baseOutRaw: 0n, maxQuoteInRaw: 0n,
    impactPct: null, execImpactPct: null, sellBackRaw: 0n, roundTripLossPct: null,
    reserveKnown: false, feeBps, halvings: 0, impactOverCap: false, roundTripOverCap: false,
  });
  return Object.freeze({
    ...result,
    cleared: chosen !== null,
    ticketLamports: ticket,
    rungs: Object.freeze(rungs),
    maxRouteHalvings: halvings,
  });
}

/** One rung of the ladder. Prefers the adapter's own quoting when it has any — the venue
 *  is the authority on its own arithmetic — and falls back to the constant-product math.
 *  A throw anywhere in here is not swallowed: it means the venue cannot be quoted, which
 *  is `exit_route_unimplemented` upstream, never a hold. */
function quoteOneRung({ state, adapter, spend, feeBps }) {
  const buy = adapter && typeof adapter.quoteExactIn === "function"
    ? adapter.quoteExactIn(state, spend)
    : constantProductExactIn({ vBase: state.vBaseRaw, vQuote: state.vQuoteRaw, quoteInRaw: spend, feeBps });
  const baseOut0 = toBig(buy.baseOutRaw, "quoteExactIn baseOutRaw");
  if (baseOut0 === 0n)
    return { deliverable: false, spendLamports: spend, baseOutRaw: 0n, maxQuoteInRaw: 0n,
      impactPct: buy.impactPct ?? null, execImpactPct: buy.execImpactPct ?? null,
      sellBackRaw: 0n, roundTripLossPct: null, reserveKnown: state.reserveKnown === true, feeBps };

  /* The ceiling, and then the check that it IS one. Shaving is bounded; it exists for an
     adapter whose exact-out rounds the other way, not for the built-in math. */
  let baseOut = baseOut0;
  let ceiling = absoluteMaxCostLamports({ curve: state, baseOutRaw: baseOut, adapter, tolerance: 0 });
  for (let shave = 0; ceiling > spend && baseOut > 1n && shave < 8; shave += 1) {
    baseOut -= 1n;
    ceiling = absoluteMaxCostLamports({ curve: state, baseOutRaw: baseOut, adapter, tolerance: 0 });
  }
  if (ceiling > spend)
    return { deliverable: false, spendLamports: spend, baseOutRaw: baseOut, maxQuoteInRaw: ceiling,
      impactPct: buy.impactPct ?? null, execImpactPct: buy.execImpactPct ?? null,
      sellBackRaw: 0n, roundTripLossPct: null, reserveKnown: state.reserveKnown === true, feeBps };

  /* The round trip, priced against the curve THE BUY LEAVES BEHIND — including the quote
     the buy just paid into the real reserve, which is the only thing the sell can be paid
     out of. Leaving that out understates the exit on precisely the fresh curves this lane
     lives on. */
  const netIn = buy.quoteInAfterFeeRaw !== undefined
    ? toBig(buy.quoteInAfterFeeRaw, "quoteExactIn quoteInAfterFeeRaw") : spend;
  const post = {
    vBaseRaw: buy.vBaseAfterRaw !== undefined ? toBig(buy.vBaseAfterRaw, "vBaseAfterRaw") : state.vBaseRaw - baseOut,
    vQuoteRaw: buy.vQuoteAfterRaw !== undefined ? toBig(buy.vQuoteAfterRaw, "vQuoteAfterRaw") : state.vQuoteRaw + netIn,
    realQuoteRaw: state.realQuoteRaw === null || state.realQuoteRaw === undefined
      ? null : toBig(state.realQuoteRaw, "realQuoteRaw") + netIn,
    feeBps,
  };
  const sell = adapter && typeof adapter.sellExactIn === "function"
    ? adapter.sellExactIn(post, baseOut)
    : constantProductSellExactIn({ vBase: post.vBaseRaw, vQuote: post.vQuoteRaw, baseInRaw: baseOut,
      feeBps, realQuoteRaw: post.realQuoteRaw });
  const sellBack = toBig(sell.quoteOutRaw, "sellExactIn quoteOutRaw");
  return {
    deliverable: true,
    spendLamports: spend,
    baseOutRaw: baseOut,
    maxQuoteInRaw: ceiling,
    impactPct: buy.impactPct ?? null,
    execImpactPct: buy.execImpactPct ?? null,
    sellBackRaw: sellBack,
    /* What an instant round trip loses, as a percentage of the spend. Positive is a loss.
       Venue fees on both legs plus impact on both legs; network fees are NOT in here —
       they are gates 19/20's business and `frictionXFor` is the position's. */
    roundTripLossPct: pctOf(spend - sellBack, spend),
    reserveKnown: state.reserveKnown === true,
    feeBps,
  };
}

/**
 * WHAT JUPITER'S OWN ENVELOPE WOULD HAVE PERMITTED — for the parity test, and for nothing
 * else. It is not imported by any live path and must not be.
 *
 * `jupiter.mjs:570` is the authority on the shape: the signed minimum output is
 * `quotedOut * (10_000 - slippageBps) / 10_000`, floor. So an exact-in order spends the
 * whole `amountRaw` and is only GUARANTEED `minOutputRaw` base units — the worst
 * admissible price is the full spend against the floor quantity, and it is a real price,
 * not a hypothetical: the order fills anywhere in that band without reverting.
 *
 * `baseOutRaw` defaults to `minOutputRaw`, which makes the answer exactly `amountRaw` —
 * the honest baseline. Pass our own contracted quantity to compare like with like.
 */
export function jupiterEquivalentWorstCost({ amountRaw, quotedOutRaw, slippageBps, baseOutRaw = null } = {}) {
  const amount = toBig(amountRaw, "amountRaw", { allowZero: false });
  const quoted = toBig(quotedOutRaw, "quotedOutRaw", { allowZero: false });
  const slip = Number(slippageBps);
  if (!Number.isInteger(slip) || slip < 0 || slip >= 10_000)
    throw new Error(`slippageBps must be an integer in [0, 10000), got ${slippageBps}`);
  const minOutputRaw = (quoted * BigInt(10_000 - slip)) / 10_000n;
  if (minOutputRaw <= 0n)
    throw new Error(`slippage ${slip} bps leaves no guaranteed output from a quote of ${quoted}`);
  const want = baseOutRaw === null ? minOutputRaw : toBig(baseOutRaw, "baseOutRaw", { allowZero: false });
  /* Ceil: the worst case rounds against us, like every other rounding in this lane. */
  const worstCostLamports = (amount * want + minOutputRaw - 1n) / minOutputRaw;
  return Object.freeze({
    amountRaw: amount,
    quotedOutRaw: quoted,
    slippageBps: slip,
    minOutputRaw,
    baseOutRaw: want,
    worstCostLamports,
    /* Diagnostics only, float, never a decision. */
    worstPricePerBase: pctOf(worstCostLamports, want),
    slippageHeadroomPct: pctOf(quoted - minOutputRaw, quoted),
  });
}

/**
 * DECODE OUR OWN BYTES BACK BEFORE THEY ARE SIGNED.
 *
 * This is the last fence, and today it is a closed one: no venue instruction layout is
 * verified in this repo, so unless the adapter carries a layout proof `snipe-venue.mjs`
 * accepts, this function REFUSES. That is not a placeholder — it is the rule. A guessed
 * discriminator or account order is not a best guess, it is a signed mistake, and the
 * observe lane recording "the encoder refused" is a far more useful row than a venue that
 * quietly produced nothing.
 *
 * When a proof does exist, the check is a round trip and nothing else: the adapter's own
 * `decodeBuyIx` reads the bytes back and the two numbers that bound the trade — the
 * quantity we contracted for and the absolute lamports we will pay for it — must match
 * EXACTLY, as BigInt. An `expected` carrying any slippage term is refused outright: this
 * envelope has no such field, and one arriving here means a caller has mixed the two
 * lanes' vocabularies.
 */
export function assertSnipeInstruction(ix, expected, adapter) {
  const detailBase = { venueId: isPlainObject(adapter) && isStr(adapter.id) ? adapter.id : null };
  const refuse = (message, extra = {}) => {
    throw new SnipeEntryRefusal("instruction_mismatch", message, { ...detailBase, ...extra });
  };

  const verdict = venueContract(adapter, { execute: true });
  if (!verdict.ok)
    refuse(`venue ${detailBase.venueId ?? "(unnamed)"} may not encode an entry: ${verdict.detail.message}` +
      " — an unverified venue is an entry refusal, not a best guess", { clause: verdict.clause });

  if (!isPlainObject(expected)) refuse("assertSnipeInstruction needs an expected envelope");
  for (const banned of ["slippageBps", "slippage", "tolerance", "minOutputRaw"])
    if (expected[banned] !== undefined && Number(expected[banned]) !== 0)
      refuse(`the snipe entry envelope carries no ${banned}; a ceiling is not a tolerance` +
        ` (received ${JSON.stringify(expected[banned])})`, { field: banned });

  let wantBase; let wantCost;
  try {
    wantBase = toBig(expected.baseOutRaw, "expected.baseOutRaw", { allowZero: false });
    wantCost = toBig(expected.maxQuoteInRaw, "expected.maxQuoteInRaw", { allowZero: false });
  } catch (error) { refuse(`expected envelope is malformed: ${error.message}`); }

  const program = programIdOf(ix);
  if (!program) refuse("the instruction carries no program id");
  if (program !== adapter.programId)
    refuse(`the instruction targets program ${program}, not venue ${adapter.id}'s ${adapter.programId}`,
      { programId: program });

  let decoded;
  try { decoded = adapter.decodeBuyIx(ix, expected); }
  catch (error) { refuse(`decodeBuyIx refused our own bytes: ${error.message}`); }
  if (!isPlainObject(decoded)) refuse("decodeBuyIx returned no fields to compare");

  let gotBase; let gotCost;
  try {
    gotBase = toBig(decoded.baseOutRaw, "decoded.baseOutRaw", { allowZero: false });
    gotCost = toBig(decoded.maxQuoteInRaw, "decoded.maxQuoteInRaw", { allowZero: false });
  } catch (error) { refuse(`decodeBuyIx returned a malformed field: ${error.message}`); }

  if (gotBase !== wantBase)
    refuse(`the encoded quantity is ${gotBase} base units, not the ${wantBase} this entry planned`,
      { encodedBaseOutRaw: gotBase, expectedBaseOutRaw: wantBase });
  if (gotCost !== wantCost)
    refuse(`the encoded ceiling is ${gotCost} lamports, not the ${wantCost} this entry planned`,
      { encodedMaxQuoteInRaw: gotCost, expectedMaxQuoteInRaw: wantCost });

  return Object.freeze({
    ok: true,
    venueId: adapter.id,
    programId: adapter.programId,
    baseOutRaw: gotBase,
    maxQuoteInRaw: gotCost,
    layoutProvedBy: verdict.detail.provedBy ?? null,
  });
}

/* ── the gates themselves ──────────────────────────────────────────────────────────
 *
 * Each one is a function of the prepared context and returns null to pass, or a detail
 * object to refuse. They never throw: a throw inside a gate would skip the gates below
 * it and the refusal would be reported under whatever code happened to be running, which
 * is the failure mode the ordered list exists to prevent.
 */
const GATE_IMPLS = Object.freeze({
  lane_off: (c) => (c.lane === "observe" || c.lane === "execute" ? null : {
    message: `SNIPE_LANE is "${c.lane}" — the sniper lane is not armed`,
  }),

  venue_not_enabled: (c) => {
    const verdict = venueContract(c.adapter, { execute: c.lane === "execute" });
    return verdict.ok ? null : { message: verdict.detail.message, clause: verdict.clause };
  },

  /* Both sentinels are read as strict booleans. `controlActive` in the poller answers a
     boolean; anything else arriving here is a caller that has not looked, and an
     unchecked sentinel is not the same fact as an absent one. */
  hard_stop: (c) => (c.control.hardStop === false ? null : {
    message: c.control.hardStop === true
      ? "the HARD STOP sentinel is present — no automated entry may be taken"
      : `the HARD STOP sentinel was not checked (received ${JSON.stringify(c.control.hardStop)})`,
  }),
  pause_entries: (c) => (c.control.pauseEntries === false ? null : {
    message: c.control.pauseEntries === true
      ? "the PAUSE ENTRIES sentinel is present — new positions are paused"
      : `the PAUSE ENTRIES sentinel was not checked (received ${JSON.stringify(c.control.pauseEntries)})`,
  }),

  /* F3: a landed-and-reverted race has ALREADY consumed this budget — journal.mjs rolls
     every attempt_fee_event into deployedTodaySol. Nothing new is charged here; the gate
     only refuses to exceed what the day has left. */
  daily_capacity: (c) => {
    /* The ticket is read here first because this is the first gate that needs a NUMBER
       out of the config rather than a switch. A malformed maxSolPerTrade refused four
       gates later, under an internal-invariant message, would name the wrong fact. */
    if (!Number.isFinite(c.ticketSol) || c.ticketSol <= 0)
      return { message: `cfg.maxSolPerTrade is not a usable ticket size (received ` +
        `${JSON.stringify(c.cfg.maxSolPerTrade)}${c.ticketError ? `: ${c.ticketError}` : ""})` };
    if (!Number.isFinite(c.dailySolCap) || c.dailySolCap <= 0)
      return { message: `dailySolCap is not configured (received ${JSON.stringify(c.cfg.dailySolCap)})` };
    const deployed = Number(c.book.deployedTodaySol);
    if (!Number.isFinite(deployed) || deployed < 0)
      return { message: `deployedTodaySol is unreadable (received ${JSON.stringify(c.book.deployedTodaySol)})` };
    const after = deployed + c.ticketSol;
    return after > c.dailySolCap + 1e-12 ? {
      message: `this ${c.ticketSol} SOL ticket would take the day to ${after.toFixed(6)} SOL against a ` +
        `${c.dailySolCap} SOL cap (already deployed ${deployed.toFixed(6)}, reverted-race fees included)`,
      deployedTodaySol: deployed, wouldBeSol: after,
    } : null;
  },

  /* THE LANE'S LATENCY IS UNMEASURED (spec §7.8) and this gate will not invent a number
     for it. A lane with no staleness bound is not armed; observe mode sets one, and the
     log is what will eventually justify it. */
  notice_stale: (c) => {
    if (!Number.isFinite(c.nowMs) || c.nowMs <= 0)
      return { message: `no clock was supplied (nowMs ${JSON.stringify(c.nowMs)}) — a gate cannot date a notice without one` };
    const maxMs = Number(c.cfg.noticeMaxMs);
    if (!Number.isFinite(maxMs) || maxMs <= 0)
      return { message: "noticeMaxMs is not configured, and this lane's notice-to-signature latency is " +
        "unmeasured — a t=0 gate with no staleness bound is not a gate" };
    const at = Number(c.notice.noticeAt);
    if (!Number.isFinite(at) || at <= 0)
      return { message: `notice carries no arrival time (received ${JSON.stringify(c.notice.noticeAt)})` };
    const ageMs = c.nowMs - at;
    if (ageMs < 0)
      return { message: `notice is stamped ${-ageMs}ms in the future — a clock disagreement, not a launch`, ageMs };
    return ageMs > maxMs
      ? { message: `notice is ${ageMs}ms old against a ${maxMs}ms bound`, ageMs } : null;
  },

  /* TWO BOOKS, and this gate reads both. S.snipes is separate from S.positions by
     construction (openList() is Object.values(S.positions) and cannot see a snipe), so
     "am I already in this mint" is the one question that has to consult both by hand. */
  already_holding: (c) => {
    if (c.book.snipes === undefined || c.book.positions === undefined)
      return { message: "the book was not supplied: both S.snipes and S.positions must be checked, " +
        "because the two books are separate by design and neither one answers for the other" };
    if (c.holds(c.book.snipes)) return { message: `already holding ${c.mint} in the snipe book` };
    if (c.holds(c.book.positions)) return { message: `already holding ${c.mint} in the desk book` };
    return null;
  },

  already_attempted: (c) => (c.holds(c.book.attempts)
    ? { message: `an entry attempt for ${c.mint} already exists in this window` } : null),

  curve_unreadable: (c) => (c.curveError
    ? { message: `the bonding curve account did not decode: ${c.curveError}` }
    : c.state ? null : { message: "no bonding curve was supplied for this mint" }),

  /* REFUSE, NEVER APPROXIMATE. Three distinct ways a decoded row can be a shape this lane
     does not understand, and every one of them is a refusal rather than a repair:
       - the adapter declares which curve types it supports and this is not one;
       - held = vBase - realBase does not resolve, so the curve's own completion point is
         unknown (snipeCurveState reports null rather than inventing it);
       - the REAL quote reserve is unknown, which makes every mark off this state an UPPER
         BOUND. An upper-bound mark is not a price, and this lane may not enter a position
         it can only over-value. */
  curve_type_unsupported: (c) => {
    const supported = Array.isArray(c.adapter?.supportedCurveTypes) ? c.adapter.supportedCurveTypes : null;
    if (supported && !supported.includes(c.state.curveType))
      return { message: `venue ${c.adapter.id} does not support curve type ${JSON.stringify(c.state.curveType)}` +
        ` (supports ${supported.join(", ")})`, curveType: c.state.curveType };
    if (c.state.heldBaseRaw === null)
      return { message: "the curve's held base reserve does not resolve (realBase >= vBase) — " +
        "this is not a shape this lane understands, and approximating one is how a rug gets bought" };
    if (c.state.reserveKnown !== true)
      return { message: "the curve's REAL quote reserve is unknown, so every mark off it is an upper " +
        "bound rather than a price — virtual reserves quote SOL a fresh curve does not hold" };
    return null;
  },

  curve_already_complete: (c) => {
    const complete = typeof c.adapter?.isComplete === "function"
      ? c.adapter.isComplete(c.state) === true : c.state.complete === true;
    if (complete) return { message: "the curve is already complete — this is a graduation, not a launch" };
    if (c.state.quoteToCompleteRaw !== null && c.state.quoteToCompleteRaw === 0n)
      return { message: "the curve owes nothing more before it completes — this is not a launch" };
    return null;
  },

  /* WE MAY NOT ENTER WHAT WE CANNOT EXIT. Two separate facts, both required: the adapter
     must name a route out, AND the ruler must actually evaluate on these bytes. A sell
     simulation that throws is an entry refusal here, never a hold later — a hold is what
     you do when you have a position. */
  exit_route_unimplemented: (c) => {
    let route = null;
    try { route = typeof c.adapter?.exitRoute === "function" ? c.adapter.exitRoute(null, c.mint) : null; }
    catch (error) { return { message: `the venue could not name an exit route: ${error.message}` }; }
    if (route && route.via !== "curve" && route.via !== "jupiter")
      return { message: `venue ${c.adapter.id} reports exit route ${JSON.stringify(route.via)}` +
        `${route.reason ? ` (${route.reason})` : ""}, which this lane cannot execute`, route: route.via };
    if (c.planError)
      return { message: `the exit could not be simulated on these bytes: ${c.planError}` };
    if (!c.plan || !c.plan.deliverable)
      return { message: "the curve cannot quote a round trip at this ticket — " +
        "the sniper may not enter a venue it cannot exit" };
    return null;
  },

  mint_refused: (c) => c.mintVerdict,

  impact_over_cap: (c) => (c.plan.impactOverCap ? {
    message: `price impact ${c.plan.impactPct?.toFixed(4)}% exceeds the ${c.cfg.maxPriceImpactPct}% cap ` +
      `at every rung down to ${Number(c.plan.spendLamports) / LAMPORTS_PER_SOL} SOL ` +
      `(${c.plan.rungs.length} rung${c.plan.rungs.length === 1 ? "" : "s"} tried)`,
    impactPct: c.plan.impactPct,
  } : null),

  round_trip_over_cap: (c) => (c.plan.roundTripOverCap ? {
    message: `an immediate round trip loses ${c.plan.roundTripLossPct?.toFixed(4)}% against the ` +
      `${c.cfg.maxEntryRoundTripLossPct}% cap at every rung tried`,
    roundTripLossPct: c.plan.roundTripLossPct,
  } : null),

  /* THE FLOOR IS DERIVED, NEVER DIALED. snipeFloor inverts the frozen sizing function, so
     this gate moves when the rails move and nobody has to remember to edit it. At the live
     cap it passes exactly: stopFrac 0.8000, minViableSol 0.005000 against a 0.005 ticket.
     A tighter stop is not safer, it is unfundable. */
  stop_floor: (c) => {
    let floor;
    try { floor = snipeFloor({ cfg: c.cfg, sol: c.ticketSol }); }
    catch (error) { return { message: `the stop floor could not be derived: ${error.message}` }; }
    return floor.minViableSol > c.ticketSol + 1e-12 ? {
      message: `the frozen fee rail needs ${floor.minViableSol.toFixed(6)} SOL to carry a ` +
        `${floor.stopFrac.toFixed(4)} stop, and this ticket is ${c.ticketSol.toFixed(6)} SOL`,
      stopFrac: floor.stopFrac, floorMarkX: floor.floorMarkX, minViableSol: floor.minViableSol,
    } : null;
  },

  /* THE LADDER REFUSES AT THE BOTTOM, on a wallet fact rather than a routing one: a
     position under the minimum viable size is not a smaller bet, it is the same fixed
     network fees against less upside. */
  size_under_minimum: (c) => {
    if (!c.plan.deliverable || c.plan.baseOutRaw <= 0n)
      return { message: `the ticket buys nothing at this state (baseOut ${c.plan.baseOutRaw})` };
    const chosenSol = Number(c.plan.spendLamports) / LAMPORTS_PER_SOL;
    let minViable;
    try { minViable = snipeFloor({ cfg: c.cfg, sol: c.ticketSol }).minViableSol; }
    catch (error) { return { message: `the minimum viable size could not be derived: ${error.message}` }; }
    return chosenSol < minViable - 1e-12 ? {
      message: `the ladder had to come down to ${chosenSol.toFixed(6)} SOL to clear the cost caps, ` +
        `which is under the ${minViable.toFixed(6)} SOL minimum viable size`,
      chosenSol, minViableSol: minViable, halvings: c.plan.halvings,
    } : null;
  },

  creator_profile: (c) => proxyGate(c, "creator_profile", {
    measured: c.creator.shareOfSupplyPct,
    threshold: Number(c.cfg.maxCreatorSharePct),
    describe: (m, t) => `the deployer holds ${m?.toFixed(4)}% of supply against a ${t}% bar`,
    extra: () => {
      const prior = Number(c.cfg.maxCreatorPriorLaunches);
      if (!Number.isFinite(prior)) return null;
      const n = Number(c.creator.priorLaunches);
      if (!Number.isFinite(n))
        return { message: "maxCreatorPriorLaunches is set but the deployer's launch history was not measured" };
      return n > prior ? { message: `the deployer has ${n} prior launches against a ${prior} bar`, priorLaunches: n } : null;
    },
  }),

  launch_share: (c) => proxyGate(c, "launch_share", {
    measured: c.launchSharePct,
    threshold: Number(c.cfg.maxLaunchSharePct),
    describe: (m, t) => `${m?.toFixed(4)}% of the curve's opening quote has already been bought, against a ${t}% bar`,
  }),

  /* The lifted fee budget, run TWICE so the two refusals keep their own names: once with
     rent zeroed (non-rent fees against maxNetworkFeeLamports and maxNetworkFeePct), once
     whole (rent against maxRentLamports). At the live size the PCT limb binds first —
     10% of a 5,000,000-lamport basis is 500,000 lamports, a quarter of the 2,000,000
     absolute cap — which is the measured reason round-trip friction is bounded at ~1.20x
     rather than merely estimated there. */
  network_fee_over_cap: (c) => feeGate(c, { includeRent: false }),
  rent_over_cap: (c) => feeGate(c, { includeRent: true }),

  instruction_mismatch: (c) => {
    if (c.instruction === null) {
      if (c.lane === "execute")
        return { message: "no instruction was supplied to decode back, and nothing may be signed on this " +
          "lane without a round-trip check of our own bytes" };
      /* Observe mode with no encoder output is the ordinary shadow row: the lane records
         what it WOULD have signed only when the adapter can produce it. */
      return null;
    }
    try {
      const proved = assertSnipeInstruction(c.instruction, {
        baseOutRaw: c.plan.baseOutRaw, maxQuoteInRaw: c.plan.maxQuoteInRaw,
        mint: c.mint, wallet: c.notice.wallet ?? null,
      }, c.adapter);
      c.trace.instruction = proved;
      return null;
    } catch (error) { return { message: error.message, clause: error.detail?.clause ?? null }; }
  },
});

/** The two proxy gates share one shape: always measure, kill only when a threshold has
 *  been set, and refuse a threshold that has nothing to judge. */
function proxyGate(c, gate, { measured, threshold, describe, extra = null }) {
  c.trace.measured[gate] = measured ?? null;
  const hasThreshold = Number.isFinite(threshold);
  if (hasThreshold) {
    if (!Number.isFinite(measured))
      return { message: `a ${gate} threshold of ${threshold} is configured but the fact was not measured ` +
        "for this launch — unverified is not safe", measured: null, threshold };
    if (measured > threshold)
      return { message: describe(measured, threshold), measured, threshold };
  }
  return extra ? extra() : null;
}

function feeGate(c, { includeRent }) {
  const basis = c.plan.maxQuoteInRaw;
  if (basis <= 0n) return { message: "there is no fee basis: the entry ceiling is zero lamports" };
  try {
    const budget = assertNetworkFeeBudget({
      signatureFeeLamports: c.fees.signatureFeeLamports ?? 0,
      prioritizationFeeLamports: c.fees.prioritizationFeeLamports ?? 0,
      rentFeeLamports: includeRent ? (c.fees.rentFeeLamports ?? 0) : 0,
      feeBasisLamports: basis,
      cfg: c.cfg,
    });
    if (includeRent) c.trace.feeBudget = budget;
    return null;
  } catch (error) {
    /* The two limbs are separated by which run threw. The rent limb only ever fires on
       the second run, because the first zeroes rent. */
    return { message: error.message, feeBasisLamports: basis.toString() };
  }
}

/* The list above and the ordered array must never drift. Asserted at import, so a
   mismatch is a boot failure in every process that loads this file rather than a gate
   silently not running. */
{
  const impls = Object.keys(GATE_IMPLS);
  if (impls.length !== SNIPE_GATES.length || impls.some((g, i) => g !== SNIPE_GATES[i]))
    throw new Error(`snipe-entry gate implementations (${impls.join(", ")}) do not match SNIPE_GATES ` +
      `(${SNIPE_GATES.join(", ")}) in name or in order`);
  let cost = -1;
  for (const gate of SNIPE_GATES) {
    const tier = SNIPE_GATE_COST[gate];
    if (!Number.isInteger(tier)) throw new Error(`snipe gate ${gate} has no cost tier`);
    if (tier < cost) throw new Error(`snipe gate ${gate} (cost ${tier}) runs after a cost-${cost} gate — ` +
      "the cheapest check must come first");
    cost = tier;
  }
}

/** Does a book-shaped collection contain this mint? Accepts a Set, a Map, an array of
 *  strings, or an array/object of position records keyed or fielded by mint — the two
 *  books are held differently and neither shape may be assumed here. */
function holderFor(mint) {
  return (collection) => {
    if (!collection) return false;
    if (collection instanceof Set) return collection.has(mint);
    if (collection instanceof Map) return collection.has(mint);
    const values = Array.isArray(collection) ? collection
      : isPlainObject(collection) ? (Object.prototype.hasOwnProperty.call(collection, mint) ? [mint] : Object.values(collection))
        : [];
    return values.some((v) => (typeof v === "string" ? v === mint : isPlainObject(v) && v.mint === mint));
  };
}

/**
 * MAY THIS LAUNCH BE ENTERED RIGHT NOW, AND IF NOT, WHICH GATE SAYS NO?
 *
 * @param {object} args
 * @param {object} args.notice   the launch notice: {mint, creator, slot, noticeAt, source}
 * @param {object} args.curve    the adapter's decoded curve, or a `snipeCurveState` result
 * @param {object} args.adapter  the venue adapter (snipe-venue.mjs contract)
 * @param {object} args.cfg      the SNIPE_* config — never the desk's CFG object
 * @param {object} args.book     {snipes, positions, attempts, deployedTodaySol}
 * @param {number} args.nowMs    the caller's clock. There is none in here.
 * @param {object} [args.control] {hardStop, pauseEntries} — strict booleans, both required
 * @param {object} [args.mint]    the mint account, either raw (auditMintAccount's input)
 *                                or the jsonParsed record `src/data/solana.js mintInfo()`
 *                                returns. Read on the SAME getMultipleAccounts as the curve.
 * @param {object} [args.creator] {shareOfSupplyPct, priorLaunches} — the statistical layer
 * @param {object} [args.fees]    {signatureFeeLamports, prioritizationFeeLamports, rentFeeLamports}
 * @param {object} [args.instruction] the buy instruction to decode back, when one exists
 *
 * @returns {{ok, gate, detail, trace}} — `gate` is null on a pass and names the FIRST
 *   refusal otherwise. `trace` is the ordered record of every gate evaluated, which is
 *   what a shadow row stores; it ends at the refusal, because nothing below it ran.
 */
export function snipeContract({
  notice = {}, curve = null, adapter = null, cfg = {}, book = {}, nowMs = null,
  control = {}, mint: mintAccount = null, creator = {}, fees = {}, instruction = null,
} = {}) {
  const lane = isStr(cfg.lane) ? cfg.lane.trim() : "off";
  const mint = isStr(notice.mint) ? notice.mint.trim() : null;

  /* Everything below is computed ONCE, before any gate runs, and every failure is caught
     and carried as a string rather than thrown — a gate that throws would skip the gates
     under it and mis-name the refusal. */
  let ticketSol = NaN; let ticketLamports = 0n; let ticketError = null;
  try { ticketLamports = solToLamports(cfg.maxSolPerTrade, "cfg.maxSolPerTrade"); ticketSol = Number(cfg.maxSolPerTrade); }
  catch (error) { ticketError = error.message; }

  let state = null; let curveError = null;
  try { state = curve === null ? null : (curve.k !== undefined ? curve : snipeCurveState(curve)); }
  catch (error) { curveError = error.message; }

  let plan = null; let planError = null;
  if (state && ticketLamports > 0n) {
    try { plan = planSnipeCeiling({ curve: state, adapter, solLamports: ticketLamports, cfg }); }
    catch (error) { planError = error.message; }
  } else if (ticketError) planError = ticketError;

  const ctx = {
    lane, mint, notice, adapter, cfg, book, control, fees, instruction,
    nowMs: Number(nowMs),
    ticketSol, ticketLamports, ticketError,
    dailySolCap: Number(cfg.dailySolCap),
    state, curveError, plan, planError,
    creator: isPlainObject(creator) ? creator : {},
    launchSharePct: state && state.vQuote0Raw !== null && state.realQuoteRaw !== null
      ? pctOf(state.realQuoteRaw, state.vQuote0Raw) : null,
    mintVerdict: judgeMint(mintAccount, mint),
    holds: holderFor(mint),
    trace: { measured: {}, instruction: null, feeBudget: null },
  };

  const steps = [];
  for (const gate of SNIPE_GATES) {
    /* A gate below `size_under_minimum` needs a plan; if there is none the refusal has
       already been named above, and reaching here without one is a contract violation
       rather than a market fact. Fail closed and say which invariant broke. */
    if (!ctx.plan && SNIPE_GATE_COST[gate] >= 2) {
      steps.push({ gate, ok: false, cost: SNIPE_GATE_COST[gate] });
      return frozenVerdict(false, gate, {
        message: `no entry plan exists at gate ${gate}${planError ? `: ${planError}` : ""} — ` +
          "a cost-2 gate ran without the arithmetic it judges",
        mint, lane, planError,
      }, steps, ctx);
    }
    let failure = null;
    try { failure = GATE_IMPLS[gate](ctx); }
    catch (error) { failure = { message: `gate ${gate} could not be evaluated: ${error.message}` }; }
    steps.push({ gate, ok: failure === null, cost: SNIPE_GATE_COST[gate] });
    if (failure) return frozenVerdict(false, gate, { mint, lane, ...failure }, steps, ctx);
  }
  return frozenVerdict(true, null, {
    mint, lane,
    message: `${mint} clears all ${SNIPE_GATES.length} snipe gates`,
  }, steps, ctx);
}

function frozenVerdict(ok, gate, detail, steps, ctx) {
  return Object.freeze({
    ok,
    gate,
    detail: Object.freeze({
      version: SNIPE_ENTRY_VERSION,
      ticketSol: ctx.ticketSol,
      ticketLamports: ctx.ticketLamports,
      baseOutRaw: ctx.plan?.baseOutRaw ?? null,
      maxQuoteInRaw: ctx.plan?.maxQuoteInRaw ?? null,
      impactPct: ctx.plan?.impactPct ?? null,
      roundTripLossPct: ctx.plan?.roundTripLossPct ?? null,
      halvings: ctx.plan?.halvings ?? null,
      launchSharePct: ctx.launchSharePct,
      measured: Object.freeze({ ...ctx.trace.measured }),
      instruction: ctx.trace.instruction,
      feeBudget: ctx.trace.feeBudget,
      ...detail,
    }),
    /* The ordered trace, ending at the refusal. §6's shadow row stores this verbatim. */
    trace: Object.freeze(steps.map((s) => Object.freeze(s))),
  });
}

/**
 * THE MINT KILL SET — the desk's own facts, judged once, under one code.
 *
 * Two input shapes, one verdict, because the two processes read the mint two different
 * ways and neither reading may be the privileged one:
 *
 *   · a RAW account (owner + data) goes through the executor's `auditMintAccount`, which
 *     is the function that throws on the live money path. Its throw IS the refusal.
 *   · a jsonParsed record — the shape `src/data/solana.js mintInfo()` returns — is judged
 *     by flag name against the same allowlist, including that module's measured fix:
 *     `defaultAccountState` is a kill only when the default state is not "initialized".
 *
 * A live mint authority is a kill here and is NOT one in `auditMintAccount`, which is a
 * deliberate ADDITION rather than a disagreement: the desk already flags
 * `mint_authority_live` ("supply can still be inflated by …") and a lane that holds a
 * position for seconds at t=0 is the one place where an un-renounced supply is a live
 * hazard rather than a note. The 33 frozen SAFETY gates are untouched; sniper gates are
 * additive.
 */
function judgeMint(account, mint) {
  if (account === null || account === undefined)
    return { message: "no mint account was supplied — the kill set cannot be read, and unverified is not safe" };

  /* The raw path: whatever `auditMintAccount` refuses, this lane refuses. */
  if (account.data !== undefined && account.owner !== undefined && account.extensions === undefined) {
    let audit;
    try { audit = auditMintAccount(account, mint ?? "(unnamed mint)"); }
    catch (error) { return { message: error.message, source: "auditMintAccount" }; }
    if (audit.mintAuthority)
      return { message: `mint authority ${audit.mintAuthority} is live — supply can still be inflated`,
        flag: "mint_authority_live", source: "auditMintAccount" };
    if (audit.freezeAuthority)
      return { message: `freeze authority ${audit.freezeAuthority} is live — token accounts can be frozen, preventing sells`,
        flag: "freeze_authority_live", source: "auditMintAccount" };
    return null;
  }

  /* The jsonParsed path: the desk's own record, judged by name. */
  if (account.ok === false)
    return { message: `the mint account could not be read: ${account.error ?? "unknown error"}`, source: "mintInfo" };
  if (account.mintAuthority)
    return { message: `mint authority ${account.mintAuthority} is live — supply can still be inflated`,
      flag: "mint_authority_live", source: "mintInfo" };
  if (account.freezeAuthority)
    return { message: `freeze authority ${account.freezeAuthority} is live — token accounts can be frozen, preventing sells`,
      flag: "freeze_authority_live", source: "mintInfo" };
  const detail = Array.isArray(account.extensionDetail) ? account.extensionDetail
    : Array.isArray(account.extensions) ? account.extensions.map((name) => ({ extension: name })) : [];
  for (const e of detail) {
    const name = isPlainObject(e) ? e.extension : e;
    if (name === "defaultAccountState") {
      const st = e?.state?.accountState ?? null;
      if (st !== "initialized")
        return { message: `new token accounts open in state ${JSON.stringify(st)} — a buyer may be unable to sell`,
          flag: "ext_defaultAccountState", source: "mintInfo" };
      continue;
    }
    if (!SNIPE_ALLOWED_EXTENSIONS.has(name))
      return { message: `mint extension ${name} is outside the bot's acceptance set`,
        flag: `ext_${name}`, source: "mintInfo" };
  }
  if (Array.isArray(account.botRefusals) && account.botRefusals.length)
    return { message: account.botRefusals.join("; "), flag: "bot_mint_refusal", source: "mintInfo" };
  const decimals = account.decimals;
  if (!(Number.isInteger(decimals) && decimals >= 0 && decimals <= 18))
    return { message: `decimals ${decimals} is outside the executor's 0-18 range`,
      flag: "bot_mint_refusal", source: "mintInfo" };
  return null;
}
