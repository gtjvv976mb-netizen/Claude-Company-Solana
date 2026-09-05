#!/usr/bin/env node
/**
 * Minimal macOS launchd bridge for WALL-ST-E.
 *
 * launchd has no EnvironmentFile directive. This runner reads the executor's
 * owner-only environment file as data, assigns literal values to process.env, and
 * only then imports poller.mjs in the same process. It never invokes a shell.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair } from "@solana/web3.js";

const MIN_NODE = Object.freeze({ major: 22, minor: 13 });
const RUNTIME_FILES = Object.freeze([
  "poller.mjs",
  "journal.mjs",
  "jupiter.mjs",
  "balance-verification.mjs",
  "entry-quote-guard.mjs",
  "exit-trigger.mjs",
  "feed-drain.mjs",
  "sol-usd-oracle.mjs",
  "heartbeat-health.mjs",
  "sleep-assertion.mjs",
  "strategy.mjs",
  "trade-policy.mjs",
  /* desk-led-v4: the desk's ruler and the mirror evaluator are loaded by the trading
     process, so an install that lacks them is an install that cannot exit while the
     desk is unreachable. Validated like every other runtime file. */
  "dexscreener-consensus.mjs",
  "desk-mirror.mjs",
  "package.json",
  "package-lock.json",
]);
const ALLOWED_ENV = new Set([
  "BLOCK_HEIGHT_WINDOW", "BOOK_HEAT_MAX", "CC_API", "CC_FLOOR", "CC_SECRET",
  "DAILY_LOSS_LIMIT_SOL",
  /* desk-led-v4 (2026-09-05). How long the desk may be consecutively unreachable before
     the bot mirrors the desk's own levels with the desk's ruler. Bounded in poller.mjs
     (live 2 min to 1 h). */
  "DESK_UNREACHABLE_MS",
  /* wave 2 (2026-09-05). How long a call may be LIVE at the desk with no fresh mark
     before the bot stops reading that silence as a decision to hold and mirrors the desk
     for THAT position. A wedged penthouse loop still answers 200. Bounded in poller.mjs
     (live 2 min to 1 h). */
  "DESK_SILENT_MS",
  /* TEST SEAM, honoured by the mirror's DexScreener lane exactly as the desk's own
     dexscreener.js honours it: with DS_OFFLINE=1 the consensus price DECLINES and mirror
     mode runs its clock lane only. It is allowlisted because the runtime references it
     and this allowlist must name every referenced setting; it has no business in a
     production env file — an operator who sets it blinds the mirror's price lane. */
  "DS_OFFLINE",
  /* What a healthy transaction is expected to cost, as opposed to the fee above which
     an entry is REFUSED. See LIVE_LIMITS in poller.mjs. */
  /* How many times a TRANSIENT entry failure is retried before the call is
     acknowledged. Bounded so a failing entry can never head-of-line block a later
     exit; a deterministic refusal is never retried at all. */
  "MAX_ENTRY_RETRIES",
  /* Retired by desk-led-v4 — the sustained-outage sell it bounded was a bot-originated
     exit. Still accepted so an existing env file validates; the poller ignores it. */
  "EXIT_MARK_OUTAGE_LATCH_MS",
  "EXPECTED_NETWORK_FEE_LAMPORTS", "DAILY_SOL_CAP", "EXECUTE", "EXECUTOR_SOURCE_COMMIT",
  "FEE_RESERVE_SOL", "FINALITY_TIMEOUT_MS", "F_DEFAULT", "F_NAME_MAX", "HARD_STOP_FILE",
  "INIT_ONLY", "JUPITER_API_BASE", "JUPITER_API_KEY", "KEYPAIR", "LIVE_CAPS_ACK",
  "LIVE_STATE_INIT_ACK", "LIVE_TRADING_ACK", "LOCK_FILE",
  /* Cadence of the valuation/custody pass (manageOpen) — the feed is read every POLL_MS
     regardless. Live 5 s to 5 min. */
  "MARK_MS",
  "MAX_AGE_HOURS",
  "MAX_CALL_AGE_MIN", "MAX_ENTRY_DEVIATION_PCT", "MAX_ENTRY_MARK_AGE_MIN",
  "MAX_ENTRY_PREFLIGHT_AGE_MS", "MAX_ENTRY_QUOTE_DRIFT_PCT",
  "MAX_ENTRY_ROUND_TRIP_LOSS_PCT", "MAX_EXIT_PRICE_IMPACT_PCT",
  "MAX_EXIT_TRIGGER_AGE_MS", "MAX_EXIT_TX_ATTEMPTS", "MAX_FUTURE_SKEW_MIN",
  "MAX_JUPITER_FEE_BPS", "MAX_NETWORK_FEE_LAMPORTS", "MAX_NETWORK_FEE_PCT",
  "MAX_OPEN_POSITIONS", "MAX_PRICE_IMPACT_PCT", "MAX_QUOTE_SHORTFALL_PCT",
  "MAX_RENT_LAMPORTS", "MAX_SOL_PER_TRADE", "MAX_TX_ATTEMPTS", "PAUSE_ENTRIES_FILE",
  "POLL_MS",
  /* How long the no-sign readiness rehearsal may run before it is abandoned. It gates
     nothing — the rehearsal signs nothing and is not consulted before an entry — but a
     probe that never settles used to latch the in-flight flag and silently end all
     rehearsals, so the deadline is what releases it. Floored at 30s in the poller. */
  "READINESS_TIMEOUT_MS",
  /* wave 2 (2026-09-05). How often the bot asks the desk about the calls it is actually
     holding — the floor under the feed, for the exit event that is delivered once and
     missed. The feed remains the fast path at POLL_MS. Bounded in poller.mjs
     (live 15 s to 10 min); the pass runs only under EXECUTE. */
  "RECONCILE_MS",
  "SLIPPAGE_BPS", "SOLANA_RPC", "SOLANA_RPC_SECONDARY",
  "SOL_USD_CACHE_MAX_AGE_MS", "STATE_DB", "STATE_FILE", "TRAIL_PCT",
  // Keeps entries armed while the host is on battery. Everything else about the power
  // gate is unchanged: the idle-sleep assertion is still required and still verified.
  "WALLSTE_ALLOW_BATTERY_ENTRIES",
]);
const SAFE_INHERITED_ENV = new Set([
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TZ", "USER",
]);
const PRESTART_ENV_BLOCKLIST = Object.freeze([
  "ALL_PROXY", "BASH_ENV", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "ENV",
  "HTTPS_PROXY", "HTTP_PROXY", "LD_PRELOAD", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS",
  "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "NO_PROXY",
  "OPENSSL_CONF", "SSLKEYLOGFILE", "SSL_CERT_DIR", "SSL_CERT_FILE", "all_proxy",
  "https_proxy", "http_proxy", "no_proxy",
]);

function abort(message, code = 1) {
  console.error(`WALL-ST-E launchd: ${message}`);
  process.exit(code);
}

function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) &&
    major < 25 && (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor));
}

function protectedRegularFile(file, label) {
  const absolute = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { abort(`${label} is unavailable (${error.code || "read error"})`); }
  if (stat.isSymbolicLink() || !stat.isFile())
    abort(`${label} must be a regular non-symlink file`);
  if ((stat.mode & 0o077) !== 0)
    abort(`${label} must not be accessible by group or other (chmod 600)`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    abort(`${label} must be owned by the LaunchAgent user`);
  return absolute;
}

function regularRuntimeFile(file, label) {
  const absolute = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { abort(`${label} is unavailable (${error.code || "read error"})`); }
  if (stat.isSymbolicLink() || !stat.isFile())
    abort(`${label} must be a regular non-symlink file`);
  if ((stat.mode & 0o022) !== 0)
    abort(`${label} must not be writable by group or other`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    abort(`${label} must be owned by the LaunchAgent user`);
  return absolute;
}

function protectedRuntimeDirectory(directory) {
  const absolute = path.resolve(directory);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { abort(`runtime directory is unavailable (${error.code || "read error"})`); }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    abort("runtime directory must be a regular non-symlink directory");
  if ((stat.mode & 0o022) !== 0)
    abort("runtime directory must not be writable by group or other");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    abort("runtime directory must be owned by the LaunchAgent user");
  return absolute;
}

function decodeQuotedValue(raw, lineNumber) {
  if (!raw.endsWith('"') || raw.length < 2)
    abort(`environment line ${lineNumber} has an unterminated quoted value`);
  const body = raw.slice(1, -1);
  let value = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== "\\") {
      if (char === '"') abort(`environment line ${lineNumber} contains an unescaped quote`);
      value += char;
      continue;
    }
    const escaped = body[++index];
    if (escaped === undefined || !['\\', '"', "$", "`"].includes(escaped))
      abort(`environment line ${lineNumber} contains an unsupported escape`);
    value += escaped;
  }
  return value;
}

export function parseProtectedEnvironment(file) {
  const absolute = protectedRegularFile(file, "environment file");
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) abort("environment file contains a NUL byte");
  const text = bytes.toString("utf8");
  if (text.includes("\r")) abort("environment file contains a carriage return");

  const values = Object.create(null);
  const seen = new Set();
  for (const [offset, line] of text.split("\n").entries()) {
    const lineNumber = offset + 1;
    if (!line || /^\s*[#;]/.test(line)) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) abort(`environment line ${lineNumber} is not a literal NAME=value assignment`);
    const [, name, raw] = match;
    if (seen.has(name)) abort(`environment line ${lineNumber} duplicates ${name}`);
    if (!ALLOWED_ENV.has(name)) abort(`environment variable ${name} is not allowed in the executor file`);
    if (raw.startsWith("'") || (!raw.startsWith('"') && /[\x00-\x1f\x7f]/.test(raw)))
      abort(`environment line ${lineNumber} has an unsupported value`);
    values[name] = raw.startsWith('"') ? decodeQuotedValue(raw, lineNumber) : raw;
    seen.add(name);
  }
  return { absolute, values, text };
}

function optionMap(tokens) {
  const options = Object.create(null);
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!/^--[a-z-]+$/.test(name || "") || value === undefined || options[name] !== undefined)
      abort("invalid or duplicate command option");
    options[name] = value;
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) if (!options[name]) abort(`missing ${name}`);
  const allowed = new Set(names);
  for (const name of Object.keys(options)) if (!allowed.has(name)) abort(`unknown option ${name}`);
}

function validateRuntime(options) {
  requireOptions(options, ["--env", "--poller"]);
  if (!nodeVersionOk()) abort("Node >=22.13 and <25 is required");
  const environment = parseProtectedEnvironment(options["--env"]);
  const poller = regularRuntimeFile(options["--poller"], "poller runtime");
  const workdir = protectedRuntimeDirectory(path.dirname(poller));
  if (path.basename(poller) !== "poller.mjs") abort("poller runtime must be named poller.mjs");
  for (const file of RUNTIME_FILES) {
    regularRuntimeFile(path.join(workdir, file), `runtime file ${file}`);
  }
  regularRuntimeFile(fileURLToPath(import.meta.url), "launchd runner");
  return { environment, poller, workdir };
}

function resolveLock(values, workdir) {
  const state = path.resolve(workdir, values.STATE_DB || ".cc-executor.sqlite");
  const canonical = `${state}.lock`;
  const configured = path.resolve(workdir, values.LOCK_FILE || canonical);
  if (configured !== canonical)
    abort("LOCK_FILE must be the canonical STATE_DB lock (STATE_DB plus .lock)");
  return canonical;
}

function resolvePauseEntries(values, workdir) {
  const state = path.resolve(workdir, values.STATE_DB || ".cc-executor.sqlite");
  return path.resolve(workdir, values.PAUSE_ENTRIES_FILE || `${state}.pause-entries`);
}

function activeLockOwner(lock) {
  let stat;
  try { stat = fs.lstatSync(lock); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    abort(`executor process lock cannot be inspected (${error.code || "read error"})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) abort("executor process lock is not a regular file");
  let owner;
  try { owner = fs.readFileSync(lock, "utf8").trim(); }
  catch (error) { abort(`executor process lock cannot be read (${error.code || "read error"})`); }
  if (!/^[0-9]+$/.test(owner) || Number(owner) <= 1)
    abort("executor process lock has an invalid owner");
  const pid = Number(owner);
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if (error.code === "EPERM") return pid;
    if (error.code === "ESRCH") return null;
    abort(`executor process lock owner cannot be verified (${error.code || "probe error"})`);
  }
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function absoluteOption(options, name) {
  const value = options[name];
  if (!path.isAbsolute(value)) abort(`${name} must be absolute`);
  if (/[\r\n\0]/.test(value)) abort(`${name} contains an invalid character`);
  return value;
}

function ownerControlFile(file, label, { required = false } = {}) {
  const absolute = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) {
    if (!required && error.code === "ENOENT") return absolute;
    abort(`${label} is unavailable (${error.code || "read error"})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    abort(`${label} must be a regular non-symlink file`);
  if ((stat.mode & 0o022) !== 0)
    abort(`${label} must not be writable by group or other`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    abort(`${label} must be owned by the LaunchAgent user`);
  return absolute;
}

function nonNegativeNumber(values, name, fallback) {
  const raw = values[name] === undefined ? String(fallback) : values[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) abort(`${name} must be a non-negative finite number`);
  return value;
}

const SOL_SCALE = 1_000_000_000n;
function plainSolUnits(value) {
  const raw = String(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/.exec(raw);
  if (!match) return null;
  return BigInt(match[1]) * SOL_SCALE + BigInt((match[2] || "").padEnd(9, "0") || "0");
}

function exactMoneyCap(name, value, { min = 0.000001, max = null, fail = abort } = {}) {
  const raw = String(value);
  const units = plainSolUnits(raw);
  if (units === null) {
    fail(`${name} must be a plain decimal with at most 9 fractional digits`);
    return null;
  }
  const minUnits = plainSolUnits(min);
  const maxUnits = max === null ? null : plainSolUnits(max);
  if (units < minUnits || (maxUnits !== null && units > maxUnits)) {
    fail(max === null
      ? `${name} must be at least ${min}`
      : `${name} must be between ${min} and ${max}`);
    return null;
  }
  return Object.freeze({ raw, units, value: Number(units) / 1_000_000_000 });
}

function liveMoneyCap(values, name, fallback) {
  const raw = values[name] === undefined ? String(fallback) : values[name];
  return exactMoneyCap(name, raw);
}

function liveOpenPositions(values, fail = abort) {
  const raw = values.MAX_OPEN_POSITIONS === undefined ? "4" : values.MAX_OPEN_POSITIONS;
  if (!/^[1-4]$/.test(raw)) {
    fail("MAX_OPEN_POSITIONS must be an integer between 1 and 4");
    return null;
  }
  return Number(raw);
}

const CANARY_MONEY_CAPS = Object.freeze({
  MAX_SOL_PER_TRADE: 0.005,
  DAILY_SOL_CAP: 0.01,
  DAILY_LOSS_LIMIT_SOL: 0.01,
});
// DAILY_LOSS_LIMIT_SOL is a rolling realized-loss entry brake threshold. It limits
// later entry authority; it cannot guarantee a fill/slippage loss ceiling.
const OPERATOR_MONEY_MAX = Object.freeze({
  MAX_SOL_PER_TRADE: 0.05,
  DAILY_SOL_CAP: 0.5,
  DAILY_LOSS_LIMIT_SOL: 0.15,
});
const MONEY_CAP_NAMES = Object.freeze(Object.keys(CANARY_MONEY_CAPS));
const capsAckSentence = (wallet, trade, daily, loss) =>
  `I acknowledge WALL-ST-E caps v2 for ${wallet}: ${trade} SOL per trade, ${daily} SOL per day, ${loss} SOL rolling realized-loss entry brake`;

function requestedOperatorCaps(options) {
  const names = ["--max-sol", "--daily-sol-cap", "--daily-loss-cap"];
  requireOptions(options, ["--env", "--workdir", ...names]);
  const raw = Object.freeze({
    MAX_SOL_PER_TRADE: options["--max-sol"],
    DAILY_SOL_CAP: options["--daily-sol-cap"],
    DAILY_LOSS_LIMIT_SOL: options["--daily-loss-cap"],
  });
  const parsed = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name,
    exactMoneyCap(name, value, { max: OPERATOR_MONEY_MAX[name],
      fail: (message) => { throw new Error(message); } }),
  ]));
  if (parsed.DAILY_SOL_CAP.units < parsed.MAX_SOL_PER_TRADE.units)
    throw new Error("DAILY_SOL_CAP must be at least MAX_SOL_PER_TRADE");
  return raw;
}

function loadProtectedKeypair(file) {
  const absolute = protectedRegularFile(file, "live keypair");
  let bytes;
  try { bytes = JSON.parse(fs.readFileSync(absolute, "utf8")); }
  catch { throw new Error("KEYPAIR is not a readable Solana JSON keypair"); }
  try { return Keypair.fromSecretKey(new Uint8Array(bytes)); }
  catch { throw new Error("KEYPAIR does not contain a valid Solana secret key"); }
}

async function terminalConfirmation(expected, { input, output }) {
  output.write(`\nExact acknowledgement required:\n${expected}\n\n`);
  const terminal = createInterface({ input, output });
  try { return await terminal.question("Type the complete sentence exactly: "); }
  finally { terminal.close(); }
}

/**
 * Atomically records a locally chosen cap tuple and its wallet-bound v2
 * acknowledgement. Production callers must use real TTY streams. The injectable
 * reader keeps the ceremony behaviorally testable without weakening that boundary.
 */
export async function armOperatorCaps(options, {
  input = process.stdin,
  output = process.stdout,
  readConfirmation = terminalConfirmation,
} = {}) {
  const raw = requestedOperatorCaps(options);
  if (!input?.isTTY || !output?.isTTY)
    throw new Error("cap arming requires an interactive terminal (TTY); piped input is refused");

  const workdir = protectedRuntimeDirectory(absoluteOption(options, "--workdir"));
  const environment = parseProtectedEnvironment(options["--env"]);
  const values = environment.values;
  if (values.EXECUTE !== "1") throw new Error("cap arming requires an existing live EXECUTE=1 environment");
  if (values.INIT_ONLY === "1") throw new Error("INIT_ONLY must not be persisted in the live environment");
  liveOpenPositions(values, (message) => { throw new Error(message); });
  if (typeof values.LIVE_TRADING_ACK !== "string" || !values.LIVE_TRADING_ACK ||
      values.LIVE_TRADING_ACK !== values.LIVE_TRADING_ACK.trim())
    throw new Error("live environment is missing an exact LIVE_TRADING_ACK wallet");

  const keypairPath = path.resolve(workdir, values.KEYPAIR || "burner.json");
  const wallet = loadProtectedKeypair(keypairPath).publicKey.toBase58();
  if (wallet !== values.LIVE_TRADING_ACK)
    throw new Error("LIVE_TRADING_ACK does not match the public key derived from KEYPAIR");

  const pause = resolvePauseEntries(values, workdir);
  ownerControlFile(pause, "entry-pause sentinel", { required: true });
  const lock = resolveLock(values, workdir);
  const active = activeLockOwner(lock);
  if (active !== null)
    throw Object.assign(new Error(`an active executor (pid ${active}) owns the process lock; stop it explicitly`),
      { exitCode: 3 });

  const acknowledgement = capsAckSentence(wallet, raw.MAX_SOL_PER_TRADE,
    raw.DAILY_SOL_CAP, raw.DAILY_LOSS_LIMIT_SOL);
  const typed = await readConfirmation(acknowledgement, { input, output });
  if (typed !== acknowledgement)
    throw new Error("cap acknowledgement did not match exactly; environment was not changed");

  // Re-prove every mutable gate after the human pause at the prompt.
  const current = parseProtectedEnvironment(environment.absolute);
  if (current.text !== environment.text)
    throw new Error("protected environment changed during acknowledgement; retry from a fresh review");
  ownerControlFile(pause, "entry-pause sentinel", { required: true });
  const activeAfterPrompt = activeLockOwner(lock);
  if (activeAfterPrompt !== null)
    throw Object.assign(new Error(`an active executor (pid ${activeAfterPrompt}) started during acknowledgement; caps were not changed`),
      { exitCode: 3 });

  const rendered = rewriteEnvironment(environment.text, {
    ...raw,
    LIVE_CAPS_ACK: acknowledgement,
  });
  const envFile = environment.absolute;
  const backup = `${envFile}.previous-caps-${Date.now()}-${process.pid}`;
  const temporary = `${envFile}.next-caps-${process.pid}-${Date.now()}`;
  let published = false;
  try {
    writeExclusiveProtected(backup, Buffer.from(environment.text, "utf8"));
    writeExclusiveProtected(temporary, Buffer.from(rendered, "utf8"));
    const candidate = parseProtectedEnvironment(temporary);
    if (candidate.values.LIVE_CAPS_ACK !== acknowledgement ||
        MONEY_CAP_NAMES.some((name) => candidate.values[name] !== raw[name]))
      throw new Error("rendered cap environment failed exact self-verification");
    ownerControlFile(pause, "entry-pause sentinel", { required: true });
    const finalOwner = activeLockOwner(lock);
    if (finalOwner !== null)
      throw Object.assign(new Error(`an active executor (pid ${finalOwner}) started before publication; caps were not changed`),
        { exitCode: 3 });
    if (parseProtectedEnvironment(envFile).text !== environment.text)
      throw new Error("protected environment changed before publication; caps were not changed");
    fs.renameSync(temporary, envFile);
    published = true;
    fsyncDirectory(path.dirname(envFile));
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    if (!published) try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch {}
    throw error;
  }

  output.write("Caps armed in the protected environment. This command started no service, and entries remain paused.\n");
  output.write(`Owner-only rollback environment: ${backup}\n`);
  return { acknowledgement, backup, wallet, caps: raw };
}

/** Mirror poller.mjs's deliberately awkward operator-raise ceremony. Adoption may
 * preserve an existing raise, never create one: all three raw values must be present,
 * valid under the poller's bounds, coherent, and named exactly in the wallet-bound
 * acknowledgement already stored in the protected environment. */
function acknowledgedOperatorCaps(values, configured) {
  const wantsRaise = MONEY_CAP_NAMES.some((name) =>
    configured[name].units > plainSolUnits(CANARY_MONEY_CAPS[name]));
  if (!wantsRaise) return { wantsRaise: false, accepted: false };
  const raw = Object.fromEntries(MONEY_CAP_NAMES.map((name) =>
    [name, typeof values[name] === "string" ? values[name] : ""]));
  if (MONEY_CAP_NAMES.some((name) => !raw[name]))
    return { wantsRaise: true, accepted: false };
  if (MONEY_CAP_NAMES.some((name) =>
      configured[name].units > plainSolUnits(OPERATOR_MONEY_MAX[name])))
    return { wantsRaise: true, accepted: false };
  if (configured.DAILY_SOL_CAP.units < configured.MAX_SOL_PER_TRADE.units)
    return { wantsRaise: true, accepted: false };
  const wallet = values.LIVE_TRADING_ACK;
  if (typeof wallet !== "string" || !wallet || wallet !== wallet.trim())
    return { wantsRaise: true, accepted: false };
  const expected = capsAckSentence(wallet, raw.MAX_SOL_PER_TRADE,
    raw.DAILY_SOL_CAP, raw.DAILY_LOSS_LIMIT_SOL);
  return {
    wantsRaise: true,
    accepted: typeof values.LIVE_CAPS_ACK === "string" &&
      values.LIVE_CAPS_ACK === expected,
  };
}

function encodedEnvironmentValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    .replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function rewriteEnvironment(text, replacements) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const written = new Set();
  const output = lines.map((line) => {
    const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (!match || replacements[match[1]] === undefined) return line;
    written.add(match[1]);
    return `${match[1]}=${encodedEnvironmentValue(replacements[match[1]])}`;
  });
  for (const [name, value] of Object.entries(replacements)) {
    if (!written.has(name)) output.push(`${name}=${encodedEnvironmentValue(value)}`);
  }
  return `${output.join("\n")}\n`;
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems reject directory fsync. The files themselves are still fsynced
    // before their same-directory atomic rename.
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function writeExclusiveProtected(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

function upgradeEnvironment(options, { requirePaused = false, requireStopped = false } = {}) {
  requireOptions(options, ["--env", "--legacy-workdir", "--commit"]);
  if (!nodeVersionOk()) abort("Node >=22.13 and <25 is required");
  const commit = String(options["--commit"]).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) abort("--commit must be an exact 40-character Git commit");
  const legacyInput = absoluteOption(options, "--legacy-workdir");
  const legacyWorkdir = protectedRuntimeDirectory(legacyInput);
  const environment = parseProtectedEnvironment(options["--env"]);
  const values = environment.values;
  if (values.EXECUTE !== "1") abort("versioned live adoption requires EXECUTE=1");
  if (values.INIT_ONLY === "1") abort("INIT_ONLY must not be persisted in the live environment");
  for (const name of ["CC_SECRET", "CC_FLOOR", "LIVE_TRADING_ACK", "JUPITER_API_KEY",
    "SOLANA_RPC", "SOLANA_RPC_SECONDARY"]) {
    if (!values[name]) abort(`live environment is missing ${name}`);
  }
  liveOpenPositions(values);
  const configuredExposure = Object.fromEntries(MONEY_CAP_NAMES.map((name) =>
    [name, liveMoneyCap(values, name, CANARY_MONEY_CAPS[name])]));
  const raisedCaps = acknowledgedOperatorCaps(values, configuredExposure);
  const capReplacements = Object.create(null);
  const capDefaultsApplied = [];
  const capsLowered = [];
  const raisedCapsPreserved = [];
  for (const [name, ceiling] of Object.entries(CANARY_MONEY_CAPS)) {
    const configured = configuredExposure[name];
    if (raisedCaps.accepted) {
      raisedCapsPreserved.push(name);
      continue;
    }
    if (values[name] === undefined) {
      capReplacements[name] = String(ceiling);
      capDefaultsApplied.push(name);
    } else if (configured.units > plainSolUnits(ceiling)) {
      capReplacements[name] = String(ceiling);
      capsLowered.push(name);
    }
  }
  const adoptedExposure = Object.fromEntries(MONEY_CAP_NAMES.map((name) => [name,
    capReplacements[name] === undefined
      ? configuredExposure[name] : exactMoneyCap(name, capReplacements[name]),
  ]));
  if (adoptedExposure.DAILY_SOL_CAP.units < adoptedExposure.MAX_SOL_PER_TRADE.units)
    abort(`DAILY_SOL_CAP (${adoptedExposure.DAILY_SOL_CAP.value}) is below ` +
      `MAX_SOL_PER_TRADE (${adoptedExposure.MAX_SOL_PER_TRADE.value}) after safe normalization`);
  // Gross ATA creation rent is a transaction-compatibility rail, not market
  // exposure. A missing value adopts the reviewed two-ATA ceiling; an explicitly
  // lower operator value remains untouched by the migration.
  const rentCeiling = 4_200_000;
  const configuredRent = nonNegativeNumber(values, "MAX_RENT_LAMPORTS", rentCeiling);
  if (values.MAX_RENT_LAMPORTS === undefined) {
    capReplacements.MAX_RENT_LAMPORTS = String(rentCeiling);
    capDefaultsApplied.push("MAX_RENT_LAMPORTS");
  } else if (configuredRent > rentCeiling) {
    capReplacements.MAX_RENT_LAMPORTS = String(rentCeiling);
    capsLowered.push("MAX_RENT_LAMPORTS");
  }

  const resolveLegacy = (value, fallback, label) => {
    const configured = value || fallback;
    const resolved = path.resolve(legacyWorkdir, configured);
    const relative = path.relative(legacyWorkdir, resolved);
    if (!path.isAbsolute(configured) && (relative === ".." || relative.startsWith(`..${path.sep}`)))
      abort(`${label} relative path escapes --legacy-workdir; use an explicit absolute path`);
    return resolved;
  };
  const keypair = resolveLegacy(values.KEYPAIR, "burner.json", "KEYPAIR");
  const state = resolveLegacy(values.STATE_DB, ".cc-executor.sqlite", "STATE_DB");
  const originalLock = resolveLegacy(values.LOCK_FILE, `${state}.lock`, "LOCK_FILE");
  const canonicalLock = `${state}.lock`;
  const pause = resolveLegacy(values.PAUSE_ENTRIES_FILE, `${state}.pause-entries`, "PAUSE_ENTRIES_FILE");
  const hardStop = resolveLegacy(values.HARD_STOP_FILE, `${state}.hard-stop`, "HARD_STOP_FILE");
  const legacyState = resolveLegacy(values.STATE_FILE, ".cc-state.json", "STATE_FILE");

  protectedRegularFile(keypair, "live keypair");
  protectedRegularFile(state, "durable state database");
  ownerControlFile(pause, "entry-pause sentinel", { required: requirePaused });
  ownerControlFile(hardStop, "hard-stop sentinel");
  ownerControlFile(legacyState, "legacy state file");
  if (requireStopped) {
    const active = new Set();
    for (const lock of new Set([originalLock, canonicalLock])) {
      const pid = activeLockOwner(lock);
      if (pid !== null) active.add(pid);
    }
    if (active.size)
      abort(`an active executor (pid ${[...active].join(",")}) still owns an old or canonical process lock; stop it explicitly`, 3);
  }

  const replacements = Object.freeze({
    KEYPAIR: keypair,
    STATE_DB: state,
    LOCK_FILE: canonicalLock,
    PAUSE_ENTRIES_FILE: pause,
    HARD_STOP_FILE: hardStop,
    STATE_FILE: legacyState,
    EXECUTOR_SOURCE_COMMIT: commit,
    ...capReplacements,
  });
  return { environment, replacements, commit, pause, hardStop, originalLock, canonicalLock,
    capDefaultsApplied, capsLowered, raisedCapsRequested: raisedCaps.wantsRaise,
    raisedCapsPreserved };
}

function updateUpgradeEnvironment(options) {
  requireOptions(options, ["--env", "--legacy-workdir", "--commit", "--backup"]);
  const base = {
    "--env": options["--env"],
    "--legacy-workdir": options["--legacy-workdir"],
    "--commit": options["--commit"],
  };
  const prepared = upgradeEnvironment(base, { requirePaused: true, requireStopped: true });
  const envFile = prepared.environment.absolute;
  const backup = absoluteOption(options, "--backup");
  if (path.dirname(backup) !== path.dirname(envFile))
    abort("--backup must be in the same directory as the protected environment");
  if (!path.basename(backup).startsWith(`${path.basename(envFile)}.previous-`))
    abort("--backup must use the protected environment's .previous- prefix");
  if (fs.existsSync(backup)) abort("environment backup already exists");

  const rendered = rewriteEnvironment(prepared.environment.text, prepared.replacements);
  const temporary = `${envFile}.next-${process.pid}-${Date.now()}`;
  try {
    writeExclusiveProtected(backup, Buffer.from(prepared.environment.text, "utf8"));
    writeExclusiveProtected(temporary, Buffer.from(rendered, "utf8"));
    parseProtectedEnvironment(temporary);
    fs.renameSync(temporary, envFile);
    fsyncDirectory(path.dirname(envFile));
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch {}
    throw error;
  }
  console.log(`updated protected environment for commit ${prepared.commit}; owner-only backup: ${backup}`);
}

function restoreUpgradeEnvironment(options) {
  requireOptions(options, ["--env", "--backup", "--commit"]);
  const commit = String(options["--commit"]).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) abort("--commit must be an exact 40-character Git commit");
  const current = parseProtectedEnvironment(options["--env"]);
  const backup = protectedRegularFile(options["--backup"], "environment backup");
  if (path.dirname(backup) !== path.dirname(current.absolute))
    abort("environment backup must be beside the protected environment");
  if (current.values.EXECUTOR_SOURCE_COMMIT !== commit)
    abort("current environment provenance does not match the rollback commit gate");
  parseProtectedEnvironment(backup);
  fs.renameSync(backup, current.absolute);
  fsyncDirectory(path.dirname(current.absolute));
  console.log("restored the previous protected environment; no secret value was printed");
}

function renderPlist(options) {
  const names = ["--label", "--node", "--runner", "--poller", "--env", "--workdir",
    "--stdout", "--stderr", "--throttle"];
  requireOptions(options, names);
  const label = options["--label"];
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(label)) abort("invalid LaunchAgent label");
  const throttle = Number(options["--throttle"]);
  if (!Number.isInteger(throttle) || throttle < 10 || throttle > 3600)
    abort("--throttle must be an integer from 10 to 3600 seconds");
  const node = absoluteOption(options, "--node");
  const runner = absoluteOption(options, "--runner");
  const poller = absoluteOption(options, "--poller");
  const env = absoluteOption(options, "--env");
  const workdir = absoluteOption(options, "--workdir");
  const stdout = absoluteOption(options, "--stdout");
  const stderr = absoluteOption(options, "--stderr");
  const clearedEnvironment = PRESTART_ENV_BLOCKLIST
    .map((name) => `    <key>${xml(name)}</key><string></string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(runner)}</string>
    <string>run</string>
    <string>--env</string><string>${xml(env)}</string>
    <string>--poller</string><string>${xml(poller)}</string>
    <string>--label</string><string>${xml(label)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
${clearedEnvironment}
  </dict>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>${throttle}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>ExitTimeOut</key><integer>30</integer>
</dict>
</plist>
`;
}

function usage() {
  console.log(`Usage:
  node launchd-runner.mjs validate --env FILE --poller FILE
  node launchd-runner.mjs preflight --env FILE --poller FILE
  node launchd-runner.mjs ready --env FILE --poller FILE --pid PID
  node launchd-runner.mjs run --env FILE --poller FILE --label LABEL
  node launchd-runner.mjs arm-caps --env FILE --workdir DIR \\
    --max-sol SOL --daily-sol-cap SOL --daily-loss-cap SOL
  node launchd-runner.mjs validate-upgrade-env --env FILE --legacy-workdir DIR --commit SHA
  node launchd-runner.mjs update-upgrade-env --env FILE --legacy-workdir DIR --commit SHA --backup FILE
  node launchd-runner.mjs restore-upgrade-env --env FILE --backup FILE --commit SHA
  node launchd-runner.mjs render-plist --label LABEL --node FILE --runner FILE \\
    --poller FILE --env FILE --workdir DIR --stdout FILE --stderr FILE --throttle SECONDS`);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
const command = process.argv[2];
if (!command || command === "help" || command === "--help") {
  usage();
  process.exit(command ? 0 : 1);
}
const options = optionMap(process.argv.slice(3));

if (command === "render-plist") {
  process.stdout.write(renderPlist(options));
} else if (command === "validate") {
  validateRuntime(options);
  console.log("protected environment and runtime validated");
} else if (command === "preflight") {
  const { environment, workdir } = validateRuntime(options);
  const pid = activeLockOwner(resolveLock(environment.values, workdir));
  if (pid !== null)
    abort(`an active executor (pid ${pid}) already owns this process lock; stop it explicitly before loading the LaunchAgent`, 3);
  console.log("protected environment, runtime, and process lock validated");
} else if (command === "validate-upgrade-env") {
  const prepared = upgradeEnvironment(options);
  console.log(`live environment can be safely normalized for commit ${prepared.commit}; no secret value was printed`);
  if (prepared.raisedCapsPreserved.length) {
    console.log(`install will preserve wallet-acknowledged operator caps: ${prepared.raisedCapsPreserved.join(",")}`);
    if (prepared.capsLowered.length)
      console.log(`install will lower other values above reviewed ceilings: ${prepared.capsLowered.join(",")}`);
  } else {
    console.log(prepared.capsLowered.length
      ? `install will lower values above reviewed ceilings: ${prepared.capsLowered.join(",")}`
      : "all explicitly configured caps are already at or below the reviewed ceilings");
  }
  if (prepared.raisedCapsRequested && !prepared.raisedCapsPreserved.length)
    console.log("operator-raised caps were not completely and validly wallet-acknowledged; canary normalization remains active");
  if (prepared.capDefaultsApplied.length)
    console.log(`install will apply reviewed defaults to missing values: ${prepared.capDefaultsApplied.join(",")}`);
  console.log(`entry-pause sentinel required before install: ${prepared.pause}`);
  console.log(`hard-stop sentinel preserved if present: ${prepared.hardStop}`);
} else if (command === "update-upgrade-env") {
  updateUpgradeEnvironment(options);
} else if (command === "restore-upgrade-env") {
  restoreUpgradeEnvironment(options);
} else if (command === "arm-caps") {
  try { await armOperatorCaps(options); }
  catch (error) { abort(error?.message || "cap arming failed", error?.exitCode || 1); }
} else if (command === "ready") {
  requireOptions(options, ["--env", "--poller", "--pid"]);
  const expectedPid = Number(options["--pid"]);
  if (!Number.isInteger(expectedPid) || expectedPid <= 1) abort("--pid must be a positive process id");
  const { environment, workdir } = validateRuntime({
    "--env": options["--env"], "--poller": options["--poller"],
  });
  const owner = activeLockOwner(resolveLock(environment.values, workdir));
  if (owner !== expectedPid) abort("LaunchAgent pid does not own the canonical executor lock", 4);
  if (process.platform === "darwin") {
    const {
      batteryEntriesAllowed, batteryPowerIsOperational, inspectOwnerControlFile,
      sleepAssertionFaultPath, verifyMacSleepAssertion,
    } = await import(
      pathToFileURL(path.join(workdir, "sleep-assertion.mjs")).href);
    const fault = inspectOwnerControlFile(
      sleepAssertionFaultPath(resolveLock(environment.values, workdir)), {
        label: "sleep assertion fault latch",
      });
    if (fault.present)
      abort(fault.valid
        ? "sleep assertion fault is latched; explicit operator repair and review are required"
        : `sleep assertion fault latch is unsafe (${fault.reason})`, 6);
    const assertion = verifyMacSleepAssertion({ ownerPid: expectedPid,
      lockFile: resolveLock(environment.values, workdir) });
    if (!assertion.ok) {
      const pause = inspectOwnerControlFile(resolvePauseEntries(environment.values, workdir), {
        label: "entry-pause sentinel",
      });
      /* TWO RULES THAT CONTRADICTED EACH OTHER ON BATTERY.
       *
       * This accepted battery operation only while entries were DURABLY PAUSED, which
       * was right when battery always meant paused. WALLSTE_ALLOW_BATTERY_ENTRIES then
       * made the poller deliberately NOT publish that pause — the operator's own way of
       * saying "keep trading on battery" — and the two rules met: the sentinel this gate
       * demands is exactly the one the flag suppresses, so the agent could never prove
       * readiness on battery and was unloaded and disabled every time it started.
       *
       * Found the hard way on 2026-09-04, with a real position open: the bot booted,
       * resumed its TOAD position, reported the fill, proved execution readiness, and
       * was then SIGTERMed by its own supervisor fifteen seconds later.
       *
       * The power fact is unchanged and still checked — battery must be OPERATIONAL,
       * meaning a real battery on a machine that reports its power state — and an
       * unexplained missing assertion on AC still fails. What changes is that the
       * operator's explicit flag is accepted as the durable answer in place of the
       * sentinel it suppresses. */
      const allowBatteryEntries = batteryEntriesAllowed(environment.values);
      if (!batteryPowerIsOperational(assertion) ||
          (!allowBatteryEntries && (!pause.present || !pause.valid)))
        abort(`LaunchAgent sleep assertion is not ready (${assertion.reason})`, 5);
      console.log(allowBatteryEntries
        ? "LaunchAgent is operational on battery with entries deliberately armed (WALLSTE_ALLOW_BATTERY_ENTRIES=1)"
        : "LaunchAgent is operational on battery with entries durably paused");
    }
  }
  console.log("LaunchAgent process owns the canonical executor lock");
} else if (command === "run") {
  requireOptions(options, ["--env", "--poller", "--label"]);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(options["--label"])) abort("invalid LaunchAgent label");
  const { environment, poller, workdir } = validateRuntime({
    "--env": options["--env"], "--poller": options["--poller"],
  });
  const lockFile = resolveLock(environment.values, workdir);
  for (const name of Object.keys(process.env)) {
    if (!SAFE_INHERITED_ENV.has(name)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(environment.values)) process.env[name] = value;
  process.env.WALLSTE_SUPERVISOR = "launchd";
  process.env.WALLSTE_SERVICE_LABEL = options["--label"];
  process.chdir(workdir);
  if (process.platform === "darwin") {
    const { startMacSleepAssertion, liftAutomaticEntryPause } = await import(
      pathToFileURL(path.join(workdir, "sleep-assertion.mjs")).href);
    const pauseEntriesFile = resolvePauseEntries(environment.values, workdir);
    await startMacSleepAssertion({ ownerPid: process.pid, lockFile, pauseEntriesFile });
    /* The assertion has started and verified, so the condition that caused any pause
       this supervisor wrote on its way out is demonstrably over. Lift that pause and
       ONLY that pause: an operator's own pause and a latched fault are left alone. See
       liftAutomaticEntryPause. Without this the bot came back from every crash, upgrade
       or power flap alive and healthy but silently disarmed, and only a human could arm
       it again — which is why it skipped a real call 31 minutes after a crash. */
    try {
      const lift = liftAutomaticEntryPause({ lockFile, pauseEntriesFile });
      if (lift.lifted) console.log("WALL-ST-E launchd: entries re-armed — the automatic pause " +
        `from the previous run is cleared (${lift.reason})`);
      else if (lift.recorded) console.log("WALL-ST-E launchd: entries remain paused — " +
        `${lift.reason}: ${lift.recorded}`);
      else console.log(`WALL-ST-E launchd: entries not re-armed (${lift.reason})`);
    } catch (error) {
      // Never let re-arming decide whether the bot runs. A failure here leaves the
      // pause in place, which is the safe direction.
      console.log(`WALL-ST-E launchd: entry re-arm check failed (${error?.message || error})`);
    }
  }
  await import(pathToFileURL(poller).href);
} else {
  abort(`unknown command ${command}`);
}
}
