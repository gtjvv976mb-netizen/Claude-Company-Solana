import { trackedBalanceDecision } from "./journal.mjs";

const rawBalance = (value, label) => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(text);
};

const rpcError = (error) => {
  const message = String(error?.message || error || "unknown RPC error");
  // Provider URLs commonly carry credentials in their path or query string. Keep the
  // useful error text without ever copying such a URL into the durable position or log.
  return message.replace(/https?:\/\/[^\s)]+/gi, "[redacted RPC endpoint]").slice(0, 240);
};

/** Marks a transport/provider failure as eligible for the independent RPC lane.
 * Canonical-account validation failures deliberately do not use this class: they are
 * safety evidence, not ordinary provider unavailability, and must fail closed. */
export class RpcBalanceUnavailableError extends Error {
  constructor(error) {
    super(rpcError(error));
    this.name = "RpcBalanceUnavailableError";
    this.cause = error;
  }
}

/**
 * Verify that the wallet still has at least the executor's durable tracked quantity.
 *
 * The primary remains authoritative while it is healthy. The secondary is consulted
 * only when the primary cannot answer or reports less than the journal. A healthy
 * secondary may stand in for an unavailable primary, but two failures, an under-read,
 * or conflicting reads all fail closed; none of those states authorizes a partial exit.
 */
export async function verifyTrackedBalanceWithFailover({
  trackedRaw,
  readPrimary,
  readSecondary = null,
}) {
  let tracked;
  try { tracked = rawBalance(trackedRaw, "tracked balance"); }
  catch (error) {
    return { verified: false, reason: error.message,
      trackedRaw: String(trackedRaw ?? ""), primaryRaw: null, secondaryRaw: null };
  }
  if (tracked <= 0n) return { verified: false, reason: "durable tracked balance is invalid",
    trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null };
  if (typeof readPrimary !== "function") return {
    verified: false,
    reason: "primary canonical-ATA balance reader is unavailable",
    trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null,
  };

  let primaryValue;
  try { primaryValue = await readPrimary(); }
  catch (primaryFailure) {
    const primaryError = rpcError(primaryFailure);
    if (!(primaryFailure instanceof RpcBalanceUnavailableError)) return {
      verified: false,
      reason: `primary canonical-ATA validation failed: ${primaryError}`,
      trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null,
    };
    if (typeof readSecondary !== "function") return {
      verified: false,
      reason: `primary canonical-ATA balance unavailable: ${primaryError}; secondary balance unavailable`,
      trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null,
    };

    let secondary;
    try { secondary = rawBalance(await readSecondary(), "secondary balance"); }
    catch (secondaryFailure) {
      const secondaryError = rpcError(secondaryFailure);
      return {
        verified: false,
        reason: `both canonical-ATA balance reads are unavailable: primary ${primaryError}; secondary ${secondaryError}`,
        trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null,
      };
    }

    if (secondary >= tracked) return {
      verified: true,
      amountRaw: tracked.toString(),
      source: "secondary",
      primaryRaw: null,
      secondaryRaw: secondary.toString(),
    };
    return {
      verified: false,
      reason: `primary canonical-ATA balance unavailable: ${primaryError}; secondary RPC reports ${secondary} below tracked ${tracked}`,
      trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: secondary.toString(),
    };
  }

  let primary;
  try { primary = rawBalance(primaryValue, "primary balance"); }
  catch (error) {
    return {
      verified: false,
      reason: `primary canonical-ATA validation failed: ${rpcError(error)}`,
      trackedRaw: tracked.toString(), primaryRaw: null, secondaryRaw: null,
    };
  }

  if (primary >= tracked) return {
    ...trackedBalanceDecision({ trackedRaw: tracked.toString(), primaryRaw: primary.toString() }),
    source: "primary",
    primaryRaw: primary.toString(),
    secondaryRaw: null,
  };

  let secondary = null;
  let secondaryError = null;
  if (typeof readSecondary === "function") {
    try { secondary = rawBalance(await readSecondary(), "secondary balance"); }
    catch (error) { secondaryError = rpcError(error); }
  }
  const decision = trackedBalanceDecision({
    trackedRaw: tracked.toString(),
    primaryRaw: primary.toString(),
    secondaryRaw: secondary?.toString() ?? null,
  });
  if (secondaryError) {
    decision.reason = `${decision.reason}: ${secondaryError}`;
  }
  return decision;
}
