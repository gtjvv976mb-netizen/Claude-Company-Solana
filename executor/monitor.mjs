/**
 * Read-only WALL-ST-E operational monitor.
 *
 * This process never imports the signer, never opens the journal for writing, and
 * never changes pause/stop files. It is safe to run from an external scheduler.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import { executorRuntimeFingerprint } from "./heartbeat-health.mjs";
import { independentSolUsdPrice, solanaRpcConnectionConfig } from "./sol-usd-oracle.mjs";
import {
  inspectOwnerControlFile, sleepAssertionFaultPath, verifyMacSleepAssertion,
} from "./sleep-assertion.mjs";

const BLOCKING_STATES = ["signed", "submitted", "confirmed", "ambiguous"];
const EXECUTION_READINESS_MAX_AGE_MS = 5 * 60_000;
const POSITION_FLAGS = [
  ["manualExitRequired", "manualExitReason", "manual_exit"],
  ["exitExecutionRequired", "exitExecutionReason", "exit_required"],
  ["callIdentityIncomplete", "callIdentityIncompleteReason", "call_identity_incomplete"],
  ["balanceReconciliationRequired", "balanceReconciliationReason", "balance_reconciliation"],
  ["riskDataUnavailable", "riskDataUnavailableReason", "risk_data_unavailable"],
  ["accountingIncomplete", "accountingIncompleteReason", "accounting_incomplete"],
];

const json = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const fingerprint = (value) => {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
};
const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

function decodeDoubleQuotedEnv(raw, lineNumber) {
  if (raw.length < 2 || !raw.endsWith('"'))
    throw new Error(`environment line ${lineNumber} has an unterminated quoted value`);
  const body = raw.slice(1, -1);
  let value = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== "\\") {
      if (char === '"') throw new Error(`environment line ${lineNumber} contains an unescaped quote`);
      value += char;
      continue;
    }
    const escaped = body[++index];
    if (escaped === undefined || !['\\', '"', "$", "`"].includes(escaped))
      throw new Error(`environment line ${lineNumber} contains an unsupported escape`);
    value += escaped;
  }
  return value;
}

function decodeEnvValue(raw, lineNumber) {
  const value = raw.trim();
  if (value.startsWith('"')) return decodeDoubleQuotedEnv(value, lineNumber);
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'") || value.slice(1, -1).includes("'"))
      throw new Error(`environment line ${lineNumber} has an invalid single-quoted value`);
    return value.slice(1, -1);
  }
  if (/[\s"'\\\x00-\x1f\x7f]/.test(value))
    throw new Error(`environment line ${lineNumber} has unsupported unquoted syntax`);
  return value;
}

/** Parse the installer's systemd KEY=value file without evaluating shell syntax. */
export function readExecutorEnv(file) {
  if (!file || !fs.existsSync(file)) return {};
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("executor environment must be a regular non-symlink file");
  if ((stat.mode & 0o077) !== 0)
    throw new Error("executor environment must not be accessible by group or other (chmod 600)");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("executor environment must be owned by the monitor user");
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) throw new Error("executor environment contains a NUL byte");
  const source = bytes.toString("utf8");
  if (source.includes("\r")) throw new Error("executor environment contains a carriage return");
  const result = {};
  const seen = new Set();
  for (const [offset, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`environment line ${offset + 1} is not a literal NAME=value assignment`);
    if (seen.has(match[1])) throw new Error(`environment line ${offset + 1} duplicates ${match[1]}`);
    result[match[1]] = decodeEnvValue(match[2], offset + 1);
    seen.add(match[1]);
  }
  return result;
}

function processWorkingDirectory(pid) {
  try { return fs.realpathSync(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch {}
  try {
    const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    const name = output.split(/\r?\n/).find((line) => line.startsWith("n"));
    return name ? fs.realpathSync(name.slice(1)) : null;
  } catch { return null; }
}

function launchdServicePid(execFile = execFileSync) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  try {
    const output = execFile("/bin/launchctl", ["print",
      `gui/${process.getuid()}/com.claudeco.wallste`], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(output);
    return match && Number(match[1]) > 1 ? Number(match[1]) : null;
  } catch { return null; }
}

export function classifyProcessTopology({ pid, command, cwd, executorDir, registeredLaunchdPid }) {
  const dir = executorDir || null;
  const expectedPoller = dir ? path.join(dir, "poller.mjs") : null;
  const expectedRunner = dir ? path.join(dir, "launchd-runner.mjs") : null;
  const node = typeof command === "string" && /(?:^|\/)node(?:\s|$)/.test(command);
  const direct = Boolean(node && !command.includes("--poller") && expectedPoller &&
    (command.includes(expectedPoller) || /(?:^|\s)(?:\.\/)?poller\.mjs(?:\s|$)/.test(command)));
  const runner = Boolean(node && expectedRunner && expectedPoller &&
    command.includes(expectedRunner) && command.includes(" run ") &&
    command.includes("--env") && command.includes("--poller") &&
    command.includes(expectedPoller) && command.includes("--label") &&
    command.includes("com.claudeco.wallste"));
  const launchd = runner && registeredLaunchdPid === pid;
  const commandMatches = direct || runner;
  const cwdMatches = Boolean(dir && cwd && cwd === dir);
  return { commandMatches, cwdMatches,
    identityVerified: commandMatches && cwdMatches,
    supervisor: launchd ? "launchd" : commandMatches ? "manual" : null,
    launchdServicePid: Number.isInteger(registeredLaunchdPid) ? registeredLaunchdPid : null };
}

function defaultProcessProbe(pid, { executorDir } = {}) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error?.code !== "EPERM") return { alive: false, commandMatches: false,
      cwdMatches: false, identityVerified: false, supervisor: null, launchdServicePid: null };
  }
  let command = null;
  try {
    command = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  const dir = executorDir ? fs.realpathSync(executorDir) : null;
  const cwd = processWorkingDirectory(pid);
  return { alive: true, ...classifyProcessTopology({ pid, command, cwd, executorDir: dir,
    registeredLaunchdPid: launchdServicePid() }) };
}

function issue(list, code, severity, message) {
  list.push({ code, severity, message: String(message).slice(0, 500) });
}

async function defaultOracleProbe({ primaryUrl, secondaryUrl, now }) {
  const primary = new Connection(primaryUrl, solanaRpcConnectionConfig());
  const secondary = new Connection(secondaryUrl, solanaRpcConnectionConfig());
  return independentSolUsdPrice(primary, secondary, { nowMs: now });
}

function readJournal(stateDb, now, issues) {
  if (!fs.existsSync(stateDb)) {
    issue(issues, "journal_missing", "critical", "executor journal is missing");
    return { exists: false, quickCheck: null, cursor: null, primed: null,
      wallet: null, openPositions: 0, blockingIntents: [], positionBlocks: [] };
  }
  let db;
  try {
    db = new DatabaseSync(stateDb, { readOnly: true });
    const quickCheck = db.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown";
    if (quickCheck !== "ok") issue(issues, "journal_corrupt", "critical", `SQLite quick_check: ${quickCheck}`);
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all()
      .map((row) => [row.key, json(row.value)]));
    const wallet = typeof meta.wallet === "string" && meta.wallet ? meta.wallet : null;
    if (!wallet) issue(issues, "journal_wallet_missing", "critical", "journal has no valid wallet binding");
    const positions = db.prepare("SELECT mint,data,updated_at FROM positions ORDER BY mint").all();
    const positionBlocks = [];
    for (const row of positions) {
      const value = json(row.data, {});
      for (const [flag, reasonKey, code] of POSITION_FLAGS) {
        if (value?.[flag] !== true) continue;
        positionBlocks.push({ mint: fingerprint(row.mint), code,
          reason: String(value?.[reasonKey] || code).slice(0, 240), updatedAt: row.updated_at });
      }
    }
    if (positionBlocks.some((block) => block.code === "manual_exit" || block.code === "exit_required"))
      issue(issues, "position_exit_blocked", "critical", "one or more positions require an unresolved or manual exit");
    else if (positionBlocks.length)
      issue(issues, "position_reconciliation", "critical", "one or more positions block safe new exposure");

    const placeholders = BLOCKING_STATES.map(() => "?").join(",");
    const blocking = db.prepare(`SELECT id,kind,mint,state,updated_at FROM intents
      WHERE state IN (${placeholders}) ORDER BY updated_at,id`).all(...BLOCKING_STATES);
    const blockingIntents = blocking.map((row) => ({
      id: fingerprint(row.id), kind: row.kind, mint: fingerprint(row.mint),
      state: row.state, ageMs: Math.max(0, now - Number(row.updated_at || 0)),
    }));
    for (const intent of blockingIntents) {
      if (intent.state === "ambiguous")
        issue(issues, "intent_ambiguous", "critical", `${intent.kind} intent ${intent.id} is ambiguous`);
      else if (intent.state === "confirmed" && intent.ageMs > 60_000)
        issue(issues, "accounting_stalled", "critical", `confirmed intent ${intent.id} has not been accounted`);
      else if (["signed", "submitted"].includes(intent.state) && intent.ageMs > 5 * 60_000)
        issue(issues, "intent_stale", "critical", `${intent.state} intent ${intent.id} is stale`);
      else issue(issues, "intent_pending", "warning", `${intent.kind} intent ${intent.id} is still ${intent.state}`);
    }
    return {
      exists: true, quickCheck, wallet, cursor: Number(meta.cursor ?? 0),
      primed: Boolean(meta.primed), openPositions: positions.length,
      blockingIntents, positionBlocks,
      risk: meta.risk_state && typeof meta.risk_state === "object" ? {
        deployed24hSol: Number(meta.risk_state.deployedTodaySol || 0),
        realized24hSol: Number(meta.risk_state.realizedTodaySol || 0),
        wins: Number(meta.risk_state.wins || 0), losses: Number(meta.risk_state.losses || 0),
      } : null,
    };
  } catch (error) {
    issue(issues, "journal_unreadable", "critical", `journal could not be read: ${error.message}`);
    return { exists: true, quickCheck: null, cursor: null, primed: null,
      wallet: null, openPositions: 0, blockingIntents: [], positionBlocks: [] };
  } finally {
    try { db?.close(); } catch {}
  }
}

async function probeFeed({
  api, floor, secret, cursor, pollMs, fetchFn, now, issues,
  expectedMode, expectedWallet, expectedCursor, expectedOpen, expectedEntriesPaused,
  expectedRuntimeCommit, expectedRuntimeFingerprint, expectedCaps,
}) {
  if (!api || !floor || !secret) {
    issue(issues, "feed_probe_unconfigured", "warning", "authenticated feed probe is not configured");
    return { checked: false, ok: false, cursorLag: null, heartbeat: null };
  }
  const headers = { authorization: `Bearer ${secret}` };
  const result = { checked: true, ok: false, cursorLag: null, heartbeat: null };
  try {
    const response = await fetchFn(`${api}/api/floor/${floor}/executor/feed?after=${Number(cursor || 0)}`, {
      headers, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    result.httpStatus = response.status;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.cluster !== "mainnet-beta" || !Number.isSafeInteger(Number(body?.latest_id)) ||
        !Array.isArray(body?.events)) throw new Error("malformed or non-mainnet feed response");
    result.cluster = body.cluster;
    result.latestId = Number(body.latest_id);
    result.eventCount = body.events.length;
    result.cursorLag = result.latestId - Number(cursor || 0);
    if (result.cursorLag < 0) {
      issue(issues, "feed_cursor_regression", "critical",
        `feed latest_id regressed behind the durable cursor by ${Math.abs(result.cursorLag)} event(s)`);
    } else {
      result.ok = true;
    }
    if (result.cursorLag > 0) {
      const times = body.events.map((event) => Number(event?.ts)).filter(Number.isFinite);
      const oldestTs = times.length ? Math.min(...times) : null;
      const lagAgeMs = oldestTs == null ? null : Math.max(0, now - oldestTs);
      result.oldestPendingAgeMs = lagAgeMs;
      issue(issues, "feed_cursor_lag", lagAgeMs != null && lagAgeMs > Math.max(60_000, pollMs * 4)
        ? "critical" : "warning", `journal cursor trails the feed by ${result.cursorLag} event(s)`);
    }
  } catch (error) {
    result.error = String(error.message).slice(0, 240);
    issue(issues, "feed_unavailable", "critical", `authenticated feed probe failed: ${error.message}`);
  }

  // New servers expose the poller's last stored pulse through the same authenticated,
  // read-only route. Older servers return 404/405; that is reported as unsupported.
  try {
    const response = await fetchFn(`${api}/api/floor/${floor}/executor/heartbeat`, {
      headers, redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const body = await response.json();
      const heartbeat = body?.heartbeat ?? body;
      const seenAt = Number(heartbeat?.seenAt || 0);
      const heartbeatWallet = String(heartbeat?.wallet || "");
      const rawHealth = heartbeat?.health && typeof heartbeat.health === "object"
        ? heartbeat.health : null;
      const rawExecutionReadiness = rawHealth?.executionReadiness &&
        typeof rawHealth.executionReadiness === "object"
        ? rawHealth.executionReadiness : null;
      const rawCaps = rawHealth?.caps && typeof rawHealth.caps === "object"
        ? rawHealth.caps : null;
      result.heartbeat = heartbeat && seenAt > 0 ? {
        supported: true, mode: String(heartbeat.mode || "").slice(0, 16),
        wallet: fingerprint(heartbeatWallet),
        cursor: Number(heartbeat.cursor || 0), open: Number(heartbeat.open || 0),
        ageMs: Math.max(0, now - seenAt),
        health: rawHealth ? {
          state: String(rawHealth.state || "degraded").slice(0, 32),
          entriesPaused: rawHealth.entriesPaused === true,
          hardStop: rawHealth.hardStop === true,
          blockingIntent: rawHealth.blockingIntent === true,
          blockedPositions: Number(rawHealth.blockedPositions || 0),
          manualAction: rawHealth.manualAction === true,
          exitBlocked: rawHealth.exitBlocked === true,
          feedRollback: rawHealth.feedRollback === true,
          lastTickCompletedAt: Number(rawHealth.lastTickCompletedAt || 0),
          lastFeedSuccessAt: Number(rawHealth.lastFeedSuccessAt || 0),
          consecutiveFeedFailures: Number(rawHealth.consecutiveFeedFailures || 0),
          consecutiveTickFailures: Number(rawHealth.consecutiveTickFailures || 0),
          runtimeCommit: rawHealth.runtimeCommit || null,
          runtimeFingerprint: rawHealth.runtimeFingerprint || null,
          executionReadiness: rawExecutionReadiness ? {
            ready: rawExecutionReadiness.ready === true,
            lastSuccessAt: Number(rawExecutionReadiness.lastSuccessAt || 0),
            observedAt: Number(rawExecutionReadiness.observedAt || 0),
            route: String(rawExecutionReadiness.route || "").slice(0, 32),
            providers: Number(rawExecutionReadiness.providers || 0),
            amountLamports: Number(rawExecutionReadiness.amountLamports || 0),
          } : null,
          caps: rawCaps ? {
            maxSolPerTrade: Number(rawCaps.maxSolPerTrade),
            dailySolCap: Number(rawCaps.dailySolCap),
            dailyLossLimitSol: Number(rawCaps.dailyLossLimitSol),
            maxOpenPositions: Number(rawCaps.maxOpenPositions),
          } : null,
        } : null,
      } : { supported: true, missing: true };
      if (!seenAt) issue(issues, "heartbeat_missing", "critical", "server has no executor heartbeat");
      else if (now - seenAt > Math.max(180_000, pollMs * 12))
        issue(issues, "heartbeat_stale", "critical", `executor heartbeat is ${Math.round((now - seenAt) / 1000)}s old`);
      if (seenAt) {
        const heartbeatFresh = now - seenAt <= Math.max(180_000, pollMs * 12);
        if (result.heartbeat.mode !== expectedMode)
          issue(issues, "heartbeat_mode_mismatch", "critical",
            `heartbeat mode ${result.heartbeat.mode || "missing"} does not match local ${expectedMode}`);
        if (!expectedWallet || heartbeatWallet !== expectedWallet)
          issue(issues, "heartbeat_wallet_mismatch", "critical",
            "heartbeat wallet does not match the durable journal binding");
        if (heartbeatFresh && result.heartbeat.cursor !== expectedCursor)
          issue(issues, "heartbeat_cursor_mismatch", "warning",
            `fresh heartbeat cursor ${result.heartbeat.cursor} does not match journal cursor ${expectedCursor}`);
        if (heartbeatFresh && result.heartbeat.open !== expectedOpen)
          issue(issues, "heartbeat_open_mismatch", "warning",
            `fresh heartbeat open count ${result.heartbeat.open} does not match journal count ${expectedOpen}`);
      }
      const health = result.heartbeat?.health;
      if (health) {
        if (expectedRuntimeCommit && health.runtimeCommit !== expectedRuntimeCommit)
          issue(issues, "heartbeat_commit_mismatch", "critical",
            "heartbeat runtime commit does not match the protected local configuration");
        if (!expectedRuntimeFingerprint || health.runtimeFingerprint !== expectedRuntimeFingerprint)
          issue(issues, "heartbeat_runtime_mismatch", "critical",
            "heartbeat runtime bytes do not match the executor files inspected locally");
        if (health.entriesPaused !== expectedEntriesPaused)
          issue(issues, "heartbeat_pause_mismatch", "warning",
            "heartbeat has not yet confirmed the local entry-pause state");
        if (health.feedRollback)
          issue(issues, "executor_feed_rollback", "critical",
            "executor self-reports that the authenticated feed moved behind its durable cursor");
        if (["manual-action", "exits-blocked"].includes(health.state))
          issue(issues, "executor_action_required", "critical", `executor self-reports ${health.state}`);
        else if (health.state === "degraded")
          issue(issues, "executor_degraded", "warning", "executor completed a tick but self-reports degraded trading health");
        const tickAge = health.lastTickCompletedAt > 0 ? now - health.lastTickCompletedAt : Infinity;
        const feedAge = health.lastFeedSuccessAt > 0 ? now - health.lastFeedSuccessAt : Infinity;
        if (tickAge > Math.max(60_000, pollMs * 4))
          issue(issues, "tick_stale", "critical", "executor has not completed a recent poll cycle");
        if (feedAge > Math.max(180_000, pollMs * 12))
          issue(issues, "executor_feed_stale", "critical", "executor has not completed a recent authenticated feed read");
      } else if (seenAt && (expectedRuntimeCommit || expectedRuntimeFingerprint))
        issue(issues, "heartbeat_identity_missing", "critical",
          "heartbeat has no runtime identity; an old or different executor may own the process lock");
      if (expectedMode === "live") {
        const readiness = health?.executionReadiness;
        const reportedCaps = health?.caps;
        if (!reportedCaps)
          issue(issues, "heartbeat_caps_missing", "critical",
            "heartbeat has no sanitized active-cap report");
        else if (["maxSolPerTrade", "dailySolCap", "dailyLossLimitSol", "maxOpenPositions"]
          .some((name) => reportedCaps[name] !== expectedCaps?.[name]))
          issue(issues, "heartbeat_caps_mismatch", "critical",
            "heartbeat active caps do not match the protected local configuration");
        if (!readiness)
          issue(issues, "execution_readiness_missing", "critical",
            "heartbeat has no successful no-sign execution-readiness probe");
        else if (!readiness.ready)
          issue(issues, "execution_readiness_failed", "critical",
            "the latest no-sign execution-readiness probe did not succeed");
        else if (readiness.route !== "wsol-usdc" || readiness.providers !== 2)
          issue(issues, "execution_readiness_invalid", "critical",
            "execution readiness did not verify the fixed WSOL/USDC route through both RPC providers");
        else if (readiness.amountLamports !== expectedCaps?.maxSolPerTradeLamports)
          issue(issues, "execution_readiness_size_mismatch", "critical",
            "execution readiness did not rehearse the active per-trade cap");
        else {
          const timestampsValid = Number.isFinite(readiness.lastSuccessAt) &&
            Number.isFinite(readiness.observedAt) && readiness.lastSuccessAt > 0 &&
            readiness.observedAt > 0 && readiness.lastSuccessAt <= now + 60_000 &&
            readiness.observedAt <= now + 60_000;
          const stale = !timestampsValid || now - readiness.lastSuccessAt > EXECUTION_READINESS_MAX_AGE_MS ||
            now - readiness.observedAt > EXECUTION_READINESS_MAX_AGE_MS;
          if (stale)
            issue(issues, "execution_readiness_stale", "critical",
              "the last successful no-sign execution-readiness probe is missing or older than five minutes");
        }
      }
    } else if (![404, 405].includes(response.status)) {
      result.heartbeat = { supported: true, error: `HTTP ${response.status}` };
      issue(issues, "heartbeat_unavailable", "warning", `heartbeat read returned HTTP ${response.status}`);
    } else {
      result.heartbeat = { supported: false };
      issue(issues, "heartbeat_unsupported", "warning", "server does not expose authenticated executor heartbeat readback");
    }
  } catch (error) {
    result.heartbeat = { supported: null, error: String(error.message).slice(0, 240) };
    issue(issues, "heartbeat_unavailable", "warning", `heartbeat read failed: ${error.message}`);
  }
  return result;
}

export async function inspectExecutor({
  executorDir = process.cwd(), envFile = null, environment = process.env,
  fetchFn = globalThis.fetch, processProbe = defaultProcessProbe,
  runtimeFingerprintFn = executorRuntimeFingerprint, oracleProbe = defaultOracleProbe,
  sleepAssertionProbe = verifyMacSleepAssertion,
  requireSleepAssertion = process.platform === "darwin",
  now = Date.now(),
} = {}) {
  const dir = fs.realpathSync(path.resolve(executorDir));
  const file = path.resolve(envFile || path.join(dir, ".cc-executor.env"));
  // The protected service file is authoritative. Ambient shell variables are a
  // fallback for ad-hoc paper runs, never a way to silently inspect another wallet.
  const cfg = { ...environment, ...readExecutorEnv(file) };
  const resolveAt = (value, fallback) => path.isAbsolute(value || "")
    ? path.resolve(value) : path.resolve(dir, value || fallback);
  const stateDb = resolveAt(cfg.STATE_DB, ".cc-executor.sqlite");
  const lockFile = resolveAt(cfg.LOCK_FILE, `${stateDb}.lock`);
  const pauseFile = resolveAt(cfg.PAUSE_ENTRIES_FILE, `${stateDb}.pause-entries`);
  const hardStopFile = resolveAt(cfg.HARD_STOP_FILE, `${stateDb}.hard-stop`);
  const sleepFaultFile = sleepAssertionFaultPath(lockFile);
  // desk-led-v4: the poller's default poll is 5 s (the feed is the only exit channel).
  const pollMs = positiveInteger(cfg.POLL_MS, 5_000);
  const issues = [];
  const mode = cfg.EXECUTE === "1" ? "live" : "paper";
  const expectedRuntimeCommit = /^[0-9a-f]{40}$/i.test(String(cfg.EXECUTOR_SOURCE_COMMIT || ""))
    ? String(cfg.EXECUTOR_SOURCE_COMMIT).toLowerCase() : null;
  const configuredCap = (name, fallback) => {
    const value = Number(cfg[name] ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const expectedCaps = {
    maxSolPerTrade: configuredCap("MAX_SOL_PER_TRADE", mode === "live" ? 0.005 : 0.05),
    dailySolCap: configuredCap("DAILY_SOL_CAP", mode === "live" ? 0.01 : 0.5),
    dailyLossLimitSol: configuredCap("DAILY_LOSS_LIMIT_SOL", mode === "live" ? 0.01 : 0.15),
    maxOpenPositions: configuredCap("MAX_OPEN_POSITIONS", 24),
  };
  expectedCaps.maxSolPerTradeLamports = Math.floor(expectedCaps.maxSolPerTrade * 1_000_000_000);
  const localRuntimeFingerprint = runtimeFingerprintFn(dir);
  if (mode === "live" && !expectedRuntimeCommit)
    issue(issues, "runtime_commit_unconfigured", "critical",
      "live executor configuration has no exact 40-character source commit");
  if (!localRuntimeFingerprint)
    issue(issues, "runtime_files_incomplete", "critical",
      "the complete trading runtime cannot be fingerprinted from regular local files");

  // The swap API must never author the USD anchor used to judge its own quote.
  // Probe the exact two-RPC Pyth path before certifying a paused live process as
  // ready. Endpoint values and raw transport errors are deliberately never emitted.
  let oracle = { checked: false, ok: mode !== "live" };
  if (mode === "live") {
    if (!cfg.SOLANA_RPC || !cfg.SOLANA_RPC_SECONDARY) {
      oracle = { checked: true, ok: false };
      issue(issues, "sol_usd_oracle_unconfigured", "critical",
        "independent Pyth SOL/USD readiness requires both configured RPC providers");
    } else {
      try {
        const observation = await oracleProbe({
          primaryUrl: cfg.SOLANA_RPC, secondaryUrl: cfg.SOLANA_RPC_SECONDARY, now,
        });
        oracle = {
          checked: true, ok: true, source: observation.source,
          price: Number(observation.price), publishTime: Number(observation.publishTime),
          confidencePct: Number(observation.confidencePct),
          providerDivergencePct: Number(observation.divergencePct),
        };
      } catch {
        oracle = { checked: true, ok: false };
        issue(issues, "sol_usd_oracle_unavailable", "critical",
          "independent two-provider Pyth SOL/USD readiness check failed");
      }
    }
  }

  let pid = null;
  try { pid = Number(fs.readFileSync(lockFile, "utf8").trim()); } catch {}
  const processState = Number.isInteger(pid) && pid > 1
    ? await processProbe(pid, { executorDir: dir })
    : { alive: false, commandMatches: false, cwdMatches: false, identityVerified: false };
  if (!processState.alive) issue(issues, "process_dead", "critical", "executor process lock has no live owner");
  else if (processState.identityVerified !== true)
    issue(issues, "process_identity_unverified", "critical",
      "lock PID is alive but its exact WALL-ST-E command and working directory could not both be verified");
  const supervisor = processState.supervisor === "launchd" ? "launchd"
    : processState.supervisor === "manual" ? "manual" : null;
  if (mode === "live" && supervisor !== "launchd")
    issue(issues, "supervisor_unverified", "critical",
      "live readiness requires the exact LaunchAgent runner topology; a manual poller is diagnostic only");

  const sleepRequired = mode === "live" && requireSleepAssertion;
  let sleepAssertion = { required: sleepRequired, ok: !sleepRequired, assertionPid: null,
    commandBound: null, powerSource: null, acPower: null,
    idleSystemSleep: null, systemSleep: null };
  if (sleepRequired) {
    try {
      const observed = await sleepAssertionProbe({ ownerPid: pid, lockFile });
      sleepAssertion = {
        required: true, ok: observed?.ok === true,
        assertionPid: Number.isInteger(observed?.assertionPid) ? observed.assertionPid : null,
        commandBound: observed?.commandBound === true,
        powerSource: ["ac", "battery"].includes(observed?.powerSource)
          ? observed.powerSource : null,
        acPower: observed?.acPower === true,
        idleSystemSleep: observed?.idleSystemSleep === true,
        systemSleep: observed?.systemSleep === true,
      };
      if (!sleepAssertion.ok)
        issue(issues, "sleep_assertion_missing", "critical",
          "LaunchAgent does not hold a verified AC no-idle/system-sleep assertion");
    } catch {
      issue(issues, "sleep_assertion_missing", "critical",
        "LaunchAgent sleep assertion could not be independently verified");
    }
  }

  const pauseControl = inspectOwnerControlFile(pauseFile, { label: "entry-pause sentinel" });
  const hardStopControl = inspectOwnerControlFile(hardStopFile, { label: "hard-stop sentinel" });
  const sleepFaultControl = inspectOwnerControlFile(sleepFaultFile, {
    label: "sleep assertion fault latch",
  });
  const controls = {
    entriesPaused: pauseControl.present || sleepFaultControl.present,
    entryPauseValid: pauseControl.valid && sleepFaultControl.valid,
    hardStop: hardStopControl.present,
    hardStopValid: hardStopControl.valid,
    sleepAssertionFault: sleepFaultControl.present,
    sleepAssertionFaultValid: sleepFaultControl.valid,
  };
  if (pauseControl.present && !pauseControl.valid)
    issue(issues, "entry_pause_invalid", "critical", pauseControl.reason);
  if (hardStopControl.present && !hardStopControl.valid)
    issue(issues, "hard_stop_invalid", "critical", hardStopControl.reason);
  if (sleepFaultControl.present && !sleepFaultControl.valid)
    issue(issues, "sleep_assertion_fault_invalid", "critical", sleepFaultControl.reason);
  if (sleepFaultControl.present)
    issue(issues, "sleep_assertion_fault_latched", "critical",
      "an automatic entry-pause publication failed; explicit operator repair and review are required");
  if (controls.hardStop) issue(issues, "hard_stop", "critical", "hard-stop file is present; automated exits are blocked");
  const journal = readJournal(stateDb, now, issues);
  if (journal.primed !== true)
    issue(issues, "journal_unprimed", "warning", "executor has not durably primed its feed cursor");
  const feed = await probeFeed({
    api: String(cfg.CC_API || "https://claude-company-api.onrender.com").replace(/\/$/, ""),
    floor: cfg.CC_FLOOR, secret: cfg.CC_SECRET, cursor: journal.cursor,
    pollMs, fetchFn, now, issues, expectedMode: mode, expectedWallet: journal.wallet,
    expectedCursor: journal.cursor, expectedOpen: journal.openPositions,
    expectedEntriesPaused: controls.entriesPaused,
    expectedRuntimeCommit, expectedRuntimeFingerprint: localRuntimeFingerprint, expectedCaps,
  });

  const hasCritical = issues.some((item) => item.severity === "critical");
  const hasWarning = issues.some((item) => item.severity === "warning");
  const status = hasCritical ? "critical" : hasWarning ? "degraded"
    : controls.entriesPaused ? "entries-paused" : "healthy";
  const unpauseReadiness = !controls.entriesPaused ? "not-paused"
    : mode !== "live" ? "not-live"
      : !hasCritical && !hasWarning ? "ready" : "blocked";
  return {
    schemaVersion: 1, observedAt: now, status,
    safeToUnpause: unpauseReadiness === "ready", unpauseReadiness, mode,
    runtime: { commit: expectedRuntimeCommit, fingerprint: localRuntimeFingerprint, pollMs },
    process: { pid, alive: Boolean(processState.alive), supervisor,
      launchdServicePid: Number.isInteger(processState.launchdServicePid)
        ? processState.launchdServicePid : null,
      commandMatches: processState.commandMatches === true,
      cwdMatches: processState.cwdMatches === true,
      identityVerified: processState.identityVerified === true },
    sleepAssertion, controls, journal, feed, oracle, issues,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--executor-dir") options.executorDir = argv[++i];
    else if (argv[i] === "--env-file") options.envFile = argv[++i];
    else if (["--json", "--no-color"].includes(argv[i])) continue;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const report = await inspectExecutor(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "critical" ? 2 : report.status === "degraded" ? 1 : 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, observedAt: Date.now(), status: "critical",
      safeToUnpause: false, issues: [{ code: "monitor_failed", severity: "critical",
        message: String(error.message).slice(0, 500) }] }, null, 2)}\n`);
    process.exitCode = 3;
  }
}
