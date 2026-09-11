/**
 * LAUNCH DETECTION — many sources, one stream, and a latency number that is MEASURED.
 *
 * This is the first thing that happens in the sniper lane: something somewhere says "a
 * new mint exists", and everything downstream — the curve read, the gate stack, the
 * would-have-signed bytes — hangs off the instant that notice arrived. Which makes the
 * arrival instant itself the most abusable number in the lane. It is trivially easy to
 * write a feed that appears to be fast, and this file is shaped almost entirely around
 * refusing to do that.
 *
 * ── THE RULER, AND WHY IT IS STAMPED HERE AND NOWHERE ELSE ──────────────────────────
 *
 * Every notice carries TWO clocks and they are never mixed:
 *
 *   arrivedAtMs  — OUR clock, read at the instant the source handed the notice to this
 *                  module. This is the only quantity in the file that is a measurement.
 *   originAtMs   — what the payload CLAIMS about when the thing happened: pump.fun's
 *                  `created_timestamp`, a venue adapter's own `noticeAt`. Somebody
 *                  else's clock, with an unknown offset from ours.
 *
 * Subtracting the second from the first looks exactly like a latency and is not one: it
 * is a latency plus an unmeasured clock skew, and skew between an arbitrary web server
 * and this laptop is routinely larger than the thing being measured. So that difference
 * is reported as `originLagMs` with `crossClock: true` welded to it, and `sourceLatency()`
 * — the table that says which source is fastest — REFUSES to look at it. The only honest
 * latency in this file is the gap between two of OUR OWN arrival stamps for one mint, and
 * that is a difference of two reads of one clock, with the skew cancelled.
 *
 * That is also the strongest argument for running more than one source even when one of
 * them is plainly better: a second source is what converts "the socket is fast" from a
 * claim into a measurement. A feed with a single source cannot tell you how late it is.
 *
 * ── FIRST ARRIVAL WINS, AND A NEGATIVE LAG IS A FAULT, NOT A ZERO ───────────────────
 *
 * A mint seen twice is one launch. The record keeps the FIRST arrival's time and slot
 * forever, and every later source is appended to `sources[]` with its own stamp — so the
 * comparison survives, which is the entire point. "First" means first as OBSERVED by this
 * module, in processing order, because that is the only ordering a single-threaded feed
 * can actually witness.
 *
 * A later arrival therefore has a non-negative lag, always — unless the clock went
 * backwards, which happens (a clock injected for a replay, an NTP step). The obvious
 * `Math.max(0, lag)` is refused here: that clamp turns a clock fault into a perfectly
 * plausible 0 ms and would have this feed report its best-ever latency at the exact
 * moment its ruler broke. The negative value is kept, `clockRegression: true` is set on
 * the record, and the counter is in stats(). A ruler that cannot report its own breakage
 * is not a ruler.
 *
 * ── DEGRADING HONESTLY ──────────────────────────────────────────────────────────────
 *
 * A dead source is REPORTED, never dropped. Concretely:
 *   · a source that throws on start is `dead` with the error kept, and `start()` returns
 *     a per-source summary rather than throwing — one dead source must not take the
 *     survivors down with it, and a feed that silently ran on one leg would have the
 *     latency table quietly stop comparing anything.
 *   · a source that goes quiet is classified against thresholds, and a source that is
 *     merely quiet is NOT called live: silence is the failure mode a websocket has. The
 *     thresholds are a heuristic and are labelled as one — see FEED_DEFAULTS.
 *   · a notice that cannot be parsed, whose mint is not a mint, or whose slot is garbage,
 *     is counted and kept as a sample in `rejections()`. Nothing is dropped on the floor.
 *   · when the queue is full the notice is refused BEFORE the dedupe ledger sees it, so a
 *     later arrival of that same mint is still admissible. Admitting it and then failing
 *     to queue it would mark the mint seen and guarantee it is never emitted at all.
 *   · dedupe memory is bounded, so eviction is possible, so a re-emission after eviction
 *     is FLAGGED (`reemittedAfterEviction`) and counted. A silently repeated launch is
 *     indistinguishable from a real one at the gate stack.
 *
 * ── NOTHING SUBSCRIBES AT IMPORT ────────────────────────────────────────────────────
 *
 * There is no module-level socket, timer, fetch or connection. Importing this file in a
 * test, a probe or a tool opens nothing; `createSnipeFeed()` still opens nothing; only
 * `start()` does. The test proves it by counting subscribes on a fake transport across
 * import and construction.
 *
 * ── WHAT THIS FILE REFUSES TO GUESS ─────────────────────────────────────────────────
 *
 * No venue log or instruction layout is verified in this repo (see snipe-venue.mjs). So
 * `logsSubscribeSource` has NO default log parser: extracting a mint from a program log
 * means knowing that program's log format, and a wrong guess here does not fail loudly —
 * it produces plausible mints for a lane that then reads curves. The parser is the
 * adapter's to supply and the adapter's to prove.
 *
 * ── CONSIDERED AND REJECTED ─────────────────────────────────────────────────────────
 *
 *  · One "primary" source with failover to the poll. Failover hides the comparison, and
 *    the comparison is the measurement. Both run; the ledger records who was first.
 *  · Auto-reconnect loops inside the feed. A backoff loop is untestable without real
 *    timers and turns a dead source into a permanently "recovering" one that reads as
 *    almost-fine. The feed reports; `restartSource(id)` is an explicit act by the lane.
 *  · Deduping on (mint, slot) or on the raw payload. The identity of a launch is its
 *    mint; anything finer re-emits the same launch from a second source, which is exactly
 *    the bug the dedupe exists to prevent.
 *  · Taking the payload's timestamp when it is earlier than ours "because it is closer to
 *    the truth". It is closer to SOMEONE ELSE'S truth. See the two-clock note above.
 *  · Throwing from start() when every source is dead. The lane needs the reason and the
 *    per-source detail to log and to latch on; an exception carries one string.
 *
 * PURITY. The decision functions — stampArrival, mergeArrival, classifySource,
 * summarizeFeedHealth, sourceLatency, the ledger — are pure: no I/O, no clock of their
 * own (every one takes the instant as an argument), no mutation of anything handed in,
 * frozen returns. The feed object around them is the only thing that touches a socket or
 * a timer, and its clock and scheduler are injected so the whole file runs offline.
 */
import bs58 from "bs58";
import { venueContract } from "./snipe-venue.mjs";

export const SNIPE_FEED_VERSION = "snipe-feed-v1";

/** How a source obtains notices. `logs` is a push subscription (the real-time route);
 *  `poll` is an interval HTTP read (the degraded, and honest, fallback); `watch` is a
 *  venue adapter's own AsyncIterable from the snipe-venue contract. The kind travels with
 *  every notice because a latency table that does not say which of these produced a row
 *  is comparing a socket against a 5-second poll and calling it a measurement. */
export const FEED_SOURCE_KINDS = Object.freeze(["logs", "poll", "watch"]);

export const FEED_HEALTH_STATES = Object.freeze(["starting", "live", "degraded", "dead", "stopped"]);

/** Every way a notice can fail to become a record. All of them are counted; none of them
 *  is silent. `queue_full` is deliberately NOT a dedupe entry — see the header. */
export const FEED_REJECT_REASONS = Object.freeze([
  "source_unknown",       // emit() from a source this feed does not own
  "after_stop",           // emit() after stop(); the socket had one more in flight
  "payload_invalid",      // not an object
  "mint_invalid",         // absent, not base58, or not 32 bytes
  "slot_invalid",         // present but not a safe non-negative integer — the latency ruler
  "arrival_invalid",      // the injected clock returned something that is not a time
  "kind_invalid",
  "unparsed",             // the source's own parser returned nothing for a raw notification
  "queue_full",           // backpressure; refused before the ledger, so the mint stays admissible
]);

/**
 * The dials, and what each one is actually derived from.
 *
 * The two silence thresholds are the weakest numbers in this file and are labelled as
 * such. What IS measured is the desk-side creation rate: src/data/pumpfun-live.js:15
 * records 28.8 coins/min probed on 2026-09-03. At that rate a minute of total silence on
 * a mainnet-wide launch subscription means ~29 creates went past unseen, which is a
 * strong signal that the socket, not the market, is the quiet one — hence `degraded` at
 * 60s. Death at 5 minutes is a round number chosen to be far outside anything the rate
 * makes plausible, and it is NOT derived from the socket's own behaviour because this
 * machine has never measured that socket. Re-derive both once the observe lane has a
 * real inter-notice distribution; until then they are a heuristic that errs toward
 * calling a working source degraded rather than calling a dead one live.
 *
 * dedupeTtlMs is not a heuristic: the dedupe window must outlive any position the lane
 * can hold, or the same mint re-enters as a fresh launch while it is still open. 30
 * minutes is DEV_SOLD_WINDOW_MS (src/data/solana.js:13), the longest window anything in
 * this lane reasons over.
 */
export const FEED_DEFAULTS = Object.freeze({
  dedupeTtlMs: 30 * 60_000,
  dedupeCapacity: 20_000,
  maxQueued: 512,
  degradedAfterSilentMs: 60_000,
  deadAfterSilentMs: 300_000,
  maxConsecutiveErrors: 5,
  maxRejectionSamples: 64,
  pollIntervalMs: 5_000,
});

export class FeedConfigError extends Error {
  constructor(message, detail = {}) { super(message); this.name = "FeedConfigError"; this.detail = detail; }
}

/* ── the ruler's primitives ────────────────────────────────────────────────────────── */

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/** A base58 32-byte key, measured by DECODED BYTE LENGTH. Character count is the ruler
 *  that lies here — base58 of 32 bytes runs 32-44 characters — so it is not used. Same
 *  discipline as snipe-venue.mjs describeKey(), deliberately. */
export function isPlausibleMint(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const bytes = bs58.decode(value);
    if (!bytes || bytes.length !== 32) return false;
    return !bytes.every((b) => b === 0);   // 32 zero bytes is the system program, never a mint
  } catch { return false; }
}

/**
 * Seconds or milliseconds, read as what it is.
 *
 * Re-derived rather than imported: src/data/pumpfun-live.js:41-47 carries this exact
 * gotcha and its exact reason — "a seconds timestamp makes a coin minted this morning
 * look 1.6 years old" — but that module is desk-side (it pulls ../lib/http.js and
 * ../categories.js) and the executor deliberately imports nothing from src/. The
 * cross-tree import is the wrong dependency; the four lines are not.
 */
export function epochMsOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

const isSlot = (v) => Number.isSafeInteger(v) && v >= 0;
const isInstant = (v) => Number.isFinite(v) && v >= 0;

/**
 * Turn one source's raw hand-off into a frozen, fully-stamped arrival, or say why not.
 *
 * PURE. `arrivedAtMs` is passed in, never read from a clock here, so a replay produces
 * byte-identical arrivals. The argument is not mutated and `raw` is carried by reference
 * on purpose: it is evidence for the shadow row and copying it would be a lie about what
 * arrived.
 *
 * @returns {{ok: true, arrival: object} | {ok: false, reason: string, message: string}}
 */
export function stampArrival({
  mint, creator = null, slot = null, raw = null, originAtMs = null,
  source, kind, venueId = null, arrivedAtMs,
} = {}) {
  const no = (reason, message) => Object.freeze({ ok: false, reason, message });

  if (!isNonEmptyString(source)) return no("payload_invalid", `notice has no source id (received ${JSON.stringify(source)})`);
  if (!FEED_SOURCE_KINDS.includes(kind))
    return no("kind_invalid", `source ${source} declares kind ${JSON.stringify(kind)}; expected one of ${FEED_SOURCE_KINDS.join(", ")}`);
  if (!isInstant(arrivedAtMs))
    return no("arrival_invalid", `source ${source} arrival stamp ${JSON.stringify(arrivedAtMs)} is not a non-negative finite instant`);
  if (!isPlausibleMint(mint))
    return no("mint_invalid", `source ${source} notice mint ${JSON.stringify(mint)} is not a 32-byte base58 key`);
  /* A garbage slot is refused rather than nulled. The slot IS the latency ruler on the
     one axis that does not depend on any clock at all, and a fabricated one would be
     averaged into the table as if it were an observation. */
  if (slot != null && !isSlot(slot))
    return no("slot_invalid", `source ${source} notice for ${mint} carries slot ${JSON.stringify(slot)}, which is not a safe non-negative integer`);

  /* A bad creator does NOT void the notice — the launch is still real and the gate stack
     can refuse it later — but it is never quietly normalised to null either: the claim is
     kept beside the flag so a CREATOR-SOLD trigger cannot mistake "we could not read the
     deployer" for "there is no deployer". */
  const creatorOk = creator == null || isPlausibleMint(creator);
  /* TAKEN AS GIVEN, NEVER RESCALED. epochMsOf()'s seconds-or-milliseconds guess is right
     for a pump.fun listing row and wrong as a general rule — it multiplies any genuine
     millisecond value below 1e12 by a thousand, which is every clock a test, a replay or a
     simulation uses. The unit is known at the SOURCE, so the source's mapper normalises
     (pumpfunRowToNotice does exactly that) and this function, which cannot know, does not
     guess. A non-positive or non-finite claim is simply no claim. */
  const origin = Number.isFinite(originAtMs) && originAtMs > 0 ? originAtMs : null;

  return Object.freeze({
    ok: true,
    arrival: Object.freeze({
      mint,
      creator: creatorOk ? creator : null,
      creatorClaim: creatorOk ? null : creator,
      creatorInvalid: !creatorOk,
      slot: slot == null ? null : slot,
      source,
      kind,
      venueId: isNonEmptyString(venueId) ? venueId : null,
      arrivedAtMs,
      originAtMs: origin,
      /* Two clocks, one subtraction, and the warning label welded on. sourceLatency()
         does not read this field; nothing that ranks sources may. */
      originLagMs: origin == null ? null : arrivedAtMs - origin,
      crossClock: origin != null,
      raw,
    }),
  });
}

/** The first arrival becomes the record. Frozen; `sources` is a frozen one-entry list so
 *  every consumer reads the same shape whether one source saw it or three. */
export function openNoticeRecord(arrival) {
  if (!isPlainObject(arrival) || !isPlausibleMint(arrival.mint))
    throw new FeedConfigError("openNoticeRecord needs a stamped arrival");
  const leg = Object.freeze({
    source: arrival.source, kind: arrival.kind, arrivedAtMs: arrival.arrivedAtMs,
    slot: arrival.slot, lagMsFromFirst: 0, slotsBehindFirst: arrival.slot == null ? null : 0,
    originAtMs: arrival.originAtMs, originLagMs: arrival.originLagMs, crossClock: arrival.crossClock,
  });
  return Object.freeze({
    feedVersion: SNIPE_FEED_VERSION,
    mint: arrival.mint,
    creator: arrival.creator,
    creatorInvalid: arrival.creatorInvalid,
    venueId: arrival.venueId,
    firstSource: arrival.source,
    firstKind: arrival.kind,
    firstSeenAtMs: arrival.arrivedAtMs,
    firstSlot: arrival.slot,
    sources: Object.freeze([leg]),
    corroborations: 0,
    clockRegression: false,
    reemittedAfterEviction: false,
    raw: arrival.raw,
  });
}

/**
 * A second (or third) source saw a mint we already have.
 *
 * PURE and NON-MUTATING: the existing record is read and a new frozen one is returned, so
 * a consumer holding the emitted record cannot have it change under it.
 *
 * The first arrival's time and slot are kept verbatim. The new leg carries its own stamp
 * plus the two deltas that make the comparison, and a negative lag is kept as a negative
 * lag with `clockRegression` raised — see the header for why the obvious clamp is a bug.
 */
export function mergeArrival(record, arrival) {
  if (!isPlainObject(record) || !isPlainObject(arrival))
    throw new FeedConfigError("mergeArrival needs a record and a stamped arrival");
  if (record.mint !== arrival.mint)
    throw new FeedConfigError(`mergeArrival called across mints: record ${record.mint} vs arrival ${arrival.mint}`);

  const lagMsFromFirst = arrival.arrivedAtMs - record.firstSeenAtMs;
  const slotsBehindFirst = (arrival.slot == null || record.firstSlot == null)
    ? null : arrival.slot - record.firstSlot;
  const leg = Object.freeze({
    source: arrival.source, kind: arrival.kind, arrivedAtMs: arrival.arrivedAtMs,
    slot: arrival.slot, lagMsFromFirst, slotsBehindFirst,
    originAtMs: arrival.originAtMs, originLagMs: arrival.originLagMs, crossClock: arrival.crossClock,
  });
  /* A later source may FILL IN a deployer the first one did not carry — the poll rows
     have it, a log line may not — but it may never overwrite one. First arrival wins on
     every field it actually supplied. */
  const creator = record.creator ?? arrival.creator ?? null;
  return Object.freeze({
    ...record,
    creator,
    creatorInvalid: creator == null && (record.creatorInvalid || arrival.creatorInvalid),
    venueId: record.venueId ?? arrival.venueId ?? null,
    sources: Object.freeze([...record.sources, leg]),
    corroborations: record.corroborations + 1,
    clockRegression: record.clockRegression || lagMsFromFirst < 0,
  });
}

/* ── the dedupe ledger ─────────────────────────────────────────────────────────────── */

/**
 * Bounded, insertion-ordered dedupe by mint.
 *
 * The bound is the interesting part. An unbounded Map is a leak in a process that runs
 * for weeks against ~29 launches a minute (~1.2M rows a month); a bounded one can evict a
 * mint that is still relevant. Both are true, so the ledger does the bounded thing and
 * makes the consequence VISIBLE: a mint that returns after eviction is admitted (it must
 * be — refusing it would drop a live launch) but its record carries
 * `reemittedAfterEviction: true` and the eviction is counted. The gate stack can then
 * treat it as the ambiguous thing it is instead of as a fresh create.
 *
 * `nowMs` is a parameter everywhere. The ledger has no clock.
 */
export function createNoticeLedger({
  capacity = FEED_DEFAULTS.dedupeCapacity, ttlMs = FEED_DEFAULTS.dedupeTtlMs,
} = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new FeedConfigError(`dedupe capacity must be a positive safe integer; received ${JSON.stringify(capacity)}`);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0)
    throw new FeedConfigError(`dedupe ttl must be a non-negative safe integer of ms; received ${JSON.stringify(ttlMs)}`);

  const rows = new Map();                 // mint -> record, in insertion order
  const evictedMints = new Set();         // mints we have forgotten, so a return is flagged
  const stats = { admitted: 0, fresh: 0, corroborated: 0, evicted: 0, expired: 0, clockRegressions: 0, reemitted: 0 };

  const forget = (mint) => { rows.delete(mint); evictedMints.add(mint); stats.evicted++; };

  const prune = (nowMs) => {
    if (!isInstant(nowMs)) throw new FeedConfigError(`ledger.prune needs an instant; received ${JSON.stringify(nowMs)}`);
    if (ttlMs > 0) {
      for (const [mint, record] of rows) {
        if (nowMs - record.firstSeenAtMs < ttlMs) break;   // insertion order is time order
        rows.delete(mint); evictedMints.add(mint); stats.expired++; stats.evicted++;
      }
    }
    while (rows.size > capacity) forget(rows.keys().next().value);
    return rows.size;
  };

  return {
    get size() { return rows.size; },
    get(mint) { return rows.get(mint) ?? null; },
    has(mint) { return rows.has(mint); },
    /** Every live record, in first-arrival order — the input to sourceLatency(). */
    all: () => Object.freeze([...rows.values()]),
    prune,
    stats: () => Object.freeze({ ...stats, size: rows.size, forgotten: evictedMints.size }),
    /**
     * @returns {{fresh: boolean, record: object, previous: object|null}} — `fresh` is the
     *   ONLY thing that may cause an emission. A corroboration updates the record and
     *   emits nothing.
     */
    admit(arrival, nowMs) {
      if (!isPlainObject(arrival)) throw new FeedConfigError("ledger.admit needs a stamped arrival");
      const at = isInstant(nowMs) ? nowMs : arrival.arrivedAtMs;
      stats.admitted++;
      const existing = rows.get(arrival.mint);
      if (existing) {
        const merged = mergeArrival(existing, arrival);
        if (merged.clockRegression && !existing.clockRegression) stats.clockRegressions++;
        rows.set(arrival.mint, merged);
        stats.corroborated++;
        return { fresh: false, record: merged, previous: existing };
      }
      let record = openNoticeRecord(arrival);
      if (evictedMints.has(arrival.mint)) {
        record = Object.freeze({ ...record, reemittedAfterEviction: true });
        stats.reemitted++;
      }
      rows.set(arrival.mint, record);
      stats.fresh++;
      prune(at);
      return { fresh: true, record, previous: null };
    },
  };
}

/* ── health, classified rather than counted ────────────────────────────────────────── */

/**
 * One source's state, judged at an instant handed in.
 *
 * PURE. Silence is measured from the last notice, or from start when there has been no
 * notice at all — a source that has never produced anything is not exempt from the
 * threshold merely because it has no last-notice stamp, which is the precise shape of the
 * bug where a socket that never connected reads as healthy forever.
 */
export function classifySource(source, nowMs, cfg = {}) {
  if (!isPlainObject(source)) throw new FeedConfigError("classifySource needs a source state");
  if (!isInstant(nowMs)) throw new FeedConfigError(`classifySource needs an instant; received ${JSON.stringify(nowMs)}`);
  const degradedAfter = cfg.degradedAfterSilentMs ?? FEED_DEFAULTS.degradedAfterSilentMs;
  const deadAfter = cfg.deadAfterSilentMs ?? FEED_DEFAULTS.deadAfterSilentMs;
  const maxErrors = cfg.maxConsecutiveErrors ?? FEED_DEFAULTS.maxConsecutiveErrors;

  const since = source.lastNoticeAtMs ?? source.startedAtMs ?? null;
  const silentMs = since == null ? null : nowMs - since;
  const base = {
    id: source.id, kind: source.kind, venueId: source.venueId ?? null,
    startedAtMs: source.startedAtMs ?? null, lastNoticeAtMs: source.lastNoticeAtMs ?? null,
    silentMs, notices: source.notices ?? 0, accepted: source.accepted ?? 0,
    firsts: source.firsts ?? 0, rejected: source.rejected ?? 0, unparsed: source.unparsed ?? 0,
    errors: source.errors ?? 0, consecutiveErrors: source.consecutiveErrors ?? 0,
    lastError: source.lastError ?? null, restarts: source.restarts ?? 0,
  };
  const verdict = (state, reason) => Object.freeze({ ...base, state, reason });

  if (source.state === "stopped") return verdict("stopped", "stopped by the lane");
  if (source.fatal) return verdict("dead", source.lastError ? `fatal: ${source.lastError}` : "fatal error");
  if (source.state === "starting" || since == null) return verdict("starting", "not started yet");
  if ((source.consecutiveErrors ?? 0) >= maxErrors)
    return verdict("dead", `${source.consecutiveErrors} consecutive errors >= ${maxErrors}`);
  if (silentMs >= deadAfter) return verdict("dead", `silent ${silentMs}ms >= ${deadAfter}ms`);
  if (silentMs >= degradedAfter) return verdict("degraded", `silent ${silentMs}ms >= ${degradedAfter}ms`);
  if ((source.consecutiveErrors ?? 0) > 0)
    return verdict("degraded", `${source.consecutiveErrors} consecutive error(s) since the last good notice`);
  return verdict("live", null);
}

/**
 * The whole feed's health. `ok` is true only while at least one source is live — a feed
 * running entirely on degraded sources is not fine, and one running on none is blind.
 * Dead sources are named in the message, because "feed unhealthy" in a log is not an
 * actionable sentence.
 */
export function summarizeFeedHealth(sources, nowMs, cfg = {}) {
  const states = (Array.isArray(sources) ? sources : []).map((s) => classifySource(s, nowMs, cfg));
  const by = (state) => states.filter((s) => s.state === state).map((s) => s.id);
  const live = by("live"), degraded = by("degraded"), dead = by("dead"), stopped = by("stopped"), starting = by("starting");
  const parts = [
    `${live.length}/${states.length} live`,
    dead.length ? `DEAD: ${dead.join(", ")}` : null,
    degraded.length ? `degraded: ${degraded.join(", ")}` : null,
    stopped.length ? `stopped: ${stopped.join(", ")}` : null,
    starting.length ? `starting: ${starting.join(", ")}` : null,
  ].filter(Boolean);
  return Object.freeze({
    feedVersion: SNIPE_FEED_VERSION,
    ok: live.length > 0,
    at: nowMs,
    state: live.length ? (dead.length || degraded.length ? "degraded" : "live")
      : states.every((s) => s.state === "stopped") && states.length ? "stopped" : "dead",
    live: Object.freeze(live), degraded: Object.freeze(degraded), dead: Object.freeze(dead),
    stopped: Object.freeze(stopped), starting: Object.freeze(starting),
    sources: Object.freeze(states),
    message: parts.join("; "),
  });
}

/* ── the latency table ─────────────────────────────────────────────────────────────── */

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Who saw it first, and by how much — over records, not over claims.
 *
 * Every number here is a difference of two reads of THIS process's clock for ONE mint, so
 * the clock's offset from anyone else's cancels exactly. `originLagMs` is deliberately not
 * read: see the header. A source that was never beaten reports `lagSamples: 0` and null
 * lags rather than a flattering zero — no samples is not "0 ms behind".
 *
 * PURE. Takes the records; no clock, no state.
 */
export function sourceLatency(records) {
  const rows = Array.isArray(records) ? records : [...(records ?? [])];
  const agg = new Map();
  const of = (id, kind) => {
    if (!agg.has(id)) agg.set(id, { id, kind, arrivals: 0, firsts: 0, lags: [], slotDeltas: [] });
    return agg.get(id);
  };
  let contested = 0;
  for (const record of rows) {
    if (!isPlainObject(record) || !Array.isArray(record.sources)) continue;
    const distinct = new Set(record.sources.map((l) => l.source));
    if (distinct.size > 1) contested++;
    for (const leg of record.sources) {
      const row = of(leg.source, leg.kind);
      row.arrivals++;
      if (leg.source === record.firstSource && leg.arrivedAtMs === record.firstSeenAtMs) { row.firsts++; continue; }
      row.lags.push(leg.lagMsFromFirst);
      if (leg.slotsBehindFirst != null) row.slotDeltas.push(leg.slotsBehindFirst);
    }
  }
  const table = [...agg.values()].map((r) => Object.freeze({
    id: r.id, kind: r.kind, arrivals: r.arrivals, firsts: r.firsts,
    firstShare: r.arrivals ? r.firsts / r.arrivals : null,
    lagSamples: r.lags.length,
    minLagMs: r.lags.length ? Math.min(...r.lags) : null,
    medianLagMs: median(r.lags),
    maxLagMs: r.lags.length ? Math.max(...r.lags) : null,
    negativeLags: r.lags.filter((x) => x < 0).length,
    slotSamples: r.slotDeltas.length,
    medianSlotsBehind: median(r.slotDeltas),
  })).sort((a, b) => b.firsts - a.firsts || a.id.localeCompare(b.id));
  return Object.freeze({
    feedVersion: SNIPE_FEED_VERSION,
    records: rows.length,
    corroborated: contested,
    /* The honest caveat, carried in the data structure so a report cannot print the table
       without it: a lag is only measurable on a mint TWO sources saw. */
    measuredOnCorroboratedOnly: true,
    sources: Object.freeze(table),
  });
}

/* ── the emission queue ────────────────────────────────────────────────────────────── */

function createQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    get size() { return items.length; },
    push(value) {
      if (closed) return false;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false }); else items.push(value);
      return true;
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

/* ── the feed ──────────────────────────────────────────────────────────────────────── */

/**
 * Many sources, one deduped stream.
 *
 * Everything that touches the outside world is injected: `clock`, `schedule`, `cancel`,
 * and the sources themselves (each of which owns its own transport). The whole file
 * therefore runs offline against fakes, which is how the test proves dedupe, timing and
 * dead-source reporting without a socket.
 *
 * @param {object[]} sources  each {id, kind, venueId?, start({emit, fail, clock, schedule, cancel}) -> handle}
 */
export function createSnipeFeed({
  sources, cfg = {}, clock = () => Date.now(), schedule = setTimeout, cancel = clearTimeout,
  onCorroboration = null, onHealth = null,
} = {}) {
  if (!Array.isArray(sources) || sources.length === 0)
    throw new FeedConfigError("a launch feed needs at least one source; a feed with none cannot report that it is blind");
  if (typeof clock !== "function") throw new FeedConfigError("clock must be a function returning ms");

  const conf = Object.freeze({ ...FEED_DEFAULTS, ...cfg });
  const states = new Map();
  for (const source of sources) {
    if (!isPlainObject(source) || !isNonEmptyString(source.id) || typeof source.start !== "function")
      throw new FeedConfigError(`every source needs {id, kind, start()}; received ${JSON.stringify(source?.id ?? source)}`);
    if (!FEED_SOURCE_KINDS.includes(source.kind))
      throw new FeedConfigError(`source ${source.id} declares kind ${JSON.stringify(source.kind)}; expected one of ${FEED_SOURCE_KINDS.join(", ")}`);
    if (states.has(source.id)) throw new FeedConfigError(`two sources share the id ${source.id}; the latency table would merge them`);
    states.set(source.id, {
      id: source.id, kind: source.kind, venueId: source.venueId ?? null, source,
      state: "starting", startedAtMs: null, lastNoticeAtMs: null, handle: null, fatal: false,
      notices: 0, accepted: 0, firsts: 0, rejected: 0, unparsed: 0, errors: 0, consecutiveErrors: 0,
      lastError: null, lastErrorAtMs: null, restarts: 0,
    });
  }

  const ledger = createNoticeLedger({ capacity: conf.dedupeCapacity, ttlMs: conf.dedupeTtlMs });
  const queue = createQueue();
  const rejections = [];
  const counters = { emitted: 0, corroborated: 0, rejected: 0, overflow: 0, afterStop: 0 };
  let running = false, stopped = false;

  const reject = (reason, message, detail = {}) => {
    counters.rejected++;
    if (rejections.length < conf.maxRejectionSamples)
      rejections.push(Object.freeze({ reason, message, at: clock(), ...detail }));
    return Object.freeze({ accepted: false, fresh: false, reason, message });
  };

  function admit(sourceId, payload) {
    const st = states.get(sourceId);
    if (!st) return reject("source_unknown", `emit() from unregistered source ${JSON.stringify(sourceId)}`);
    if (stopped) { counters.afterStop++; return reject("after_stop", `source ${sourceId} emitted after stop()`, { source: sourceId }); }
    st.notices++;

    /* ANYTHING ARRIVING IS PROOF THE TRANSPORT IS ALIVE, whatever we then think of the
       payload. Health is a fact about the socket, not about our opinion of its contents —
       a program subscription is mostly trades, and a feed that only counted CREATES as
       liveness would declare a perfectly healthy socket dead on a quiet launch minute. */
    const arrivedAtMs = clock();
    st.lastNoticeAtMs = arrivedAtMs;
    st.consecutiveErrors = 0;

    if (!isPlainObject(payload)) {
      st.rejected++;
      return reject("payload_invalid", `source ${sourceId} emitted ${payload === null ? "null" : typeof payload}`, { source: sourceId });
    }
    /* The source's own parser recognised nothing. Expected and common; counted separately
       from a malformed notice so the two never hide in one number. */
    if (payload.unparsed === true) {
      st.unparsed++;
      st.rejected++;
      return reject("unparsed", `source ${sourceId} could not extract a mint from a notification`, { source: sourceId });
    }

    const stamped = stampArrival({
      ...payload, source: sourceId, kind: st.kind, venueId: payload.venueId ?? st.venueId, arrivedAtMs,
    });
    if (!stamped.ok) { st.rejected++; return reject(stamped.reason, stamped.message, { source: sourceId, mint: payload.mint ?? null }); }
    const arrival = stamped.arrival;

    /* BACKPRESSURE BEFORE THE LEDGER. Admitting first and then failing to queue would mark
       the mint as seen and guarantee it is never emitted at all — the dedupe would refuse
       every later arrival of a launch nobody ever received. Refused here, the mint is
       still unknown to the ledger and the next source to see it can still get it through. */
    if (!ledger.has(arrival.mint) && queue.size >= conf.maxQueued) {
      counters.overflow++;
      st.rejected++;
      return reject("queue_full", `queue at ${queue.size}/${conf.maxQueued}; refused ${arrival.mint} from ${sourceId} BEFORE dedupe so a later arrival can still be taken`,
        { source: sourceId, mint: arrival.mint });
    }

    const result = ledger.admit(arrival, arrivedAtMs);
    st.accepted++;
    if (result.fresh) {
      st.firsts++;
      queue.push(result.record);
      counters.emitted++;
    } else {
      counters.corroborated++;
      if (onCorroboration) { try { onCorroboration(result.record, arrival); } catch { /* a reporter must not break the feed */ } }
    }
    return Object.freeze({ accepted: true, fresh: result.fresh, record: result.record });
  }

  function fail(sourceId, error, { fatal = false } = {}) {
    const st = states.get(sourceId);
    if (!st) return;
    st.errors++;
    st.consecutiveErrors++;
    st.lastError = String(error?.message ?? error);
    st.lastErrorAtMs = clock();
    if (fatal) { st.fatal = true; st.state = "dead"; }
    if (onHealth) { try { onHealth(health()); } catch { /* ditto */ } }
  }

  const ctxFor = (id) => Object.freeze({
    emit: (payload) => admit(id, payload),
    fail: (error, opts) => fail(id, error, opts),
    clock, schedule, cancel, cfg: conf,
  });

  function health(nowMs = clock()) {
    return summarizeFeedHealth([...states.values()], nowMs, conf);
  }

  async function startOne(st) {
    /* Cleared BEFORE the attempt, not after it. A source can die while start() is still
       awaiting — a venue watch() that ends on its first next() does exactly that, and
       reports fatal from a microtask — so a successful return must not overwrite a verdict
       that has already been recorded. Resetting these afterwards resurrected a dead source
       as `live` and hid it behind the 5-minute silence timer. */
    st.state = "starting";
    st.fatal = false;
    st.lastError = null;
    st.consecutiveErrors = 0;
    st.startedAtMs = clock();
    try {
      st.handle = await st.source.start(ctxFor(st.id));
      if (!st.fatal) st.state = "live";
      return Object.freeze({ id: st.id, kind: st.kind, ok: st.fatal !== true, error: st.lastError });
    } catch (error) {
      /* A source that cannot start is DEAD AND NAMED, and the others still start. One bad
         endpoint must not take the feed down, and it must not vanish either. */
      st.state = "dead";
      st.fatal = true;
      st.handle = null;
      st.errors++;
      st.consecutiveErrors++;
      st.lastError = String(error?.message ?? error);
      st.lastErrorAtMs = clock();
      return Object.freeze({ id: st.id, kind: st.kind, ok: false, error: st.lastError });
    }
  }

  return {
    feedVersion: SNIPE_FEED_VERSION,
    cfg: conf,

    /** Opens every subscription. NOTHING above this line has opened one. */
    async start() {
      if (running) throw new FeedConfigError("feed already started");
      if (stopped) throw new FeedConfigError("feed was stopped; construct a new one");
      running = true;
      const results = [];
      for (const st of states.values()) results.push(await startOne(st));
      const summary = Object.freeze({
        feedVersion: SNIPE_FEED_VERSION,
        started: Object.freeze(results.filter((r) => r.ok).map((r) => r.id)),
        failed: Object.freeze(results.filter((r) => !r.ok)),
        sources: Object.freeze(results),
        health: health(),
      });
      if (onHealth) { try { onHealth(summary.health); } catch { /* a reporter must not break the feed */ } }
      return summary;
    },

    /** Restarting is the LANE's decision, not a hidden loop in here. Counted. */
    async restartSource(id) {
      const st = states.get(id);
      if (!st) throw new FeedConfigError(`no source ${JSON.stringify(id)}`);
      if (stopped) throw new FeedConfigError("feed is stopped");
      /* A restart is a RE-start. Reaching this before start() would open one subscription
         out of several and leave the feed reporting a health summary for sources that were
         never asked to connect. */
      if (!running) throw new FeedConfigError(`feed has not been started; cannot restart source ${id}`);
      try { await st.handle?.stop?.(); } catch { /* it is already broken; that is why we are here */ }
      st.handle = null;
      st.restarts++;
      st.state = "starting";
      st.lastNoticeAtMs = null;
      return startOne(st);
    },

    async stop() {
      stopped = true;
      running = false;
      for (const st of states.values()) {
        try { await st.handle?.stop?.(); } catch { /* nothing here may prevent the others stopping */ }
        st.handle = null;
        st.state = "stopped";
      }
      queue.close();
      return this.stats();
    },

    /** The deduped stream. One notice per mint, first arrival, in arrival order. */
    notices() { return queue[Symbol.asyncIterator](); },

    record(mint) { return ledger.get(mint); },
    /** Every deduped record still inside the dedupe window, first-arrival order. */
    records() { return ledger.all(); },
    health,
    /** The measured table: who was first, and by how much, over this feed's own clock. */
    latency() { return sourceLatency(ledger.all()); },
    rejections() { return Object.freeze([...rejections]); },
    stats() {
      return Object.freeze({
        feedVersion: SNIPE_FEED_VERSION,
        running, stopped,
        queued: queue.size,
        ...counters,
        ledger: ledger.stats(),
      });
    },
  };
}

/* ── source builders ───────────────────────────────────────────────────────────────── */

/**
 * A push subscription over an injected transport.
 *
 * The transport is `{subscribe({programId, commitment, onNotice, onError}) -> {unsubscribe()}}`
 * — deliberately small, because the whole point is that the test drives it. `web3LogsTransport`
 * below adapts a @solana/web3.js Connection to it, and is the only place a real socket exists.
 *
 * `extractMint` is REQUIRED and has no default. Pulling a mint out of a program's logs
 * means knowing that program's log format, no venue layout is verified in this repo, and a
 * wrong guess here does not fail loudly — it manufactures plausible mints for a lane that
 * then reads curves against them. That parser belongs to the adapter that can prove it.
 */
export function logsSubscribeSource({
  id, venueId = null, programId, commitment = "processed", transport, extractMint,
} = {}) {
  if (!isNonEmptyString(id)) throw new FeedConfigError("logsSubscribeSource needs an id");
  if (!isPlausibleMint(programId))
    throw new FeedConfigError(`logsSubscribeSource ${id} programId ${JSON.stringify(programId)} is not a 32-byte base58 key`);
  if (!isPlainObject(transport) || typeof transport.subscribe !== "function")
    throw new FeedConfigError(`logsSubscribeSource ${id} needs a transport with subscribe()`);
  if (typeof extractMint !== "function")
    throw new FeedConfigError(`logsSubscribeSource ${id} needs an explicit extractMint(): no venue log layout is verified in this repo, so this module refuses to guess one`);

  return {
    id, kind: "logs", venueId, programId, commitment,
    start({ emit, fail }) {
      const handle = transport.subscribe({
        programId, commitment,
        onNotice: (notification, context) => {
          let parsed = null;
          try { parsed = extractMint(notification, context); }
          catch (error) { fail(error); return; }
          /* A notification the parser did not recognise is the common case on a program
             subscription — most of them are trades, not creates — so it is not an error.
             It is still counted rather than dropped invisibly: emit() rejects it as
             `unparsed` and the counter is in stats(). */
          if (!parsed || !parsed.mint) { emit({ unparsed: true, raw: notification }); return; }
          emit({
            mint: parsed.mint,
            creator: parsed.creator ?? null,
            slot: parsed.slot ?? context?.slot ?? null,
            originAtMs: parsed.originAtMs ?? null,
            raw: notification,
          });
        },
        onError: (error) => fail(error),
      });
      return { stop: () => handle?.unsubscribe?.() };
    },
  };
}

/**
 * An interval HTTP read — the degraded route, and honest about being one.
 *
 * src/data/pumpfun-live.js is a POLL, not a stream (LIST at :29, newLaunches() at :72,
 * PAGE_ROWS server-capped at 70 at :31). A poll cannot be a t=0 trigger: its notice is at
 * best one interval late and it carries no slot at all, so a row from here can never be
 * compared against a socket on the slot axis. It earns its place as (a) the fallback when
 * the socket is dead, and (b) a second, independent witness that the socket is seeing
 * what the world sees — which is the only thing that makes the socket's latency a measured
 * quantity rather than a self-report.
 *
 * `schedule`/`cancel` come from the feed, so a test drives the interval by hand and this
 * file never waits on a real timer.
 */
export function pollSource({
  id, venueId = null, fetchRows, mapRow = pumpfunRowToNotice, intervalMs = FEED_DEFAULTS.pollIntervalMs,
  firstDelayMs = 0,
} = {}) {
  if (!isNonEmptyString(id)) throw new FeedConfigError("pollSource needs an id");
  if (typeof fetchRows !== "function") throw new FeedConfigError(`pollSource ${id} needs fetchRows()`);
  if (typeof mapRow !== "function") throw new FeedConfigError(`pollSource ${id} needs mapRow()`);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new FeedConfigError(`pollSource ${id} interval ${JSON.stringify(intervalMs)} must be a positive number of ms`);

  return {
    id, kind: "poll", venueId, intervalMs,
    start({ emit, fail, schedule, cancel }) {
      let timer = null, done = false;
      const tick = async () => {
        timer = null;
        if (done) return;
        try {
          const rows = await fetchRows();
          if (!Array.isArray(rows)) throw new Error(`fetchRows() returned ${rows === null ? "null" : typeof rows}, not an array`);
          for (const row of rows) {
            let notice = null;
            try { notice = mapRow(row); } catch { notice = null; }
            if (notice && notice.mint) emit(notice);
            else emit({ unparsed: true, raw: row });
          }
        } catch (error) {
          fail(error);
        } finally {
          if (!done) { timer = schedule(tick, intervalMs); timer?.unref?.(); }
        }
      };
      timer = schedule(tick, firstDelayMs);
      timer?.unref?.();
      return { stop: () => { done = true; if (timer != null) cancel(timer); timer = null; } };
    },
  };
}

/**
 * A venue adapter's own watch() as a source.
 *
 * The adapter is run through the OBSERVE venue contract first. An adapter that is not
 * admissible even for observing does not get to put mints into this lane's stream —
 * self-identification is how an unregistered program ends up feeding the gate stack.
 * Nothing here grants anything: passing the observe contract is not permission to sign,
 * and this source never touches buyIx.
 *
 * The adapter's `noticeAt` is ITS clock and lands in originAtMs, never in the arrival
 * stamp. See the header.
 */
export function sourceFromVenueWatch(adapter, { id = null, opts = {} } = {}) {
  const verdict = venueContract(adapter, { execute: false });
  if (!verdict.ok)
    throw new FeedConfigError(`venue adapter is not admissible even for observe (${verdict.clause}): ${verdict.detail?.message ?? ""}`,
      { clause: verdict.clause });
  const sourceId = id ?? `watch:${adapter.id}`;
  return {
    id: sourceId, kind: "watch", venueId: adapter.id,
    start({ emit, fail }) {
      const iterable = adapter.watch(opts);
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function")
        throw new Error(`venue ${adapter.id} watch() did not return an AsyncIterable`);
      const iterator = iterable[Symbol.asyncIterator]();
      let done = false;
      (async () => {
        try {
          while (!done) {
            const next = await iterator.next();
            if (next.done) break;
            const n = next.value ?? {};
            emit({
              mint: n.mint, creator: n.creator ?? null, slot: n.slot ?? null,
              originAtMs: n.noticeAt ?? null, venueId: n.venue ?? adapter.id, raw: n.raw ?? n,
            });
          }
          /* A watch that ENDS is a dead source, not a quiet one, and the difference
             matters: quiet is a threshold, ended is a fact. Reported as fatal so health
             says dead immediately instead of waiting out the silence timer. */
          if (!done) fail(new Error(`venue ${adapter.id} watch() ended`), { fatal: true });
        } catch (error) {
          if (!done) fail(error, { fatal: true });
        }
      })();
      return { stop: async () => { done = true; await iterator.return?.(); } };
    },
  };
}

/* ── real transports (constructed on demand, never at import) ─────────────────────── */

/**
 * Adapts a @solana/web3.js Connection to the tiny transport the source expects.
 *
 * This is the only function in the file that can open a socket, and it opens one only
 * when `subscribe()` is called — which only `feed.start()` does. The Connection itself is
 * the caller's: snipe-lane.mjs owns its own, unconditionally secondary-equipped (spec
 * §2.6), and this module has no business creating one.
 *
 * `toPublicKey` is REQUIRED and injected rather than imported. web3.js's onLogs() filter
 * is `"all" | "allWithVotes" | PublicKey` — it does NOT accept a base58 string, and a
 * string handed to it is forwarded to the node as a filter the node rejects, i.e. a
 * subscription that appears to have been created and delivers nothing forever. Refusing
 * without the constructor is therefore the difference between a loud start failure and a
 * silently empty feed. Injecting it also keeps this module free of an @solana/web3.js
 * import, so it stays loadable from a test with nothing installed.
 */
export function web3LogsTransport(connection, { toPublicKey } = {}) {
  if (!isPlainObject(connection) || typeof connection.onLogs !== "function")
    throw new FeedConfigError("web3LogsTransport needs a @solana/web3.js Connection with onLogs()");
  if (typeof toPublicKey !== "function")
    throw new FeedConfigError("web3LogsTransport needs toPublicKey (the caller's own PublicKey constructor): onLogs() refuses a base58 string filter and would subscribe to nothing");
  return {
    subscribe({ programId, commitment, onNotice, onError }) {
      let subscriptionId = null;
      try {
        subscriptionId = connection.onLogs(toPublicKey(programId), (logs, ctx) => onNotice(logs, ctx), commitment);
      } catch (error) { onError?.(error); throw error; }
      return {
        unsubscribe() {
          if (subscriptionId == null) return;
          const id = subscriptionId;
          subscriptionId = null;
          return connection.removeOnLogsListener?.(id);
        },
      };
    },
  };
}

export const PUMPFUN_LIST_ORIGIN = "https://frontend-api-v3.pump.fun";
/** The server ignores anything larger — src/data/pumpfun-live.js:31, measured. */
export const PUMPFUN_PAGE_ROWS = 70;

/** One pump.fun listing row → a notice payload. The row's `created_timestamp` is pump.fun's
 *  clock and is therefore an origin claim, never an arrival stamp; a listing row carries no
 *  slot, and `slot: null` says so instead of inventing one. */
export function pumpfunRowToNotice(row) {
  if (!isPlainObject(row) || !isNonEmptyString(row.mint)) return null;
  return {
    mint: row.mint,
    creator: isNonEmptyString(row.creator) ? row.creator : null,
    slot: null,
    originAtMs: epochMsOf(row.created_timestamp),
    raw: row,
  };
}

/**
 * A fetcher for `pollSource`, aimed at pump.fun's own listing — free, keyless, and the
 * same endpoint the desk already reads. `fetchJson` is injected so the test runs offline;
 * the default reaches the network only when the returned function is actually called.
 */
export function pumpfunListingFetcher({
  pages = 1, timeoutMs = 9_000, origin = PUMPFUN_LIST_ORIGIN,
  fetchJson = defaultFetchJson,
} = {}) {
  const wanted = Math.max(1, Math.min(12, Math.floor(pages) || 1));
  return async function fetchRows() {
    const urls = Array.from({ length: wanted }, (_, i) =>
      `${origin}/coins?offset=${i * PUMPFUN_PAGE_ROWS}&limit=${PUMPFUN_PAGE_ROWS}&sort=created_timestamp&order=DESC&includeNsfw=true`);
    const results = await Promise.allSettled(urls.map((url) => fetchJson(url, { timeoutMs })));
    const rows = [];
    let failures = 0;
    for (const result of results) {
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) { failures++; continue; }
      rows.push(...result.value);
    }
    /* Every page failing is a dead source, not an empty market. Returning [] here is the
       exact silent degradation this module exists to refuse. */
    if (failures === results.length) throw new Error(`pump.fun listing: all ${failures} page request(s) failed`);
    return rows;
  };
}

async function defaultFetchJson(url, { timeoutMs = 9_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; claude-co-executor)" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  } finally { clearTimeout(timer); }
}
