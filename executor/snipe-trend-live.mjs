/**
 * THE TREND LANE, WITH REAL MONEY (owner, 2026-09-30: "make the variants strat live and trading
 * on real money").
 *
 * What it trades is decided by the shadow (snipe-trend.mjs): when the paper lane enters a
 * launch of a strategy kind (SNIPE_TREND_KINDS, "variant" for the owner), this lane buys the
 * same coin for real. It then manages that position on EXACTLY the rule the paper record
 * measured (trendExitReason: -25% stop, the three-minute loser cut, the +30% trail, the hour
 * cap) plus one rule paper never needed — sell before the curve graduates, because a
 * graduated coin cannot leave through the curve and this path builds no pool route.
 *
 * Every buy and sell goes through the sniper's own signing port (snipe-execute.mjs): the same
 * wallet, the two-provider simulation, the reserve that keeps the exit paid for, the hard-stop
 * and pause sentinels, the Mac power boundary, and the one journal — so the two lanes can
 * never both hold one mint (the journal refuses a second entry intent), an unresolved intent
 * on either lane freezes new exposure on both, and every fill lands in the same rolling risk
 * the desk's brakes read.
 *
 * Its own limits, all small by default and all the owner's to change:
 *   ticketSol        SOL per buy (0.05, the paper ticket)
 *   maxOpen          positions open or being bought at once (2)
 *   maxDailyLossSol  realized trend-lane loss over 24h after which no new buy is made (0.15);
 *                    exits always continue
 *
 * Positions are written to disk after every change, so a restart resumes managing what is
 * open instead of forgetting it. Nothing here opens a connection: readers, the port, the
 * venue, the clock and the store are handed in, so the whole lane replays in a test.
 */
import { readAcrossEndpoints } from "./snipe-lane.mjs";
import { planSnipeCeiling } from "./snipe-entry.mjs";
import { TREND_DEFAULTS, trendExitReason, priceOfTrade } from "./snipe-trend.mjs";

export const TREND_LIVE_VERSION = "snipe-trend-live-v1";
const LAMPORTS = 1_000_000_000;

export const TREND_LIVE_DEFAULTS = Object.freeze({
  ticketSol: 0.05,
  maxOpen: 2,
  maxDailyLossSol: 0.15,
  /* A hard ceiling no dial can pass: this lane is a lottery ticket, not a position. */
  hardMaxTicketSol: 0.5,
  /* Room for the price to move between the read and the slot, taken from the QUANTITY, never
     added to the spend (snipe-entry.mjs planSnipeCeiling): the buy never costs more than the
     ticket. A launch two seconds old moves fast, so this is wider than the main lane's 3% — and
     no wider than 5%, because the room also comes off the sell-back, and at 10% a 0.05 SOL
     ticket's round trip (12.2%) failed the 12% cap on every rung. */
  entrySlippageBps: 500,
  maxPriceImpactPct: 5,
  maxEntryRoundTripLossPct: 12,
  /* A paper signal older than this when the buy would start is not the entry paper measured. */
  maxEntryLagMs: 15_000,
  /* pump.fun completes a curve at ~85 SOL of real reserve; leave before that. */
  graduationGuardSol: 75,
  /* With no trade heard for this long, the tick reads the curve itself for a price. */
  staleReadMs: 5_000,
  historyCap: 500,
});

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isRaw = (v) => /^\d+$/.test(String(v ?? ""));
const raw = (v) => (isRaw(v) ? BigInt(String(v)) : null);

/** Validate an owner's dials; throws with the dial's name on anything unusable. */
export function trendLiveConfig(over = {}) {
  const cfg = { ...TREND_LIVE_DEFAULTS, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined && v !== null)) };
  if (!(Number(cfg.ticketSol) > 0 && Number(cfg.ticketSol) <= cfg.hardMaxTicketSol))
    throw new Error(`SNIPE_TREND_TICKET_SOL=${cfg.ticketSol} must be above 0 and at most ${cfg.hardMaxTicketSol} SOL`);
  if (!(Number.isInteger(Number(cfg.maxOpen)) && cfg.maxOpen >= 1 && cfg.maxOpen <= 10))
    throw new Error(`SNIPE_TREND_MAX_OPEN=${cfg.maxOpen} must be a whole number from 1 to 10`);
  if (!(Number(cfg.maxDailyLossSol) > 0 && Number(cfg.maxDailyLossSol) <= 10))
    throw new Error(`SNIPE_TREND_MAX_DAILY_LOSS_SOL=${cfg.maxDailyLossSol} must be above 0 and at most 10 SOL`);
  return Object.freeze({ ...cfg, ticketSol: Number(cfg.ticketSol), maxOpen: Number(cfg.maxOpen),
    maxDailyLossSol: Number(cfg.maxDailyLossSol) });
}

/**
 * @param {object} a
 * @param {object} a.executor        snipe-execute.mjs port (prepareBuy, buy, sell)
 * @param {object} a.venue           the pump.fun venue (accountsFor, curveFromAccount, isComplete, quote*)
 * @param {object[]} a.readers       >= 2 {id, read(mint, addresses)} — the lane's own endpoints
 * @param {object} [a.holdingsReader] {read(mint) -> {qtyRaw}} — tells a failed sell from a gone position
 * @param {function} a.feeBps        () -> the venue's fee in bps, or null
 * @param {object} [a.cfg]           trendLiveConfig() dials
 * @param {object} [a.exitCfg]       the shadow's exit numbers (TREND_DEFAULTS), so both lanes leave alike
 * @param {function} [a.load]        () -> saved state or null
 * @param {function} [a.save]        (state) -> void, called after every change
 * @param {function} [a.onClose]     (row) -> void, each closed live trade
 */
export function createTrendLive({ executor, venue, readers, holdingsReader = null, feeBps = () => null,
  cfg: over = {}, exitCfg = TREND_DEFAULTS, clock = () => Date.now(), log = () => {},
  load = () => null, save = () => {}, onClose = () => {} } = {}) {
  if (!executor || typeof executor.buy !== "function" || typeof executor.sell !== "function" || typeof executor.prepareBuy !== "function")
    throw new Error("the live trend lane needs the sniper's signing port (SNIPE_LANE=execute on a live install)");
  if (!venue || typeof venue.accountsFor !== "function" || typeof venue.curveFromAccount !== "function")
    throw new Error("the live trend lane needs the pump.fun venue");
  if (!Array.isArray(readers) || readers.length < 2) throw new Error("the live trend lane needs two read endpoints");
  const cfg = trendLiveConfig(over);
  const exits = Object.freeze({ ...TREND_DEFAULTS, ...exitCfg });
  const positions = new Map();
  const pending = new Set();
  let closed = [];
  const counters = { signals: 0, entered: 0, exited: 0, reconciled: 0, entryFailures: 0, exitFailures: 0,
    skippedFull: 0, skippedLossStop: 0, skippedLate: 0 };
  let lastError = null;
  let ticking = false;

  /* ── persistence ── */
  function persist() {
    try {
      save({ version: TREND_LIVE_VERSION, savedAtMs: clock(), positions: [...positions.values()],
        closed: closed.slice(-cfg.historyCap) });
    } catch (error) { log(`trend live: could not save its book (${error?.message ?? error})`); }
  }
  try {
    const saved = load();
    if (isPlainObject(saved)) {
      for (const p of Array.isArray(saved.positions) ? saved.positions : []) {
        if (isPlainObject(p) && typeof p.mint === "string" && isRaw(p.qtyRaw) && isRaw(p.costBasisLamports)
            && Number(p.entryPrice) > 0)
          /* The saved price is from before the restart: lastPriceAtMs 0 makes the first tick
             read the curve rather than judge the position on a price nobody has checked. */
          positions.set(p.mint, { ...p, lastPriceAtMs: 0, wantExit: p.wantExit ?? null });
      }
      closed = (Array.isArray(saved.closed) ? saved.closed : []).filter((r) => isPlainObject(r) && Number.isFinite(Number(r.exitAtMs)));
      if (positions.size) log(`trend live: restored ${positions.size} open position(s) from disk — managing them again`);
    }
  } catch (error) { log(`trend live: saved book not read (${error?.message ?? error}) — starting empty`); }

  const setError = (where, error) => {
    lastError = Object.freeze({ atMs: clock(), where, clause: String(error?.clause ?? error?.name ?? "error"),
      message: String(error?.message ?? error).slice(0, 240) });
  };

  /* ── the loss stop ── */
  function realizedSince(sinceMs) {
    let sum = 0;
    for (const r of closed) if (Number(r.exitAtMs) >= sinceMs && Number.isFinite(Number(r.realizedSol))) sum += Number(r.realizedSol);
    return Math.round(sum * 1e9) / 1e9;
  }
  const lossStopActive = () => realizedSince(clock() - 86_400_000) <= -cfg.maxDailyLossSol;

  /* ── reading a curve ── */
  async function readCurve(mint) {
    const read = await readAcrossEndpoints({ readers, addresses: venue.accountsFor(mint), mint });
    if (read.verdict !== "agree" && read.verdict !== "single")
      throw Object.assign(new Error(`the two endpoints could not agree on the curve (${read.verdict})`), { clause: "curve_unreadable" });
    const curve = venue.curveFromAccount(read.accounts[0], { feeBps: feeBps(), mint });
    if (!curve) throw Object.assign(new Error("the curve could not be decoded"), { clause: "curve_unreadable" });
    return { read, curve };
  }
  const priceOfCurve = (curve) => {
    try { const q = Number(BigInt(curve.vQuoteRaw)), b = Number(BigInt(curve.vBaseRaw)); return q > 0 && b > 0 ? q / b : null; }
    catch { return null; }
  };
  const solOf = (lamportsRaw) => { try { return Number(BigInt(String(lamportsRaw))) / LAMPORTS; } catch { return null; } };
  const completeOf = (curve) => { try { return typeof venue.isComplete === "function" ? venue.isComplete(curve) : curve?.complete === true; } catch { return false; } };

  /* ── entry ── */
  async function buy(sig) {
    const mint = sig.mint;
    pending.add(mint);
    try {
      const { read, curve } = await readCurve(mint);
      if (completeOf(curve)) throw Object.assign(new Error("the curve has already graduated"), { clause: "refused" });
      const plan = planSnipeCeiling({
        curve, adapter: venue, solLamports: BigInt(Math.round(cfg.ticketSol * LAMPORTS)),
        cfg: { maxPriceImpactPct: cfg.maxPriceImpactPct, maxEntryRoundTripLossPct: cfg.maxEntryRoundTripLossPct,
          entrySlippageBps: cfg.entrySlippageBps },
      });
      if (!plan?.cleared || !plan.deliverable || !(plan.baseOutRaw > 0n) || !(plan.maxQuoteInRaw > 0n))
        throw Object.assign(new Error(`no buy clears the caps at ${cfg.ticketSol} SOL (impact ${plan?.impactPct ?? "?"}%, `
          + `round trip ${plan?.roundTripLossPct ?? "?"}%)`), { clause: "refused" });
      const prepared = executor.prepareBuy({ mint, curve, read, baseOutRaw: plan.baseOutRaw, maxQuoteInRaw: plan.maxQuoteInRaw });
      const fill = await executor.buy({ mint, curve, curveReadSlot: read.slot, prepared, creator: curve.creator ?? null,
        baseOutRaw: plan.baseOutRaw, maxQuoteInRaw: plan.maxQuoteInRaw });
      if (!fill || !(raw(fill.qtyRaw) > 0n) || !(raw(fill.quoteInRaw) > 0n))
        throw Object.assign(new Error("the port returned no usable fill — the journal holds the intent"), { clause: "ambiguous" });
      const fee = raw(fill.feeLamports) ?? 0n;
      const entryPrice = priceOfCurve(curve) ?? Number(sig.entryPrice);
      const now = clock();
      const pos = {
        mint, symbol: String(sig.symbol ?? ""), name: String(sig.name ?? ""), kind: sig.kind, key: sig.key ?? null,
        parent: { mint: sig.parent?.mint ?? null, symbol: sig.parent?.symbol ?? null },
        entryAtMs: Number(fill.confirmedAtMs) > 0 ? Number(fill.confirmedAtMs) : now,
        entryPrice, lastPrice: entryPrice, lastPriceAtMs: now, peak: entryPrice, armed: false,
        realQuoteSol: solOf(curve.realQuoteRaw),
        qtyRaw: String(fill.qtyRaw), entryInputLamports: String(fill.quoteInRaw), entryFeeLamports: String(fee),
        costBasisLamports: String(raw(fill.quoteInRaw) + fee), entrySignature: fill.signature ?? null,
        wantExit: null, exitError: null, exitAttempts: 0,
      };
      positions.set(mint, pos);
      counters.entered++;
      persist();
      log(`trend LIVE ${pos.symbol} (${pos.kind} of ${pos.parent.symbol}): BOUGHT ${pos.qtyRaw} base for `
        + `${pos.entryInputLamports} lamports + ${fee} fee, sig ${pos.entrySignature ?? "?"}`);
    } catch (error) {
      counters.entryFailures++;
      setError("entry", error);
      log(`trend LIVE ${sig.symbol ?? mint}: entry not made (${error?.clause ?? error?.name ?? "error"}: ${error?.message ?? error})`);
    } finally { pending.delete(mint); }
  }

  /** The shadow's entry signal. Returns what it decided, for the log and the test. */
  function onSignal(sig) {
    if (!isPlainObject(sig) || typeof sig.mint !== "string" || sig.strategy !== true) return "not_strategy";
    counters.signals++;
    if (positions.has(sig.mint) || pending.has(sig.mint)) return "held";
    if (positions.size + pending.size >= cfg.maxOpen) { counters.skippedFull++; return "full"; }
    if (lossStopActive()) {
      counters.skippedLossStop++;
      if (counters.skippedLossStop === 1 || counters.skippedLossStop % 20 === 0)
        log(`trend LIVE: loss stop — ${realizedSince(clock() - 86_400_000)} SOL over 24h reached the `
          + `-${cfg.maxDailyLossSol} SOL limit; no new trend buys until it rolls off (exits continue)`);
      return "loss_stop";
    }
    if (clock() - Number(sig.entryAtMs) > cfg.maxEntryLagMs) { counters.skippedLate++; return "late"; }
    void buy(sig);
    return "buying";
  }

  /** A trade on a held mint: the fastest price there is. */
  function onTrade(ev, atMs = clock()) {
    const pos = positions.get(ev?.mint);
    if (!pos) return;
    const price = priceOfTrade(ev);
    if (!(price > 0)) return;
    pos.lastPrice = price; pos.lastPriceAtMs = atMs;
    const rq = solOf(ev.realQuoteRaw);
    if (rq !== null) pos.realQuoteSol = rq;
    if (!pos.wantExit) pos.wantExit = exitReasonFor(pos, atMs);
  }

  function exitReasonFor(pos, nowMs) {
    if (Number(pos.realQuoteSol) >= cfg.graduationGuardSol)
      return `graduation guard: ${Number(pos.realQuoteSol).toFixed(1)} SOL on the curve, selling before it completes`;
    return trendExitReason(pos, nowMs, exits);
  }

  async function walletHoldsNothing(mint) {
    if (!holdingsReader || typeof holdingsReader.read !== "function") return false;
    try {
      const answer = await holdingsReader.read(mint);
      return isRaw(answer?.qtyRaw) && BigInt(String(answer.qtyRaw)) === 0n;
    } catch { return false; }
  }

  function closePosition(pos, { reason, now, fill = null, reconciled = false }) {
    positions.delete(pos.mint);
    const quoteOut = raw(fill?.quoteOutRaw);
    const fee = raw(fill?.feeLamports) ?? 0n;
    const basis = raw(pos.costBasisLamports) ?? 0n;
    const realized = quoteOut === null ? null : quoteOut - fee - basis;
    const row = Object.freeze({
      version: TREND_LIVE_VERSION, mode: "live", mint: pos.mint, symbol: pos.symbol, name: pos.name, kind: pos.kind,
      parent: pos.parent, entryAtMs: pos.entryAtMs, exitAtMs: now, holdMs: now - pos.entryAtMs, reason,
      entrySignature: pos.entrySignature, exitSignature: fill?.signature ?? null,
      costBasisLamports: pos.costBasisLamports, quoteOutRaw: quoteOut === null ? null : String(quoteOut),
      exitFeeLamports: String(fee), realizedLamports: realized === null ? null : String(realized),
      realizedSol: realized === null ? null : Number(realized) / LAMPORTS,
      peakX: Math.round((pos.peak / pos.entryPrice) * 10_000) / 10_000,
      exitX: Math.round((pos.lastPrice / pos.entryPrice) * 10_000) / 10_000,
      reconciled,
    });
    closed.push(row);
    if (closed.length > cfg.historyCap) closed = closed.slice(-cfg.historyCap);
    persist();
    try { onClose(row); } catch { /* a sink that throws must not stop the lane */ }
    return row;
  }

  async function manage(pos, now) {
    /* A price nobody has heard for a while is read from the curve itself. */
    let fresh = null;
    if (!(now - Number(pos.lastPriceAtMs) < cfg.staleReadMs)) {
      try {
        fresh = await readCurve(pos.mint);
        const p = priceOfCurve(fresh.curve);
        if (p > 0) { pos.lastPrice = p; pos.lastPriceAtMs = now; }
        const rq = solOf(fresh.curve.realQuoteRaw);
        if (rq !== null) pos.realQuoteSol = rq;
      } catch { /* blind is not a sell signal; the clock below still decides */ }
    }
    const reason = pos.wantExit ?? exitReasonFor(pos, now);
    if (!reason) return;
    /* A SELL THAT KEEPS FAILING IS RETRIED ON A BACKOFF (2s, 4s ... 30s), not every tick: two
       simulations a second against the same refusal only spends the providers' patience, and a
       send that lands and fails costs a network fee each time. */
    if (Number(pos.nextExitAtMs) > now) return;
    pos.wantExit = reason;
    let fill = null;
    try {
      const { read, curve } = fresh ?? await readCurve(pos.mint);
      fill = await executor.sell({ mint: pos.mint, curve, curveReadSlot: read.slot, qtyRaw: pos.qtyRaw,
        position: { costBasisLamports: pos.costBasisLamports, entryInputLamports: pos.entryInputLamports,
          entryFeeLamports: pos.entryFeeLamports }, reason });
    } catch (error) {
      counters.exitFailures++;
      pos.exitAttempts = Number(pos.exitAttempts || 0) + 1;
      pos.nextExitAtMs = now + Math.min(30_000, 1_000 * 2 ** Math.min(pos.exitAttempts, 5));
      pos.exitError = `${error?.clause ?? error?.name ?? "error"}: ${String(error?.message ?? error).slice(0, 200)}`;
      setError("exit", error);
      if (await walletHoldsNothing(pos.mint)) {
        counters.reconciled++;
        closePosition(pos, { reason: `reconciled: the wallet holds none of it (last sell: ${pos.exitError})`, now, reconciled: true });
        log(`trend LIVE ${pos.symbol}: RECONCILED — the wallet holds none of it; closed without a realized figure`);
        return;
      }
      persist();
      if (pos.exitAttempts === 1 || pos.exitAttempts % 10 === 0)
        log(`trend LIVE ${pos.symbol}: EXIT FAILED (${pos.exitError}) — kept, retried every tick`
          + (/graduated/.test(pos.exitError) ? "; the coin has GRADUATED — sell it by hand in a wallet app" : ""));
      return;
    }
    counters.exited++;
    const row = closePosition(pos, { reason, now, fill });
    log(`trend LIVE ${pos.symbol}: SOLD — ${reason}; ${row.quoteOutRaw ?? "?"} lamports back, realized `
      + `${row.realizedSol === null ? "?" : row.realizedSol.toFixed(6)} SOL, sig ${row.exitSignature ?? "?"}`);
  }

  /** Every lane tick: price what is held and sell what a rule says to. One tick at a time. */
  async function tick(nowMs = clock()) {
    if (ticking) return;
    ticking = true;
    try {
      for (const pos of [...positions.values()]) {
        try { await manage(pos, nowMs); }
        catch (error) { setError("tick", error); log(`trend LIVE ${pos.symbol}: tick failed — ${error?.message ?? error}`); }
      }
    } finally { ticking = false; }
  }

  function stats() {
    const now = clock();
    const realizedRows = closed.filter((r) => Number.isFinite(Number(r.realizedSol)));
    const wins = realizedRows.filter((r) => r.realizedSol > 0).length;
    return Object.freeze({
      mode: "live", version: TREND_LIVE_VERSION,
      ticketSol: cfg.ticketSol, maxOpen: cfg.maxOpen, maxDailyLossSol: cfg.maxDailyLossSol,
      ...counters,
      pending: pending.size,
      open: [...positions.values()].map((p) => Object.freeze({
        mint: p.mint, symbol: p.symbol, parent: p.parent?.symbol ?? null, kind: p.kind,
        x: p.entryPrice > 0 ? Math.round((p.lastPrice / p.entryPrice) * 1000) / 1000 : null,
        heldMs: now - Number(p.entryAtMs), exiting: Boolean(p.wantExit), exitError: p.exitError ?? null })),
      closed: closed.length, wins, losses: realizedRows.length - wins,
      realized24hSol: realizedSince(now - 86_400_000),
      realizedSumSol: Math.round(realizedRows.reduce((a, r) => a + r.realizedSol, 0) * 1e9) / 1e9,
      lossStop: lossStopActive(),
      lastError,
      recent: closed.slice(-8).reverse().map((r) => ({ symbol: r.symbol, parent: r.parent?.symbol ?? null, kind: r.kind,
        realizedSol: r.realizedSol, reason: String(r.reason).slice(0, 60), exitAtMs: r.exitAtMs })),
    });
  }

  return Object.freeze({
    version: TREND_LIVE_VERSION, cfg,
    onSignal, onTrade, tick, stats,
    holds: (mint) => positions.has(mint) || pending.has(mint),
    openPositions: () => [...positions.values()].map((p) => ({ ...p })),
  });
}
