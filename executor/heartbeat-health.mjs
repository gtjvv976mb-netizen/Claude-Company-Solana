import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* The ceiling the poller enforces on MAX_OPEN_POSITIONS. Kept in step with
   LIVE_LIMITS.maxOpenPositions in poller.mjs — a sentinel, not an exposure cap. */
const MAX_OPEN_POSITION_SENTINEL = 24;

const POSITION_FLAGS = ["callIdentityIncomplete", "accountingIncomplete", "balanceReconciliationRequired",
  "riskDataUnavailable", "exitExecutionRequired", "manualExitRequired"];

const TRADING_RUNTIME_FILES = Object.freeze([
  "poller.mjs", "journal.mjs", "jupiter.mjs", "balance-verification.mjs",
  "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs", "sol-usd-oracle.mjs",
  "heartbeat-health.mjs", "sleep-assertion.mjs", "strategy.mjs", "trade-policy.mjs",
  // desk-led-v4: both are loaded by the trading process, so both are part of its identity.
  "dexscreener-consensus.mjs", "desk-mirror.mjs",
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
    maxSolPerTrade: boundedCap(caps.maxSolPerTrade, 0.05),
    dailySolCap: boundedCap(caps.dailySolCap, 0.5),
    dailyLossLimitSol: boundedCap(caps.dailyLossLimitSol, 0.15),
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
  return {
    state, entriesPaused: Boolean(entriesPaused), hardStop: Boolean(hardStop),
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
