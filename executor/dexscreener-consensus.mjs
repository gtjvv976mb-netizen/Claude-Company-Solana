/**
 * THE DESK'S RULER, CARRIED BY THE BOT.
 *
 * Shrek, call 55, 2026-09-05: the bot sold at 03:01:42Z on its own normalised stop at
 * -13.5%, measured on a chain-simulated Jupiter sell quote against its own fill; the
 * desk's determined stop_hit — measured on the DexScreener consensus mark against
 * entry_ref — came at 03:10:24Z. Same policy function, different ruler, different
 * moment. Under desk-led-v4 the bot has no exit ruler of its own. The one time it
 * prices a position for an exit decision is MIRROR mode, when the desk has been
 * unreachable for DESK_UNREACHABLE_MS, and then it must measure with the desk's own
 * instrument so the level and the moment are the ones the desk would have produced.
 *
 * This is a pure port of src/data/dexscreener.js pairsFor() + consensus(): same
 * algorithm, same tolerances, same weighted median. It is a separate file because the
 * executor is a standalone install that ships no src/ and has no dependencies; the
 * fetch helper is inlined rather than imported from src/lib/http.js for the same reason.
 * If consensus() changes on the desk, change it here in the same commit — the parity
 * test (executor/test-desk-led-exits.mjs) compares the two functions on shared fixtures.
 */
const BASE = "https://api.dexscreener.com";
const FETCH_TIMEOUT_MS = 8_000;

async function getJson(url, { timeoutMs = FETCH_TIMEOUT_MS, label } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url: label || url };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), url: label || url };
  } finally {
    clearTimeout(t);
  }
}

/** All pairs for a mint, richest first. pairs[0] from the API is NOT the deepest. */
export async function pairsFor(mint, { fetchJson = getJson } = {}) {
  /* Offline test seam, same flag the desk honours. A test that spawns the real poller
   * against a dead desk drives mirror mode, and mirror mode would otherwise reach the
   * public DexScreener API from inside a unit test. With the flag set the price lane
   * declines deterministically and the clock lane still runs — which is also the exact
   * behaviour when DexScreener itself is down. Never set in production. */
  if (process.env.DS_OFFLINE === "1") return { ok: false, error: "DS_OFFLINE test mode", pairs: [] };
  const r = await fetchJson(`${BASE}/latest/dex/tokens/${mint}`, { label: "dexscreener/tokens" });
  if (!r.ok || !r.data?.pairs?.length) return { ok: false, error: r.error || "no pairs", pairs: [] };
  const pairs = r.data.pairs
    .filter((p) => p.chainId === "solana")
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return { ok: true, pairs };
}

/**
 * Consensus pricing across a token's pools — byte-for-byte the desk's function.
 *
 * Drop zero-liquidity pools from the vote (a graduated pump.fun coin's dead bonding
 * curve is listed forever at the launch price with $0 behind it), take the top `sample`
 * by liquidity, anchor on the LIQUIDITY-WEIGHTED median priceUsd, keep pools within
 * `tolerancePct` of it, and report the kept depth. See src/data/dexscreener.js for the
 * RAY 5,000x incident that made the median the anchor in the first place.
 */
export function consensus(pairs, { sample = 8, tolerancePct = 25 } = {}) {
  const sol = (pairs || []).filter((p) => p.chainId === "solana" && Number(p.priceUsd) > 0);
  if (!sol.length) return { ok: false, error: "no priced solana pairs" };

  const funded = sol.filter((p) => Number(p.liquidity?.usd) > 0);
  const voters = funded.length ? funded : sol;
  const drained = sol.length - voters.length;

  const byLiq = [...voters].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = byLiq.slice(0, sample);

  const ranked = [...top].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));
  const weights = ranked.map((p) => Math.max(Number(p.liquidity?.usd) || 0, 0));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let median;
  if (totalWeight > 0) {
    let run = 0;
    median = Number(ranked.at(-1).priceUsd);
    for (let i = 0; i < ranked.length; i++) {
      run += weights[i];
      if (run >= totalWeight / 2) { median = Number(ranked[i].priceUsd); break; }
    }
  } else {
    const prices = ranked.map((p) => Number(p.priceUsd));
    median = prices.length % 2
      ? prices[(prices.length - 1) / 2]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  }

  const agrees = (p) => Math.abs(Number(p.priceUsd) - median) / median * 100 <= tolerancePct;
  const kept = byLiq.filter(agrees);
  const rejected = byLiq.filter((p) => !agrees(p))
    .map((p) => ({ dex: p.dexId, priceUsd: Number(p.priceUsd), reportedLiqUsd: p.liquidity?.usd ?? 0 }));

  if (!kept.length) return { ok: false, error: "no pool agrees with the median", median, rejected };

  const spreadPrices = kept.map((p) => Number(p.priceUsd)).sort((a, b) => a - b);
  return {
    ok: true,
    priceUsd: median,
    liquidityUsd: Number(kept.reduce((a, p) => a + (p.liquidity?.usd || 0), 0).toFixed(2)),
    deepest: kept[0],
    poolsUsed: kept.length,
    poolsRejected: rejected,
    drainedPoolsIgnored: drained,
    priceSpreadPct: spreadPrices.length > 1
      ? Number(((spreadPrices.at(-1) - spreadPrices[0]) / median * 100).toFixed(1)) : 0,
  };
}

/** One call for the mirror: the desk's consensus mark for a mint, or a decline.
 *  Never throws — an unreadable price is a null mark, and pricePolicy treats a null
 *  mark as "hold" while the clock lane keeps running. */
export async function consensusMark(mint, { fetchJson = getJson, now = () => Date.now() } = {}) {
  let pairs;
  try { pairs = await pairsFor(mint, { fetchJson }); }
  catch (error) { return { ok: false, error: String(error?.message || error), observedAt: now() }; }
  if (!pairs.ok) return { ok: false, error: pairs.error, observedAt: now() };
  const c = consensus(pairs.pairs);
  if (!c.ok) return { ok: false, error: c.error, observedAt: now() };
  return { ok: true, priceUsd: c.priceUsd, liquidityUsd: c.liquidityUsd,
    poolsUsed: c.poolsUsed, observedAt: now() };
}

export const DEXSCREENER_FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
