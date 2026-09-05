import { PYTH_SOL_USD_CACHE_SOURCE, SOL_USD_ORACLE_POLICY } from "./sol-usd-oracle.mjs";

const raw = (value, label) => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw new Error(`${label} must be a positive integer`);
  return BigInt(text);
};
const finitePositive = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive and finite`);
  return number;
};

/**
 * Bind the last executable Jupiter order to the independently monitored entry mark.
 *
 * The preflight quote supplies raw-token units per lamport at the monitored mark.
 * Comparing that ratio with the final order needs no trusted token-decimal field:
 * token decimals cancel. Both quoted output and the transaction's min-output floor
 * must remain inside the authored entry thesis before any signature is created.
 */
export function validateExecutableEntryOrder(intent, order, {
  nowMs = Date.now(), maxEntryQuoteDriftPct = 5, maxEntryPreflightAgeMs = 60_000,
} = {}) {
  const verified = validateEntryPreflightContext(intent, {
    nowMs, maxEntryPreflightAgeMs, requireFresh: true,
  });
  if (!verified) return null;
  const {
    context, reference, preflight, event, anchoredMark, low, high, stop, target,
    observedAt, solUsd, tokenDecimals, solUsdPublishTime, solUsdConfidencePct,
    solUsdProviderDivergencePct,
  } = verified;

  const preIn = raw(preflight.inputAmountRaw, "preflight input");
  const preOut = raw(preflight.forwardOutputRaw, "preflight output");
  const finalIn = raw(order?.inAmount, "final order input");
  const quotedOut = raw(order?.outAmount, "final quoted output");
  const minimumOut = raw(order?.otherAmountThreshold, "final minimum output");
  if (minimumOut > quotedOut) throw new Error("final minimum output exceeds its quote");
  if (finalIn !== raw(intent.amountRaw, "entry intent input"))
    throw new Error("final order input does not match the entry intent");

  const tokenScale = 10 ** tokenDecimals;
  const impliedMark = (input, out, label) => {
    const sol = Number(input) / 1_000_000_000;
    const tokens = Number(out) / tokenScale;
    const mark = sol * solUsd / tokens;
    if (!Number.isFinite(mark) || mark <= 0) throw new Error(`${label} entry mark is invalid`);
    return mark;
  };
  // Prove the preliminary Jupiter rate agreed with the independently monitored
  // USD mark before using it for any final-order comparison. This closes the
  // circular check where a bad preflight quote defined its own idea of fair value.
  const preflightMark = impliedMark(preIn, preOut, "preflight");
  const quotedMark = impliedMark(finalIn, quotedOut, "quoted");
  const worstCaseMark = impliedMark(finalIn, minimumOut, "minimum-output");
  const driftPct = Math.max(
    Math.abs(preflightMark / anchoredMark - 1),
    Math.abs(quotedMark / anchoredMark - 1),
    Math.abs(worstCaseMark / anchoredMark - 1),
  ) * 100;
  const driftCap = Number(maxEntryQuoteDriftPct);
  if (!Number.isFinite(driftCap) || driftCap <= 0 || driftCap > 100)
    throw new Error("entry executable-quote drift cap is invalid");
  if (driftPct > driftCap)
    throw new Error(`final executable entry drift ${driftPct.toFixed(2)}% exceeds ${driftCap}% cap`);
  if (quotedMark < low || quotedMark > high || worstCaseMark > high)
    throw new Error(`final executable entry ${quotedMark.toPrecision(8)} ` +
      `(worst case ${worstCaseMark.toPrecision(8)}) is outside authored zone ${low}-${high}`);
  if (quotedMark <= stop)
    throw new Error(`final executable entry ${quotedMark.toPrecision(8)} has breached authored stop ${stop}`);
  if (target != null && worstCaseMark >= target)
    throw new Error(`final executable entry ${worstCaseMark.toPrecision(8)} has reached authored target ${target}`);
  return { preflightMark, quotedMark, worstCaseMark, driftPct, anchoredMark,
    solUsd, tokenDecimals, observedAt, solUsdPublishTime, solUsdConfidencePct,
    solUsdProviderDivergencePct };
}

/**
 * Validate the durable, independently sourced entry context without consulting a
 * Jupiter order. Recovery calls this before it can disclose an older signed
 * transaction, so a pre-upgrade entry can never bypass the Pyth/dual-RPC gate merely
 * because its transaction bytes already exist.
 *
 * `requireFresh:false` is reserved for accounting a fill that is already finalized.
 * It still proves that the oracle was fresh at observation time; it simply does not
 * demand that a historical fill remain younger than the live submission window.
 */
export function validateEntryPreflightContext(intent, {
  nowMs = Date.now(), maxEntryPreflightAgeMs = 60_000, requireFresh = true,
} = {}) {
  if (intent?.kind !== "entry") return null;
  const context = intent?.context;
  const reference = context?.entryReference;
  const preflight = context?.entryPreflight;
  const event = context?.event;
  if (!reference || !preflight || !event)
    throw new Error("entry intent is missing its durable market/preflight context");

  const anchoredMark = finitePositive(reference.marketMark, "entry monitored mark");
  const low = finitePositive(reference.entryLow, "entry-zone low");
  const high = finitePositive(reference.entryHigh, "entry-zone high");
  if (high < low) throw new Error("entry zone is inverted");
  const stop = finitePositive(event.stop, "authored stop");
  const target = event.target == null ? null : finitePositive(event.target, "authored target");
  const observedAt = Number(preflight.observedAt);
  const ageCap = Number(maxEntryPreflightAgeMs);
  if (!Number.isFinite(observedAt) || observedAt <= 0 || !Number.isFinite(ageCap) || ageCap <= 0)
    throw new Error("entry executable preflight has an invalid observation time or age cap");
  if (requireFresh) {
    const age = Number(nowMs) - observedAt;
    if (age < 0 || age > ageCap)
      throw new Error(`entry executable preflight is stale (${Math.max(0, Math.round(age))}ms; cap ${ageCap}ms)`);
  }

  const tokenDecimals = Number(preflight.tokenDecimals);
  if (preflight.tokenDecimals == null || !Number.isInteger(tokenDecimals) ||
      tokenDecimals < 0 || tokenDecimals > 18)
    throw new Error("entry preflight has no valid on-chain token decimals");
  const solUsd = finitePositive(preflight.solUsd, "entry SOL/USD");
  if (preflight.solUsdSource !== PYTH_SOL_USD_CACHE_SOURCE)
    throw new Error("entry SOL/USD did not come from the independent two-RPC Pyth oracle");
  const solUsdPublishTime = Number(preflight.solUsdPublishTime);
  const solUsdConfidencePct = Number(preflight.solUsdConfidencePct);
  const solUsdProviderDivergencePct = Number(preflight.solUsdProviderDivergencePct);
  // Bind provenance to the instant it was observed. A delayed recovery may account
  // an already-finalized fill, but it may never reinterpret a stale Pyth print as one
  // that was fresh when the order was built.
  const oracleAgeAtObservationMs = observedAt - solUsdPublishTime * 1_000;
  if (!Number.isSafeInteger(solUsdPublishTime) || solUsdPublishTime <= 0 ||
      oracleAgeAtObservationMs < -SOL_USD_ORACLE_POLICY.maxFutureSkewMs ||
      oracleAgeAtObservationMs > SOL_USD_ORACLE_POLICY.maxAgeMs)
    throw new Error("entry independent SOL/USD oracle observation is stale or invalid");
  if (!Number.isFinite(solUsdConfidencePct) || solUsdConfidencePct < 0 ||
      solUsdConfidencePct > SOL_USD_ORACLE_POLICY.maxConfidencePct)
    throw new Error("entry independent SOL/USD oracle confidence is invalid");
  if (!Number.isFinite(solUsdProviderDivergencePct) || solUsdProviderDivergencePct < 0 ||
      solUsdProviderDivergencePct > SOL_USD_ORACLE_POLICY.maxProviderDivergencePct)
    throw new Error("entry independent SOL/USD RPC consensus is invalid");
  return { context, reference, preflight, event, anchoredMark, low, high, stop, target,
    observedAt, solUsd, tokenDecimals, solUsdPublishTime, solUsdConfidencePct,
    solUsdProviderDivergencePct };
}
