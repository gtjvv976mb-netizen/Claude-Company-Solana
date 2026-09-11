/**
 * THE NETWORK-FEE CEILING, LIFTED OUT SO TWO LANES SHARE ONE DEFINITION.
 *
 * This is `validateOrderEnvelope`'s fee block moved verbatim out of jupiter.mjs and
 * nothing else. It is a LIFT, not a rewrite: same constants, same comparisons, same
 * message text, same fail-open and fail-closed corners. The desk path is expected to
 * keep behaving byte-for-byte as it did, and `test-network-fee-budget.mjs` proves that
 * by running the same inputs through `validateOrderEnvelope` and through this function
 * and asserting the two agree on both the verdict and the message string.
 *
 * The original, `executor/jupiter.mjs:172-186` as read on 2026-09-11:
 *
 *     const signatureFee = finite(order.signatureFeeLamports ?? 0, "signature fee");
 *     const priorityFee = finite(order.prioritizationFeeLamports ?? 0, "priority fee");
 *     const rentFee = finite(order.rentFeeLamports ?? 0, "rent fee");
 *     if ([signatureFee, priorityFee, rentFee].some((value) => value < 0))
 *       throw new Error("Jupiter returned a negative fee estimate");
 *     const networkFees = signatureFee + priorityFee;
 *     if (networkFees > cfg.maxNetworkFeeLamports)
 *       throw new Error(`non-rent network fees ${networkFees} lamports exceed cap ${cfg.maxNetworkFeeLamports}`);
 *     const feeBasis = BigInt(String(expected.feeBasisLamports ?? expected.amountRaw));
 *     const maxNetworkFeePct = Number(cfg.maxNetworkFeePct ?? 10);
 *     if (feeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
 *         BigInt(Math.ceil(networkFees)) * 10_000n > feeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
 *       throw new Error(`estimated network fees exceed ${maxNetworkFeePct}% of the trade basis`);
 *     if (rentFee > (cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS))
 *       throw new Error(`rent ${rentFee} lamports exceeds cap ${cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS}`);
 *
 * WHY LIFT IT AT ALL. The sniper lane has to answer the same question before it signs
 * (gates 18 `network_fee_over_cap` and 19 `rent_over_cap`) and it does not go through
 * Jupiter to get there — it builds its own venue instruction, so it never constructs a
 * Jupiter order envelope for `validateOrderEnvelope` to inspect. The alternative to a
 * lift is a second implementation of a live money gate, which is how two copies of one
 * ceiling drift apart; this repo already carries a test whose whole subject is four
 * copies of a cap that did exactly that (test-operator-max-parity.mjs). One definition,
 * two callers, and a differential test pinning them.
 *
 * WHAT THE 172-176 LINES ARE DOING HERE. The block at :177-186 is not standalone: it
 * consumes three already-normalised numbers. Rather than take the caller's word for
 * that, the normalisation comes with it, so this function is safe to hand raw envelope
 * fields. Called from `validateOrderEnvelope` after its own :172-176 the three checks
 * are exact no-ops — `finite()` of a finite number is that number, and a value already
 * proved non-negative stays non-negative — so the lift is still behaviour-neutral.
 *
 * TWO LIFTED QUIRKS, PRESERVED ON PURPOSE AND NAMED SO NOBODY RELIES ON THEM:
 *
 *   1. `networkFees > cfg.maxNetworkFeeLamports` is FALSE when the cap is undefined,
 *      because every comparison with undefined is false. A cfg with no
 *      `maxNetworkFeeLamports` therefore has no absolute lamport ceiling at all. That
 *      is the behaviour on the desk path today and changing it here would be a silent
 *      change to a live gate, so it stays. The percentage ceiling below still binds
 *      (it defaults to 10), which is why this has never been load-bearing. Any new
 *      caller — the sniper included — must pass a cfg with the cap set; the test
 *      asserts the quirk rather than pretending it is absent.
 *   2. A missing basis throws `Cannot convert undefined to a BigInt`, a SyntaxError
 *      from `BigInt("undefined")`, not a sentence of ours. Also lifted as-is: it fails
 *      closed, which is the direction that matters, and inventing a nicer message here
 *      would make this function and `validateOrderEnvelope` disagree.
 *
 * ARITHMETIC. The percentage test is exact integer arithmetic in BigInt on both sides —
 * `ceil(fees) * 10_000 > basis * floor(pct * 100)` — so it carries no float error at any
 * basis size. `pctOfBasis` in the returned record is a float and is REPORT ONLY: print
 * it, log it, put it in a shadow row, never re-derive a decision from it.
 *
 * MEASURED, AT THE LIVE SIZE (poller.mjs LIVE_LIMITS, read this pass): basis
 * 0.005 SOL = 5,000,000 lamports, `maxNetworkFeePct` 10, `maxNetworkFeeLamports`
 * 2,000,000. The percentage ceiling is 500,000 lamports — a quarter of the absolute
 * one — so at live size THE PERCENTAGE GATE BINDS and the lamport cap is slack. The
 * test derives both from poller.mjs source rather than restating them, and prints them.
 */

/* Gross creation rent for one temporary WSOL ATA plus one destination ATA, the default
 * when a cfg carries no `maxRentLamports`. This is the same 4,200,000 that jupiter.mjs
 * exports under this name and that poller.mjs LIVE_LIMITS imports from there; the test
 * reads jupiter.mjs as text and fails loudly if the two literals ever diverge. When the
 * wiring step deletes jupiter's copy it can re-export this one under the same name —
 * test-live-execution.mjs imports MAX_GROSS_RENT_LAMPORTS from jupiter.mjs. */
export const MAX_GROSS_RENT_LAMPORTS = 4_200_000;

/* Lifted from jupiter.mjs:84-88, character for character, because the message text is
   part of the behaviour this function promises to keep. */
const finite = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
  return number;
};

/**
 * Throw unless the fees a transaction is about to pay fit inside the cfg's ceilings.
 *
 * @param {object}  args
 * @param {number|string} [args.signatureFeeLamports=0]
 * @param {number|string} [args.prioritizationFeeLamports=0]
 * @param {number|string} [args.rentFeeLamports=0]
 * @param {bigint|number|string} args.feeBasisLamports  what the fees are charged
 *        against. The Jupiter caller passes `expected.feeBasisLamports ?? expected.amountRaw`;
 *        the sniper passes the lamports it is about to spend on the entry.
 * @param {object}  args.cfg  `maxNetworkFeeLamports`, `maxNetworkFeePct` (default 10),
 *        `maxRentLamports` (default MAX_GROSS_RENT_LAMPORTS).
 * @returns {Readonly<object>} the accepted figures, for the log line and the shadow row.
 *          The caller's arguments are never mutated.
 */
export function assertNetworkFeeBudget({
  signatureFeeLamports,
  prioritizationFeeLamports,
  rentFeeLamports,
  feeBasisLamports,
  cfg,
} = {}) {
  const signatureFee = finite(signatureFeeLamports ?? 0, "signature fee");
  const priorityFee = finite(prioritizationFeeLamports ?? 0, "priority fee");
  const rentFee = finite(rentFeeLamports ?? 0, "rent fee");
  if ([signatureFee, priorityFee, rentFee].some((value) => value < 0))
    throw new Error("Jupiter returned a negative fee estimate");
  const networkFees = signatureFee + priorityFee;
  if (networkFees > cfg.maxNetworkFeeLamports)
    throw new Error(`non-rent network fees ${networkFees} lamports exceed cap ${cfg.maxNetworkFeeLamports}`);
  const feeBasis = BigInt(String(feeBasisLamports));
  const maxNetworkFeePct = Number(cfg.maxNetworkFeePct ?? 10);
  if (feeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
      BigInt(Math.ceil(networkFees)) * 10_000n > feeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
    throw new Error(`estimated network fees exceed ${maxNetworkFeePct}% of the trade basis`);
  const maxRentLamports = cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS;
  if (rentFee > maxRentLamports)
    throw new Error(`rent ${rentFee} lamports exceeds cap ${maxRentLamports}`);
  return Object.freeze({
    signatureFeeLamports: signatureFee,
    prioritizationFeeLamports: priorityFee,
    rentFeeLamports: rentFee,
    networkFeeLamports: networkFees,
    feeBasisLamports: feeBasis,
    maxNetworkFeePct,
    maxRentLamports,
    /* The largest whole-lamport non-rent fee this basis admits, by the same integer
       arithmetic the gate used: the gate refuses when ceil(fees)*10_000 exceeds
       basis*floor(pct*100), so the last accepted integer is the floor of the quotient.
       Exact, BigInt, and the number a caller should size against. */
    networkFeeCeilingLamports: (feeBasis * BigInt(Math.floor(maxNetworkFeePct * 100))) / 10_000n,
    /* REPORT ONLY — float, for a log line. The decision above was integer. */
    pctOfBasis: feeBasis > 0n ? (networkFees / Number(feeBasis)) * 100 : Number.POSITIVE_INFINITY,
  });
}
