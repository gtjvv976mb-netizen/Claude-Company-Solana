/**
 * THE SNIPER LANE — feed -> gate -> ceiling -> shadow -> determiner, AND NOTHING ELSE.
 *
 * OBSERVE-ONLY, and structurally rather than by policy. No keypair is loaded on any path
 * in this file, nothing is signed, nothing is sent, and the venue adapter this lane hands
 * to the gate stack is a FACADE whose three instruction encoders throw
 * (`observeOnlyVenue()` below). A lane that merely declined to call `buyIx` would be one
 * careless edit from calling it; a lane that cannot reach it is a different kind of
 * object. `test-snipe-lane.mjs` drives the whole pipeline and then asserts the real
 * adapter's encoder counters are still zero.
 *
 * IT IS NOT STARTED AT IMPORT. Importing this module opens no socket, starts no timer,
 * reads no environment and creates no Connection — `createSnipeLane()` builds an object,
 * and only `start()` subscribes. Nothing in poller.mjs calls any of it yet. That is
 * deliberate: the five narrow poller/journal edits are a separate commit, and until they
 * land this lane cannot trade because nothing invokes it.
 *
 * ── WHY THE CONFIG IS A SEPARATE OBJECT AND NOT A BRANCH OF CFG ─────────────────────
 *
 * `snipeLaneConfig()` reads ONLY `SNIPE_*` environment names into its own frozen object.
 * A shared config builder is the one realistic way a sniper dial silently re-enables a
 * bot-led exit on the desk path: the desk holds unconditionally (strategy.mjs
 * stepPosition returns hold without a deskExit) because the owner decided that after a
 * measured incident, and a key with the same name in both objects is how that decision
 * gets edited by someone who thought they were tuning a sniper. Two objects, two prefixes,
 * one test that asserts the names are disjoint.
 *
 * ── THE TWO FEE NUMBERS ARE NOT THE SAME NUMBER, AND CONFLATING THEM BREAKS THE BOOK ─
 *
 * poller.mjs:199-204 splits them on purpose and this lane inherits the split verbatim:
 *
 *   · `expectedNetworkFeeLamports` (500,000) is a COST MODEL. It sizes the position —
 *     `networkFeeReserveSol` feeds `minViableSolPerTrade`, therefore `snipeFloor`,
 *     therefore the derived 0.80 stop distance, and it is the fee inside `frictionX`.
 *     Raising it can only ever REFUSE trades.
 *   · What `assertNetworkFeeBudget` judges is the ESTIMATED signature + priority fee of
 *     the actual transaction. Measured on four live rehearsals on 2026-09-03 those ran
 *     1,356 to 92,207 lamports on a ~135k CU transaction (poller.mjs:159-177), i.e. one
 *     to two orders of magnitude under the cost model.
 *
 * Feeding the cost model into the budget gate refuses everything at the live cap: the
 * basis is the entry ceiling (<= 5,000,000 lamports) and `maxNetworkFeePct 10` admits at
 * most 500,000, so a 500,000-lamport "fee" is ON the boundary and one lamport of rounding
 * in the ceiling puts it over. A shadow book that refuses every row at gate 19 measures
 * its own arithmetic instead of the market. So the observe fee model here is the MEASURED
 * PEAK priority fee plus the chain's fixed per-signature 5,000 — the conservative end of
 * the real distribution — while the cost model keeps its own name and its own job.
 *
 * ── THE SECOND ENDPOINT IS NOT OPTIONAL ─────────────────────────────────────────────
 *
 * poller.mjs:660-663 opens a secondary Connection only when EXECUTE is on, so in the
 * observe configuration the poller has ONE endpoint — and the whole witness design (§2.3:
 * two witnesses, strictly increasing slots, DIFFERENT endpoints) could not run. An observe
 * book that validates a rule the live lane does not run is worse than no book, so this
 * lane requires two readers with distinct ids UNCONDITIONALLY and refuses to start with
 * one. It also never constructs a Connection itself: readers are injected, which is what
 * makes the whole pipeline runnable offline against fakes.
 *
 * ── WHAT THE DAILY CAP MEANS WHEN NOTHING IS SPENT ──────────────────────────────────
 *
 * `daily_capacity` is a real gate and it runs on every notice. But in observe the ticket
 * is hypothetical, and charging hypothetical tickets against the real 0.01 SOL cap would
 * silence the book after TWO notices a day — the book would then be a measurement of our
 * own cap rather than of the market, and the 200-row sample floor would take a hundred
 * days to reach. So `chargeDailyCap` defaults to false in observe: the gate is evaluated
 * against whatever `deployedTodaySol` the caller actually supplies (the journal's real
 * number, which already includes reverted-race fees — F3), and the would-have-entries are
 * counted in the report instead. Set `SNIPE_CHARGE_DAILY_CAP=1` and the lane charges them
 * and goes quiet exactly as the live lane would; the test drives both directions and
 * prints the row counts each produced.
 *
 * ── THE DETERMINER IS BOUND, NOT IMPORTED BY NAME ───────────────────────────────────
 *
 * `snipe-policy.mjs` on disk is a DRAFT (spec §7.1: it was written by a parallel session
 * and §2.4 says its `stopFrac: 0.70` must be replaced by the derivation, because at the
 * live cap `minViableSolPerTrade(cfg, 0.70) = 0.005714` is a position the repo's own
 * sizing engine refuses). The spec's rewrite exports `openSnipe`/`snipeStep`; the draft
 * exports `freshSnipe`/`snipePolicy`. This lane binds through `bindDeterminer()`, which
 * accepts EITHER shape and refuses loudly when neither is present — so whichever draft
 * survives the owner's decision, the lane is wired to it without this file being the
 * thing that has to change, and without it silently running against half an API.
 */
import { createHash } from "node:crypto";

import { snipeContract, SNIPE_GATES } from "./snipe-entry.mjs";
import { curveExitMarkX, frictionXFor, snipeFloor } from "./snipe-curve.mjs";
import { venueContract } from "./snipe-venue.mjs";
import { createSnipeShadow, SHADOW_HOPS } from "./snipe-shadow.mjs";
import { closeSnipe, ensureSnipeBook, openSnipe, snipeFor, snipeList, updateSnipe } from "./snipe-book.mjs";
import * as snipePolicy from "./snipe-policy.mjs";

export const SNIPE_LANE_VERSION = "snipe-lane-v1";

/** The only two modes this file admits. `execute` is listed so a caller can NAME it and
 *  be refused by name; there is no signing path here to run it on. */
export const SNIPE_LANE_MODES = Object.freeze(["off", "observe", "execute"]);

/** Every refusal this module can produce, ordered cheapest-first like the gate list, so a
 *  caller branches on a code rather than on English. */
export const SNIPE_LANE_CLAUSES = Object.freeze([
  "mode_invalid",
  "execute_not_implemented",
  "venue_missing",
  "venue_refused",
  "single_endpoint",
  "duplicate_endpoint",
  "control_unchecked",
  "determiner_unbound",
  "feed_missing",
  "signing_refused",
  "already_started",
]);

export class SnipeLaneError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "SnipeLaneError";
    if (!SNIPE_LANE_CLAUSES.includes(clause))
      throw new Error(`SnipeLaneError given clause ${JSON.stringify(clause)}, which is not in SNIPE_LANE_CLAUSES`);
    this.clause = clause;
    this.detail = Object.freeze({ ...detail });
  }
}

/** The three adapter methods this lane refuses to be able to call. Named, exported, and
 *  asserted by the test both ways: the facade throws on each, and the underlying adapter's
 *  own counters stay at zero across a full run. */
export const LANE_REFUSED_VENUE_METHODS = Object.freeze(["buyIx", "buildBuy", "sellIx"]);

/**
 * THE DEFAULTS, AND WHERE EVERY ONE OF THEM COMES FROM.
 *
 * The rails are RE-DECLARED rather than imported, for a mechanical reason: they live in
 * `poller.mjs LIVE_LIMITS`, and poller.mjs is the daemon — importing it starts the bot.
 * `test-snipe-lane.mjs` reads poller.mjs AS TEXT and asserts every value below that claims
 * to mirror a rail still equals the rail, which is the same mirror technique
 * `test-token2022-mirror.mjs` uses to hold the desk's extension allowlist in step with the
 * executor's. A copy that is tested against its source is a copy; one that is not is a
 * fork waiting to happen.
 */
export const SNIPE_LANE_DEFAULTS = Object.freeze({
  /* off until an operator says otherwise. `lane_off` is gate 0 for a reason. */
  lane: "off",

  /* ── mirrored from poller.mjs LIVE_LIMITS (:154-206) ───────────────────────────── */
  maxSolPerTrade: 0.005,
  dailySolCap: 0.01,
  maxPriceImpactPct: 5,
  maxEntryRoundTripLossPct: 12,
  maxNetworkFeeLamports: 2_000_000,
  maxNetworkFeePct: 10,
  maxRentLamports: 4_200_000,
  /* THE COST MODEL, in SOL, exactly as poller.mjs:1407 derives it from
     expectedNetworkFeeLamports 500,000. It sizes the position and it is the fee inside
     frictionX. It is NOT what the fee gate judges — see the header. */
  networkFeeReserveSol: 0.0005,

  /* ── mirrored from strategy.mjs DEFAULTS (:131, :134) ──────────────────────────── */
  maxFeeShareOfStop: 0.25,
  minSolPerTrade: 0.005,

  /* ── the fee MODEL the budget gate judges, from measured live rehearsals ───────── */
  /* The chain's fixed per-signature fee. One signature on this transaction. */
  signatureFeeLamports: 5_000,
  /* The PEAK of four live priority-fee rehearsals on 2026-09-03 (1,356 / 38,785 / 50,002
     / 92,207 lamports on a ~135k CU transaction, poller.mjs:159-177). Modelling the peak
     is the conservative direction for a REFUSAL gate: it can only make the shadow book
     refuse rows the live lane would have taken, never the reverse. */
  priorityFeeLamports: 92_207,
  /* One destination ATA. poller.mjs:205-207 records the gross for a temporary WSOL ATA
     plus a destination ATA as 4,078,560; a curve buy needs the destination only. */
  rentFeeLamports: 2_039_280,

  /* ── this lane's own dials ─────────────────────────────────────────────────────── */
  /* THE LANE'S NOTICE->SIGNATURE LATENCY IS UNMEASURED (spec §7.8) and this number is not
     a claim about it. It is a bound, set generously in observe so the book measures the
     distribution rather than pre-filtering it; the log is what will eventually justify a
     real one. `notice_stale` refuses outright when it is unset, which is the correct
     behaviour for a t=0 gate with no bound. */
  noticeMaxMs: 30_000,
  /* The venue fee, in bps, when the adapter cannot read its own. Null means "unknown",
     and an unknown fee makes every quote refuse — which is the right refusal: a quote
     priced at a fee we guessed is a ceiling we cannot defend. */
  venueFeeBps: null,
  /* Forward path after the would-have-fill: how many samples, how far apart. The positive
     class (a launch nobody followed) is read off these. */
  forwardSamples: 12,
  forwardIntervalMs: 5_000,
  /* How long a would-have-position stays in the observe book before the lane closes it on
     the clock. §2.5 puts the CLOCK above TAKE deliberately: it is the default outcome of
     this lane, not its backstop. */
  holdMaxMs: 10 * 60_000,
  /* See the header. False in observe so the book is not silenced after two notices. */
  chargeDailyCap: false,
  shadowCapacity: 5_000,
  /* Proxy thresholds are deliberately ABSENT by default (undefined, not a number), so the
     two proxy gates MEASURE and never kill until somebody has run them against a known
     answer. src/launch-shadow.js states the discipline; snipe-shadow.mjs scores them. */
  maxCreatorSharePct: undefined,
  maxLaunchSharePct: undefined,
});

/**
 * THE ENVIRONMENT NAMES, and nothing outside this table is read.
 *
 * Exported so `test-snipe-separation.mjs` can assert that none of them appears in the
 * desk's CFG builder, and so this file's own test can assert that every name starts with
 * `SNIPE_`.
 */
export const SNIPE_ENV = Object.freeze({
  SNIPE_LANE: Object.freeze({ key: "lane", parse: "mode" }),
  SNIPE_MAX_SOL_PER_TRADE: Object.freeze({ key: "maxSolPerTrade", parse: "number" }),
  SNIPE_DAILY_SOL_CAP: Object.freeze({ key: "dailySolCap", parse: "number" }),
  SNIPE_MAX_PRICE_IMPACT_PCT: Object.freeze({ key: "maxPriceImpactPct", parse: "number" }),
  SNIPE_MAX_ROUND_TRIP_LOSS_PCT: Object.freeze({ key: "maxEntryRoundTripLossPct", parse: "number" }),
  SNIPE_MAX_NETWORK_FEE_LAMPORTS: Object.freeze({ key: "maxNetworkFeeLamports", parse: "number" }),
  SNIPE_MAX_NETWORK_FEE_PCT: Object.freeze({ key: "maxNetworkFeePct", parse: "number" }),
  SNIPE_MAX_RENT_LAMPORTS: Object.freeze({ key: "maxRentLamports", parse: "number" }),
  SNIPE_NETWORK_FEE_RESERVE_SOL: Object.freeze({ key: "networkFeeReserveSol", parse: "number" }),
  SNIPE_MAX_FEE_SHARE_OF_STOP: Object.freeze({ key: "maxFeeShareOfStop", parse: "number" }),
  SNIPE_MIN_SOL_PER_TRADE: Object.freeze({ key: "minSolPerTrade", parse: "number" }),
  SNIPE_SIGNATURE_FEE_LAMPORTS: Object.freeze({ key: "signatureFeeLamports", parse: "number" }),
  SNIPE_PRIORITY_FEE_LAMPORTS: Object.freeze({ key: "priorityFeeLamports", parse: "number" }),
  SNIPE_RENT_FEE_LAMPORTS: Object.freeze({ key: "rentFeeLamports", parse: "number" }),
  SNIPE_NOTICE_MAX_MS: Object.freeze({ key: "noticeMaxMs", parse: "number" }),
  SNIPE_VENUE_FEE_BPS: Object.freeze({ key: "venueFeeBps", parse: "number" }),
  SNIPE_FORWARD_SAMPLES: Object.freeze({ key: "forwardSamples", parse: "number" }),
  SNIPE_FORWARD_INTERVAL_MS: Object.freeze({ key: "forwardIntervalMs", parse: "number" }),
  SNIPE_HOLD_MAX_MS: Object.freeze({ key: "holdMaxMs", parse: "number" }),
  SNIPE_SHADOW_CAPACITY: Object.freeze({ key: "shadowCapacity", parse: "number" }),
  SNIPE_CHARGE_DAILY_CAP: Object.freeze({ key: "chargeDailyCap", parse: "flag" }),
  SNIPE_MAX_CREATOR_SHARE_PCT: Object.freeze({ key: "maxCreatorSharePct", parse: "number" }),
  SNIPE_MAX_LAUNCH_SHARE_PCT: Object.freeze({ key: "maxLaunchSharePct", parse: "number" }),
});

/* Every env name must carry the prefix that keeps the two config objects apart. Asserted
   at import so a name added without it is a boot failure, not a surprise in six weeks. */
{
  const stray = Object.keys(SNIPE_ENV).filter((name) => !name.startsWith("SNIPE_"));
  if (stray.length) throw new Error(`snipe-lane env names must start with SNIPE_: ${stray.join(", ")}`);
  const keys = Object.values(SNIPE_ENV).map((e) => e.key);
  const unknown = keys.filter((k) => !(k in SNIPE_LANE_DEFAULTS));
  if (unknown.length) throw new Error(`snipe-lane env maps to unknown config keys: ${unknown.join(", ")}`);
}

/**
 * Build the lane's config from an environment object. Reads ONLY the table above, so a
 * desk variable cannot reach this lane and a sniper variable cannot reach the desk.
 *
 * A malformed value is REFUSED, never coerced: `SNIPE_MAX_SOL_PER_TRADE=abc` silently
 * becoming NaN and then a gate refusing "cfg.maxSolPerTrade is not a usable ticket size"
 * four gates later names the wrong fact. And a flag is read strictly — "0" is truthy as a
 * string, which is how an OFF switch turns something on.
 */
export function snipeLaneConfig(env = {}) {
  const out = { ...SNIPE_LANE_DEFAULTS };
  for (const [name, spec] of Object.entries(SNIPE_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const text = String(raw).trim();
    if (spec.parse === "mode") {
      if (!SNIPE_LANE_MODES.includes(text))
        throw new SnipeLaneError("mode_invalid",
          `${name}=${JSON.stringify(text)} is not one of ${SNIPE_LANE_MODES.join(", ")}`, { name, value: text });
      out[spec.key] = text;
    } else if (spec.parse === "number") {
      const n = Number(text);
      if (!Number.isFinite(n))
        throw new SnipeLaneError("mode_invalid", `${name}=${JSON.stringify(text)} is not a number`, { name, value: text });
      out[spec.key] = n;
    } else {
      /* Strictly: 1/true/yes is on, 0/false/no/absent is off, anything else is a refusal
         rather than a guess about what the operator meant. */
      if (["1", "true", "yes", "on"].includes(text.toLowerCase())) out[spec.key] = true;
      else if (["0", "false", "no", "off"].includes(text.toLowerCase())) out[spec.key] = false;
      else throw new SnipeLaneError("mode_invalid", `${name}=${JSON.stringify(text)} is not a boolean flag`, { name, value: text });
    }
  }
  /* SNIPE_EXECUTE exists only to be refused. There is no signing path in this file, and a
     lane that accepted the flag and then quietly observed would be worse than one that
     says so. */
  const wantsExecute = out.lane === "execute"
    || ["1", "true", "yes", "on"].includes(String(env.SNIPE_EXECUTE ?? "").trim().toLowerCase());
  if (wantsExecute)
    throw new SnipeLaneError("execute_not_implemented",
      "this lane is observe-only: no keypair is loaded, nothing is signed and nothing is sent. "
      + "Arming live is a separate owner decision on the shadow book's evidence, and a separate "
      + "signing path that does not exist yet.",
      { lane: out.lane, snipeExecute: env.SNIPE_EXECUTE ?? null });
  return Object.freeze(out);
}

/* ── the observe-only venue facade ─────────────────────────────────────────────────── */

/**
 * The adapter, with its instruction encoders replaced by refusals.
 *
 * `venueContract` requires all twelve methods to be PRESENT as functions, so they are —
 * they just throw. Everything else is copied verbatim, including `layoutVerified` and any
 * `layoutProof`, because the facade must not be able to make a venue look more proved than
 * it is. The contract is then re-run on the facade so a facade that lost a method is
 * caught here rather than at the first notice.
 */
export function observeOnlyVenue(adapter) {
  if (adapter === null || typeof adapter !== "object")
    throw new SnipeLaneError("venue_missing", `a venue adapter is required; received ${adapter === null ? "null" : typeof adapter}`);
  const refuse = (method) => () => {
    throw new SnipeLaneError("signing_refused",
      `${method}() is not reachable from the observe lane: no keypair is loaded here, nothing is signed `
      + "and nothing is sent. The encoder is also unproved — a layout must be proved by a decode "
      + "round-trip against a real on-chain transaction before any signing code exists.",
      { method, venueId: adapter.id ?? null });
  };
  const facade = { ...adapter, observeOnly: true };
  for (const method of LANE_REFUSED_VENUE_METHODS) facade[method] = refuse(method);
  const frozen = Object.freeze(facade);
  const verdict = venueContract(frozen, { execute: false });
  if (!verdict.ok)
    throw new SnipeLaneError("venue_refused",
      `the observe facade does not satisfy the venue contract: ${verdict.detail.message}`,
      { clause: verdict.clause, venueId: adapter.id ?? null });
  return frozen;
}

/* ── the determiner binding ────────────────────────────────────────────────────────── */

/**
 * Bind whichever exit determiner `snipe-policy.mjs` actually presents.
 *
 * Two shapes are accepted, because the file on disk is a draft the owner has yet to
 * choose between (spec §7.1) and this lane must not be the reason a rewrite breaks:
 *
 *   · the spec's rewrite — `openSnipe(...)` + `snipeStep({pos, sample, cfg, nowMs})`
 *   · the draft on disk  — `freshSnipe(...)` + `snipePolicy({position, mark, nowMs, ...})`
 *
 * Neither present is a REFUSAL at construction, not a silent no-op tick: a lane whose
 * determiner never ran would fill a shadow book with positions nothing ever decided
 * about, and every trigger in §2.5 would read as untested because it never fired.
 *
 * The mark handed over is `markX` — the simulated sell of the whole would-have-fill back
 * into the curve, over the swap input. It is a ROUND-TRIP MULTIPLE, so the position's
 * `entry` is 1 by construction and friction is already inside the number.
 */
export function bindDeterminer(policy = snipePolicy) {
  if (policy === null || typeof policy !== "object")
    throw new SnipeLaneError("determiner_unbound", "a determiner module is required");

  const hasNew = typeof policy.snipeStep === "function" && typeof policy.openSnipe === "function";
  const hasDraft = typeof policy.snipePolicy === "function" && typeof policy.freshSnipe === "function";
  if (!hasNew && !hasDraft)
    throw new SnipeLaneError("determiner_unbound",
      "snipe-policy.mjs presents neither {openSnipe, snipeStep} (the spec's rewrite) nor "
      + "{freshSnipe, snipePolicy} (the draft on disk); the lane will not run a half-bound determiner",
      { exports: Object.keys(policy).sort() });

  return Object.freeze({
    shape: hasNew ? "snipeStep" : "snipePolicy",
    version: policy.SNIPE_POLICY_VERSION ?? null,
    open(draft) {
      return hasNew ? policy.openSnipe(draft) : policy.freshSnipe(draft);
    },
    step({ position, markX, nowMs, cfg, creatorSold = false, rugFlag = false, sample = null }) {
      if (hasNew)
        return policy.snipeStep({ pos: position, sample: sample ?? { markX, nowMs }, cfg, nowMs });
      return policy.snipePolicy({
        position, mark: markX, nowMs, config: cfg?.policy ?? {}, creatorSold, rugFlag,
      });
    },
  });
}

/* ── endpoint reads ────────────────────────────────────────────────────────────────── */

const LAMPORTS = 1_000_000_000;
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** A stable digest of an account's bytes, so two endpoints can be compared without
 *  trusting either one's field decoding. Two nodes at one slot must return the same
 *  bytes; anything else is a decode fault or a lying node (§2.3's fourth layer). */
function digestOf(account) {
  const data = account?.data ?? null;
  if (data === null || data === undefined) return null;
  const bytes = typeof data === "string" ? Buffer.from(data, "base64")
    : Array.isArray(data) && typeof data[0] === "string" ? Buffer.from(data[0], data[1] || "base64")
      : Buffer.from(data);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Read the venue's accounts on EVERY endpoint and classify how they answered.
 *
 * The classification is the TOAD fix applied at entry rather than at exit — classify,
 * don't count:
 *
 *   · neither endpoint has the account        -> both_missing  (refuse; there is nothing)
 *   · one has it and the other does not       -> one_missing   (refuse; a node's gap is
 *                                                not a chain fact, and at ENTRY a half
 *                                                read is a reason not to act at all)
 *   · both have it, same slot, different bytes-> disagree      (refuse; a fault)
 *   · both have it, different slots           -> agree, on the NEWER slot, with the stale
 *                                                endpoint recorded
 *
 * Every one of these ends at the same gate — `curve_unreadable` — because the frozen gate
 * list is additive-only and inventing a code here would put it outside `GATE_CLASS`, where
 * `src/calls.js gateClass()` would answer SAFETY and turn a transport hiccup into an
 * un-waivable rug check. The distinction is carried on the shadow row instead, which is
 * where it is actually read.
 */
export async function readAcrossEndpoints({ readers, addresses, mint }) {
  const results = [];
  for (const reader of readers) {
    try {
      const answer = await reader.read(mint, addresses);
      results.push({
        id: reader.id,
        slot: Number.isFinite(Number(answer?.slot)) ? Number(answer.slot) : null,
        accounts: Array.isArray(answer?.accounts) ? answer.accounts : [],
        error: null,
      });
    } catch (error) {
      results.push({ id: reader.id, slot: null, accounts: [], error: String(error?.message ?? error) });
    }
  }

  const view = results.map((r) => ({
    id: r.id, slot: r.slot, error: r.error,
    present: isPlainObject(r.accounts?.[0]) && (r.accounts[0].data !== undefined && r.accounts[0].data !== null),
    digest: r.accounts?.[0] ? digestOf(r.accounts[0]) : null,
    accounts: r.accounts,
  }));

  const present = view.filter((v) => v.present);
  let verdict;
  let chosen = null;
  if (view.length < 2) verdict = "single";
  else if (present.length === 0) verdict = "both_missing";
  else if (present.length < view.length) verdict = "one_missing";
  else {
    const digests = new Set(present.map((v) => v.digest));
    const slots = new Set(present.map((v) => v.slot));
    if (digests.size > 1 && slots.size === 1) verdict = "disagree";
    else {
      verdict = "agree";
      chosen = present.reduce((a, b) => ((b.slot ?? -1) > (a.slot ?? -1) ? b : a));
    }
  }
  if (verdict === "single" && present.length === 1) chosen = present[0];

  return Object.freeze({
    verdict,
    chosen,
    slot: chosen?.slot ?? null,
    accounts: chosen?.accounts ?? [],
    endpoints: Object.freeze(view.map((v) => Object.freeze({
      id: v.id, slot: v.slot, present: v.present, digest: v.digest, error: v.error,
    }))),
  });
}

/* ── the lane ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the lane. NOTHING IS STARTED HERE — no socket, no timer, no Connection.
 *
 * @param {object}   args
 * @param {object}   args.venue    the venue adapter (snipe-venue.mjs contract)
 * @param {object}   args.feed     a snipe-feed.mjs feed, or anything with the same shape
 * @param {object[]} args.readers  >= 2 of `{id, async read(mint, addresses) -> {slot, accounts}}`
 * @param {function} args.control  () -> {hardStop, pauseEntries} as STRICT booleans. Required:
 *                                 an unchecked sentinel is not the same fact as an absent one.
 * @param {object}   [args.cfg]    snipeLaneConfig() output, or a patch of it
 * @param {function} [args.clock]  () -> epoch ms. Injected so a replay is byte-identical.
 * @param {object}   [args.state]  the process state object that owns `S.snipes`
 * @param {object}   [args.shadow] a snipe-shadow.mjs recorder; one is built if absent
 * @param {object}   [args.policy] the determiner module
 * @param {function} [args.log]    a line sink
 */
export function createSnipeLane({
  venue, feed = null, readers = [], control = null, cfg = {}, clock = () => Date.now(),
  state = {}, shadow = null, policy = snipePolicy, log = () => {}, book = null,
} = {}) {
  const conf = Object.freeze({ ...SNIPE_LANE_DEFAULTS, ...cfg });
  if (!SNIPE_LANE_MODES.includes(conf.lane))
    throw new SnipeLaneError("mode_invalid", `lane ${JSON.stringify(conf.lane)} is not one of ${SNIPE_LANE_MODES.join(", ")}`);
  if (conf.lane === "execute")
    throw new SnipeLaneError("execute_not_implemented",
      "createSnipeLane refuses lane=execute: there is no signing path in this file and no keypair is "
      + "loaded on it. The shadow book is the deliverable; arming is a separate owner decision.",
      { lane: conf.lane });

  const adapter = observeOnlyVenue(venue);

  /* TWO ENDPOINTS, UNCONDITIONALLY. See the header: the poller has one in observe, and a
     book that validates a witness rule the live lane cannot run is worse than no book. */
  if (!Array.isArray(readers) || readers.length < 2)
    throw new SnipeLaneError("single_endpoint",
      `the lane needs at least two distinct endpoints (received ${Array.isArray(readers) ? readers.length : 0}) — `
      + "the two-endpoint witness rule cannot run on one, and poller.mjs:660-663 opens a secondary "
      + "Connection only when EXECUTE is on, which is exactly the configuration this lane ships in",
      { endpoints: Array.isArray(readers) ? readers.length : 0 });
  const ids = readers.map((r) => r?.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim()))
    throw new SnipeLaneError("single_endpoint", `every reader needs a string id; received [${ids.map(String).join(", ")}]`);
  if (new Set(ids).size !== ids.length)
    throw new SnipeLaneError("duplicate_endpoint",
      `two readers share an id ([${ids.join(", ")}]) — two names for one node is one witness counted twice, `
      + "which is the exact failure the different-endpoint rule exists to prevent", { ids });

  if (typeof control !== "function")
    throw new SnipeLaneError("control_unchecked",
      "the lane needs a control reader returning {hardStop, pauseEntries} as strict booleans; there is no "
      + "safe default, because an unchecked sentinel is not the same fact as an absent one");

  const determiner = bindDeterminer(policy);
  const S = state;
  ensureSnipeBook(S);
  if (S.positions === undefined) S.positions = {};
  const recorder = shadow ?? createSnipeShadow({ capacity: conf.shadowCapacity, laneMode: conf.lane });

  const counters = {
    notices: 0, recorded: 0, cleared: 0, refused: 0, wouldHaveOpened: 0,
    wouldHaveExited: 0, forwardSamples: 0, readErrors: 0, ticks: 0, deterministErrors: 0,
  };
  /* The would-have-deployed total. It charges the real daily cap only when the operator
     asks; either way it is REPORTED, so "how many would this lane have taken today" is a
     number the book produces rather than one anybody estimates. */
  let wouldHaveDeployedSol = 0;
  let started = false;
  let stopping = false;
  let consumed = null;

  const bookView = () => Object.freeze({
    snipes: S.snipes,
    positions: S.positions,
    attempts: book?.attempts ?? Object.freeze({}),
    deployedTodaySol: (Number(book?.deployedTodaySol) || 0)
      + (conf.chargeDailyCap ? wouldHaveDeployedSol : 0),
  });

  const controlView = () => {
    const c = control() ?? {};
    return Object.freeze({ hardStop: c.hardStop, pauseEntries: c.pauseEntries });
  };

  /** The fee model the budget gate judges — the measured estimate, never the cost model. */
  const feeModel = () => Object.freeze({
    signatureFeeLamports: Number(conf.signatureFeeLamports) || 0,
    prioritizationFeeLamports: Number(conf.priorityFeeLamports) || 0,
    rentFeeLamports: Number(conf.rentFeeLamports) || 0,
  });

  const feeReserveLamports = () => BigInt(Math.round((Number(conf.networkFeeReserveSol) || 0) * LAMPORTS));

  /**
   * ONE NOTICE, END TO END. Never throws past its caller: a lane that dies on one bad
   * launch stops recording every launch after it, and the row that killed it is the one
   * row that would have explained why.
   */
  async function handleNotice(record) {
    counters.notices++;
    const mint = record?.mint;
    const noticeAtMs = Number.isFinite(Number(record?.firstSeenAtMs)) ? Number(record.firstSeenAtMs) : clock();
    const hops = [{ hop: "notice", atMs: noticeAtMs }];

    /* COST 1: the one getMultipleAccounts, on every endpoint. */
    let read;
    try {
      read = await readAcrossEndpoints({ readers, addresses: adapter.accountsFor(mint), mint });
    } catch (error) {
      counters.readErrors++;
      read = Object.freeze({ verdict: "both_missing", chosen: null, slot: null, accounts: [],
        endpoints: Object.freeze(readers.map((r) => Object.freeze({
          id: r.id, slot: null, present: false, digest: null, error: String(error?.message ?? error) }))) });
    }
    hops.push({ hop: "accounts", atMs: clock() });

    /* Decode only on an unambiguous read. Every other classification hands `null` to the
       gate stack, which refuses at `curve_unreadable` — the classification itself rides on
       the row. */
    let curve = null;
    if (read.verdict === "agree" || read.verdict === "single") {
      try {
        const feeBps = venueFeeBps();
        curve = adapter.curveFromAccount(read.accounts[0], { feeBps, mint }) ?? null;
      } catch { curve = null; }
    }
    hops.push({ hop: "decode", atMs: clock() });

    const verdict = snipeContract({
      notice: {
        mint,
        creator: record?.creator ?? null,
        slot: record?.firstSlot ?? null,
        noticeAt: noticeAtMs,
        source: record?.firstSource ?? null,
      },
      curve,
      adapter,
      cfg: conf,
      book: bookView(),
      nowMs: clock(),
      control: controlView(),
      mint: read.accounts[2] ?? null,
      creator: creatorFacts(record, curve),
      fees: feeModel(),
      instruction: null,
    });
    hops.push({ hop: "gate", atMs: clock() });

    /* frictionX for the fill this row would have been: computed from the lamports the
       ceiling says would actually have been paid, with the COST MODEL on both legs. It is
       ~1.20x at the live cap, no exit logic can improve it, and it is printed on the row
       so nobody has to recompute it from memory later. */
    let frictionX = null;
    const entryInputRaw = verdict.detail.maxQuoteInRaw ?? null;
    if (entryInputRaw !== null && entryInputRaw > 0n) {
      try {
        frictionX = frictionXFor({
          entryInputLamports: entryInputRaw,
          entryFeeLamports: feeReserveLamports(),
          expectedExitFeeLamports: feeReserveLamports(),
        });
      } catch { frictionX = null; }
    }
    hops.push({ hop: "ceiling", atMs: clock() });
    hops.push({ hop: "record", atMs: clock() });

    const row = recorder.record({
      mint,
      venueId: adapter.id,
      notice: record ?? {},
      createSlot: record?.firstSlot ?? null,
      observedSlot: read.slot,
      endpointVerdict: read.verdict,
      endpoints: read.endpoints,
      curve,
      verdict,
      hops,
      frictionX,
      ticketLamports: verdict.detail.ticketLamports ?? null,
    });
    counters.recorded++;

    if (verdict.ok) {
      counters.cleared++;
      openWouldBePosition({ row, mint, curve, verdict, frictionX, record, slot: read.slot });
    } else {
      counters.refused++;
      log(`snipe shadow ${mint}: refused at ${verdict.gate} — ${verdict.detail.message}`);
    }
    return Object.freeze({ row, verdict });
  }

  /** The venue's own fee, when it carries a measured one; otherwise the config's, which is
   *  null by default — and a null fee makes every quote refuse, which is the correct
   *  refusal for a ceiling we could not defend. */
  function venueFeeBps() {
    if (Number.isFinite(Number(conf.venueFeeBps))) return Number(conf.venueFeeBps);
    const observed = Number(adapter.feeObservation?.totalFeeBps);
    return Number.isFinite(observed) ? observed : null;
  }

  /** The statistical layer, measured on every notice whether or not a threshold is set. */
  function creatorFacts(record, curve) {
    const creator = record?.creator ?? curve?.creator ?? null;
    const facts = book?.creatorFacts?.(creator) ?? {};
    return Object.freeze({
      creator,
      shareOfSupplyPct: Number.isFinite(Number(facts.shareOfSupplyPct)) ? Number(facts.shareOfSupplyPct) : undefined,
      priorLaunches: Number.isFinite(Number(facts.priorLaunches)) ? Number(facts.priorLaunches) : undefined,
    });
  }

  /**
   * FILE THE FILL THE LANE WOULD HAVE TAKEN — at the CEILING, not at the quote.
   *
   * The ceiling is the worst price we would have accepted and the only number the chain
   * could actually have charged us, so recording the fill there is the conservative side
   * of the one assumption a shadow book has to make. The alternative — recording the
   * exact-in quote — records a fill at a price nobody was obliged to give us.
   */
  function openWouldBePosition({ row, mint, curve, verdict, frictionX, record, slot }) {
    const openedAt = clock();
    const entryInputLamports = verdict.detail.maxQuoteInRaw;
    const qtyRaw = verdict.detail.baseOutRaw;
    const feeLamports = feeReserveLamports();
    try {
      const position = determiner.open({
        mint,
        /* markX at the fill is 1 by construction: the mark is a round-trip multiple over
           the swap input, so `entry` is the input itself. */
        entry: 1,
        openedAt,
        creator: record?.creator ?? curve?.creator ?? null,
        sizeSol: Number(entryInputLamports) / LAMPORTS,
        feeSolPerLeg: Number(feeLamports) / LAMPORTS,
      });
      const filed = openSnipe(S, {
        ...position,
        mint,
        venue: adapter.id,
        entry: 1,
        openedAt,
        sizeSol: Number(entryInputLamports) / LAMPORTS,
        feeSolPerLeg: Number(feeLamports) / LAMPORTS,
        qtyRaw,
        entryInputLamports,
        entryFeeLamports: feeLamports,
        creator: record?.creator ?? curve?.creator ?? null,
        openedAtSlot: slot,
        frictionXAtOpen: frictionX,
        samples: 0,
      });
      counters.wouldHaveOpened++;
      wouldHaveDeployedSol += Number(entryInputLamports) / LAMPORTS;
      const floor = safeFloor();
      log(`snipe shadow ${mint}: WOULD HAVE ENTERED — ${qtyRaw} base for at most ${entryInputLamports} lamports, `
        + `frictionX ${frictionX === null ? "?" : frictionX.toFixed(4)}, floorMarkX ${floor.floorMarkX.toFixed(4)}, `
        + `queue depth ${row.slotDeltaToFirstMark === null ? "unmeasured" : `${row.slotDeltaToFirstMark} slots`}`);
      return filed;
    } catch (error) {
      /* A book refusal here is a finding, not a crash: it means the fill this lane would
         have taken is one the book could not price, which is exactly what the book is for. */
      log(`snipe shadow ${mint}: the book refused the would-have-fill (${error.clause ?? error.name}): ${error.message}`);
      return null;
    }
  }

  const safeFloor = () => {
    try { return snipeFloor({ cfg: conf, sol: Number(conf.maxSolPerTrade) }); }
    catch { return { stopFrac: 0, floorMarkX: 0, minViableSol: 0 }; }
  };

  /**
   * ONE TICK OVER THE OBSERVE BOOK: re-read every would-have-position on both endpoints,
   * price it, ask the determiner, and record what it said. Nothing sells, because nothing
   * was bought; a `sell` verdict closes the row and is recorded as a would-have-exit.
   */
  async function tick() {
    counters.ticks++;
    const open = snipeList(S);
    const out = [];
    for (const pos of open) {
      try { out.push(await stepOne(pos)); }
      catch (error) {
        counters.deterministErrors++;
        log(`snipe shadow ${pos.mint}: tick failed — ${error.message}`);
      }
    }
    return Object.freeze(out);
  }

  async function stepOne(pos) {
    const mint = pos.mint;
    const now = clock();
    const read = await readAcrossEndpoints({ readers, addresses: adapter.accountsFor(mint), mint });
    let curve = null;
    if (read.verdict === "agree" || read.verdict === "single") {
      try { curve = adapter.curveFromAccount(read.accounts[0], { feeBps: venueFeeBps(), mint }) ?? null; }
      catch { curve = null; }
    }

    /* BLIND IS NOT A SELL SIGNAL AND IT IS NOT A PRICE. An unreadable mark reaches the
       determiner as null: `markX` is the absence of information, and the clock is what
       decides a position nobody can price. */
    let markX = null;
    if (curve) {
      try {
        markX = curveExitMarkX({
          curve, qtyRaw: pos.qtyRaw, entryInputLamports: pos.entryInputLamports, adapter,
        });
      } catch { markX = null; }
    }

    const step = determiner.step({
      position: pos, markX, nowMs: now, cfg: conf,
      creatorSold: false, rugFlag: read.verdict === "disagree",
      sample: { markX, nowMs: now, slot: read.slot, endpoint: read.chosen?.id ?? null },
    });

    counters.forwardSamples++;
    recorder.observe(mint, {
      atMs: now,
      slot: read.slot,
      slotDelta: Number.isFinite(pos.openedAtSlot) && Number.isFinite(read.slot) ? read.slot - pos.openedAtSlot : null,
      msAfterFill: now - Number(pos.openedAt),
      markX,
      realQuoteRaw: curve?.realQuoteRaw ?? null,
      complete: curve?.complete === true,
      endpointVerdict: read.verdict,
      action: step?.action ?? null,
      reason: step?.reason ?? null,
    });

    const aged = now - Number(pos.openedAt) >= Number(conf.holdMaxMs);
    const samples = Number(pos.samples ?? 0) + 1;
    const done = step?.action === "sell" || aged || samples >= Number(conf.forwardSamples);

    if (!done) {
      /* The determiner's own updated position is carried back into the book, which is what
         `updateSnipe` exists for: it re-runs the whole shape test and refuses anything that
         rewrites the fill. */
      updateSnipe(S, { ...pos, ...(isPlainObject(step?.position) ? step.position : {}), mint, samples });
      return Object.freeze({ mint, action: step?.action ?? "hold", markX, closed: false });
    }

    const reason = step?.action === "sell" ? step.reason
      : aged ? `clock: the forward window closed at ${conf.holdMaxMs}ms`
        : `the forward path is complete at ${samples} samples`;
    closeSnipe(S, mint, { reason, closedAt: now });
    recorder.close(mint, { action: step?.action === "sell" ? "would_have_exited" : "window_closed", reason, atMs: now, slot: read.slot });
    if (step?.action === "sell") counters.wouldHaveExited++;
    log(`snipe shadow ${mint}: would-have-exit (${step?.action ?? "window"}) — ${reason}`);
    return Object.freeze({ mint, action: step?.action ?? "window_closed", markX, closed: true });
  }

  /** Consume the feed until it closes. One notice at a time, deliberately: the gate stack
   *  is cheap and ordered, and a parallel consumer would interleave book writes. */
  async function consume() {
    for await (const record of feed.notices()) {
      if (stopping) break;
      try { await handleNotice(record); }
      catch (error) { log(`snipe lane: notice for ${record?.mint} failed — ${error.message}`); }
    }
  }

  return {
    laneVersion: SNIPE_LANE_VERSION,
    cfg: conf,
    mode: conf.lane,
    adapter,
    determiner: Object.freeze({ shape: determiner.shape, version: determiner.version }),
    shadow: recorder,
    state: S,

    /** Opens the feed's subscriptions and begins consuming. Nothing above this line has
     *  opened one, and nothing anywhere in this file signs. */
    async start() {
      if (started) throw new SnipeLaneError("already_started", "the snipe lane is already running");
      if (conf.lane !== "observe")
        throw new SnipeLaneError("mode_invalid",
          `SNIPE_LANE is "${conf.lane}" — gate 0 (lane_off) would refuse every notice; the lane is not armed`,
          { lane: conf.lane });
      if (!feed || typeof feed.notices !== "function" || typeof feed.start !== "function")
        throw new SnipeLaneError("feed_missing", "the lane needs a feed with start() and notices()");
      started = true;
      const floor = safeFloor();
      log(`snipe lane ${SNIPE_LANE_VERSION}: OBSERVE ONLY on ${adapter.id} over ${readers.length} endpoints `
        + `[${ids.join(", ")}]; ticket ${conf.maxSolPerTrade} SOL, derived stop ${floor.stopFrac.toFixed(4)} `
        + `(floorMarkX ${floor.floorMarkX.toFixed(4)}, minViable ${floor.minViableSol.toFixed(6)} SOL); `
        + `determiner ${determiner.shape}${determiner.version ? ` ${determiner.version}` : ""}; `
        + "no keypair is loaded, nothing is signed, nothing is sent");
      const summary = await feed.start();
      consumed = consume();
      return summary;
    },

    /** Stop consuming and close the feed. Awaits the consumer so a test can assert on a
     *  settled book rather than on a race. */
    async stop() {
      stopping = true;
      const stats = feed && typeof feed.stop === "function" ? await feed.stop() : null;
      if (consumed) { try { await consumed; } catch { /* the loop's own errors are logged */ } }
      started = false;
      return stats;
    },

    handleNotice,
    tick,
    report(opts) { return recorder.report(opts); },
    render(opts) { return recorder.render(opts); },
    rows() { return recorder.rows(); },
    openPositions() { return snipeList(S); },
    positionFor(mint) { return snipeFor(S, mint); },
    stats() {
      return Object.freeze({
        laneVersion: SNIPE_LANE_VERSION,
        mode: conf.lane,
        venue: adapter.id,
        endpoints: Object.freeze([...ids]),
        gates: SNIPE_GATES.length,
        hops: SHADOW_HOPS.length,
        chargeDailyCap: conf.chargeDailyCap === true,
        wouldHaveDeployedSol,
        ...counters,
        /* STAMPED AND ASSERTED. Not a claim in a comment — a field the test reads. */
        signed: 0,
        sent: 0,
        keypairsLoaded: 0,
      });
    },
  };
}
