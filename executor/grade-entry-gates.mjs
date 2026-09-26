/**
 * GRADE THE TWO RULERS — the one experiment that could give this bot an entry edge.
 *
 * Measured over the owner's 64 traded launches: nothing observable at entry orders the
 * outcome. Buyers ahead of us, seconds late, trades on the curve — every Spearman ρ under
 * 0.13, which at n=64 is noise. The exits leak real money and fixing them still loses
 * (best modelled ladder: −0.122 SOL against an actual −0.361). So the loss is not an exit
 * problem and not a latency problem. It is that the bot cannot tell a good launch from a
 * bad one, and pays 2.5% a round trip to find out.
 *
 * `creator_profile` and `launch_share` are the two filters the rug literature actually
 * names. Both are implemented as gates in snipe-entry.mjs. Both are `undefined` by
 * default, so they measure and never kill — deliberately, because a number is not evidence
 * until it has been run against a case whose answer is already known.
 *
 * This is the command that runs them against known answers.
 *
 * WHAT IT GRADES, AND WHY IT IS NOT THE 64 TRADES
 *
 * The obvious dataset is the traded book: 64 launches with realised P&L. It is also the
 * wrong one, twice over. It is small, and it is SELECTED — those 64 are the launches that
 * cleared every other gate, so grading a ruler on them asks "does this separate winners
 * among coins we already agreed to buy", which is not the question.
 *
 * The shadow book answers the real one. It records a row for every launch the lane
 * EVALUATES — the refused ones included — and samples each row's forward path whether or
 * not we bought. At ~29 launches a minute that is thousands of graded rows a day, none of
 * them selected by the gates under test. `snipeScorecard()` then scores each ruler over
 * exactly the rows where the measurement exists AND the outcome is known.
 *
 * THE POSITIVE CLASS IS A BAD LAUNCH, NOT A GOOD ONE
 *
 * `positiveOutcome` is "the curve's real quote reserve never advanced past the would-have-
 * fill within the forward window" — a launch nobody followed us into. These rulers are
 * REFUSALS: a high precision means "when this ruler flags a launch, that launch really was
 * one nobody followed". That is what makes it safe to promote to a kill, and it is why the
 * bar is precision rather than accuracy: the cost of a false flag is a missed winner.
 *
 * NOTHING HERE PROMOTES ANYTHING. The scorecard reports; arming a proxy as a kill is a
 * separate registered change the owner makes deliberately.
 *
 *   node grade-entry-gates.mjs                  # the live book beside the state db
 *   node grade-entry-gates.mjs --limit 5000     # the most recent N rows only
 *   node grade-entry-gates.mjs --file <path>    # an exported book
 *   node grade-entry-gates.mjs --json           # machine-readable, for a longer study
 */

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readShadowRows, shadowBookPath } from "./shadow-sink.mjs";
import {
  snipeScorecard, outcomeKnown, SNIPE_PROXIES,
  PROMOTION_PRECISION_BAR, PROMOTION_MIN_ROWS, PROMOTION_MIN_FLAGGED,
} from "./snipe-shadow.mjs";

export function parseArgs(argv = []) {
  const out = { file: null, limit: 0, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--file") { out.file = argv[++i] ?? null; }
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error("--limit must be a positive integer");
      out.limit = n;
    } else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return out;
}

/** The book's default home, from the same STATE_DB the poller resolves everything else
 *  against. Named rather than guessed, so a refusal can say where it looked. */
export function defaultBookPath(env = process.env) {
  const stateDb = path.resolve(env.STATE_DB || "./.cc-executor.sqlite");
  return shadowBookPath(stateDb);
}

const pct = (v) => (v == null ? "  —  " : `${(v * 100).toFixed(1)}%`);

/**
 * The report, as text. Pure — it takes the scorecard and returns lines — so the shape of
 * what the owner reads is testable without a disk, an RPC or a wallet.
 */
export function formatReport({ scorecard, read, bookPath }) {
  const L = [];
  L.push("");
  L.push(`HAWK-AI — grading the ${Object.keys(scorecard.proxies).length} entry rulers against the shadow book`);
  L.push("=".repeat(66));
  L.push(`book        ${bookPath}`);
  L.push(`rows        ${read.total} retained across ${read.files} file(s)` +
    (read.malformed ? `, ${read.malformed} unparseable line(s) skipped` : ""));
  L.push(`judged      ${scorecard.judged} rows have a known outcome`);
  L.push(`positives   ${scorecard.positives} of those are the positive class`);
  L.push(`            (${scorecard.positiveClass})`);
  L.push("");

  if (scorecard.judged === 0) {
    L.push("NOTHING TO GRADE YET.");
    L.push("");
    L.push("A row is judgeable only once its forward window has closed, so a book that was");
    L.push("just started reads zero. This is not a fault. Leave the bot running and come back:");
    L.push(`the bar is ${PROMOTION_MIN_ROWS} judged rows per ruler, which at the lane's evaluation rate is`);
    L.push("hours, not weeks.");
    return L.join("\n");
  }

  for (const [name, p] of Object.entries(scorecard.proxies)) {
    L.push(`── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
    L.push(`   rule        ${p.rule}`);
    L.push(`   measured    ${p.n} rows`);
    L.push(`   flagged     ${p.flagged}  (true ${p.tp} / false ${p.fp})`);
    L.push(`   missed      ${p.fn}  (bad launches this ruler did not flag)`);
    L.push(`   precision   ${pct(p.precision)}   when it flags, how often it is right`);
    L.push(`   recall      ${pct(p.recall)}   of the bad launches, how many it catches`);
    L.push(`   verdict     ${p.promotable ? "PROMOTABLE" : "not promotable"} — ${p.why}`);
    L.push("");
  }

  L.push(`bar: precision >= ${scorecard.bar} over >= ${scorecard.minRows} judged rows with >= ${scorecard.minFlagged} flagged.`);
  L.push(`promotes: ${scorecard.promotes}`);
  L.push("");
  /* THE HONEST READING, stated in the report rather than left to the reader — because the
     most likely outcome of this experiment is that neither ruler separates anything, and
     that result is worth as much as a positive one and is far easier to talk yourself out
     of. */
  const any = Object.values(scorecard.proxies).some((p) => p.promotable);
  /* A RULER THAT IS NEVER MEASURED ON THIS BOOK CANNOT HOLD THE VERDICT OPEN. volume_spike
     needs five minutes of a coin's history, and a launch notice is judged within thirty
     seconds of its birth — so on a book of launches it measures nothing, by construction, and
     "every ruler shows n >= 200" could never become true. The "no edge" reading was
     unreachable. Sufficiency is therefore judged over the rulers that measured something, and
     the ones that measured nothing are named as such rather than silently dropped. */
  const entries = Object.entries(scorecard.proxies);
  const measurable = entries.filter(([, p]) => p.n > 0);
  const unmeasured = entries.filter(([, p]) => p.n === 0).map(([name]) => name);
  const enough = measurable.length > 0 && measurable.every(([, p]) => p.n >= scorecard.minRows);
  if (unmeasured.length) {
    L.push(`NOT IN THE VERDICT: ${unmeasured.join(", ")} — measured on 0 of ${scorecard.judged} judged rows.`);
    L.push("A ruler this book's population cannot measure is left out rather than holding the");
    L.push("reading open forever. (volume_spike needs a 5-minute baseline; a launch has none.)");
    L.push("");
  }
  if (any) {
    L.push("READ THIS AS: at least one ruler clears the bar. That is a candidate, not a");
    L.push("decision — arming it is a separate deliberate change, and a ruler that works this");
    L.push("week on this market can stop working next week.");
  } else if (!enough) {
    L.push("READ THIS AS: not enough judged rows yet. Come back when every ruler shows");
    L.push(`n >= ${scorecard.minRows}.`);
  } else {
    L.push("READ THIS AS: with a full sample, no ruler separates the launches nobody");
    L.push("followed from the ones people did. That is a real result. It means this strategy");
    L.push("has no entry edge that these measurements can find, and the honest options are");
    L.push("a different signal entirely or not trading this book at all — not a faster feed,");
    L.push("and not another exit ladder.");
  }
  return L.join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env, out = console.log) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { out(`grade-entry-gates: ${e.message}`); return 2; }
  if (args.help) {
    out("usage: node grade-entry-gates.mjs [--file PATH] [--limit N] [--json]");
    return 0;
  }

  const bookPath = args.file ? path.resolve(args.file) : defaultBookPath(env);
  const read = readShadowRows({ file: bookPath, limit: args.limit });

  if (read.files === 0) {
    out(`grade-entry-gates: no shadow book at ${bookPath}`);
    out("");
    out("The book is written only by a build that wires the sink (shadow-sink.mjs). If this");
    out("executor predates that, the measurements were computed and discarded — upgrade, let");
    out("it run, and come back.");
    return 1;
  }

  const scorecard = snipeScorecard(read.rows);
  if (args.json) {
    out(JSON.stringify({ bookPath, read: { total: read.total, malformed: read.malformed, files: read.files }, scorecard }, null, 2));
    return 0;
  }
  out(formatReport({ scorecard, read, bookPath }));
  return 0;
}

/**
 * Only when run directly — and THE GUARD HAS TO SURVIVE A SYMLINK.
 *
 * Node resolves a module's own URL through symlinks, so `import.meta.url` is the REALPATH
 * while `process.argv[1]` is whatever the operator typed. The documented way to run this is
 *
 *     node ~/claudeco-executor/current/grade-entry-gates.mjs
 *
 * and `current` is a symlink into the release tree. Comparing those two strings raw
 * therefore never matched on a real install: main() did not run, nothing printed, and the
 * command looked exactly like a tool that had found nothing worth saying. Measured on the
 * owner's Mac at 04:37Z on 2026-09-19, the first time he ran it.
 *
 * This is the same `current`-symlink trap that made `macos-launchagent.sh load` refuse a
 * live install the day before. Resolve both sides to a real path and compare those.
 */
export const runningAsScript = (argv = process.argv[1], moduleUrl = import.meta.url) => {
  if (!argv) return false;
  const mine = fileURLToPath(moduleUrl);
  try { return realpathSync(argv) === mine; }
  catch { return path.resolve(argv) === mine; }   // argv may not exist on disk in a test
};

if (runningAsScript()) {
  main().then((code) => { process.exitCode = code; });
}

export { outcomeKnown, SNIPE_PROXIES, PROMOTION_PRECISION_BAR, PROMOTION_MIN_ROWS, PROMOTION_MIN_FLAGGED };
