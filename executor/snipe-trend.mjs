/**
 * THE TREND LANE — buy the coins a runaway coin inspires, not the runaway coin itself.
 *
 * The owner's thesis (2026-09-28): when a pump.fun coin goes to millions within hours, people
 * launch coins RELATED to it — parodies, spin-offs, sub-topics — and those ride the trend. Not
 * copies: a clone with the same name or ticker is a different bet (it competes with the parent
 * for the same buyers) and is left out on purpose.
 *
 * What the data said before this was built, from pump.fun's own listing (49 parents that
 * reached $1M+ within a day, 40 related launches against 1,009 others in the same 29 minutes):
 * the related coins were NOT a 75% winner — most died exactly like any launch — but the big
 * outcomes were two to three times more common among them (7.5% reached ~$30k against 3.4%;
 * 7.5% graduated against 2.6%). That shape is a lottery, so this lane is built like one:
 *
 *   1. PARENTS. Every few minutes, pump.fun's listing by market cap is read, and a coin whose
 *      all-time-high market cap reached `minParentMcapUsd` within `maxHoursToReach` of its
 *      launch — and did so within the last `parentActiveMs` — is a parent. Pure: see
 *      parentsFromListing.
 *   2. RELATED LAUNCHES. Every new launch's name and ticker, which arrive IN the create event
 *      and so cost nothing to read, are matched against every parent's keys: its ticker, the
 *      distinctive words of its name (and of its ticker split on case and digits), and the
 *      capitalised words of its description. A match is a VARIANT (the launch carries the
 *      parent's ticker or name with something added: "Baby Cali", "NIKE 2.0", "cat wif hat")
 *      or a SUBTOPIC (it shares a distinctive word: "Kitten Wif Sword" under "cat wif sword",
 *      "Maye Musk" under a coin whose description names her). An exact clone — same ticker or
 *      same name as the parent — is counted and skipped. A key that suddenly matches a large
 *      share of all launches ("trump" on some days) is treated as generic and ignored, so one
 *      broad word cannot turn the lane into "buy everything".
 *   3. LOTTERY EXITS. Small ticket. A hard stop well below entry. A loser that has not moved
 *      by `loserMinX` inside `loserTimeMs` is cut. A winner that reaches `trailArmX` is not
 *      sold at a fixed target: it rides, and leaves only when it falls `1 - trailFrac` from
 *      its own peak. A maximum hold closes anything left.
 *   4. SHADOW FIRST. In `shadow` mode nothing is signed. Each related launch is "bought" at
 *      the price the curve showed `entryDelayMs` after its create event — the latency a real
 *      buy would have — and followed trade by trade off the same gRPC stream the volume tape
 *      uses, with pump.fun's fees and the network cost charged on both legs. The closed rows
 *      are the evidence the owner decides on; switching this lane to real money is a separate
 *      change made after reading them.
 *
 * Nothing in this file signs, holds a key, or opens a connection: listing rows, create events
 * and trade events are handed in, and every clock is injected, so the whole lane replays.
 */

export const SNIPE_TREND_VERSION = "snipe-trend-v1";
export const TREND_MODES = Object.freeze(["off", "shadow"]);

export const TREND_DEFAULTS = Object.freeze({
  /* Parents. */
  minParentMcapUsd: 1_000_000,
  maxHoursToReach: 12,
  /* How long a parent stays "trending" after its all-time high: a day. */
  parentActiveMs: 24 * 3_600_000,
  refreshMs: 5 * 60_000,
  listingPages: 4,
  /* A key matching more launches than this in the last hour is generic, not a trend. */
  genericPerHour: 25,
  /* Entry. */
  entryDelayMs: 2_000,
  ticketSol: 0.05,
  /* Exits. */
  stopFrac: 0.75,          // out at -25% from entry
  loserTimeMs: 180_000,    // after 3 minutes...
  loserMinX: 1.10,         // ...a coin that never reached +10% is cut
  trailArmX: 1.30,         // at +30% the winner starts to ride
  trailFrac: 0.75,         // and leaves once it falls 25% from its own peak
  maxHoldMs: 60 * 60_000,
  /* Costs, per leg: pump.fun's protocol plus creator fee, and the network. */
  feeBpsPerLeg: 125,
  networkSolPerLeg: 0.0001,
  /* Bounds. */
  maxTracked: 500,
  historyCap: 1_000,
});

/* pump.fun's opening curve: 30 SOL of virtual quote against 1,073,000,000 tokens (6 decimals).
   The price a launch shows before its first trade, in the same raw units a TradeEvent carries. */
export const PUMPFUN_OPEN_PRICE = 30_000_000_000 / 1_073_000_000_000_000;

/* Words too common in pump.fun names to mean anything on their own. */
const GENERIC = new Set(`
the a an of and for to in on is it at by or as be my me we you your our its this that with from
coin coins token tokens sol solana pump fun pumpfun inu dog doge cat baby official real new ai meme memes
usd usa united states national american america world global digital fund reserve protocol project
king queen lord lady man woman boy girl moon mars sun star life love money cash rich just like make
more most best good bad big little mini super mega ultra first last only one two three next
community capital network finance chain labs dao dex swap bank market trade trading
walk fees fee long short gain gains pay paid hold buy sell send perps perp based tokenized control
powered supply account accounts strategic currency bridge oil water gold silver dividend asset assets
game games play time day night today people free open launch launched discord telegram twitter
`.split(/\s+/).filter(Boolean));

const FAMILY = /\b(baby|mini|lil|little|son|daughter|wife|husband|mom|dad|mama|papa|brother|sister|jr|junior|kid)\b/;
const SEQUEL = /(\b2\.0\b|\bv2\b|\bii\b|\b2\b|\bnext\b|\breturns?\b|\bagain\b)/;
const WIF = /\bwif\b/;
const PARODY = /\b(anti|fake|evil|dark|reverse|not|real|based|poor|broke|drunk|sad|angry|gay|chad|beta)\b/;

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (s) => String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Split a ticker on case changes and digit runs: "MrBeast" -> mr, beast; "GTA6" -> gta, 6. */
function tickerParts(symbol) {
  return String(symbol ?? "").replace(/^\$+/, "")
    .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])|[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase()).filter(Boolean);
}

/**
 * A parent's keys, each tagged with where it came from. `strong` keys (ticker, whole name)
 * make a launch a VARIANT when they appear inside it; `word` keys (distinctive words of the
 * name and ticker parts) and `desc` keys (capitalised words of the description) make it a
 * SUBTOPIC when they appear as a word of it.
 */
export function trendKeys({ name, symbol, description } = {}) {
  const keys = new Map();   // key -> source
  const add = (k, source) => {
    if (!k || k.length < 3 || GENERIC.has(k) || /^[0-9]+$/.test(k)) return;
    if (!keys.has(k) || source === "strong") keys.set(k, source);
  };
  const sym = norm(symbol);
  if (sym.length >= 3 && !GENERIC.has(sym)) add(sym, "strong");
  const whole = norm(name);
  if (whole.length >= 5 && whole !== sym) add(whole, "strong");
  for (const w of words(name)) if (w.length >= 4) add(w, "word");
  for (const p of tickerParts(symbol)) if (p.length >= 3) add(p, "word");
  const caps = String(description ?? "").match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? [];
  for (const c of caps.slice(0, 8)) add(c.toLowerCase(), "desc");
  return keys;
}

/** Parents from pump.fun listing rows (sort=market_cap). Pure. */
export function parentsFromListing(rows, { nowMs, cfg = TREND_DEFAULTS } = {}) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(r) || typeof r.mint !== "string") continue;
    const created = Number(r.created_timestamp);
    const ath = Number(r.ath_market_cap ?? r.usd_market_cap);
    const athAt = Number(r.ath_market_cap_timestamp);
    if (!(created > 0) || !(ath >= cfg.minParentMcapUsd) || !(athAt >= created)) continue;
    const hoursToReach = (athAt - created) / 3_600_000;
    if (hoursToReach > cfg.maxHoursToReach) continue;
    if (Number.isFinite(nowMs) && nowMs - athAt > cfg.parentActiveMs) continue;
    if (out.has(r.mint)) continue;
    out.set(r.mint, Object.freeze({
      mint: r.mint, name: String(r.name ?? ""), symbol: String(r.symbol ?? ""),
      athUsd: ath, athAtMs: athAt, createdAtMs: created,
      hoursToReach: Math.round(hoursToReach * 10) / 10,
      keys: trendKeys({ name: r.name, symbol: r.symbol, description: r.description }),
    }));
  }
  return [...out.values()];
}

/**
 * Is this launch related to a trending parent? Returns the best match or null.
 *   { clone: true, parent }                                  — same ticker or name: skipped
 *   { kind: "variant"|"subtopic", parent, key, pattern }     — related
 * `isGeneric(key)` lets the caller withdraw keys that are matching too much.
 */
export function matchLaunch({ mint, name, symbol } = {}, parents = [], { isGeneric = () => false, createdAtMs = null } = {}) {
  const nSym = norm(symbol), nName = norm(name);
  const launchWords = new Set([...words(name), ...tickerParts(symbol)]);
  const text = `${String(name ?? "").toLowerCase()} ${String(symbol ?? "").toLowerCase()}`;
  let best = null;
  for (const p of parents) {
    if (!p || p.mint === mint) continue;
    if (Number.isFinite(createdAtMs) && Number.isFinite(p.createdAtMs) && createdAtMs < p.createdAtMs) continue;
    const pSym = norm(p.symbol), pName = norm(p.name);
    if ((nSym && nSym === pSym) || (nName && nName.length >= 3 && nName === pName)) {
      if (!best) best = { clone: true, parent: p };
      continue;
    }
    for (const [key, source] of p.keys) {
      if (isGeneric(key)) continue;
      let kind = null;
      /* A short key (three letters, like "phi") only counts as a whole word: as a substring it
         is inside "Philly" and "aphiro", which are not about the parent at all. */
      if (source === "strong" && key.length >= 4 && (nSym.includes(key) || nName.includes(key))) kind = "variant";
      else if (launchWords.has(key)) kind = source === "strong" ? "variant" : "subtopic";
      if (!kind) continue;
      const pattern = FAMILY.test(text) ? "family" : SEQUEL.test(text) ? "sequel" : WIF.test(text) ? "wif"
        : PARODY.test(text) ? "parody" : kind === "variant" ? "remix" : "theme";
      const rank = kind === "variant" ? 2 : 1;
      if (!best || best.clone || rank > (best.kind === "variant" ? 2 : 1) ||
          (rank === (best.kind === "variant" ? 2 : 1) && p.athUsd > best.parent.athUsd))
        best = { kind, parent: p, key, pattern };
      break;
    }
  }
  return best ? Object.freeze(best) : null;
}

/** The curve's price after a trade, in raw quote per raw base. Null when it cannot be read. */
export function priceOfTrade(ev) {
  if (!isPlainObject(ev) || ev.quoteUsable === false) return null;
  try {
    const q = Number(BigInt(ev.vQuoteRaw)), b = Number(BigInt(ev.vBaseRaw));
    return q > 0 && b > 0 ? q / b : null;
  } catch { return null; }
}

/** Net return of a round trip at `exitX` times the entry price, after both legs' costs. */
export function netReturn(exitX, cfg = TREND_DEFAULTS) {
  const fee = Number(cfg.feeBpsPerLeg) / 10_000;
  const network = 2 * Number(cfg.networkSolPerLeg) / Number(cfg.ticketSol);
  return exitX * (1 - fee) * (1 - fee) - 1 - network;
}

/**
 * The shadow lane: parents in, create and trade events in, closed would-have trades out.
 *
 *   parents()                    — the detector's current parents
 *   onCreate(event, atMs)        — a create event (name, symbol, mint)
 *   onTrade(event, atMs)         — a trade event (mint, vQuoteRaw, vBaseRaw)
 *   tick(nowMs)                  — entries that are due, and time-based exits
 *   onClose(row)                 — each closed row, e.g. to a JSONL sink
 */
export function createTrendShadow({ parents = () => [], cfg: override = {}, clock = () => Date.now(),
  log = () => {}, onClose = () => {} } = {}) {
  const cfg = Object.freeze({ ...TREND_DEFAULTS, ...override });
  const tracked = new Map();        // mint -> position (pending or entered)
  const history = [];               // closed rows, newest last
  const keyHits = new Map();        // key -> [atMs...] launches it matched in the last hour
  const counters = { launches: 0, clones: 0, matched: 0, entered: 0, closed: 0, dropped: 0, generic: 0, trades: 0 };

  const isGeneric = (key) => {
    const hits = keyHits.get(key);
    if (!hits) return false;
    const cutoff = clock() - 3_600_000;
    while (hits.length && hits[0] < cutoff) hits.shift();
    return hits.length >= cfg.genericPerHour;
  };

  function close(pos, reason, nowMs) {
    tracked.delete(pos.mint);
    const exitX = pos.lastPrice / pos.entryPrice;
    const net = netReturn(exitX, cfg);
    const row = Object.freeze({
      version: SNIPE_TREND_VERSION, mode: "shadow",
      mint: pos.mint, name: pos.name, symbol: pos.symbol,
      parent: { mint: pos.parent.mint, symbol: pos.parent.symbol, name: pos.parent.name, athUsd: Math.round(pos.parent.athUsd) },
      kind: pos.kind, key: pos.key, pattern: pos.pattern,
      noticeAtMs: pos.noticeAtMs, entryAtMs: pos.entryAtMs, exitAtMs: nowMs,
      holdMs: nowMs - pos.entryAtMs, reason,
      entryPrice: pos.entryPrice, exitPrice: pos.lastPrice,
      exitX: Math.round(exitX * 10_000) / 10_000, peakX: Math.round((pos.peak / pos.entryPrice) * 10_000) / 10_000,
      netPct: Math.round(net * 10_000) / 100, pnlSol: Math.round(net * cfg.ticketSol * 1e6) / 1e6,
      trades: pos.trades, ticketSol: cfg.ticketSol,
    });
    history.push(row);
    while (history.length > cfg.historyCap) history.shift();
    counters.closed++;
    log(`trend shadow ${pos.symbol} (${pos.kind} of ${pos.parent.symbol} via "${pos.key}"): ${reason} at ${row.exitX}x, `
      + `peak ${row.peakX}x, net ${row.netPct}% (${row.pnlSol} SOL on ${cfg.ticketSol})`);
    try { onClose(row); } catch { /* a sink that throws must not stop the lane */ }
    return row;
  }

  function checkExits(pos, nowMs) {
    if (!pos.entered || !(pos.lastPrice > 0)) return null;
    const x = pos.lastPrice / pos.entryPrice;
    if (pos.lastPrice > pos.peak) pos.peak = pos.lastPrice;
    const peakX = pos.peak / pos.entryPrice;
    if (x <= cfg.stopFrac) return close(pos, `stop: ${Math.round((1 - cfg.stopFrac) * 100)}% under entry`, nowMs);
    if (!pos.armed && peakX >= cfg.trailArmX) pos.armed = true;
    if (pos.armed && pos.lastPrice <= pos.peak * cfg.trailFrac)
      return close(pos, `trail: ${Math.round((1 - cfg.trailFrac) * 100)}% off a ${peakX.toFixed(2)}x peak`, nowMs);
    const held = nowMs - pos.entryAtMs;
    if (!pos.armed && held >= cfg.loserTimeMs && peakX < cfg.loserMinX)
      return close(pos, `loser: under ${cfg.loserMinX}x after ${Math.round(cfg.loserTimeMs / 1000)}s`, nowMs);
    if (held >= cfg.maxHoldMs) return close(pos, `max hold ${Math.round(cfg.maxHoldMs / 60_000)}m`, nowMs);
    return null;
  }

  return {
    version: SNIPE_TREND_VERSION,
    cfg,

    onCreate(event, atMs = clock()) {
      if (!isPlainObject(event) || typeof event.mint !== "string" || tracked.has(event.mint)) return null;
      counters.launches++;
      let ps = [];
      try { ps = parents() ?? []; } catch { ps = []; }
      if (!ps.length) return null;
      const m = matchLaunch(event, ps, { isGeneric, createdAtMs: atMs });
      if (!m) return null;
      if (m.clone) { counters.clones++; return m; }
      const hits = keyHits.get(m.key) ?? [];
      hits.push(atMs); keyHits.set(m.key, hits);
      if (isGeneric(m.key)) { counters.generic++; return null; }
      if (tracked.size >= cfg.maxTracked) { counters.dropped++; return null; }
      counters.matched++;
      tracked.set(event.mint, {
        mint: event.mint, name: String(event.name ?? ""), symbol: String(event.symbol ?? ""),
        parent: m.parent, kind: m.kind, key: m.key, pattern: m.pattern,
        noticeAtMs: atMs, entryDueMs: atMs + cfg.entryDelayMs,
        entered: false, entryAtMs: null, entryPrice: null,
        lastPrice: null, peak: 0, armed: false, trades: 0,
      });
      log(`trend match ${event.symbol} "${event.name}" — ${m.kind} (${m.pattern}) of ${m.parent.symbol} `
        + `($${Math.round(m.parent.athUsd / 1e6 * 10) / 10}M in ${m.parent.hoursToReach}h) via "${m.key}"`);
      return m;
    },

    onTrade(event, atMs = clock()) {
      if (!isPlainObject(event)) return;
      const pos = tracked.get(event.mint);
      if (!pos) return;
      const price = priceOfTrade(event);
      if (!(price > 0)) return;
      counters.trades++;
      pos.lastPrice = price; pos.trades++;
      if (pos.entered) checkExits(pos, atMs);
    },

    tick(nowMs = clock()) {
      for (const pos of [...tracked.values()]) {
        if (!pos.entered) {
          if (nowMs < pos.entryDueMs) continue;
          pos.entered = true; pos.entryAtMs = nowMs;
          pos.entryPrice = pos.lastPrice > 0 ? pos.lastPrice : PUMPFUN_OPEN_PRICE;
          if (!(pos.lastPrice > 0)) pos.lastPrice = pos.entryPrice;
          pos.peak = pos.entryPrice;
          counters.entered++;
          continue;
        }
        checkExits(pos, nowMs);
      }
    },

    open() { return [...tracked.values()].filter((p) => p.entered).map((p) => Object.freeze({
      mint: p.mint, symbol: p.symbol, parent: p.parent.symbol, kind: p.kind,
      x: Math.round((p.lastPrice / p.entryPrice) * 1000) / 1000, heldMs: clock() - p.entryAtMs })); },
    history() { return history.slice(); },

    stats() {
      const rows = history;
      const wins = rows.filter((r) => r.pnlSol > 0).length;
      const pnl = rows.reduce((a, r) => a + r.pnlSol, 0);
      const byKind = {};
      for (const r of rows) {
        const k = (byKind[r.kind] ??= { n: 0, wins: 0, pnlSol: 0 });
        k.n++; k.wins += r.pnlSol > 0 ? 1 : 0; k.pnlSol = Math.round((k.pnlSol + r.pnlSol) * 1e6) / 1e6;
      }
      let ps = [];
      try { ps = parents() ?? []; } catch { ps = []; }
      return Object.freeze({
        mode: "shadow", version: SNIPE_TREND_VERSION, ticketSol: cfg.ticketSol,
        parents: ps.length,
        topParents: ps.slice().sort((a, b) => b.athUsd - a.athUsd).slice(0, 5)
          .map((p) => ({ symbol: p.symbol, athUsd: Math.round(p.athUsd), hoursToReach: p.hoursToReach })),
        ...counters,
        open: [...tracked.values()].filter((p) => p.entered).length,
        wins, losses: rows.length - wins,
        winRate: rows.length ? Math.round((wins / rows.length) * 1000) / 10 : null,
        pnlSol: Math.round(pnl * 1e6) / 1e6,
        bestPct: rows.length ? Math.max(...rows.map((r) => r.netPct)) : null,
        worstPct: rows.length ? Math.min(...rows.map((r) => r.netPct)) : null,
        byKind,
        recent: rows.slice(-8).reverse().map((r) => ({ symbol: r.symbol, parent: r.parent.symbol, kind: r.kind,
          netPct: r.netPct, peakX: r.peakX, reason: r.reason.slice(0, 60), exitAtMs: r.exitAtMs })),
      });
    },
  };
}

/**
 * The parent detector: reads pump.fun's listing on a timer and keeps the current parents.
 * `fetchRows(page)` is injected (the poller hands it a fetch against PUMPFUN_LIST_ORIGIN).
 * A failed refresh keeps the last good parents — a trend does not end because one request did.
 */
export function createTrendDetector({ fetchRows, cfg: override = {}, clock = () => Date.now(), log = () => {} } = {}) {
  if (typeof fetchRows !== "function") throw new TypeError("createTrendDetector needs fetchRows(page)");
  const cfg = Object.freeze({ ...TREND_DEFAULTS, ...override });
  let current = [];
  let lastRefreshAtMs = null, lastError = null, refreshes = 0, failures = 0;
  let timer = null;

  async function refresh() {
    try {
      const rows = [];
      for (let page = 0; page < cfg.listingPages; page++) {
        const got = await fetchRows(page);
        if (!Array.isArray(got) || !got.length) break;
        rows.push(...got);
      }
      const next = parentsFromListing(rows, { nowMs: clock(), cfg });
      const was = new Set(current.map((p) => p.mint));
      for (const p of next) if (!was.has(p.mint))
        log(`trend PARENT ${p.symbol} "${p.name}" — $${Math.round(p.athUsd / 1e6 * 10) / 10}M ATH ${p.hoursToReach}h after launch`);
      if (rows.length) current = next;
      lastRefreshAtMs = clock(); refreshes++; lastError = null;
    } catch (error) {
      failures++; lastError = String(error?.message ?? error).slice(0, 160);
      log(`trend parent refresh failed (${lastError}) — keeping the last ${current.length} parents`);
    }
    return current;
  }

  return {
    parents: () => current,
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => { void refresh(); }, cfg.refreshMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    stats: () => ({ parents: current.length, lastRefreshAtMs, refreshes, failures, lastError }),
  };
}
