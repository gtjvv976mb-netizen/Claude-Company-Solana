/**
 * PUMP.FUN — the first venue adapter, and the first thing in this repo that reads a
 * program's own account bytes.
 *
 * It decodes. It quotes. IT SIGNS NOTHING, and the three methods that would emit program
 * bytes — buyIx, sellIx, decodeBuyIx — REFUSE by construction. That is not a stub waiting
 * to be filled in and it is not a configuration someone forgot to turn on: it is the
 * honest state of this repository, and snipe-venue.mjs's `layout_unverified` clause turns
 * it into an execute refusal that nobody has to remember to apply.
 *
 * ══ WHAT WAS MEASURED FOR THIS FILE, AND HOW IT WAS CHECKED ═══════════════════════════
 *
 * Every layout below was read off MAINNET on 2026-09-11 through the free public endpoint
 * https://api.mainnet-beta.solana.com and cross-checked against an answer known BEFORE
 * the read. Nothing here is copied from memory and nothing is a plausible guess. The
 * accounts and transactions are named in PUMPFUN_LAYOUT_EVIDENCE so a reviewer can re-run
 * every one of them.
 *
 *  1. THE BONDING CURVE ACCOUNT — proved against pump.fun's own feed row.
 *     Account CaLhPyhttKFHy2T6i12HCuqocFCCKuf49Z5QYpS3Fp77 (124 bytes, owner
 *     6EF8rre…F6P) for mint BjPvXGPq6aPvamzeJAhRF5HaTixY4zAtRti1WtSepump. Decoded at the
 *     offsets below it reads vTok 1,069,079,517,066,588 / vSol 30,110,014,725 / rTok
 *     789,179,517,066,588 / rSol 110,014,725 / supply 1e15 / complete false / creator
 *     4Uko6H1FMJVuxxDjtnkjvbTf3adLmny5tWdnwdgLXLkt — every single field equal to the row
 *     frontend-api-v3.pump.fun returned for that mint in the same minute. Six independent
 *     agreements is not a coincidence of offsets.
 *
 *  2. THE ACCOUNT DISCRIMINATOR IS DERIVED, NOT PASTED. sha256("account:BondingCurve")
 *     truncated to 8 bytes is 17b7f83760d8ac60, and that is byte-for-byte the first eight
 *     bytes of both real accounts read. The anchor convention is therefore validated here
 *     rather than assumed — which matters, because §6 below is a case where it fails.
 *
 *  3. THERE ARE TWO REAL ACCOUNT LENGTHS AND THE SHORT ONE HAS NO CREATOR.
 *     Account Cg14LaBKV4TrN253WmpA55LB9R9ec38HMcgPjyiFaM5i, for a GRADUATED coin, is
 *     49 bytes: discriminator, five u64s, `complete = 1`, and then nothing. So `creator`
 *     is read only when the account is long enough to hold one, and a 49-byte curve
 *     reports `creator: null` instead of reading 32 bytes past the end of the buffer.
 *
 *  4. A GRADUATED CURVE READS ALL ZEROS, AND THAT IS WHY `complete` IS CHECKED FIRST.
 *     That same 49-byte account carries vTok 0 / vSol 0 / rTok 0 / rSol 0 while pump.fun's
 *     feed still reports its pre-graduation reserves (vSol 115,005,360,585). A mark
 *     computed from those bytes is 0.0 — a FLOOR trigger manufactured out of a coin that
 *     merely graduated. `isComplete()` is therefore a structural fact the lane must read
 *     before it reads a price, exactly the ordering spec §2.5 puts GONE and FAULT above
 *     FLOOR for.
 *
 *  5. 115,005,360,585 − 30,000,000,000 = 85,005,360,585. The repo's own hand-worked
 *     fixture (test-pumpfun-curve.mjs, and the header of src/data/pumpfun-live.js) says a
 *     standard curve graduates at 85.005 SOL. That number fell out of an account this
 *     file decoded, from a completely different direction, to five decimal places. It is
 *     the strongest single piece of evidence that these offsets are right, and it is why
 *     test-snipe-venue-pumpfun.mjs re-derives it rather than asserting a constant.
 *
 *  6. THE INSTRUCTION NAMES ARE NOT WHAT AN IDL READER WOULD GUESS — AND THIS IS THE
 *     WHOLE REASON buyIx REFUSES. The live program no longer executes `buy`/`sell`/
 *     `create` on new launches; it executes CreateV2 / BuyV2 / SellV2. Measured:
 *       sha256("global:buy")    = 66063d1201daebea   ← appears in NO transaction sampled
 *       sha256("global:buy_v2") = b817ee6167c5d33d   ← the real BuyV2 instruction
 *       sha256("global:sell_v2")= 5df6823ce7e940b2   ← the real SellV2 instruction
 *     A confident adapter written from the obvious IDL name would have emitted a
 *     discriminator the program has stopped honouring. And the far worse half is that the
 *     ARGUMENT encoding is the easy part: the real BuyV2 carries 27 accounts and SellV2
 *     carries 26, in an order nothing in this repo has verified. A transposed account in
 *     a hand-built buy does not refuse — it signs, it lands, and the money goes somewhere
 *     nobody planned. So: `layoutVerified: false`, and the encoders throw.
 *
 *  7. THE FEE IS NOT A CONSTANT AND THE GLOBAL ACCOUNT IS NOT THE EXECUTABLE RATE.
 *     Inside a real BuyV2 the program CPIs into a SEPARATE fee program,
 *     pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ, whose `GetFeesWithQuoteMint` returned
 *     three u64s [0, 95, 30]. The Global account's own static fee field reads 95 and the
 *     field after it reads 5 — and the tape says 30. Whatever that second static field
 *     means, IT IS NOT THE RATE THE SWAP CHARGED. A fee baked in here as a constant would
 *     have been wrong by 25 bps on the very first trade this file was written against.
 *     Hence: `feeBps` is NEVER defaulted. A curve decoded without one carries
 *     `feeBps: null`, and every quoting method REFUSES rather than quoting at zero — a
 *     zero fee flatters the mark, which is precisely the direction that turns a bad fill
 *     into a number that looks like a good one.
 *
 *  8. THE FEE SHAPE, MEASURED IN BOTH DIRECTIONS FROM REAL TRADE EVENTS.
 *     BUY  (tx 3X3mQJn8…, slot 446,023,102): solAmount 987,500,000 into the curve, fee
 *       9,381,250 (= 95.000 bps of it) and creatorFee 2,962,500 (= 30.000 bps of it)
 *       charged ON TOP; the user paid 999,843,750 and the virtual SOL reserve moved by
 *       the full 987,500,000.
 *     SELL (tx 3gzecTLyyW7…, slot 446,023,240): solAmount 342,232,518 out of the curve,
 *       fee 3,251,209 (95 bps) and creatorFee 1,026,698 (30 bps) taken OUT of it.
 *     One rule explains both: THE CURVE ALWAYS SEES THE GROSS; the fee is charged on the
 *     gross, outside the invariant, in whichever direction the quote asset is moving.
 *     snipe-curve.mjs's generic helpers model a fee taken off the input, which is a
 *     different arithmetic by ~12 parts per 100,000 at live size, so this adapter applies
 *     pump.fun's own shape and hands the helpers `feeBps: 0`. It is the venue's fee, and
 *     the venue adapter is where a venue's fee shape belongs.
 *
 *  9. AND THE ARITHMETIC ITSELF CHECKS OUT ON A REAL FILL. That same buy, replayed
 *     through the plain constant product on the reserves the event reports it started
 *     from:  floor(1,073,000,000,000,000 × 987,500,000 / (30,000,000,000 + 987,500,000))
 *     = 34,194,029,850,746 — EXACTLY the tokenAmount the chain delivered, to the raw
 *     unit. That is a known answer produced by somebody else's program, and the test
 *     re-runs it through snipe-curve.mjs's own exact-in helper.
 *
 * 10. NEW PUMP.FUN MINTS ARE TOKEN-2022. The CreateV2 transaction initialises the mint
 *     under TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb with MetadataPointer (18) and
 *     TokenMetadata (19) — both already in token2022.mjs ALLOWED_MINT_EXTENSIONS — and
 *     revokes mint and freeze authority. So spec gate 11 (`mint_refused`) passes a
 *     stock launch rather than refusing every one of them, and that was checked by
 *     running the executor's own auditMintAccount over the real mint bytes, not by
 *     reading the allow-list and hoping. `accountsFor()` therefore returns the mint
 *     account alongside the curve, so one getMultipleAccounts feeds gate 7 and gate 11.
 *
 * ══ WHAT THIS FILE STILL DOES NOT KNOW, SAID OUT LOUD ═════════════════════════════════
 *
 *  · THE INSTRUCTION ACCOUNT ORDER. 27 accounts for BuyV2, 26 for SellV2, order unproved.
 *    This is the one that keeps `layoutVerified` false.
 *  · BYTES 81..123 OF THE CURVE ACCOUNT. The live account is 124 bytes and only the first
 *    81 are accounted for. The remainder decoded to `01 01` and then 41 zeros, which is
 *    consistent with several different field lists and proof of none of them. Nothing
 *    here reads past offset 81, and nothing here asserts a total length — a program that
 *    grows its account must not turn into a decode failure on a position the bot holds.
 *  · ANYTHING IN THE GLOBAL ACCOUNT PAST OFFSET 113. See §7: the field at 154 reads 5
 *    while the tape charged 30, so the rest of that account is decoded by nobody here.
 *  · WHETHER A V2 CURVE CAN BE QUOTED IN A MINT OTHER THAN SOL. The fee program's entry
 *    point is literally named `GetFeesWithQuoteMint`, which is at least a hint that the
 *    quote asset is a parameter somewhere. Every curve sampled was SOL-quoted and the
 *    adapter declares SOL; if that ever stops being true the declaration is wrong and the
 *    oracle clause in snipe-venue.mjs is the thing that has to catch it. Recorded here so
 *    the next person does not have to rediscover the question.
 *  · TRADE EVENTS CARRY A `creator` FIELD THAT DISAGREED WITH THE CURVE'S. On the sampled
 *    sell it read EB9GaRfKcVuTKsNdmrfVzbSvyQr3es7o39bGBrzs1do7 while the curve account's
 *    creator for that mint is 8tEh5ZzrxyLh12jfprebQEVjz9kgMgUcYLCHmeSME6E9. The fee
 *    arithmetic around it decodes exactly, so the offsets are right and the DISAGREEMENT
 *    IS REAL. The CREATOR-SOLD trigger (spec §2.5 #5) must therefore take the deployer
 *    from the CURVE ACCOUNT, which is the field proved against the feed, and treat the
 *    event's creator as unattributed. `decodeTradeEvent` returns it flagged as such.
 *
 * ══ SHAPE ════════════════════════════════════════════════════════════════════════════
 *
 * Decoding is pure: no clock, no randomness, no network, no mutation of the buffer it is
 * handed, BigInt for every on-chain amount. The only method that touches the network is
 * `watch()`, and it does not open a connection — it is handed one, so nothing here can
 * dial out by being imported. No keypair is loaded on any path in this file; there is no
 * code here that could sign if it wanted to.
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { WSOL } from "./jupiter.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";
import {
  BPS_DENOM,
  constantProductExactIn,
  constantProductExactOut,
  constantProductSellExactIn,
} from "./snipe-curve.mjs";

export const PUMPFUN_VENUE_ID = "pumpfun";
export const PUMPFUN_VENUE_VERSION = "snipe-venue-pumpfun-v1";

/**
 * THE PROGRAM ID, RE-DECLARED RATHER THAN IMPORTED, and the reason is not stylistic.
 *
 * The same string appears at src/data/solana.js:171 inside `const POOL_PROGRAMS` — a
 * const that is NOT exported, in a module the executor does not import and structurally
 * cannot: src/data/solana.js:36-40 records that the desk declares three dependencies and
 * @solana is not among them, because @solana/web3.js lives only in executor/node_modules.
 * So there is nothing to reuse. Claiming reuse here would be a comment that reads like a
 * dependency and is not one; a second declaration that says why is honest and is checked
 * against the desk's copy by nobody, which is exactly what this paragraph exists to warn
 * the next reader about.
 */
export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** The separate program the bonding curve CPIs into to compute a swap's fee (§7). Held
 *  as a constant so a log line naming it is greppable; nothing here calls it. */
export const PUMPFUN_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

export const BONDING_CURVE_SEED = "bonding-curve";
export const GLOBAL_SEED = "global";

/** sha256("account:BondingCurve")[0..8] and sha256("account:Global")[0..8], confirmed
 *  byte-for-byte against real mainnet accounts (§2). Held as hex because these are read
 *  and compared, never emitted. */
export const BONDING_CURVE_DISCRIMINATOR = "17b7f83760d8ac60";
export const GLOBAL_DISCRIMINATOR = "a7e8e8b1c86c727f";

/** sha256("event:CreateEvent")[0..8] / sha256("event:TradeEvent")[0..8], confirmed
 *  against real `Program data:` lines. */
export const CREATE_EVENT_DISCRIMINATOR = "1b72a94ddeeb6376";
export const TRADE_EVENT_DISCRIMINATOR = "bddb7fd34ee661ee";

/** The prefix anchor puts in front of a CPI event log. */
const PROGRAM_DATA_PREFIX = "Program data: ";

/** Field offsets proved in §1. Frozen and exported so the test asserts against the same
 *  numbers the decoder uses instead of a private second copy of them. */
export const BONDING_CURVE_LAYOUT = Object.freeze({
  discriminator: 0,
  virtualTokenReserves: 8,
  virtualSolReserves: 16,
  realTokenReserves: 24,
  realSolReserves: 32,
  tokenTotalSupply: 40,
  complete: 48,
  creator: 49,
});

/** 8 + five u64 + the `complete` byte. The 49-byte graduated account (§3) is exactly
 *  this and nothing more, which is what makes it the floor rather than a guess. */
export const BONDING_CURVE_MIN_BYTES = 49;
/** …and this is the length at which `creator` is actually present. */
export const BONDING_CURVE_WITH_CREATOR_BYTES = 81;

/** Global is only decoded as far as its fee field. See §7 for why nothing past here is
 *  read: the static field at 154 is contradicted by the tape, so the rest of this
 *  account has no owner in this codebase. */
export const GLOBAL_LAYOUT = Object.freeze({
  discriminator: 0,
  initialized: 8,
  authority: 9,
  feeRecipient: 41,
  initialVirtualTokenReserves: 73,
  initialVirtualSolReserves: 81,
  initialRealTokenReserves: 89,
  tokenTotalSupply: 97,
  feeBasisPoints: 105,
});
export const GLOBAL_MIN_BYTES = 113;

/** pump.fun mints are six-decimal; measured on the real mint account (byte 44 = 6) and
 *  consistent with a 1e15 raw total supply meaning one billion tokens. Reported, never
 *  used as a divisor — every amount in this file is raw. */
export const PUMPFUN_BASE_DECIMALS = 6;

/** The one curve type this adapter claims to understand. Spec gate 8
 *  (`curve_type_unsupported`) is a REFUSAL, never an approximation, so the set of things
 *  we admit to understanding is written down rather than implied. */
export const PUMPFUN_CURVE_TYPE = "pumpfun-constant-product";
export const PUMPFUN_SUPPORTED_CURVE_TYPES = Object.freeze([PUMPFUN_CURVE_TYPE]);

/**
 * THE FEE, AS MEASURED — an observation with a transaction attached, NOT a constant this
 * file quotes with.
 *
 * Nothing in this module reads this record. It exists so that a caller who wants to quote
 * has to reach for a named object whose own field says where the number came from and on
 * which trade, and so the test can assert the two sampled swaps really did charge exactly
 * these rates. The rate is computed per swap by another program (§7); using yesterday's
 * observation as today's fee is a decision, and it should look like one at the call site.
 */
export const PUMPFUN_FEE_OBSERVATION = Object.freeze({
  cluster: "mainnet-beta",
  observedAt: "2026-09-11",
  protocolFeeBps: 95,
  creatorFeeBps: 30,
  totalFeeBps: 125,
  computedBy: PUMPFUN_FEE_PROGRAM_ID,
  note:
    "measured on two real swaps; the bonding curve CPIs into the fee program per swap, so " +
    "this is an observation of what WAS charged and not a rate this repo can promise",
  samples: Object.freeze([
    Object.freeze({
      side: "buy",
      signature: "3X3mQJn8Bhe3zBKFjYwvUarL45uzEbjHjXy5Ebh2GJxNUfD4a1TBWdqSJfg8iHLVJbu1rR3Nded1qyhMFV8a3K8d",
      slot: 446023102,
      curveAmountLamports: 987500000n,
      protocolFeeLamports: 9381250n,
      creatorFeeLamports: 2962500n,
      userPaidLamports: 999843750n,
    }),
    Object.freeze({
      side: "sell",
      signature: "3gzecTLyyW7SiXuiVeTsdd7DVQtYqcVgosWqpRXVaKZ761cZwNXMzuNd4B9cw5Lg1QpWwg8hcVYikmTCi3d12am",
      slot: 446023240,
      curveAmountLamports: 342232518n,
      protocolFeeLamports: 3251209n,
      creatorFeeLamports: 1026698n,
      userReceivedLamports: 337954611n,
    }),
  ]),
});

/**
 * THE EVIDENCE FOR EVERY LAYOUT CLAIM ABOVE, in one machine-readable place.
 *
 * Note what this is NOT: it is not `layoutProof` in snipe-venue.mjs's sense, and the
 * adapter deliberately does not present it as one. That contract's proof is about
 * INSTRUCTION layouts — the bytes we would emit — and none of those are proved. This
 * record covers the ACCOUNT and EVENT layouts we READ. Reading a wrong offset produces a
 * wrong number you can catch with a cross-check; writing a wrong account order produces a
 * signed transaction you cannot take back. Conflating the two would be the exact failure
 * the venue contract was built to prevent, so they are kept in separate objects with
 * separate names.
 */
export const PUMPFUN_LAYOUT_EVIDENCE = Object.freeze({
  cluster: "mainnet-beta",
  readAt: "2026-09-11",
  endpoint: "https://api.mainnet-beta.solana.com",
  accounts: Object.freeze({
    liveCurve: Object.freeze({
      address: "CaLhPyhttKFHy2T6i12HCuqocFCCKuf49Z5QYpS3Fp77",
      mint: "BjPvXGPq6aPvamzeJAhRF5HaTixY4zAtRti1WtSepump",
      bytes: 124,
      crossCheckedAgainst: "frontend-api-v3.pump.fun coin row, all six fields",
    }),
    graduatedCurve: Object.freeze({
      address: "Cg14LaBKV4TrN253WmpA55LB9R9ec38HMcgPjyiFaM5i",
      mint: "6ZrYhkwvoYE4QqzpdzJ7htEHwT2u2546EkTNJ7qepump",
      bytes: 49,
      crossCheckedAgainst: "complete=true with zeroed reserves and no creator field",
    }),
    global: Object.freeze({
      address: "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
      bytes: 1054,
      crossCheckedAgainst:
        "initial reserves 1,073,000,000,000,000 / 30,000,000,000 / 793,100,000,000,000 — " +
        "the three numbers test-pumpfun-curve.mjs already pins by hand",
    }),
    launchMint: Object.freeze({
      address: "uKubAxmYJEABdmw6hqegbgghe6fcmaHqjKd2umjpump",
      bytes: 423,
      program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      crossCheckedAgainst: "executor/token2022.mjs auditMintAccount, run over the real bytes",
    }),
  }),
  transactions: Object.freeze({
    createV2: Object.freeze({
      signature: "3X3mQJn8Bhe3zBKFjYwvUarL45uzEbjHjXy5Ebh2GJxNUfD4a1TBWdqSJfg8iHLVJbu1rR3Nded1qyhMFV8a3K8d",
      slot: 446023102,
      instructionIndex: 2,
      discriminator: "d6904cec5f8b31b4",
      proves: "CreateEvent layout; the decoded bondingCurve field equals the PDA derived from the decoded mint",
    }),
    buyV2: Object.freeze({
      signature: "3AX3rL1WtwRbsyVfcBF6EWwcsvNinDJNY4drijfx2h9LtR4tv3Nq5Xe6o2TGyrkcqz8NyxvMNDNg1Jvi57FKRWu9",
      slot: 446023264,
      instructionIndex: 6,
      discriminator: "b817ee6167c5d33d",
      accountCount: 27,
      dataBytes: 24,
      proves: "ONLY that the discriminator and arg width are these; the account ORDER is unverified",
    }),
    sellV2: Object.freeze({
      signature: "5hgzpqDhghA3g2YrdB4ZVkb1F7PU56TuJUmGfwegkYSgNSmmGKiGCAauTbMSqGgFh3XnF7VGWstUSrghtiovvP4g",
      slot: 446023303,
      instructionIndex: 2,
      discriminator: "5df6823ce7e940b2",
      accountCount: 26,
      dataBytes: 24,
      proves: "same, and the same caveat",
    }),
  }),
  unproved: Object.freeze([
    "BuyV2 / SellV2 account order",
    "bonding curve bytes 81..123",
    "Global bytes 113..1053",
    "whether a V2 curve may be quoted in a mint other than SOL",
  ]),
});

/** Why every signing method on this adapter refuses. One string, so the log line, the
 *  thrown message and the test all quote the same sentence. */
export const LAYOUT_UNVERIFIED_REASON =
  `pump.fun instruction layout is NOT verified in this repository: the live program executes BuyV2 ` +
  `(${PUMPFUN_LAYOUT_EVIDENCE.transactions.buyV2.discriminator}, ` +
  `${PUMPFUN_LAYOUT_EVIDENCE.transactions.buyV2.accountCount} accounts) and SellV2 ` +
  `(${PUMPFUN_LAYOUT_EVIDENCE.transactions.sellV2.discriminator}, ` +
  `${PUMPFUN_LAYOUT_EVIDENCE.transactions.sellV2.accountCount} accounts) whose ACCOUNT ORDER nothing here ` +
  `has proved by decoding a real transaction. An unverified venue is an ENTRY REFUSAL, not a best guess`;

/** Thrown by every refusal in this module. `clause` is a stable code so a caller branches
 *  on the reason rather than on English, matching VenueContractError's shape. */
export class PumpfunVenueError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "PumpfunVenueError";
    this.clause = clause;
    this.detail = detail;
  }
}

/** Every clause this module can refuse with, ordered roughly by where it bites. */
export const PUMPFUN_CLAUSES = Object.freeze([
  "account_missing",
  "account_wrong_owner",
  "account_too_short",
  "account_discriminator_mismatch",
  "curve_complete",
  "fee_unverified",
  "layout_unverified",
  "event_malformed",
]);

/* ── small pure helpers ─────────────────────────────────────────────────────────────── */

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Accept a Buffer, a Uint8Array, a base64 string, or an account info wrapping one. The
 *  buffer is NEVER mutated and never retained: every read copies out of it. */
function bytesOf(input) {
  if (input == null) return null;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input) && typeof input[0] === "string") return Buffer.from(input[0], input[1] || "base64");
  if (typeof input === "string") return Buffer.from(input, "base64");
  if (isPlainObject(input)) return bytesOf(input.data ?? null);
  return null;
}

function ownerOf(input) {
  if (!isPlainObject(input) || input instanceof Uint8Array) return null;
  const owner = input.owner ?? (isPlainObject(input.account) ? input.account.owner : null);
  if (owner == null) return null;
  if (typeof owner === "string") return owner;
  if (typeof owner.toBase58 === "function") return owner.toBase58();
  return String(owner);
}

const discriminatorHex = (data) => (data && data.length >= 8 ? data.subarray(0, 8).toString("hex") : null);
const readU64 = (data, offset) => data.readBigUInt64LE(offset);
const readKey = (data, offset) => bs58.encode(data.subarray(offset, offset + 32));
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** A fee in basis points, or a refusal. `null`/`undefined` is NOT zero — see §7 — and a
 *  STRING is not a number: `"125"` out of an env var coerces to a perfectly plausible
 *  1.25%, and so would `"0"` out of a misread config, which is the value this whole
 *  design exists to refuse. Only a real number or bigint is a fee. */
function feeBpsOrNull(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "bigint")
    throw new PumpfunVenueError("fee_unverified",
      `${label} must be a number or bigint of basis points; received ${typeof value} ${JSON.stringify(value)}`);
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0 || n >= Number(BPS_DENOM))
    throw new PumpfunVenueError("fee_unverified",
      `${label} must be an integer in 0..${Number(BPS_DENOM) - 1} basis points; received ${JSON.stringify(value)}`);
  return n;
}

/** The venue fee on a gross amount, rounded UP — against us in both directions, which is
 *  the only rounding a quote is allowed to choose. */
const feeOnGross = (gross, feeBps) => (feeBps ? ceilDiv(gross * BigInt(feeBps), BPS_DENOM) : 0n);

function requireFee(curve, method) {
  if (!isPlainObject(curve))
    throw new PumpfunVenueError("account_missing", `${method} needs a decoded curve; received ${typeof curve}`);
  if (curve.feeBps === null || curve.feeBps === undefined)
    throw new PumpfunVenueError("fee_unverified",
      `${method} refuses to quote ${curve.mint ?? "this curve"} with an unknown fee: pump.fun computes the rate per swap ` +
      `in program ${PUMPFUN_FEE_PROGRAM_ID} (measured ${PUMPFUN_FEE_OBSERVATION.protocolFeeBps} + ` +
      `${PUMPFUN_FEE_OBSERVATION.creatorFeeBps} bps on ${PUMPFUN_FEE_OBSERVATION.samples.length} real swaps), and quoting ` +
      `at zero would flatter the mark in exactly the dangerous direction — pass {feeBps} to curveFromAccount`,
      { mint: curve.mint ?? null });
  return feeBpsOrNull(curve.feeBps, "curve.feeBps");
}

/* ── addresses ─────────────────────────────────────────────────────────────────────── */

/** The bonding curve PDA for a mint. Validated in §6 of the evidence: for the sampled
 *  CreateV2 the PDA derived here equals the `bondingCurve` field the program itself
 *  emitted, so the seed and the program id are both right rather than merely plausible. */
export function bondingCurveAddress(mint) {
  const key = mint instanceof PublicKey ? mint : new PublicKey(mint);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), key.toBuffer()], new PublicKey(PUMPFUN_PROGRAM_ID))[0];
}

export function globalAddress() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_SEED)], new PublicKey(PUMPFUN_PROGRAM_ID))[0];
}

/** The fixed order `accountsFor` returns, so the lane can index one getMultipleAccounts
 *  response without guessing. Exported because a positional contract nobody can read is a
 *  transposition waiting to happen. */
export const PUMPFUN_ACCOUNT_ROLES = Object.freeze(["bondingCurve", "global", "mint"]);

/* ── decoding ──────────────────────────────────────────────────────────────────────── */

/**
 * Decode a bonding curve account, or refuse with a named clause.
 *
 * The discriminator is checked before anything else and is the only real gate here: a
 * length window would accept a Global account, a token account, or half a curve. It also
 * deliberately does NOT require a total length — see the unproved list. The program may
 * append fields; a bot holding a position must not go blind because it did.
 */
export function decodeBondingCurve(account, { feeBps = null, mint = null, requireOwner = true } = {}) {
  const data = bytesOf(account);
  if (!data) throw new PumpfunVenueError("account_missing", `pump.fun curve account for ${mint ?? "?"} is absent`);
  const owner = ownerOf(account);
  if (requireOwner && owner && owner !== PUMPFUN_PROGRAM_ID)
    throw new PumpfunVenueError("account_wrong_owner",
      `account for ${mint ?? "?"} is owned by ${owner}, not ${PUMPFUN_PROGRAM_ID}`, { owner });
  if (data.length < BONDING_CURVE_MIN_BYTES)
    throw new PumpfunVenueError("account_too_short",
      `pump.fun curve account is ${data.length} bytes, fewer than the ${BONDING_CURVE_MIN_BYTES} the layout needs`,
      { bytes: data.length });
  const disc = discriminatorHex(data);
  if (disc !== BONDING_CURVE_DISCRIMINATOR)
    throw new PumpfunVenueError("account_discriminator_mismatch",
      `account discriminator ${disc} is not the BondingCurve discriminator ${BONDING_CURVE_DISCRIMINATOR}`,
      { discriminator: disc });

  const L = BONDING_CURVE_LAYOUT;
  const completeByte = data[L.complete];
  const hasCreator = data.length >= BONDING_CURVE_WITH_CREATOR_BYTES;
  const fee = feeBpsOrNull(feeBps, "feeBps");
  return Object.freeze({
    kind: "bonding-curve",
    venue: PUMPFUN_VENUE_ID,
    curveType: PUMPFUN_CURVE_TYPE,
    mint: mint ?? null,
    /* The base asset is the launch token, the quote asset is SOL. The names are
       deliberately snipe-curve.mjs's, not pump.fun's, so a decoded curve can be handed
       straight to snipeCurveState() without a translation step nobody maintains. */
    vBaseRaw: readU64(data, L.virtualTokenReserves),
    vQuoteRaw: readU64(data, L.virtualSolReserves),
    realBaseRaw: readU64(data, L.realTokenReserves),
    realQuoteRaw: readU64(data, L.realSolReserves),
    tokenTotalSupplyRaw: readU64(data, L.tokenTotalSupply),
    /* Anything other than 0 or 1 in a bool byte means we are not reading the field we
       think we are, and `!== 0` would quietly call that "complete". */
    complete: completeByte === 1,
    completeByte,
    creator: hasCreator ? readKey(data, L.creator) : null,
    /* §7: null is "unknown", and every quoting method refuses on it. */
    feeBps: fee,
    feeBpsKnown: fee !== null,
    baseDecimals: PUMPFUN_BASE_DECIMALS,
    quoteMint: WSOL,
    quoteDecimals: 9,
    bytes: data.length,
    discriminator: disc,
    layoutVariant: hasCreator ? "with-creator" : "no-creator",
  });
}

/** The contract's non-throwing form: null means "this is not a curve I can read", which
 *  is spec gate 7 (`curve_unreadable`). The reason is available through
 *  decodeBondingCurve for anything that wants to log it. */
export function curveFromAccount(account, opts = {}) {
  try { return decodeBondingCurve(account, opts); }
  catch (error) { if (error instanceof PumpfunVenueError) return null; throw error; }
}

/**
 * Decode the Global account as far as its fee field and no further (§7). What comes back
 * is state, not permission: `feeBasisPoints` here is the protocol's static field, and the
 * tape showed a swap charging a creator fee this account does not carry. It is returned
 * so a caller can SEE the divergence, never so a caller can quote from it silently —
 * which is why the field is not named `feeBps` and why nothing in this file reads it.
 */
export function decodeGlobal(account) {
  const data = bytesOf(account);
  if (!data) throw new PumpfunVenueError("account_missing", "pump.fun Global account is absent");
  if (data.length < GLOBAL_MIN_BYTES)
    throw new PumpfunVenueError("account_too_short",
      `pump.fun Global account is ${data.length} bytes, fewer than the ${GLOBAL_MIN_BYTES} decoded here`,
      { bytes: data.length });
  const disc = discriminatorHex(data);
  if (disc !== GLOBAL_DISCRIMINATOR)
    throw new PumpfunVenueError("account_discriminator_mismatch",
      `account discriminator ${disc} is not the Global discriminator ${GLOBAL_DISCRIMINATOR}`, { discriminator: disc });
  const L = GLOBAL_LAYOUT;
  return Object.freeze({
    kind: "global",
    initialized: data[L.initialized] === 1,
    authority: readKey(data, L.authority),
    feeRecipient: readKey(data, L.feeRecipient),
    initialVirtualBaseRaw: readU64(data, L.initialVirtualTokenReserves),
    initialVirtualQuoteRaw: readU64(data, L.initialVirtualSolReserves),
    initialRealBaseRaw: readU64(data, L.initialRealTokenReserves),
    tokenTotalSupplyRaw: readU64(data, L.tokenTotalSupply),
    staticFeeBasisPoints: Number(readU64(data, L.feeBasisPoints)),
    staticFeeIsNotTheExecutableRate: true,
    bytes: data.length,
    discriminator: disc,
  });
}

/** Borsh reader over an event payload. Bounds-checked on every field: a truncated
 *  `Program data:` line must be a named refusal, never a read past the end of a buffer. */
function eventReader(data, label) {
  let o = 8;
  const need = (n, what) => {
    if (o + n > data.length)
      throw new PumpfunVenueError("event_malformed",
        `${label} is ${data.length} bytes and ran out reading ${what} at offset ${o} (+${n})`,
        { bytes: data.length, offset: o });
  };
  return {
    get offset() { return o; },
    str(what) { need(4, `${what} length`); const n = data.readUInt32LE(o); o += 4; need(n, what);
      const s = data.subarray(o, o + n).toString("utf8"); o += n; return s; },
    key(what) { need(32, what); const s = readKey(data, o); o += 32; return s; },
    u64(what) { need(8, what); const v = readU64(data, o); o += 8; return v; },
    i64(what) { need(8, what); const v = data.readBigInt64LE(o); o += 8; return v; },
    bool(what) { need(1, what); const b = data[o]; o += 1; return b === 1; },
  };
}

/**
 * CreateEvent — the launch notice, decoded from the program's own CPI event log.
 *
 * SELF-CHECKING BY CONSTRUCTION, which is the only reason it is trusted: the event
 * carries both the mint and the bonding curve address, and the decoder re-derives the PDA
 * from the decoded mint and refuses when the two disagree. If any offset above `mint`
 * drifts — a string length misread, a field inserted — the two 32-byte keys stop lining
 * up and this throws instead of emitting a plausible launch notice for the wrong coin.
 */
export function decodeCreateEvent(payload) {
  const data = bytesOf(payload);
  if (!data || data.length < 8)
    throw new PumpfunVenueError("event_malformed", `CreateEvent payload is ${data ? data.length : 0} bytes`);
  const disc = discriminatorHex(data);
  if (disc !== CREATE_EVENT_DISCRIMINATOR)
    throw new PumpfunVenueError("account_discriminator_mismatch",
      `event discriminator ${disc} is not CreateEvent ${CREATE_EVENT_DISCRIMINATOR}`, { discriminator: disc });
  const r = eventReader(data, "CreateEvent");
  const name = r.str("name"), symbol = r.str("symbol"), uri = r.str("uri");
  const mint = r.key("mint"), bondingCurve = r.key("bondingCurve");
  const user = r.key("user"), creator = r.key("creator");
  const timestamp = r.i64("timestamp");
  const vBaseRaw = r.u64("virtualTokenReserves"), vQuoteRaw = r.u64("virtualSolReserves");
  const realBaseRaw = r.u64("realTokenReserves"), tokenTotalSupplyRaw = r.u64("tokenTotalSupply");

  const derived = bondingCurveAddress(mint).toBase58();
  if (derived !== bondingCurve)
    throw new PumpfunVenueError("event_malformed",
      `CreateEvent decode failed its own cross-check: the event names curve ${bondingCurve} for mint ${mint}, ` +
      `but the PDA for that mint is ${derived}`, { mint, bondingCurve, derived });

  return Object.freeze({
    kind: "create", venue: PUMPFUN_VENUE_ID,
    name, symbol, uri, mint, bondingCurve, user, creator,
    timestampSec: timestamp,
    vBaseRaw, vQuoteRaw, realBaseRaw, tokenTotalSupplyRaw,
    consumedBytes: r.offset, bytes: data.length,
  });
}

/**
 * TradeEvent — the tape. Feeds the DRAIN and CREATOR-SOLD triggers and is the only place
 * the EXECUTABLE fee rate is visible, because it reports the lamports actually charged
 * next to the amount they were charged on.
 *
 * `creator` comes back under `eventCreator` and flagged unattributed on purpose: on the
 * sampled sell it disagreed with the curve account's creator while every fee field around
 * it decoded exactly (95.000 and 30.000 bps to three decimals), so the disagreement is a
 * fact about the program and not about these offsets. The deployer the CREATOR-SOLD
 * trigger acts on must come from the curve account.
 */
export function decodeTradeEvent(payload) {
  const data = bytesOf(payload);
  if (!data || data.length < 8)
    throw new PumpfunVenueError("event_malformed", `TradeEvent payload is ${data ? data.length : 0} bytes`);
  const disc = discriminatorHex(data);
  if (disc !== TRADE_EVENT_DISCRIMINATOR)
    throw new PumpfunVenueError("account_discriminator_mismatch",
      `event discriminator ${disc} is not TradeEvent ${TRADE_EVENT_DISCRIMINATOR}`, { discriminator: disc });
  const r = eventReader(data, "TradeEvent");
  const mint = r.key("mint");
  const curveQuoteRaw = r.u64("solAmount");
  const baseRaw = r.u64("tokenAmount");
  const isBuy = r.bool("isBuy");
  const user = r.key("user");
  const timestamp = r.i64("timestamp");
  const vQuoteRaw = r.u64("virtualSolReserves"), vBaseRaw = r.u64("virtualTokenReserves");
  const realQuoteRaw = r.u64("realSolReserves"), realBaseRaw = r.u64("realTokenReserves");
  const feeRecipient = r.key("feeRecipient");
  const protocolFeeBps = Number(r.u64("feeBasisPoints"));
  const protocolFeeRaw = r.u64("fee");
  const eventCreator = r.key("creator");
  const creatorFeeBps = Number(r.u64("creatorFeeBasisPoints"));
  const creatorFeeRaw = r.u64("creatorFee");

  return Object.freeze({
    kind: "trade", venue: PUMPFUN_VENUE_ID,
    mint, isBuy, user, timestampSec: timestamp,
    curveQuoteRaw, baseRaw,
    vQuoteRaw, vBaseRaw, realQuoteRaw, realBaseRaw,
    feeRecipient, protocolFeeBps, protocolFeeRaw,
    creatorFeeBps, creatorFeeRaw,
    totalFeeBps: protocolFeeBps + creatorFeeBps,
    totalFeeRaw: protocolFeeRaw + creatorFeeRaw,
    /* Buy: the curve took curveQuoteRaw and the fees were charged on top. Sell: the curve
       paid curveQuoteRaw and the fees came out of it. §8, both measured. */
    userQuoteRaw: isBuy
      ? curveQuoteRaw + protocolFeeRaw + creatorFeeRaw
      : curveQuoteRaw - protocolFeeRaw - creatorFeeRaw,
    eventCreator,
    eventCreatorIsUnattributed: true,
    consumedBytes: r.offset, bytes: data.length,
  });
}

/** Every `Program data:` line in a log array that decodes as one of our events. Pure, so
 *  the feed's hardest-to-test part — turning a log into a launch notice — is testable
 *  offline against bytes a real transaction actually emitted. A line that is not ours, or
 *  is truncated, is skipped rather than throwing: one malformed log must not blind the
 *  lane to the other launches in the same batch. */
export function eventsFromLogs(logs, { kind = null } = {}) {
  if (!Array.isArray(logs)) return Object.freeze([]);
  const out = [];
  for (const line of logs) {
    if (typeof line !== "string" || !line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    let data;
    try { data = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), "base64"); } catch { continue; }
    const disc = discriminatorHex(data);
    try {
      if (disc === CREATE_EVENT_DISCRIMINATOR && (kind === null || kind === "create"))
        out.push(decodeCreateEvent(data));
      else if (disc === TRADE_EVENT_DISCRIMINATOR && (kind === null || kind === "trade"))
        out.push(decodeTradeEvent(data));
    } catch { /* a malformed line is one lost notice, never a lost batch */ }
  }
  return Object.freeze(out);
}

/**
 * Launch notices out of one logsSubscribe callback, in the shape spec §3 asks `watch` to
 * yield. `receivedAt` and `slot` are PARAMETERS: this function has no clock, so a replay
 * of a captured log through it produces the identical notice, which is what
 * test-snipe-replay.mjs will need and what a notice-age gate (spec gate 4) can be trusted
 * against.
 */
export function noticesFromLogs({ logs, signature = null, slot = null, receivedAt = null, source = "logs" } = {}) {
  return Object.freeze(eventsFromLogs(logs, { kind: "create" }).map((event) => Object.freeze({
    venue: PUMPFUN_VENUE_ID,
    mint: event.mint,
    creator: event.creator,
    curve: event.bondingCurve,
    slot,
    noticeAt: receivedAt,
    source,
    signature,
    raw: event,
  })));
}

/* ── quoting ───────────────────────────────────────────────────────────────────────── */

/**
 * BUY, EXACT IN — `quoteInRaw` is what the WALLET SPENDS IN TOTAL, fee included.
 *
 * pump.fun charges the fee on top of what the curve receives (§8), so the split is
 * curveIn = floor(total × 10000 / (10000 + feeBps)) and the fee is the remainder, and the
 * constant product is then evaluated at feeBps 0 because the invariant genuinely never
 * sees the fee. Handing snipe-curve.mjs's fee-off-the-input model the total instead would
 * understate the curve input by ~771 lamports on a 0.005 SOL ticket at 125 bps — small,
 * conservative, and still the wrong arithmetic for this venue.
 */
export function quoteExactIn(curve, quoteInRaw) {
  const feeBps = requireFee(curve, "quoteExactIn");
  const total = BigInt(quoteInRaw);
  if (total < 0n) throw new PumpfunVenueError("account_missing", `quoteInRaw must not be negative (${total})`);
  const curveInRaw = (total * BPS_DENOM) / (BPS_DENOM + BigInt(feeBps));
  const feeRaw = total - curveInRaw;
  const q = constantProductExactIn({
    vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, quoteInRaw: curveInRaw, feeBps: 0,
  });
  return Object.freeze({
    baseOutRaw: q.baseOutRaw,
    quoteInRaw: total,
    curveQuoteInRaw: curveInRaw,
    feeRaw,
    feeBps,
    spotBefore: q.spotBefore,
    execPrice: q.execPrice,
    impactPct: q.impactPct,
    execImpactPct: q.execImpactPct,
    vBaseAfterRaw: q.vBaseAfterRaw,
    vQuoteAfterRaw: q.vQuoteAfterRaw,
    feeShape: "charged on top of the curve input (measured)",
  });
}

/**
 * BUY, EXACT OUT — the absolute ceiling, in lamports, on what `baseOutRaw` may cost.
 *
 * This is the spine of the entry envelope and it carries NO slippage term by design: a
 * tolerance against a launch curve is a standing offer to whoever gets in front of us,
 * because anything that moves the reserve between our decode and our slot moves it in
 * exactly that direction. Both roundings go up, so the ceiling is never short of what the
 * chain would charge at the state we read; if the state moved, the buy reverts and costs
 * one network fee, which journal.mjs already charges to both daily counters.
 */
export function quoteExactOut(curve, baseOutRaw) {
  const feeBps = requireFee(curve, "quoteExactOut");
  const out = BigInt(baseOutRaw);
  const q = constantProductExactOut({
    vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseOutRaw: out, feeBps: 0,
  });
  const curveInRaw = q.quoteInRaw;
  const feeRaw = feeOnGross(curveInRaw, feeBps);
  return Object.freeze({
    quoteInRaw: curveInRaw + feeRaw,
    curveQuoteInRaw: curveInRaw,
    feeRaw,
    feeBps,
    baseOutRaw: out,
    deliveredBaseOutRaw: q.deliveredBaseOutRaw,
    spotBefore: q.spotBefore,
    execPrice: q.execPrice,
    impactPct: q.impactPct,
    feeShape: "charged on top of the curve input (measured)",
  });
}

/**
 * SELL, EXACT IN — the ruler's engine, and the number every exit trigger is a comparison
 * against.
 *
 * Two things it refuses to flatter. The curve pays out of its REAL quote reserve, not its
 * virtual one, so the gross is capped at `realQuoteRaw` before the fee is taken — a fresh
 * curve quotes against ~30 virtual SOL while holding a fraction of one, and an uncapped
 * simulation would report proceeds that do not exist and then let a mark be built on
 * them. And the fee comes OUT of the proceeds on a sell (§8, measured), so it is
 * subtracted after the cap, in that order, because that is the order the program does it.
 */
export function sellExactIn(curve, baseInRaw) {
  const feeBps = requireFee(curve, "sellExactIn");
  const inRaw = BigInt(baseInRaw);
  const gross = constantProductSellExactIn({
    vBase: curve.vBaseRaw, vQuote: curve.vQuoteRaw, baseInRaw: inRaw, feeBps: 0,
    realQuoteRaw: curve.realQuoteRaw,
  });
  const cappedGross = gross.quoteOutRaw;
  const feeRaw = feeOnGross(cappedGross, feeBps);
  const netOut = cappedGross > feeRaw ? cappedGross - feeRaw : 0n;
  return Object.freeze({
    quoteOutRaw: netOut,
    grossQuoteOutRaw: cappedGross,
    uncappedQuoteOutRaw: gross.uncappedQuoteOutRaw,
    feeRaw,
    feeBps,
    baseInRaw: inRaw,
    reserveKnown: true,
    reserveBound: gross.reserveBound,
    vBaseAfterRaw: gross.vBaseAfterRaw,
    vQuoteAfterRaw: gross.vQuoteAfterRaw,
    spotBefore: gross.spotBefore,
    impactPct: gross.impactPct,
    feeShape: "taken out of the curve output (measured)",
  });
}

/* ── the three refusals ────────────────────────────────────────────────────────────── */

function refuseLayout(method) {
  throw new PumpfunVenueError("layout_unverified",
    `${PUMPFUN_VENUE_ID}.${method}() refuses: ${LAYOUT_UNVERIFIED_REASON}`,
    Object.freeze({
      method,
      venue: PUMPFUN_VENUE_ID,
      programId: PUMPFUN_PROGRAM_ID,
      evidence: PUMPFUN_LAYOUT_EVIDENCE.transactions,
      unproved: PUMPFUN_LAYOUT_EVIDENCE.unproved,
      whatWouldLiftIt:
        "a decode round trip against a real mainnet BuyV2 and SellV2 that recovers every account " +
        "position, recorded as adapter.layoutProof, after which snipe-venue.mjs can certify execute",
    }));
}

/** The encoder that does not exist. It is a function, not an omission, because
 *  snipe-venue.mjs REQUIRES buyIx in observe mode too: an observe row records the exact
 *  bytes the lane would have signed, so the encoder has to be there to be asked, and
 *  "the encoder refused" is a far more useful thing to find in a shadow log than a venue
 *  that quietly produced nothing. */
export function buyIx() { return refuseLayout("buyIx"); }
/** The task names this one `buildBuy`; snipe-venue.mjs's contract names it `buyIx`. Both
 *  exist and both refuse, so neither name is a door. */
export function buildBuy() { return refuseLayout("buildBuy"); }
export function sellIx() { return refuseLayout("sellIx"); }
/** Decoding our own bytes back (spec gate 20) cannot mean anything while the bytes we
 *  would emit are unproved — a decoder written from the same wrong assumption as the
 *  encoder agrees with it perfectly. */
export function decodeBuyIx() { return refuseLayout("decodeBuyIx"); }

/* ── state questions the lane asks ─────────────────────────────────────────────────── */

export function isComplete(curve) {
  if (!isPlainObject(curve))
    throw new PumpfunVenueError("account_missing", `isComplete needs a decoded curve; received ${typeof curve}`);
  return curve.complete === true;
}

/** What the curve can actually pay out, in lamports. Spec gate 3 (DRAIN) watches this
 *  and it is the cap inside `sellExactIn`. */
export function quoteReserveLamports(curve) {
  if (!isPlainObject(curve))
    throw new PumpfunVenueError("account_missing",
      `quoteReserveLamports needs a decoded curve; received ${typeof curve}`);
  return BigInt(curve.realQuoteRaw);
}

/**
 * HOW WOULD WE GET OUT? Answered without I/O whenever the caller already holds the curve,
 * because the lane decodes it every tick anyway and a second round trip on the exit
 * question is latency spent to learn nothing.
 *
 * The answer today is `routable: false` for any live curve, and that is the correct
 * answer rather than a missing feature: the sell instruction is unverified, so the only
 * exit is the one we cannot build. Spec gate 10 turns this into `exit_route_unimplemented`
 * — WE MAY NOT ENTER WHAT WE CANNOT EXIT. A completed curve is a different question: it
 * has graduated to a pool the audited Jupiter path already trades, which is why GRADUATED
 * in the state machine swaps the ruler rather than the lane.
 */
export function exitRoute(_conn, mint, { curve = null } = {}) {
  if (curve && isComplete(curve))
    return Object.freeze({
      via: "jupiter", routable: true, mint: mint ?? curve.mint ?? null,
      reason: "curve is complete; the graduated pool is routable by the audited Jupiter exit path",
    });
  return Object.freeze({
    via: null, routable: false, mint: mint ?? (curve ? curve.mint : null) ?? null,
    reason: `no exit can be built on this venue: ${LAYOUT_UNVERIFIED_REASON}`,
  });
}

/* ── the feed ──────────────────────────────────────────────────────────────────────── */

/**
 * Launch notices as they happen, over the executor's own RPC WebSocket.
 *
 * DEPENDENCY-INJECTED ON PURPOSE: the connection is handed in, never created. Importing
 * this module therefore cannot open a socket, an observe run and a replay run use the
 * same code path with different sources, and a test can drive it without a network by
 * passing anything that implements onLogs. There is no polling fallback here — that is
 * src/data/pumpfun-live.js's `newLaunches()`, which is an HTTP poll and structurally
 * cannot be a t=0 trigger, and wiring the two together is snipe-feed.mjs's job, not this
 * adapter's.
 *
 * LATENCY FROM THIS MACHINE IS UNMEASURED. Nothing here claims a slot target. The one
 * thing the shape guarantees is that `noticeAt` is stamped at arrival by the caller's
 * clock and carried through untouched, so the measurement is possible later.
 */
export async function* watch({ connection, commitment = "processed", signal = null, source = "logsSubscribe", now = null } = {}) {
  if (!connection || typeof connection.onLogs !== "function")
    throw new PumpfunVenueError("account_missing",
      "watch() must be handed a Connection with onLogs; this adapter never opens one of its own");
  const clock = typeof now === "function" ? now : () => Date.now();
  const queue = [];
  let wake = null;
  const push = (notice) => { queue.push(notice); if (wake) { const w = wake; wake = null; w(); } };

  const subscriptionId = await connection.onLogs(new PublicKey(PUMPFUN_PROGRAM_ID), (entry) => {
    if (!entry || entry.err) return;
    for (const notice of noticesFromLogs({
      logs: entry.logs, signature: entry.signature ?? null,
      slot: entry.slot ?? null, receivedAt: clock(), source,
    })) push(notice);
  }, commitment);

  const onAbort = () => { if (wake) { const w = wake; wake = null; w(); } };
  if (signal) signal.addEventListener("abort", onAbort);
  try {
    for (;;) {
      if (signal && signal.aborted) return;
      while (queue.length) yield queue.shift();
      if (signal && signal.aborted) return;
      await new Promise((resolve) => { wake = resolve; });
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    if (typeof connection.removeOnLogsListener === "function")
      await Promise.resolve(connection.removeOnLogsListener(subscriptionId)).catch(() => {});
  }
}

/* ── the adapter ───────────────────────────────────────────────────────────────────── */

/**
 * The object snipe-venue.mjs judges.
 *
 * `layoutVerified: false` and no `layoutProof` — so `venueContract(adapter, {execute:
 * true})` refuses with clause `layout_unverified` and `venueFor` hands back `venue: null`.
 * Observe passes. That is the whole intended posture of this venue today, and it is a
 * property of the evidence rather than of a switch: the way to flip it is to prove the
 * instruction account order against a real transaction, not to edit this line.
 *
 * The quote asset is declared as WSOL. pump.fun's curve holds native lamports, but WSOL is
 * this repo's canonical id for the nine-decimal SOL every cap and the Pyth oracle are
 * already denominated in (jupiter.mjs uses it the same way), and naming it is what makes
 * the contract's `quote_mint_mismatch` clause able to check us at all.
 */
export const PUMPFUN_VENUE = Object.freeze({
  id: PUMPFUN_VENUE_ID,
  version: PUMPFUN_VENUE_VERSION,
  programId: PUMPFUN_PROGRAM_ID,
  quote: Object.freeze({ mint: WSOL, decimals: 9, symbol: "SOL", oracle: PYTH_SOL_USD_CACHE_SOURCE }),
  supportsExactOut: true,
  layoutVerified: false,
  layoutEvidence: PUMPFUN_LAYOUT_EVIDENCE,
  feeObservation: PUMPFUN_FEE_OBSERVATION,
  supportedCurveTypes: PUMPFUN_SUPPORTED_CURVE_TYPES,
  accountRoles: PUMPFUN_ACCOUNT_ROLES,

  watch,
  accountsFor(mint) {
    /* One getMultipleAccounts, three roles, fixed order (PUMPFUN_ACCOUNT_ROLES): the
       curve for gates 7-9, Global so a caller can SEE the static fee next to the tape's,
       and the mint itself so token2022.mjs's audit (gate 11) runs off the same round
       trip instead of costing a second one. */
    return [bondingCurveAddress(mint), globalAddress(), new PublicKey(mint)];
  },
  curveFromAccount,
  quoteExactIn,
  quoteExactOut,
  sellExactIn,
  buyIx,
  buildBuy,
  sellIx,
  decodeBuyIx,
  exitRoute,
  isComplete,
  quoteReserveLamports,
});

export default PUMPFUN_VENUE;
