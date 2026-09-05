/**
 * THE SIMULATOR — what the risk engine actually does to a stream of calls.
 *
 * Runs strategy.mjs (the same code the bot trades with) over synthetic but
 * deliberately UNFLATTERING memecoin price paths, tick by tick, so stops and
 * trails trigger path-dependently the way they would live.
 *
 * The honest framing, stated up front because it is the whole point:
 *   This does NOT prove the bot makes money. Profit comes from the desk's call
 *   quality — the hit rate and the size of the winners — which is an empirical
 *   question no simulation can answer for you. What this DOES measure is what
 *   the risk engine contributes GIVEN a call quality: it runs the same call
 *   stream through a naive bot (buy, hold until the desk says exit) and the
 *   risk-managed bot (stop, scale, trail, brakes), and reports the difference.
 *   That difference is the part the bot is responsible for.
 *
 * Price model: memecoins are fat-tailed and mostly go down. Each call draws an
 * outcome class, then walks a path to it with heavy noise, so a token that ends
 * +400% may still have dipped through its stop first — which is exactly the
 * case that flatters naive backtests and ruins real accounts.
 *
 *   node simulate.mjs [--trials 400] [--calls 60] [--winrate 0.28] [--seed 7]
 */
import { DEFAULTS, planEntry, openPosition, stepPosition, rollDay, freshState } from "./strategy.mjs";

// deterministic RNG so a reported number can be reproduced
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** One call's price path: [p0, p1, ...] over `steps` polls. */
function makePath(rand, { steps = 240, winrate = 0.28 } = {}) {
  const u = rand();
  // Outcome classes, roughly the shape of live memecoin call outcomes:
  //   rug/fade (most), chop, modest winner, runner (rare, carries the tail)
  let endMul;
  if (u < 0.34) endMul = 0.05 + rand() * 0.25;                 // rug / bleed to near zero
  else if (u < 1 - winrate) endMul = 0.45 + rand() * 0.45;      // fade
  else if (u < 1 - winrate * 0.22) endMul = 1.15 + rand() * 1.1; // modest winner
  else endMul = 2.5 + rand() * 9;                               // runner (the tail)

  const drift = Math.log(endMul) / steps;
  const vol = 0.055 + rand() * 0.05;                            // memecoin-grade noise
  const path = [1];
  for (let i = 1; i <= steps; i++) {
    // box-muller
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    path.push(Math.max(1e-6, path[i - 1] * Math.exp(drift + vol * z)));
  }
  return path;
}

/** Where the desk would publish its exit: a fixed horizon, or when its own
 *  stop/target is breached and the monitor catches it (with a realistic lag). */
function deskExitStep(path, stop, target, lag) {
  for (let i = 1; i < path.length; i++) {
    if (path[i] <= stop || (target != null && path[i] >= target))
      return Math.min(path.length - 1, i + lag);
  }
  return path.length - 1;
}

function runOne({ managed, calls, rand, cfg, deskLag }) {
  const state = freshState(0);
  let realized = 0, wins = 0, losses = 0, stopped = 0, scaled = 0, taken = 0, skippedByCaps = 0;
  let peak = 0, equity = 0, maxDD = 0;

  for (let n = 0; n < calls; n++) {
    const path = makePath(rand, { winrate: cfg._winrate });
    const entry = path[0];
    const stop = entry * 0.62;                 // the desk's published stop
    const target = entry * 1.9;                // and its target
    const call = { mint: "m" + n, symbol: "C" + n, size_sol: cfg.maxSolPerTrade, stop, target, ts: n };

    // Calls arrive over TIME. Feeding the engine a fake never-rolling day meant the
    // 0.5 SOL rolling deploy cap filled after 10 trades and skipped the rest
    // of the run — the sample was a tenth of what the header claimed. Space calls
    // CALL_GAP_H apart and roll the day properly.
    const now = n * CALL_GAP_H * 3600e3;
    rollDay(state, now, 86400e3);
    const plan = planEntry({ call, cfg, state });
    if (plan.action !== "buy") { skippedByCaps++; continue; }
    taken++;

    state.deployedTodaySol += plan.sol;
    state.openCount++;
    const pos = openPosition({ call, sol: plan.sol, fillPrice: entry, cfg });
    const exitAt = deskExitStep(path, stop, target, deskLag);

    let qty = pos.qty, pnl = 0, done = false;
    for (let i = 1; i < path.length && !done; i++) {
      const mark = path[i];
      const deskExit = i >= exitAt ? { code: "desk" } : null;

      if (!managed) {
        // The naive bot: no local risk at all. It holds until the desk speaks.
        if (deskExit) { pnl += qty * mark; qty = 0; done = true; }
        continue;
      }
      const d = stepPosition({ pos, mark, deskExit, cfg });
      if (d.action === "sell") {
        pnl += qty * mark; qty = 0; done = true;
        if (d.reason.startsWith("stop")) stopped++;
      } else if (d.action === "sell_part") {
        const part = qty * d.fraction;
        pnl += part * mark; qty -= part; scaled++;
      }
    }
    if (qty > 0) pnl += qty * path[path.length - 1];
    pnl *= (1 - COST);                       // pay to get out
    const net = pnl - plan.sol * (1 + COST); // and pay to get in
    realized += net;
    state.realizedTodaySol += net;
    state.openCount--;
    net >= 0 ? wins++ : losses++;

    equity += net;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }
  return { realized, wins, losses, stopped, scaled, maxDD, taken, skippedByCaps };
}

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};

const TRIALS = arg("trials", 400), CALLS = arg("calls", 60);
// Round-trip cost: memecoin entry+exit slippage, spread and priority fees. The
// codebase probes this on every candidate for a reason — it is brutal, and a
// simulation that ignores it will show a profit on a strategy that has none.
const COST = arg("cost", 0.06);
const CALL_GAP_H = arg("gaph", 8);   // hours between calls (3/day at 8h)
const WINRATE = arg("winrate", 0.28), SEED = arg("seed", 7), DESK_LAG = arg("desklag", 6);
const cfg = { ...DEFAULTS, _winrate: WINRATE };

const agg = (rows) => {
  const s = rows.map((r) => r.realized).sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    meanSol: mean,
    medianSol: s[Math.floor(s.length / 2)],
    p10: s[Math.floor(s.length * 0.1)], p90: s[Math.floor(s.length * 0.9)],
    profitableRuns: rows.filter((r) => r.realized > 0).length / rows.length,
    worstDD: Math.min(...rows.map((r) => r.maxDD)),
    avgTaken: rows.reduce((a, r) => a + r.taken, 0) / rows.length,
    avgSkipped: rows.reduce((a, r) => a + r.skippedByCaps, 0) / rows.length,
    avgStops: rows.reduce((a, r) => a + r.stopped, 0) / rows.length,
    avgScales: rows.reduce((a, r) => a + r.scaled, 0) / rows.length,
  };
};

const naive = [], managed = [];
for (let t = 0; t < TRIALS; t++) {
  naive.push(runOne({ managed: false, calls: CALLS, rand: rng(SEED + t), cfg, deskLag: DESK_LAG }));
  managed.push(runOne({ managed: true, calls: CALLS, rand: rng(SEED + t), cfg, deskLag: DESK_LAG }));
}
const N = agg(naive), M = agg(managed);
const f = (v) => (v >= 0 ? "+" : "") + v.toFixed(3);
const pct = (v) => (v * 100).toFixed(0) + "%";

console.log(`\nSIMULATION — ${TRIALS} runs x ${CALLS} calls, desk win rate ${pct(WINRATE)}, round-trip cost ${(COST*100).toFixed(1)}%, seed ${SEED}`);
console.log(`Same call stream through both bots. Size ${cfg.maxSolPerTrade} SOL/trade.\n`);
console.log(`                         NAIVE (hold to desk exit)      RISK-MANAGED`);
console.log(`  mean P&L (SOL)              ${f(N.meanSol).padEnd(22)}${f(M.meanSol)}`);
console.log(`  median P&L (SOL)            ${f(N.medianSol).padEnd(22)}${f(M.medianSol)}`);
console.log(`  10th pct (bad run)          ${f(N.p10).padEnd(22)}${f(M.p10)}`);
console.log(`  90th pct (good run)         ${f(N.p90).padEnd(22)}${f(M.p90)}`);
console.log(`  runs that made money        ${pct(N.profitableRuns).padEnd(22)}${pct(M.profitableRuns)}`);
console.log(`  worst drawdown (SOL)        ${N.worstDD.toFixed(3).padEnd(22)}${M.worstDD.toFixed(3)}`);
console.log(`  trades taken / skipped      ${(N.avgTaken.toFixed(1)+" / "+N.avgSkipped.toFixed(1)).padEnd(22)}${M.avgTaken.toFixed(1)} / ${M.avgSkipped.toFixed(1)}`);
console.log(`  avg stops / scale-outs      ${"—".padEnd(22)}${M.avgStops.toFixed(1)} / ${M.avgScales.toFixed(1)}`);
console.log(`\n  Risk engine delta: ${f(M.meanSol - N.meanSol)} SOL mean, ` +
  `drawdown ${(M.worstDD - N.worstDD >= 0 ? "reduced " : "worsened ")}by ${Math.abs(M.worstDD - N.worstDD).toFixed(3)} SOL\n`);
console.log(`  NOTE: profit is a function of the DESK'S call quality (win rate above),`);
console.log(`  not of this bot. Re-run with --winrate to see how the same engine behaves`);
console.log(`  on a better or worse call stream.\n`);
