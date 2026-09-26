/**
 * THE FEE LANE — the business, as opposed to the marketing.
 *
 * Measured across 26 of bagworkagent.fun's agents and 362 closed trades, best performer to
 * worst:
 *
 *     trading        -0.077 SOL
 *     creator fees  +14.515 SOL
 *     level rewards  +0.620 SOL
 *
 * Twenty-one percent win rate. Their #1 agent displays +15.6 SOL and is -0.105 on trading.
 * Not one agent in that system makes money trading. Every SOL of profit is the pump.fun
 * creator fee on the coin the agent itself launched: the trading makes the coin worth
 * watching, the watching makes volume, the volume makes the fee. The bot is the marketing.
 * This file is the business.
 *
 * pumpfun-fees.mjs already holds the claim itself, decoded from three transactions that
 * landed on mainnet. What was missing is everything around it: deciding WHEN a claim is worth
 * making, signing it behind the same gates the trading path signs behind, and booking what
 * arrives in a way that cannot flatter a losing strategy.
 *
 * ── THE ONE THING THIS FILE REFUSES TO DO ─────────────────────────────────────────────
 *
 * BAGWORK's own `pnlSol` adds claimed fees to trading P&L. That is how a bot that loses every
 * round trip displays +15.6 SOL, and it is not a display bug — it is the mechanism by which a
 * losing strategy survives contact with its owner. Nobody turns off a bot that shows +15.6.
 *
 * So fee revenue is kept in ITS OWN BOOK, on disk, physically separate from the journal the
 * trading path writes. Not a flag on a shared row, not a field somebody could sum by accident:
 * a different file. `feeSummary()` reports the two figures side by side and there is no
 * function in this module that returns their total. If this desk ever shows a blended number,
 * it will have to be written on purpose, by somebody who read this paragraph.
 *
 * ── AND IT WILL NOT CLAIM WHAT IT CANNOT KEEP ─────────────────────────────────────────
 *
 * The claim instructions carry no amount, so claiming an empty vault costs a signature and a
 * priority fee to move zero. Worse, it would then be BOOKED as revenue of zero while the fee
 * left the wallet, so the lane's own cost would show up nowhere. Every decision here is made
 * on lamports NET of what the transaction costs, and a claim that does not clear its own cost
 * plus a margin is skipped with the arithmetic attached.
 *
 * ── DRY BY DEFAULT ────────────────────────────────────────────────────────────────────
 *
 * `live: false` is the shipped default. The lane reads the vaults, decides, and records what
 * it WOULD have claimed — the same observe-first discipline the sniper ships under, for the
 * same reason: a signing path that has never been watched deciding is a signing path nobody
 * has checked. Arming needs an explicit mode and the owner's typed acknowledgement of the
 * wallet the fees will land in.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * The rent-exempt minimum for a system-owned account with no data, in lamports — MEASURED ON
 * MAINNET, 2026-09-26, not remembered:
 *
 *     getMinimumBalanceForRentExemption(0)   ->   650240
 *     getMinimumBalanceForRentExemption(165) ->  1488440   (a token account, for reference)
 *
 * The curve's creator vault is a data-less system account, so its balance is never fully
 * claimable and the last of it cannot move. Subtracting this is what stops the lane claiming
 * the same few hundred thousand lamports of rent over and over and booking each pass as income.
 *
 * IT WAS WRITTEN AS 890,880 FIRST, from memory, and the chain was asked before it shipped. The
 * error would have been in the safe direction — too high leaves a little behind, too low makes
 * a claim fail loudly — but "safe direction" is not the same as "right", and a constant that
 * silently under-claims forever is a revenue line quietly missing 0.00024 SOL a claim. It is a
 * config key (`rentReserveLamports`) so an operator on a chain whose rent parameters have moved
 * can correct it without a release.
 *
 * ONE OPERATIONAL NOTE that is not a threshold: the pump-amm half of the claim creates a token
 * account and closes it in the same transaction, so its 1,488,440 lamports come back — but the
 * wallet has to be able to cover them for the length of one transaction. A wallet holding less
 * than about 0.0015 SOL free cannot claim, however much is waiting in the vaults.
 */
export const SYSTEM_RENT_EXEMPT_LAMPORTS = 650_240;

export const FEE_LANE_VERSION = "fee-lane-v1";

/** The kinds this lane books. `creator_fee` is revenue; nothing here is ever a trade. */
export const FEE_RECORD_KINDS = Object.freeze(["claim_skipped", "claim_would_have", "claim_landed", "claim_failed"]);

/** Why a pass claimed nothing. Every one of these is a normal outcome, not an error. */
export const SKIP_CLAUSES = Object.freeze([
  "no_creator",        // no coin's creator is this desk's wallet — nothing has ever accrued
  "unreadable",        // a vault could not be read: unknown is not zero
  "below_floor",       // there is money there, but not enough to clear its own cost
  "not_live",          // dry run: decided, recorded, nothing signed
  "hard_stop",         // the desk's own sentinel; a claim is a signature like any other
]);

export const FEE_LANE_DEFAULTS = Object.freeze({
  /* Every half hour. Fees accrue per trade on the coin, so there is no hurry: a claim is
     worth exactly as much an hour later, minus nothing. Polling faster costs requests to
     learn the same number. */
  intervalMs: 30 * 60_000,
  /* WHAT A CLAIM MUST BE WORTH, net of its own cost, before it is made. 0.002 SOL is roughly
     twenty times a typical claim's fees, so a claim is only made when the overwhelming
     majority of what moves is kept. */
  minNetLamports: 2_000_000,
  /* The transaction's own cost, for the net arithmetic. Read from the same dials the trading
     path uses so the two cannot disagree about what a signature costs. */
  signatureFeeLamports: 5_000,
  priorityFeeLamports: 0,
  rentReserveLamports: SYSTEM_RENT_EXEMPT_LAMPORTS,
  /* DRY BY DEFAULT. See the header. */
  live: false,
});

/**
 * THE LANE'S NUMBERS FROM THE ENVIRONMENT, validated — and refused by name when they are not
 * numbers this lane can run on.
 *
 * `Number(env value || default)` was the whole parser before, and it accepted everything:
 * `FEE_CLAIM_INTERVAL_MS=30m` is NaN and `=0` is zero, and setInterval treats both as ~1ms, so a
 * typo turned a half-hourly read into a flood of RPC calls on the connection the trading path
 * shares. An unparseable floor was NaN, which made every `net < floor` comparison false and so
 * behaved as a floor of zero. Both are refused now, at startup, with the value named.
 */
export const FEE_LANE_MIN_INTERVAL_MS = 60_000;
export function feeLaneConfigFromEnv(env = {}) {
  const read = (name, dflt, { min }) => {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text))
      throw new FeeLaneError("config_invalid", `${name}=${JSON.stringify(text)} is not a whole number`, { name, value: text });
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < min)
      throw new FeeLaneError("config_invalid", `${name}=${text} is under the minimum of ${min}`, { name, value: n, min });
    return n;
  };
  return Object.freeze({
    intervalMs: read("FEE_CLAIM_INTERVAL_MS", FEE_LANE_DEFAULTS.intervalMs, { min: FEE_LANE_MIN_INTERVAL_MS }),
    minNetLamports: read("FEE_CLAIM_MIN_NET_LAMPORTS", FEE_LANE_DEFAULTS.minNetLamports, { min: 0 }),
  });
}

export class FeeLaneError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "FeeLaneError";
    this.clause = clause;
    this.detail = Object.freeze({ clause, ...detail });
  }
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
/** A finite non-negative integer of lamports, or null. Never a coerced zero. */
const lamports = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? Math.floor(x) : null;
};

/**
 * What one pass should do, as a pure function of what the vaults hold and what a claim costs.
 *
 * Returns `{ claim: boolean, clause, netLamports, grossLamports, costLamports, ... }`. Never
 * throws on a bad reading and never guesses at one: an unreadable vault produces
 * `claim: false` with clause `unreadable`, distinct in every field from a vault that is
 * genuinely empty, because a lane that treats those the same stops claiming the moment an RPC
 * hiccups and never says why.
 */
export function feeClaimDecision({ claimable = null, cfg = {}, hardStop = false } = {}) {
  const conf = { ...FEE_LANE_DEFAULTS, ...cfg };
  const cost = (lamports(conf.signatureFeeLamports) ?? 0) + (lamports(conf.priorityFeeLamports) ?? 0);
  const floor = lamports(conf.minNetLamports) ?? 0;
  const rent = lamports(conf.rentReserveLamports) ?? 0;

  const base = Object.freeze({
    claim: false, costLamports: cost, floorLamports: floor, rentReserveLamports: rent,
    curveLamports: claimable?.curveLamports ?? null,
    ammLamports: claimable?.ammLamports ?? null,
    grossLamports: null, netLamports: null,
  });

  /* THE SENTINEL FIRST. A claim is a signature, and HARD STOP means this wallet signs
     nothing — the owner's instruction does not have an exception for the profitable path. */
  if (hardStop === true)
    return Object.freeze({ ...base, clause: "hard_stop",
      message: "HARD STOP is set: this wallet signs nothing, and a claim is a signature like any other" });

  if (!isPlainObject(claimable) || claimable.creator === null || claimable.creator === undefined)
    return Object.freeze({ ...base, clause: "no_creator",
      message: "no creator wallet was supplied, so there is no vault to read — a claim pays only the coin's own creator" });

  if (claimable.readable !== true)
    return Object.freeze({ ...base, clause: "unreadable",
      message: "neither creator vault could be read. That is not the same fact as an empty vault, and this "
        + "lane will not spend a signature on a guess — it retries next pass" });

  /* HALF A READING IS NOT A READING. `readable` is true when EITHER side answered, so a failed
     curve read beside an AMM account that simply does not exist yet came through as "readable",
     and `?? 0` then booked the unknown curve as a measured zero: a claim sized on half the
     vaults, and a below_floor row reporting "0.000000 SOL" for money nobody had counted. */
  const curve = lamports(claimable.curveLamports);
  const amm = lamports(claimable.ammLamports);
  if (curve === null || amm === null)
    return Object.freeze({ ...base, clause: "unreadable", partial: true,
      message: `the ${curve === null ? "bonding-curve" : "pump-amm"} vault could not be read, so what is claimable is `
        + "unknown — the other side's figure is not the total, and this lane retries next pass rather than acting on half" });
  const curveClaimable = Math.max(0, curve - rent);
  const gross = curveClaimable + amm;
  const net = gross - cost;

  if (net < floor)
    return Object.freeze({ ...base, clause: "below_floor", grossLamports: gross, netLamports: net,
      curveClaimableLamports: curveClaimable,
      message: `${(gross / LAMPORTS_PER_SOL).toFixed(6)} SOL is claimable (${(curveClaimable / LAMPORTS_PER_SOL).toFixed(6)} `
        + `from the curve after ${(rent / LAMPORTS_PER_SOL).toFixed(6)} of rent that cannot move, `
        + `${(amm / LAMPORTS_PER_SOL).toFixed(6)} from pump-amm), which is ${(net / LAMPORTS_PER_SOL).toFixed(6)} net of `
        + `${(cost / LAMPORTS_PER_SOL).toFixed(6)} in fees — under the ${(floor / LAMPORTS_PER_SOL).toFixed(6)} floor. `
        + "Fees accrue; this is worth exactly as much next pass" });

  if (conf.live !== true)
    return Object.freeze({ ...base, clause: "not_live", grossLamports: gross, netLamports: net,
      curveClaimableLamports: curveClaimable,
      message: `would claim ${(gross / LAMPORTS_PER_SOL).toFixed(6)} SOL, ${(net / LAMPORTS_PER_SOL).toFixed(6)} net — `
        + "but this lane is not armed, so nothing was signed" });

  return Object.freeze({ ...base, claim: true, clause: null, grossLamports: gross, netLamports: net,
    curveClaimableLamports: curveClaimable,
    /* WHICH HALVES TO INCLUDE. Claiming a side that holds nothing would add instructions and
       cost to move zero, and on the pump-amm side it would create and close a token account
       for no reason. */
    includeCurve: curveClaimable > 0, includeAmm: amm > 0,
    message: `claiming ${(gross / LAMPORTS_PER_SOL).toFixed(6)} SOL, ${(net / LAMPORTS_PER_SOL).toFixed(6)} net of fees`,
  });
}

/**
 * The arming sentence, byte for byte — the same shape the sniper's uses, and for the same
 * reason: an acknowledgement that does not contain the wallet cannot prove the operator knew
 * which wallet they were arming.
 */
export function feeArmSentence({ creator, wallet }) {
  return `I acknowledge Claude Co claims creator fees for ${creator} into ${wallet}`;
}

/**
 * The lane.
 *
 * Every outside thing is a port: the vault read, the submitter, the sentinel, the clock and
 * the book. Nothing here opens a connection, and a test drives every outcome — an unreadable
 * vault, a claim that lands, a claim the chain rejects, a book that cannot be written — with
 * no network and no keypair.
 */
export function createFeeLane({
  creator = null,
  wallet = null,
  cfg = {},
  readClaimable = null,
  submit = null,
  control = () => ({ hardStop: false }),
  book = null,
  clock = () => Date.now(),
  log = () => {},
  liveAck = null,
} = {}) {
  const conf = Object.freeze({ ...FEE_LANE_DEFAULTS, ...cfg });
  if (typeof readClaimable !== "function")
    throw new FeeLaneError("readers_missing", "createFeeLane needs readClaimable(): the vault read is injected, never built here");
  if (conf.live === true) {
    if (typeof submit !== "function")
      throw new FeeLaneError("submit_missing", "a live fee lane needs submit(): without it there is nothing to sign with");
    if (typeof creator !== "string" || !creator)
      throw new FeeLaneError("creator_missing", "a live fee lane needs the creator wallet whose vaults it claims");
    if (typeof wallet !== "string" || !wallet)
      throw new FeeLaneError("wallet_missing", "a live fee lane needs the wallet the fees land in");
    const expected = feeArmSentence({ creator, wallet });
    if (String(liveAck ?? "") !== expected)
      throw new FeeLaneError("arming_refused",
        `arming the fee lane needs the owner's typed acknowledgement for this wallet.\n\n    ${expected}\n`,
        { creator, wallet });
  }

  const counters = { passes: 0, claimed: 0, skipped: 0, failed: 0, lamportsClaimed: 0, bookErrors: 0 };
  /* WHAT IS SITTING IN THE VAULTS, as of the last read that could say. This is not revenue and
     never becomes revenue by being reported: nothing is revenue until a claim lands, and on
     this desk the claim is the owner's, signed at /fees.html. It is carried so the page can say
     "this much is waiting" instead of showing the dry lane's permanent zero of claims as if it
     were a measurement of income. */
  const lastRead = { grossLamports: null, netLamports: null, atMs: null };
  const bySkipClause = {};
  for (const c of SKIP_CLAUSES) bySkipClause[c] = 0;

  /** Write one row. A book that throws costs a row in a report, never a decision — the same
   *  rule createSnipeShadow applies to its sink. */
  const record = (row) => {
    const full = Object.freeze({ laneVersion: FEE_LANE_VERSION, atMs: clock(), ...row });
    if (typeof book === "function") { try { book(full); } catch { counters.bookErrors++; } }
    return full;
  };

  return {
    version: FEE_LANE_VERSION,
    intervalMs: conf.intervalMs,
    config: conf,
    creator, wallet,

    /** One pass. Never throws: a fee lane that dies takes the revenue line with it. */
    async tick() {
      counters.passes++;
      let sentinels = { hardStop: false };
      try { sentinels = control() ?? { hardStop: false }; } catch { sentinels = { hardStop: true }; }

      let claimable = null, readError = null;
      if (typeof creator === "string" && creator) {
        try { claimable = await readClaimable(creator); }
        catch (error) { readError = String(error?.message ?? error).slice(0, 200); }
      }
      const decision = feeClaimDecision({
        claimable: claimable ?? (creator ? { creator, readable: false } : null),
        cfg: conf, hardStop: sentinels.hardStop === true,
      });
      if (decision.grossLamports !== null && decision.grossLamports !== undefined) {
        lastRead.grossLamports = decision.grossLamports;
        lastRead.netLamports = decision.netLamports;
        lastRead.atMs = clock();
      }

      if (!decision.claim) {
        counters.skipped++;
        bySkipClause[decision.clause] = (bySkipClause[decision.clause] ?? 0) + 1;
        /* `claim_would_have` is its own kind, not a skip dressed up as one: a dry lane that
           decided to claim is the row an operator reads before arming, and folding it in with
           "nothing there" would hide exactly the evidence arming should rest on. */
        const kind = decision.clause === "not_live" ? "claim_would_have" : "claim_skipped";
        if (decision.clause === "not_live" || decision.clause === "unreadable")
          log(`fee lane: ${decision.message}${readError ? ` (${readError})` : ""}`);
        return record({ kind, clause: decision.clause, decision, readError, creator });
      }

      let result = null, error = null;
      try { result = await submit({ creator, wallet, decision }); }
      catch (e) { error = String(e?.message ?? e).slice(0, 300); }

      if (error !== null || result?.ok !== true) {
        counters.failed++;
        const detail = error ?? String(result?.error ?? "the submitter reported no success and no error");
        log(`fee lane: CLAIM FAILED — ${detail}; nothing is booked and the next pass retries`);
        return record({ kind: "claim_failed", clause: null, decision, error: detail, creator });
      }

      /* WHAT LANDED, NOT WHAT WAS EXPECTED. The submitter reports the lamports the wallet
         actually gained; the decision's estimate is kept beside it so the two can be compared
         rather than confused. A submitter that cannot say is booked as unknown, never as the
         estimate — booking an estimate as revenue is how a revenue line starts drifting. */
      const landed = lamports(result.lamports);
      if (landed !== null) counters.lamportsClaimed += landed;
      counters.claimed++;
      log(`fee lane: claimed ${landed === null ? "an unreported amount" : `${(landed / LAMPORTS_PER_SOL).toFixed(6)} SOL`}`
        + ` (signature ${result.signature ?? "unreported"})`);
      return record({
        kind: "claim_landed", clause: null, creator,
        /* THE REVENUE KIND. It is never a trade, and it is written to a book of its own —
           see the header on why that separation is physical rather than a flag. */
        revenueKind: "creator_fee",
        lamports: landed, estimatedLamports: decision.grossLamports,
        netEstimateLamports: decision.netLamports,
        signature: result.signature ?? null, decision,
      });
    },

    stats() {
      return Object.freeze({
        laneVersion: FEE_LANE_VERSION, live: conf.live === true,
        creator, wallet, intervalMs: conf.intervalMs,
        ...counters, skippedBy: Object.freeze({ ...bySkipClause }),
        solClaimed: counters.lamportsClaimed / LAMPORTS_PER_SOL,
        claimableSol: lastRead.grossLamports === null ? null : lastRead.grossLamports / LAMPORTS_PER_SOL,
        claimableNetSol: lastRead.netLamports === null ? null : lastRead.netLamports / LAMPORTS_PER_SOL,
        claimableAtMs: lastRead.atMs,
      });
    },
  };
}

/**
 * The two figures, side by side — and deliberately never their sum.
 *
 * `feeRows` are this lane's own book; `tradingSol` is whatever the trading journal says. The
 * return has no `total`, no `pnl` and no `net`, because the moment one exists somebody will
 * print it and a bot that loses money on every round trip will look profitable. Their system
 * has that number. This one does not.
 */
export function feeSummary({ feeRows = [], tradingSol = null } = {}) {
  const rows = Array.isArray(feeRows) ? feeRows.filter(isPlainObject) : [];
  let landedLamports = 0, landed = 0, unreported = 0, wouldHave = 0, wouldHaveLamports = 0, failed = 0;
  for (const r of rows) {
    if (r.kind === "claim_landed") {
      landed++;
      const l = lamports(r.lamports);
      if (l === null) unreported++; else landedLamports += l;
    } else if (r.kind === "claim_would_have") {
      wouldHave++;
      wouldHaveLamports += lamports(r.decision?.grossLamports) ?? 0;
    } else if (r.kind === "claim_failed") failed++;
  }
  /* `Number(null)` IS 0 — for the third time in this subsystem, and in the one function whose
     entire job is to stop a fee line flattering a losing strategy. Written as
     `Number.isFinite(Number(tradingSol))` first, this reported an UNKNOWN trading result as a
     tidy 0.000 SOL, so a report showing 14.515 in fees beside it would have read as "the
     trading costs nothing" — the same lie their +15.6 tells, arrived at by a different route.
     The absent check comes first and explicitly, every time. */
  const trading = tradingSol === null || tradingSol === undefined || tradingSol === ""
    ? null
    : (Number.isFinite(Number(tradingSol)) ? Number(tradingSol) : null);
  return Object.freeze({
    /* REVENUE. */
    feeSol: landedLamports / LAMPORTS_PER_SOL,
    feeClaims: landed,
    /* A claim whose amount the submitter could not report is COUNTED, so `feeSol` can never
       quietly be a subset of what actually arrived while looking like all of it. */
    claimsWithUnreportedAmount: unreported,
    feeSolComplete: unreported === 0,
    /* What a dry lane would have taken — the number an operator reads before arming. */
    wouldHaveClaims: wouldHave,
    wouldHaveSol: wouldHaveLamports / LAMPORTS_PER_SOL,
    failedClaims: failed,
    /* TRADING, separately and by name. */
    tradingSol: trading,
    /* And the sentence that goes with them, so a report cannot present one as the other. */
    note: "fee revenue and trading result are reported separately and never summed: a fee line "
      + "that flatters a losing strategy is how a losing strategy survives contact with its owner",
  });
}
