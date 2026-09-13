import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* The ceiling the poller enforces on MAX_OPEN_POSITIONS. Kept in step with
   LIVE_LIMITS.maxOpenPositions in poller.mjs — a sentinel, not an exposure cap. */
const MAX_OPEN_POSITION_SENTINEL = 24;

const POSITION_FLAGS = ["callIdentityIncomplete", "accountingIncomplete", "balanceReconciliationRequired",
  "riskDataUnavailable", "exitExecutionRequired", "manualExitRequired"];

/* THE CAP BOUNDS THE HEARTBEAT WILL VOUCH FOR — the operator maxima, and nothing lower.
   These were the 0.05 / 0.5 / 0.15 canary ceilings from the first live install, left
   behind when the operator maxima were raised everywhere else. Any bot armed above the
   canary (0.4 SOL per trade, as the owner's was) had its caps NULLED here and its state
   forced to "degraded" on every pulse: a healthy, trading bot told the desk it was
   degraded and declared no caps at all, and the board said so. The parity test now holds
   this copy equal to poller.mjs OPERATOR_MAX, so the heartbeat cannot fall behind the
   ceiling it reports against again. */
export const HEARTBEAT_CAP_BOUNDS = Object.freeze({ maxSolPerTrade: 1, dailySolCap: 1000, dailyLossLimitSol: 0.4 });

const TRADING_RUNTIME_FILES = Object.freeze([
  "poller.mjs", "journal.mjs", "jupiter.mjs", "network-fee-budget.mjs",
  /* THE LAUNCH LANE. Dynamically imported by poller.mjs behind SNIPE_LANE, so inert on an
     install that never sets it — but "the trading process can load it" is exactly the test
     for whether a file belongs in the fingerprint. A module that can execute in this
     process and is not fingerprinted is a module that can be swapped without the heartbeat
     noticing. Since 2026-09-12 the poller builds the lane's feed (snipe-feed.mjs) and, on
     an armed install, its signing path (snipe-execute.mjs) — the one sniper file that
     holds a key, which is the last file whose bytes may change unnoticed — so both are
     here. This list must match what is loaded EXACTLY, in both directions. */
  "snipe-lane.mjs", "snipe-venue.mjs", "snipe-venue-pumpfun.mjs", "snipe-curve.mjs",
  "snipe-entry.mjs", "snipe-book.mjs", "snipe-shadow.mjs", "snipe-policy.mjs",
  "snipe-feed.mjs", "snipe-execute.mjs",
 "balance-verification.mjs",
  "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs", "sol-usd-oracle.mjs",
  "heartbeat-health.mjs", "sleep-assertion.mjs", "strategy.mjs", "trade-policy.mjs",
  // desk-led-v4: both are loaded by the trading process, so both are part of its identity.
  "dexscreener-consensus.mjs", "desk-mirror.mjs",
  /* token2022.mjs was missing from this list while poller.mjs:22 and jupiter.mjs:37 both
     import it — so a fingerprint documented as "exactly the modules loaded by the trading
     process" covered 14 of the 15 it loads, and the one it missed is the module that
     decides whether a Token-2022 mint can tax, block or freeze the holder. Its bytes
     could change without changing the identity this heartbeat reports. The list is
     derived from poller.mjs's transitive imports by test-executor-publish.mjs now, so it
     cannot silently fall behind the import graph again. */
  "token2022.mjs",
  /* The entry contract — one definition of "tradeable" for the desk and the bot. It
     decides whether a published call is enterable at all, so its bytes are as much a
     part of what this process IS as the stop policy's are. */
  "entry-contract.mjs",
  /* The route-sizing ladder is a runtime import of poller.mjs and decides the AMOUNT
     that gets signed, so its bytes are part of what this process IS. */
  "entry-sizing.mjs",
]);

/** A byte identity for exactly the modules loaded by the trading process. */
export function executorRuntimeFingerprint(executorDir) {
  const dir = path.resolve(executorDir);
  const hash = crypto.createHash("sha256");
  for (const name of TRADING_RUNTIME_FILES) {
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { return null; }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    hash.update(name).update("\0").update(fs.readFileSync(file));
  }
  return hash.digest("hex").slice(0, 32);
}

/** Build the bounded, non-secret health facts sent after a completed poll cycle. */
export function executorHeartbeatHealth({
  entriesPaused = false, hardStop = false, blockingIntent = false, positions = [],
  /* THE TENANT'S OFF SWITCH, AS THIS PROCESS SEES IT. `deskEntriesEnabled` is the flag
     this bot last read out of the feed's rules block — null until it has read one, which
     is why the desk's page can only ever say "pending" before the first poll. It is
     echoed rather than obeyed silently: the page shows what the BOT says, never what the
     server asked for, because a bot that is asleep has agreed to nothing. */
  deskEntriesEnabled = null,
  /* How the bot decides whether to buy: "risk" (the rails decide) or "take-every-call"
     (the owner's instruction; the edge rails are advisory). Reported so the board says
     which bot it is looking at. */
  entryMode = "risk",
  lastTickCompletedAt = 0, lastFeedSuccessAt = 0, consecutiveFeedFailures = 0,
  consecutiveTickFailures = 0, feedRollback = false, executionReadiness = null,
  caps = null, runtimeCommit = null, runtimeFingerprint = null,
  deskUnreachableSince = null, mirrorActive = false,
} = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const blockedPositions = list.filter((position) =>
    POSITION_FLAGS.some((flag) => position?.[flag] === true)).length;
  const manualAction = list.some((position) => position?.manualExitRequired === true);
  const exitBlocked = list.some((position) => position?.exitExecutionRequired === true);
  /* desk-led-v4: an unreadable executable mark is a HEALTH fact, never a sell. It is
     counted here so the floor's card can say "valuation blind on N" instead of the bot
     quietly selling, which is what the old latch did (TOAD, 2026-09-04). */
  const markUnavailable = list.filter((position) => Number(position?.markUnavailableSince) > 0).length;
  const unreachableSince = Number.isSafeInteger(Number(deskUnreachableSince)) && Number(deskUnreachableSince) > 0
    ? Number(deskUnreachableSince) : 0;
  let state = "healthy";
  if (hardStop || manualAction) state = "manual-action";
  else if (exitBlocked) state = "exits-blocked";
  else if (blockingIntent || blockedPositions || consecutiveFeedFailures || consecutiveTickFailures ||
      feedRollback || executionReadiness?.ready === false || mirrorActive === true || unreachableSince)
    state = "degraded";
  else if (entriesPaused) state = "entries-paused";
  const boundedCap = (value, max) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0.000001 && number <= max ? number : null;
  };
  const publicCaps = caps && typeof caps === "object" ? {
    maxSolPerTrade: boundedCap(caps.maxSolPerTrade, HEARTBEAT_CAP_BOUNDS.maxSolPerTrade),
    dailySolCap: boundedCap(caps.dailySolCap, HEARTBEAT_CAP_BOUNDS.dailySolCap),
    dailyLossLimitSol: boundedCap(caps.dailyLossLimitSol, HEARTBEAT_CAP_BOUNDS.dailyLossLimitSol),
    /* The open-position figure is a SENTINEL, not an exposure cap: risk decides how many
       memecoins run at once (book heat, the per-name cap, the daily deploy cap and the
       wallet all bind before it). This bound was 4 and the sentinel moved to 24, so a
       perfectly healthy bot reported itself DEGRADED — the cap read as invalid, and
       nothing about the money had changed. The three figures below it are the real
       exposure caps and their bounds are unchanged. */
    maxOpenPositions: Number.isInteger(Number(caps.maxOpenPositions)) &&
      Number(caps.maxOpenPositions) >= 1 && Number(caps.maxOpenPositions) <= MAX_OPEN_POSITION_SENTINEL
      ? Number(caps.maxOpenPositions) : null,
  } : null;
  const capsValid = publicCaps && Object.values(publicCaps).every((value) => value != null) &&
    publicCaps.dailySolCap >= publicCaps.maxSolPerTrade;
  if (caps != null && !capsValid && (state === "healthy" || state === "entries-paused"))
    state = "degraded";
  /* THE EFFECTIVE ANSWER TO "WILL YOU OPEN A NEW POSITION?", derived from all three
     switches at once so no screen has to re-implement the precedence and get it wrong.
     The two LOCAL sentinels are ORed in independently of the desk flag, which is what
     makes a server "on" powerless: it can only ever fail to block, never unblock. This
     is the switch state and not a promise to trade — the entry contract, the risk
     history, the book and the rails all still stand between this and a signature. */
  const deskFlag = deskEntriesEnabled === true ? true : deskEntriesEnabled === false ? false : null;
  const entriesEnabled = !entriesPaused && !hardStop && deskFlag !== false;
  return {
    state, entriesPaused: Boolean(entriesPaused), hardStop: Boolean(hardStop),
    entriesEnabled, deskEntriesEnabled: deskFlag,
    blockingIntent: Boolean(blockingIntent), blockedPositions, manualAction, exitBlocked,
    lastTickCompletedAt: Number(lastTickCompletedAt) || 0,
    lastFeedSuccessAt: Number(lastFeedSuccessAt) || 0,
    consecutiveFeedFailures: Math.max(0, Number(consecutiveFeedFailures) || 0),
    consecutiveTickFailures: Math.max(0, Number(consecutiveTickFailures) || 0),
    feedRollback: Boolean(feedRollback),
    // The desk-unreachability clock and whether the mirror has engaged. Facts about the
    // bot, no reins: the server learns it is being mirrored, it cannot switch it on or off.
    deskUnreachableSince: unreachableSince,
    mirrorActive: mirrorActive === true,
    entryMode: entryMode === "take-every-call" ? "take-every-call" : "risk",
    markUnavailable,
    executionReadiness: executionReadiness && typeof executionReadiness === "object" ? {
      ready: executionReadiness.ready === true,
      lastSuccessAt: Number(executionReadiness.lastSuccessAt) || 0,
      observedAt: Number(executionReadiness.observedAt) || 0,
      route: executionReadiness.route === "wsol-usdc" ? "wsol-usdc" : null,
      providers: Number(executionReadiness.providers) === 2 ? 2 : 0,
      amountLamports: Number.isSafeInteger(Number(executionReadiness.amountLamports)) &&
        Number(executionReadiness.amountLamports) >= 1 &&
        Number(executionReadiness.amountLamports) <= 50_000_000
        ? Number(executionReadiness.amountLamports) : 0,
      // Why it is not ready, in the bot's own words. Bounded and free of secrets: it is
      // an error message about a route and a balance, and without it the dashboard can
      // only show 0/2 and leave the operator guessing.
      lastError: typeof executionReadiness.lastError === "string"
        ? executionReadiness.lastError.slice(0, 300) : null,
    } : null,
    caps: capsValid ? publicCaps : null,
    runtimeCommit: /^[0-9a-f]{7,40}$/i.test(String(runtimeCommit || ""))
      ? String(runtimeCommit).slice(0, 40).toLowerCase() : null,
    runtimeFingerprint: /^[0-9a-f]{32}$/i.test(String(runtimeFingerprint || ""))
      ? String(runtimeFingerprint).toLowerCase() : null,
  };
}
