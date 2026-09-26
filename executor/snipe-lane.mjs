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

import { snipeContract, planSnipeCeiling, SNIPE_GATES } from "./snipe-entry.mjs";
import { curveExitMarkX, frictionXFor, snipeCurveState, snipeFloor } from "./snipe-curve.mjs";
import { venueContract } from "./snipe-venue.mjs";
import { createSnipeShadow, latencyBudget, SHADOW_HOPS } from "./snipe-shadow.mjs";
import { closeSnipe, ensureSnipeBook, openSnipe, snipeFor, snipeList, updateSnipe } from "./snipe-book.mjs";
import * as snipePolicy from "./snipe-policy.mjs";
import { readSocials, SOCIAL_DEFAULTS } from "./snipe-socials.mjs";
import { createFlowTape } from "./snipe-volume.mjs";
import {
  MARKET_FLOOR_KEYS, MARKET_FLOOR_PRESET_VALUES, ageAloneRefuses, curveReachability, floorIsArmed, marketReadFor,
  resolveMarketFloor,
} from "./snipe-market.mjs";

export const SNIPE_LANE_VERSION = "snipe-lane-v1";

/** The market-floor presets SNIPE_MARKET_FLOOR admits. "bagwork" is the four thresholds
 *  bagworkagent.fun's own agents run, copied literally; "curve" is the two of those four a
 *  bonding curve can physically meet, and the one to run on this desk — bagwork's liquidity
 *  and market-cap bars sit above anything a curve holds (snipe-market.mjs, CURVE_FLOOR). */
export const MARKET_FLOOR_PRESETS = Object.freeze(Object.keys(MARKET_FLOOR_PRESET_VALUES));

/**
 * RISK MODES (owner, 2026-09-26: "make trading modes so it will help me choose the risks").
 *
 * One setting that picks a whole bundle of WHAT-TO-BUY filters, so choosing how much risk to take
 * is one decision instead of nine numbers. Every value in a mode is an entry filter from
 * LIVE_FILTER_ENV — a mode never touches trade size, the daily cap, the stop or the exits, which
 * stay on the Mac behind the typed sentence. Each mode carries a SUGGESTED size, shown to the
 * owner and never applied.
 *
 * A dial the owner sets explicitly (env file or page) always wins over the mode, the same rule a
 * floor preset follows: a mode fills in only what nobody typed.
 *
 * These are HYPOTHESES, not measurements. The only evidence behind them is that curve coins an hour
 * old with real volume exist (the `curve` preset) and that brand-new launches lost this desk money.
 * The scorecard is how a mode earns trust; until then they are three honest guesses at three levels
 * of pickiness.
 */
export const RISK_MODES = Object.freeze({
  veteran: Object.freeze({
    label: "Veteran — established coins only", risk: "lowest", suggestedSolPerTrade: 0.05,
    summary: "Coins at least 2 hours old with $75k+ of 24h volume, 300+ trades, no more than 60% sells, and a social link. Fewest trades.",
    filters: Object.freeze({ marketFloorPreset: "curve", minAgeHours: 2, minVolume24hUsd: 75_000, minTxns24h: 300,
      maxSellShare: 0.6, requireSocials: true }),
  }),
  proven: Object.freeze({
    label: "Proven mover — an hour of real demand", risk: "medium", suggestedSolPerTrade: 0.1,
    summary: "Coins at least 1 hour old with $50k+ of 24h volume, no more than 70% sells, and a social link.",
    filters: Object.freeze({ marketFloorPreset: "curve", maxSellShare: 0.7, requireSocials: true }),
  }),
  wave: Object.freeze({
    label: "Wave rider — buy when volume spikes", risk: "medium-high", suggestedSolPerTrade: 0.1,
    summary: "Coins at least 1 hour old with $25k+ of 24h volume and a social link, bought only while money is flowing in 3x faster than its last 5 minutes. Needs the gRPC feed.",
    filters: Object.freeze({ marketFloorPreset: "curve", minVolume24hUsd: 25_000, minVolumeSpike: 3, requireSocials: true }),
  }),
  early: Object.freeze({
    label: "Early riser — younger coins, more trades", risk: "highest", suggestedSolPerTrade: 0.2,
    summary: "Coins from 30 minutes old with $25k+ of 24h volume, social link not required. The most trades, on the least proven coins.",
    filters: Object.freeze({ marketFloorPreset: "curve", minAgeHours: 0.5, minVolume24hUsd: 25_000, requireSocials: false }),
  }),
});
export const RISK_MODE_NAMES = Object.freeze(["off", ...Object.keys(RISK_MODES)]);

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
  /* A market floor is configured and no reader was wired to honour it. Named here for the
     same reason cap_over_operator_max is: a refusal that ships without a clause reports
     under whatever code happened to be nearby. */
  "market_reader_missing",
  /* A spike threshold is configured and nothing feeds the tape it would be measured on. */
  "volume_tape_unfed",
  /* A money dial above the operator ceiling. Added 2026-09-11 with the ceiling itself —
     the clause list is frozen precisely so a new refusal cannot ship without being named,
     and this one refused correctly while reporting the wrong error until it was. */
  "cap_over_operator_max",
  /* Arming refused because a precondition in armabilityReport() is unmet. */
  "not_armable",
  "determiner_unbound",
  "feed_missing",
  "signing_refused",
  "already_started",
  /* Execute mode (2026-09-12). Named refusals for the three things arming can lack: the
     signing port, the owner's typed sentence, and — at run time — a buy or sell the port
     could not land. Frozen with the rest so none can ship unnamed. */
  "executor_missing",
  "arming_refused",
  "execution_failed",
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
  /* ONLY BUY A LAUNCH THAT NAMES A SOCIAL (owner, 2026-09-17). Default ON: it was asked
     for after four losing round trips in twenty minutes, and a deployer who attaches no
     twitter, telegram or website spent thirty seconds less on the coin than one who did.
     `SNIPE_REQUIRE_SOCIALS=0` turns it off. Costs one metadata request per launch, issued
     in parallel with the account read — see handleNotice — and it FAILS CLOSED, so a dead
     gateway stops entries rather than waving them through. */
  requireSocials: true,
  socialsTimeoutMs: SOCIAL_DEFAULTS.timeoutMs,
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
  /* THE OWNER'S VOLUME-SPIKE FLOOR (2026-09-26). Net inflow over the last 30s against the
     5 minutes before it, as a ratio. Undefined by default like the other two proxies: it
     is measured on every notice, recorded in the shadow book and scored by
     grade-entry-gates.mjs, and it kills nothing until the owner sets a number he has seen
     a scorecard for. Set SNIPE_MIN_VOLUME_SPIKE=2 to demand twice the baseline. */
  minVolumeSpike: undefined,
  /* THE MARKET FLOOR (2026-09-26) — bagworkagent.fun's floor, and the biggest change to what
     this bot buys. "off" by default, and that default is not timidity: the launch lane's
     entire population is minutes old, so an accidentally-armed floor would refuse every
     notice and look exactly like a broken feed. `SNIPE_MARKET_FLOOR=bagwork` loads their four
     measured numbers wholesale; the nine dials below override individual thresholds, and any
     dial set on its own arms a floor of EXACTLY what was asked for and nothing else. See
     snipe-market.mjs for where each fact comes from and why this desk adds five more. */
  marketFloorPreset: "off",
  /* WHETHER THE DESK MAY CHANGE THE ENTRY FILTERS OF A RUNNING LANE (owner, 2026-09-26: "can I
     change the filters on the spot, like the BAGWORK agents can"). Off unless the owner opts in
     on this machine, because the desk is a server this machine does not control — see
     LIVE_FILTER_ENV for exactly what it may and may not touch. */
  remoteFilters: false,
  /* The risk mode, or "off" for none. See RISK_MODES. */
  riskMode: "off",
  /* ROOM FOR THE PRICE TO MOVE BETWEEN THE READ AND THE BUY, taken out of the quantity and
     never added to the spend — see snipe-entry.mjs quoteOneRung. 3%: enough for one or two
     trades landing in between on an active coin, and the ticket stays the hard cap either way.
     Mac-only (not in LIVE_FILTER_ENV): it is how a fill is priced, not what is bought. */
  entrySlippageBps: 300,
  minAgeHours: undefined,
  minLiquidityUsd: undefined,
  minVolume24hUsd: undefined,
  minMcapUsd: undefined,
  maxVolumeToLiquidity: undefined,
  minTxns24h: undefined,
  maxSellShare: undefined,
  maxPriceChange24hPct: undefined,
  minTopPoolLiquidityUsd: undefined,
  /* The resolved floor the gate actually reads, assembled by snipeLaneConfig from the preset
     and the dials. Null means no floor, and `market_floor` then passes without looking. */
  marketFloor: null,
  /* Consecutive two-endpoint disagreements before blindness is treated as hostility and
     the position leaves. THREE, matching snipe-policy's confirmWindow, and for the same
     reason: it is the smallest run in which a single outlier cannot be the whole story.
     At the default 1s tick that is three seconds of being unable to price a position. */
  disagreeStreakMax: 3,
  /* How far the deployer's balance must fall before it counts as them getting out. Not
     zero: a token account can move by dust for reasons that are not a decision, and this
     signal sells the entire position. Ten percent is a deliberate disposal and not an
     accident. */
  creatorExitFrac: 0.10,
  /* THE OWNER'S TAKE DIAL, as the policy reads it: the whole position leaves at N x entry.
     Null means snipe-policy's own default (2x). Named takeAtEntryX and never takeProfitX,
     because strategy.mjs owns that key and separation clause 6 pins that the two config
     namespaces share no name. */
  takeAtEntryX: null,
  /* THE STALL EXIT'S DIALS. Null means snipe-policy's own defaults (90s at 1.0x entry,
     and a 3-minute backstop) — see SNIPE_POLICY_DEFAULTS.stallMs for the 58-trade record
     that set them. SNIPE_STALL_MS=0 turns the stall off and leaves only the time stop. */
  stallMs: null,
  stallAtX: null,
  timeStopMs: null,
  /* THE OWNER'S STOP DIAL, as the policy reads it: the whole position leaves when the mark
     falls to this fraction of entry. Null means snipe-policy's own 0.20, which was derived
     for the 0.005 SOL canary and which the arming checklist refuses to carry, unexamined,
     onto a larger ticket — so an executing lane above the canary size cannot construct
     until this is typed. The checklist also refuses a level the fee rail cannot fund. */
  stopFrac: null,
  /* THE ARMING SENTENCE. Null on every lane that observes. An executing lane refuses to
     construct unless this equals snipeArmSentence(wallet, maxSolPerTrade, dailySolCap)
     for the wallet that will sign, so the numbers were typed by a person beside the key
     they bind. It is a string the lane compares and never otherwise reads. */
  liveAck: null,
});

/**
 * THE ENVIRONMENT NAMES, and nothing outside this table is read.
 *
 * Exported so `test-snipe-separation.mjs` can assert that none of them appears in the
 * desk's CFG builder, and so this file's own test can assert that every name starts with
 * `SNIPE_`.
 */
/**
 * THE SNIPER'S MONEY CEILING, AND IT IS THE DESK'S CEILING.
 *
 * Until 2026-09-11 SNIPE_MAX_SOL_PER_TRADE was a bare finite number with no bound of any
 * kind: SNIPE_MAX_SOL_PER_TRADE=50 parsed, froze into the config, and would have been
 * spent verbatim as one position the instant a signing path existed. That was harmless
 * only because nothing signed. It is the single most dangerous line in the file once
 * something does, so the bound lands with the dial rather than after it.
 *
 * The numbers are deliberately the SAME numbers as poller.mjs OPERATOR_MAX. A sniper that
 * could take a larger position than the desk would make the desk's frozen ceiling
 * decorative — the wallet is one wallet. There is no import, because poller.mjs is the
 * application and this is a library it loads; instead this is the FIFTH copy, and
 * test-operator-max-parity.mjs holds all five equal by reading the source. That test
 * exists because four copies already drifted once and made a raise unarmable.
 *
 * Raising these is a code change, reviewed, exactly as it is on the desk side.
 */
export const SNIPE_OPERATOR_MAX = Object.freeze({ maxSolPerTrade: 1, dailySolCap: 1000 });

/**
 * WHICH EXIT SIGNALS ARE ACTUALLY CONNECTED, AS A FACT RATHER THAN AN IMPRESSION.
 *
 * snipe-policy.mjs carries a branch that sells the whole position when the creator sells,
 * and calls it "the one signal a launch has that no later market does". stepOne passes
 * `creatorSold: false` — a literal. The branch cannot fire. Nothing is wrong with the
 * policy; the fact simply never arrives, which is the same shape of defect as the hard
 * stop that was read at entry and never on the management path.
 *
 * A dead branch that reads like a protection is worse than an absent one, because it is
 * counted as covered by whoever reviews the exits. So the gap is declared here, the
 * armability checklist blocks on it, and wiring it means changing this constant — not
 * remembering that a comment somewhere said it was pending.
 */
export const LANE_SIGNALS = Object.freeze({
  hardStop: "wired",        // control() is read on the management path, not only at entry
  rugFlag: "wired",         // a RUN of two-endpoint disagreements; see stepOne
  liquidityFloor: "wired",  // from the curve's own reserves
  stop: "wired",
  trail: "wired",
  take: "wired",
  timeStop: "wired",
  /* WIRED 2026-09-11. stepOne reads the deployer's token accounts alongside the curve and
     watches the balance against a baseline taken at the first readable tick. Witnessed
     across every endpoint unanimously, because a fall here sells the whole position. */
  creatorSold: "wired",
});

export const SNIPE_ENV = Object.freeze({
  SNIPE_LANE: Object.freeze({ key: "lane", parse: "mode" }),
  SNIPE_MAX_SOL_PER_TRADE: Object.freeze({ key: "maxSolPerTrade", parse: "number", max: SNIPE_OPERATOR_MAX.maxSolPerTrade }),
  SNIPE_DAILY_SOL_CAP: Object.freeze({ key: "dailySolCap", parse: "number", max: SNIPE_OPERATOR_MAX.dailySolCap }),
  SNIPE_MAX_PRICE_IMPACT_PCT: Object.freeze({ key: "maxPriceImpactPct", parse: "number" }),
  SNIPE_MAX_ROUND_TRIP_LOSS_PCT: Object.freeze({ key: "maxEntryRoundTripLossPct", parse: "number" }),
  SNIPE_MAX_NETWORK_FEE_LAMPORTS: Object.freeze({ key: "maxNetworkFeeLamports", parse: "number" }),
  SNIPE_MAX_NETWORK_FEE_PCT: Object.freeze({ key: "maxNetworkFeePct", parse: "number" }),
  SNIPE_MAX_RENT_LAMPORTS: Object.freeze({ key: "maxRentLamports", parse: "number" }),
  SNIPE_NETWORK_FEE_RESERVE_SOL: Object.freeze({ key: "networkFeeReserveSol", parse: "number" }),
  SNIPE_MAX_FEE_SHARE_OF_STOP: Object.freeze({ key: "maxFeeShareOfStop", parse: "number" }),
  SNIPE_MIN_SOL_PER_TRADE: Object.freeze({ key: "minSolPerTrade", parse: "number", max: SNIPE_OPERATOR_MAX.maxSolPerTrade }),
  SNIPE_SIGNATURE_FEE_LAMPORTS: Object.freeze({ key: "signatureFeeLamports", parse: "number" }),
  SNIPE_PRIORITY_FEE_LAMPORTS: Object.freeze({ key: "priorityFeeLamports", parse: "number" }),
  SNIPE_RENT_FEE_LAMPORTS: Object.freeze({ key: "rentFeeLamports", parse: "number" }),
  SNIPE_NOTICE_MAX_MS: Object.freeze({ key: "noticeMaxMs", parse: "number" }),
  SNIPE_VENUE_FEE_BPS: Object.freeze({ key: "venueFeeBps", parse: "number" }),
  SNIPE_REQUIRE_SOCIALS: Object.freeze({ key: "requireSocials", parse: "flag" }),
  SNIPE_SOCIALS_TIMEOUT_MS: Object.freeze({ key: "socialsTimeoutMs", parse: "number" }),
  SNIPE_FORWARD_SAMPLES: Object.freeze({ key: "forwardSamples", parse: "number" }),
  SNIPE_FORWARD_INTERVAL_MS: Object.freeze({ key: "forwardIntervalMs", parse: "number" }),
  SNIPE_HOLD_MAX_MS: Object.freeze({ key: "holdMaxMs", parse: "number" }),
  SNIPE_SHADOW_CAPACITY: Object.freeze({ key: "shadowCapacity", parse: "number" }),
  SNIPE_CHARGE_DAILY_CAP: Object.freeze({ key: "chargeDailyCap", parse: "flag" }),
  SNIPE_MAX_CREATOR_SHARE_PCT: Object.freeze({ key: "maxCreatorSharePct", parse: "number" }),
  SNIPE_MAX_LAUNCH_SHARE_PCT: Object.freeze({ key: "maxLaunchSharePct", parse: "number" }),
  SNIPE_MIN_VOLUME_SPIKE: Object.freeze({ key: "minVolumeSpike", parse: "number" }),
  SNIPE_MARKET_FLOOR: Object.freeze({ key: "marketFloorPreset", parse: "preset" }),
  SNIPE_REMOTE_FILTERS: Object.freeze({ key: "remoteFilters", parse: "flag" }),
  SNIPE_RISK_MODE: Object.freeze({ key: "riskMode", parse: "risk" }),
  SNIPE_ENTRY_SLIPPAGE_BPS: Object.freeze({ key: "entrySlippageBps", parse: "number" }),
  SNIPE_MIN_AGE_HOURS: Object.freeze({ key: "minAgeHours", parse: "number" }),
  SNIPE_MIN_LIQUIDITY_USD: Object.freeze({ key: "minLiquidityUsd", parse: "number" }),
  SNIPE_MIN_VOLUME_24H_USD: Object.freeze({ key: "minVolume24hUsd", parse: "number" }),
  SNIPE_MIN_MCAP_USD: Object.freeze({ key: "minMcapUsd", parse: "number" }),
  SNIPE_MAX_VOLUME_TO_LIQUIDITY: Object.freeze({ key: "maxVolumeToLiquidity", parse: "number" }),
  SNIPE_MIN_TXNS_24H: Object.freeze({ key: "minTxns24h", parse: "number" }),
  SNIPE_MAX_SELL_SHARE: Object.freeze({ key: "maxSellShare", parse: "number" }),
  SNIPE_MAX_PRICE_CHANGE_24H_PCT: Object.freeze({ key: "maxPriceChange24hPct", parse: "number" }),
  SNIPE_MIN_TOP_POOL_LIQUIDITY_USD: Object.freeze({ key: "minTopPoolLiquidityUsd", parse: "number" }),
  SNIPE_DISAGREE_STREAK_MAX: Object.freeze({ key: "disagreeStreakMax", parse: "number" }),
  SNIPE_CREATOR_EXIT_FRAC: Object.freeze({ key: "creatorExitFrac", parse: "number" }),
  SNIPE_TAKE_AT_ENTRY_X: Object.freeze({ key: "takeAtEntryX", parse: "number" }),
  SNIPE_STALL_MS: Object.freeze({ key: "stallMs", parse: "number" }),
  SNIPE_STALL_AT_X: Object.freeze({ key: "stallAtX", parse: "number" }),
  SNIPE_TIME_STOP_MS: Object.freeze({ key: "timeStopMs", parse: "number" }),
  SNIPE_STOP_FRAC: Object.freeze({ key: "stopFrac", parse: "number" }),
  SNIPE_LIVE_ACK: Object.freeze({ key: "liveAck", parse: "string" }),
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
  const typed = new Set();          // keys the operator set explicitly, which a risk mode never overrides
  for (const [name, spec] of Object.entries(SNIPE_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const text = String(raw).trim();
    typed.add(spec.key);
    if (spec.parse === "risk") {
      if (!RISK_MODE_NAMES.includes(text.toLowerCase()))
        throw new SnipeLaneError("mode_invalid",
          `${name}=${JSON.stringify(text)} is not one of ${RISK_MODE_NAMES.join(", ")}`, { name, value: text });
      out[spec.key] = text.toLowerCase();
    } else if (spec.parse === "mode") {
      if (!SNIPE_LANE_MODES.includes(text))
        throw new SnipeLaneError("mode_invalid",
          `${name}=${JSON.stringify(text)} is not one of ${SNIPE_LANE_MODES.join(", ")}`, { name, value: text });
      out[spec.key] = text;
    } else if (spec.parse === "number") {
      const n = Number(text);
      if (!Number.isFinite(n))
        throw new SnipeLaneError("mode_invalid", `${name}=${JSON.stringify(text)} is not a number`, { name, value: text });
      /* NEGATIVE IS NEVER MEANINGFUL HERE. Every number in this table is a size, a cap, a
         fee, a percentage or a duration, and no default is negative. A negative size is
         not a small position; it is a sign error that would reach the sizing arithmetic
         and produce a number no gate downstream is shaped to refuse. */
      if (n < 0)
        throw new SnipeLaneError("mode_invalid",
          `${name}=${JSON.stringify(text)} is negative; every value in this table is a size, cap, fee or duration`,
          { name, value: text });
      /* AND THE MONEY KEYS CARRY THE OPERATOR CEILING. Refused, never clamped: silently
         lowering an operator's stated size to a different one is how a bot ends up
         trading a number nobody chose. */
      if (spec.max !== undefined && n > spec.max)
        throw new SnipeLaneError("cap_over_operator_max",
          `${name}=${text} exceeds the operator maximum of ${spec.max} SOL. That ceiling is the ` +
          "desk's own (poller.mjs OPERATOR_MAX) and the wallet is one wallet; raising it is a " +
          "reviewed code change in all five copies, not an environment setting.",
          { name, value: n, max: spec.max });
      out[spec.key] = n;
    } else if (spec.parse === "preset") {
      /* Named presets only. A misspelled preset is refused rather than silently becoming
         "off", because a floor that is not there is indistinguishable from a floor that
         passed everything — and this is the switch that decides what the bot buys. */
      if (!MARKET_FLOOR_PRESETS.includes(text.toLowerCase()))
        throw new SnipeLaneError("mode_invalid",
          `${name}=${JSON.stringify(text)} is not one of ${MARKET_FLOOR_PRESETS.join(", ")}`, { name, value: text });
      out[spec.key] = text.toLowerCase();
    } else if (spec.parse === "string") {
      /* Compared, never interpreted: the arming sentence is matched byte for byte against
         the one the lane composes for the signing wallet, so it is kept exactly as typed. */
      out[spec.key] = text;
    } else {
      /* Strictly: 1/true/yes is on, 0/false/no/absent is off, anything else is a refusal
         rather than a guess about what the operator meant. */
      if (["1", "true", "yes", "on"].includes(text.toLowerCase())) out[spec.key] = true;
      else if (["0", "false", "no", "off"].includes(text.toLowerCase())) out[spec.key] = false;
      else throw new SnipeLaneError("mode_invalid", `${name}=${JSON.stringify(text)} is not a boolean flag`, { name, value: text });
    }
  }
  /* SNIPE_EXECUTE exists only to be refused. The flag predates the signing path and named
     the wrong thing: execution is a MODE (SNIPE_LANE=execute) that createSnipeLane admits
     only with a signing port, a clear arming checklist and the owner's typed sentence, and
     a bare boolean that skipped all three would be a flag that arms. */
  if (["1", "true", "yes", "on"].includes(String(env.SNIPE_EXECUTE ?? "").trim().toLowerCase()))
    throw new SnipeLaneError("execute_not_implemented",
      "SNIPE_EXECUTE is not a switch this lane honours. Arming is SNIPE_LANE=execute together with "
      + "SNIPE_LIVE_ACK, the sentence the lane prints for your wallet and caps, on a live (EXECUTE=1) "
      + "install; a boolean cannot carry the numbers the acknowledgement exists to make you type.",
      { lane: out.lane, snipeExecute: env.SNIPE_EXECUTE ?? null });

  /* THE FLOOR, ASSEMBLED ONCE. The preset supplies a whole set of measured numbers; a dial
     overrides one of them. A dial set with no preset arms a floor of exactly that dial —
     surprising the other way round would be worse, since inheriting three thresholds the
     operator never typed is how a bot ends up refusing on a number nobody chose. */
  /* Whole basis points, at most 20%: past that it is not room for a trade landing in between,
     it is buying whatever the price has become. */
  if (!Number.isInteger(out.entrySlippageBps) || out.entrySlippageBps < 0 || out.entrySlippageBps > 2_000)
    throw new SnipeLaneError("mode_invalid",
      `SNIPE_ENTRY_SLIPPAGE_BPS=${out.entrySlippageBps} must be a whole number of basis points from 0 to 2000`,
      { name: "SNIPE_ENTRY_SLIPPAGE_BPS", value: out.entrySlippageBps });

  /* THE RISK MODE FILLS IN WHAT NOBODY TYPED. Applied before the floor is assembled, so its
     floor preset and thresholds take part exactly as if they had been set by hand — and any
     dial the operator did set keeps its value. */
  const mode = RISK_MODES[out.riskMode];
  if (mode) for (const [key, value] of Object.entries(mode.filters)) if (!typed.has(key)) out[key] = value;

  const dialed = {};
  for (const key of MARKET_FLOOR_KEYS) if (out[key] !== undefined) dialed[key] = out[key];
  const preset = MARKET_FLOOR_PRESET_VALUES[out.marketFloorPreset] ?? {};
  const asked = { ...preset, ...dialed };
  if (Object.keys(asked).length) {
    const floor = {};
    for (const key of MARKET_FLOOR_KEYS) floor[key] = asked[key] === undefined ? null : asked[key];
    out.marketFloor = resolveMarketFloor(floor);
  } else out.marketFloor = null;

  return Object.freeze(out);
}

/**
 * THE FILTERS THE DESK MAY CHANGE ON A RUNNING LANE — and, by omission, everything it may not.
 *
 * bagworkagent.fun lets an owner retune an agent from its page and the agent picks it up. This
 * desk can do the same for one class of setting only: WHAT TO BUY. Every entry here can only
 * make the lane more or less selective about which coin it enters; none of them changes how
 * much it spends, how much it may lose, how it exits, or whether it signs at all.
 *
 * NOT here, deliberately, and they stay env-only behind the owner's typed sentence:
 *   SNIPE_MAX_SOL_PER_TRADE, SNIPE_DAILY_SOL_CAP  — money, bound into SNIPE_LIVE_ACK
 *   SNIPE_STOP_FRAC, SNIPE_TAKE_AT_ENTRY_X, SNIPE_HOLD_MAX_MS, ...  — exits, checked by the
 *     arming checklist at construction; a stop the desk could move is a stop a stolen session
 *     could move
 *   SNIPE_MAX_PRICE_IMPACT_PCT and the fee dials — how a fill is priced, not what is bought
 *   SNIPE_LANE, SNIPE_REMOTE_FILTERS itself — a server cannot arm the lane or grant itself this
 *
 * So the worst a stolen desk session can do is make the bot pickier, or less picky, within the
 * money caps the owner typed on this machine.
 */
export const LIVE_FILTER_ENV = Object.freeze([
  "SNIPE_RISK_MODE", "SNIPE_MARKET_FLOOR", "SNIPE_MIN_AGE_HOURS", "SNIPE_MIN_LIQUIDITY_USD", "SNIPE_MIN_VOLUME_24H_USD",
  "SNIPE_MIN_MCAP_USD", "SNIPE_MAX_VOLUME_TO_LIQUIDITY", "SNIPE_MIN_TXNS_24H", "SNIPE_MAX_SELL_SHARE",
  "SNIPE_MAX_PRICE_CHANGE_24H_PCT", "SNIPE_MIN_TOP_POOL_LIQUIDITY_USD",
  "SNIPE_MIN_VOLUME_SPIKE", "SNIPE_REQUIRE_SOCIALS",
  "SNIPE_MAX_CREATOR_SHARE_PCT", "SNIPE_MAX_LAUNCH_SHARE_PCT",
]);
/** The config keys those names resolve to, plus the floor object they assemble into. */
export const LIVE_FILTER_KEYS = Object.freeze([
  ...LIVE_FILTER_ENV.map((name) => SNIPE_ENV[name].key), "marketFloor",
]);

/**
 * The lane configuration a desk-sent filter set asks for, validated exactly as the env file is.
 *
 * `baseEnv` is what the owner put on this machine; `remote` is `{ SNIPE_NAME: value }` from the
 * desk. A remote value OVERRIDES the base for that name; a name the desk leaves out, or sends as
 * null, falls back to the base — so clearing a filter on the page reverts to the env file, never
 * to "no filter at all" behind the owner's back.
 *
 * Every remote entry is judged ON ITS OWN first, so one bad value is named and refused while the
 * rest still apply — a whole panel refused over one typo would read on the page as "the bot
 * ignored me". A name outside LIVE_FILTER_ENV is refused by name, whatever it is.
 */
export function remoteFilterConfig({ baseEnv = {}, remote = {} } = {}) {
  const rejected = [];
  const accepted = {};
  const entries = remote && typeof remote === "object" && !Array.isArray(remote) ? Object.entries(remote) : [];
  for (const [name, value] of entries) {
    if (!LIVE_FILTER_ENV.includes(name)) {
      rejected.push(Object.freeze({ name, reason: "not a filter the desk may change — set it in the env file on the Mac" }));
      continue;
    }
    if (value === null || value === undefined || String(value).trim() === "") continue;   // revert to base
    const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value).trim();
    try { snipeLaneConfig({ [name]: text }); accepted[name] = text; }
    catch (error) { rejected.push(Object.freeze({ name, reason: String(error?.message ?? error).slice(0, 200) })); }
  }
  const merged = { ...baseEnv };
  for (const name of LIVE_FILTER_ENV) delete merged[name];
  for (const name of LIVE_FILTER_ENV) {
    if (accepted[name] !== undefined) merged[name] = accepted[name];
    else if (baseEnv[name] !== undefined) merged[name] = baseEnv[name];
  }
  let cfg = null;
  try { cfg = snipeLaneConfig(merged); }
  catch (error) {
    return Object.freeze({ ok: false, cfg: null, accepted: Object.freeze({}), rejected: Object.freeze([...rejected,
      Object.freeze({ name: "(combined)", reason: String(error?.message ?? error).slice(0, 200) })]) });
  }
  return Object.freeze({ ok: true, cfg, accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
}

/**
 * THE SENTENCE THAT ARMS THE SNIPER, bound to the wallet that signs and the two money dials.
 * Same shape and same reason as the desk's caps sentence (poller.mjs capsAckSentence): a
 * number typed beside the key it binds is a number somebody looked at. The lane compares
 * the operator's SNIPE_LIVE_ACK against this byte for byte and refuses to construct on any
 * difference, so the dials cannot be moved without retyping it.
 */
export function snipeArmSentence(wallet, maxSolPerTrade, dailySolCap) {
  return `I arm HAWK-AI v1 for ${wallet}: ${maxSolPerTrade} SOL per launch, ${dailySolCap} SOL per day, ` +
    "sold in full at the take, the stop, the creator's exit or the clock";
}

/**
 * THE OVERRIDES THE MODE DECIDES, NOT THE OPERATOR.
 *
 * chargeDailyCap defaults false, and that default is correct: a shadow book that silenced
 * itself after two notices would measure nothing, which is the whole point of section 6 in
 * test-snipe-lane.mjs. It is also catastrophic the moment the lane has a wallet —
 * deployedTodaySol stays 0 for ever and dailySolCap never binds, whatever it is set to.
 *
 * The fix is not an item on a pre-flight list for a person to remember. A lane that spends
 * money MUST charge its daily cap, so the mode decides it and the operator cannot set it
 * wrong. The one flag whose misconfiguration removes a money cap entirely is exactly the
 * flag that should not be a flag.
 */
export function effectiveLaneConfig(cfg = {}) {
  const executing = cfg.lane === "execute";
  /* THE TAKE DIAL REACHES THE POLICY HERE. bindDeterminer hands snipe-policy `cfg.policy`
     and nothing else, so a dial parked at the top level of the config would be a dial the
     determiner never reads — set, printed, and inert. Folded in once, where the mode's own
     overrides already live, so every consumer of the effective config sees the same take. */
  const take = Number(cfg.takeAtEntryX);
  const stop = Number(cfg.stopFrac);
  /* The stall dials fold in the same way and for the same reason — parked at the top
     level they would be read by nobody. `stallMs` accepts 0, which is how an operator
     turns the stall exit off, so it is bounded at >= 0 rather than > 0. */
  const stall = Number(cfg.stallMs);
  const stallAt = Number(cfg.stallAtX);
  const timeStop = Number(cfg.timeStopMs);
  const folded = {
    ...(Number.isFinite(take) && take > 0 ? { takeAtEntryX: take } : {}),
    ...(Number.isFinite(stop) && stop > 0 ? { stopFrac: stop } : {}),
    ...(Number.isFinite(stall) && stall >= 0 ? { stallMs: stall } : {}),
    ...(Number.isFinite(stallAt) && stallAt > 0 ? { stallAtX: stallAt } : {}),
    ...(Number.isFinite(timeStop) && timeStop > 0 ? { timeStopMs: timeStop } : {}),
  };
  const policy = Object.keys(folded).length
    ? Object.freeze({ ...(cfg.policy ?? {}), ...folded })
    : cfg.policy;
  return Object.freeze({
    ...cfg,
    ...(policy !== undefined ? { policy } : {}),
    /* Forced ON for an executing lane; the operator's value stands everywhere else. */
    chargeDailyCap: executing ? true : cfg.chargeDailyCap === true,
  });
}

/**
 * EVERYTHING THAT MUST BE TRUE BEFORE THIS LANE MAY SPEND MONEY, IN ONE FUNCTION.
 *
 * Arming is not a flag, and it should not be a judgement call made by whoever is awake.
 * The lane is still refused execute at config parse and again at construction; what this
 * adds is the CHECKLIST those refusals are hiding, written down and executable now rather
 * than discovered one clause at a time on the day someone unlocks it.
 *
 * Every item here is a defect found by auditing the lane against the question "what breaks
 * the first time this holds a real bag?" — and every one of them costs nothing today:
 *
 *   · A DAILY CAP THAT CANNOT SEE THE SPEND. chargeDailyCap defaults false, which is right
 *     for a shadow book (a book that silenced itself after two notices would measure
 *     nothing) and catastrophic for a lane with a wallet: deployedTodaySol stays 0 for
 *     ever and dailySolCap never binds, whatever it is set to.
 *   · A TAKE INSIDE FRICTION, which is an instruction to sell at a loss on the way up.
 *   · A STOP THE FILL CANNOT FUND, or the frozen 0.20 canary stop carried unexamined onto
 *     a position eighty times larger, where it is an 80% drawdown.
 *   · AN UNPROVED INSTRUCTION LAYOUT. A transposed account in a hand-built buy does not
 *     refuse: it signs, it lands, and the money goes somewhere nobody planned.
 *
 * Returns the checklist with every item's verdict, so a caller can PRINT it. Throws only
 * when asked to assert. Refusals are never clamps: a dial quietly moved to a safe value is
 * a bot trading a number its owner never chose.
 */
export function armabilityReport({ cfg = {}, venue = null, stopExplicit = false,
  signals = LANE_SIGNALS } = {}) {
  const items = [];
  const add = (name, okFlag, detail) => items.push({ name, ok: okFlag === true, detail });

  const size = Number(cfg.maxSolPerTrade);
  const fee = Number(cfg.networkFeeReserveSol ?? SNIPE_LANE_DEFAULTS.networkFeeReserveSol);

  add("size_within_operator_max",
    Number.isFinite(size) && size > 0 && size <= SNIPE_OPERATOR_MAX.maxSolPerTrade,
    `maxSolPerTrade ${size} against an operator maximum of ${SNIPE_OPERATOR_MAX.maxSolPerTrade} SOL`);

  /* Asked of the config this lane WOULD run under if armed, not of the observe config in
     hand: the question is whether the daily cap binds when money moves. effectiveLaneConfig
     forces it on for execute, so this is a check of the mechanism rather than of whether
     someone remembered a flag — and it fails loudly if that forcing is ever removed. */
  const armedCfg = effectiveLaneConfig({ ...cfg, lane: "execute" });
  add("daily_cap_is_charged", armedCfg.chargeDailyCap === true,
    armedCfg.chargeDailyCap === true
      ? `dailySolCap ${cfg.dailySolCap} SOL accumulates once armed — the mode forces the charge on, `
        + "so it cannot be configured off on a lane that spends"
      : "an executing lane would NOT charge its daily cap: deployedTodaySol stays 0 and "
        + "dailySolCap never binds, whatever it is set to");

  /* The take the determiner will actually run under: armedCfg has the owner's dial folded
     into policy, so a take typed as SNIPE_TAKE_AT_ENTRY_X is the take this item judges. */
  const policyCfg = { ...snipePolicy.SNIPE_DEFAULTS, ...(armedCfg.policy ?? {}) };
  try {
    const e = snipePolicy.assertTakeFundable({ takeAtEntryX: policyCfg.takeAtEntryX, sizeSol: size, feeSolPerLeg: fee });
    add("take_is_fundable", true,
      `a ${policyCfg.takeAtEntryX}x take realizes ${(e.realizedFrac * 100).toFixed(2)}% at a ${e.frictionX.toFixed(4)}x round trip`);
  } catch (err) { add("take_is_fundable", false, err.message); }

  try {
    const e = snipePolicy.assertStopFundable({ stopFrac: policyCfg.stopFrac, sizeSol: size, explicit: stopExplicit });
    add("stop_is_fundable", true,
      `stop ${e.stopFrac}x entry, tightest fundable at this size ${e.tightestFundableStopFrac.toFixed(4)}x`);
  } catch (err) { add("stop_is_fundable", false, err.message); }

  /* `signals` is injectable ONLY so a test can knock one out and prove this item can still
     go red. Nothing in the application passes it; the default is the real table. */
  const unwired = Object.entries(signals).filter(([, v]) => v !== "wired").map(([k]) => k);
  add("exit_signals_are_wired", unwired.length === 0,
    unwired.length === 0
      ? `all ${Object.keys(signals).length} exit signals reach the determiner`
      : `${unwired.join(", ")} ${unwired.length === 1 ? "is a branch that" : "are branches that"} cannot fire — `
        + "the policy has the rule, the fact never arrives, and a dead branch reads as a protection to "
        + "whoever reviews the exits");

  const proved = venue?.layoutVerified === true && venue?.layoutProof != null;
  add("venue_layout_is_proved", proved,
    proved ? `${venue.id} layout proved by ${venue.layoutProof?.provedBy ?? "an unnamed source"}`
      : `${venue?.id ?? "the venue"} has no proved instruction layout — a transposed account in a ` +
        "hand-built buy does not refuse, it signs and lands");

  const blocking = items.filter((i) => !i.ok);
  return Object.freeze({
    armable: blocking.length === 0,
    items: Object.freeze(items.map(Object.freeze)),
    blocking: Object.freeze(blocking.map((i) => i.name)),
  });
}

/** armabilityReport(), as a refusal. Throws naming every unmet item, not just the first. */
export function assertArmable(args) {
  const report = armabilityReport(args);
  if (!report.armable)
    throw new SnipeLaneError("not_armable",
      "this lane may not spend money yet:\n" +
      report.items.filter((i) => !i.ok).map((i) => `  · ${i.name}: ${i.detail}`).join("\n"),
      { blocking: report.blocking });
  return report;
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

/**
 * The adapter as an ARMED lane sees it: encoders reachable, and the venue contract run in
 * execute mode, which is the mode that demands a proved layout. Nothing is wrapped and
 * nothing is invented — the object is the venue's own, frozen, with observeOnly stated
 * false so a reader of the lane's state can tell the two postures apart in one field.
 */
export function armedVenue(adapter) {
  if (adapter === null || typeof adapter !== "object")
    throw new SnipeLaneError("venue_missing", `a venue adapter is required; received ${adapter === null ? "null" : typeof adapter}`);
  const verdict = venueContract(adapter, { execute: true });
  if (!verdict.ok)
    throw new SnipeLaneError("venue_refused",
      `the venue may not be armed: ${verdict.detail.message}`,
      { clause: verdict.clause, venueId: adapter.id ?? null });
  return Object.freeze({ ...adapter, observeOnly: false });
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
    /* EVERY FACT THE CALLER PASSES MUST BE NAMED HERE OR IT IS SILENTLY DROPPED. This
       signature destructures, so an argument the binding does not list simply vanishes
       between the lane and the policy with no error anywhere — which is exactly what
       happened to `hardStop` on its first wiring: stepOne passed it, this forwarded
       nothing, and the kill switch looked connected while reaching nothing. */
    step({ position, markX, nowMs, cfg, creatorSold = false, rugFlag = false,
      hardStop = false, creatorSoldDetail = null, sample = null }) {
      if (hasNew)
        return policy.snipeStep({ pos: position, sample: sample ?? { markX, nowMs }, cfg, nowMs,
          hardStop, creatorSold, creatorSoldDetail });
      return policy.snipePolicy({
        position, mark: markX, nowMs, config: cfg?.policy ?? {}, creatorSold, rugFlag, hardStop,
        creatorSoldDetail,
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
  /* BOTH ENDPOINTS AT ONCE. This awaited each reader in turn, so the witness read cost
     the SUM of two round trips at the exact moment a launch is measured in slots. The
     verdict below compares reads BY SLOT and does not care which answered first, and each
     reader keeps its own try/catch, so an endpoint that throws still lands in the table as
     its own error rather than taking the other's answer down with it. */
  const results = await Promise.all(readers.map(async (reader) => {
    try {
      const answer = await reader.read(mint, addresses);
      return {
        id: reader.id,
        slot: Number.isFinite(Number(answer?.slot)) ? Number(answer.slot) : null,
        accounts: Array.isArray(answer?.accounts) ? answer.accounts : [],
        error: null,
      };
    } catch (error) {
      return { id: reader.id, slot: null, accounts: [], error: String(error?.message ?? error) };
    }
  }));

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
    /* EVERY ENDPOINT'S FULL ANSWER, so a caller can witness an account this function does
       not itself judge. `present`, `digest` and the verdict above are computed from
       accounts[0] — the bonding curve — and nothing else, so an address added to the read
       list rides along unwitnessed. That is harmless for a read nobody acts on and not
       harmless for the creator's balance, where a single lying node would otherwise be
       able to trigger a full market sell. stepOne cross-checks it across this. */
    all: Object.freeze(view.map((v) => Object.freeze({ id: v.id, slot: v.slot, accounts: v.accounts }))),
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
  executor = null,
  /* THE METADATA READ, AS A PORT. Injected for the same reason the readers are: this is
     the one call the lane makes to a host the COIN'S DEPLOYER chose, and a test must be
     able to drive every answer — an empty document, a hang, a hostile body — without a
     network and without a real stranger's server on the other end. */
  socialsReader = readSocials,
  /* WHAT THE WALLET ACTUALLY HOLDS, AS A PORT — and it exists because of one position.
     2026-09-17: the owner's lane kept a row for 5xXJ1Aqjw…pump for eight hours, failing
     its exit once per tick, sixty times and counting. The coin had been SOLD at 12:17:42Z
     — 0.193313 SOL back against 0.201920 spent, confirmed on chain — and the wallet's
     balance of that mint was zero the entire time the lane was trying to sell it. Nothing
     was stuck: no money was at risk and nothing was signed. But the row held an open slot
     and its realised result was missing from the record.

     The retry rule in exitForReal is RIGHT for what it was written for — a sell the port
     could not land must never be forgotten. What it could not distinguish is a position
     that is not unsellable but ALREADY GONE. Retrying that is not caution, it is a loop.

     So: a reader, injected like every other outside call this lane makes, answering one
     question — how many units of this mint does the signing wallet hold. Absent, nothing
     changes and the lane latches and retries exactly as before. */
  holdingsReader = null,
  /* THE VOLUME TAPE — the owner's spike criterion, 2026-09-26: "when volume spikes on a
     token, that's a sign to get in and ride the wave."

     Handed in rather than created here whenever somebody else is filling it, which in
     practice is always: the useful samples come from the launch subscription's own trade
     traffic (snipe-volume.mjs, `createTradeTap`), and that tap is mounted on the feed
     source in the poller, not in here. The lane still constructs one when none is given so
     that `measure` is never a null check at three call sites — an empty tape answers
     `not_enough_samples`, the gate treats unknown as not-a-spike, and with no threshold set
     that is a recorded measurement and nothing else. */
  flowTape = null,
  /* THE MARKET READ, AS A PORT — the DexScreener half of the market floor. Injected like
     every other outside call here so a test can drive an empty pair list, a hang, or a pool
     with no liquidity field (which that API really does return) without a network. Absent,
     and the floor refuses whatever it was asked to judge rather than passing it: see
     snipe-market.mjs on why unverified is not safe in both directions. */
  marketReader = null,
  /* SOL IN DOLLARS, AS AN OPTIONAL OVERRIDE. Without it the price is derived from the same
     DexScreener response the depth came out of (snipe-market.mjs, solUsdFromPairs) — free,
     self-consistent, and WSOL-quoted pools only. Wire this to hand the floor the desk's own
     verified oracle instead; a supplied price always wins, and which one was used is reported
     on the facts, because a liquidity figure is only as good as its denominator. */
  solUsdReader = null,
} = {}) {
  /* `let`, and only for applyFilters() below: the entry filters are the one part of this
     configuration a running lane may have replaced. Everything else is read from the same
     object and never changes after construction. */
  let conf = Object.freeze({ ...SNIPE_LANE_DEFAULTS, ...cfg });
  if (!SNIPE_LANE_MODES.includes(conf.lane))
    throw new SnipeLaneError("mode_invalid", `lane ${JSON.stringify(conf.lane)} is not one of ${SNIPE_LANE_MODES.join(", ")}`);
  const executing = conf.lane === "execute";
  /* ARMING, IN THREE REFUSALS. This constructor refused lane=execute outright while there
     was no signing path. There is one now (snipe-execute.mjs), and it is reached ONLY as a
     port handed in here — this file still constructs no connection, loads no key and
     sends nothing, exactly as its own test scans it. Execute mode therefore needs, in
     order: a signing port with a wallet; a clear arming checklist, every item printed;
     and the owner's sentence, typed for that wallet and these two dials. A lane that
     could be armed by a flag alone would be a lane a typo arms. */
  if (executing) {
    const portOk = executor !== null && typeof executor === "object"
      && typeof executor.wallet === "string" && executor.wallet.length > 0
      && typeof executor.prepareBuy === "function" && typeof executor.buy === "function"
      && typeof executor.sell === "function";
    if (!portOk)
      throw new SnipeLaneError("executor_missing",
        "lane=execute needs a signing port {wallet, prepareBuy, buy, sell} from snipe-execute.mjs; "
        + "there is no signing code in this file and it will not run armed without one",
        { lane: conf.lane });
    /* The stop is "explicit" only when the owner typed SNIPE_STOP_FRAC; the checklist then
       still refuses a level the fee rail cannot fund at this size. */
    assertArmable({ cfg: conf, venue, stopExplicit: Number.isFinite(Number(conf.stopFrac)) && Number(conf.stopFrac) > 0 });
    const expected = snipeArmSentence(executor.wallet, conf.maxSolPerTrade, conf.dailySolCap);
    if (conf.liveAck !== expected)
      throw new SnipeLaneError("arming_refused",
        "arming HAWK-AI needs the owner's typed acknowledgement for this wallet and these caps. "
        + `Set SNIPE_LIVE_ACK to exactly:\n\n    ${expected}\n`,
        { wallet: executor.wallet, maxSolPerTrade: conf.maxSolPerTrade, dailySolCap: conf.dailySolCap });
  }

  /* The mode's overrides, resolved once. conf stays the operator's stated configuration so
     it can still be reported back verbatim; `effective` is what the lane actually runs on. */
  const effective = effectiveLaneConfig(conf);
  /* Consecutive two-endpoint disagreements per mint. Cleared by any agreeing read, so it
     counts a RUN of blindness rather than a lifetime total — a position that recovers has
     not been blind for long, whatever it went through earlier. */
  const disagreeStreak = new Map();

  const adapter = executing ? armedVenue(venue) : observeOnlyVenue(venue);

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

  /* A FLOOR WITH NOTHING TO READ REFUSES EVERY CANDIDATE, and in a log that is
     indistinguishable from a market with nothing worth buying in it. So it is a construction
     refusal rather than a quiet afternoon of zero trades: either the floor can be honoured or
     the lane says which half is missing. */
  if (floorIsArmed(conf.marketFloor) && typeof marketReader !== "function")
    throw new SnipeLaneError("market_reader_missing",
      "a market floor is configured but no marketReader port was wired — every candidate would be "
      + "refused at market_floor for want of a measurement, which reads in a log exactly like a "
      + "market with nothing in it. Wire the reader or set SNIPE_MARKET_FLOOR=off.",
      { floor: conf.marketFloor });

  if (typeof control !== "function")
    throw new SnipeLaneError("control_unchecked",
      "the lane needs a control reader returning {hardStop, pauseEntries} as strict booleans; there is no "
      + "safe default, because an unchecked sentinel is not the same fact as an absent one");

  const determiner = bindDeterminer(policy);
  const S = state;
  ensureSnipeBook(S);
  if (S.positions === undefined) S.positions = {};
  const recorder = shadow ?? createSnipeShadow({ capacity: conf.shadowCapacity, laneMode: conf.lane });
  /* A SPIKE FLOOR ON A TAPE NOBODY FILLS REFUSES EVERYTHING. The lane's own reads give a
     mint one sample per notice, and a ratio needs 330 seconds of history, so without a tape
     handed in by whoever mounts the trade tap, every candidate would be refused at
     volume_spike for want of a baseline — in a log, the same sentence as "nothing spiked".
     Refused at construction, like a floor with no reader. */
  if (conf.minVolumeSpike !== undefined && conf.minVolumeSpike !== null && !flowTape)
    throw new SnipeLaneError("volume_tape_unfed",
      `minVolumeSpike is ${conf.minVolumeSpike} but no flowTape port was wired — the lane's own reads cannot `
      + "form a 5-minute baseline, so every candidate would be refused at volume_spike. Mount the trade tap "
      + "(SNIPE_GRPC_ENDPOINT + SNIPE_GRPC_TOKEN) or unset SNIPE_MIN_VOLUME_SPIKE.",
      { minVolumeSpike: conf.minVolumeSpike });
  const flow = flowTape ?? createFlowTape();

  const counters = {
    notices: 0, recorded: 0, cleared: 0, refused: 0, wouldHaveOpened: 0, marketReadsSkipped: 0,
    wouldHaveExited: 0, forwardSamples: 0, readErrors: 0, ticks: 0, deterministErrors: 0,
    /* Execute mode. `entered`/`exited` count fills the port confirmed; the two failure
       counters count buys and sells the port refused or could not land, which in observe
       mode stay at zero for the life of the process. */
    entered: 0, exited: 0, entryFailures: 0, exitFailures: 0,
    /* Rows closed because the wallet no longer held them. Counted apart from exitFailures
       on purpose: an exit that failed and an exit that had already happened are different
       facts, and folding them together is what let one of them hide for eight hours. */
    reconciled: 0,
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
      + (effective.chargeDailyCap ? wouldHaveDeployedSol : 0),
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

    /* COST 1: the one getMultipleAccounts, on every endpoint — and, when the operator has
       asked for the socials filter, the launch's metadata document ALONGSIDE it rather
       than after it. Started here and awaited below, so the filter costs the SLOWER of the
       two rather than their sum: on a launch sniper, a second round trip in series is a
       second during which somebody else is buying. Never awaited when the filter is off,
       so an operator who did not ask for it makes no request at all. */
    const socialsPromise = conf.requireSocials === true
      ? Promise.resolve(socialsReader({
          /* A create event decodes to `uri`; a pump.fun LISTING row — every momentum candidate,
             and any launch the poll hears before the socket — spells it `metadata_uri`
             (50 of 50 live rows, 2026-09-26). Reading only the first sent every momentum
             candidate to no_socials with "no uri", so none ever reached the floor. */
          uri: record?.raw?.uri ?? record?.raw?.metadata_uri ?? record?.uri ?? null,
          timeoutMs: Number(conf.socialsTimeoutMs) || undefined,
        })).catch((error) => Object.freeze({ ok: false, clause: "fetch_failed",
          message: String(error?.message ?? error).slice(0, 160) }))
      : null;
    /* COST 1, THE OTHER HALF: the market read, issued HERE and joined below — beside the
       account read and the metadata read, never after them. Only when a floor is actually
       configured: an operator running no floor makes no request, and the gate passes without
       looking. */
    const listingRow = isPlainObject(record?.raw) ? record.raw : null;
    /* NOT FOR A COIN THE AGE RULE ALREADY REFUSES. Age is free — the listing's creation stamp,
       or for a create event the moment it arrived — so with an age floor armed, a launch
       notice is known to fail before anything is fetched, and paying DexScreener for it was
       ~29 wasted requests a minute. The facts are still assembled (with no pairs), so the gate
       refuses on age by name exactly as before. */
    const floorArmed = floorIsArmed(conf.marketFloor);
    const skipMarketRead = floorArmed
      && ageAloneRefuses(conf.marketFloor, { listing: listingRow, createdAtMs: noticeAtMs, nowMs: clock() });
    if (skipMarketRead) counters.marketReadsSkipped++;
    const marketPromise = !floorArmed ? null
      : skipMarketRead
        ? Promise.resolve(Object.freeze({ ok: false, clause: "skipped_age",
            message: "not fetched: the coin's age alone already fails the floor", pairs: null }))
        : typeof marketReader === "function"
          ? Promise.resolve(marketReader(mint)).catch((error) => Object.freeze({
              ok: false, clause: "fetch_failed", message: String(error?.message ?? error).slice(0, 160), pairs: null }))
          : null;
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

    /* THE BYTES BEFORE THE VERDICT, when armed. Gate 20 (instruction_mismatch) decodes the
       instruction that would be signed and refuses an execute lane that supplies none, so
       the port builds it here from the same plan the contract is about to recompute —
       same curve, same ticket, same cfg, deterministic — and the contract then proves the
       bytes match the plan it reaches on its own. The instruction the gate passed is the
       instruction the port signs; nothing is rebuilt between the check and the send. */
    let prepared = null;
    let prepareError = null;
    if (executing && curve) {
      try {
        const plan = planSnipeCeiling({
          curve: curve.k !== undefined ? curve : snipeCurveState(curve), adapter,
          solLamports: BigInt(Math.round(Number(conf.maxSolPerTrade) * LAMPORTS)), cfg: conf,
        });
        if (plan?.deliverable && plan.baseOutRaw > 0n && plan.maxQuoteInRaw > 0n)
          prepared = await executor.prepareBuy({
            mint, curve, read, baseOutRaw: plan.baseOutRaw, maxQuoteInRaw: plan.maxQuoteInRaw,
          });
      } catch (error) { prepared = null; prepareError = String(error?.message ?? error); }
    }
    hops.push({ hop: "prepare", atMs: clock() });

    /* ONE STAMP FOR THE WHOLE GATE STACK, and the volume measurement taken against it.
       The curve read this notice already paid for is added to the tape first — it is the
       most recent point there is for this mint — and the spike is then measured as of the
       same instant the rest of the gates are judged at. Two clock readings here would let
       the budget gate and the volume gate disagree about when "now" was. */
    const gateAtMs = clock();
    flow.observe(mint, { atMs: gateAtMs, quoteRaw: curve?.realQuoteRaw ?? null });
    const flowNow = flow.measure(mint, { nowMs: gateAtMs });

    /* THE FLOOR'S FACTS, joined here rather than fetched here. The awaited half has had the
       whole account round trip to finish; the liquidity half comes out of the curve that was
       just decoded, which is the only place an exact bonding-curve depth exists. */
    const market = marketPromise
      ? marketReadFor({
          read: await marketPromise,
          /* The candidate row the momentum source carried, when there was one. A launch
             notice has no listing, and its age is then taken from when it arrived. */
          listing: listingRow,
          curve,
          solUsd: typeof solUsdReader === "function" ? (() => { try { return solUsdReader(); } catch { return null; } })() : null,
          createdAtMs: noticeAtMs,
          nowMs: gateAtMs,
        })
      : null;

    const verdict = snipeContract({
      notice: {
        mint,
        creator: record?.creator ?? null,
        slot: record?.firstSlot ?? null,
        noticeAt: noticeAtMs,
        source: record?.firstSource ?? null,
        wallet: executing ? executor.wallet : null,
      },
      curve,
      adapter,
      cfg: conf,
      book: bookView(),
      nowMs: gateAtMs,
      control: controlView(),
      flow: flowNow,
      market,
      mint: read.accounts[2] ?? null,
      creator: creatorFacts(record, curve),
      fees: feeModel(),
      instruction: prepared?.instruction ?? null,
      /* Awaited here rather than at the top: it was issued before the account read and has
         had that whole round trip to finish, so on any healthy gateway this is already
         settled and costs nothing. */
      socials: socialsPromise ? await socialsPromise : null,
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
      if (executing) await enterForReal({ row, mint, curve, verdict, frictionX, record, read, prepared });
      else openWouldBePosition({ row, mint, curve, verdict, frictionX, record, slot: read.slot });
    } else {
      counters.refused++;
      const why = prepareError && verdict.gate === "instruction_mismatch"
        ? `${verdict.detail.message} (the port could not build the instruction: ${prepareError})`
        : verdict.detail.message;
      log(`snipe ${executing ? "live" : "shadow"} ${mint}: refused at ${verdict.gate} — ${why}`);
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

  /**
   * THE REAL ENTRY, through the port. The verdict's numbers are the contract's own plan —
   * the quantity the instruction encodes and the ceiling it may spend — and the port has
   * already proved those bytes decode back to them (gate 20). What comes back is the
   * FILL: what the chain actually charged and delivered, read from the confirmed
   * transaction, never from the plan. The book is opened on the fill, so every mark this
   * position is ever judged against is a multiple of the SOL that actually left.
   *
   * A port refusal is a finding on the log, not a crash: the notice was refused at the
   * last gate there is. A fill the book then refuses is the one case that must shout —
   * the money has moved and the lane cannot hold the position — so it names the
   * signature and says to sell by hand; the journal has the intent either way.
   */
  let lastEntryFailure = null;
  async function enterForReal({ row, mint, curve, verdict, frictionX, record, read, prepared }) {
    const creator = record?.creator ?? curve?.creator ?? null;
    let fill = null;
    try {
      fill = await executor.buy({
        mint, curve, curveReadSlot: read.slot, prepared, creator,
        baseOutRaw: verdict.detail.baseOutRaw, maxQuoteInRaw: verdict.detail.maxQuoteInRaw,
      });
    } catch (error) {
      counters.entryFailures++;
      /* The last reason, kept for the heartbeat: 43 simulation failures once reached nobody but
         a log file on the owner's Mac, and the page could only say "entryFailures: 43". */
      lastEntryFailure = Object.freeze({ atMs: clock(), mint: String(mint), clause: String(error?.clause ?? error?.name ?? "error"),
        message: String(error?.message ?? error).slice(0, 240) });
      log(`snipe live ${mint}: ENTRY FAILED (${error?.clause ?? error?.name ?? "error"}): ${error?.message ?? error}`);
      return null;
    }
    const isRaw = (v) => /^\d+$/.test(String(v ?? "")) && BigInt(String(v)) > 0n;
    if (!fill || !isRaw(fill.qtyRaw) || !isRaw(fill.quoteInRaw)) {
      counters.entryFailures++;
      log(`snipe live ${mint}: ENTRY UNACCOUNTED — the port returned no usable fill; the journal holds the intent`);
      return null;
    }
    const openedAt = Number(fill.confirmedAtMs) > 0 ? Number(fill.confirmedAtMs) : clock();
    const entryInputLamports = BigInt(String(fill.quoteInRaw));
    const qtyRaw = BigInt(String(fill.qtyRaw));
    const paidFee = /^\d+$/.test(String(fill.feeLamports ?? "")) ? BigInt(String(fill.feeLamports)) : feeReserveLamports();
    const sizeSol = Number(entryInputLamports) / LAMPORTS;
    const feeSolPerLeg = Number(paidFee) / LAMPORTS;
    try {
      const position = determiner.open({ mint, entry: 1, openedAt, creator, sizeSol, feeSolPerLeg });
      const filed = openSnipe(S, {
        ...position,
        mint, venue: adapter.id, entry: 1, openedAt, sizeSol, feeSolPerLeg,
        qtyRaw, entryInputLamports, entryFeeLamports: paidFee, creator,
        openedAtSlot: Number.isFinite(Number(fill.slot)) ? Number(fill.slot) : read.slot,
        frictionXAtOpen: frictionX, samples: 0,
        /* The fields that make this a position and not a would-have: the signature the
           chain accepted, the intent the journal holds, and the basis every exit realizes
           against. costBasisLamports is input plus the entry fee, as the desk defines it. */
        live: true,
        entrySignature: fill.signature ?? null,
        entryIntentId: fill.intentId ?? null,
        costBasisLamports: String(entryInputLamports + paidFee),
      });
      counters.entered++;
      wouldHaveDeployedSol += sizeSol;   // charged for real: effective.chargeDailyCap is forced on
      const floor = safeFloor();
      log(`snipe live ${mint}: ENTERED — ${qtyRaw} base for ${entryInputLamports} lamports plus ${paidFee} fee, `
        + `sig ${fill.signature ?? "?"}, frictionX ${frictionX === null ? "?" : frictionX.toFixed(4)}, `
        + `floorMarkX ${floor.floorMarkX.toFixed(4)}`);
      return filed;
    } catch (error) {
      counters.entryFailures++;
      log(`snipe live ${mint}: BOUGHT BUT THE BOOK REFUSED THE FILL (${error?.clause ?? error?.name}): ${error?.message} `
        + `— sig ${fill.signature ?? "?"}; the journal holds the intent; this position must be sold by hand`);
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
    /* The management read carries the deployer's two candidate token accounts when the
       adapter offers them and the fill recorded a creator. Falls back to the entry list,
       so an adapter without accountsForHeld simply has no creator signal rather than
       throwing — and LANE_SIGNALS is what says so out loud. */
    const heldAddresses = typeof adapter.accountsForHeld === "function"
      ? adapter.accountsForHeld(mint, { creator: pos.creator ?? null })
      : adapter.accountsFor(mint);
    const read = await readAcrossEndpoints({ readers, addresses: heldAddresses, mint });
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

    /* THE SENTINELS, READ FRESH ON THE MANAGEMENT PATH AND NOT ONLY ON THE ENTRY PATH.
       handleNotice has always consulted control(); stepOne never did, which made the hard
       stop an entry gate wearing a kill switch's name. Read here so one file still stops
       both lanes AND reaches what is already open. */
    /* ── DID THE DEPLOYER GET OUT? ─────────────────────────────────────────────────
     *
     * snipe-policy.mjs calls this "the one signal a launch has that no later market
     * does", and until now nothing told it: stepOne passed a literal false, so the branch
     * could not fire. This is what tells it.
     *
     * WITNESSED ACROSS EVERY ENDPOINT, UNANIMOUSLY. readAcrossEndpoints judges presence
     * and digest on accounts[0] — the curve — and nothing else, so these two addresses
     * ride along unwitnessed by the verdict. A fall here triggers a FULL MARKET SELL, so
     * one lying node must not be able to cause one: the balance is decoded from every
     * endpoint's own answer and a fall counts only when they all agree on it.
     *
     * A BALANCE THAT FALLS IS THE SIGNAL, not a sale specifically. On chain a sale and a
     * transfer to a fresh wallet look identical, and on a launch the second is the first
     * with an extra step. Naming it "sold" would be the narrower claim; the reason string
     * says what was actually measured.
     *
     * AND "THE CREATOR HOLDS NOTHING" IS NOT "THE CREATOR HAS NOT SOLD". Measured on
     * mainnet: of four sampled deployers, two had no token account for their own mint at
     * all and two held exactly zero. A baseline of zero can never fall, so the signal is
     * inapplicable rather than quiet, and the position records which. */
    let creatorExited = false, creatorNote = null;
    let creatorBaselineRaw = pos.creatorBaselineRaw ?? null;
    if (pos.creator && heldAddresses.length > adapter.accountsFor(mint).length) {
      const first = adapter.accountsFor(mint).length;   // where the creator accounts begin
      const amountFrom = (accounts) => {
        let total = null;
        for (let i = first; i < heldAddresses.length; i++) {
          const amt = adapter.decodeTokenAmount?.(accounts?.[i], { mint, owner: pos.creator });
          if (amt === null || amt === undefined) continue;
          total = (total ?? 0n) + amt;
        }
        return total;
      };
      const perEndpoint = (read.all ?? []).map((v) => amountFrom(v.accounts));
      const answered = perEndpoint.filter((v) => v !== null);
      const unanimous = answered.length === perEndpoint.length && answered.length > 0
        && answered.every((v) => v === answered[0]);
      if (unanimous) {
        const nowRaw = answered[0];
        if (creatorBaselineRaw === null) {
          creatorBaselineRaw = String(nowRaw);
          creatorNote = nowRaw === 0n ? "creator held nothing at the first readable tick" : null;
        } else {
          const base = BigInt(creatorBaselineRaw);
          if (base > 0n) {
            const fallen = base - nowRaw;
            const frac = Number(fallen * 10000n / base) / 10000;
            if (frac >= Number(effective.creatorExitFrac)) {
              creatorExited = true;
              creatorNote = `the deployer's balance fell ${(frac * 100).toFixed(1)}% ` +
                `(${base} -> ${nowRaw}) — sold or moved out, which on a launch is the same signal`;
            }
          }
        }
      } else if (answered.length) {
        creatorNote = "endpoints disagree on the deployer's balance — not acting on one node's word";
      }
    }

    const sentinels = controlView();

    /* A DISAGREEMENT IS BLINDNESS, NOT HOSTILITY — UNTIL IT PERSISTS.
     *
     * Two endpoints returning different bytes for the same account at the same slot is a
     * decode fault or a lying node. At ENTRY, refusing on it is plainly right: there is
     * nothing to lose by not acting. This was also wired straight into rugFlag on the EXIT
     * path, where it means something very different — a full market liquidation of a real
     * position on a transport hiccup, paying 1.25% of venue fee each way to act on a fact
     * nobody established. At 0.4 SOL, a flaky endpoint would repeatedly force-sell the book.
     *
     * So a single disagreement now makes the MARK unusable, which the policy already
     * handles as the absence of information: it holds, and the clock decides. What a
     * disagreement cannot be allowed to do is persist silently — a position nobody can
     * price is a position nobody is managing — so after disagreeStreakMax consecutive
     * blind ticks it escalates to the exit it used to take immediately.
     *
     * Both directions of the error are covered: a transient fault no longer liquidates,
     * and sustained blindness still leaves. */
    if (read.verdict === "disagree") disagreeStreak.set(mint, (disagreeStreak.get(mint) ?? 0) + 1);
    else disagreeStreak.delete(mint);
    const blindStreak = disagreeStreak.get(mint) ?? 0;
    const blindTooLong = blindStreak >= Number(conf.disagreeStreakMax);
    if (read.verdict === "disagree" && !blindTooLong) markX = null;

    /* `effective`, not `conf`: the owner's take and stop dials are folded into policy by
       effectiveLaneConfig, and until 2026-09-12 this handed the determiner the stated
       config instead — SNIPE_TAKE_AT_ENTRY_X was parsed, printed, checked by the arming
       checklist, and never once read by the code that sells. */
    const step = determiner.step({
      position: pos, markX, nowMs: now, cfg: effective,
      hardStop: sentinels.hardStop === true,
      /* LANE_SIGNALS.creatorSold is "unwired" and this literal is why. Declared there so
         the armability checklist blocks on it, rather than living as a comment nobody
         reads next to a branch that silently never fires. */
      creatorSold: creatorExited,
      creatorSoldDetail: creatorExited ? creatorNote : null,
      rugFlag: blindTooLong,
      sample: { markX, nowMs: now, slot: read.slot, endpoint: read.chosen?.id ?? null },
    });

    counters.forwardSamples++;
    /* The held position's own reserve reading, onto the same tape. Free — the read has
       already happened — and it keeps a coin we are in measurable even if the trade tap is
       not mounted or the wire went quiet. */
    flow.observe(mint, { atMs: now, quoteRaw: curve?.realQuoteRaw ?? null });
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
      /* What the deployer's balance said this tick, including when it said nothing. A
         signal that is inapplicable must be visibly inapplicable in the record, or a
         reader counts silence as reassurance. */
      creatorBaselineRaw,
      creatorNote,
    });

    const aged = now - Number(pos.openedAt) >= Number(conf.holdMaxMs);
    const samples = Number(pos.samples ?? 0) + 1;
    /* AN ARMED LANE CLOSES ONLY ON A SELL — the determiner's or the clock's. The forward
       window is a property of the shadow book (a would-have-position needs no exit, so the
       row is closed once its evidence is complete); a real position that has been sampled
       forwardSamples times has simply been held that long, and is sold when a rule fires. */
    const wantsSell = step?.action === "sell" || aged;
    const done = executing ? wantsSell : (wantsSell || samples >= Number(conf.forwardSamples));

    if (!done) {
      /* The determiner's own updated position is carried back into the book, which is what
         `updateSnipe` exists for: it re-runs the whole shape test and refuses anything that
         rewrites the fill. */
      updateSnipe(S, { ...pos, ...(isPlainObject(step?.position) ? step.position : {}), mint, samples,
        creatorBaselineRaw });
      return Object.freeze({ mint, action: step?.action ?? "hold", markX, closed: false });
    }

    const reason = step?.action === "sell" ? step.reason
      : aged ? (executing
        ? `clock: the position reached its ${conf.holdMaxMs}ms hold — leaving on the clock`
        : `clock: the forward window closed at ${conf.holdMaxMs}ms`)
        : `the forward path is complete at ${samples} samples`;
    if (executing)
      return exitForReal({ pos, mint, curve, read, reason, now, markX, samples, creatorBaselineRaw, step });
    closeSnipe(S, mint, { reason, closedAt: now });
    recorder.close(mint, { action: step?.action === "sell" ? "would_have_exited" : "window_closed", reason, atMs: now, slot: read.slot });
    if (step?.action === "sell") counters.wouldHaveExited++;
    log(`snipe shadow ${mint}: would-have-exit (${step?.action ?? "window"}) — ${reason}`);
    return Object.freeze({ mint, action: step?.action ?? "window_closed", markX, closed: true });
  }

  /**
   * THE REAL EXIT, through the port, always the WHOLE position. A sell the port cannot
   * land keeps the book entry exactly as it was, latched with the reason and the error, and
   * is retried on the next tick: a position the lane could not sell is not a position the
   * lane may forget. The book closes only on a fill, and the realized figure is what the
   * chain paid back less the fee and the basis the entry recorded — never a mark.
   */
  /**
   * Does the signing wallet hold nothing of this mint?
   *
   * TRUE ONLY ON A DEFINITE ZERO. Every other answer — no port, a throw, a null, a
   * number that will not parse — is "I do not know", and not knowing must never close a
   * position: that is the difference between reconciling a sale that happened and
   * forgetting one that did not. The whole point of this function is that it fails
   * closed, so it is written to return false everywhere except the one certain case.
   */
  async function walletHoldsNothing(mint) {
    if (!holdingsReader || typeof holdingsReader.read !== "function") return false;
    let answer;
    try { answer = await holdingsReader.read(mint); }
    catch (error) {
      log(`snipe live ${mint}: could not read the wallet's balance (${error?.message ?? error}) — `
        + "treating it as unknown, so the position is kept");
      return false;
    }
    const raw = answer?.qtyRaw;
    if (raw === null || raw === undefined) return false;
    const text = String(raw);
    if (!/^\d+$/.test(text)) return false;
    return BigInt(text) === 0n;
  }

  async function exitForReal({ pos, mint, curve, read, reason, now, markX, samples, creatorBaselineRaw, step }) {
    let fill = null;
    try {
      fill = await executor.sell({ mint, curve, curveReadSlot: read.slot, qtyRaw: pos.qtyRaw, position: pos, reason });
    } catch (error) {
      counters.exitFailures++;
      const detail = `${error?.clause ?? error?.name ?? "error"}: ${error?.message ?? error}`;
      /* BEFORE LATCHING IT: is there anything left to sell? A failed sell and a position
         that is already gone look identical from inside this catch, and only the wallet
         can tell them apart. A DEFINITE zero is the only answer that closes a row — an
         unreadable balance, a throwing reader and a missing port all fall through to the
         latch below, which is the behaviour this lane has always had. */
      const gone = await walletHoldsNothing(mint);
      if (gone) {
        counters.reconciled++;
        const why = `reconciled: the wallet holds no ${mint} — this position left before this sell could. `
          + `The last attempt failed with ${detail}`;
        try {
          /* realizedLamports stays NULL. The sale happened outside this lane's sight, so
             its result is unknown here — and "not read" is a true statement where a zero
             would be a false one. The book and the board both render it as words. */
          closeSnipe(S, mint, { reason: why, closedAt: now, exitSignature: null,
            quoteOutRaw: null, realizedLamports: null });
          recorder.close(mint, { action: "reconciled", reason: why, atMs: now, slot: read.slot });
          log(`snipe live ${mint}: RECONCILED — the wallet holds none of it, so the position is `
            + `closed rather than retried for ever. Its realised result is not read here.`);
          return Object.freeze({ mint, action: "reconciled", markX, closed: true, reconciled: true });
        } catch (closeError) {
          log(`snipe live ${mint}: could not close the reconciled row (${closeError?.message ?? closeError})`);
        }
      }
      log(`snipe live ${mint}: EXIT FAILED — ${detail}; the position is kept and the sell is retried next tick`);
      try {
        updateSnipe(S, { ...pos, ...(isPlainObject(step?.position) ? step.position : {}), mint, samples,
          creatorBaselineRaw, exitLatched: true, exitLatchedAt: now, exitLatchReason: reason,
          exitError: detail.slice(0, 240) });
      } catch (bookError) {
        log(`snipe live ${mint}: could not record the exit latch (${bookError?.message ?? bookError})`);
      }
      return Object.freeze({ mint, action: "sell", markX, closed: false, latched: true });
    }
    const raw = (v) => (/^\d+$/.test(String(v ?? "")) ? BigInt(String(v)) : null);
    const quoteOut = raw(fill?.quoteOutRaw);
    const fee = raw(fill?.feeLamports) ?? 0n;
    const basis = raw(pos.costBasisLamports)
      ?? (raw(pos.entryInputLamports) ?? 0n) + (raw(pos.entryFeeLamports) ?? 0n);
    const realized = quoteOut === null ? null : quoteOut - fee - basis;
    closeSnipe(S, mint, {
      reason, closedAt: now,
      exitSignature: fill?.signature ?? null,
      quoteOutRaw: quoteOut === null ? null : String(quoteOut),
      realizedLamports: realized === null ? null : String(realized),
    });
    recorder.close(mint, { action: "exited", reason, atMs: now, slot: read.slot });
    counters.exited++;
    log(`snipe live ${mint}: EXITED — ${reason}; ${quoteOut ?? "?"} lamports back for ${pos.qtyRaw} base, `
      + `fee ${fee}, realized ${realized === null ? "?" : realized} lamports, sig ${fill?.signature ?? "?"}`);
    return Object.freeze({ mint, action: "sell", markX, closed: true });
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
    /* A getter, not a snapshot: applyFilters() replaces the entry filters, and a caller reading
       `lane.cfg` must see the ones the gates are judging on now. */
    get cfg() { return conf; },
    /* What the lane actually runs on: the stated config with the mode's overrides and the
       owner's dials folded into policy. Exposed so a test can prove a typed dial arrived. */
    effective,
    mode: conf.lane,
    adapter,
    determiner: Object.freeze({ shape: determiner.shape, version: determiner.version }),
    shadow: recorder,
    state: S,

    /** Opens the feed's subscriptions and begins consuming. Nothing above this line has
     *  opened one, and nothing anywhere in this file signs. */
    async start() {
      if (started) throw new SnipeLaneError("already_started", "the snipe lane is already running");
      if (conf.lane !== "observe" && conf.lane !== "execute")
        throw new SnipeLaneError("mode_invalid",
          `SNIPE_LANE is "${conf.lane}" — gate 0 (lane_off) would refuse every notice; the lane is not armed`,
          { lane: conf.lane });
      if (!feed || typeof feed.notices !== "function" || typeof feed.start !== "function")
        throw new SnipeLaneError("feed_missing", "the lane needs a feed with start() and notices()");
      started = true;
      const floor = safeFloor();
      const posture = executing
        ? `EXECUTING for ${executor.wallet} on ${adapter.id}`
        : `OBSERVE ONLY on ${adapter.id}`;
      const tail = executing
        ? `signing through the port; ${conf.dailySolCap} SOL per day; sold in full at the take, the stop, the creator's exit or the clock`
        : "no keypair is loaded, nothing is signed, nothing is sent";
      log(`snipe lane ${SNIPE_LANE_VERSION}: ${posture} over ${readers.length} endpoints `
        + `[${ids.join(", ")}]; ticket ${conf.maxSolPerTrade} SOL, derived stop ${floor.stopFrac.toFixed(4)} `
        + `(floorMarkX ${floor.floorMarkX.toFixed(4)}, minViable ${floor.minViableSol.toFixed(6)} SOL); `
        + `determiner ${determiner.shape}${determiner.version ? ` ${determiner.version}` : ""}; `
        + tail);
      if (floorIsArmed(conf.marketFloor)) {
        const named = MARKET_FLOOR_KEYS.filter((k) => conf.marketFloor[k] !== null)
          .map((k) => `${k}=${conf.marketFloor[k]}`).join(", ");
        log(`snipe market floor ARMED${conf.riskMode !== "off" ? ` (risk mode ${conf.riskMode})` : ""}: ${named} — candidates under any of these are refused at market_floor`);
        for (const w of curveReachability(conf.marketFloor)) log(`snipe market floor WARNING: ${w.message}`);
      } else log("snipe market floor: off (every candidate is judged on the launch gates alone)");
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

    /**
     * REPLACE THE ENTRY FILTERS OF A RUNNING LANE — nothing else. `next` is a full lane config
     * (from remoteFilterConfig); only LIVE_FILTER_KEYS are taken from it, so a money dial, an
     * exit dial or the lane mode in it is ignored rather than applied.
     *
     * The same two port checks construction makes are made here, because a floor with no
     * reader or a spike floor with no tape refuses every candidate and reads in a log like an
     * empty market. A refused change leaves the running filters exactly as they were.
     * Never throws: it is called from the heartbeat path.
     */
    applyFilters(next) {
      if (!isPlainObject(next)) return Object.freeze({ ok: false, reason: "no configuration" });
      const picked = {};
      for (const key of LIVE_FILTER_KEYS) if (Object.prototype.hasOwnProperty.call(next, key)) picked[key] = next[key];
      if (floorIsArmed(picked.marketFloor) && typeof marketReader !== "function")
        return Object.freeze({ ok: false, reason: "a market floor was asked for but this lane has no market reader wired" });
      if (picked.minVolumeSpike !== undefined && picked.minVolumeSpike !== null && !flowTape)
        return Object.freeze({ ok: false, reason: "a volume-spike floor was asked for but no trade tape feeds this lane" });
      const changed = LIVE_FILTER_KEYS.filter((k) => JSON.stringify(conf[k] ?? null) !== JSON.stringify(picked[k] ?? null));
      if (!changed.length) return Object.freeze({ ok: true, changed: Object.freeze([]) });
      conf = Object.freeze({ ...conf, ...picked });
      const floorText = floorIsArmed(conf.marketFloor)
        ? MARKET_FLOOR_KEYS.filter((k) => conf.marketFloor[k] !== null).map((k) => `${k}=${conf.marketFloor[k]}`).join(", ")
        : "off";
      log(`snipe filters CHANGED from the desk (${changed.join(", ")}): risk mode ${conf.riskMode}; floor ${floorText}; `
        + `volume spike ${conf.minVolumeSpike ?? "measure only"}; socials ${conf.requireSocials === true ? "required" : "not required"}`);
      for (const w of curveReachability(conf.marketFloor)) log(`snipe market floor WARNING: ${w.message}`);
      return Object.freeze({ ok: true, changed: Object.freeze(changed) });
    },
    /** The entry filters this lane is judging on right now. */
    filters() {
      const out = {};
      for (const key of LIVE_FILTER_KEYS) out[key] = conf[key] ?? null;
      return Object.freeze(out);
    },
    /* The tape, exposed so the process that MOUNTS the trade tap and the lane that reads
       the tape are provably the same one. A second tape filled by the tap and never
       measured would look identical in every log line either of them prints. */
    flow,
    report(opts) { return recorder.report(opts); },
    render(opts) { return recorder.render(opts); },
    rows() { return recorder.rows(); },
    /* THE LATENCY BUDGET this process is actually running at. Exposed on the lane rather
       than left inside the recorder because the operator asking "why am I five seconds
       late" cannot read a shadow row, and the answer is a per-hop percentile. */
    latency(opts) { return latencyBudget(recorder.rows(), opts); },
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
        chargeDailyCap: effective.chargeDailyCap === true,
        wouldHaveDeployedSol,
        /* What the volume tape actually holds. A spike gate reporting "no spike" on every
           launch and a spike gate whose tape is empty are the same sentence and different
           facts, so the tape's own counters ride on the lane's stats. */
        flow: flow.stats(),
        /* THE FLOOR THIS LANE IS ACTUALLY RUNNING, and whether it can be honoured. A floor
           configured with no reader wired refuses every candidate, which in a log looks
           exactly like a market with nothing in it — so both facts are stamped. */
        marketFloor: conf.marketFloor,
        marketFloorArmed: floorIsArmed(conf.marketFloor),
        marketReaderWired: typeof marketReader === "function",
        lastEntryFailure,
        ...counters,
        /* STAMPED AND ASSERTED. Not a claim in a comment — a field the test reads. An
           observing lane reports zero for all three by construction; an armed lane reports
           what its port counted, which is the only party that can count it. */
        ...(executing && typeof executor.stats === "function"
          ? (() => { const s = executor.stats() ?? {};
              return { signed: Number(s.signed) || 0, sent: Number(s.sent) || 0,
                keypairsLoaded: Number(s.keypairsLoaded) || 0 }; })()
          : { signed: 0, sent: 0, keypairsLoaded: 0 }),
      });
    },
  };
}
