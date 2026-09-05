/**
 * Independent SOL/USD reference for WALL-ST-E.
 *
 * Jupiter is the transaction counterparty, so a Jupiter SOL/USDC quote cannot also
 * be the independent USD anchor used to decide whether Jupiter's token quote is
 * fair. This module reads Pyth's sponsored SOL/USD shard-0 account through both
 * operator-supplied Solana RPC providers and fails closed unless both views are
 * authentic, fresh and mutually consistent.
 *
 * Pinned from Pyth's official Solana push-feed table (2026-09-01):
 * https://docs.pyth.network/price-feeds/core/push-feeds/solana
 */
import { PublicKey } from "@solana/web3.js";

// This is an HTTP-transport ceiling, not a finality/recovery deadline. Every RPC
// request must either return or have its underlying fetch aborted within four
// seconds. More restrictive, operation-specific fences remain in force.
export const SOLANA_RPC_HTTP_REQUEST_TIMEOUT_MS = 4_000;

/** Build the only fetch transport used by executor and monitor Solana Connections.
 *
 * Promise.race can release a caller while leaving its socket/request alive. This
 * wrapper instead owns an AbortController for every HTTP attempt and does not settle
 * its promise until the underlying fetch observes success, failure, or cancellation.
 * An upstream signal is preserved, timers/listeners are always released, and thrown
 * non-Errors are normalized because web3.js otherwise leaves its callback pending.
 */
export function createSolanaRpcDeadlineFetch({
  fetchFn = globalThis.fetch,
  requestTimeoutMs = SOLANA_RPC_HTTP_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchFn !== "function")
    throw new Error("Solana RPC HTTP fetch implementation is unavailable");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      requestTimeoutMs > SOLANA_RPC_HTTP_REQUEST_TIMEOUT_MS)
    throw new Error("Solana RPC HTTP request timeout is invalid");

  return async function solanaRpcDeadlineFetch(input, init = {}) {
    const upstream = init?.signal;
    if (upstream != null && (typeof upstream.addEventListener !== "function" ||
        typeof upstream.removeEventListener !== "function"))
      throw new Error("Solana RPC HTTP request signal is invalid");
    if (upstream?.aborted)
      throw new Error("Solana RPC HTTP request was aborted before dispatch");

    const controller = new AbortController();
    let timeoutError = null;
    let upstreamAborted = false;
    const abortFromUpstream = () => {
      upstreamAborted = true;
      controller.abort(upstream.reason);
    };
    upstream?.addEventListener("abort", abortFromUpstream, { once: true });
    const timer = setTimeout(() => {
      timeoutError = new Error(
        `Solana RPC HTTP request timed out after ${requestTimeoutMs}ms`,
      );
      timeoutError.code = "SOLANA_RPC_HTTP_TIMEOUT";
      controller.abort(timeoutError);
    }, requestTimeoutMs);

    try {
      const response = await fetchFn(input, { ...init, signal: controller.signal });
      if (!response || typeof response.arrayBuffer !== "function" ||
          !Number.isInteger(response.status))
        throw new Error("Solana RPC HTTP transport returned an invalid response");
      // Fetch resolves after response headers, before the JSON body is necessarily
      // complete. Buffer it while this controller is still armed; otherwise a peer
      // can send headers and leave web3.js's later response.text() hung forever.
      const bytes = await response.arrayBuffer();
      return new Response(bytes.byteLength ? bytes : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (timeoutError) throw timeoutError;
      if (upstreamAborted || controller.signal.aborted)
        throw new Error("Solana RPC HTTP request was aborted");
      if (error instanceof Error) throw error;
      throw new Error("Solana RPC HTTP transport failed");
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", abortFromUpstream);
    }
  };
}

/** A fresh config creates a fresh transport controller domain for each provider.
 * Hidden web3.js 429 retries are disabled: the executor's explicit fail-closed and
 * recovery loops retain authority over retries instead of an invisible HTTP queue.
 */
export function solanaRpcConnectionConfig(options = {}) {
  return {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: createSolanaRpcDeadlineFetch(options),
  };
}

export const PYTH_SOL_USD_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const PYTH_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_SOL_USD_CACHE_SOURCE = "pyth-sol-usd-shard0-v1";

// Anchor sha256("account:PriceUpdateV2")[0..8]. Pinning it prevents a different
// Receiver account type with coincidentally similar bytes from being interpreted.
const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from("22f123639d7ef4cd", "hex");
const FEED_ID = Buffer.from(PYTH_SOL_USD_FEED_ID, "hex");
const ACCOUNT = new PublicKey(PYTH_SOL_USD_ACCOUNT);

export const SOL_USD_ORACLE_POLICY = Object.freeze({
  // Pyth sponsors this feed at a one-minute heartbeat. Three minutes tolerates one
  // missed push without accepting an indefinitely stale absolute-price anchor.
  maxAgeMs: 180_000,
  maxFutureSkewMs: 60_000,
  maxConfidencePct: 2,
  maxProviderDivergencePct: 1,
  maxPublishGapMs: 120_000,
});

/**
 * Recover a previously agreed Pyth observation without allowing the local write
 * time to launder an already-old oracle update. The immutable publish time is the
 * staleness authority; `observedAt` only proves the cache was not written in the
 * future after a local clock correction.
 */
export function usableSolUsdCache(cache, {
  nowMs = Date.now(), maxAgeMs,
} = {}) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache) ||
      cache.source !== PYTH_SOL_USD_CACHE_SOURCE) return null;
  const price = Number(cache.v);
  const observedAt = Number(cache.ts);
  const publishTime = Number(cache.publishTime);
  const ageCap = Number(maxAgeMs);
  const now = Number(nowMs);
  if (!Number.isFinite(price) || price <= 0 ||
      !Number.isSafeInteger(observedAt) || observedAt <= 0 ||
      !Number.isSafeInteger(publishTime) || publishTime <= 0 ||
      !Number.isFinite(ageCap) || ageCap <= 0 ||
      !Number.isFinite(now) || now <= 0) return null;
  const observedAgeMs = now - observedAt;
  const publishAgeMs = now - publishTime * 1_000;
  if (observedAgeMs < 0 || publishAgeMs < 0 ||
      observedAgeMs > ageCap || publishAgeMs > ageCap) return null;
  return { price, publishTime, observedAt, publishAgeMs };
}

const owner = (account) => account?.owner?.toBase58?.() || String(account?.owner || "");
const data = (account) => {
  if (Buffer.isBuffer(account?.data) || account?.data instanceof Uint8Array)
    return Buffer.from(account.data);
  if (Array.isArray(account?.data) && account.data[1] === "base64")
    return Buffer.from(account.data[0], "base64");
  throw new Error("Pyth SOL/USD account has an unsupported RPC encoding");
};
const safeInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Pyth SOL/USD ${label} is outside the safe integer range`);
  return number;
};

/** Decode and validate one fully-verified PriceUpdateV2 account view. */
export function parsePythSolUsdAccount(account, {
  nowMs = Date.now(), policy = SOL_USD_ORACLE_POLICY,
} = {}) {
  if (!account) throw new Error("Pyth SOL/USD account is unavailable");
  if (owner(account) !== PYTH_RECEIVER_PROGRAM)
    throw new Error("Pyth SOL/USD account has the wrong owner");
  const bytes = data(account);
  // PriceUpdateV2 allocates the maximum enum size (134 bytes). Full verification
  // serializes as the one-byte Borsh variant at byte 40, leaving one zero pad byte.
  if (bytes.length !== 134) throw new Error(`Pyth SOL/USD account has unexpected length ${bytes.length}`);
  if (!bytes.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR))
    throw new Error("Pyth SOL/USD account discriminator is invalid");
  if (bytes[40] !== 1) throw new Error("Pyth SOL/USD update is not fully verified");
  if (!bytes.subarray(41, 73).equals(FEED_ID))
    throw new Error("Pyth SOL/USD account contains the wrong feed id");
  if (bytes[133] !== 0) throw new Error("Pyth SOL/USD account has non-zero trailing data");

  const rawPrice = bytes.readBigInt64LE(73);
  const rawConfidence = bytes.readBigUInt64LE(81);
  const exponent = bytes.readInt32LE(89);
  const publishTime = safeInteger(bytes.readBigInt64LE(93), "publish time");
  const postedSlot = safeInteger(bytes.readBigUInt64LE(125), "posted slot");
  if (rawPrice <= 0n) throw new Error("Pyth SOL/USD price is not positive");
  if (!Number.isInteger(exponent) || exponent < -18 || exponent > 18)
    throw new Error(`Pyth SOL/USD exponent ${exponent} is outside the accepted range`);
  const price = Number(rawPrice) * (10 ** exponent);
  const confidencePct = Number(rawConfidence) / Number(rawPrice) * 100;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Pyth SOL/USD decoded price is invalid");
  if (!Number.isFinite(confidencePct) || confidencePct < 0 ||
      confidencePct > Number(policy.maxConfidencePct))
    throw new Error(`Pyth SOL/USD confidence width ${confidencePct.toFixed(4)}% exceeds ` +
      `${policy.maxConfidencePct}%`);

  const observedAt = Number(nowMs);
  const publishedAt = publishTime * 1_000;
  const ageMs = observedAt - publishedAt;
  if (!Number.isFinite(observedAt) || observedAt <= 0 || ageMs < -Number(policy.maxFutureSkewMs))
    throw new Error("Pyth SOL/USD publish time is too far in the future");
  if (ageMs > Number(policy.maxAgeMs))
    throw new Error(`Pyth SOL/USD update is stale (${Math.round(ageMs / 1_000)}s old)`);
  return { price, confidencePct, publishTime, postedSlot, observedAt };
}

/**
 * Require two independent RPC views. The providers may be one push apart, so exact
 * bytes need not match; both signed updates must independently pass validation and
 * their prices/timestamps must agree within immutable canary bounds.
 */
export async function independentSolUsdPrice(primaryConnection, secondaryConnection, {
  nowMs = Date.now(), policy = SOL_USD_ORACLE_POLICY,
} = {}) {
  if (!primaryConnection || !secondaryConnection || primaryConnection === secondaryConnection)
    throw new Error("independent SOL/USD oracle requires two distinct RPC connections");
  const reads = await Promise.allSettled([
    primaryConnection.getAccountInfo(ACCOUNT, "confirmed"),
    secondaryConnection.getAccountInfo(ACCOUNT, "confirmed"),
  ]);
  if (reads[0].status !== "fulfilled" || reads[1].status !== "fulfilled")
    throw new Error("independent SOL/USD oracle requires successful reads from both RPC providers");

  let primary, secondary;
  try {
    primary = parsePythSolUsdAccount(reads[0].value, { nowMs, policy });
    secondary = parsePythSolUsdAccount(reads[1].value, { nowMs, policy });
  } catch (error) {
    throw new Error(`independent SOL/USD oracle rejected an RPC view: ${error.message}`);
  }
  const low = Math.min(primary.price, secondary.price);
  const high = Math.max(primary.price, secondary.price);
  const divergencePct = low > 0 ? (high / low - 1) * 100 : Infinity;
  if (!Number.isFinite(divergencePct) || divergencePct > Number(policy.maxProviderDivergencePct))
    throw new Error(`independent SOL/USD RPC views diverge by ${divergencePct.toFixed(4)}% ` +
      `(cap ${policy.maxProviderDivergencePct}%)`);
  const publishGapMs = Math.abs(primary.publishTime - secondary.publishTime) * 1_000;
  if (publishGapMs > Number(policy.maxPublishGapMs))
    throw new Error(`independent SOL/USD RPC views are ${Math.round(publishGapMs / 1_000)}s apart`);

  return {
    price: (primary.price + secondary.price) / 2,
    observedAt: Number(nowMs),
    publishTime: Math.min(primary.publishTime, secondary.publishTime),
    confidencePct: Math.max(primary.confidencePct, secondary.confidencePct),
    divergencePct,
    source: PYTH_SOL_USD_CACHE_SOURCE,
  };
}
