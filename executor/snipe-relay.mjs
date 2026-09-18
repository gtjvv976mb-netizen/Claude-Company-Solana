/**
 * MULTI-RELAY SUBMISSION AND THE TIP THAT BUYS INCLUSION.
 *
 * The owner, 2026-09-18: the fastest sniper in the market. Measured the day before, this
 * bot lands a median 5 seconds behind a curve's first trade with a median 12 buyers
 * already in front of it. Detection is one half of that; THIS FILE IS THE OTHER HALF —
 * what happens between a signed transaction and a slot.
 *
 * Today snipe-execute.mjs sends the signed bytes to its two RPC providers and hopes. Every
 * competitive stack does two more things:
 *
 *   1. SUBMITS THE SAME BYTES DOWN SEVERAL PATHS AT ONCE. A block engine, a second block
 *      engine, the ordinary RPCs. They are not alternatives, they are parallel bets on
 *      whose path reaches a leader first, and the transaction is idempotent by signature
 *      so the duplicates cost nothing but bandwidth.
 *   2. PAYS A TIP. On a contested launch, inclusion is auctioned. A transaction with no
 *      tip is a transaction the leader has no reason to prefer.
 *
 * WHAT THIS FILE WILL NOT DO, and each refusal is deliberate:
 *
 *   · IT SHIPS NO TIP ADDRESSES. A tip is an irreversible transfer to an address this
 *     module did not verify, and a plausible-looking constant in a repo is exactly how
 *     money goes to the wrong wallet. The operator supplies them; base58 is checked; an
 *     empty list means no tip instruction is built at all, never a guessed one.
 *   · IT SHIPS NO RELAY URLS. Same reason in a different currency: a default endpoint is
 *     a default third party who sees every transaction before the chain does.
 *   · IT NEVER SIGNS, and holds no key. It takes bytes that are already signed.
 *   · IT NEVER THROWS INTO THE TRADING PATH. A relay that is down, slow, rate-limited or
 *     lying is a relay whose answer is discarded — submission is best-effort by
 *     construction, because the ordinary RPC sends are still happening beside it.
 *
 * The tip instruction is built by the CALLER before signing (it has to be inside the
 * signed message to be paid), so this module exports `tipInstruction` for that and
 * `createRelaySubmitter` for the send.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";

export const SNIPE_RELAY_VERSION = "snipe-relay-v1";

/** Bounds, stated here so every one of them is a number somebody chose on purpose. */
export const RELAY_LIMITS = Object.freeze({
  /* A tip is a transfer out of the trading wallet on EVERY attempt, landed or not, so its
     ceiling is a money cap and not a tuning knob. 0.01 SOL is already 10% of a 0.1 SOL
     ticket; anything above this is a typo, not a strategy. */
  maxTipLamports: 10_000_000,
  maxRelays: 6,
  /* Past this a relay has already lost the race it was entered for. Whatever it answers
     afterwards is history, not a submission. */
  maxTimeoutMs: 3_000,
  defaultTimeoutMs: 800,
});

export class SnipeRelayError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "SnipeRelayError";
    this.clause = clause;
    this.detail = detail;
  }
}
const refuse = (clause, message, detail) => { throw new SnipeRelayError(clause, message, detail); };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * The tip transfer, for the caller to put INSIDE the message it is about to sign.
 *
 * A tip added after signing is not paid; a tip in its own unsigned transaction is not
 * paid either. It has to ride in the same message, which is why this is an instruction
 * builder and not a sender.
 */
export function tipInstruction({ from, to, lamports }) {
  if (!isStr(to) || !BASE58.test(String(to)))
    refuse("tip_account_invalid", `a tip account must be a base58 address, got ${JSON.stringify(to)}`);
  const n = Number(lamports);
  if (!Number.isInteger(n) || n <= 0)
    refuse("tip_invalid", `a tip must be a positive whole number of lamports, got ${JSON.stringify(lamports)}`);
  if (n > RELAY_LIMITS.maxTipLamports)
    refuse("tip_over_cap", `a ${n} lamport tip is above the ${RELAY_LIMITS.maxTipLamports} ceiling this module will build`);
  return SystemProgram.transfer({
    fromPubkey: from instanceof PublicKey ? from : new PublicKey(String(from)),
    toPubkey: new PublicKey(String(to)),
    lamports: n,
  });
}

/**
 * What to tip, from what the launch is worth and how contested it looks.
 *
 * DELIBERATELY BORING ARITHMETIC. A tip model that nobody can predict is a tip model
 * nobody can budget, and the operator's ceiling is the only thing standing between a
 * contested launch and an unbounded auction. Linear in contention, clamped at both ends,
 * and it never returns more than `maxLamports` however contested the launch looks.
 *
 * `contention` is whatever the caller has: buyers already ahead, arrivals per second, any
 * monotone measure of "how many others want this". It is normalised against `fullAt`, so
 * a caller with no measure at all passes 0 and pays the floor.
 */
export function calibrateTip({ baseLamports, maxLamports, contention = 0, fullAt = 10 } = {}) {
  const base = Number(baseLamports), cap = Number(maxLamports);
  if (!Number.isFinite(base) || base < 0) refuse("tip_invalid", `baseLamports must be >= 0, got ${JSON.stringify(baseLamports)}`);
  if (!Number.isFinite(cap) || cap < base)
    refuse("tip_invalid", `maxLamports must be >= baseLamports, got ${JSON.stringify(maxLamports)}`);
  if (cap > RELAY_LIMITS.maxTipLamports)
    refuse("tip_over_cap", `maxLamports ${cap} is above the ${RELAY_LIMITS.maxTipLamports} ceiling`);
  const full = Number(fullAt) > 0 ? Number(fullAt) : 10;
  const c = Number.isFinite(Number(contention)) ? Math.max(0, Number(contention)) : 0;
  const frac = Math.min(1, c / full);
  return Math.round(base + (cap - base) * frac);
}

/**
 * Submit already-signed bytes down every relay at once.
 *
 * `relays` are `{id, url, headers?}`. `submit` returns a report rather than throwing:
 * which relay answered, how fast, and what it said. The caller logs it and carries on,
 * because the RPC sends are happening in parallel and this is an additional bet, never
 * the only one.
 *
 * `fetchImpl` is injected for the same reason every other outside call in this executor
 * is: a test has to be able to drive a relay that is slow, that 429s, that returns
 * nonsense and that never answers at all, without a network.
 */
export function createRelaySubmitter({
  relays = [],
  fetchImpl = (typeof fetch === "function" ? fetch : null),
  timeoutMs = RELAY_LIMITS.defaultTimeoutMs,
  clock = () => Date.now(),
  log = () => {},
} = {}) {
  if (!Array.isArray(relays)) refuse("relays_invalid", "relays must be an array of {id, url}");
  if (relays.length > RELAY_LIMITS.maxRelays)
    refuse("relays_invalid", `${relays.length} relays is above the ${RELAY_LIMITS.maxRelays} this module will fan out to`);
  const cleaned = relays.map((r, i) => {
    if (!r || typeof r !== "object") refuse("relays_invalid", `relay ${i} is not an object`);
    if (!isStr(r.id)) refuse("relays_invalid", `relay ${i} needs an id`);
    if (!isStr(r.url)) refuse("relays_invalid", `relay ${r.id} needs a url`);
    /* https only. A submission carries a signed transaction; sending it in clear is
       handing the whole trade to anyone on the path. */
    let parsed;
    try { parsed = new URL(String(r.url)); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== "https:")
      refuse("relays_invalid", `relay ${r.id} url must be https, got ${JSON.stringify(r.url)}`);
    return Object.freeze({ id: String(r.id), url: parsed.toString(),
      headers: r.headers && typeof r.headers === "object" ? { ...r.headers } : {} });
  });
  const deadline = Math.min(RELAY_LIMITS.maxTimeoutMs,
    Math.max(50, Number(timeoutMs) || RELAY_LIMITS.defaultTimeoutMs));
  if (cleaned.length && typeof fetchImpl !== "function")
    refuse("fetch_missing", "a fetch implementation is required to reach a relay");

  const counters = { submissions: 0, relayAttempts: 0, relayOk: 0, relayFailed: 0 };

  return Object.freeze({
    version: SNIPE_RELAY_VERSION,
    relays: Object.freeze(cleaned.map((r) => r.id)),
    stats: () => Object.freeze({ ...counters }),

    /**
     * @param {string} base64 already-signed, already-serialised transaction
     * @returns {Promise<object>} a report; never throws, never rejects
     */
    async submit(base64) {
      if (!cleaned.length) return Object.freeze({ attempted: 0, results: Object.freeze([]), firstOkId: null, firstOkMs: null });
      counters.submissions++;
      const startedAt = clock();
      const results = await Promise.all(cleaned.map(async (relay) => {
        counters.relayAttempts++;
        const at = clock();
        try {
          const res = await fetchImpl(relay.url, {
            method: "POST",
            headers: { "content-type": "application/json", ...relay.headers },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction",
              params: [base64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }),
            signal: AbortSignal.timeout(deadline),
          });
          const ms = clock() - at;
          if (!res || typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
            counters.relayFailed++;
            return { id: relay.id, ok: false, ms, detail: `HTTP ${res?.status ?? "no status"}` };
          }
          let body = null;
          try { body = await res.json(); } catch { body = null; }
          /* A 200 carrying a JSON-RPC error is a REFUSAL, not a success. Reading the
             status alone is how a rate-limited relay gets counted as a landed send. */
          if (body && body.error) {
            counters.relayFailed++;
            return { id: relay.id, ok: false, ms, detail: String(body.error?.message ?? "rpc error").slice(0, 160) };
          }
          counters.relayOk++;
          return { id: relay.id, ok: true, ms,
            signature: isStr(body?.result) ? String(body.result).slice(0, 96) : null };
        } catch (error) {
          counters.relayFailed++;
          return { id: relay.id, ok: false, ms: clock() - at,
            detail: String(error?.name === "TimeoutError" ? `timed out after ${deadline}ms` : error?.message ?? error).slice(0, 160) };
        }
      }));
      const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
      const report = Object.freeze({
        attempted: results.length,
        results: Object.freeze(results.map(Object.freeze)),
        firstOkId: ok.length ? ok[0].id : null,
        firstOkMs: ok.length ? ok[0].ms : null,
        elapsedMs: clock() - startedAt,
      });
      log(`relay fan-out: ${ok.length}/${results.length} accepted` +
        (ok.length ? `, fastest ${ok[0].id} at ${ok[0].ms}ms` : "") +
        results.filter((r) => !r.ok).map((r) => `; ${r.id} ${r.detail}`).join(""));
      return report;
    },
  });
}

/**
 * Read the operator's relay list out of the environment.
 *
 * `SNIPE_RELAYS` is `id=url` pairs, comma separated. No defaults: an unset value means no
 * relay fan-out, which is exactly what every install does today.
 */
export function relaysFromEnv(env = {}) {
  const raw = String(env.SNIPE_RELAYS ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0) refuse("relays_invalid", `SNIPE_RELAYS entry ${JSON.stringify(pair)} is not id=url`);
    return { id: pair.slice(0, at).trim(), url: pair.slice(at + 1).trim() };
  });
}

/** The operator's tip accounts, base58-checked. Empty means no tip is ever built. */
export function tipAccountsFromEnv(env = {}) {
  const raw = String(env.SNIPE_TIP_ACCOUNTS ?? "").trim();
  if (!raw) return [];
  const out = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of out)
    if (!BASE58.test(a)) refuse("tip_account_invalid", `SNIPE_TIP_ACCOUNTS entry ${JSON.stringify(a)} is not a base58 address`);
  return out;
}

/** One of them, chosen at random — spreading tips is what the block engines ask for. */
export function pickTipAccount(accounts, random = Math.random) {
  if (!Array.isArray(accounts) || !accounts.length) return null;
  /* A random that returns NaN would index `accounts[NaN]` and hand back undefined — a
     tip built against nothing. Non-finite reads as 0, so the worst a broken source can
     do is always pick the first, never pick none. */
  const r = Number(random());
  const at = Number.isFinite(r) ? Math.floor(r * accounts.length) : 0;
  return accounts[Math.min(accounts.length - 1, Math.max(0, at))];
}
