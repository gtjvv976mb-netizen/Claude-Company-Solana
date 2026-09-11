/**
 * WALL-ST-E — CLAUDE COMPANY'S SELF-HOSTED POLLING EXECUTOR
 *
 * Default: paper decisions. EXECUTE=1 enables real mainnet swaps only after every
 * local gate below passes. The central desk remains keyless: this process polls a
 * read-only feed and signs with a dedicated burner that never leaves this machine.
 * First startup primes at the latest feed id and never replays old calls.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  EXIT_INTENT_KINDS, ExecutionJournal, LEGACY_CALL_IDENTITY_POLICY, acquireProcessLock,
  deskExitDecisionForPosition, positionEntryBlock, requirePositiveCallId, validateRiskState,
} from "./journal.mjs";
import {
  JupiterV2Executor, MAX_GROSS_RENT_LAMPORTS, WSOL, associatedTokenAddress,
  walletTokenAmount, independentClassicMintDecimals, independentMintProgram, mintTokenProgram,
  TOKEN_2022_PROGRAM, EXECUTION_READINESS_ROUTE, validateOrderEnvelope,
} from "./jupiter.mjs";
import { token2022Enabled } from "./token2022.mjs";
import {
  RpcBalanceUnavailableError, verifyTrackedBalanceWithFailover,
} from "./balance-verification.mjs";
import {
  advanceFrozenBatchCursor, authenticatedFeedCursorState, waitForRecoveryBudget,
} from "./feed-drain.mjs";
import {
  clearExitImpactRefusals, clearMarkUnavailable, executableExitMark, exitRetryFraction,
  isPriceImpactRefusal, noteExitImpactRefusal, noteMarkUnavailable,
} from "./exit-trigger.mjs";
import {
  MIRROR_MARK_MS, evaluateMirror, mirrorLatchExpiry, mirrorPriceable,
  reconcileGate, reconcileVerdict, refreshDeskLevels,
} from "./desk-mirror.mjs";
import { consensusMark } from "./dexscreener-consensus.mjs";
import { executorHeartbeatHealth, executorRuntimeFingerprint } from "./heartbeat-health.mjs";
import {
  validateEntryPreflightContext, validateExecutableEntryOrder,
} from "./entry-quote-guard.mjs";
import {
  inspectOwnerControlFile, requireMacEntryPower, sleepAssertionFaultPath,
} from "./sleep-assertion.mjs";
import {
  independentSolUsdPrice, PYTH_SOL_USD_CACHE_SOURCE, solanaRpcConnectionConfig,
  usableSolUsdCache,
} from "./sol-usd-oracle.mjs";
import { DEFAULTS, POLICY_VERSION, planEntry, minViableSolPerTrade, openPosition, stepPosition,
  freshState } from "./strategy.mjs";
import { sizeEntryToRoute } from "./entry-sizing.mjs";
import { policyConfigForPosition, resolveTakeProfitRule, validateEntryReference } from "./trade-policy.mjs";
import { ENTRY_WINDOW_FLOOR_MS, entryContract, entryWindowMs } from "./entry-contract.mjs";

process.umask(0o077);

const API = (process.env.CC_API || "https://claude-company-api.onrender.com").replace(/\/$/, "");
const SECRET = process.env.CC_SECRET || "";
const FLOOR = process.env.CC_FLOOR || "";
const EXECUTE = process.env.EXECUTE === "1";
/* THE PAPER-PREFLIGHT SEAM — OFF UNLESS ASKED FOR, AND IMPOSSIBLE WHILE EXECUTING.
 *
 * Paper mode returns at the ENTRY line, before the executable-cost gates, so SIM A's
 * "the bot decided to BUY all 12 published calls" is a decision taken ahead of the four
 * fences that actually refused live entries: the round-trip cap (measured 14%), the
 * entry impact cap (7%), the executable-quote drift (8.20% and 26.04% on 2026-09-04/05)
 * and the gross-rent ceiling (3,742,803 and 4,078,560 against 4,200,000). A simulation
 * that stops before them cannot say anything about the take rate, which is the whole
 * question.
 *
 * With PAPER_PREFLIGHT=1 the paper path continues into those gates against whatever
 * JUPITER_API_BASE points at — a local fixture server in SIM C — and stops one line
 * before anything is journaled or signed. `&& !EXECUTE` is written into the constant
 * itself rather than checked at the call site so no later edit can reach the paper
 * branch from a live run; paperPreflightEntry() refuses a second time on its own. */
const PAPER_PREFLIGHT = !EXECUTE && process.env.PAPER_PREFLIGHT === "1";
/* The SOL/USD the paper preflight prices its implied marks with. There is no chain in
 * paper mode, so there is no Pyth read to take it from — and the drift test only needs
 * the two sides to share ONE anchor, because it compares Jupiter's implied mark with the
 * desk's monitored mark. Live, this number comes from independentSolUsdPrice across both
 * RPC providers and nothing else is accepted (validateEntryPreflightContext). */
const PAPER_SOL_USD = Number(process.env.PAPER_SOL_USD || 150);
/* FIVE SECONDS, NOT FIFTEEN. Under desk-led-v4 the poll is the bot's ONLY way to hear the
 * exit the desk determined, so its period is the floor on how late every exit lands.
 * Shrek, call 55 (2026-09-05): the desk's stop_hit was written at 03:10:24Z; at 15 s the
 * bot could have heard it up to 15 s late, and did not hear it at all because it had
 * already sold on its own stop nine minutes earlier. Bounds unchanged (1 s to 1 h). */
const POLL_MS = Number(process.env.POLL_MS || 5_000);
/* The feed is read on EVERY tick; the valuation/custody pass (manageOpen) runs only when
 * MARK_MS has elapsed — it prices every position through a chain-simulated Jupiter exit
 * order on two RPCs, which is far too heavy for a 5 s cadence and, since desk-led-v4,
 * decides nothing. Live bounds 5 s to 5 min; paper accepts 0 so a test can run it every tick. */
const MARK_MS = Number(process.env.MARK_MS ?? 15_000);
/* How long the desk may be CONSECUTIVELY unreachable (network error, timeout, non-2xx,
 * unparsable body) before the bot mirrors it. Ten minutes: longer than every Render
 * wobble in the log, shorter than a nano window. Live bounds 2 min to 1 h; paper any. */
const DESK_UNREACHABLE_MS = Number(process.env.DESK_UNREACHABLE_MS ?? 600_000);
/* HOW OFTEN THE BOT ASKS THE DESK ABOUT THE CALLS IT IS ACTUALLY HOLDING (wave 2).
 * The feed stays the fast path — an exit event is executed the tick it is seen, inside
 * POLL_MS. This is the floor UNDER it, for the two ways the event never arrives at all:
 * a row delivered once that the bot's cursor has already passed, and a desk that answers
 * 200 while its penthouse loop is wedged. A minute is cheap against a 25-id state read
 * and is still 1/30th of the shortest nano window. Live bounds 15 s to 10 min. */
const RECONCILE_MS = Number(process.env.RECONCILE_MS ?? 60_000);
/* How long a call may be LIVE at the desk without the desk marking it before the bot
 * stops reading that silence as a decision to hold. Ten minutes, the same figure as
 * DESK_UNREACHABLE_MS and for the same reason: a healthy desk sub-marks every fast-lane
 * band every 45 s, so ten minutes is thirteen missed passes, not a slow one. Live bounds
 * 2 min to 1 h; paper any >= 0. */
const DESK_SILENT_MS = Number(process.env.DESK_SILENT_MS ?? 600_000);
const FEE_RESERVE = Number(process.env.FEE_RESERVE_SOL || 0.01);
const MAX_CALL_AGE_MS = Number(process.env.MAX_CALL_AGE_MIN || 45) * 60_000;
const MAX_FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MIN || 5) * 60_000;
const MAX_ENTRY_MARK_AGE_MS = Number(process.env.MAX_ENTRY_MARK_AGE_MIN || 15) * 60_000;
const MAX_ENTRY_DEVIATION_PCT = Number(process.env.MAX_ENTRY_DEVIATION_PCT || 10);
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const SECONDARY_RPC = process.env.SOLANA_RPC_SECONDARY || "https://api.mainnet-beta.solana.com";
/* TWO SUBDOMAINS OF ONE PROVIDER ARE ONE PROVIDER. The live gate below compared
   full hostnames, so us1.alchemy.com and us2.alchemy.com passed as "independent"
   — and then every cross-check built on that second opinion (the SOL/USD
   agreement, the independent mint audit, the independent finalized confirmation)
   was one operator checking itself while all of them still appeared to pass.
   Independence is judged on the registrable domain. Naive eTLD+1 with the few
   two-part suffixes that would otherwise collapse to a public suffix. Ported from
   the Robinhood fork, where this was found and fixed first. */
const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "co.nz", "com.br", "co.in", "com.sg"]);
export function registrableDomain(host) {
  const parts = String(host || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const JUPITER_API_BASE = (process.env.JUPITER_API_BASE || "https://api.jup.ag/swap/v2").replace(/\/$/, "");
const KEYPAIR_FILE = path.resolve(process.env.KEYPAIR || "./burner.json");
const STATE_DB = path.resolve(process.env.STATE_DB || "./.cc-executor.sqlite");
const LOCK_FILE = path.resolve(process.env.LOCK_FILE || `${STATE_DB}.lock`);
const PAUSE_ENTRIES_FILE = path.resolve(process.env.PAUSE_ENTRIES_FILE || `${STATE_DB}.pause-entries`);
const HARD_STOP_FILE = path.resolve(process.env.HARD_STOP_FILE || `${STATE_DB}.hard-stop`);
const SLEEP_ASSERTION_FAULT_FILE = sleepAssertionFaultPath(LOCK_FILE);
// Compute once, before the loop starts. A release changed on disk without restarting
// cannot make an old in-memory process impersonate the newly published runtime.
const RUNTIME_FINGERPRINT = executorRuntimeFingerprint(path.dirname(fileURLToPath(import.meta.url)));
const LAMPORTS = 1_000_000_000;
// newest floor verdict already logged; verdicts older than this are not repeated
let lastDecisionSeen = Date.now() - 6 * 3600e3;
/* The FULL 44-character mainnet-beta genesis hash. It shipped truncated to 32
 * characters, so the equality check could never pass against a real RPC — a bug only
 * a genuine live boot could surface, and exactly the kind fail-closed design is for:
 * the first live start REFUSED with the true genesis printed in the message, which is
 * how this was caught. Verified against the RPC's own answer. */
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LIVE_LIMITS = Object.freeze({
  maxSolPerTrade: 0.005,
  dailySolCap: 0.01,
  dailyLossLimitSol: 0.01,
  maxOpenPositions: 24,
  slippageBps: 300,
  maxPriceImpactPct: 5,
  maxExitPriceImpactPct: 50,
  maxFeeBps: 100,
  /* THE PRIORITY FEE CEILING, RAISED FROM 500,000 ON THE OWNER'S INSTRUCTION.
   *
   * Exceeding this REFUSES the entry — see the networkFees check in jupiter.mjs — so it
   * is not a budget, it is a gate, and the question is only whether a congested moment
   * can close it. Measured on four live rehearsals between 16:31 and 18:59 on
   * 2026-09-03, Jupiter's own priority price moved 79x: 10,000, then 38,785, then
   * 50,002, then 793,188 microlamports per compute unit, which on a ~135k CU
   * transaction is 1,356 to 92,207 lamports. The old ceiling sat about 5x above that
   * peak, so a further ordinary-looking move would have started refusing entries — and
   * the moment it happened would be a congested one, which is exactly when a coin worth
   * catching is being caught.
   *
   * Raising a REFUSAL threshold does not raise what a quiet market costs: Jupiter's
   * estimate decides what is actually paid, and every measured fee so far is under a
   * fifth of the OLD ceiling. The change is only felt in the tail. What it does cost is
   * the tail itself — at 0.05 SOL a trade this is 4% of notional, against 0.19% at the
   * observed peak — and maxNetworkFeePct below still refuses anything over 10% of the
   * trade, so that remains the outer limit and this sits at half of it. */
  maxNetworkFeeLamports: 2_000_000,
  /* THE SAME NUMBER WAS DOING TWO OPPOSITE JOBS.
   *
   * As a GATE, maxNetworkFeeLamports is the fee above which an entry is refused, and
   * raising it can only ever admit trades. As a COST MODEL it was also charged against
   * every trade — networkFeeReserveSol below, and worstFeeRatio in the entry guard —
   * where raising it can only ever refuse them. Coupled, the owner's instruction to
   * stop congestion refusing fills would have refused ALL of them: reviewed against the
   * real sizing engine at the live 0.3366 SOL wallet, a 2,000,000 cost model leaves no
   * stop width between 8% and 95%, at any round-trip friction from 0% to 5%, that still
   * yields a buy, and lifts the wallet floor for a 30%-stop position from 0.140 to
   * 0.380 SOL. The bot would have gone silent in every market, not just a congested one.
   *
   * So the cost model is now its own constant and deliberately UNCHANGED at the old
   * value. That makes the split provably behaviour-neutral: every sizing decision, every
   * stop-distance band and every downstream derivation keeps the number it was built
   * from. Lowering it to flatter the measured fee would loosen the executable-cost band
   * that the desk's 12% stop floor exists to enforce — a change nobody asked for. */
  expectedNetworkFeeLamports: 500_000,
  maxNetworkFeePct: 10,
  // Gross creation rent for one temporary WSOL ATA plus one destination ATA is
  // currently 4,078,560 lamports. The reviewed ceiling leaves only a narrow buffer;
  // core 0.005/0.01-SOL exposure caps are unchanged.
  maxRentLamports: MAX_GROSS_RENT_LAMPORTS,
  maxEntryRoundTripLossPct: 12,
  /* HOW FAR JUPITER'S EXECUTABLE QUOTE MAY SIT FROM OUR OWN ANCHORED MARK.
   *
   * This is a quote-sanity check, not a price-movement one: it asks whether the
   * executable rate agrees with a mark we monitored independently. At 5% it refused a
   * real entry on 2026-09-04 — "SKIP Pistacio: final executable entry drift 8.20%
   * exceeds 5% cap" — one second after sizing the position and clearing every other
   * gate.
   *
   * On these coins 8% between a seconds-old anchor and a live quote is the market
   * moving, not a bad quote: the owner's whole thesis is that a nano or micro name
   * routinely travels 20% in minutes, which is why the desk holds them for minutes.
   * A cap tuned for a slow book refuses the fast ones it exists to catch.
   *
   * Raising it does NOT loosen where we actually buy. Immediately below, the same
   * function still refuses a quote outside the desk's authored entry zone, one that has
   * already breached the authored stop, and one that has already reached the target —
   * and those are the checks that bound the price paid. This one bounds only how much
   * the two price sources may disagree before we distrust the quote itself. */
  maxEntryQuoteDriftPct: 15,
  /* THE SAME BUDGET AS THE ENTRY WINDOW, SEEN FROM THE OTHER END. The quotes, the mint
   * audit and the Pyth read are stamped at the top of the preflight and re-checked
   * against this cap at the submission gate, immediately before signing — so a cap
   * shorter than the window refuses, at the last fence, a preflight this same pipeline
   * legitimately took that long to produce. It was a second 60_000 sitting beside
   * MIN_CALL_EXPIRY_MS's; both are ENTRY_WINDOW_FLOOR_MS now, and executor/
   * test-entry-window.mjs measured what that has to cover (12 serial hops, 68s at this
   * executor's own per-request deadlines). MAX_ENTRY_PREFLIGHT_AGE_MS still tightens
   * it, and under EXECUTE=1 that is the only direction it can move. */
  maxEntryPreflightAgeMs: ENTRY_WINDOW_FLOOR_MS,
  maxExitTriggerAgeMs: 60_000,
  solUsdCacheMaxAgeMs: 30 * 60_000,
  maxAttempts: 3,
  /* Adversarial-review hardening, 2026-09-01 — each closes a hole where the only
   * number consulted was one the counterparty authored:
   * blockHeightWindow: a quoted lastValidBlockHeight further than this above the
   *   chain's real height is refused BEFORE signing. Unbounded, one inflated value
   *   wedged the journal forever and disarmed every exit behind it.
   * maxQuoteShortfallPct: if simulation delivers more than this % above the QUOTED
   *   output, the quote was low-balled (stale or adversarial) and the signed minOut
   *   floor is garbage — refuse. The chain is the one number Jupiter cannot author.
   * maxExitAttempts: exits get more tries than entries — a stop that fails three
   *   times during the exact dump that fired it must not be dead forever — but
   *   bounded, because every on-chain failure burns a real, accounted fee. */
  blockHeightWindow: 600,
  maxQuoteShortfallPct: 15,
  maxExitAttempts: 12,
});
const log = (...args) => console.log(new Date().toISOString(), "WALL-ST-E", ...args);
const fatal = (message) => { console.error(new Date().toISOString(), "WALL-ST-E REFUSES:", message); process.exit(1); };

// One durable journal has exactly one lock identity. Allowing LOCK_FILE to point
// elsewhere lets two differently configured pollers mutate the same SQLite state.
if (LOCK_FILE !== `${STATE_DB}.lock`)
  fatal("LOCK_FILE must be the canonical STATE_DB lock (STATE_DB plus .lock)");

const number = (name, value, { min = 0, max = Infinity } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fatal(`${name} must be between ${min} and ${max}`);
  return n;
};
const SOL_SCALE = 1_000_000_000n;
const plainSolUnits = (value) => {
  const raw = String(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/.exec(raw);
  if (!match) return null;
  return BigInt(match[1]) * SOL_SCALE + BigInt((match[2] || "").padEnd(9, "0") || "0");
};
const solCap = (name, value, { min, max }) => {
  const raw = String(value);
  const units = plainSolUnits(raw);
  if (units === null)
    fatal(`${name} must be a plain decimal with at most 9 fractional digits`);
  const minUnits = plainSolUnits(min);
  const maxUnits = plainSolUnits(max);
  if (units < minUnits || units > maxUnits)
    fatal(`${name} must be between ${min} and ${max}`);
  return Object.freeze({ raw, units, value: Number(units) / 1_000_000_000 });
};
/* NO ARBITRARY CAP ON HOW MANY MEMECOINS MAY RUN AT ONCE.
 *
 * Owner's rule: several memes pump together, so a fixed count makes the desk late on
 * the ones it was right about. Measured, the count was never the real limit anyway —
 * removing it alone took the book from 4 positions to 5, because bookHeatMax bound
 * next. So the count is now a sentinel rather than a policy, and RISK decides: total
 * book heat, the rolling daily deploy cap, the per-name stop risk and the wallet.
 * At the live 0.3366 SOL balance the wallet itself saturates at 14 positions, which is
 * the honest meaning of "let the money decide". */
const openPositions = (value) => {
  const raw = String(value);
  if (!/^([1-9]|1[0-9]|2[0-4])$/.test(raw))
    fatal("MAX_OPEN_POSITIONS must be an integer between 1 and 24");
  return Number(raw);
};

if (!SECRET || !/^\d+$/.test(FLOOR) || Number(FLOOR) <= 0) fatal("CC_SECRET and a positive CC_FLOOR are required");
/* HTTPS always — with one carve-out that cannot weaken live. A loopback API lets a
 * full dry-run rehearsal run against a local office process (the only way to test the
 * feed contract end-to-end without touching production). Loopback traffic never
 * crosses a network, so there is nothing for TLS to protect; any OTHER plain-HTTP
 * host still refuses, and EXECUTE=1 refuses plain HTTP unconditionally — a live
 * canary has no business on a rehearsal feed. */
{
  let apiHost = "";
  try { apiHost = new URL(API).hostname; } catch { fatal("CC_API is not a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiHost);
  if (!API.startsWith("https://") && !(loopback && !EXECUTE))
    fatal(EXECUTE ? "live execution requires an HTTPS CC_API — no loopback carve-out"
                  : "CC_API must use HTTPS (plain HTTP is allowed only for loopback dry-run rehearsals)");
}
if (!fs.existsSync(KEYPAIR_FILE)) fatal(`no keypair at ${KEYPAIR_FILE}`);

function loadKeypair() {
  const st = fs.lstatSync(KEYPAIR_FILE);
  if (!st.isFile() || st.isSymbolicLink()) fatal("KEYPAIR must be a regular, non-symlink file");
  if (EXECUTE) {
    if ((st.mode & 0o077) !== 0) fatal(`live keypair permissions must be 0600 (chmod 600 ${KEYPAIR_FILE})`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) fatal("live keypair must be owned by the service user");
  }
  let bytes;
  try { bytes = JSON.parse(fs.readFileSync(KEYPAIR_FILE, "utf8")); }
  catch { fatal("KEYPAIR is not a readable Solana JSON keypair"); }
  try { return Keypair.fromSecretKey(new Uint8Array(bytes)); }
  catch { fatal("KEYPAIR does not contain a valid Solana secret key"); }
}

const kp = loadKeypair();
const WALLET = kp.publicKey.toBase58();
const controlActive = (file, label) => inspectOwnerControlFile(file, { label }).present;
const pauseEntries = () => controlActive(PAUSE_ENTRIES_FILE, "entry-pause sentinel") ||
  controlActive(SLEEP_ASSERTION_FAULT_FILE, "sleep assertion fault latch");
const hardStop = () => controlActive(HARD_STOP_FILE, "hard-stop sentinel");
const assertEntriesUnpaused = () => {
  const pause = inspectOwnerControlFile(PAUSE_ENTRIES_FILE, { label: "entry-pause sentinel" });
  if (pause.present) throw new Error(pause.valid
    ? "PAUSE ENTRIES file appeared before submission"
    : `PAUSE ENTRIES control is unsafe (${pause.reason})`);
  const fault = inspectOwnerControlFile(SLEEP_ASSERTION_FAULT_FILE, {
    label: "sleep assertion fault latch",
  });
  if (fault.present) throw new Error(fault.valid
    ? "sleep assertion fault is latched; explicit operator repair and review are required"
    : `sleep assertion fault latch is unsafe (${fault.reason})`);
};

if (EXECUTE) {
  if (process.env.LIVE_TRADING_ACK !== WALLET)
    fatal(`LIVE_TRADING_ACK must exactly equal this burner public key: ${WALLET}`);
  if (!JUPITER_API_KEY) fatal("JUPITER_API_KEY is required for live execution");
  if (!process.env.SOLANA_RPC || !RPC.startsWith("https://")) fatal("live execution requires an explicit private HTTPS SOLANA_RPC");
  if (!process.env.SOLANA_RPC_SECONDARY)
    fatal("live execution requires an explicit independent SOLANA_RPC_SECONDARY");
  let primaryRpcUrl, secondaryRpcUrl;
  try {
    primaryRpcUrl = new URL(RPC);
    secondaryRpcUrl = new URL(SECONDARY_RPC);
  } catch { fatal("both live RPC endpoints must be valid HTTPS URLs"); }
  const primaryHost = primaryRpcUrl.hostname.toLowerCase().replace(/\.$/, "");
  const secondaryHost = secondaryRpcUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (primaryRpcUrl.protocol !== "https:" || secondaryRpcUrl.protocol !== "https:")
    fatal("both live RPC endpoints must use HTTPS");
  if (primaryHost === "api.mainnet-beta.solana.com" || secondaryHost === "api.mainnet-beta.solana.com")
    fatal("the rate-limited public Solana RPC is not accepted for either live endpoint");
  if (primaryHost === secondaryHost || registrableDomain(primaryHost) === registrableDomain(secondaryHost))
    fatal("SOLANA_RPC_SECONDARY must use an independent provider, not another hostname at the same one");
  if (!JUPITER_API_BASE.startsWith("https://")) fatal("JUPITER_API_BASE must use HTTPS");
  const legacy = path.resolve(process.env.STATE_FILE || "./.cc-state.json");
  if (fs.existsSync(legacy)) {
    let old;
    try { old = JSON.parse(fs.readFileSync(legacy, "utf8")); }
    catch { fatal(`legacy state is unreadable: ${legacy}`); }
    if (Object.keys(old?.positions || {}).length)
      fatal(`legacy JSON contains unproven positions; reconcile them manually before live mode (${legacy})`);
  }
  if (!fs.existsSync(STATE_DB) && process.env.LIVE_STATE_INIT_ACK !== WALLET)
    fatal(`live journal is missing; initialize it once with LIVE_STATE_INIT_ACK=${WALLET} and INIT_ONLY=1`);
}

/* ── OPERATOR-RAISED LIVE CAPS ────────────────────────────────────────────────
 * Reinstated after a rewrite dropped it. The canary ceilings stay the default and env
 * can still only LOWER them; raising is possible and deliberately awkward.
 *
 * It has to exist because the canary size cannot trade at all. Solana's network fees
 * are fixed, so two worst-case 500k-lamport fees are 20% of a 0.005 SOL position, and
 * the entry guard then demands a round trip returning over 100% of input —
 * unsatisfiable by construction. Measured on live coins: real round trips are ~0.7%,
 * and at 0.05 SOL the same call clears comfortably. Frozen forever, the canary is not
 * caution; it is a bot that can never buy anything.
 *
 * The property preserved is not "small" — it is that nothing raises real-money
 * exposure by accident. All three money caps must be set explicitly, and LIVE_CAPS_ACK
 * must be the current versioned sentence naming THIS wallet and THESE numbers; change
 * one and it stops matching. The v2 wording deliberately revokes the pre-hardening
 * acknowledgement retained by some old environments. OPERATOR_MAX stays at the
 * evidence-backed configuration that cleared the live preflight, and maxOpenPositions
 * stays frozen because it multiplies every other cap. */
/* OWNER, 2026-09-07: 0.4 SOL a trade, and NO DAILY DEPLOYMENT CAP.
 *
 * dailySolCap is set far above any reachable balance rather than deleted. The rail is
 * woven through the boot checks (DAILY_SOL_CAP below MAX_SOL_PER_TRADE is fatal), the
 * typed LIVE_CAPS_ACK sentence, install.sh and the dashboard, and every one of those
 * wants a number; a sentinel would mean new machinery in four files for a rail that is
 * already redundant. It cannot bind: the wallet's spendable balance is checked on every
 * entry and is ~2 SOL, so the daily rail sits three orders of magnitude above the money
 * that exists. What still bounds a day is the balance itself, the per-name risk cap,
 * book heat, maxOpenPositions and the realized-loss brake.
 *
 * The loss brake moves 0.15 -> 0.4 for a reason, not for symmetry: it is applied as the
 * TIGHTER of the absolute figure and 20% of the bankroll, so at 0.15 it was the binding
 * number and stopped the day after roughly two stop-outs on a 0.4 position. At 0.4 the
 * percentage becomes the binding one (0.399 on this balance), which is the owner's
 * original "stop after losing 20% of the SOL" rule actually taking effect. */
const OPERATOR_MAX = Object.freeze({ maxSolPerTrade: 0.4, dailySolCap: 1000, dailyLossLimitSol: 0.4 });
const capsAckSentence = (wallet, trade, daily, loss) =>
  `I acknowledge WALL-ST-E caps v2 for ${wallet}: ${trade} SOL per trade, ${daily} SOL per day, ${loss} SOL rolling realized-loss entry brake`;

let LIVE_CEILINGS = LIVE_LIMITS;
if (EXECUTE) {
  const req = {
    trade: process.env.MAX_SOL_PER_TRADE,
    daily: process.env.DAILY_SOL_CAP,
    loss: process.env.DAILY_LOSS_LIMIT_SOL,
  };
  const requested = {
    trade: req.trade == null ? null : solCap("MAX_SOL_PER_TRADE", req.trade,
      { min: 0.000001, max: OPERATOR_MAX.maxSolPerTrade }),
    daily: req.daily == null ? null : solCap("DAILY_SOL_CAP", req.daily,
      { min: 0.000001, max: OPERATOR_MAX.dailySolCap }),
    loss: req.loss == null ? null : solCap("DAILY_LOSS_LIMIT_SOL", req.loss,
      { min: 0.000001, max: OPERATOR_MAX.dailyLossLimitSol }),
  };
  const wantsRaise =
    (requested.trade && requested.trade.units > plainSolUnits(LIVE_LIMITS.maxSolPerTrade)) ||
    (requested.daily && requested.daily.units > plainSolUnits(LIVE_LIMITS.dailySolCap)) ||
    (requested.loss && requested.loss.units > plainSolUnits(LIVE_LIMITS.dailyLossLimitSol));
  if (wantsRaise) {
    if (!requested.trade || !requested.daily || !requested.loss)
      fatal("raising any live cap requires ALL THREE set explicitly: MAX_SOL_PER_TRADE, " +
        "DAILY_SOL_CAP, DAILY_LOSS_LIMIT_SOL — a partial raise hides the numbers the " +
        "acknowledgement exists to make you look at");
    if (requested.daily.units < requested.trade.units)
      fatal(`DAILY_SOL_CAP (${requested.daily.value}) is below MAX_SOL_PER_TRADE (${requested.trade.value}) — the day would refuse the first trade`);
    const expected = capsAckSentence(WALLET, requested.trade.raw,
      requested.daily.raw, requested.loss.raw);
    if ((process.env.LIVE_CAPS_ACK || "") !== expected)
      fatal("raised live caps need a typed acknowledgement. Set LIVE_CAPS_ACK to exactly:\n\n    " + expected + "\n");
    LIVE_CEILINGS = Object.freeze({ ...LIVE_LIMITS,
      maxSolPerTrade: requested.trade.value,
      dailySolCap: requested.daily.value,
      dailyLossLimitSol: requested.loss.value });
    log(`OPERATOR-RAISED CAPS acknowledged: ${requested.trade.value} SOL/trade, ${requested.daily.value} SOL/day deploy, ${requested.loss.value} SOL rolling realized-loss entry brake ` +
      `(hard maxima ${OPERATOR_MAX.maxSolPerTrade}/${OPERATOR_MAX.dailySolCap}/${OPERATOR_MAX.dailyLossLimitSol} are a code change, by design)`);
  }
}

const configuredTradeCap = solCap("MAX_SOL_PER_TRADE",
  process.env.MAX_SOL_PER_TRADE ?? (EXECUTE ? LIVE_CEILINGS.maxSolPerTrade : DEFAULTS.maxSolPerTrade),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.maxSolPerTrade : 100 });
const configuredDailyCap = solCap("DAILY_SOL_CAP",
  process.env.DAILY_SOL_CAP ?? (EXECUTE ? LIVE_CEILINGS.dailySolCap : DEFAULTS.dailySolCap),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailySolCap : 1000 });
const configuredLossCap = solCap("DAILY_LOSS_LIMIT_SOL",
  process.env.DAILY_LOSS_LIMIT_SOL ?? (EXECUTE ? LIVE_CEILINGS.dailyLossLimitSol : DEFAULTS.dailyLossLimitSol),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailyLossLimitSol : 1000 });
const CFG = {
  ...DEFAULTS,
  maxSolPerTrade: configuredTradeCap.value,
  dailySolCap: configuredDailyCap.value,
  dailyLossLimitSol: configuredLossCap.value,
  maxOpenPositions: openPositions(process.env.MAX_OPEN_POSITIONS ?? DEFAULTS.maxOpenPositions),
  trailPct: number("TRAIL_PCT", process.env.TRAIL_PCT || DEFAULTS.trailPct, { min: 0.01, max: 0.95 }),
  fDefault: number("F_DEFAULT", process.env.F_DEFAULT || DEFAULTS.fDefault, { min: 0.00001, max: 1 }),
  fNameMax: number("F_NAME_MAX", process.env.F_NAME_MAX || DEFAULTS.fNameMax, { min: 0.00001, max: 1 }),
  bookHeatMax: number("BOOK_HEAT_MAX", process.env.BOOK_HEAT_MAX || DEFAULTS.bookHeatMax, { min: 0.00001, max: 1 }),
  maxAgeHours: number("MAX_AGE_HOURS", process.env.MAX_AGE_HOURS || DEFAULTS.maxAgeHours, { min: 0.01, max: 720 }),
  /* THE ONLY THING THE DESK'S CONVICTION CAN DO, AND ONLY BECAUSE A HUMAN HERE ASKED.
   * A take-it-or-leave-it floor, read from THIS machine's environment. It cannot change
   * an amount — the position is identical on the taking side — so it is not a way back
   * to the conviction MULTIPLIER that was removed from strategy.mjs on 2026-09-07.
   * 0 (the default) means conviction changes nothing in this process at all. */
  minConviction: number("MIN_CONVICTION", process.env.MIN_CONVICTION || DEFAULTS.minConviction,
    { min: 0, max: 100 }),
  scaleOutPct: 0,
};
if (EXECUTE && configuredDailyCap.units < configuredTradeCap.units)
  fatal(`DAILY_SOL_CAP (${CFG.dailySolCap}) is below MAX_SOL_PER_TRADE (${CFG.maxSolPerTrade}) — the day would refuse the first trade`);

// Parse every transaction rail before INIT_ONLY can exit. This makes the
// installer validate the exact persistent environment that systemd will use.
const JUPITER_CFG = {
  slippageBps: number("SLIPPAGE_BPS", process.env.SLIPPAGE_BPS || LIVE_LIMITS.slippageBps,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.slippageBps : 1_000 }),
  maxPriceImpactPct: number("MAX_PRICE_IMPACT_PCT",
    process.env.MAX_PRICE_IMPACT_PCT || LIVE_LIMITS.maxPriceImpactPct,
    { min: 0.01, max: EXECUTE ? LIVE_LIMITS.maxPriceImpactPct : 50 }),
  maxExitPriceImpactPct: number("MAX_EXIT_PRICE_IMPACT_PCT",
    process.env.MAX_EXIT_PRICE_IMPACT_PCT || LIVE_LIMITS.maxExitPriceImpactPct,
    { min: 0.01, max: EXECUTE ? LIVE_LIMITS.maxExitPriceImpactPct : 100 }),
  maxFeeBps: number("MAX_JUPITER_FEE_BPS", process.env.MAX_JUPITER_FEE_BPS || LIVE_LIMITS.maxFeeBps,
    { min: 0, max: EXECUTE ? LIVE_LIMITS.maxFeeBps : 500 }),
  maxNetworkFeeLamports: number("MAX_NETWORK_FEE_LAMPORTS",
    process.env.MAX_NETWORK_FEE_LAMPORTS || LIVE_LIMITS.maxNetworkFeeLamports,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxNetworkFeeLamports : 100_000_000 }),
  expectedNetworkFeeLamports: number("EXPECTED_NETWORK_FEE_LAMPORTS",
    process.env.EXPECTED_NETWORK_FEE_LAMPORTS || LIVE_LIMITS.expectedNetworkFeeLamports,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.expectedNetworkFeeLamports : 100_000_000 }),
  maxNetworkFeePct: number("MAX_NETWORK_FEE_PCT",
    process.env.MAX_NETWORK_FEE_PCT || LIVE_LIMITS.maxNetworkFeePct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxNetworkFeePct : 25 }),
  maxRentLamports: number("MAX_RENT_LAMPORTS",
    process.env.MAX_RENT_LAMPORTS || LIVE_LIMITS.maxRentLamports,
    { min: 0, max: EXECUTE ? LIVE_LIMITS.maxRentLamports : 10_000_000 }),
  maxEntryRoundTripLossPct: number("MAX_ENTRY_ROUND_TRIP_LOSS_PCT",
    process.env.MAX_ENTRY_ROUND_TRIP_LOSS_PCT || LIVE_LIMITS.maxEntryRoundTripLossPct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxEntryRoundTripLossPct : 50 }),
  maxEntryQuoteDriftPct: number("MAX_ENTRY_QUOTE_DRIFT_PCT",
    process.env.MAX_ENTRY_QUOTE_DRIFT_PCT || LIVE_LIMITS.maxEntryQuoteDriftPct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxEntryQuoteDriftPct : 50 }),
  maxEntryPreflightAgeMs: number("MAX_ENTRY_PREFLIGHT_AGE_MS",
    process.env.MAX_ENTRY_PREFLIGHT_AGE_MS || LIVE_LIMITS.maxEntryPreflightAgeMs,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxEntryPreflightAgeMs : 600_000 }),
  maxExitTriggerAgeMs: number("MAX_EXIT_TRIGGER_AGE_MS",
    process.env.MAX_EXIT_TRIGGER_AGE_MS || LIVE_LIMITS.maxExitTriggerAgeMs,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxExitTriggerAgeMs : 600_000 }),
  maxAttempts: number("MAX_TX_ATTEMPTS", process.env.MAX_TX_ATTEMPTS || LIVE_LIMITS.maxAttempts,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxAttempts : 10 }),
  // Exit retries beyond maxAttempts: only when every prior attempt is terminally
  // proven dead, and never past this. See LIVE_LIMITS for why exits differ.
  maxExitAttempts: number("MAX_EXIT_TX_ATTEMPTS",
    process.env.MAX_EXIT_TX_ATTEMPTS || LIVE_LIMITS.maxExitAttempts,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxExitAttempts : 50 }),
  blockHeightWindow: number("BLOCK_HEIGHT_WINDOW",
    process.env.BLOCK_HEIGHT_WINDOW || LIVE_LIMITS.blockHeightWindow,
    { min: 150, max: EXECUTE ? LIVE_LIMITS.blockHeightWindow : 10_000 }),
  maxQuoteShortfallPct: number("MAX_QUOTE_SHORTFALL_PCT",
    process.env.MAX_QUOTE_SHORTFALL_PCT || LIVE_LIMITS.maxQuoteShortfallPct,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxQuoteShortfallPct : 100 }),
  finalityTimeoutMs: number("FINALITY_TIMEOUT_MS", process.env.FINALITY_TIMEOUT_MS || 30_000,
    { min: 1_000, max: 120_000 }),
};

// Parse this once at startup. Live operators may shorten the outage bridge, but
// cannot extend the reviewed 30-minute canary ceiling through a mutable env value.
const SOL_USD_CACHE_MAX_AGE_MS = number("SOL_USD_CACHE_MAX_AGE_MS",
  process.env.SOL_USD_CACHE_MAX_AGE_MS || LIVE_LIMITS.solUsdCacheMaxAgeMs,
  { min: 1_000, max: EXECUTE ? LIVE_LIMITS.solUsdCacheMaxAgeMs : 24 * 60 * 60_000 });

number("POLL_MS", POLL_MS, { min: 1_000, max: 3_600_000 });
number("MARK_MS", MARK_MS, EXECUTE ? { min: 5_000, max: 300_000 } : { min: 0 });
number("DESK_UNREACHABLE_MS", DESK_UNREACHABLE_MS, EXECUTE ? { min: 120_000, max: 3_600_000 } : { min: 0 });
number("RECONCILE_MS", RECONCILE_MS, EXECUTE ? { min: 15_000, max: 600_000 } : { min: 0 });
number("DESK_SILENT_MS", DESK_SILENT_MS, EXECUTE ? { min: 120_000, max: 3_600_000 } : { min: 0 });
number("FEE_RESERVE_SOL", FEE_RESERVE, { min: 0, max: 100 });
number("MAX_CALL_AGE_MIN", MAX_CALL_AGE_MS / 60_000, { min: 1, max: 10_080 });
number("MAX_FUTURE_SKEW_MIN", MAX_FUTURE_SKEW_MS / 60_000, { min: 0.1, max: 60 });
number("MAX_ENTRY_MARK_AGE_MIN", MAX_ENTRY_MARK_AGE_MS / 60_000, { min: 1, max: 60 });
number("MAX_ENTRY_DEVIATION_PCT", MAX_ENTRY_DEVIATION_PCT, { min: 0.1, max: 50 });

const releaseLock = (() => {
  try { return acquireProcessLock(LOCK_FILE); }
  catch (error) { fatal(error.message); }
})();
let journal;
try {
  journal = new ExecutionJournal(STATE_DB, {
    wallet: WALLET,
    create: !EXECUTE || fs.existsSync(STATE_DB) || process.env.LIVE_STATE_INIT_ACK === WALLET,
  });
} catch (error) {
  releaseLock();
  fatal(error.message);
}

let S = journal.snapshot();
S.state = { ...freshState(Date.now()), ...(S.state || {}) };
Object.assign(S.state, journal.rollingRisk(Date.now()));
S.positions ||= {};
/* The sniper's book, restored from its own table. Without this line a lane restarted
   mid-position forgets it holds anything: no cost basis, no armed flags, no confirmed
   high, and nothing running that would ever sell it. `save()` passes all of S, so once
   the key is here it persists on the same cadence as the desk's book. */
S.snipes ||= {};
let feedRollback = (() => {
  const value = journal.getMeta("feed_rollback");
  if (value == null) return null;
  if (value?.active === true && Number.isSafeInteger(Number(value.cursor)) &&
      Number.isSafeInteger(Number(value.latestId))) return value;
  // A corrupt durable alarm is itself reason to keep entries frozen until a valid
  // authenticated feed proves it has caught back up to the durable cursor.
  return { active: true, cursor: S.cursor, latestId: -1, observedAt: Date.now() };
})();
const feedRollbackActive = () => feedRollback?.active === true;
const persistFeedRollback = (latestId) => {
  feedRollback = {
    active: true, cursor: S.cursor, latestId: Number(latestId), observedAt: Date.now(),
  };
  journal.setMeta("feed_rollback", feedRollback);
};
const clearFeedRollback = () => {
  if (!feedRollbackActive()) return;
  feedRollback = null;
  journal.setMeta("feed_rollback", null);
};

/* ── THE TENANT'S OFF SWITCH ──────────────────────────────────────────────────
 *
 * The floor page has an off/on button now (owner, 2026-09-09: "an off/on button"). It
 * does not, and cannot, reach this process: there is no inbound port, no callback and
 * no queue. The desired state is a boolean in the `rules` block of the feed THIS
 * process asks for, and this is the whole of the mechanism — read it on the poll that
 * already happens, remember it, and let onEntry consult it.
 *
 * null until a feed has been read, and only a literal boolean moves it: an older or
 * damaged server that omits the field leaves the switch exactly where it was rather
 * than inventing a state. Not persisted on purpose — the value arrives in the SAME
 * payload as the events it governs, so a restart cannot act on an entry before it has
 * seen the flag that goes with it.
 *
 * OFF MEANS: OPEN NO NEW POSITIONS. It is checked in onEntry alone. Exits, marks,
 * reconciliation, the desk mirror, the fill reports and the heartbeat are untouched —
 * an off switch that stranded an open position would be worse than no switch.
 *
 * AND IT CANNOT TURN TRADING ON. `false` blocks; nothing here ever clears the hard-stop
 * or entry-pause sentinels, which are separate, local, and checked on their own. */
let deskEntriesEnabled = null;
const deskEntriesOff = () => deskEntriesEnabled === false;
const noteDeskEntriesRule = (rules) => {
  const wanted = rules && typeof rules === "object" ? rules.entries_enabled : undefined;
  if (wanted !== true && wanted !== false) return;
  if (wanted === deskEntriesEnabled) return;
  deskEntriesEnabled = wanted;
  log(wanted
    ? "your floor's switch is ON — new positions are permitted again (your machine's own hard stop and entry pause still bind)"
    : "your floor's switch is OFF — no new positions will be opened; exits, marks and reconciliation continue");
};
const save = () => journal.saveRuntime(S);
save();
if (process.env.INIT_ONLY === "1") {
  log(`initialized journal for ${WALLET} at ${STATE_DB}; no network request or trade was made`);
  journal.close();
  releaseLock();
  process.exit(0);
}

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping on ${signal}`);
  try { journal.close(); } catch {}
  releaseLock();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", releaseLock);

// Both independent providers use an actually aborting HTTP transport. A logical
// Promise.race elsewhere may fail closed sooner, but no abandoned socket/request can
// survive this fixed ceiling or accumulate without bound across recovery passes.
const conn = new Connection(RPC, solanaRpcConnectionConfig());
const secondaryConn = EXECUTE
  ? new Connection(SECONDARY_RPC, solanaRpcConnectionConfig())
  : null;
/* A NETWORK BLIP IS NOT A WRONG CHAIN, AND IT WAS COSTING THE BOT ITS LIFE.
 *
 * This check exists so the bot can never trade against devnet, and that part is
 * absolutely right. But it treated "the RPC did not answer" exactly like "the RPC
 * answered, and it is not mainnet" — both went to fatal(), which is process.exit(1),
 * and launchd restarts. Measured over two days of the live log: 63 cap-acknowledgement
 * lines against 14 boots, and at 06:07 on 2026-09-03 four "RPC mainnet check failed:
 * fetch failed" refusals inside 31 seconds. The bot spent much of its life dead or
 * restarting, and every restart hurt twice — it was not polling while down, and when it
 * came back the calls waiting for it were already past MAX_CALL_AGE_MIN and skipped as
 * stale ("call is 143m old (max 45m)"). A trading bot that cannot survive a dropped
 * packet cannot trade.
 *
 * So the two facts are now separated. An ANSWER that is not mainnet is a configuration
 * error: refuse at once, exactly as before, because no amount of retrying turns a
 * devnet endpoint into mainnet. A FAILURE TO REACH the provider is weather: wait and
 * ask again. The process stays alive and nothing trades until BOTH providers have
 * proved mainnet, so the guard is not weakened by a single byte — it is merely allowed
 * to be answered late.
 */
async function proveMainnetOrWait() {
  const MAX_BACKOFF_MS = 30_000;
  for (let attempt = 1; ; attempt++) {
    let genesis, secondaryGenesis;
    try {
      [genesis, secondaryGenesis] = await Promise.all([
        conn.getGenesisHash(), secondaryConn.getGenesisHash(),
      ]);
    } catch (error) {
      const waitMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt - 1, 5));
      // Once plainly, then every tenth attempt: a short outage still leaves a trace and
      // a long one does not bury the log.
      if (attempt === 1 || attempt % 10 === 0)
        log(`RPC unreachable for the mainnet check (attempt ${attempt}: ${error.message}) —` +
          ` waiting ${Math.round(waitMs / 1_000)}s and asking again.` +
          ` NOTHING is traded until both providers have proved mainnet.`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (genesis !== MAINNET_GENESIS) fatal(`RPC is not Solana mainnet-beta (genesis ${genesis})`);
    if (secondaryGenesis !== MAINNET_GENESIS)
      fatal(`secondary RPC is not Solana mainnet-beta (genesis ${secondaryGenesis})`);
    if (attempt > 1) log(`both RPC providers proved mainnet after ${attempt} attempts`);
    return;
  }
}

if (EXECUTE) await proveMainnetOrWait();

const jupiter = JUPITER_API_KEY ? new JupiterV2Executor({
  connection: conn,
  secondaryConnection: secondaryConn,
  keypair: kp,
  journal,
  apiKey: JUPITER_API_KEY,
  baseUrl: JUPITER_API_BASE,
  hardStop,
  submissionGate: (intent) => entrySubmissionGate(intent),
  log,
  config: JUPITER_CFG,
}) : null;

const openList = () => Object.values(S.positions);
// A mint's token program never changes after initialization, so one audited answer is
// cached for the life of the process. Both providers are asked first; if one is down,
// the lane that IS answering still audits the mint itself. A balance read must survive
// a single-provider outage — that failover is the whole point of the second lane — and
// entry pricing keeps its strict two-provider requirement elsewhere.
const MINT_PROGRAM_CACHE = new Map();
async function mintProgramFor(mint, connection = conn) {
  if (!MINT_PROGRAM_CACHE.has(mint)) {
    let program;
    if (secondaryConn) {
      try { program = await independentMintProgram(conn, secondaryConn, mint); }
      catch { program = await mintTokenProgram(connection, mint); }
    } else program = await mintTokenProgram(connection, mint);
    MINT_PROGRAM_CACHE.set(mint, program);
  }
  return MINT_PROGRAM_CACHE.get(mint);
}
async function heldRaw(mint, connection = conn) {
  let program, account;
  try { program = await mintProgramFor(mint, connection); }
  catch (error) { throw new RpcBalanceUnavailableError(error); }
  const ata = associatedTokenAddress(WALLET, mint, program);
  try { account = await connection.getAccountInfo(new PublicKey(ata), "confirmed"); }
  catch (error) { throw new RpcBalanceUnavailableError(error); }
  return walletTokenAmount(account, {
    program, mint, wallet: WALLET, allowMissing: true, label: `canonical ATA ${ata}`,
  });
}
/* ONE READ, NO RETRY, NO FAILOVER — ON THE PATH THAT DECIDES WHETHER WE CAN AFFORD
 * THE TRADE. A single RPC hiccup here dropped the whole call, and the log shows how
 * ordinary those hiccups are: "Solana RPC HTTP request timed out after 4000ms" and
 * "RPC could not obtain a processed-slot freshness anchor" appear throughout, and
 * roughly half the readiness rehearsals fail for transport reasons rather than trading
 * ones. Three lines below, inspectTrackedBalance already reads a token balance through
 * verifyTrackedBalanceWithFailover against BOTH providers; this read simply never
 * learned the same trick.
 *
 * Retry the primary once, then ask the independent secondary. Still throws when nothing
 * answers, because an unknown balance must never be treated as a sufficient one. */
async function solBalance() {
  const read = async (connection, label) => {
    const lamports = await connection.getBalance(kp.publicKey, "confirmed");
    if (!Number.isFinite(lamports)) throw new Error(`${label} returned a non-numeric balance`);
    return lamports / LAMPORTS;
  };
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await read(conn, "primary RPC"); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (secondaryConn) {
    try {
      const balance = await read(secondaryConn, "secondary RPC");
      log("wallet balance: the primary RPC did not answer twice; the independent secondary did" +
        ` (${lastError?.message || lastError})`);
      return balance;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function inspectTrackedBalance(pos) {
  const balance = await verifyTrackedBalanceWithFailover({
    trackedRaw: String(pos.qtyRaw || "0"),
    readPrimary: () => heldRaw(pos.mint, conn),
    readSecondary: secondaryConn ? () => heldRaw(pos.mint, secondaryConn) : null,
  });
  if (balance.verified && balance.source === "secondary") {
    log(`${pos.symbol}: primary canonical-ATA read failed; custody verified by the independent secondary RPC`);
  }
  return balance;
}

function persistBalanceBlock(pos, balance) {
  pos.balanceReconciliationRequired = true;
  pos.balanceReconciliationReason = balance.reason;
  pos.balanceObservedAt = Date.now();
  pos.balanceObservedPrimaryRaw = balance.primaryRaw ?? null;
  pos.balanceObservedSecondaryRaw = balance.secondaryRaw ?? null;
  save();
}

function clearBalanceBlock(pos) {
  delete pos.balanceReconciliationRequired;
  delete pos.balanceReconciliationReason;
  delete pos.balanceObservedAt;
  delete pos.balanceObservedPrimaryRaw;
  delete pos.balanceObservedSecondaryRaw;
}

/* The three exit kinds, told apart by the intent id sellAll was handed. Written once so
 * the latch and the intent it will submit can never disagree about which it is. */
const exitKindForIntentId = (intentId) => {
  const id = String(intentId || "");
  /* snipe-exit: MUST be named here and not left to fall through. The final branch is a
     DEFAULT, not a match — every unrecognised prefix is stamped "risk_exit" — so without
     this clause a snipe latch would carry the desk's kind, and desk-mirror.mjs
     mirrorLatchExpiry would reason about it as a risk_exit determination. A lane is not
     told apart by where the code lives; it is told apart by what the record says. */
  return id.startsWith("desk-exit:") ? "desk_exit"
    : id.startsWith("mirror-exit:") ? "mirror_exit"
    : id.startsWith("snipe-exit:") ? "snipe_exit" : "risk_exit";
};

function latchExit(pos, why, intentId, trigger = null, meta = {}) {
  if (!EXECUTE) return;
  pos.exitExecutionRequired = true;
  pos.exitExecutionReason ||= String(why || "risk exit");
  pos.exitExecutionIntentId ||= intentId;
  pos.exitExecutionObservedAt ||= Date.now();
  /* WHOSE DETERMINATION IS THIS, AND WAS IT A STAND-IN? A latch used to be a bare "sell
   * this", retried forever. A mirror_exit is the bot's own stand-in for a desk it could
   * not hear, and it must expire when the desk starts determining again (mirrorLatchExpiry
   * in desk-mirror.mjs) — a desk_exit or a risk_exit never may. Both facts are stamped
   * here, at the moment of the determination, because after the fact nothing else can
   * tell them apart. */
  pos.exitExecutionKind ||= exitKindForIntentId(intentId);
  if (!Object.hasOwn(pos, "exitExecutionStandIn"))
    pos.exitExecutionStandIn = pos.exitExecutionKind === "mirror_exit" &&
      (mirrorActive() || deskSilentPositions.has(pos.mint));
  if (trigger && !pos.exitExecutionTrigger) pos.exitExecutionTrigger = structuredClone(trigger);
  if (meta?.deskCode && !pos.exitExecutionDeskCode) pos.exitExecutionDeskCode = String(meta.deskCode);
  save();
}

function clearExitLatch(pos) {
  for (const key of ["exitExecutionRequired", "exitExecutionReason", "exitExecutionIntentId",
    "exitExecutionObservedAt", "exitExecutionTrigger", "exitExecutionLastError",
    "exitExecutionLastAttemptAt", "exitExecutionDeskCode", "exitExecutionKind",
    "exitExecutionStandIn"]) delete pos[key];
  // The impact ladder belongs to THIS latch: a new determination starts at the whole
  // position again rather than inheriting a quarter clip from a pool that has since healed.
  clearExitImpactRefusals(pos);
}

/**
 * A MIRROR LATCH IS A STAND-IN, AND IT EXPIRES.
 *
 * manageOpen retries a latched exit ahead of all other work on every pass, forever, and
 * nothing ever revalidated one. That is right for a DETERMINATION — a desk_exit is the
 * desk's word, a risk_exit is a custody/legacy path — but a mirror_exit is neither: the
 * bot produced it ONLY because the desk could not be heard. Latched, it survived the desk
 * coming back, answering, and reporting the call LIVE, so the bot would liquidate on its
 * own stale stand-in reading after the real determiner had said hold. Shrek, call 55,
 * 2026-09-05 with an extra step.
 *
 * So the determination expires the moment the party it stood in for is determining again.
 * mirrorLatchExpiry (desk-mirror.mjs) owns every clause; this applies it. Returns whether
 * the latch was dropped, so the caller re-reads the flag rather than assuming.
 */
function dropExpiredMirrorLatch(pos) {
  let intentState = null;
  try {
    /* The clip in flight is the one that matters: once the impact ladder has stepped
     * down, the sell lives under a `#clip<n>` id and the base intent sits in whatever
     * state its full-position attempt ended in. Reading only the base id could drop a
     * latch whose reduced sell had already crossed the signing boundary. */
    const current = pos.exitExecutionIntentId
      ? exitClipIntentId(pos.exitExecutionIntentId, pos, exitRetryFraction(pos)) : null;
    intentState = current
      ? journal.getIntent(current)?.state ?? journal.getIntent(pos.exitExecutionIntentId)?.state ?? null
      : null;
  } catch {}
  const expiry = mirrorLatchExpiry({ position: pos, deskReachable: deskUnreachableSince == null,
    deskSilent: deskSilentPositions.has(pos.mint), intentState });
  if (!expiry.drop) return false;
  const age = Math.round((Date.now() - (Number(expiry.observedAt) || Date.now())) / 1000);
  log(`MIRROR EXIT CANCELLED ${pos.symbol}: the mirror determined "${pos.exitExecutionReason}" ` +
    `${age}s ago while the desk could not be heard; the desk is reachable and is not silent on call ` +
    `${pos.callId} — the stand-in determination is dropped and the DESK determines this exit`);
  clearExitLatch(pos);
  save();
  return true;
}

function validEntryEvent(ev) {
  try { new PublicKey(ev.mint); } catch { throw new Error("invalid Solana mint in feed event"); }
  requirePositiveCallId(ev.call_id, "entry event call_id");
  if (!Number.isFinite(Number(ev.ts)) || Number(ev.ts) <= 0) throw new Error("entry event has no valid timestamp");
  if (Number(ev.ts) > Date.now() + MAX_FUTURE_SKEW_MS) throw new Error("entry event timestamp is too far in the future");
}

function entryEventSubmissionGate(intent) {
  if (intent?.kind !== "entry") return;
  assertEntriesUnpaused();
  const event = intent.context?.event;
  validEntryEvent(event);
  /* The same clock at submission time: a call that went stale between the preflight and
     the signature must not be signed on a price that has moved on. */
  if (Date.now() - Number(event.ts) > callExpiryMs(event))
    throw new Error("entry call became stale before submission");
  validateEntryReference(event, {
    nowMs: Date.now(), maxMarkAgeMs: MAX_ENTRY_MARK_AGE_MS,
    maxDeviationPct: MAX_ENTRY_DEVIATION_PCT,
  });
}

function entrySubmissionGate(intent) {
  entryEventSubmissionGate(intent);
  if (intent?.kind === "entry" && EXECUTE && process.env["WALLSTE_SUPERVISOR"] === "launchd") {
    requireMacEntryPower({ ownerPid: process.pid, lockFile: LOCK_FILE,
      pauseEntriesFile: PAUSE_ENTRIES_FILE });
    // The synchronous pmset/ps proof takes time. A concurrent power watcher or
    // operator pause that appeared during those reads must still close this gate.
    assertEntriesUnpaused();
  }
  validateEntryPreflightContext(intent, {
    nowMs: Date.now(), maxEntryPreflightAgeMs: JUPITER_CFG.maxEntryPreflightAgeMs,
    requireFresh: true,
  });
}

function confirmedAmounts(intent, label) {
  if (!intent || intent.state !== "confirmed")
    throw new Error(`${label} intent is not confirmed`);
  const input = String(intent.actualInputRaw ?? "");
  const output = String(intent.actualOutputRaw ?? "");
  const exactIn = String(intent.amountRaw ?? "");
  if (!/^\d+$/.test(input) || !/^\d+$/.test(output) || BigInt(input) <= 0n || BigInt(output) <= 0n)
    throw new Error(`${label} confirmed without positive actual fill totals`);
  if (!/^\d+$/.test(exactIn) || BigInt(input) !== BigInt(exactIn))
    throw new Error(`${label} actual input does not match its durable exact-in amount`);
  const networkFee = String(intent.networkFeeLamports ?? "");
  if (!/^\d+$/.test(networkFee)) throw new Error(`${label} confirmed without an exact network fee`);
  return { input, output, networkFee };
}

function recoveryRuntime(context) {
  const next = structuredClone(S);
  const liveState = structuredClone(next.state);
  if (context?.riskStateBefore && typeof context.riskStateBefore === "object") {
    const recovered = structuredClone(context.riskStateBefore);
    // A malformed pre-sign snapshot must not prevent custody accounting. Exact
    // financial rails are rebuilt from risk_events inside markAccounted anyway.
    try {
      validateRiskState(recovered, { now: Date.now() });
      next.state = recovered;
    } catch {}
  }
  // Unrelated exits may reconcile independently and carry equally old pre-sign
  // snapshots. Lifetime result counters are monotonic: restoring one snapshot may
  // never erase a result already accounted by another intent.
  for (const key of ["wins", "losses"]) {
    const live = Number(liveState?.[key]);
    const recovered = Number(next.state?.[key]);
    if (Number.isSafeInteger(live) && live >= 0 &&
        Number.isSafeInteger(recovered) && recovered >= 0)
      next.state[key] = Math.max(live, recovered);
  }
  return next;
}

/**
 * Finish the local half of a confirmed buy. This deliberately reads the event,
 * sizing decision and immutable take-profit rule from the intent journal rather
 * than from a replayed feed row or today's environment. markAccounted commits the
 * intent transition and the full runtime snapshot in one SQLite transaction; S is
 * replaced only after that commit succeeds, so a disk error cannot double-count.
 */
function applyConfirmedEntry(intent) {
  if (intent?.state === "accounted") return false;
  if (intent?.kind !== "entry") throw new Error(`intent ${intent?.id || "?"} is not an entry`);
  const { input, output, networkFee } = confirmedAmounts(intent, "entry");
  const context = intent.context || {};
  const authoredEvent = context.event;
  const plan = context.plan;
  if (context.wallet && context.wallet !== WALLET)
    throw new Error(`entry intent ${intent.id} belongs to a different wallet context`);
  if (intent.inputMint !== WSOL || intent.outputMint !== intent.mint)
    throw new Error(`entry intent ${intent.id} has an invalid durable mint route`);

  /* A finalized fill is custody reality, even if it was created by the older
   * runtime. Never let missing pre-upgrade Pyth/call metadata make that holding
   * disappear from the book or throw at the top of every future tick. New entries
   * prove the complete durable context; older/malformed contexts are represented as
   * an explicit exit-only quarantine with conservative placeholders. */
  let verified = null;
  const metadataIssues = [];
  try {
    verified = validateEntryPreflightContext(intent, {
      nowMs: Number(context.entryPreflight?.observedAt) || Date.now(),
      maxEntryPreflightAgeMs: JUPITER_CFG.maxEntryPreflightAgeMs,
      requireFresh: false,
    });
  } catch (error) {
    metadataIssues.push(`no provable independent SOL/USD entry basis: ${error.message}`);
  }
  const matchingEvent = authoredEvent &&
    String(authoredEvent.mint || "") === String(intent.mint) ? authoredEvent : null;
  const candidateCallId = Number(matchingEvent?.call_id);
  const hasExactCallId = Number.isSafeInteger(candidateCallId) && candidateCallId > 0;
  if (!hasExactCallId) metadataIssues.push("no exact durable call identity");
  if (!plan || plan.action !== "buy" || !Number.isFinite(Number(plan.sol)) || Number(plan.sol) <= 0 ||
      !Number.isFinite(Number(plan.f)) || Number(plan.f) < 0)
    metadataIssues.push("no complete durable sizing context");

  const rule = context.takeProfitRule || {};
  const durableTakeProfitX = Number(rule.takeProfitX);
  if (!Number.isFinite(durableTakeProfitX) || durableTakeProfitX <= 0 ||
      typeof rule.honorDeskTarget !== "boolean")
    metadataIssues.push("no durable take-profit rule");
  const entryReference = context.entryReference;
  if (!entryReference || !(Number(entryReference.stopRatio) > 0) ||
      Number(entryReference.stopRatio) >= 1 ||
      (entryReference.targetRatio != null && !(Number(entryReference.targetRatio) > 0)))
    metadataIssues.push("no valid durable market reference");
  const oracleVerified = Boolean(verified);
  const independentlyVerified = oracleVerified && metadataIssues.length === 0;

  const costBasisLamports = BigInt(input) + BigInt(networkFee);
  const paidSol = Number(costBasisLamports) / LAMPORTS;
  const existing = S.positions[intent.mint];
  if (existing) {
    if (existing.entryIntentId !== intent.id || String(existing.qtyRaw) !== output ||
        String(existing.costBasisLamports) !== costBasisLamports.toString() ||
        (hasExactCallId && Number(existing.callId) !== candidateCallId) ||
        (independentlyVerified && existing.solUsdSource !== PYTH_SOL_USD_CACHE_SOURCE) ||
        (!independentlyVerified && existing.accountingIncomplete !== true) ||
        Math.abs(Number(existing.paidSol) - paidSol) > 1e-12)
      throw new Error(`entry intent ${intent.id} conflicts with the recorded position`);
    const next = structuredClone(S);
    journal.markAccounted(intent.id, next);
    S = next;
    return true;
  }

  const takeProfitX = Number.isFinite(durableTakeProfitX) && durableTakeProfitX > 0
    ? durableTakeProfitX : Math.max(1, Number(CFG.takeProfitX) || 2);
  const honorDeskTarget = typeof rule.honorDeskTarget === "boolean" ? rule.honorDeskTarget : false;
  const stopBufferPct = Number(context.positionConfig?.stopBufferPct);
  const stopRatio = Number(entryReference?.stopRatio) > 0 && Number(entryReference.stopRatio) < 1
    ? Number(entryReference.stopRatio) : 0.01;
  const targetRatio = Number(entryReference?.targetRatio) > 0
    ? Number(entryReference.targetRatio) : null;
  const event = matchingEvent || {
    mint: intent.mint,
    symbol: String(authoredEvent?.symbol || intent.mint.slice(0, 6)),
    ts: Number(context.openedAtMs || intent.confirmedAt || intent.createdAt || Date.now()),
  };
  const pos = openPosition({
    call: {
      ...event,
      mint: intent.mint,
      stop: stopRatio,
      target: targetRatio,
      /* THE DESK'S ABSOLUTE LEVELS, verbatim from the feed's entry event, stored beside
       * the ratios. The ratios (stop / current_mark-at-fill, applied to a fill of 1) are
       * the numbers the bot sold Shrek on at -13.5% while the desk's stop_hit measured
       * the SAME authored stop against entry_ref on a different ruler. Mirror mode
       * evaluates these, and only these, so its level is the desk's level. */
      deskEntryRef: matchingEvent?.entry_ref,
      deskStop: matchingEvent?.stop,
      deskTarget: matchingEvent?.target,
      deskOpenedAt: Number(matchingEvent?.opened_at) > 0 ? Number(matchingEvent.opened_at)
        : (Number(matchingEvent?.ts) > 0 ? Number(matchingEvent.ts) : null),
    },
    sol: paidSol,
    fillPrice: 1,
    cfg: { stopBufferPct: Number.isFinite(stopBufferPct) ? stopBufferPct : CFG.stopBufferPct },
  });
  pos.qtyRaw = output;
  pos.paidSol = paidSol;
  pos.costBasisLamports = costBasisLamports.toString();
  pos.entryInputLamports = input;
  pos.riskF = Number.isFinite(Number(plan?.f)) && Number(plan.f) >= 0 ? Number(plan.f) : 0;
  const durableOpenedAt = Number(context.openedAtMs ?? intent.createdAt);
  pos.openedAtMs = Number.isFinite(durableOpenedAt) && durableOpenedAt > 0
    ? durableOpenedAt : Date.now();
  pos.entryIntentId = intent.id;
  if (hasExactCallId) pos.callId = candidateCallId;
  else {
    pos.callIdentityIncomplete = true;
    pos.callIdentityIncompleteReason =
      "landed legacy entry has no provable originating call_id; new entries remain blocked until it closes";
    pos.callIdentityPolicy = LEGACY_CALL_IDENTITY_POLICY;
  }
  pos.takeProfitX = takeProfitX;
  pos.honorDeskTarget = honorDeskTarget;
  if (Number(entryReference?.marketMark) > 0)
    pos.marketMarkAtEntry = Number(entryReference.marketMark);
  if (Number(entryReference?.marketMarkAt) > 0)
    pos.marketMarkObservedAt = Number(entryReference.marketMarkAt);
  const solUsdAtEntry = Number(context.entryPreflight?.solUsd);
  pos.solUsdAtEntry = Number.isFinite(solUsdAtEntry) && solUsdAtEntry > 0 ? solUsdAtEntry : 1;
  // Preserve truthful oracle provenance even when some other strategy metadata is
  // incomplete. accountingIncomplete, not a false source label, is what disarms all
  // automatic price policy for the exit-only quarantine.
  pos.solUsdSource = oracleVerified ? PYTH_SOL_USD_CACHE_SOURCE : "legacy-unverified";
  if (!independentlyVerified) {
    pos.accountingIncomplete = true;
    pos.accountingIncompleteReason =
      `landed entry has incomplete durable non-custody metadata: ` +
      `${metadataIssues.join("; ") || "durable provenance unavailable"}; ` +
      "automatic price exits are quarantined";
  }

  // An exit can arrive while this exact buy is signed/submitted/ambiguous but not
  // yet a position. The feed cursor is allowed to drain past that exit only because
  // the journal kept it. Attach the latch in the SAME transaction that accounts the
  // buy, so a crash cannot create a position that forgot the desk had already left.
  const deferredExit = journal.deferredDeskExitForEntry(intent.id);
  if (deferredExit) {
    if (deferredExit.mint !== intent.mint ||
        (hasExactCallId && Number(deferredExit.callId) !== candidateCallId))
      throw new Error(`deferred desk exit for ${intent.id} does not match the confirmed entry`);
    pos.exitExecutionRequired = true;
    pos.exitExecutionReason = deferredExit.reason;
    pos.exitExecutionIntentId = `desk-exit:${deferredExit.eventId}`;
    pos.exitExecutionObservedAt = deferredExit.observedAt;
    /* The DESK determined this one, before the buy had even accounted. Never the bot's
     * stand-in, so mirrorLatchExpiry can never drop it. */
    pos.exitExecutionKind = "desk_exit";
    pos.exitExecutionStandIn = false;
    // The desk's close code rides on the latch so the eventual sell report carries it.
    const deferredCode = /^desk exit \((.+)\)$/.exec(String(deferredExit.reason || ""))?.[1];
    if (deferredCode) pos.exitExecutionDeskCode = deferredCode;
  }

  const next = recoveryRuntime(independentlyVerified ? context : null);
  next.positions[intent.mint] = pos;
  next.state.openCount = Object.keys(next.positions).length;
  next.state.bookHeat = Object.values(next.positions)
    .reduce((sum, position) => sum + (Number(position.riskF) || 0), 0);
  journal.markAccounted(intent.id, next, { consumeDeferredDeskExit: Boolean(deferredExit) });
  S = next;
  /* The desk is told what the bot did. Queued rather than awaited: a fill is a fact
     about the chain and must never be delayed or undone by the desk being unreachable. */
  if (Number.isInteger(Number(pos?.callId)) && Number(pos.callId) > 0) {
    unreportedFills.add(Number(pos.callId));
    flushUnreportedFills().catch(() => {});
    /* And the REAL numbers behind the flag: SOL in, lamports, tokens, the entry mark. The
     * take flag alone left the site rendering the desk's paper 0.4 SOL for a 0.0175 SOL
     * fill (Shrek, call 55). Same durability rules as the flag — queued, retried every
     * tick, rebuilt from the journal at boot, acknowledged only by a journal meta key. */
    unreportedFillDetails.add(intent.id);
    flushFillReports().catch(() => {});
  }
  log(`${independentlyVerified ? "BOUGHT" : "RECOVERED + QUARANTINED"} ` +
    `${event.symbol || intent.mint.slice(0, 6)} — ${paidSol.toFixed(6)} SOL → ${output} raw — ` +
    `https://solscan.io/tx/${intent.signature}`);
  return true;
}

/** Apply a confirmed sell from its pre-submit position snapshot, never a balance read. */
function applyConfirmedExit(intent) {
  if (intent?.state === "accounted") return false;
  if (!intent || !EXIT_INTENT_KINDS.includes(intent.kind))
    throw new Error(`intent ${intent?.id || "?"} is not an exit`);
  const { input, output, networkFee } = confirmedAmounts(intent, "exit");
  if (intent.context?.wallet && intent.context.wallet !== WALLET)
    throw new Error(`exit intent ${intent.id} belongs to a different wallet context`);
  if (intent.inputMint !== intent.mint || intent.outputMint !== WSOL)
    throw new Error(`exit intent ${intent.id} has an invalid durable mint route`);
  const before = intent.context?.position;
  if (!before || String(before.mint || "") !== String(intent.mint))
    throw new Error(`exit intent ${intent.id} has no matching durable position context`);
  const beforeRaw = BigInt(String(before.qtyRaw || "0"));
  const soldRaw = BigInt(input);
  if (beforeRaw <= 0n || soldRaw > beforeRaw)
    throw new Error(`exit intent ${intent.id} fill exceeds its durable position`);
  const current = S.positions[intent.mint];
  if (current && (String(current.qtyRaw) !== String(before.qtyRaw) ||
      (before.entryIntentId && current.entryIntentId !== before.entryIntentId)))
    throw new Error(`exit intent ${intent.id} conflicts with the recorded position`);

  const basisBeforeRaw = BigInt(String(before.costBasisLamports || "0"));
  if (basisBeforeRaw <= 0n) throw new Error(`exit intent ${intent.id} has invalid durable cost basis`);
  const paidPortionRaw = soldRaw >= beforeRaw ? basisBeforeRaw : basisBeforeRaw * soldRaw / beforeRaw;
  const netProceedsRaw = BigInt(output) - BigInt(networkFee);
  const netRaw = netProceedsRaw - paidPortionRaw;
  const outSol = Number(netProceedsRaw) / LAMPORTS;
  const net = Number(netRaw) / LAMPORTS;
  const fraction = Number(intent.context?.fraction ?? 1);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new Error(`exit intent ${intent.id} has invalid durable sell fraction`);
  const fullExit = fraction >= 1 || soldRaw >= beforeRaw;
  const next = recoveryRuntime(intent.context);
  if (fullExit) {
    delete next.positions[intent.mint];
    if (net >= 0) next.state.wins = (Number(next.state.wins) || 0) + 1;
    else next.state.losses = (Number(next.state.losses) || 0) + 1;
  } else {
    next.positions[intent.mint] = {
      ...structuredClone(before),
      qtyRaw: String(beforeRaw - soldRaw),
      costBasisLamports: String(basisBeforeRaw - paidPortionRaw),
      paidSol: Number(basisBeforeRaw - paidPortionRaw) / LAMPORTS,
      entryInputLamports: String(BigInt(before.entryInputLamports) -
        (soldRaw >= beforeRaw ? BigInt(before.entryInputLamports) :
          BigInt(before.entryInputLamports) * soldRaw / beforeRaw)),
    };
  }
  next.state.openCount = Object.keys(next.positions).length;
  next.state.bookHeat = Object.values(next.positions)
    .reduce((sum, position) => sum + (Number(position.riskF) || 0), 0);
  journal.markAccounted(intent.id, next);
  S = next;
  const symbol = before.symbol || intent.mint.slice(0, 6);
  /* THE DESK IS TOLD THE BOT SOLD. Nothing ever reported an exit before this: the desk's
   * board kept Shrek "held" at the desk's paper size until the desk's own call closed,
   * nine minutes after the bot was out. Queued, never awaited — a sell is a chain fact. */
  if (Number.isInteger(Number(before?.callId)) && Number(before.callId) > 0) {
    unreportedFillDetails.add(intent.id);
    flushFillReports().catch(() => {});
  }
  log(`${fullExit ? "SOLD" : "SCALED"} ${symbol} for ${outSol.toFixed(6)} SOL` +
    `${fullExit ? ` (${net >= 0 ? "+" : ""}${net.toFixed(6)})` : ""} — https://solscan.io/tx/${intent.signature}`);
  return true;
}

function accountConfirmedIntents() {
  let count = 0;
  for (const intent of journal.pendingIntents()) {
    if (intent.state !== "confirmed") continue;
    try {
      if (intent.kind === "entry") applyConfirmedEntry(intent);
      else if (EXIT_INTENT_KINDS.includes(intent.kind)) applyConfirmedExit(intent);
      else throw new Error(`confirmed intent ${intent.id} has unsupported kind ${intent.kind}`);
      count++;
    } catch (error) {
      // One damaged accounting row must remain visible and block new exposure, but
      // it may never starve stop/desk-exit handling for every unrelated holding.
      // The confirmed state is deliberately retained for monitor/operator repair.
      log(`ACCOUNTING QUARANTINE ${intent.id}: ${error.message} — ` +
        "intent remains confirmed; unrelated position protection continues");
    }
  }
  return count;
}

/**
 * THE PAPER PREFLIGHT — every cost and geometry fence an entry faces, and no signature.
 *
 * Runs only under PAPER_PREFLIGHT (which already implies EXECUTE=0) and refuses again
 * here, because the branch below deliberately does something a live run must never do:
 * it prices the implied entry mark with a declared constant instead of the two-RPC Pyth
 * read, since paper mode has no chain to read. Everything else is the real code —
 * sizeEntryToRoute's halving ladder, planEntry re-run against the friction the route
 * actually measured, validateOrderEnvelope's rent/impact/fee/router caps, and
 * validateExecutableEntryOrder's drift/zone/stop/target tests — so a refusal here is the
 * refusal the live path would have produced from the same quotes.
 *
 * It journals nothing, signs nothing and touches no key. The line it prints is the
 * measurement: PAPER PREFLIGHT <sym> — CLEARED|REFUSED, with the numbers.
 */
async function paperPreflightEntry(ev, plan, perCall, entryReference, normalizedCall) {
  if (EXECUTE || !PAPER_PREFLIGHT) throw new Error("the paper preflight is not reachable from a live run");
  if (!jupiter) return log(`PAPER PREFLIGHT ${ev.symbol} — SKIPPED: no Jupiter client (JUPITER_API_KEY unset)`);
  const routeStopFrac = Math.max(1e-9, 1 - entryReference.stopRatio);
  const sizing = await sizeEntryToRoute({
    probe: (amountRaw) => jupiter.preflightEntryProbe(WSOL, ev.mint, amountRaw),
    sol: plan.sol, lamportsPerSol: LAMPORTS, stopRatio: entryReference.stopRatio,
    expectedNetworkFeeLamports: jupiter.cfg.expectedNetworkFeeLamports,
    slippageBps: jupiter.cfg.slippageBps,
    minSizeFor: (conservativeLossPct) => minViableSolPerTrade(perCall,
      Math.min(1, routeStopFrac + Math.max(0, conservativeLossPct) / 100)),
  });
  if (!sizing.ok) return log(`PAPER PREFLIGHT ${ev.symbol} — REFUSED [executable_cost] ${sizing.refusal}`);
  if (sizing.sizedDown) log(`SIZED ${ev.symbol} — ${sizing.reason}`);
  const sized = planEntry({ call: normalizedCall,
    cfg: { ...perCall, measuredRoundTripLossPct: sizing.conservativeLossPct,
      maxSolPerTrade: Math.min(perCall.maxSolPerTrade, sizing.sol) }, state: S.state });
  if (sized.action !== "buy")
    return log(`PAPER PREFLIGHT ${ev.symbol} — REFUSED [rails_after_cost] ${sized.reason}`);
  const amountRaw = String(Math.floor(sized.sol * LAMPORTS));
  const observedAt = Date.now();
  let order;
  try {
    order = await jupiter.order({ inputMint: WSOL, outputMint: ev.mint, amountRaw, taker: true });
    validateOrderEnvelope(order, { inputMint: WSOL, outputMint: ev.mint, amountRaw,
      wallet: jupiter.wallet, feeBasisLamports: amountRaw }, jupiter.cfg);
  } catch (error) {
    return log(`PAPER PREFLIGHT ${ev.symbol} — REFUSED [order_envelope] ${error.message}`);
  }
  const intent = { kind: "entry", amountRaw, mint: ev.mint, inputMint: WSOL, outputMint: ev.mint,
    context: { event: ev, entryReference,
      entryPreflight: {
        inputAmountRaw: String(sizing.amountRaw),
        forwardOutputRaw: String(sizing.preflight.forward.outAmount),
        reverseOutputRaw: String(sizing.preflight.reverse.outAmount),
        roundTripLossPct: sizing.preflight.lossPct,
        solUsd: PAPER_SOL_USD, solUsdSource: PYTH_SOL_USD_CACHE_SOURCE,
        solUsdPublishTime: Math.floor(observedAt / 1000) - 2,
        solUsdConfidencePct: 0.01, solUsdProviderDivergencePct: 0.01,
        tokenDecimals: Number(ev.token_decimals ?? 6), observedAt,
      } } };
  let bound;
  try {
    bound = validateExecutableEntryOrder(intent, order, { nowMs: Date.now(),
      maxEntryQuoteDriftPct: jupiter.cfg.maxEntryQuoteDriftPct,
      maxEntryPreflightAgeMs: jupiter.cfg.maxEntryPreflightAgeMs });
  } catch (error) {
    return log(`PAPER PREFLIGHT ${ev.symbol} — REFUSED [executable_quote] ${error.message}`);
  }
  const hops = Array.isArray(order.routePlan) ? order.routePlan.length : 0;
  return log(`PAPER PREFLIGHT ${ev.symbol} — CLEARED ${sized.sol} SOL ` +
    `(round trip ${sizing.preflight.lossPct.toFixed(2)}%, impact ${sizing.preflight.impactPct.toFixed(2)}%, ` +
    `drift ${bound.driftPct.toFixed(2)}%, rent ${Number(order.rentFeeLamports ?? 0)} lamports, ${hops} hop(s)) ` +
    "— PAPER, no transaction signed");
}

async function onEntry(ev) {
  const intentId = `entry:${ev.event_id || `${FLOOR}:${ev.id}`}`;
  const existingIntent = journal.getIntent(intentId);
  if (existingIntent?.state === "confirmed") {
    applyConfirmedEntry(existingIntent);
    return;
  }
  if (existingIntent?.state === "accounted") return log(`ENTRY ${ev.symbol} already accounted`);
  validEntryEvent(ev);
  if (S.positions[ev.mint]) return log(`SKIP ${ev.symbol}: already holding`);
  const unresolvedPosition = openList().find((position) => positionEntryBlock(position));
  if (unresolvedPosition)
    return log(`SKIP ${ev.symbol}: ${unresolvedPosition.symbol} blocks new exposure — ${positionEntryBlock(unresolvedPosition)}`);
  /* ONE DEFINITION OF TRADEABLE, NOT THREE. The call's age, the live mark's binding and
     the bracket's geometry were three separate tests in two files and one inline block
     here, and the desk had a fourth idea of the same thing. They are one function now
     (entry-contract.mjs), called with THIS machine's knobs, so a threshold that moves
     moves on both sides at once. The refusals it names are decisions, not transport, and
     are answered at once exactly as before. */
  const contract = entryContract(entryContractInput(ev, Date.now()));
  if (!contract.ok) {
    /* The age refusal keeps its own words: it is the one an operator reads most, and it
       names the BAND rather than a bare number so the reader can tell a nano call that
       expired on purpose from a bot that was asleep. */
    if (contract.gate === "window_expired")
      return log(`SKIP ${ev.symbol}: call is ${Math.round(contract.detail.ageMs / 60_000)}m old ` +
        `(the ${ev.hold_band || "default"} band holds for at least ${expiryLabel(ev)}, so the entry is past)`);
    return log(`SKIP ${ev.symbol}: ${contract.detail.message} [${contract.gate}]`);
  }
  if (feedRollbackActive())
    return log(`SKIP ${ev.symbol}: authenticated feed latest_id rolled behind durable cursor — entries frozen`);
  if (pauseEntries()) return log(`SKIP ${ev.symbol}: PAUSE ENTRIES file is present`);
  if (hardStop()) return log(`SKIP ${ev.symbol}: HARD STOP file is present`);
  /* The floor's own off switch, read off the feed this process polls. It sits BELOW the
     two local sentinels deliberately: those are the operator's, they are checked first,
     and no value of this flag can reach past them. This is the only place it is
     consulted — the exit path below and manageOpen never ask. */
  if (deskEntriesOff())
    return log(`SKIP ${ev.symbol}: your floor's switch is OFF — no new positions ` +
      "(exits, marks and reconciliation continue)");
  const history = journal.riskHistoryStatus(Date.now());
  if (!history.complete)
    return log(`SKIP ${ev.symbol}: rolling risk history is quarantined until ${new Date(history.incompleteUntil).toISOString()}`);

  Object.assign(S.state, journal.rollingRisk(Date.now()));
  S.state.openCount = openList().length;
  /* ONE READ, NOT TWO. These were two separate getBalance round trips a line apart, so
     every entry paid the RPC twice for the same number and could see two DIFFERENT
     numbers if a block landed between them — spendable computed from one balance and
     equity from another. Read the wallet once and derive both. */
  const walletSol = EXECUTE ? await solBalance() : null;
  S.state.spendableSol = EXECUTE ? Math.max(0, walletSol - FEE_RESERVE) : null;
  S.state.equitySol = EXECUTE ? walletSol : (S.state.equitySol ?? CFG.dailySolCap);
  S.state.bookHeat = openList().reduce((sum, pos) => sum + (pos.riskF || 0), 0);

  /* validateEntryReference's own six fields, taken off the contract that already ran it
     above rather than binding the mark a second time. The freshness this used to get by
     reading the clock AFTER the balance round trip is not lost: entryEventSubmissionGate
     re-binds on a fresh Date.now() below, immediately before anything is signed. */
  const entryReference = {
    marketMark: contract.detail.marketMark, marketMarkAt: contract.detail.marketMarkAt,
    stopRatio: contract.detail.stopRatio, targetRatio: contract.detail.targetRatio,
    entryLow: contract.detail.entryLow, entryHigh: contract.detail.entryHigh,
  };

  const takeProfitRule = resolveTakeProfitRule(ev.take_profit_x, CFG.takeProfitX);
  /* SIZE IS THIS PROCESS'S, NOT THE FEED'S. `ev.fixed_sol` and `ev.size_sol` ride on
   * every event and are read here for NOTHING.
   *
   * This line used to be `Number(ev.fixed_sol) > 0 ? Math.min(Number(ev.fixed_sol),
   * CFG.maxSolPerTrade) : CFG.fixedSol`, and the min() made it look safe: the desk
   * could only ever shrink the trade. Restoring it would be a mistake for the same
   * reason it was removed (owner, 2026-09-07) — a party that can shrink the order is
   * still choosing the order. The desk decides WHAT and WHEN; the size comes from
   * FIXED_SOL / MAX_SOL_PER_TRADE and the rails in strategy.mjs, all of which are read
   * from this machine's own environment and can only be raised by the operator typing
   * the caps acknowledgement in front of them.
   *
   * The tenant who wants a different size changes it HERE, on their own box. That the
   * server also stores a `fixed_sol` for the floor's screen is now a display fact with
   * no authority over this wallet. */
  const perCall = { ...CFG, ...takeProfitRule, fixedSol: CFG.fixedSol,
    networkFeeReserveSol: EXECUTE ? jupiter.cfg.expectedNetworkFeeLamports / LAMPORTS : 0 };
  const normalizedCall = { ...ev, entry_ref: 1, stop: entryReference.stopRatio,
    target: entryReference.targetRatio };
  let plan = planEntry({ call: normalizedCall, cfg: perCall, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol}: ${plan.reason}`);

  if (!EXECUTE) {
    log(`ENTRY ${ev.symbol} — ${plan.sol} SOL | stop ${ev.stop} target ${ev.target}`);
    if (!PAPER_PREFLIGHT) return log("PAPER — no transaction signed");
    return paperPreflightEntry(ev, plan, perCall, entryReference, normalizedCall);
  }
  if (!jupiter) throw new Error("Jupiter client is unavailable");

  /* CC_TOKEN_2022=0 is the rollback switch, and it belongs HERE: it stops new
   * Token-2022 entries without touching a held position. Inside the shared mint audit
   * it would also refuse to read the balance of a coin already owned, which blocks that
   * position's stop and, because a blocked position gates the entry queue, every
   * classic entry too. */
  if (!token2022Enabled() && (await mintProgramFor(ev.mint)) === TOKEN_2022_PROGRAM)
    throw new Error("CC_TOKEN_2022=0 keeps this executor on classic SPL Token mints");
  /* THE COST GATES ARE A SIZE DECISION, SO SIZE TO THEM (executor/entry-sizing.mjs).
   *
   * This was three binary refusals in a row — the round-trip cap, the entry impact cap
   * the order envelope applies at signing, and the stop floor below — and every one of
   * them is a function of the AMOUNT, not of the coin. A 0.4 SOL clip refused at 14%
   * round trip through a thin pool was thrown away whole and landed on the acknowledge
   * branch of the poll loop (a permanent, un-retried loss of the call), when the same
   * pool at 0.1 SOL costs 3% and clears all three.
   *
   * So the ladder re-quotes at half, at most MAX_ROUTE_HALVINGS times, and binds the
   * trade to the largest amount that clears them together. The desk is not consulted
   * anywhere in it: the starting amount is this process's own plan.sol, the caps are
   * this process's own jupiter.cfg, and the floor it stops at is strategy.mjs's own
   * minimum viable size. A cost-shaped refusal becomes a smaller fill; a wallet-shaped
   * one is still a refusal, because no cost model can wish a too-small wallet away. */
  const routeStopFrac = Math.max(1e-9, 1 - entryReference.stopRatio);
  const [sizing, tokenDecimals, solUsdOracle] = await Promise.all([
    sizeEntryToRoute({
      probe: (amountRaw) => jupiter.preflightEntryProbe(WSOL, ev.mint, amountRaw),
      sol: plan.sol, lamportsPerSol: LAMPORTS, stopRatio: entryReference.stopRatio,
      expectedNetworkFeeLamports: jupiter.cfg.expectedNetworkFeeLamports,
      slippageBps: jupiter.cfg.slippageBps,
      minSizeFor: (conservativeLossPct) => minViableSolPerTrade(perCall,
        Math.min(1, routeStopFrac + Math.max(0, conservativeLossPct) / 100)),
    }),
    independentClassicMintDecimals(conn, secondaryConn, ev.mint),
    independentSolUsdPrice(conn, secondaryConn),
  ]);
  entryEventSubmissionGate({ kind: "entry", context: { event: ev } });
  if (!sizing.ok) throw new Error(sizing.refusal);
  const preflight = sizing.preflight;
  const preliminaryAmountRaw = sizing.amountRaw;
  const conservativeLossPct = sizing.conservativeLossPct;
  if (sizing.sizedDown) log(`SIZED ${ev.symbol} — ${sizing.reason}`);
  /* The rails run again against the friction that was actually MEASURED, and against a
     ceiling the route just set. maxSolPerTrade is the honest place for it: it is a
     per-trade ceiling this process owns, and every rail below it (per-name risk, book
     heat, the daily cap, the spendable balance, the fee floor) still binds underneath. */
  plan = planEntry({ call: normalizedCall,
    cfg: { ...perCall, measuredRoundTripLossPct: conservativeLossPct,
      maxSolPerTrade: Math.min(perCall.maxSolPerTrade, sizing.sol) }, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol} after executable-cost check: ${plan.reason}`);
  const amountRaw = BigInt(Math.floor(plan.sol * LAMPORTS));
  log(`ENTRY ${ev.symbol} — ${plan.sol} SOL | stop ${ev.stop} target ${ev.target}`);
  const openedAtMs = Date.now();
  const intentContext = {
    event: ev, plan, takeProfitRule, openedAtMs, entryReference,
    entryPreflight: {
      inputAmountRaw: preliminaryAmountRaw.toString(),
      forwardOutputRaw: String(preflight.forward.outAmount),
      reverseOutputRaw: String(preflight.reverse.outAmount),
      roundTripLossPct: preflight.lossPct,
      // Never let the swap counterparty author its own USD fairness anchor.
      // Pyth is read through both independent Solana RPC providers and its
      // verification, feed id, confidence, freshness and consensus are checked.
      solUsd: solUsdOracle.price,
      solUsdSource: solUsdOracle.source,
      solUsdPublishTime: solUsdOracle.publishTime,
      solUsdConfidencePct: solUsdOracle.confidencePct,
      solUsdProviderDivergencePct: solUsdOracle.divergencePct,
      tokenDecimals,
      observedAt: solUsdOracle.observedAt,
    },
    positionConfig: { stopBufferPct: perCall.stopBufferPct },
    riskStateBefore: structuredClone(S.state),
  };
  // Apply the exact same complete gate used by restart recovery before an intent is
  // even journaled. The executor checks it again after final simulation and before
  // signing, and once more before any recovered signed bytes could be disclosed.
  entrySubmissionGate({ kind: "entry", amountRaw: amountRaw.toString(), context: intentContext });
  const fill = await jupiter.executeIntent({
    id: intentId,
    kind: "entry",
    eventId: ev.event_id || null,
    feedId: ev.id,
    mint: ev.mint,
    inputMint: WSOL,
    outputMint: ev.mint,
    amountRaw: amountRaw.toString(),
    context: intentContext,
  });
  applyConfirmedEntry(fill);
}

/** The durable id for THIS attempt: the latch's own id at a full clip, and a
 *  refusal-numbered variant once the impact ladder has stepped the clip down. */
function exitClipIntentId(baseIntentId, pos, fraction) {
  const refusals = Number(pos?.exitImpactRefusals);
  const step = Number.isSafeInteger(refusals) && refusals > 0 ? refusals : 0;
  return Number(fraction) >= 1 || step <= 0 ? baseIntentId : `${baseIntentId}#clip${step}`;
}

/* Every sell in this process goes through here. Three intent kinds, told apart by the
 * intent id the caller supplies: `desk-exit:<eventId>` is the desk's determination heard
 * on the feed; `mirror-exit:<entryIntentId>` is the desk's determination evaluated by the
 * mirror while the desk is unreachable (executor/desk-mirror.mjs); anything else is a
 * risk_exit — since desk-led-v4 only the pre-existing custody/legacy/manual paths and a
 * latch persisted by an older journal ever produce one. `meta.deskCode` is the desk's
 * close code and rides into the intent context so the fill report can carry it. */
async function sellAll(pos, why, fraction = 1, suppliedIntentId = null, trigger = null, meta = {}) {
  const baseIntentId = suppliedIntentId || `risk-exit:${pos.entryIntentId || `${pos.mint}:${pos.openedAtMs || pos.openedAt}`}`;
  /* A SMALLER CLIP IS A DIFFERENT TRANSACTION, SO IT NEEDS A DIFFERENT DURABLE INTENT.
   * journal.ensureIntent holds amountRaw immutable for an id ("changed amountRaw;
   * refusing replay") — that immutability is what makes a replay safe, so the impact
   * ladder's reduced attempt gets its own id rather than mutating the first one's. The
   * suffix is the refusal count, so it is deterministic: a crash mid-attempt resumes the
   * SAME intent instead of opening a second sell for the same clip. The latch keeps the
   * base id (latchExit assigns with ||=), and the desk still hears the base event id on
   * the fill report — the determination did not change, only how much is sold at once. */
  const intentId = exitClipIntentId(baseIntentId, pos, fraction);
  latchExit(pos, why, intentId, trigger, meta);
  const existingIntent = journal.getIntent(intentId);
  if (existingIntent?.state === "confirmed") {
    applyConfirmedExit(existingIntent);
    return;
  }
  if (existingIntent?.state === "accounted") return log(`EXIT ${pos.symbol} already accounted`);
  if (["signed", "submitted", "ambiguous"].includes(existingIntent?.state))
    return log(`EXIT ${pos.symbol} remains durably latched — ${existingIntent.state} attempt is ` +
      "handled by bounded recovery without blocking other position checks");
  if (!EXECUTE) return log(`PAPER EXIT ${pos.symbol} — ${why} — position retained; no transaction sent`);
  if (hardStop()) throw new Error("HARD STOP is present — automated exits are blocked; manage the wallet manually");

  const tracked = BigInt(pos.qtyRaw || 0);
  const balance = await inspectTrackedBalance(pos);
  if (!balance.verified) {
    persistBalanceBlock(pos, balance);
    return log(`AMBIGUOUS ${pos.symbol}: ${balance.reason} — durable position retained; manual reconciliation required`);
  }
  clearBalanceBlock(pos);
  const amount = fraction >= 1 ? tracked :
    (tracked * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
  if (amount <= 0n) throw new Error(`${pos.symbol} durable exit amount rounded to zero`);
  log(`EXIT ${pos.symbol} — ${why}`);
  const kind = exitKindForIntentId(suppliedIntentId);
  const fill = await jupiter.executeIntent({
    id: intentId,
    kind,
    eventId: kind === "desk_exit" ? baseIntentId.slice(10) : null,
    mint: pos.mint,
    inputMint: pos.mint,
    outputMint: WSOL,
    amountRaw: amount.toString(),
    context: {
      position: structuredClone(pos), why, fraction,
      trigger: trigger ? structuredClone(trigger) : null,
      deskCode: meta?.deskCode ?? pos.exitExecutionDeskCode ?? null,
      riskStateBefore: structuredClone(S.state),
    },
  });
  applyConfirmedExit(fill);
}

/* ONE GARBLED ROW MUST NOT PIN THE CURSOR FOREVER.
 *
 * handleDeskExitEvent throws on a row it cannot identify — an unparseable mint, a
 * non-positive call id — and every throw in the sequential pass leaves the cursor where
 * it is so the event is re-read next poll. For a TRANSIENT failure that is exactly
 * right. For a STRUCTURALLY unusable row it is a permanent head-of-line block: the row
 * will parse no better on the ten-thousandth poll, and behind it sit every later entry
 * AND every later exit, invisible for as long as the row exists. The desk's feed can
 * produce one without anybody being at fault — office.js builds the payload with
 * `alerts LEFT JOIN calls`, so an alert whose call row is gone yields a null mint.
 *
 * So a row that fails this test is acknowledged: logged loudly, by name, and crossed.
 * Nothing is sold and nothing is inferred from it. The safety net is reconciliation,
 * which asks the desk every RECONCILE_MS about the calls the bot is ACTUALLY HOLDING and
 * recovers a closed one as a RECOVERED DESK EXIT — a lane that does not depend on this
 * row being readable, and (since this same change) is no longer switched off by a feed
 * rollback either. Returns the reason, or null when the row is usable. */
function malformedExitRow(ev) {
  if (ev?.type !== "exit") return null;
  try { new PublicKey(ev?.mint); }
  catch { return `unusable mint ${JSON.stringify(ev?.mint ?? null)}`; }
  try { requirePositiveCallId(ev?.call_id, "desk exit call_id"); }
  catch { return `unusable call_id ${JSON.stringify(ev?.call_id ?? null)}`; }
  return null;
}

/** Execute an exit for a held position, or durably defer it for the exact buy that
 * is already beyond the no-return signing boundary but has not accounted yet. */
async function handleDeskExitEvent(ev) {
  try { new PublicKey(ev?.mint); }
  catch { throw new Error("invalid Solana mint in desk exit event"); }
  requirePositiveCallId(ev?.call_id, "desk exit call_id");
  /* THE IDEA IS OVER, SO THE HELD ENTRY IS OVER. A call whose entry was held while
     exposure was frozen must never be replayed after the desk has closed it — the exit
     is the desk's determination that the trade is finished, whether or not this bot ever
     got into it. Dropping it here also covers the case where the entry is still sitting
     in the backlog and the exit arrives in a later batch. */
  try {
    const retired = journal.dropDeferredEntriesForCall(ev.call_id);
    if (retired) log(`HELD CALL ${ev.symbol || ev.mint} (call ${ev.call_id}) retired: ` +
      "the desk closed it before exposure unfroze, so it is not offered again");
  } catch {}
  const eventId = ev.event_id || `${FLOOR}:${ev.id}`;
  const reason = `desk exit (${ev.code || "exit"})`;
  const pos = S.positions[ev.mint];
  if (pos) {
    const decision = deskExitDecisionForPosition(pos, ev);
    if (decision.action === "ignore") {
      log(`EXIT ${ev.symbol || ev.mint}: call ${decision.callId} does not match held call ${decision.positionCallId}`);
      return "different-call";
    }
    if (decision.reason === "legacy-risk-reduction")
      log(`EXIT ${ev.symbol || ev.mint}: legacy call identity is unprovable — taking the risk-reducing same-mint exit`);
    await sellAll(pos, reason, 1, `desk-exit:${eventId}`, null, { deskCode: ev.code || null });
    return "position";
  }
  const entry = journal.blockingEntryForDeskExit({ mint: ev.mint, callId: ev.call_id });
  if (!entry) return "not-held";
  journal.deferDeskExitForEntry({
    entryIntentId: entry.id, eventId, feedId: ev.id, callId: ev.call_id,
    mint: ev.mint, reason, observedAt: Date.now(),
  });
  log(`EXIT ${ev.symbol || ev.mint}: durably deferred until unresolved entry ${entry.id} is accounted`);
  return "deferred";
}

/* THE VALUATION AND CUSTODY PASS. Since desk-led-v4 this function SELLS NOTHING of its
 * own: it verifies custody on two RPCs, retries an exit that is already latched (a desk
 * exit that could not be executed yet, a deferred desk exit attached at fill, a legacy
 * risk exit, a manual-review latch), values every position on the chain-simulated
 * executable mark for the heartbeat and the board, and flags an unreadable mark as a
 * HEALTH fact (markUnavailableSince, riskDataUnavailable — a heartbeat/monitor signal,
 * and since journal.mjs POSITION_BLOCK_FLAGS dropped it, no longer an entry block). The
 * price-exit trigger path, the exit-mark-outage sell and the two-witness mark-failure
 * sell that used to live here are gone: each was a bot-originated exit, and Shrek call 55
 * (2026-09-05) showed what one costs — sold 03:01:42Z on the bot's own normalised stop,
 * the desk's determined stop_hit at 03:10:24Z landing on a position that was already gone.
 * Cadence: called from tick() only when MARK_MS has elapsed, or at once when a latched
 * exit is waiting — a determined exit is never throttled behind a valuation budget. */
async function manageOpen() {
  let currentSolUsd = null;
  let solUsdObservation = null;
  let solUsdError = null;
  if (EXECUTE && openList().length) {
    try {
      solUsdObservation = await independentSolUsdPrice(conn, secondaryConn);
      currentSolUsd = solUsdObservation.price;
    }
    catch (error) { solUsdError = error; }
  }

  /* ONE DENOMINATOR OUTAGE MUST NOT BLIND EVERY VALUATION.
   * The SOL/USD leg is fetched once per pass; when it failed, the code discarded the
   * token→WSOL quote it ALREADY HELD for every position and left mark=null. When this
   * mark still armed the bot's own stops that meant every stop was silently off during
   * a Pyth push or RPC-consensus outage; now it means the heartbeat, the monitor and the
   * board go blind on every position at once and markUnavailableSince starts for all of
   * them. SOL/USD moves single-digit percent in hours while these coins move 20%+, so a
   * cached rate is overwhelmingly better than no valuation. The cache is used for up to
   * SOL_USD_CACHE_MAX_AGE_MS with the staleness logged; past that, the fail-closed
   * "unreadable" applies.
   *
   * The window was 24h and the re-review caught why that is too generous: in a
   * combined SOL crash + quote-route outage, a day-old rate misprices every mark by
   * SOL's full daily move — which can be 20%+, the size of the very moves the stops
   * exist to catch. Thirty minutes still covers the routine outage while bounding
  * the mispricing to SOL's half-hour drift, normally low single digits. */
  if (currentSolUsd > 0) {
    S.solUsdCache = {
      v: currentSolUsd,
      ts: solUsdObservation.observedAt,
      publishTime: solUsdObservation.publishTime,
      source: PYTH_SOL_USD_CACHE_SOURCE,
    };
    /* The cache must survive a restart, because restarts CORRELATE with the outages
     * it exists for — a deploy, crash or box reboot during quote-route chaos is the
     * normal case, not the unlucky one. It lived only on the in-memory S, which
     * saveRuntime does not persist, so the first tick after any mid-outage restart
     * silently blinded every valuation the cache was built to keep readable. Durable
     * meta, best-effort: a failed write must never fail a tick. */
    try { journal.setMeta("sol_usd_cache", JSON.stringify(S.solUsdCache)); } catch {}
  } else if (solUsdError || !(currentSolUsd > 0)) {
    if (!S.solUsdCache) {
      try { const m = journal.getMeta("sol_usd_cache"); if (m) S.solUsdCache = JSON.parse(m); } catch {}
    }
    const cache = S.solUsdCache;
    // Never inherit a cache written by the old circular Jupiter SOL/USDC anchor, or
    // a Pyth cache without its immutable publish time. Both the local observation
    // and the oracle publication must remain inside the startup-validated window.
    const usableCache = usableSolUsdCache(cache, {
      nowMs: Date.now(), maxAgeMs: SOL_USD_CACHE_MAX_AGE_MS,
    });
    if (usableCache) {
      currentSolUsd = usableCache.price;
      solUsdError = null;
      log(`independent SOL/USD oracle failed — using the cached Pyth rate $${usableCache.price} ` +
        `published ${Math.round(usableCache.publishAgeMs / 60_000)}m ago so valuation stays readable`);
    }
  }

  /* Iterate by KEY and re-resolve each position from the live state. The loop used to
   * hold the array snapshot: any exit inside it swaps S for a structuredClone
   * (applyConfirmedExit), leaving every later `pos` a detached object — trail
   * ratchets written to it were silently dropped by save(), and the custody
   * entry-block flag set on it never reached the state the entry gate reads. */
  for (const posKey of openList().map((p) => p.mint)) {
    const pos = openList().find((p) => p.mint === posKey);
    if (!pos) continue;                            // exited earlier in this same pass
    try {
      if (EXECUTE) {
        const wasBlocked = pos.balanceReconciliationRequired;
        const balance = await inspectTrackedBalance(pos);
        if (!balance.verified) {
          persistBalanceBlock(pos, balance);
          log(`AMBIGUOUS ${pos.symbol}: ${balance.reason} — position management remains disarmed`);
          continue;
        }
        clearBalanceBlock(pos);
        save();
        if (wasBlocked) log(`${pos.symbol}: full canonical-ATA balance verified again — custody gate re-armed`);
      }
      // A previously latched desk/mirror/legacy exit outranks fresh market-data work.
      // Retrying it first prevents an order-service outage from delaying an exit
      // whose decision has already crossed the durable execution boundary.
      // A MIRROR LATCH IS A STAND-IN, AND IT EXPIRES — asked FIRST, so a determination
      // the desk has since taken back is never the thing the retry below executes.
      if (pos.exitExecutionRequired) dropExpiredMirrorLatch(pos);
      if (pos.exitExecutionRequired) {
        /* The clip steps down only after an impact refusal; with none recorded this is 1
         * and the whole position is sold, exactly as before. */
        const fraction = exitRetryFraction(pos);
        if (fraction < 1)
          log(`EXIT RETRY ${pos.symbol}: selling ${(fraction * 100).toFixed(0)}% of the position after ` +
            `${pos.exitImpactRefusals} price-impact refusal(s) — the determination is unchanged, the clip is smaller`);
        await sellAll(pos, pos.exitExecutionReason || "required risk exit", fraction,
          pos.exitExecutionIntentId || null, pos.exitExecutionTrigger || null,
          { deskCode: pos.exitExecutionDeskCode || null });
        continue;
      }
      if (pos.accountingIncomplete) {
        // A quarantined legacy basis has no readable valuation; explicit desk exits for
        // the mint are still executed the moment the feed carries one.
        log(`${pos.symbol}: legacy accounting/SOL-USD basis is incomplete — ` +
          "valuation disarmed; explicit same-mint desk exits remain enabled");
        continue;
      }
      let mark = null;
      if (jupiter && pos.qtyRaw && BigInt(pos.qtyRaw) > 0n) {
        try {
          if (solUsdError || !(currentSolUsd > 0))
            throw new Error(`independent SOL/USD mark unavailable: ${solUsdError?.message || "no usable Pyth cache"}`);
          const observation = await jupiter.preflightExitMark({
            mint: pos.mint, amountRaw: pos.qtyRaw, position: pos,
          });
          mark = executableExitMark(pos, observation.actualOutputRaw, currentSolUsd);
          pos.valuationMark = mark;
          pos.valuationMarkAt = Date.now();
          clearMarkUnavailable(pos);
          /* A READABLE QUOTE DOES NOT ANSWER "WHICH COIN IS THIS?". When reconciliation
           * has caught the desk answering about a DIFFERENT mint under this call id, the
           * unusable risk data is the desk's answer, not the exit quote — clearing the
           * flag here would let a healthy Jupiter quote silently unblock new exposure
           * while the identity contradiction stands. Only reconciliation lifts it, and
           * only when a row names the held mint again. */
          if (pos.deskIdentityMismatch !== true) {
            delete pos.riskDataUnavailable;
            delete pos.riskDataUnavailableReason;
            delete pos.riskDataUnavailableAt;
          }
          save();
        }
        catch (error) {
          pos.riskDataUnavailable = true;
          pos.riskDataUnavailableReason = `independent executable exit mark unavailable: ${error.message}`;
          pos.riskDataUnavailableAt = Date.now();
          /* AN UNREADABLE MARK IS A HEALTH FLAG, NEVER A SELL.
           *
           * Two bot-originated exits used to live in this catch. A sustained TRANSPORT
           * outage (longer than EXIT_MARK_OUTAGE_LATCH_MS) latched a risk-reducing sell,
           * and two consecutive NON-transport failures latched one at once — the threat
           * being an order service that hides a breached stop by refusing every exit
           * quote. On 2026-09-04 the two-tick latch sold TOAD thirty-two minutes into a
           * very_high hold on two "Failed to get quotes" four seconds apart, and the fix
           * was to classify. Under desk-led-v4 the classification is all that survives:
           * the bot has no stop of its own for a hostile quote service to hide, the desk
           * determines the exit on its own ruler, and a desk_exit intent never consults
           * this mark. So a failed mark timestamps markUnavailableSince for the heartbeat
           * and monitor, says whether it looks like weather or like a refusal — and
           * holds. Shrek, call 55: a bot that sells on its own reading is a bot that
           * sells nine minutes before the desk.
           *
           * IT NO LONGER BLOCKS NEW ENTRIES, and that is this change, not an oversight:
           * riskDataUnavailable left journal.mjs POSITION_BLOCK_FLAGS. Under v4 this
           * mark decides nothing — a desk_exit never consults it — so one coin the bot
           * cannot quote was silencing the whole book, and a drained pump.fun pool
           * produces exactly that all day. Custody and identity facts still block. */
          const transient = isTransientEntryFailure(error);
          const outageMs = noteMarkUnavailable(pos, {
            observedAt: pos.riskDataUnavailableAt, reason: error.message, transient,
          });
          save();
          log(`mark ${pos.symbol}: ${error.message} — ${transient ? "transient (transport)" : "not a transport failure"}; ` +
            `valuation unreadable for ${Math.round(outageMs / 1000)}s; new entries blocked; ` +
            "held for the desk's determination — no local exit");
        }
      }
      /* Valuation only. stepPosition holds unless a desk exit is supplied, and none is
       * supplied here — desk exits arrive on the feed and are executed there. The call
       * stays so the invariant is exercised on every pass, and a sell verdict without a
       * desk exit is logged as the contradiction it would be, and refused. */
      const decision = stepPosition({ pos, mark, deskExit: null, cfg: policyConfigForPosition(pos, CFG) });
      if (decision.action !== "hold") {
        log(`REFUSED ${pos.symbol}: local policy asked to ${decision.action} (${decision.reason}) ` +
          "without a desk exit — desk-led-v4 has no exit of its own");
      }
      save();
    } catch (error) {
      recordPositionFailure(posKey, error, "manage");
    }
  }
}

/* A sellAll above may have swapped S for a clone; write the failure onto the LIVE
 * object or the flags evaporate with the detached one. Shared by the valuation pass
 * and the mirror pass so both record a failed exit the same way. */
function recordPositionFailure(posKey, error, phase) {
  const live = openList().find((p) => p.mint === posKey);
  const pos = live ?? { symbol: posKey };
  if (!live) { log(`${phase} ${pos.symbol}: ${error.message} — position left the book mid-pass`); return; }
  if (pos.exitExecutionRequired) {
    if (error?.code === "EXIT_TRIGGER_NOT_MET") {
      /* Only a price trigger persisted by a pre-v4 journal can reach here — desk_exit
       * and mirror_exit intents are exempt from re-validation. Clearing the stale
       * latch is still right: the position is then held for the desk's determination. */
      clearExitLatch(pos);
      save();
      log(`EXIT CANCELLED ${pos.symbol}: ${error.message} — legacy price trigger no longer confirms; ` +
        "held for the desk's determination");
      return;
    }
    pos.exitExecutionLastError = error.message;
    pos.exitExecutionLastAttemptAt = Date.now();
    /* A DRAINED POOL IS A CLIP SIZE, NOT AN OPERATOR. This branch used to set
     * manualExitRequired on the first "price impact X% exceeds cap" — which permanently
     * disabled the automated exit for the position and froze every entry on the book
     * behind it. A full-position sell into a bled-out pump.fun pool quotes over 50%
     * impact routinely; the answer is a smaller clip on the next tick (the ladder in
     * exit-trigger.mjs: whole position, half, quarter), with the exit still LATCHED and
     * still retried ahead of all other work. Manual review stays reserved for custody
     * and identity facts — a balance two RPCs disagree on, a desk row about another
     * coin — where an operator really is the only next step. */
    if (isPriceImpactRefusal(error.message)) {
      const next = noteExitImpactRefusal(pos, { observedAt: Date.now(), reason: error.message });
      save();
      log(`EXIT IMPACT ${pos.symbol}: ${error.message} — the exit remains latched and the next attempt ` +
        `sells ${(next * 100).toFixed(0)}% of the position (refusal ${pos.exitImpactRefusals}); ` +
        "price impact is not a custody or identity fact, so nothing is latched for manual review");
      return;
    }
    save();
    log(`EXIT BLOCKED ${pos.symbol}: ${error.message} — fired exit remains latched; new entries blocked`);
  } else {
    pos.riskDataUnavailable = true;
    pos.riskDataUnavailableReason = `position management failed: ${error.message}`;
    pos.riskDataUnavailableAt = Date.now();
    save();
    log(`${phase} ${pos.symbol}: ${error.message} — new entries blocked`);
  }
}

let ticking = false;
/* Self-reported liveness for the floor's bot card. Outbound-only, same read-only
 * secret as the feed, fire-and-forget: a dead site must never delay a stop check,
 * so failures are silent and nothing awaits it in the trade path. It carries no
 * secret and opens no control channel — the server learns the bot's pulse, not its
 * reins. Throttled to once a minute. */
let lastHeartbeatAt = 0;
const runtimeHealth = {
  lastTickStartedAt: 0, lastTickCompletedAt: 0, lastFeedSuccessAt: 0,
  consecutiveFeedFailures: 0, consecutiveTickFailures: 0,
  executionReadiness: EXECUTE ? {
    ready: false, lastSuccessAt: 0, observedAt: 0, route: "wsol-usdc", providers: 0,
    amountLamports: Math.floor(CFG.maxSolPerTrade * LAMPORTS),
  } : null,
};
let readinessProbeInFlight = false;
let lastReadinessProbeAt = 0;
let lastReadinessError = null;
/* 0 means "never logged one", so the first success after boot always speaks. */
let lastReadinessSuccessLoggedAt = 0;
function maybeProbeExecutionReadiness() {
  if (!EXECUTE || !jupiter || readinessProbeInFlight ||
      Date.now() - lastReadinessProbeAt < 2 * 60_000) return;
  lastReadinessProbeAt = Date.now();
  readinessProbeInFlight = true;
  /* A PROBE THAT NEVER SETTLES TAKES THE REHEARSAL WITH IT, PERMANENTLY.
   *
   * `readinessProbeInFlight` is cleared in a .finally(), which is correct for a promise
   * that resolves or rejects — and useless for one that does neither. Every leg inside
   * has its own timeout today, but "every leg I know about" is not the same as "the
   * whole thing terminates", and the failure is silent and absorbing: the flag stays
   * true, every later tick returns early, and the bot stops rehearsing with no line in
   * the log to say so. Observed on 2026-09-03: no readiness line of either kind for
   * nineteen minutes across roughly eighty ticks, on a process whose tick loop was
   * demonstrably alive.
   *
   * So the probe is raced against a deadline generous enough that it never truncates a
   * healthy rehearsal — the /order fetch alone is allowed twelve seconds — and the race
   * is what the .finally() hangs off. A timeout is reported like any other failure, so
   * a hang is now visible instead of absorbing. This gates nothing: the rehearsal signs
   * nothing and is not consulted before an entry, so the only thing at risk was our
   * ability to see. */
  const readinessDeadlineMs = Math.max(30_000, Number(process.env.READINESS_TIMEOUT_MS) || 90_000);
  let readinessTimer = null;
  const readinessDeadline = new Promise((_, reject) => {
    readinessTimer = setTimeout(
      () => reject(new Error(`readiness rehearsal exceeded ${Math.round(readinessDeadlineMs / 1000)}s and was abandoned`)),
      readinessDeadlineMs);
    readinessTimer.unref?.();
  });
  Promise.race([
    jupiter.probeExecutionReadiness({ amountLamports: Math.floor(CFG.maxSolPerTrade * LAMPORTS) }),
    readinessDeadline,
  ]).then((result) => {
    const succeededAt = Date.now();
    /* A REHEARSAL THAT SUCCEEDS SILENTLY IS INDISTINGUISHABLE FROM ONE THAT NEVER RAN.
     *
     * This logged a success ONLY when it cleared a previous failure, so on a healthy
     * process — where lastReadinessError starts null and stays null — a passing
     * rehearsal every two minutes wrote nothing at all. Every "proved" line in the log
     * is therefore a RECOVERY, which is why they only ever appear paired with a "not
     * proved" line above them.
     *
     * That cost real time and two restarts of the live bot on 2026-09-03: I read the
     * silence after a clean boot as the rehearsal having stopped, went looking for a
     * hang that was not there, and reverted a good change on the correlation. Silence
     * meant it was working.
     *
     * So a success now speaks: always the first one after boot, so an operator learns
     * the bot can trade rather than inferring it; then at most one an hour, so a
     * healthy desk leaves a heartbeat in the log without burying it. A recovery still
     * logs immediately, as it always did. */
    const readinessSuccessQuietMs = 3_600_000;
    const recovered = result?.ready === true && lastReadinessError !== null;
    const dueForHeartbeat = result?.ready === true &&
      succeededAt - lastReadinessSuccessLoggedAt >= readinessSuccessQuietMs;
    if (recovered || dueForHeartbeat) {
      lastReadinessError = null;
      lastReadinessSuccessLoggedAt = succeededAt;
      /* The compute budget is reported because it is what the bot is actually bidding
         with. Agave ranks buffered transactions by reward/(cost+1) where cost follows
         the REQUESTED compute-unit limit, so a transaction asking for the 1,400,000
         default while using a fraction of it is quietly outbid by identical money. */
      const budget = result.computeUnitLimit != null
        ? ` — built with ${Number(result.computeUnitLimit).toLocaleString()} CU limit` +
          (result.computeUnitPriceMicroLamports != null
            ? ` at ${result.computeUnitPriceMicroLamports} microlamports/CU` : "")
        : "";
      log(`READINESS proved: ${result.route} at ${CFG.maxSolPerTrade} SOL on ${result.providers} providers, nothing signed${budget}`);
    }
    runtimeHealth.executionReadiness = {
      ready: result?.ready === true,
      lastSuccessAt: result?.ready === true ? succeededAt : 0,
      observedAt: Number(result?.observedAt) || succeededAt,
      route: result?.route === "wsol-usdc" ? "wsol-usdc" : null,
      providers: Number(result?.providers) === 2 ? 2 : 0,
      amountLamports: Number(result?.amountLamports) || 0,
    };
  }).catch((error) => {
    /* SAY WHY IT IS NOT READY.
     *
     * This catch was empty, so a failing probe set providers to 0 and wrote nothing
     * anywhere. An operator watching "READINESS PROVIDERS 0/2" could not tell whether
     * the probe had never run, could not reach a provider, or had run and been refused
     * — and the commonest cause by far is simply an unfunded wallet, which the message
     * names outright. A refusal that cannot be read is the same defect as a refusal
     * that never happened. Repeats are collapsed so a persistent cause logs once. */
    const reason = String(error?.message || error).slice(0, 300);
    if (reason !== lastReadinessError) {
      lastReadinessError = reason;
      const need = Math.floor(CFG.maxSolPerTrade * LAMPORTS) +
        Number(jupiter.cfg.maxNetworkFeeLamports ?? 500_000) +
        Number(jupiter.cfg.maxRentLamports ?? 4_200_000) + 10_000_000;
      log(`READINESS not proved (${EXECUTION_READINESS_ROUTE} at ${CFG.maxSolPerTrade} SOL): ${reason}` +
        ` — this no-sign rehearsal needs about ${(need / LAMPORTS).toFixed(4)} SOL in the wallet ` +
        "(the trade size, the network-fee ceiling, two ATAs of rent and an untouched reserve)");
    }
    runtimeHealth.executionReadiness = {
      ready: false,
      lastSuccessAt: Number(runtimeHealth.executionReadiness?.lastSuccessAt) || 0,
      observedAt: Date.now(), route: "wsol-usdc", providers: 0,
      amountLamports: Math.floor(CFG.maxSolPerTrade * LAMPORTS),
      lastError: reason,
    };
  }).finally(() => { clearTimeout(readinessTimer); readinessProbeInFlight = false; });
}
/* WHICH ENTRY FAILURES DESERVE ANOTHER LOOK.
 *
 * Deliberately an allowlist of TRANSPORT failures, matched on the message. Anything not
 * listed is treated as a decision and acknowledged at once, so a misclassification costs
 * a retry that never happens rather than a call retried for ever. Every pattern here is
 * one observed in the live log. */
const TRANSIENT_ENTRY_FAILURE = [
  /timed out/i, /timeout/i, /fetch failed/i, /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i,
  /socket hang up/i, /network error|network request failed|temporarily unavailable/i,
  /minimum context slot has not been reached/i,
  /could not (?:obtain|produce)[^.]*(?:anchor|snapshot)/i,
  /failed to get quotes/i, /HTTP 5\d\d/i, /\b(?:429|502|503|504)\b/,
  /rate limit/i, /blockhash not found/i,
  /* CONSENSUS IS A TWO-PROVIDER READ, AND ONE PROVIDER BLINKING IS WEATHER.
   *
   * The entry path prices the trade through two independent RPC views — the classic
   * mint audit in jupiter.mjs and the Pyth SOL-USD oracle in sol-usd-oracle.mjs — and
   * both fail closed when either read is rejected or the two views differ. That is
   * right, and it is not being loosened: a forged decimals byte moves the absolute USD
   * entry anchor by powers of ten. But the failure was landing on the acknowledge
   * branch below, so ONE slow provider consumed a published call permanently — the
   * dropped-packet-as-decision defect this allowlist exists to cure. Retried instead,
   * bounded by MAX_ENTRY_RETRIES (6) with the cursor pinned, so a genuine forgery keeps
   * disagreeing across six polls and is acknowledged about ninety seconds later.
   *
   * Deliberately narrow. The sibling failure "requires two distinct RPC connections" is
   * a misconfiguration rather than weather, matches neither pattern, and is still
   * answered at once. */
  /requires successful reads from both RPC providers/i,
  /RPC views disagree/i,
];
/* EXIT_MARK_OUTAGE_LATCH_MS is retired (desk-led-v4): the sustained-outage sell it bounded
 * was a bot-originated exit. The name stays on the launchd allowlist so an existing env
 * file still validates; the value is ignored. */

const isTransientEntryFailure = (error) => {
  const message = String(error?.message || error);
  return TRANSIENT_ENTRY_FAILURE.some((re) => re.test(message));
};
/* Six attempts at a 15-second poll is about ninety seconds of patience — long enough to
 * outlast the RPC hiccups in the log, short enough that a call cannot block the queue. */
const MAX_ENTRY_RETRIES = Math.max(1, Math.min(20, Number(process.env.MAX_ENTRY_RETRIES) || 6));
const entryRetries = new Map();
const bumpEntryRetry = (key) => {
  const next = (entryRetries.get(key) || 0) + 1;
  entryRetries.set(key, next);
  // The map only ever holds events currently being retried; anything that succeeds or
  // is acknowledged is deleted, and a bounded feed cannot grow it without limit.
  if (entryRetries.size > 200) for (const k of entryRetries.keys()) { entryRetries.delete(k); break; }
  return next;
};

/* HOW LONG A PUBLISHED CALL STAYS GOOD — the band's own clock, not a flat number.
 *
 * One 45-minute window was wrong in both directions. A nano coin's move is decided in
 * minutes, so a 40-minute-old nano call is an entry into something already over; a $5m
 * coin held for a day is still a perfectly good entry an hour after it was published.
 * The flat figure also ate two real calls in one restart window — "SKIP FWOG: call is
 * 143m old", "SKIP Jimothy: call is 130m old", both at 06:08:30 on 2026-09-03.
 *
 * The expiry is the band's MINIMUM HOLD, which the desk already publishes on every
 * call: nano 1 minute, micro 20, low/medium/high 1 hour, very_high 5. The reasoning is
 * the owner's — if more time has passed than you would have held the position for, the
 * entry idea is gone. A call carrying no band falls back to the flat setting.
 *
 * The floor exists because a call must survive several polls AND the preflight that
 * follows: an expiry under that could retire a call before the bot ever saw it, or
 * while it was still inside the fences that protect the trade. */
/* ONE FLOOR, ONE DEFINITION — and it is no longer a guess. This used to be a literal
   60_000 spelled out here beside the contract's own, with a test to keep the two equal;
   an identity needs no such test. The number itself was a poll-rate argument until
   executor/test-entry-window.mjs timed the pipeline it has to cover: 28 requests, 12 of
   them SERIAL, and 68_000ms when those 12 are priced at this executor's own
   per-request deadlines (Jupiter /order 12s x3, RPC 4s, slot anchor 2s, epoch 2s) —
   longer than the minute a nano call used to get, before POLL_MS is even spent reaching
   the alert row. See the note on ENTRY_WINDOW_FLOOR_MS for the measurement. */
const MIN_CALL_EXPIRY_MS = ENTRY_WINDOW_FLOOR_MS;
const callExpiryMs = (ev) => entryWindowMs({
  holdMinMs: ev?.hold_min_ms, floorMs: MIN_CALL_EXPIRY_MS, fallbackMs: MAX_CALL_AGE_MS,
});
/* Everything the contract judges, read off one feed event with this machine's own
   thresholds. MAX_ENTRY_MARK_AGE_MIN, MAX_ENTRY_DEVIATION_PCT and MAX_CALL_AGE_MIN keep
   their meaning exactly: an operator who tightens one still tightens it here. */
const entryContractInput = (ev, nowMs) => ({
  entryRef: ev?.entry_ref, entryLo: ev?.entry_lo, entryHi: ev?.entry_hi,
  stop: ev?.stop, target: ev?.target,
  mark: ev?.current_mark, markAt: ev?.current_mark_at,
  now: nowMs, holdBand: ev?.hold_band, holdMinMs: ev?.hold_min_ms, alertTs: ev?.ts,
  costPct: CFG.costPct,
  maxMarkAgeMs: MAX_ENTRY_MARK_AGE_MS, maxDeviationPct: MAX_ENTRY_DEVIATION_PCT,
  windowFloorMs: MIN_CALL_EXPIRY_MS, windowFallbackMs: MAX_CALL_AGE_MS,
});
const expiryLabel = (ev) => {
  const ms = callExpiryMs(ev);
  // Seconds under two minutes: the floor is 90_000 now, and "2m" is a rounding of it
  // that matches neither the window nor the band's own one-minute hold.
  if (ms < 120_000) return `${Math.round(ms / 1_000)}s`;
  return ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(0)}h` : `${Math.round(ms / 60_000)}m`;
};

const noteFeedFailure = () => { runtimeHealth.consecutiveFeedFailures++; };
const noteFeedSuccess = () => {
  runtimeHealth.lastFeedSuccessAt = Date.now();
  runtimeHealth.consecutiveFeedFailures = 0;
};
/* TELLING THE DESK THE TRADE HAPPENED.
 *
 * The `taken` flag is what the site reads to show a position on the floor's board, and
 * nothing in this executor ever set it — only a human clicking in the UI did. So on
 * 2026-09-04 the bot bought TOAD (signed, confirmed, finalized, 491m tokens in the
 * wallet) and the site showed nothing at all. The trade was real and invisible, which
 * is indistinguishable from a bot that never traded.
 *
 * Reported on the same read-only secret as the feed and the heartbeat: this states a
 * fact about our own floor and gives the server no control over us.
 *
 * NOT fire-and-forget. That mistake is already in this codebase once — the desk's entry
 * alert was posted without awaiting it and a failed write lost a call silently. A fill
 * that cannot be reported stays in the queue and is retried on every tick until the
 * desk acknowledges it, and the queue is rebuilt from the journal at boot so a restart
 * mid-report does not drop it. */
const unreportedFills = new Set();
let reportingFills = false;

async function reportTakenCall(callId) {
  const response = await fetch(`${API}/api/floor/${FLOOR}/executor/take`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ callId, taken: true }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`take HTTP ${response.status}`);
  return true;
}

async function flushUnreportedFills() {
  if (reportingFills || !unreportedFills.size) return;
  reportingFills = true;
  try {
    for (const callId of [...unreportedFills]) {
      try {
        await reportTakenCall(callId);
        unreportedFills.delete(callId);
        log(`reported fill of call ${callId} to the desk`);
      } catch (error) {
        // Left in the queue on purpose; the next tick tries again.
        log(`could not report fill of call ${callId} (${error.message}) — will retry`);
      }
    }
  } finally { reportingFills = false; }
}

/** Every open position whose fill the desk has not acknowledged. Rebuilt at boot so a
 *  restart between the fill and the report does not lose it. */
function queueUnreportedFillsFromJournal() {
  for (const position of Object.values(S.positions || {})) {
    const callId = Number(position?.callId);
    if (Number.isInteger(callId) && callId > 0) unreportedFills.add(callId);
  }
}

function sendHeartbeat() {
  if (Date.now() - lastHeartbeatAt < 60_000) return;
  lastHeartbeatAt = Date.now();
  let health;
  try {
    health = executorHeartbeatHealth({
      entriesPaused: pauseEntries(), hardStop: hardStop(),
      /* The floor's switch, ECHOED not obeyed-in-silence: the page shows what this bot
         says it heard, never what the server asked for. Until this line reports the
         value the tenant pressed, their screen says the request is pending — because
         it is. */
      deskEntriesEnabled,
      blockingIntent: Boolean(journal.hasBlockingIntent()), positions: openList(),
      lastTickCompletedAt: runtimeHealth.lastTickCompletedAt,
      lastFeedSuccessAt: runtimeHealth.lastFeedSuccessAt,
      consecutiveFeedFailures: runtimeHealth.consecutiveFeedFailures,
      consecutiveTickFailures: runtimeHealth.consecutiveTickFailures,
      feedRollback: feedRollbackActive(),
      deskUnreachableSince, mirrorActive: mirrorActive(),
      executionReadiness: runtimeHealth.executionReadiness,
      caps: {
        maxSolPerTrade: CFG.maxSolPerTrade,
        dailySolCap: CFG.dailySolCap,
        dailyLossLimitSol: CFG.dailyLossLimitSol,
        maxOpenPositions: CFG.maxOpenPositions,
      },
      runtimeCommit: process.env.EXECUTOR_SOURCE_COMMIT || null,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    });
  } catch {
    // Telemetry can lose detail; it can never stop the trading/reconciliation loop.
    health = executorHeartbeatHealth({
      entriesPaused: pauseEntries(), hardStop: hardStop(), deskEntriesEnabled, blockingIntent: true,
      lastTickCompletedAt: runtimeHealth.lastTickCompletedAt,
      lastFeedSuccessAt: runtimeHealth.lastFeedSuccessAt,
      consecutiveFeedFailures: runtimeHealth.consecutiveFeedFailures,
      consecutiveTickFailures: runtimeHealth.consecutiveTickFailures + 1,
      feedRollback: feedRollbackActive(),
      deskUnreachableSince, mirrorActive: mirrorActive(),
      executionReadiness: runtimeHealth.executionReadiness,
      caps: {
        maxSolPerTrade: CFG.maxSolPerTrade,
        dailySolCap: CFG.dailySolCap,
        dailyLossLimitSol: CFG.dailyLossLimitSol,
        maxOpenPositions: CFG.maxOpenPositions,
      },
      runtimeCommit: process.env.EXECUTOR_SOURCE_COMMIT || null,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    });
  }
  fetch(`${API}/api/floor/${FLOOR}/executor/heartbeat`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      mode: EXECUTE ? "live" : "paper",
      wallet: WALLET,
      cursor: S.cursor,
      open: openList().length,
      // WHICH coins, not just how many — the call cards need to say "your bot is in
      // THIS one" rather than leaving a tenant to infer it from a count. Mint and
      // size only: no prices, no PnL, nothing the server could use against the
      // operator, and still nothing it can act on.
      held: openList().slice(0, 20).map((p) => ({
        mint: p.mint,
        sol: Number((Number(p.entryInputLamports || 0) / LAMPORTS).toFixed(4)),
        openedAt: Number(p.openedAtMs) || 0,
      })),
      health,
      ts: Date.now(),
    }),
  }).catch(() => {});
}

/* TELLING THE DESK WHAT THE TRADE WAS — every fill AND every exit, with real numbers.
 *
 * The take flag (above) says only "the bot is in call N". It cannot say for how much, and
 * it cannot say the bot has left: Shrek, call 55, 2026-09-05 — the site showed the desk's
 * paper 0.4 SOL for a real 0.0175 SOL fill and kept showing it after the bot had sold.
 * This posts the buy (SOL in, lamports, tokens, entry mark, SOL/USD) and the sell (tokens
 * sold, SOL out, realized, fraction, reason, kind, the desk's code and event) to
 * POST /api/floor/:n/executor/fill, keyed by the intent id and the signature.
 *
 * Same durability rules as the flag, and one more. Queued, never awaited; retried every
 * tick; a non-2xx (404 included — a 200 for a write that did not happen would end the
 * retry that surfaces it) leaves it queued. The acknowledgement is a journal meta key,
 * fill_reported:<intentId>, because the take queue's boot rebuild walks S.positions and
 * an exited position is DELETED at accounting — a sell report that failed to post could
 * never be rebuilt that way. Boot instead walks every accounted intent with a callId in
 * the last seven days and re-queues those without the key. */
const unreportedFillDetails = new Set();
let reportingFillDetails = false;
const FILL_REPORT_WINDOW_MS = 7 * 24 * 3600e3;
const fillReportedKey = (intentId) => `fill_reported:${intentId}`;

/** The exact body the desk stores, built from the durable intent alone so a boot
 *  rebuild can produce it after the position is gone. Null when unattributable. */
function fillReportBody(intent) {
  if (!intent || intent.state !== "accounted") return null;
  const context = intent.context || {};
  const digits = (value) => /^\d+$/.test(String(value ?? "")) ? BigInt(String(value)) : null;
  if (intent.kind === "entry") {
    const callId = Number(context.event?.call_id);
    if (!Number.isSafeInteger(callId) || callId <= 0) return null;
    const input = digits(intent.actualInputRaw);
    const output = digits(intent.actualOutputRaw);
    const fee = digits(intent.networkFeeLamports) ?? 0n;
    if (input == null || output == null || !intent.signature) return null;
    const openedAt = Number(context.openedAtMs) || Number(intent.confirmedAt) || Number(intent.createdAt) || 0;
    return {
      callId, side: "buy", signature: intent.signature, wallet: WALLET, at: openedAt,
      sizeSol: Number(input + fee) / LAMPORTS,
      lamportsIn: Number(input),
      qtyRaw: output.toString(),
      entryMark: Number(context.entryReference?.marketMark) > 0 ? Number(context.entryReference.marketMark) : null,
      solUsd: Number(context.entryPreflight?.solUsd) > 0 ? Number(context.entryPreflight.solUsd) : null,
      intentId: intent.id,
    };
  }
  if (EXIT_INTENT_KINDS.includes(intent.kind)) {
    const before = context.position || {};
    const callId = Number(before.callId);
    if (!Number.isSafeInteger(callId) || callId <= 0) return null;
    const soldRaw = digits(intent.actualInputRaw);
    const output = digits(intent.actualOutputRaw);
    const fee = digits(intent.networkFeeLamports) ?? 0n;
    const beforeRaw = digits(before.qtyRaw);
    const basis = digits(before.costBasisLamports);
    if (soldRaw == null || output == null || beforeRaw == null || basis == null || beforeRaw <= 0n ||
        !intent.signature) return null;
    const paidPortion = soldRaw >= beforeRaw ? basis : basis * soldRaw / beforeRaw;
    const proceeds = output - fee;
    const fraction = Number(context.fraction ?? 1);
    return {
      callId, side: "sell", signature: intent.signature, wallet: WALLET,
      at: Number(intent.confirmedAt) || Number(intent.updatedAt) || 0,
      qtyRaw: soldRaw.toString(),
      sol: Number(proceeds) / LAMPORTS,
      realizedSol: Number(proceeds - paidPortion) / LAMPORTS,
      fraction: Number.isFinite(fraction) && fraction > 0 ? fraction : 1,
      reason: String(context.why || ""),
      kind: intent.kind,
      deskCode: context.deskCode ?? null,
      eventId: intent.eventId ?? null,
      intentId: intent.id,
    };
  }
  return null;
}

async function reportFillDetail(intentId) {
  const intent = journal.getIntent(intentId);
  const body = fillReportBody(intent);
  if (!body) return { reported: false, unreportable: true };
  const response = await fetch(`${API}/api/floor/${FLOOR}/executor/fill`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`fill HTTP ${response.status}`);
  journal.setMeta(fillReportedKey(intentId), Date.now());
  return { reported: true, body };
}

async function flushFillReports() {
  if (reportingFillDetails || !unreportedFillDetails.size) return;
  reportingFillDetails = true;
  try {
    for (const intentId of [...unreportedFillDetails]) {
      try {
        const result = await reportFillDetail(intentId);
        unreportedFillDetails.delete(intentId);
        if (result.unreportable)
          log(`fill detail ${intentId} has no attributable call id or fill totals — not reported`);
        else
          log(`reported ${result.body.side} fill of call ${result.body.callId} (${intentId}) to the desk`);
      } catch (error) {
        // Left in the queue on purpose; the next tick tries again.
        log(`could not report fill detail ${intentId} (${error.message}) — will retry`);
      }
    }
  } finally { reportingFillDetails = false; }
}

/** Every accounted intent with a call id in the last seven days that the desk has not
 *  acknowledged (no fill_reported:<intentId> meta key). Rebuilt at boot so a restart
 *  between the fill and the report — or between the SELL and the report — keeps it. */
function queueUnreportedFillDetailsFromJournal() {
  const since = Date.now() - FILL_REPORT_WINDOW_MS;
  let intents = [];
  try { intents = journal.accountedIntentsWithCallId({ sinceMs: since }); }
  catch (error) { log(`could not rebuild the fill-report queue from the journal: ${error.message}`); }
  for (const intent of intents) {
    let acknowledged = null;
    try { acknowledged = journal.getMeta(fillReportedKey(intent.id)); } catch {}
    if (acknowledged == null) unreportedFillDetails.add(intent.id);
  }
  return unreportedFillDetails.size;
}

/* Recovery is never allowed to sit unbounded in front of fresh position safety.
 * At most one exit-first intent is probed before manageOpen, and the tick waits no
 * more than one second for that observation-only pass. The promise keeps its
 * in-process intent scope if the RPC is slower, so continuing cannot duplicate a
 * submission. A full identical-byte retry is scheduled only after the tick's risk,
 * feed and heartbeat work has completed, and never overlaps another recovery pass. */
let recoveryPassInFlight = null;
const startRecoveryPass = (options) => {
  if (!EXECUTE || !jupiter || recoveryPassInFlight) return recoveryPassInFlight;
  const pass = Promise.resolve(jupiter.recoverPending(options))
    .catch((error) => log(`bounded recovery pass: ${error.message}`))
    .finally(() => { if (recoveryPassInFlight === pass) recoveryPassInFlight = null; });
  recoveryPassInFlight = pass;
  return pass;
};
async function boundedRecoveryBeforeRisk() {
  if (!EXECUTE) return;
  const pass = recoveryPassInFlight || startRecoveryPass({ observationOnly: true, maxIntents: 1 });
  if (!pass) return;
  await waitForRecoveryBudget(pass,
    Math.min(1_000, Math.max(100, Math.floor(POLL_MS / 4))));
}
const scheduleBackgroundRecovery = () => {
  if (!EXECUTE || recoveryPassInFlight) return;
  startRecoveryPass({ maxIntents: 1 });
};

/* THE DESK-UNREACHABILITY CLOCK. deskUnreachableSince is the timestamp of the FIRST
 * consecutive failure of the feed GET — network error, timeout, non-2xx, unparsable
 * body — and is cleared by any 2xx with a valid payload. It is persisted best-effort in
 * journal meta because restarts correlate with the outages it measures. Once the outage
 * has lasted DESK_UNREACHABLE_MS the bot MIRRORS the desk (executor/desk-mirror.mjs). */
let deskUnreachableSince = (() => {
  const value = Number(journal.getMeta("desk_unreachable_since"));
  return Number.isSafeInteger(value) && value > 0 && value <= Date.now() + MAX_FUTURE_SKEW_MS ? value : null;
})();
let mirrorEngaged = false;
const mirrorActive = () => deskUnreachableSince != null && Date.now() - deskUnreachableSince >= DESK_UNREACHABLE_MS;
const noteDeskUnreachable = (why) => {
  if (deskUnreachableSince != null) return;
  deskUnreachableSince = Date.now();
  try { journal.setMeta("desk_unreachable_since", deskUnreachableSince); } catch {}
  log(`desk unreachable (${String(why).slice(0, 160)}) — clock started; mirror mode engages after ` +
    `${Math.round(DESK_UNREACHABLE_MS / 1000)}s of silence`);
};
const noteDeskReachable = () => {
  if (deskUnreachableSince == null) return;
  const outageMs = Date.now() - deskUnreachableSince;
  deskUnreachableSince = null;
  try { journal.setMeta("desk_unreachable_since", null); } catch {}
  if (mirrorEngaged) {
    mirrorEngaged = false;
    log(`desk reachable again after ${Math.round(outageMs / 1000)}s — MIRROR MODE stood down; the desk determines exits`);
  } else log(`desk reachable again after ${Math.round(outageMs / 1000)}s`);
};
const mirrorUnpriceableLogged = new Set();
const mirrorQuarantineLogged = new Set();
/* Positions whose call the desk is ANSWERING about but has stopped marking. Mirror mode
 * is engaged for these individually, on exactly wave 1's terms, while the rest of the
 * book stays the desk's. Keyed by mint; emptied the moment a fresher mark comes back. */
const deskSilentPositions = new Map();
/* THE FLAGS THAT USED TO SILENCE THE MIRROR, AND WHY THEY NO LONGER DO.
 *
 * The guard here skipped any position carrying accountingIncomplete,
 * balanceReconciliationRequired or manualExitRequired. Each of those is a real
 * quarantine — and each quarantines the bot's OWN accounting basis: the independently
 * verified SOL/USD rate at fill, the custody read, the executable exit mark. The mirror
 * needs none of them. Its CLOCK lane needs only opened_at and the band window; its PRICE
 * lane needs only the desk's absolute USD levels and the desk's own DexScreener USD
 * mark. Neither ever touches the bot's SOL/USD entry basis — which is precisely the
 * thing quarantine invalidates.
 *
 * So the old guard bought nothing and cost everything: while the desk was unreachable a
 * legacy or quarantined position had NO exit path at all, not even its band clock. Under
 * wave 1 that is the whole book's only remaining safety, so it ran the position to
 * whatever the market did. The fences that actually matter are untouched and all live
 * downstream in sellAll: HARD_STOP still refuses every automated exit, PAPER still sells
 * nothing, and the balance-verification fence still refuses to sign a sell whose custody
 * two RPCs could not agree on — a custody-blocked position now LATCHES the desk's
 * determination and sells the moment the read comes back, instead of losing it.
 *
 * exitExecutionRequired stays skipped, and it is the one flag that is not a quarantine
 * at all: a latched exit IS an exit path, retried by manageOpen ahead of all other work
 * on every pass. Running the mirror over it would open a SECOND exit intent, under a
 * different `mirror-exit:` id, for a position already selling. */
const MIRROR_QUARANTINE_FLAGS = Object.freeze([
  "accountingIncomplete", "balanceReconciliationRequired", "manualExitRequired",
]);

/* MIRROR MODE. Engaged either GLOBALLY — the desk has been unreachable for
 * DESK_UNREACHABLE_MS — or PER POSITION, when reconciliation found the desk answering
 * about a live call it has stopped marking (wave 2). For every position in scope the bot
 * evaluates the desk's own absolute levels (deskEntryRef, deskStop, deskTarget,
 * deskOpenedAt, the band window) with the shared pricePolicy on POLICY_DEFAULTS, against
 * the desk's own ruler — the DexScreener consensus mark, read every MIRROR_MARK_MS (45 s,
 * the desk's sub-tick) — and sells with the desk's close code. The clock lane runs every
 * tick with a null mark (pricePolicy's clock branch precedes its price branch), so a
 * window closes on time even when DexScreener is down or DS_OFFLINE=1 declines. A
 * position with no desk levels (filled before desk-led-v4) gets the clock lane only: its
 * ratios are the numbers that sold Shrek early, and mirroring them would be that bug with
 * a new name. A position already selling on a latch is left to that path. */
async function mirrorTick() {
  // A position that has left the book takes its engagement with it, or the map never
  // empties and this pass keeps waking for a mint that no longer exists.
  for (const mint of deskSilentPositions.keys())
    if (!S.positions[mint]) deskSilentPositions.delete(mint);
  const globalMirror = mirrorActive();
  if (!globalMirror && deskSilentPositions.size === 0) return;
  if (globalMirror && !mirrorEngaged) {
    mirrorEngaged = true;
    log(`MIRROR MODE: desk unreachable for ${Math.round((Date.now() - deskUnreachableSince) / 1000)}s ` +
      `(>= DESK_UNREACHABLE_MS ${Math.round(DESK_UNREACHABLE_MS / 1000)}s) — evaluating the desk's own levels ` +
      `with the desk's ruler on ${openList().length} position(s); price lane every ${MIRROR_MARK_MS / 1000}s, clock lane every tick`);
  }
  for (const posKey of openList().map((p) => p.mint)) {
    const pos = openList().find((p) => p.mint === posKey);
    if (!pos) continue;                            // exited earlier in this same pass
    // Globally the mirror covers the whole book; per position it covers only the calls
    // reconciliation found the desk silent on. Everything else is the desk's to decide.
    if (!globalMirror && !deskSilentPositions.has(posKey)) continue;
    try {
      if (pos.exitExecutionRequired) continue;
      const quarantined = MIRROR_QUARANTINE_FLAGS.filter((flag) => pos[flag] === true);
      if (quarantined.length && !mirrorQuarantineLogged.has(posKey)) {
        mirrorQuarantineLogged.add(posKey);
        log(`mirror ${pos.symbol}: quarantined (${quarantined.join(", ")}) and evaluated ANYWAY — ` +
          "the clock and desk-level lanes never read the bot's own SOL/USD entry basis, which is " +
          "the only thing that quarantine invalidates; HARD_STOP, paper mode and the " +
          "balance-verification fence still guard the sell itself");
      }
      const now = Date.now();
      let mark = null;
      if (mirrorPriceable(pos)) {
        if (now - (Number(pos.mirrorMarkAt) || 0) >= MIRROR_MARK_MS) {
          const observed = await consensusMark(pos.mint);
          pos.mirrorMarkAt = now;
          if (observed.ok) {
            mark = observed.priceUsd;
            pos.mirrorMark = observed.priceUsd;
            delete pos.mirrorMarkError;
          } else {
            pos.mirrorMarkError = String(observed.error || "declined").slice(0, 200);
            log(`mirror ${pos.symbol}: consensus mark declined (${pos.mirrorMarkError}) — ` +
              `the clock lane still runs; the price lane retries in ${MIRROR_MARK_MS / 1000}s`);
          }
        }
      } else if (!mirrorUnpriceableLogged.has(posKey)) {
        mirrorUnpriceableLogged.add(posKey);
        log(`mirror ${pos.symbol}: no desk levels on this position (filled before desk-led-v4) — ` +
          "clock lane only; the ratio stop is deliberately not mirrored");
      }
      const verdict = evaluateMirror(pos, { mark, now });
      save();
      if (verdict.action === "sell") {
        await sellAll(pos, `mirror exit (${verdict.code}): ${verdict.reason}`, 1,
          `mirror-exit:${pos.entryIntentId || `${pos.mint}:${pos.openedAtMs || pos.openedAt}`}`,
          null, { deskCode: verdict.code });
      }
    } catch (error) {
      recordPositionFailure(posKey, error, "mirror");
    }
  }
}

/* ── EXIT RECONCILIATION: THE BOT ASKS ABOUT THE CALLS IT IS ACTUALLY HOLDING ───────
 *
 * The feed is the fast path and stays the fast path: an exit event is executed the tick
 * it is seen. This is the FLOOR under it, for the two ways that event never arrives
 * while the desk looks perfectly healthy.
 *
 * 1. The event is delivered ONCE, ever. `alerts` has UNIQUE(floor_no, call_id, kind), the
 *    feed serves rows strictly after a durable cursor, and the cursor advances per event.
 *    If the bot was restarting, errored on that row, or advanced past it in a frozen-book
 *    path, the desk never re-sends it. reconcileMissingExitAlerts repairs a missing alert
 *    ROW; nothing re-delivers a row the cursor has already passed.
 * 2. A desk that answers 200 while it is not DECIDING. A wedged penthouse loop, a failing
 *    DexScreener source, a monitor that never runs — each serves a healthy feed with no
 *    exit events, which is byte-for-byte identical to "the desk looked and decided to
 *    hold". Mirror mode never engages, because the feed is not unreachable at all.
 *
 * Before wave 1 either hole was survivable: the bot had its own stop underneath. Wave 1
 * removed it, which is what the owner asked for (Shrek, call 55, 2026-09-05: the bot sold
 * at 03:01:42Z on its own normalised stop at -13.5%, the desk's determined stop_hit
 * landed 03:10:24Z), and that is exactly why these holes are now unsurvivable rather than
 * merely late. Holding forever is not "as exactly as it was determined".
 *
 * This is a STATE READ, not a bigger event stream. It is idempotent — a recovered exit
 * runs through the same desk-exit path under an intent id derived from the desk's own
 * closed_at, so the journal dedupes a repeat — and it can only ever make the bot take an
 * exit the DESK RECORDED. */
const RECONCILE_ROUTE_TIMEOUT_MS = 8_000;
let lastReconcileAt = 0;
let reconcileInFlight = false;
const reconcileAbsentLogged = new Set();
const reconcileUndecidableLogged = new Set();
const reconcileIdentityUnprovenLogged = new Set();

function engagePositionMirror(pos, callId, staleMs) {
  const existing = deskSilentPositions.get(pos.mint);
  deskSilentPositions.set(pos.mint,
    { callId, staleMs, engagedAt: existing?.engagedAt ?? Date.now() });
  if (existing) return;
  log(`DESK SILENT ${pos.symbol}: call ${callId} is LIVE at the desk but was last marked ` +
    `${(staleMs / 60_000).toFixed(1)} minutes ago (DESK_SILENT_MS ${(DESK_SILENT_MS / 60_000).toFixed(1)}m) — ` +
    "a desk that answers 200 while it is not watching serves the same empty feed as a desk that " +
    "decided to hold; engaging the MIRROR for this position alone, on the desk's own levels, " +
    "the desk's ruler and the desk's codes");
}

function standDownPositionMirror(pos, why) {
  const engaged = deskSilentPositions.get(pos.mint);
  if (!engaged) return;
  deskSilentPositions.delete(pos.mint);
  log(`DESK AWAKE ${pos.symbol}: call ${engaged.callId} — ${why}; the per-position mirror stood ` +
    `down after ${Math.round((Date.now() - engaged.engagedAt) / 1000)}s and the desk determines this exit again`);
}

/* The desk's call-state route. A failure here is NOT desk unreachability: that clock
 * belongs to the feed GET and to mirror mode, and starting it from a second route would
 * let one flaky endpoint mirror a desk that is talking. This just retries next pass. */
async function fetchHeldCallState(ids) {
  const response = await fetch(
    `${API}/api/floor/${FLOOR}/executor/calls?ids=${ids.join(",")}`,
    { headers: { authorization: `Bearer ${SECRET}` }, redirect: "error",
      signal: AbortSignal.timeout(RECONCILE_ROUTE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`calls HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.calls))
    throw new Error("call-state answer omitted its calls array");
  return payload;
}

/** Act on the desk's answer about ONE held position. */
async function reconcileOneHeldCall(pos, call, deskNow) {
  const callId = Number(pos.callId);
  /* `position: pos` is what makes the row prove its identity before anything else reads
   * it — see callIdentityVerdict. The delivered-event path has always refused a
   * different mint first (journal.mjs deskExitDecisionForPosition); this path bound on
   * the call id alone, and an AUTOINCREMENT id re-issued by a restored desk database is
   * another coin's row wearing the right number. */
  const verdict = reconcileVerdict({ call, position: pos, now: deskNow,
    deskSilentMs: DESK_SILENT_MS, floorNo: FLOOR });
  if (verdict.action === "identity_mismatch") {
    /* THE LOUDEST THING THIS PASS CAN SAY. Nothing below runs: no level is adopted from
     * this row and no sell is taken on it. The position keeps the levels it already has
     * and is held for a determination that can prove which coin it is about. The
     * position is also flagged deskIdentityMismatch — which blocks new exposure (journal
     * positionEntryBlock) — and riskDataUnavailable, which shows in the heartbeat as a
     * blocked position, i.e. DEGRADED on the floor's card. */
    const changed = pos.deskIdentityMismatch !== true || pos.deskIdentityAnsweredMint !== verdict.answeredMint;
    pos.deskIdentityMismatch = true;
    pos.deskIdentityAnsweredMint = String(verdict.answeredMint || "");
    pos.deskIdentityMismatchAt = Date.now();
    /* THE BLOCKING FLAG IS deskIdentityMismatch ITSELF NOW. It used to block only as a
     * side effect of riskDataUnavailable, and riskDataUnavailable has since left
     * journal.mjs POSITION_BLOCK_FLAGS — an unreadable quote is weather, but a desk row
     * about ANOTHER COIN is an identity fact about the book and must keep freezing new
     * exposure. Both are still set: riskDataUnavailable remains the health signal the
     * heartbeat and the monitor read. */
    pos.deskIdentityMismatchReason =
      `the desk's answer for call ${callId} is about ${pos.deskIdentityAnsweredMint || "(no mint)"}, not the held ${pos.mint}`;
    pos.riskDataUnavailable = true;
    pos.riskDataUnavailableReason = pos.deskIdentityMismatchReason;
    pos.riskDataUnavailableAt = pos.deskIdentityMismatchAt;
    save();
    if (changed)
      log(`CRITICAL CALL IDENTITY MISMATCH ${pos.symbol}: the desk's row for call ${callId} is about ` +
        `${pos.deskIdentityAnsweredMint || "(no mint)"}, but the bot holds ${pos.mint} under that call id — ` +
        "the row is REFUSED: no level adopted, no sell taken, new entries blocked. A call id is not an " +
        "identity (calls.id is AUTOINCREMENT, so a restored desk database re-issues held ids, and a bot " +
        "pointed at the wrong CC_FLOOR reads the same wrong answer); this needs an operator");
    return "identity-mismatch";
  }
  if (verdict.action === "identity_unproven") {
    /* The row named no mint at all — an older desk build that does not serve the field.
     * It proves nothing either way, so it is refused exactly as an absent row is: no
     * level, no sell, hold. Logged once per call id; a line a minute would bury the
     * recoveries this pass exists to surface. */
    if (!reconcileIdentityUnprovenLogged.has(callId)) {
      reconcileIdentityUnprovenLogged.add(callId);
      log(`reconcile ${pos.symbol}: the desk's row for call ${callId} carries no mint — ` +
        "it cannot prove it is about the held coin; no level adopted, no sell taken, holding");
    }
    return "identity-unproven";
  }
  reconcileIdentityUnprovenLogged.delete(callId);
  /* The row proved it is about the held coin. If a previous answer did not, say so and
   * lift the alarm — an integrity flag nothing can clear is a flag operators learn to
   * ignore, and the condition really is over: this row named the held mint. */
  if (pos.deskIdentityMismatch === true) {
    delete pos.deskIdentityMismatch;
    delete pos.deskIdentityAnsweredMint;
    delete pos.deskIdentityMismatchAt;
    delete pos.deskIdentityMismatchReason;
    delete pos.riskDataUnavailable;
    delete pos.riskDataUnavailableReason;
    delete pos.riskDataUnavailableAt;
    save();
    log(`CALL IDENTITY RESTORED ${pos.symbol}: the desk's row for call ${callId} names the held ` +
      `${pos.mint} again — the row is trusted once more and new entries are unblocked`);
  }
  if (verdict.action === "absent") {
    /* AN ABSENT CALL IS NEVER AN EXIT SIGNAL. It may be an id this desk has never heard
     * of, or a delivery that was re-verdicted away. Logged once per call id — a line per
     * minute per position would bury the recoveries this pass exists to surface. */
    if (!reconcileAbsentLogged.has(callId)) {
      reconcileAbsentLogged.add(callId);
      log(`reconcile ${pos.symbol}: call ${callId} is absent from the desk's answer — ` +
        "absence is not an exit signal (an unknown id, or a re-verdicted delivery); holding");
    }
    return "absent";
  }
  reconcileAbsentLogged.delete(callId);
  /* THE DESK MAY RESTATE ITS LEVELS, AND A DESK THAT RESTATES A STOP MUST BE FOLLOWED —
   * the same principle that makes the mirror evaluate the desk's levels at all. */
  const changes = refreshDeskLevels(pos, call);
  if (changes.length) {
    save();
    log(`reconcile ${pos.symbol}: the desk restated ` +
      `${changes.map((c) => `${c.field} ${c.from} → ${c.to}`).join(", ")} — the position now carries the desk's current levels`);
  }
  if (verdict.action === "unknown" || verdict.action === "unmeasurable") {
    if (!reconcileUndecidableLogged.has(callId)) {
      reconcileUndecidableLogged.add(callId);
      log(`reconcile ${pos.symbol}: call ${callId} — ${verdict.reason}; holding`);
    }
    return verdict.action;
  }
  reconcileUndecidableLogged.delete(callId);
  if (verdict.action === "desk_exit") {
    /* SAID OUT LOUD, AND SAID DIFFERENTLY FROM A LIVE-EVENT EXIT. This line is the only
     * evidence that the event path failed; a transcript that reads like an ordinary desk
     * exit would hide a broken feed delivery for as long as it kept happening. */
    log(`RECOVERED DESK EXIT ${pos.symbol}: call ${callId} is CLOSED at the desk (${verdict.code}` +
      `${verdict.closeMark != null ? `, close_mark ${verdict.closeMark}` : ""}) and the bot STILL HOLDS it — ` +
      `the exit EVENT never reached the bot. Desk closed_at ${verdict.closedAt ? new Date(verdict.closedAt).toISOString() : "(unstamped)"}` +
      `${verdict.closedAt ? `, ${((Date.now() - verdict.closedAt) / 60_000).toFixed(1)} minutes ago` : ""}; ` +
      "selling the whole position now through the desk-exit path");
    standDownPositionMirror(pos, "the desk closed the call");
    await sellAll(pos, `desk exit (${verdict.code}) recovered by reconciliation`, 1,
      `desk-exit:${verdict.eventId}`, null, { deskCode: verdict.code });
    return "recovered";
  }
  if (verdict.action === "engage_mirror") {
    engagePositionMirror(pos, callId, verdict.staleMs);
    return "engage_mirror";
  }
  standDownPositionMirror(pos, `the desk marked it ${Math.round(verdict.staleMs / 1000)}s ago`);
  return "watch";           // live and freshly marked: the normal path, and it stays silent
}

/**
 * One reconciliation pass. Gated exactly as the contract says: only when EXECUTE, only
 * when at least one open position carries a positive callId, only while the feed is
 * currently REACHABLE (mirror mode already owns the unreachable case, and asking a desk
 * that cannot be reached would only re-measure that), never while the authenticated feed
 * is in ROLLBACK (entries are frozen for that reason at the entry gate; the call-state
 * route reads the same suspect database), and at most once per RECONCILE_MS.
 * Returns why it did nothing, so the caller and the tests can name the gate.
 */
async function reconcileHeldCalls() {
  const now = Date.now();
  const held = openList();
  /* THE GATES ARE A PURE FUNCTION (desk-mirror.mjs) so a test can execute every one of
   * them rather than read them off this source. It also produces the id list: deduped,
   * positive-only, and capped at the 25 the desk's route accepts — more is a 400 there,
   * by design. The book's cap is 24 open positions, so the cap truncates nothing in
   * practice, and anything it ever did drop is simply asked about on the next pass. */
  const gate = reconcileGate({ execute: EXECUTE, inFlight: reconcileInFlight, deskUnreachableSince,
    feedRollback: feedRollbackActive(),
    now, lastReconcileAt, reconcileMs: RECONCILE_MS,
    heldCallIds: held.map((position) => position?.callId) });
  if (!gate.run) return gate.why;
  /* A ROLLBACK NO LONGER REFUSES THIS PASS — under a frozen feed it is the ONLY route by
   * which a closed call still reaches a held position — but it is said out loud, because
   * every row this pass reads comes from the database that rewound. Each one must name
   * the held mint or it is refused (reconcileVerdict → callIdentityVerdict). */
  if (gate.feedRollback === true)
    log(`reconcile: running under the FEED ROLLBACK alarm — it is the only exit lane while the feed ` +
      "is frozen, and every row must name the held mint or it is refused");
  lastReconcileAt = now;
  reconcileInFlight = true;
  try {
    const ids = gate.ids;
    let payload;
    try { payload = await fetchHeldCallState(ids); }
    catch (error) {
      log(`reconcile: could not read the desk's call state for ${ids.length} held call(s) ` +
        `(${error.message}) — retrying in ${Math.round(RECONCILE_MS / 1000)}s`);
      return "route-failed";
    }
    /* THE DESK'S CLOCK, not the bot's. Staleness measured on a local clock is staleness
     * plus whatever the two machines disagree by, and this bot runs on a laptop. Fall
     * back only when the desk did not stamp one. */
    const deskNow = Number(payload.now) > 0 ? Number(payload.now) : Date.now();
    const byCallId = new Map();
    for (const call of payload.calls) {
      const id = Number(call?.call_id);
      if (Number.isSafeInteger(id) && id > 0) byCallId.set(id, call);
    }
    log(`reconcile: asked the desk about ${ids.length} held call(s) [${ids.join(",")}] — ` +
      `${byCallId.size} answered`);
    /* Only the positions actually ASKED about. A position whose call id could not be
     * proven (the legacy call-identity quarantine) is not in `ids`, was never in the
     * request, and must never be read as "absent from the desk's answer" — that would
     * print a permanent falsehood about a call the bot never asked after. */
    for (const posKey of held.filter((position) => ids.includes(Number(position?.callId)))
      .map((position) => position.mint)) {
      const pos = openList().find((position) => position.mint === posKey);
      if (!pos) continue;                          // exited earlier in this same pass
      try { await reconcileOneHeldCall(pos, byCallId.get(Number(pos.callId)) ?? null, deskNow); }
      catch (error) { recordPositionFailure(posKey, error, "reconcile"); }
    }
    return "reconciled";
  } finally { reconcileInFlight = false; }
}

/* THE FEED, READ BEFORE THE BOOK IS VALUED. Under desk-led-v4 the feed is the only place
 * an exit comes from, so it is consumed on EVERY tick and BEFORE manageOpen: an exit row
 * is executed the tick it is seen, never one valuation pass later. The exit prepass and
 * the sequential cursor pass are unchanged from before; only their position in the tick
 * moved. Every early return here is a feed verdict, not a tick verdict — the caller still
 * runs the custody pass and the mirror afterwards. */
/**
 * OFFER BACK THE CALLS THE FREEZE HELD.
 *
 * Nothing here is a bypass of anything. Each held event goes through `onEntry`, the same
 * function the feed calls, so it faces the same gates in the same order against the clock
 * of the moment it runs — the band's own window (a nano call is past in a minute), the
 * mark's age and deviation, the book, the pause and hard-stop files, the risk history,
 * and then the bot's own sizing rails. The freeze is still absolute: if an intent is
 * unresolved, nothing is offered at all, and if a replay signs a buy the drain stops
 * there so only one buy is ever in flight.
 */
async function drainDeferredEntries() {
  let held = [];
  try { held = journal.deferredEntries(); } catch { return; }
  if (!held.length) return;
  if (journal.hasBlockingIntent()) return;
  for (const row of held) {
    const ev = row.event;
    const key = String(ev.event_id || `${FLOOR}:${ev.id}`);
    log(`HELD CALL ${ev.symbol || ev.mint} (call ${ev.call_id}) is offered again — ` +
      `exposure unfroze ${Math.round((Date.now() - row.deferredAt) / 1000)}s after it was held`);
    try {
      await onEntry(ev);
      journal.dropDeferredEntry(row.eventId);
    } catch (error) {
      const intent = journal.getIntent(`entry:${key}`);
      const undecided = !intent || ["planned", "failed", "expired"].includes(intent.state);
      if (undecided && isTransientEntryFailure(error) &&
          journal.bumpDeferredEntryAttempt(row.eventId) <= MAX_ENTRY_RETRIES) {
        log(`RETRY ${ev.symbol || ev.id} (held call ${ev.call_id}): ${error.message} — ` +
          `transient, attempt ${row.attempts + 1} of ${MAX_ENTRY_RETRIES}; the call stays held`);
        continue;
      }
      log(`SKIP ${ev.symbol || ev.id} (held call ${ev.call_id}): ${error.message} — ` +
        "the held call is retired");
      journal.dropDeferredEntry(row.eventId);
    }
    // A replayed entry that signed a buy freezes exposure again, by the same rule.
    if (journal.hasBlockingIntent()) {
      log("a held call was acted on and its buy is in flight — the rest stay held");
      break;
    }
  }
}

async function consumeFeed() {
  try {
    const response = await fetch(`${API}/api/floor/${FLOOR}/executor/feed?after=${S.cursor}`, {
      headers: { authorization: `Bearer ${SECRET}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) {
      noteFeedFailure();
      noteDeskUnreachable("feed authentication rejected");
      log("feed authentication rejected — check CC_SECRET / CC_FLOOR");
    } else if (!response.ok) {
      noteFeedFailure();
      noteDeskUnreachable(`feed HTTP ${response.status}`);
      log(`feed HTTP ${response.status}`);
    }
    else {
      const payload = await response.json();
      if (payload.cluster !== "mainnet-beta") throw new Error("feed cluster is not mainnet-beta");
      if (!Array.isArray(payload.events)) throw new Error("feed omitted its events array");
      const events = payload.events;
      /* THE FLOOR'S OFF SWITCH, BEFORE ANY EVENT IN THIS PAYLOAD IS ACTED ON. The flag
         and the entries it governs arrive in the same response, so a call published
         after the tenant pressed OFF can never be entered on the strength of a stale
         reading. It is read even on the rollback path below, which returns early. */
      noteDeskEntriesRule(payload.rules);
      /* Say why a call was NOT offered. An empty feed is indistinguishable from a
       * desk that published nothing, and today it hid two published calls the floor
       * had declined. The feed now carries the floor's recent verdicts; log each
       * new refusal once. Pure observability — nothing here changes a decision. */
      if (Array.isArray(payload.decisions)) {
        for (const d of [...payload.decisions].reverse()) {
          const at = Number(d?.delivered_at) || 0;
          if (at <= lastDecisionSeen || d?.verdict === "offered") continue;
          log(`NOT OFFERED ${d?.symbol || d?.call_id}: ${d?.reason || d?.verdict}`);
        }
        lastDecisionSeen = Math.max(lastDecisionSeen,
          ...payload.decisions.map((d) => Number(d?.delivered_at) || 0));
      }
      const feedCursor = authenticatedFeedCursorState(S.cursor, payload.latest_id);
      const latestId = feedCursor.latestId;
      /* The desk ANSWERED, with an authenticated mainnet payload: it is reachable, and
       * the mirror stands down whatever the cursor says next. A latest_id rollback is a
       * feed-integrity alarm (entries freeze, below), not unreachability — mirroring a
       * desk that is talking would be the bot second-guessing it. */
      noteDeskReachable();
      if (feedCursor.rollback) {
        persistFeedRollback(latestId);
        noteFeedFailure();
        /* A COIN THE BOT CANNOT SELL IS NOT A CALL.
         *
         * This branch used to return here, and the line it printed — "local position/risk
         * exits continue" — stopped being true at desk-led-v4: the bot has no exit of its
         * own any more (strategy.mjs stepPosition holds unless a desk exit is supplied),
         * so returning closed EVERY exit path at once. Entries must stay frozen — a
         * database that has rewound must not authorise NEW exposure — but that argument
         * says nothing about getting OUT of exposure the bot already has.
         *
         * So the batch's EXIT rows are still executed, and reconciliation still runs
         * (desk-mirror.mjs reconcileGate no longer refuses on rollback). Both are
         * identity-checked against the held coin — deskExitDecisionForPosition here,
         * callIdentityVerdict there — so the one real hazard a rewound AUTOINCREMENT id
         * poses, another coin's row wearing a held number, is refused on its own merits
         * rather than by shutting the lane. The cursor does NOT move: these ids have not
         * been validated against a latest_id that is behind them, and an exit executed
         * twice is idempotent (the intent id is the durable unit) while an entry crossed
         * unseen is gone. */
        const { count } = await runExitPrepass(events);
        log(`CRITICAL FEED ROLLBACK: authenticated latest_id ${latestId} is behind durable cursor ` +
          `${S.cursor} — entries remain frozen; the batch's ${count} desk exit(s) were still executed ` +
          "and reconciliation still runs, both identity-checked against the held mint");
        return;
      }
      const returnedIds = events.map((event) => Number(event?.id));
      let previousId = S.cursor;
      for (const id of returnedIds) {
        if (!Number.isSafeInteger(id) || id <= previousId || id > latestId)
          throw new Error("feed event ids are not strictly increasing above the cursor or exceed latest_id");
        previousId = id;
      }
      clearFeedRollback();
      noteFeedSuccess();
      if (!S.primed) {
        S.primed = true;
        S.cursor = Math.max(S.cursor, latestId);
        save();
        log(`primed at cursor ${S.cursor} — ${events.length} historic event(s) skipped; trading forward only`);
      } else {
        /* Exit safety is not held hostage by an earlier bad entry. Pre-latch/process
         * every exit in the validated batch before the sequential cursor pass.
         *
         * AND EXACTLY ONCE. This pass used to hand every exit to handleDeskExitEvent and
         * then the cursor loop below handed it over a SECOND time: measured 2026-09-07,
         * 24 exit executions for 12 desk determinations. The second call is a retry, and
         * a retry is worth keeping — but only for an exit whose first attempt THREW. One
         * that was handled is remembered here and skipped below, so a determination is
         * executed once and reads once in the log. */
        const { prepassed, unsafe: unsafeExitPrepass } = await runExitPrepass(events);
        const blockingIntent = journal.hasBlockingIntent();
        if (blockingIntent) {
          /* The server returns at most 50 rows. Returning forever without moving
           * the cursor pins us to that first window, so a newer desk exit can be
           * invisible indefinitely. Every exit in THIS validated batch was already
           * pre-latched above. Cross the batch now: entries are conservatively
           * abandoned while exposure is frozen, and the next window (and its exits)
           * becomes visible on the next poll. Never jump straight to latest_id —
           * exits beyond this batch have not been seen yet. */
          if (unsafeExitPrepass) {
            log(`journal intent ${blockingIntent} is unresolved and an exit could not be recorded — ` +
              "cursor stays pinned; manual action required");
            return;
          }
          const nextCursor = advanceFrozenBatchCursor(S.cursor, events);
          if (nextCursor > S.cursor) {
            /* HOLD THE CALLS THE CURSOR IS ABOUT TO CROSS. DO NOT ABANDON THEM.
             *
             * Crossing the batch is a DURABLE decision: the cursor moves past every
             * entry in it, and an id at or below the cursor is never re-read. Measured
             * on 2026-09-07 with one signed-but-unconfirmed buy in the journal (the
             * ordinary consequence of an RPC timeout after signing): three published
             * calls, feed ids 48, 49 and 50, were crossed — abandoned permanently, and
             * not one of them appeared in the log by name.
             *
             * THE FREEZE ITSELF IS UNTOUCHED, and that matters: no new exposure is
             * taken while a buy's fate is unknown, which is the whole reason the freeze
             * exists. What changes is what happens to the CALL. It is written to the
             * journal's deferred_entries table, verbatim and durably, and offered back
             * to onEntry once the intent resolves — where it faces every gate again
             * against the clock of that moment: the band window, the mark's age and
             * deviation, the book, the pauses, the risk history, the rails. A call that
             * went stale in the meantime is refused there, by the same rule that refuses
             * any stale call, and a desk exit for it retires it outright. */
            const held = events.filter((event) => event.type === "entry");
            for (const event of held) {
              try {
                journal.deferEntryEvent(event);
                log(`HOLD ${event.symbol || event.mint} (call ${event.call_id}): new exposure is frozen while ` +
                  `intent ${blockingIntent} is unresolved — the call is held and offered again when it resolves`);
              } catch (error) {
                log(`SKIP ${event.symbol || event.mint} (call ${event.call_id}): could not hold the call ` +
                  `while exposure is frozen — ${error.message}`);
              }
            }
            S.cursor = nextCursor;
            save();
            log(`journal intent ${blockingIntent} is unresolved — exits were preprocessed; ` +
              `new exposure stayed frozen${held.length ? `, ${held.length} entr${held.length === 1 ? "y was" : "ies were"} held for replay` : ""} ` +
              `and cursor advanced to ${S.cursor} to expose the next batch`);
          } else {
            log(`journal intent ${blockingIntent} is unresolved — exits stay latched and new exposure is frozen`);
          }
          return;
        }
        /* Exposure is not frozen. Anything the freeze held is offered again BEFORE this
           batch's own entries, so a call published earlier is decided on earlier. */
        await drainDeferredEntries();
        for (const ev of events) {
          try {
            if (ev.type === "entry") {
              await onEntry(ev);
              entryRetries.delete(String(ev.event_id || `${FLOOR}:${ev.id}`));
            }
            else if (ev.type === "exit") {
              if (!prepassed.has(String(ev.id))) {
                const disposition = await handleDeskExitEvent(ev);
                if (disposition === "not-held") log(`EXIT ${ev.symbol} — not held`);
              }
            } else throw new Error(`unknown event type ${ev.type}`);
            S.cursor = Math.max(S.cursor, Number(ev.id));
            save();
          } catch (error) {
            const intent = ev.type === "entry"
              ? journal.getIntent(`entry:${ev.event_id || `${FLOOR}:${ev.id}`}`) : null;
            if (ev.type === "entry" && (!intent || ["planned", "failed", "expired"].includes(intent.state))) {
              /* A DROPPED PACKET IS NOT A DECISION.
               *
               * This acknowledged the event and advanced the cursor for ANY error, so
               * a four-second RPC timeout consumed a published call exactly like a
               * refusal did — permanently, with no retry. Measured in the live log
               * across 2026-09-01 to 09-04, eight real calls went this way: TOAD,
               * MACRODUCK, Hosico, TripleT, HeeHaw, TOAD, USWS, HeeHaw.
               *
               * The reason for acknowledging is still right and is kept: new exposure
               * is optional, and an entry that keeps failing must not become a
               * head-of-line denial of every later EXIT. So a transient failure is
               * retried a bounded number of times — the cursor stays pinned and the
               * next poll re-reads the same event — and only then acknowledged. A
               * deterministic refusal still acknowledges at once, as before.
               *
               * Unrecognised errors acknowledge immediately, which is today's
               * behaviour: the retry is an allowlist, so a misclassification can only
               * cost a retry that never happens, never a call held forever. */
              const key = String(ev.event_id || `${FLOOR}:${ev.id}`);
              if (isTransientEntryFailure(error) && bumpEntryRetry(key) <= MAX_ENTRY_RETRIES) {
                log(`RETRY ${ev.symbol || ev.id}: ${error.message} — transient, ` +
                  `attempt ${entryRetries.get(key)} of ${MAX_ENTRY_RETRIES}; the call stays on the feed`);
                break;             // leave the cursor where it is; re-read next poll
              }
              if (entryRetries.has(key)) {
                log(`SKIP ${ev.symbol || ev.id}: ${error.message} — gave up after ` +
                  `${entryRetries.get(key)} transient attempts`);
                entryRetries.delete(key);
                S.cursor = Number(ev.id); save(); continue;
              }
              log(`SKIP ${ev.symbol || ev.id}: ${error.message} — entry acknowledged without a trade`);
              S.cursor = Number(ev.id);
              save();
              continue;
            }
            /* A structurally unusable EXIT row is acknowledged rather than re-read for
             * ever; reconciliation every RECONCILE_MS is the net. See malformedExitRow. */
            const malformed = malformedExitRow(ev);
            if (malformed) {
              log(`MALFORMED EXIT ROW ${ev.symbol || ev.id}: ${malformed} — nothing was sold and nothing ` +
                "was inferred; the row is acknowledged and the cursor advances so later events are not " +
                "hidden behind it. Reconciliation asks the desk about the calls actually held.");
              S.cursor = Number(ev.id);
              save();
              continue;
            }
            log(`ERROR on ${ev.symbol || ev.id}: ${error.message} — event remains pending`);
            break;
          }
        }
      }
    }
  } catch (error) {
    noteFeedFailure();
    noteDeskUnreachable(error.message);
    log(`poll error: ${error.message}`);
  }
}

/* THE EXIT PREPASS — ONE IMPLEMENTATION, TWO CALLERS.
 *
 * Exit safety is not held hostage by an earlier bad entry: every exit in the batch is
 * pre-latched/processed before the sequential cursor pass, and the same pass is what a
 * ROLLED-BACK feed runs instead of returning empty-handed.
 *
 * AND EXACTLY ONCE. consumeFeed used to hand every exit to handleDeskExitEvent here and
 * then the cursor loop handed it over a SECOND time: measured 2026-09-07, 24 exit
 * executions for 12 desk determinations. The second call is a retry, and a retry is
 * worth keeping — but only for an exit whose first attempt THREW. One that was handled
 * is remembered in `prepassed` and skipped below, so a determination is executed once
 * and reads once in the log.
 *
 * `unsafe` means an exit could not be durably represented anywhere — the one condition
 * that pins the cursor. A MALFORMED row is not that: it is a row that will never be
 * executable, so it is acknowledged and never allowed to pin anything. */
async function runExitPrepass(events) {
  let unsafeExitPrepass = false;
  let count = 0;
  const prepassed = new Set();
  for (const ev of events.filter((event) => event.type === "exit")) {
    const malformed = malformedExitRow(ev);
    if (malformed) {
      prepassed.add(String(ev.id));
      log(`MALFORMED EXIT ROW ${ev.symbol || ev.id}: ${malformed} — nothing was sold and nothing was ` +
        "inferred; the row is acknowledged so it cannot pin the cursor and hide every later event. " +
        "Reconciliation asks the desk about the calls actually held.");
      continue;
    }
    try {
      const disposition = await handleDeskExitEvent(ev);
      prepassed.add(String(ev.id));
      count++;
      if (disposition === "not-held") log(`EXIT ${ev.symbol} — not held`);
    } catch (error) {
      const positionLatched = S.positions[ev.mint]?.exitExecutionRequired === true;
      let deferred = false;
      try {
        const entry = journal.blockingEntryForDeskExit({ mint: ev.mint, callId: ev.call_id });
        deferred = Boolean(entry && journal.deferredDeskExitForEntry(entry.id));
      } catch {}
      if (!positionLatched && !deferred) unsafeExitPrepass = true;
      log(`EXIT PREPASS ${ev.symbol || ev.id}: ${error.message} — ` +
        `${positionLatched || deferred ? "durable exit remains latched" : "exit was not durably recorded"}`);
    }
  }
  return { prepassed, unsafe: unsafeExitPrepass, count };
}

let lastManageOpenAt = 0;
async function tick() {
  if (ticking || shuttingDown) return;
  ticking = true;
  runtimeHealth.lastTickStartedAt = Date.now();
  let tickFailed = false;
  try {
    await boundedRecoveryBeforeRisk();
    accountConfirmedIntents();
    /* ORDER, desk-led-v4: recovery → accounting → FEED → valuation → mirror. The feed
     * carries the desk's determined exits, so it is read first and on every tick; the
     * valuation pass decides nothing any more and runs on the MARK_MS cadence — except
     * that a LATCHED exit (desk exit deferred at fill, a retry after an order-service
     * hiccup) is never throttled behind it. Before this the order was valuation-then-
     * feed, which meant every desk exit was seen one local pass after the bot had
     * already judged the position on its own ruler (Shrek, call 55). */
    await consumeFeed();
    /* AFTER the feed, never instead of it. This tick's exit events have already been
     * executed, so what reconciliation asks about is what the bot is STILL holding — the
     * narrowest possible question, and the one that cannot manufacture a recovery for an
     * exit that simply arrived normally. It runs before manageOpen and mirrorTick so a
     * position the desk has gone silent on is mirrored on this same tick. */
    await reconcileHeldCalls();
    const latchedExit = openList().some((position) => position.exitExecutionRequired === true);
    if (latchedExit || Date.now() - lastManageOpenAt >= MARK_MS) {
      lastManageOpenAt = Date.now();
      await manageOpen();
    }
    await mirrorTick();
  } catch (error) {
    tickFailed = true;
    log(`tick safety stop: ${error.message}`);
  } finally {
    runtimeHealth.lastTickCompletedAt = Date.now();
    runtimeHealth.consecutiveTickFailures = tickFailed
      ? runtimeHealth.consecutiveTickFailures + 1 : 0;
    maybeProbeExecutionReadiness();
    flushFillReports().catch(() => {});
    flushUnreportedFills().catch(() => {});
    sendHeartbeat();
    ticking = false;
    scheduleBackgroundRecovery();
  }
}

log(`up — floor ${FLOOR} — wallet ${WALLET} — ${EXECUTE ? "LIVE MAINNET" : "PAPER"}`);
log(`caps: ${CFG.maxSolPerTrade} SOL/trade, ${CFG.dailySolCap} SOL/rolling 24h deploy, ` +
  `realized-loss entry brake = the TIGHTER of ${CFG.dailyLossLimitSol} SOL and ` +
  `${(DEFAULTS.dailyLossPctOfEquity * 100).toFixed(0)}% of the bankroll, ` +
  `${CFG.maxOpenPositions} open (a sentinel — book heat and the wallet bind first)`);
log(`journal: ${STATE_DB}; entries pause: ${PAUSE_ENTRIES_FILE}; ` +
  `sleep fault: ${SLEEP_ASSERTION_FAULT_FILE}; hard stop: ${HARD_STOP_FILE}`);
log(`desk-led exits (${POLICY_VERSION}): the bot holds until the desk determines the exit — ` +
  `feed every ${POLL_MS / 1000}s before valuation (MARK_MS ${MARK_MS / 1000}s); ` +
  `mirror mode after ${Math.round(DESK_UNREACHABLE_MS / 1000)}s unreachable` +
  `${deskUnreachableSince ? ` (desk already unreachable since ${new Date(deskUnreachableSince).toISOString()})` : ""}`);
log("exit reconciliation: " +
  (EXECUTE
    ? `every ${Math.round(RECONCILE_MS / 1000)}s the bot asks the desk about the calls it is actually holding`
    : "DISABLED in paper (the pass runs under EXECUTE only)") +
  " — a call the desk has CLOSED is sold as a RECOVERED desk exit, and a LIVE call the desk has not marked for " +
  `${Math.round(DESK_SILENT_MS / 60_000)}m engages the mirror for that position alone; ` +
  "every answer must name the held mint or it is refused (a call id is not an identity)");
const rebuiltFillReports = queueUnreportedFillDetailsFromJournal();
if (rebuiltFillReports) log(`${rebuiltFillReports} fill report(s) still owed to the desk — re-queued from the journal`);
queueUnreportedFillsFromJournal();
log(`resuming ${openList().length} position(s) from cursor ${S.cursor}`);
await tick();
setInterval(tick, POLL_MS);

/* ── THE LAUNCH LANE, OBSERVE-ONLY AND OFF UNLESS ASKED FOR ──────────────────────────
 *
 * A second lane in this process, watching pump.fun launches and recording what it WOULD
 * have done. It has no desk, so it carries its own exit determiner (snipe-policy.mjs);
 * it shares no book, no engine and no config namespace with the desk
 * (test-snipe-separation.mjs holds all six clauses).
 *
 * FOUR PROPERTIES, EACH DELIBERATE:
 *
 * 1. OFF BY DEFAULT. Absent SNIPE_LANE the block below does nothing at all — not a
 *    timer, not a socket, not an import side effect. An installed bot that never sets
 *    the variable behaves exactly as it did before this existed.
 * 2. NOTHING SIGNS. createSnipeLane REFUSES lane=execute outright: there is no signing
 *    path in the lane and no keypair is loaded on it. Arming is a separate owner
 *    decision, not a flag flip, and the lane cannot be talked into it from here.
 * 3. ITS OWN TWO ENDPOINTS, UNCONDITIONALLY. secondaryConn above is null whenever
 *    EXECUTE is off — which is exactly the configuration the observe lane ships in — so
 *    the lane opens its own pair. A shadow book that validated a two-endpoint witness
 *    rule the live lane could not run would be measuring a rule that does not exist.
 * 4. IT CANNOT TAKE THE DESK DOWN. Construction and every tick are wrapped: a lane that
 *    throws is logged and disabled, and the trading loop above continues untouched. An
 *    observation lane is worth exactly nothing if it can stop the bot that earns.
 */
const SNIPE_LANE_MODE = String(process.env.SNIPE_LANE || "off").trim().toLowerCase();
if (SNIPE_LANE_MODE !== "off") {
  try {
    const [{ createSnipeLane, snipeLaneConfig }, { PUMPFUN_VENUE }] = await Promise.all([
      import("./snipe-lane.mjs"),
      import("./snipe-venue-pumpfun.mjs"),
    ]);
    const laneCfg = snipeLaneConfig(process.env);
    /* Its own pair, never the desk's — see property 3. The lane reads through a narrow
       {id, read} port rather than a Connection: it needs the SLOT alongside the accounts
       (the witness rule compares reads BY SLOT, and a read whose slot is unknown cannot
       witness anything), and naming each endpoint is what lets a disagreement between
       them be attributed instead of averaged. */
    const laneReader = (label, endpoint) => {
      const c = new Connection(endpoint, solanaRpcConnectionConfig());
      return {
        id: label,
        async read(_mint, addresses) {
          const keys = (Array.isArray(addresses) ? addresses : [addresses])
            .filter(Boolean).map((a) => new PublicKey(String(a)));
          const res = await c.getMultipleAccountsInfoAndContext(keys);
          return { slot: res?.context?.slot ?? null, accounts: res?.value ?? [] };
        },
      };
    };
    const laneReaders = [
      laneReader("primary", RPC),
      laneReader("secondary", SECONDARY_RPC),
    ];
    const lane = createSnipeLane({
      venue: PUMPFUN_VENUE,
      readers: laneReaders,
      cfg: laneCfg,
      /* THE DESK'S STATE OBJECT, SO THE TWO BOOKS CAN SEE EACH OTHER — which is the
         opposite of mixing them, and the distinction is the whole design.
         The lane keeps its positions under S.snipes and the desk keeps its under
         S.positions, so openList() is still Object.values(S.positions) and cannot see a
         snipe BY CONSTRUCTION (test-snipe-separation.mjs clause 1). What sharing the
         CONTAINER buys is the one thing the lane genuinely must know: whether the desk
         already holds this mint. Until now the poller passed no state at all, so
         snipe-lane.mjs's `state = {}` default applied and the already_holding gate
         checked an empty object — a collision gate that could not see a collision.
         Two lanes sizing exits from the same token balance is precisely the failure the
         second book exists to prevent, and the wiring defeated it. It also means the
         shadow book has been recording would-have-entries on coins the desk was already
         holding, so the evidence improves the moment this is passed. */
      state: S,
      /* THE SAME KILL SWITCHES THE DESK OBEYS, not a second pair. The lane refuses to
         construct without this and takes no default, on the stated grounds that an
         UNCHECKED sentinel is not the same fact as an ABSENT one — so it is handed the
         desk's own readers. An owner who drops the hard-stop file stops both lanes with
         one action, which is the only behaviour that is safe to remember under pressure.
         Booleans are coerced here because the lane demands strict booleans and these
         helpers already return them; a truthy string would be accepted by neither. */
      control: () => ({ hardStop: hardStop() === true, pauseEntries: pauseEntries() === true }),
      log: (msg) => log(`[snipe] ${msg}`),
    });
    const snipeTickMs = Number(process.env.SNIPE_TICK_MS || 1_000);
    /* A FAULT MUST NEVER ABANDON AN OPEN POSITION.
     *
     * The original latch was right for an observer and wrong for anything that can hold:
     * any throw set laneFaulted permanently, so a single transient RPC error would leave
     * a live bag with nothing running to price it, stop it, take it or answer the hard
     * stop. The lane would sit quietly disabled while the position it opened rode to zero.
     *
     * So the latch now asks ONE question — is anything open? With an empty book, giving up
     * permanently is still correct and still cheap. With a position open, the lane keeps
     * trying on an exponential backoff, because a retried READ cannot make the position
     * worse and not retrying certainly can. The backoff is what keeps a genuinely broken
     * lane from spinning every tick, and the log escalates so a persistent fault with a
     * bag open is not a line that scrolls past looking like the last one. */
    let laneFaulted = false, laneFaults = 0, laneRetryAt = 0;
    const LANE_BACKOFF_MAX_MS = 60_000;
    setInterval(async () => {
      if (laneFaulted) return;
      if (laneRetryAt && Date.now() < laneRetryAt) return;
      try {
        await lane.tick(Date.now());
        laneFaults = 0; laneRetryAt = 0;
      } catch (err) {
        const open = (() => { try { return lane.openPositions().length; } catch { return 0; } })();
        if (open === 0) {
          laneFaulted = true;
          log(`[snipe] lane disabled after a tick fault with nothing open — the desk is unaffected: ${err?.message || err}`);
          return;
        }
        laneFaults += 1;
        const wait = Math.min(snipeTickMs * 2 ** Math.min(laneFaults, 6), LANE_BACKOFF_MAX_MS);
        laneRetryAt = Date.now() + wait;
        log(`[snipe] TICK FAULT ${laneFaults} WITH ${open} POSITION(S) OPEN — retrying in ${wait}ms rather ` +
          `than disabling, because a disabled lane cannot exit what it opened. The desk is unaffected: ${err?.message || err}`);
      }
    }, snipeTickMs);
    log(`[snipe] launch lane up in ${laneCfg.lane} mode, ${snipeTickMs}ms tick, ` +
      `${laneReaders.length} endpoints — nothing is signed on this path`);
  } catch (err) {
    /* Deliberately not fatal. The desk was running before the lane existed and must go on
       running if it cannot start: a missing module, a bad SNIPE_* value or an unreachable
       secondary endpoint are all reasons to have no shadow book, and none of them is a
       reason to stop trading. */
    log(`[snipe] launch lane did not start (${err?.message || err}) — the desk is unaffected`);
  }
}
