/**
 * SIZE TO THE ROUTE INSTEAD OF REFUSING IT.
 *
 * Three of the entry gates are not judgements about the COIN at all — they are
 * judgements about the AMOUNT going through the pool:
 *
 *   1. the round-trip loss cap        (jupiter.mjs preflightEntry, maxEntryRoundTripLossPct = 12%)
 *   2. the entry price-impact cap     (jupiter.mjs validateOrderEnvelope, maxPriceImpactPct = 5%)
 *   3. the executable-cost stop floor (poller.mjs: conservative return <= the authored stop)
 *
 * All three were binary. A 0.4 SOL clip that costs 14% round trip through a thin pool was
 * thrown away whole, and the throw landed on the acknowledge branch in poller.mjs — the
 * call was consumed permanently, with no retry — even though the same pool at 0.1 SOL
 * costs 3% and would have cleared every one of them. That is a HOW MUCH judgement being
 * spent as a WHETHER veto.
 *
 * The owner's rule (2026-09-07) says the desk decides WHAT and WHEN and the bot decides
 * HOW MUCH, and nothing here moves that line: the desk is not consulted, the caps are
 * unchanged, and every number below is this process's own. What changes is that a
 * cost-shaped refusal becomes a SMALLER FILL. The ladder re-quotes at half the amount at
 * most MAX_ROUTE_HALVINGS times and binds the trade to the largest amount that clears all
 * three gates at once. It refuses only at the bottom, where the answer stops being a
 * routing fact and becomes a wallet fact: a position under the minimum viable size is not
 * a smaller bet, it is the same fixed network fees against less upside.
 *
 * Halving is strictly the safe direction. Round-trip loss and price impact are monotone
 * in size for any real AMM curve, so a candidate that clears the caps is cheaper than the
 * one above it that did not; and the sizing rails in strategy.mjs run again afterwards
 * against the cost actually measured, so the ladder can only ever lower the amount.
 */

/* Three halvings takes 0.4 SOL to 0.05 — already under the 0.0625 SOL fee floor a 16%
   stop implies at the 500k-lamport cost model, so the wallet floor bites first in
   practice and this bound exists to keep the quote budget finite rather than to shape
   the outcome. Four quotes at 2 legs each is the worst case per entry. */
export const MAX_ROUTE_HALVINGS = 3;

/**
 * The round trip as it would actually execute: the reverse quote, haircut by slippage on
 * BOTH legs, less the worst-case network fees of both legs. This is the arithmetic that
 * used to sit inline in poller.mjs onEntry; it moved here so the ladder can evaluate it
 * at every candidate amount rather than once at the desk's clip.
 *
 * `expectedNetworkFeeLamports` is the COST MODEL (500_000), never the refusal gate
 * (maxNetworkFeeLamports, 2_000_000). The two point opposite ways and coupling them
 * would refuse every trade — see test-fee-gate-split.mjs.
 */
export function executableEntryCost({ reverseOutputRaw, amountRaw, expectedNetworkFeeLamports, slippageBps }) {
  const input = BigInt(amountRaw);
  if (input <= 0n) throw new Error("executable entry cost needs a positive input amount");
  const executableReturnRatio = Number(BigInt(reverseOutputRaw) * 1_000_000n / input) / 1_000_000;
  const worstFeeRatio = 2 * expectedNetworkFeeLamports / Number(input);
  const slippageHaircut = (1 - slippageBps / 10_000) ** 2;
  const conservativeReturnRatio = executableReturnRatio * slippageHaircut - worstFeeRatio;
  return { executableReturnRatio, worstFeeRatio, slippageHaircut, conservativeReturnRatio };
}

/* Say the NUMBERS, not just the verdict — and say WHICH term dominated. Four consecutive
   refusals on this line once told us nothing about which side was wrong: a desk authoring
   stops too tight for a coin's real liquidity, or a reconstruction too pessimistic to ever
   pass. A message that only names "the authored stop" sends the reader to the desk for a
   problem that lives in this file. Wording preserved verbatim from poller.mjs. */
export function stopFloorRefusal({ cost, lossPct, stopRatio }) {
  const { executableReturnRatio, worstFeeRatio, slippageHaircut, conservativeReturnRatio } = cost;
  return `entry round trip plus worst-case fees is already at/below the authored stop ` +
    `[dominant term: ${worstFeeRatio > (1 - executableReturnRatio * slippageHaircut) ? "the fee model" : "the measured round trip"}] ` +
    `(measured round trip ${Number(lossPct ?? 0).toFixed(2)}% → executable ${(executableReturnRatio * 100).toFixed(2)}%; ` +
    `slippage haircut ${((1 - slippageHaircut) * 100).toFixed(2)}%, worst-case fees ${(worstFeeRatio * 100).toFixed(2)}%; ` +
    `conservative return ${(conservativeReturnRatio * 100).toFixed(2)}% vs stop at ${(stopRatio * 100).toFixed(2)}% of entry)`;
}

const rung = (a) => `${a.sol.toFixed(4)} SOL (round trip ${a.lossPct.toFixed(2)}%, ` +
  `impact ${a.impactPct.toFixed(2)}%, conservative return ${(a.conservativeReturnRatio * 100).toFixed(2)}%)`;

/**
 * Walk the halving ladder and bind the entry to the largest amount that clears all three
 * cost gates.
 *
 * @param probe        (amountRawString) => jupiter.preflightEntryProbe(...) — measures one
 *                     amount and REPORTS its cap breaches instead of throwing.
 * @param minSizeFor   (conservativeLossPct) => the minimum viable size in SOL at that
 *                     friction. strategy.mjs minViableSolPerTrade, so the floor the ladder
 *                     stops at is the identical number planEntry would refuse under.
 * @returns { ok:true, sol, amountRaw, preflight, cost, conservativeLossPct, sizedDown,
 *            reason, attempts } or { ok:false, refusal, attempts }.
 */
export async function sizeEntryToRoute({
  probe, sol, lamportsPerSol, stopRatio, expectedNetworkFeeLamports, slippageBps,
  minSizeFor, maxHalvings = MAX_ROUTE_HALVINGS,
  /* "enforce" (default): a route whose costs already sit at or below the authored stop is
     refused. "advisory" (ENTRY_MODE=take-every-call): the same verdict is returned as
     `advisory` text on a successful sizing and the call is taken — the owner's choice.
     The route's own caps (round-trip loss, price impact) are never advisory. */
  stopFloor = "enforce",
}) {
  if (stopFloor !== "enforce" && stopFloor !== "advisory")
    throw new Error(`stopFloor must be "enforce" or "advisory", got ${JSON.stringify(stopFloor)}`);
  let candidate = Number(sol);
  if (!Number.isFinite(candidate) || candidate <= 0)
    throw new Error("route sizing needs a positive starting size");
  const attempts = [];
  for (let halvings = 0; halvings <= maxHalvings; halvings++) {
    const amountRaw = BigInt(Math.floor(candidate * lamportsPerSol));
    if (amountRaw <= 0n)
      return { ok: false, attempts, refusal: "route sizing fell to zero lamports before clearing the caps" };
    const preflight = await probe(amountRaw.toString());
    const cost = executableEntryCost({ reverseOutputRaw: preflight.reverse.outAmount,
      amountRaw, expectedNetworkFeeLamports, slippageBps });
    /* The friction the rails must charge is the WORSE of the two measurements: the raw
       round trip, and the round trip after the slippage haircut and both fees. */
    const conservativeLossPct = Math.max(preflight.lossPct, (1 - cost.conservativeReturnRatio) * 100);
    const minSize = minSizeFor(conservativeLossPct);
    const stopFloorHit = cost.conservativeReturnRatio <= stopRatio
      ? stopFloorRefusal({ cost, lossPct: preflight.lossPct, stopRatio }) : null;
    const refusal = preflight.refusal ?? (stopFloor === "enforce" ? stopFloorHit : null);
    const advisory = stopFloor === "advisory" && !preflight.refusal ? stopFloorHit : null;
    const attempt = { sol: candidate, amountRaw, halvings, lossPct: preflight.lossPct,
      impactPct: preflight.impactPct, conservativeReturnRatio: cost.conservativeReturnRatio,
      conservativeLossPct, minSize, refusal, advisory };
    attempts.push(attempt);
    if (!refusal)
      return { ok: true, sol: candidate, amountRaw, preflight, cost, conservativeLossPct, advisory,
        minSize, attempts, halvings, sizedDown: halvings > 0,
        reason: halvings > 0
          ? `sized down by the route: ${attempts.map(rung).join(" → ")}`
          : null };
    const next = candidate / 2;
    if (next < minSize)
      return { ok: false, attempts,
        refusal: `${refusal} — re-quoted down the route at ${attempts.map(rung).join(" → ")}; ` +
          `half of ${candidate.toFixed(4)} SOL is under the ${minSize.toFixed(4)} SOL minimum viable ` +
          `position (below it the round trip is mostly fees), so no fundable size clears the caps` };
    if (halvings === maxHalvings)
      return { ok: false, attempts,
        refusal: `${refusal} — re-quoted down the route at ${attempts.map(rung).join(" → ")}; ` +
          `${maxHalvings} halvings did not bring it inside the caps` };
    candidate = next;
  }
  /* Unreachable: every path above returns. Kept explicit rather than falling off the end
     with `undefined`, which a caller would read as a silent buy. */
  return { ok: false, attempts, refusal: "route sizing ladder ended without a verdict" };
}
