/**
 * THE VENUE CONTRACT — the fence between "an adapter exists" and "an adapter may be
 * signed against".
 *
 * The sniper lane is the first thing in this executor that builds its OWN instructions.
 * Every trade the bot has ever signed came back from Jupiter as a built transaction that
 * jupiter.mjs then decoded and re-checked; nothing in this repo has ever encoded a swap
 * from a program's own layout. That changes the failure mode completely. A wrong
 * discriminator or a transposed account in a hand-built buy does not refuse — it signs,
 * it lands, and the money goes somewhere nobody planned. There is no quote to re-check
 * it against, because we wrote the bytes.
 *
 * ── THE MEASURED FACT THIS FILE IS SHAPED BY ────────────────────────────────────────
 *
 * NO VENUE INSTRUCTION LAYOUT IS VERIFIED IN THIS REPOSITORY. Not pump.fun's, not
 * LaunchLab's. `grep -rn "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"` finds the program
 * id once, as a label in src/data/solana.js's POOL_PROGRAMS table (which is not even
 * exported); no discriminator, no account order, no fee rate for any venue appears
 * anywhere. So the honest default state of every adapter that will ever be written
 * against this contract is EXECUTE-REFUSED, and that is a property of the repository,
 * not a configuration someone forgot to switch on.
 *
 * ── WHAT THIS CONTRACT CAN AND CANNOT PROVE, SAID PLAINLY ───────────────────────────
 *
 * It cannot decode a transaction. Doing that needs an RPC round trip, which would make
 * the boot assertion async, networked and failure-prone on the one path that must be
 * able to say no while the machine is offline. So this file does NOT prove a layout.
 *
 * What it does instead is refuse to certify until the adapter has converted its claim
 * into a FALSIFIABLE one: `layoutVerified: true` is worthless on its own (any author can
 * type it), so the contract demands, alongside it, the base58 signature of the real
 * mainnet transaction whose decode round-trip proved the layout, the slot and instruction
 * index inside it, and the path of the test that ran the round trip — one entry per
 * signing method, and every signing method must be covered. A reviewer can take that row
 * and re-run it. "I believe this is right" is refused; "this transaction, at this slot,
 * decoded by this test" is admissible and checkable by somebody else.
 *
 * That is the whole trick, and it is worth being blunt about its limit: a determined
 * author can still write a plausible signature next to a wrong layout. The contract makes
 * that a lie with a name and a slot attached rather than an unexamined default, and it
 * makes the adapter's own decode round-trip test (spec Commit 2, against a real on-chain
 * buy read from mainnet) the thing that actually carries the proof. This file is the
 * fence; that test is the evidence.
 *
 * ── WHY EXECUTE IS SOL-ONLY, BY ARITHMETIC AND NOT BY POLICY ────────────────────────
 *
 * Every cap in this executor is denominated in SOL — maxSolPerTrade, dailySolCap,
 * dailyLossLimitSol, expectedNetworkFeeLamports, networkFeeReserveSol, and the fee floor
 * minViableSolPerTrade. And jupiter.mjs's own fee gate compares `networkFees` (lamports,
 * always paid in SOL whatever the quote asset) against `feeBasis = amountRaw`. Give that
 * gate a non-SOL quote and it is comparing lamports against the base units of some other
 * token: not loose, MEANINGLESS. The stop distance has the same problem one level up —
 * the floor is arithmetic in SOL, and a position whose risk is denominated in an asset
 * with its own independent SOL price has no stop distance to compute until that asset has
 * a SOL price from two independent sources.
 *
 * This repo has exactly one such oracle: executor/sol-usd-oracle.mjs, Pyth SOL/USD
 * through two independent RPC providers. So `assertVenueContract` refuses `execute:true`
 * for any adapter whose quote asset is not the one asset every cap and the only oracle
 * are already denominated in. A stonk.fun-class adapter quoted in SPYx is therefore
 * observe-only BY CONSTRUCTION — it registers, it accumulates shadow rows against the
 * same determiner, and it cannot be signed. Nobody has to remember to disable it.
 *
 * ── WHAT WAS CONSIDERED AND REJECTED ────────────────────────────────────────────────
 *
 *  · An `enabled: true` flag on the adapter. Self-granting: the thing being judged writes
 *    the verdict. Whether a venue may execute is decided here, from evidence the adapter
 *    supplies, never declared by the adapter.
 *  · Caching the certificate at registration. A stored pass is a stale pass: flip
 *    `layoutVerified` after boot and a cached registry would keep signing on a proof that
 *    no longer stands. Certification is pure and costs microseconds, so venueFor re-runs
 *    the WHOLE contract on every single use. test-snipe-venue.mjs proves that by flipping
 *    the flag after a successful registration and watching the next lookup refuse.
 *  · Truthiness anywhere. `layoutVerified: "false"` is truthy. `execute: "0"` out of an
 *    env var is truthy. Both are refused: every boolean in this contract must be the
 *    literal `true`, and the mode argument must be a real boolean or the call itself is
 *    the first refusal. This is not pedantry — `SNIPE_EXECUTE="0"` reaching a `?:` is the
 *    single most likely way this fence gets walked through.
 *  · venueFor returning the adapter alongside a refusal so the caller "can decide". A
 *    caller that can reach an uncertified adapter will eventually call buyIx on it. On
 *    any refusal `venue` is null; there is nothing to sign with.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────────────
 *
 * Fail-closed, ordered, first failure names the refusal — entry-contract.mjs:112
 * ENTRY_GATES, deliberately, so the sniper's vocabulary is the one the rest of this
 * executor already speaks. The clause names below are NOT desk gate codes: src/calls.js
 * gateClass() answers SAFETY for anything it has not heard of, so whoever maps one of
 * these onto a desk-side withhold must register it in GATE_CLASS explicitly first. The
 * snipe entry envelope reports all of them under its own gate `venue_not_enabled`
 * (spec §5 gate 1) and carries the clause in the detail.
 *
 * PURE. No I/O, no network, no wallet, no clock, no keypair, and it mutates nothing it is
 * handed. The registry is the only state, it holds adapters and no verdicts, and a test
 * seam (createVenueRegistry) keeps suites from fighting over the module-level one.
 */
import bs58 from "bs58";
import { WSOL } from "./jupiter.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";

export const VENUE_CONTRACT_VERSION = "snipe-venue-v1";

/** Every method the lane calls on an adapter, required in BOTH modes.
 *
 *  buyIx/sellIx/decodeBuyIx are required in observe mode too, and that is on purpose: an
 *  observe row records the exact bytes the lane WOULD have signed, so the encoder has to
 *  exist to be asked. An unverified encoder refusing on the observe path is the correct
 *  and visible outcome — the shadow row says "the encoder refused", which is a far more
 *  useful thing to find in a log than a venue that quietly produced nothing.
 *
 *  quoteExactOut is not optional, and it is the one entry on this list that is a policy
 *  decision rather than a plumbing need: the entry ceiling (spec §5) is an ABSOLUTE max
 *  cost in the quote asset with no slippage term, and an adapter that can only express
 *  exact-in cannot state one. A venue that cannot bound what a buy costs is not
 *  admissible to a lane whose position is the full ticket at risk. */
export const REQUIRED_VENUE_METHODS = Object.freeze([
  "watch",
  "accountsFor",
  "curveFromAccount",
  "quoteExactIn",
  "quoteExactOut",
  "sellExactIn",
  "buyIx",
  "sellIx",
  "decodeBuyIx",
  "exitRoute",
  "isComplete",
  "quoteReserveLamports",
]);

/** The methods that emit or read raw program bytes. Each one needs its own proved
 *  round trip: sellIx is on this list because we may not enter what we cannot exit, and
 *  a buy layout proved while the sell layout is guessed is a position with no door. */
export const LAYOUT_PROVED_METHODS = Object.freeze(["buyIx", "sellIx", "decodeBuyIx"]);

/** A layout proof is a claim about MAINNET. A devnet program may carry a different
 *  layout under the same name, and it is not the program the money meets. */
export const PROOF_CLUSTER = "mainnet-beta";

/** Quote assets that this repo can actually price from two independent sources, keyed by
 *  the oracle id the adapter must name. One entry today, and the entry is the constant
 *  sol-usd-oracle.mjs itself exports — not a second copy of the string — so deleting or
 *  renaming that oracle breaks this table loudly instead of leaving a venue certified
 *  against an oracle that is gone. */
export const SUPPORTED_QUOTE_ORACLES = Object.freeze({
  [PYTH_SOL_USD_CACHE_SOURCE]: Object.freeze({
    mint: WSOL,
    symbol: "SOL",
    decimals: 9,
    sources: 2,
    module: "executor/sol-usd-oracle.mjs",
  }),
});

/** The contract, in the order it is evaluated. The first clause that fails names the
 *  refusal. Everything above `quote_oracle_unsupported` is required in both modes;
 *  everything from it down is an execute-only clause, which is the line the whole file
 *  exists to draw. */
export const VENUE_CONTRACT_CLAUSES = Object.freeze([
  "mode_invalid",
  "adapter_missing",
  "venue_id_invalid",
  "program_id_invalid",
  "method_missing",
  "quote_asset_invalid",
  "exact_out_unsupported",
  "quote_oracle_unsupported",
  "quote_mint_mismatch",
  "layout_unverified",
  "layout_proof_missing",
  "layout_proof_cluster",
  "layout_proof_program_mismatch",
  "layout_proof_malformed",
  "layout_proof_unattributed",
  "layout_proof_incomplete",
]);

/** Refusals that belong to the registry rather than to one adapter's shape. Kept in a
 *  separate frozen list, and asserted disjoint from the contract clauses, so a log line
 *  never leaves you guessing whether "the venue" or "the lookup" said no. */
export const VENUE_REGISTRY_CLAUSES = Object.freeze([
  "mint_invalid",
  "venue_unknown",
  "venue_ambiguous",
  "venue_duplicate",
]);

/** Thrown by assertVenueContract and registerVenue. Carries the clause so a caller can
 *  branch on the reason without parsing English. */
export class VenueContractError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "VenueContractError";
    this.clause = clause;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isTrue = (v) => v === true;

/** Decode a base58 key/signature and report the BYTE length, not the character count.
 *  Character count is the ruler that lies here: base58 of 32 bytes runs 32-44 characters
 *  depending on leading zeros, so a length window accepts things that are not keys at
 *  all. Decoding answers exactly. */
function base58Bytes(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const bytes = bs58.decode(value);
    return bytes && bytes.length ? bytes : null;
  } catch { return null; }
}

const allZero = (bytes) => bytes.every((b) => b === 0);

function describeKey(value, wantBytes) {
  const bytes = base58Bytes(value);
  if (!bytes) return { ok: false, why: "is not base58", bytes: null, length: null };
  if (bytes.length !== wantBytes)
    return { ok: false, why: `decodes to ${bytes.length} bytes, not ${wantBytes}`, bytes, length: bytes.length };
  if (allZero(bytes))
    return { ok: false, why: `decodes to ${wantBytes} zero bytes — the default/unset value, never a real one`,
      bytes, length: bytes.length };
  return { ok: true, why: null, bytes, length: bytes.length };
}

/**
 * Run the contract. Pure; returns the verdict rather than throwing, so the entry
 * envelope can fold a refusal into its own ordered gate trace without a try/catch.
 *
 * @returns {{ok: boolean, clause: string|null, detail: object}}
 */
export function venueContract(adapter, { execute = false } = {}) {
  const base = {
    contractVersion: VENUE_CONTRACT_VERSION,
    mode: execute === true ? "execute" : "observe",
    venueId: isPlainObject(adapter) && isNonEmptyString(adapter.id) ? adapter.id : null,
    programId: isPlainObject(adapter) && isNonEmptyString(adapter.programId) ? adapter.programId : null,
  };
  const no = (clause, message, extra = {}) => ({ ok: false, clause, detail: { ...base, message, ...extra } });

  /* The caller's own argument is judged first. `execute` arriving as the string "0" out
     of an env var is truthy, and a contract that read it with `?:` would certify a venue
     for signing because someone turned it OFF. There is no sane default here, so a
     non-boolean is the refusal rather than a coerced guess. */
  if (typeof execute !== "boolean")
    return no("mode_invalid",
      `execute must be a boolean; received ${typeof execute} ${JSON.stringify(execute)}`,
      { mode: null });

  if (!isPlainObject(adapter))
    return no("adapter_missing", `venue adapter must be an object; received ${adapter === null ? "null" : Array.isArray(adapter) ? "an array" : typeof adapter}`);

  if (!isNonEmptyString(adapter.id))
    return no("venue_id_invalid", `venue adapter has no id (received ${JSON.stringify(adapter.id)})`);

  const program = describeKey(adapter.programId, 32);
  if (!program.ok)
    return no("program_id_invalid",
      `venue ${adapter.id} programId ${JSON.stringify(adapter.programId)} ${program.why}`,
      { programBytes: program.length });

  const missing = REQUIRED_VENUE_METHODS.filter((name) => typeof adapter[name] !== "function");
  if (missing.length)
    return no("method_missing",
      `venue ${adapter.id} is missing ${missing.length} required method(s): ` +
      missing.map((name) => `${name} (${adapter[name] === undefined ? "absent" : typeof adapter[name]})`).join(", "),
      { missingMethods: Object.freeze([...missing]) });

  const quote = adapter.quote;
  if (!isPlainObject(quote))
    return no("quote_asset_invalid", `venue ${adapter.id} declares no quote asset`);
  const quoteMint = describeKey(quote.mint, 32);
  if (!quoteMint.ok)
    return no("quote_asset_invalid",
      `venue ${adapter.id} quote mint ${JSON.stringify(quote.mint)} ${quoteMint.why}`);
  if (!Number.isInteger(quote.decimals) || quote.decimals < 0 || quote.decimals > 18)
    return no("quote_asset_invalid",
      `venue ${adapter.id} quote decimals ${JSON.stringify(quote.decimals)} is not an integer in 0..18`);
  if (!isNonEmptyString(quote.symbol))
    return no("quote_asset_invalid", `venue ${adapter.id} quote asset has no symbol`);
  if (!isNonEmptyString(quote.oracle))
    return no("quote_asset_invalid",
      `venue ${adapter.id} quote asset ${quote.symbol} names no price oracle`);

  /* Declared, not inferred — the behaviour is proved by the adapter's own quote tests,
     and what is checked here is that the author has said out loud that the venue can
     express an absolute max cost. A missing quoteExactOut was already caught above; this
     catches the adapter that ships a quoteExactOut which approximates one. */
  if (!isTrue(adapter.supportsExactOut))
    return no("exact_out_unsupported",
      `venue ${adapter.id} does not declare supportsExactOut === true (received ${JSON.stringify(adapter.supportsExactOut)}) —` +
      ` a venue that cannot state an absolute max cost cannot carry this lane's entry ceiling`,
      { supportsExactOut: adapter.supportsExactOut ?? null });

  const observed = {
    ...base,
    quoteMint: quote.mint,
    quoteSymbol: quote.symbol,
    quoteOracle: quote.oracle,
    layoutVerified: adapter.layoutVerified === true,
  };

  if (execute !== true)
    return { ok: true, clause: null,
      detail: { ...observed, message: `venue ${adapter.id} is admissible for OBSERVE only; nothing on this path signs` } };

  // ── execute-only from here down ────────────────────────────────────────────────────
  const oracle = Object.prototype.hasOwnProperty.call(SUPPORTED_QUOTE_ORACLES, quote.oracle)
    ? SUPPORTED_QUOTE_ORACLES[quote.oracle] : null;
  if (!oracle)
    return no("quote_oracle_unsupported",
      `venue ${adapter.id} is quoted in ${quote.symbol} against oracle ${JSON.stringify(quote.oracle)}, which this repo` +
      ` cannot price from two independent sources (it has ${Object.keys(SUPPORTED_QUOTE_ORACLES).join(", ")});` +
      ` every cap in this executor is denominated in SOL, so the venue is observe-only`,
      { ...observed, supportedOracles: Object.freeze(Object.keys(SUPPORTED_QUOTE_ORACLES)) });
  if (quote.mint !== oracle.mint || quote.decimals !== oracle.decimals)
    return no("quote_mint_mismatch",
      `venue ${adapter.id} names oracle ${quote.oracle} but quotes ${quote.mint}/${quote.decimals}dp,` +
      ` while that oracle prices ${oracle.mint}/${oracle.decimals}dp`,
      { ...observed, oracleMint: oracle.mint, oracleDecimals: oracle.decimals });

  if (!isTrue(adapter.layoutVerified))
    return no("layout_unverified",
      `venue ${adapter.id} instruction layout is not verified (layoutVerified = ${JSON.stringify(adapter.layoutVerified)}).` +
      ` No venue layout is verified in this repo; an unverified venue is an ENTRY REFUSAL, not a best guess`,
      observed);

  const proof = adapter.layoutProof;
  if (!isPlainObject(proof))
    return no("layout_proof_missing",
      `venue ${adapter.id} claims layoutVerified but supplies no layoutProof —` +
      ` the claim must name the on-chain transaction that proved it`, observed);
  if (proof.cluster !== PROOF_CLUSTER)
    return no("layout_proof_cluster",
      `venue ${adapter.id} layout proof is from cluster ${JSON.stringify(proof.cluster)}, not ${PROOF_CLUSTER}`,
      observed);
  if (proof.programId !== adapter.programId)
    return no("layout_proof_program_mismatch",
      `venue ${adapter.id} layout proof is against program ${JSON.stringify(proof.programId)} but the adapter trades ${adapter.programId}`,
      observed);
  if (!isNonEmptyString(proof.provedBy))
    return no("layout_proof_unattributed",
      `venue ${adapter.id} layout proof names no test that ran the decode round trip (provedBy = ${JSON.stringify(proof.provedBy)})` +
      ` — an unrepeatable proof is an assertion`, observed);

  const roundTrips = Array.isArray(proof.roundTrips) ? proof.roundTrips : null;
  if (!roundTrips || roundTrips.length === 0)
    return no("layout_proof_missing",
      `venue ${adapter.id} layout proof carries no round trips`, observed);

  const covered = new Set();
  for (let i = 0; i < roundTrips.length; i++) {
    const rt = roundTrips[i];
    const where = `venue ${adapter.id} layout proof round trip #${i}`;
    if (!isPlainObject(rt))
      return no("layout_proof_malformed", `${where} is not an object (${typeof rt})`, observed);
    if (!LAYOUT_PROVED_METHODS.includes(rt.method))
      return no("layout_proof_malformed",
        `${where} names method ${JSON.stringify(rt.method)}, which is not one of ${LAYOUT_PROVED_METHODS.join(", ")}`,
        observed);
    const sig = describeKey(rt.signature, 64);
    if (!sig.ok)
      return no("layout_proof_malformed",
        `${where} (${rt.method}) signature ${JSON.stringify(rt.signature)} ${sig.why}`,
        { ...observed, signatureBytes: sig.length });
    if (!Number.isInteger(rt.slot) || rt.slot <= 0)
      return no("layout_proof_malformed",
        `${where} (${rt.method}) slot ${JSON.stringify(rt.slot)} is not a positive integer`, observed);
    if (!Number.isInteger(rt.instructionIndex) || rt.instructionIndex < 0)
      return no("layout_proof_malformed",
        `${where} (${rt.method}) instructionIndex ${JSON.stringify(rt.instructionIndex)} is not a non-negative integer`,
        observed);
    covered.add(rt.method);
  }

  const uncovered = LAYOUT_PROVED_METHODS.filter((name) => !covered.has(name));
  if (uncovered.length)
    return no("layout_proof_incomplete",
      `venue ${adapter.id} layout proof covers ${[...covered].join(", ") || "nothing"} but leaves ${uncovered.join(", ")} unproved` +
      ` — a buy layout proved while the sell layout is guessed is a position with no door`,
      { ...observed, uncoveredMethods: Object.freeze([...uncovered]) });

  return { ok: true, clause: null,
    detail: { ...observed, message: `venue ${adapter.id} is certified for EXECUTE`,
      provedBy: proof.provedBy,
      provedSignatures: Object.freeze(roundTrips.map((rt) => `${rt.method}@${rt.slot}:${rt.signature}`)) } };
}

/**
 * The boot assertion. Throws a VenueContractError naming the first clause that refused,
 * or returns a frozen certificate.
 *
 * The certificate is a RECORD OF A PASS, not a permission token — nothing in this module
 * accepts one as an argument, and venueFor re-runs the whole contract rather than reading
 * a stored one, so there is no object anywhere that can outlive the facts it was made
 * from. Callers log it.
 */
export function assertVenueContract(adapter, { execute = false } = {}) {
  const verdict = venueContract(adapter, { execute });
  if (!verdict.ok) throw new VenueContractError(verdict.clause, verdict.detail.message, verdict.detail);
  return Object.freeze({
    ok: true,
    clause: null,
    contractVersion: VENUE_CONTRACT_VERSION,
    venueId: verdict.detail.venueId,
    programId: verdict.detail.programId,
    mode: verdict.detail.mode,
    layoutVerified: verdict.detail.layoutVerified,
    quoteMint: verdict.detail.quoteMint,
    quoteSymbol: verdict.detail.quoteSymbol,
    quoteOracle: verdict.detail.quoteOracle,
    detail: Object.freeze({ ...verdict.detail }),
  });
}

/** A registry is a Map of venue id → {adapter}. It holds adapters and NO verdicts. */
export function createVenueRegistry() { return new Map(); }

const DEFAULT_REGISTRY = createVenueRegistry();

/**
 * Put an adapter where venueFor can find it.
 *
 * Registration proves the shape contract (observe level) and nothing more: it is not the
 * thing that grants execute, which is decided fresh at every lookup. Passing
 * `{execute: true}` additionally asserts the execute contract HERE, at boot, in the
 * fail-closed spirit of poller.mjs proveMainnetOrWait — an operator who intends to sign
 * on this venue finds out at start-up rather than in the middle of a launch. It still
 * grants nothing; nothing is stored.
 *
 * Two adapters on one program id are refused. `venueFor` matches a mint to a venue by the
 * program that owns its accounts, so a duplicate program would make that match ambiguous,
 * and an ambiguous venue is two different sets of bytes claiming to be the same trade.
 */
export function registerVenue(adapter, { execute = false, registry = DEFAULT_REGISTRY } = {}) {
  if (typeof execute !== "boolean")
    throw new VenueContractError("mode_invalid",
      `execute must be a boolean; received ${typeof execute} ${JSON.stringify(execute)}`, {});
  assertVenueContract(adapter, { execute: false });
  if (execute === true) assertVenueContract(adapter, { execute: true });

  if (registry.has(adapter.id))
    throw new VenueContractError("venue_duplicate",
      `venue ${adapter.id} is already registered`, { venueId: adapter.id });
  for (const [id, record] of registry)
    if (record.adapter.programId === adapter.programId)
      throw new VenueContractError("venue_duplicate",
        `venue ${adapter.id} trades program ${adapter.programId}, which venue ${id} already claims —` +
        ` a mint could not be matched to one venue`,
        { venueId: adapter.id, conflictsWith: id, programId: adapter.programId });

  const record = Object.freeze({ adapter, registeredAt: registry.size });
  registry.set(adapter.id, record);
  return record;
}

export function registeredVenues(registry = DEFAULT_REGISTRY) {
  return Object.freeze([...registry.values()].map((r) => r.adapter));
}

/** Test seam. The live lane registers once at boot and never clears. */
export function clearVenues(registry = DEFAULT_REGISTRY) { registry.clear(); }

/** Which program owns this account? Accepts a bare account info, a
 *  {pubkey, account} pair as getProgramAccounts returns it, a PublicKey owner or a
 *  string one. A null entry is a missing account, which is a fact about one endpoint's
 *  view and not about the chain — it is skipped, never counted against a venue. */
function ownerOf(info) {
  if (!isPlainObject(info)) return null;
  const account = isPlainObject(info.account) ? info.account : info;
  const owner = account.owner;
  if (owner == null) return null;
  if (typeof owner === "string") return owner;
  if (typeof owner.toBase58 === "function") return owner.toBase58();
  return String(owner);
}

/**
 * Which registered venue owns this mint, and may it be used in the mode asked for?
 *
 * The match is structural: a venue claims a mint when one of the supplied account infos
 * is owned by that venue's program. No adapter is asked to identify its own mints —
 * self-identification is how two venues end up claiming the same launch.
 *
 * @returns {{ok, venue, certificate, clause, detail}} — `venue` is the adapter on a pass
 *   and is ALWAYS null on a refusal. There is deliberately no way to reach an adapter
 *   that the contract has just refused, because a caller holding one will eventually
 *   call buyIx on it.
 */
export function venueFor(mint, accountInfos, { execute = false, registry = DEFAULT_REGISTRY } = {}) {
  const refuse = (clause, message, extra = {}) =>
    ({ ok: false, venue: null, certificate: null, clause, detail: { mint: mint ?? null, message, ...extra } });

  if (typeof execute !== "boolean")
    return refuse("mode_invalid", `execute must be a boolean; received ${typeof execute} ${JSON.stringify(execute)}`);
  const mintKey = describeKey(mint, 32);
  if (!mintKey.ok)
    return refuse("mint_invalid", `mint ${JSON.stringify(mint)} ${mintKey.why}`);

  const infos = Array.isArray(accountInfos) ? accountInfos : accountInfos == null ? [] : [accountInfos];
  const owners = new Set();
  for (const info of infos) {
    const owner = ownerOf(info);
    if (owner) owners.add(owner);
  }

  const matches = [...registry.values()].filter((r) => owners.has(r.adapter.programId));
  if (matches.length === 0)
    return refuse("venue_unknown",
      `no registered venue owns any of the ${owners.size} account owner(s) supplied for ${mint}` +
      ` (${[...owners].join(", ") || "none"}); registered: ${registeredVenues(registry).map((a) => a.id).join(", ") || "none"}`,
      { owners: Object.freeze([...owners]) });
  if (matches.length > 1)
    return refuse("venue_ambiguous",
      `${matches.length} registered venues claim ${mint}: ${matches.map((r) => r.adapter.id).join(", ")}`,
      { venues: Object.freeze(matches.map((r) => r.adapter.id)) });

  const adapter = matches[0].adapter;
  /* THE WHOLE CONTRACT, AGAIN, EVERY TIME. Not an optimisation target: it is pure
     arithmetic on a small object, and the alternative — trusting a verdict computed at
     boot — is exactly the stale-permission bug this file was written to make impossible. */
  const verdict = venueContract(adapter, { execute });
  if (!verdict.ok)
    return { ok: false, venue: null, certificate: null, clause: verdict.clause,
      detail: { mint, ...verdict.detail } };

  return { ok: true, venue: adapter, certificate: assertVenueContract(adapter, { execute }),
    clause: null, detail: { mint, ...verdict.detail } };
}
