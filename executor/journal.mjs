/**
 * WALL-ST-E'S DURABLE LEDGER
 *
 * The feed cursor is not an execution guarantee. A process can die after a swap
 * lands but before a JSON file is renamed, and replaying that feed row would spend
 * twice. This SQLite journal makes the signed transaction the durable unit instead:
 * exact bytes + signature are committed with synchronous=FULL before submission.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateEntryPreflightContext } from "./entry-quote-guard.mjs";
import { PYTH_SOL_USD_CACHE_SOURCE } from "./sol-usd-oracle.mjs";

const INTENT_STATES = new Set([
  "planned", "signed", "submitted", "confirmed", "accounted",
  "failed", "expired", "ambiguous",
]);
/* mirror_exit (desk-led-v4, 2026-09-05): the desk's determination evaluated by the bot
 * itself while the desk is unreachable — same levels, same ruler, same code. It is an
 * exit in every rule below: a safety exit for the conflict lock, a realized event for the
 * risk ledger, exempt from trigger re-validation like desk_exit. */
const INTENT_KINDS = new Set(["entry", "risk_exit", "desk_exit", "mirror_exit"]);
export const EXIT_INTENT_KINDS = Object.freeze(["desk_exit", "risk_exit", "mirror_exit"]);
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const LEGACY_CALL_IDENTITY_POLICY = "liquidate-on-next-valid-same-mint-desk-exit";
// Bump only when the rules that authorize construction/disclosure of signed bytes
// change. Recovery compares this durable provenance marker; a null value is an
// explicitly unversioned attempt built before this invariant existed.
export const CURRENT_TX_ATTEMPT_PROTOCOL = "jupiter-dual-rpc-coherent-snapshot-v3";

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, { fallback = null, label = "journal JSON" } = {}) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} is corrupt JSON`); }
};

const record = (value) => value && typeof value === "object" && !Array.isArray(value);

export function requirePositiveCallId(value, label = "call_id") {
  const callId = Number(value);
  if (!Number.isSafeInteger(callId) || callId <= 0)
    throw new Error(`${label} is invalid`);
  return callId;
}

const finiteNumber = (value, label, { min = -Infinity, integer = false } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || (integer && !Number.isInteger(number)))
    throw new Error(`${label} is invalid`);
  return number;
};

export function validateRiskState(value, { now = Date.now() } = {}) {
  if (!record(value)) throw new Error("journal risk_state is invalid");
  const dayStart = finiteNumber(value.dayStart, "journal risk_state dayStart", { min: 0 });
  if (dayStart > Number(now) + 5 * 60_000)
    throw new Error("journal risk_state dayStart is implausibly in the future");
  finiteNumber(value.deployedTodaySol, "journal risk_state deployedTodaySol", { min: 0 });
  finiteNumber(value.realizedTodaySol, "journal risk_state realizedTodaySol");
  finiteNumber(value.openCount, "journal risk_state openCount", { min: 0, integer: true });
  finiteNumber(value.wins, "journal risk_state wins", { min: 0, integer: true });
  finiteNumber(value.losses, "journal risk_state losses", { min: 0, integer: true });
  finiteNumber(value.bookHeat, "journal risk_state bookHeat", { min: 0 });
  for (const key of ["spendableSol", "equitySol"]) {
    if (value[key] != null) finiteNumber(value[key], `journal risk_state ${key}`, { min: 0 });
  }
  return value;
}

const POSITION_BLOCK_FLAGS = [
  ["callIdentityIncomplete", "callIdentityIncompleteReason", "legacy call identity is incomplete"],
  ["accountingIncomplete", "accountingIncompleteReason", "legacy accounting is incomplete"],
  ["balanceReconciliationRequired", "balanceReconciliationReason", "balance reconciliation"],
  ["riskDataUnavailable", "riskDataUnavailableReason", "risk data unavailable"],
  ["exitExecutionRequired", "exitExecutionReason", "required exit unresolved"],
  ["manualExitRequired", "manualExitReason", "manual exit required"],
];

export function positionEntryBlock(value) {
  for (const [field, reasonField, fallback] of POSITION_BLOCK_FLAGS) {
    if (value?.[field] === true) {
      return String(value[reasonField] || fallback);
    }
  }
  return null;
}

/**
 * Route an authenticated desk-exit row to a durable position. New positions match
 * the originating call exactly; mint equality alone is never sufficient. A legacy
 * row whose call identity could not be recovered is already quarantined from new
 * exposure and takes the explicitly persisted risk-reducing fallback: the next
 * valid same-mint desk exit closes it rather than leaving an unidentifiable holding.
 */
export function deskExitDecisionForPosition(position, event) {
  if (!record(position) || typeof position.mint !== "string" || !position.mint)
    throw new Error("desk exit position identity is invalid");
  if (!record(event)) throw new Error("desk exit event is invalid");
  if (String(event.mint || "") !== position.mint)
    return { action: "ignore", reason: "different-mint" };
  const eventCallId = requirePositiveCallId(event.call_id, "desk exit call_id");

  const positionCallId = Number(position.callId);
  if (Number.isSafeInteger(positionCallId) && positionCallId > 0) {
    return positionCallId === eventCallId
      ? { action: "exit", reason: "exact-call", callId: eventCallId }
      : { action: "ignore", reason: "different-call", callId: eventCallId,
          positionCallId };
  }
  if (position.callIdentityIncomplete === true &&
      position.callIdentityPolicy === LEGACY_CALL_IDENTITY_POLICY) {
    return { action: "exit", reason: "legacy-risk-reduction", callId: eventCallId };
  }
  throw new Error(`position ${position.mint} has no durable call identity`);
}

function validatePosition(mint, value) {
  if (!record(value)) throw new Error(`position ${mint} is not an object`);
  if (value.mint !== mint) throw new Error(`position row ${mint} contains mint ${value.mint ?? "missing"}`);
  if (!/^\d+$/.test(String(value.qtyRaw ?? "")) || BigInt(value.qtyRaw) <= 0n)
    throw new Error(`position ${mint} has invalid qtyRaw`);
  if (!Number.isFinite(Number(value.paidSol)) || Number(value.paidSol) <= 0)
    throw new Error(`position ${mint} has invalid paidSol`);
  if (!/^\d+$/.test(String(value.costBasisLamports ?? "")) || BigInt(value.costBasisLamports) <= 0n)
    throw new Error(`position ${mint} has invalid costBasisLamports`);
  if (Math.abs(Number(value.paidSol) - Number(BigInt(value.costBasisLamports)) / 1_000_000_000) > 1e-12)
    throw new Error(`position ${mint} paidSol disagrees with exact cost basis`);
  if (!/^\d+$/.test(String(value.entryInputLamports ?? "")) || BigInt(value.entryInputLamports) <= 0n)
    throw new Error(`position ${mint} has invalid entryInputLamports`);
  if (!Number.isFinite(Number(value.solUsdAtEntry)) || Number(value.solUsdAtEntry) <= 0)
    throw new Error(`position ${mint} has invalid solUsdAtEntry`);
  if (value.solUsdSource !== PYTH_SOL_USD_CACHE_SOURCE && value.accountingIncomplete !== true)
    throw new Error(`position ${mint} has no independent SOL/USD entry source`);
  if (typeof value.entryIntentId !== "string" || !value.entryIntentId)
    throw new Error(`position ${mint} has no durable entryIntentId`);
  const callId = Number(value.callId);
  const hasExactCallId = Number.isSafeInteger(callId) && callId > 0;
  const hasLegacyFallback = value.callIdentityIncomplete === true;
  if (hasExactCallId && hasLegacyFallback)
    throw new Error(`position ${mint} has conflicting call identity state`);
  if (value.callId != null && !hasExactCallId)
    throw new Error(`position ${mint} has invalid callId`);
  if (!hasExactCallId && !hasLegacyFallback)
    throw new Error(`position ${mint} has no durable callId`);
  if (hasLegacyFallback) {
    if (value.callIdentityPolicy !== LEGACY_CALL_IDENTITY_POLICY)
      throw new Error(`position ${mint} has no valid legacy call identity policy`);
    if (typeof value.callIdentityIncompleteReason !== "string" ||
        !value.callIdentityIncompleteReason.trim())
      throw new Error(`position ${mint} has no legacy call identity reason`);
  }
  if (!Number.isFinite(Number(value.openedAtMs)) || Number(value.openedAtMs) <= 0)
    throw new Error(`position ${mint} has invalid openedAtMs`);
  for (const key of ["entry", "stop", "takeProfitX"]) {
    if (!Number.isFinite(Number(value[key])) || Number(value[key]) <= 0)
      throw new Error(`position ${mint} has invalid ${key}`);
  }
  if (typeof value.honorDeskTarget !== "boolean")
    throw new Error(`position ${mint} has no immutable target rule`);
  if (!Number.isFinite(Number(value.riskF)) || Number(value.riskF) < 0)
    throw new Error(`position ${mint} has invalid riskF`);
  for (const [field] of POSITION_BLOCK_FLAGS) {
    if (value[field] != null && typeof value[field] !== "boolean")
      throw new Error(`position ${mint} has invalid ${field}`);
  }
  return value;
}

function ensurePrivateFile(file) {
  try { fs.chmodSync(file, 0o600); } catch {}
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`journal is not a regular file: ${file}`);
  if ((st.mode & 0o077) !== 0) throw new Error(`journal permissions must be 0600: ${file}`);
}

export class ExecutionJournal {
  constructor(file, { wallet, create = true, now = () => Date.now() } = {}) {
    if (!file) throw new Error("STATE_DB is required");
    if (!wallet) throw new Error("wallet is required to bind the journal");
    this.file = path.resolve(file);
    this.wallet = String(wallet);
    this.now = now;
    const existed = fs.existsSync(this.file);
    if (!existed && !create) throw new Error(`live journal does not exist: ${this.file}`);
    if (!existed) fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS positions (
        mint TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        event_id TEXT,
        feed_id INTEGER,
        mint TEXT NOT NULL,
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        amount_raw TEXT NOT NULL,
        state TEXT NOT NULL,
        context TEXT NOT NULL,
        actual_input_raw TEXT,
        actual_output_raw TEXT,
        network_fee_lamports TEXT,
        signature TEXT,
        error TEXT,
        confirmed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_event ON intents(event_id) WHERE event_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS deferred_desk_exits (
        entry_intent_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL UNIQUE,
        feed_id INTEGER NOT NULL,
        call_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        reason TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tx_attempts (
        intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE RESTRICT,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        request_id TEXT NOT NULL,
        signed_tx BLOB NOT NULL,
        signature TEXT NOT NULL UNIQUE,
        blockhash TEXT NOT NULL,
        last_valid_block_height INTEGER NOT NULL,
        quoted_output_raw TEXT NOT NULL,
        min_output_raw TEXT NOT NULL,
        order_json TEXT NOT NULL,
        protocol TEXT,
        execute_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(intent_id, attempt)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_attempts_state ON tx_attempts(state);
      CREATE TABLE IF NOT EXISTS risk_events (
        intent_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('deployment','realized')),
        deployed_lamports INTEGER NOT NULL,
        realized_lamports INTEGER NOT NULL,
        network_fee_lamports INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_risk_events_time ON risk_events(occurred_at);
      CREATE TABLE IF NOT EXISTS attempt_fee_events (
        intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE RESTRICT,
        attempt INTEGER NOT NULL,
        network_fee_lamports INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY(intent_id,attempt)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_attempt_fee_events_time ON attempt_fee_events(occurred_at);
    `);
    const intentColumns = new Set(this.db.prepare("PRAGMA table_info(intents)").all().map((column) => column.name));
    if (!intentColumns.has("network_fee_lamports"))
      this.db.exec("ALTER TABLE intents ADD COLUMN network_fee_lamports TEXT");
    if (!intentColumns.has("confirmed_at"))
      this.db.exec("ALTER TABLE intents ADD COLUMN confirmed_at INTEGER");
    const attemptColumns = new Set(this.db.prepare("PRAGMA table_info(tx_attempts)").all()
      .map((column) => column.name));
    if (!attemptColumns.has("protocol"))
      // SQLite fills the new nullable column with NULL for every pre-invariant row.
      // Never backfill CURRENT_TX_ATTEMPT_PROTOCOL onto bytes this build did not make.
      this.db.exec("ALTER TABLE tx_attempts ADD COLUMN protocol TEXT");
    ensurePrivateFile(this.file);
    try {
      this.legacyPositionMigrated = this._migrateLegacyPositions();
      this._validateDurableJson();
      this._bindWallet();
      if (this.getMeta("cursor") == null) this.setMeta("cursor", 0);
      if (this.getMeta("primed") == null) this.setMeta("primed", false);
      if (!this.db.prepare("SELECT 1 FROM meta WHERE key='risk_state'").get())
        this.setMeta("risk_state", null);
      this._initializeRiskHistoryGuard(existed);
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
    this.existed = existed;
  }

  _validateDurableJson() {
    for (const row of this.db.prepare("SELECT key,value FROM meta").all()) {
      const value = parse(row.value, { label: `journal meta ${row.key}` });
      if (row.key === "wallet" && (typeof value !== "string" || !value))
        throw new Error("journal wallet binding is invalid");
      if (row.key === "cursor" && (!Number.isSafeInteger(value) || value < 0))
        throw new Error("journal cursor is invalid");
      if (row.key === "primed" && typeof value !== "boolean")
        throw new Error("journal primed flag is invalid");
      if (row.key === "risk_state" && value !== null)
        validateRiskState(value, { now: this.now() });
      if (row.key === "risk_history_incomplete_until" &&
          (!Number.isSafeInteger(value) || value < 0))
        throw new Error("journal risk-history quarantine is invalid");
      if (row.key === "risk_history_incomplete_first_seen_at" &&
          (!Number.isSafeInteger(value) || value < 0))
        throw new Error("journal risk-history first-seen marker is invalid");
    }
    for (const row of this.db.prepare("SELECT mint,data FROM positions").all())
      validatePosition(row.mint, parse(row.data, { label: `position ${row.mint}` }));
    for (const row of this.db.prepare("SELECT id,context FROM intents").all()) {
      if (!record(parse(row.context, { label: `intent ${row.id} context` })))
        throw new Error(`intent ${row.id} context is not an object`);
    }
    for (const row of this.db.prepare("SELECT intent_id,attempt,order_json,execute_json FROM tx_attempts").all()) {
      if (!record(parse(row.order_json, { label: `attempt ${row.intent_id}/${row.attempt} order` })))
        throw new Error(`attempt ${row.intent_id}/${row.attempt} order is not an object`);
      const execute = parse(row.execute_json, { label: `attempt ${row.intent_id}/${row.attempt} execute` });
      if (execute !== null && !record(execute))
        throw new Error(`attempt ${row.intent_id}/${row.attempt} execute is not an object`);
    }
  }

  _migrateLegacyPositions() {
    let changed = false;
    const update = this.db.prepare("UPDATE positions SET data=?,updated_at=? WHERE mint=?");
    const entryIntent = this.db.prepare("SELECT kind,mint,context FROM intents WHERE id=?");
    for (const row of this.db.prepare("SELECT mint,data FROM positions").all()) {
      const value = parse(row.data, { label: `position ${row.mint}` });
      if (!record(value)) continue;
      let rowChanged = false;
      const missing = value.costBasisLamports == null || value.entryInputLamports == null ||
        value.solUsdAtEntry == null;
      if (missing) {
        const paidLamports = Math.round(Number(value.paidSol) * 1_000_000_000);
        if (Number.isSafeInteger(paidLamports) && paidLamports > 0) {
          value.costBasisLamports ||= String(paidLamports);
          value.entryInputLamports ||= String(paidLamports);
          value.solUsdAtEntry ||= 1;
          value.accountingIncomplete = true;
          value.accountingIncompleteReason = "pre-ledger position has unknown finalized fees/SOL-USD basis; reconcile manually";
          rowChanged = true;
        }
      }

      // Before the independent-oracle release, positions stored a Jupiter-derived
      // SOL/USDC denominator. It must never silently become the basis for Pyth-priced
      // stops after an upgrade. Recover provenance only from the exact durable entry
      // context; otherwise quarantine automatic price accounting for reconciliation.
      {
        const intent = typeof value.entryIntentId === "string"
          ? entryIntent.get(value.entryIntentId) : null;
        const context = intent ? parse(intent.context,
          { label: `intent ${value.entryIntentId} context` }) : null;
        const contextSolUsd = Number(context?.entryPreflight?.solUsd);
        const sameBasis = Number.isFinite(contextSolUsd) && contextSolUsd > 0 &&
          Math.abs(contextSolUsd - Number(value.solUsdAtEntry)) <=
            Math.max(1e-12, Math.abs(contextSolUsd) * 1e-12);
        let independentlyVerified = false;
        if (intent?.kind === "entry" && intent.mint === row.mint && sameBasis) {
          try {
            validateEntryPreflightContext({ ...intent, context }, {
              nowMs: Number(context?.entryPreflight?.observedAt) || this.now(),
              maxEntryPreflightAgeMs: 60_000,
              requireFresh: false,
            });
            independentlyVerified = true;
          } catch {}
        }
        if (independentlyVerified) {
          if (value.solUsdSource !== PYTH_SOL_USD_CACHE_SOURCE) {
            value.solUsdSource = PYTH_SOL_USD_CACHE_SOURCE;
            rowChanged = true;
          }
        } else {
          if (value.solUsdSource !== "legacy-unverified") {
            value.solUsdSource = "legacy-unverified";
            rowChanged = true;
          }
          if (value.accountingIncomplete !== true ||
              !String(value.accountingIncompleteReason || "").includes("no provable independent SOL/USD")) {
            value.accountingIncomplete = true;
            value.accountingIncompleteReason =
              "legacy position has no provable independent SOL/USD entry basis; reconcile manually";
            rowChanged = true;
          }
        }
      }

      // Old position JSON did not persist call_id. Recover it only when the exact
      // durable entry intent proves kind, mint, event mint and a positive call_id.
      // Otherwise persist a visible quarantine and the risk-reducing legacy policy.
      if (value.callId == null) {
        const intent = typeof value.entryIntentId === "string"
          ? entryIntent.get(value.entryIntentId) : null;
        const context = intent ? parse(intent.context,
          { label: `intent ${value.entryIntentId} context` }) : null;
        const recoveredCallId = Number(context?.event?.call_id);
        const recoverable = intent?.kind === "entry" && intent.mint === row.mint &&
          String(context?.event?.mint || "") === row.mint &&
          Number.isSafeInteger(recoveredCallId) && recoveredCallId > 0;
        if (recoverable) {
          value.callId = recoveredCallId;
          delete value.callIdentityIncomplete;
          delete value.callIdentityIncompleteReason;
          delete value.callIdentityPolicy;
        } else {
          value.callIdentityIncomplete = true;
          value.callIdentityIncompleteReason =
            "legacy position has no provable originating call_id; new entries remain blocked until it closes";
          value.callIdentityPolicy = LEGACY_CALL_IDENTITY_POLICY;
        }
        rowChanged = true;
      }
      if (rowChanged) {
        update.run(json(value), this.now(), row.mint);
        changed = true;
      }
    }
    return changed;
  }

  _initializeRiskHistoryGuard(existed) {
    if (!existed) return;
    const legacyAccounted = this.db.prepare(`SELECT COUNT(*) n FROM intents i
      LEFT JOIN risk_events r ON r.intent_id=i.id
      WHERE i.state='accounted' AND r.intent_id IS NULL`).get().n;
    const legacyConfirmed = this.db.prepare(`SELECT COUNT(*) n FROM intents
      WHERE state='confirmed' AND network_fee_lamports IS NULL`).get().n;
    const state = this.getMeta("risk_state");
    const eventCount = this.db.prepare("SELECT COUNT(*) n FROM risk_events").get().n +
      this.db.prepare("SELECT COUNT(*) n FROM attempt_fee_events").get().n;
    const legacyCounters = eventCount === 0 && state &&
      (Number(state.deployedTodaySol) !== 0 || Number(state.realizedTodaySol) !== 0);
    if (!legacyAccounted && !legacyConfirmed && !legacyCounters && !this.legacyPositionMigrated) return;
    const existingUntil = Number(this.getMeta("risk_history_incomplete_until") || 0);
    let firstSeen = Number(this.getMeta("risk_history_incomplete_first_seen_at") || 0);
    // Older releases persisted only the deadline. Recover its original anchor rather
    // than treating this upgrade/reopen as a new discovery and extending quarantine.
    if (!Number.isSafeInteger(firstSeen) || firstSeen <= 0) {
      firstSeen = Number.isSafeInteger(existingUntil) && existingUntil > 0
        ? Math.max(1, existingUntil - 24 * 60 * 60_000)
        : Math.max(1, Math.floor(this.now()));
      this.setMeta("risk_history_incomplete_first_seen_at", firstSeen);
    }
    if (!Number.isSafeInteger(existingUntil) || existingUntil <= 0)
      this.setMeta("risk_history_incomplete_until", firstSeen + 24 * 60 * 60_000);
  }

  _bindWallet() {
    const bound = this.getMeta("wallet");
    if (bound && bound !== this.wallet)
      throw new Error(`journal belongs to wallet ${bound}, not ${this.wallet}`);
    if (!bound) this.setMeta("wallet", this.wallet);
  }

  close() { this.db.close(); }

  immediate(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? parse(row.value, { label: `journal meta ${key}` }) : null;
  }

  setMeta(key, value) {
    if (key === "risk_state" && value !== null) validateRiskState(value, { now: this.now() });
    if (key === "cursor" && (!Number.isSafeInteger(Number(value)) || Number(value) < 0))
      throw new Error("journal cursor is invalid");
    if (key === "primed" && typeof value !== "boolean") throw new Error("journal primed flag is invalid");
    this.db.prepare(`INSERT INTO meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, json(value));
  }

  rollingRisk(now = this.now(), windowMs = 24 * 60 * 60_000) {
    const end = finiteNumber(now, "risk window clock", { min: 0 });
    const window = finiteNumber(windowMs, "risk window", { min: 1 });
    let deployed = 0n;
    let realized = 0n;
    // Deliberately no upper bound: if the local clock moves backwards, future-dated
    // durable events remain counted rather than reopening risk capacity.
    for (const row of this.db.prepare(`SELECT deployed_lamports,realized_lamports
      FROM risk_events WHERE occurred_at>?`).all(Math.floor(end - window))) {
      deployed += BigInt(row.deployed_lamports);
      realized += BigInt(row.realized_lamports);
    }
    for (const row of this.db.prepare(`SELECT network_fee_lamports
      FROM attempt_fee_events WHERE occurred_at>?`).all(Math.floor(end - window))) {
      const fee = BigInt(row.network_fee_lamports);
      deployed += fee;
      realized -= fee;
    }
    return {
      deployedTodaySol: Number(deployed) / 1_000_000_000,
      realizedTodaySol: Number(realized) / 1_000_000_000,
      riskWindowAsOf: end,
      riskWindowMs: window,
    };
  }

  riskHistoryStatus(now = this.now()) {
    const until = Number(this.getMeta("risk_history_incomplete_until") || 0);
    return { complete: !(until > Number(now)), incompleteUntil: until || null };
  }

  snapshot() {
    const positions = {};
    for (const row of this.db.prepare("SELECT mint,data FROM positions").all()) {
      positions[row.mint] = validatePosition(row.mint,
        parse(row.data, { label: `position ${row.mint}` }));
    }
    return {
      cursor: Number(this.getMeta("cursor") || 0),
      primed: Boolean(this.getMeta("primed")),
      state: this.getMeta("risk_state"),
      positions,
    };
  }

  saveRuntime({ cursor, primed, state, positions }) {
    if (cursor != null && (!Number.isSafeInteger(Number(cursor)) || Number(cursor) < 0))
      throw new Error("journal cursor is invalid");
    if (primed != null && typeof primed !== "boolean") throw new Error("journal primed flag is invalid");
    if (state !== undefined) validateRiskState(state, { now: this.now() });
    if (positions) for (const [mint, value] of Object.entries(positions)) validatePosition(mint, value);
    this.immediate(() => {
      if (cursor != null) this.setMeta("cursor", Number(cursor));
      if (primed != null) this.setMeta("primed", Boolean(primed));
      if (state !== undefined) this.setMeta("risk_state", state);
      if (positions) {
        const now = this.now();
        const keep = new Set(Object.keys(positions));
        const upsert = this.db.prepare(`INSERT INTO positions(mint,data,updated_at) VALUES(?,?,?)
          ON CONFLICT(mint) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`);
        for (const [mint, value] of Object.entries(positions)) upsert.run(mint, json(value), now);
        for (const row of this.db.prepare("SELECT mint FROM positions").all()) {
          if (!keep.has(row.mint)) this.db.prepare("DELETE FROM positions WHERE mint=?").run(row.mint);
        }
      }
    });
  }

  ensureIntent(spec) {
    for (const key of ["id", "kind", "mint", "inputMint", "outputMint", "amountRaw"])
      if (spec[key] == null || spec[key] === "") throw new Error(`intent ${key} is required`);
    if (!INTENT_KINDS.has(String(spec.kind)))
      throw new Error(`unsupported intent kind ${spec.kind}`);
    const amountRaw = String(spec.amountRaw);
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) throw new Error("intent amountRaw must be positive");
    const existing = this.getIntent(spec.id);
    if (existing) {
      const immutable = {
        kind: spec.kind, mint: spec.mint, inputMint: spec.inputMint,
        outputMint: spec.outputMint, amountRaw,
      };
      for (const [key, expected] of Object.entries(immutable)) {
        if (String(existing[key]) !== String(expected))
          throw new Error(`intent ${spec.id} changed ${key}; refusing replay`);
      }
      // Context is a pre-sign recovery snapshot, not an immutable decision record.
      // A build may fail before bytes exist; refresh it on the next planned/failed/
      // expired attempt so later accounting cannot restore an older book snapshot.
      if (["planned", "failed", "expired"].includes(existing.state)) {
        const context = spec.context || {};
        if (!record(context)) throw new Error(`intent ${spec.id} context is not an object`);
        this.db.prepare("UPDATE intents SET context=?,updated_at=? WHERE id=?")
          .run(json(context), this.now(), spec.id);
        return this.getIntent(spec.id);
      }
      return existing;
    }
    const now = this.now();
    this.db.prepare(`INSERT INTO intents
      (id,kind,event_id,feed_id,mint,input_mint,output_mint,amount_raw,state,context,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        spec.id, spec.kind, spec.eventId ?? null,
        Number.isFinite(Number(spec.feedId)) ? Number(spec.feedId) : null,
        spec.mint, spec.inputMint, spec.outputMint, amountRaw, "planned",
        json(spec.context || {}), now, now,
      );
    return this.getIntent(spec.id);
  }

  _intent(row) {
    if (!row) return null;
    return {
      id: row.id, kind: row.kind, eventId: row.event_id, feedId: row.feed_id,
      mint: row.mint, inputMint: row.input_mint, outputMint: row.output_mint,
      amountRaw: row.amount_raw, state: row.state,
      context: parse(row.context, { fallback: {}, label: `intent ${row.id} context` }),
      actualInputRaw: row.actual_input_raw, actualOutputRaw: row.actual_output_raw,
      networkFeeLamports: row.network_fee_lamports,
      signature: row.signature, error: row.error, confirmedAt: row.confirmed_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  getIntent(id) { return this._intent(this.db.prepare("SELECT * FROM intents WHERE id=?").get(id)); }

  pendingIntents() {
    return this.db.prepare(`SELECT * FROM intents
      WHERE state IN ('signed','submitted','confirmed','ambiguous') ORDER BY created_at,id`)
      .all().map((row) => this._intent(row));
  }

  /**
   * Every ACCOUNTED intent confirmed within the window, oldest first, with the call it
   * belongs to (entry: context.event.call_id; exit: context.position.callId) and the
   * fill facts the desk's /executor/fill route wants. Boot rebuilds the fill-report
   * queue from this: a position is deleted at exit accounting, so a queue rebuilt from
   * S.positions (the take-flag queue) could never re-report an exit that failed to
   * post — which is exactly how the desk never learned the bot sold Shrek (call 55).
   * Intents with no provable callId are skipped: the desk cannot key a fill it cannot
   * attribute, and legacy quarantined positions are never fill-reported either.
   */
  accountedIntentsWithCallId({ sinceMs, now = this.now() } = {}) {
    const floor = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : Number(now) - 7 * 24 * 3600e3;
    const rows = this.db.prepare(`SELECT * FROM intents
      WHERE state='accounted' AND COALESCE(confirmed_at, updated_at) >= ?
      ORDER BY COALESCE(confirmed_at, updated_at), id`).all(floor);
    const out = [];
    for (const row of rows) {
      let intent;
      try { intent = this._intent(row); } catch { continue; }
      const callId = intent.kind === "entry"
        ? Number(intent.context?.event?.call_id)
        : Number(intent.context?.position?.callId);
      if (!Number.isSafeInteger(callId) || callId <= 0) continue;
      out.push({ ...intent, callId });
    }
    return out;
  }

  hasBlockingIntent(exceptId = null) {
    const row = this.db.prepare(`SELECT id FROM intents
      WHERE state IN ('signed','submitted','confirmed','ambiguous') AND (? IS NULL OR id<>?) LIMIT 1`)
      .get(exceptId, exceptId);
    return row?.id || null;
  }

  /**
   * Return the unresolved intent that conflicts with a candidate submission.
   *
   * New exposure remains globally serialized: an entry may not pass while any
   * signed/submitted/confirmed/ambiguous intent still needs reconciliation or
   * accounting. Risk-reducing exits are narrower. They may proceed around an
   * unrelated position, but never around another unresolved operation for the
   * same mint. Unknown intent kinds intentionally receive the stricter entry
   * policy instead of being allowed to masquerade as safety exits.
   */
  hasConflictingIntent(candidate, exceptId = candidate?.id ?? null) {
    if (!record(candidate)) throw new Error("candidate intent is invalid");
    const kind = String(candidate.kind || "");
    const mint = String(candidate.mint || "");
    if (!kind || !mint) throw new Error("candidate intent kind and mint are required");
    // Kind alone is not authority to bypass the global exposure lock. The route
    // and immutable position snapshot must prove this is actually reducing the
    // named position into wrapped SOL.
    const isSafetyExit = EXIT_INTENT_KINDS.includes(kind) &&
      String(candidate.inputMint || "") === mint &&
      String(candidate.outputMint || "") === WRAPPED_SOL_MINT &&
      String(candidate.context?.position?.mint || "") === mint;
    const row = this.db.prepare(`SELECT id FROM intents
      WHERE state IN ('signed','submitted','confirmed','ambiguous')
        AND (? IS NULL OR id<>?)
        AND (?=0 OR mint=? OR kind NOT IN ('entry','risk_exit','desk_exit','mirror_exit'))
      ORDER BY created_at,id LIMIT 1`)
      .get(exceptId, exceptId, isSafetyExit ? 1 : 0, mint);
    return row?.id || null;
  }

  /** Locate the exact unresolved buy that a later desk exit belongs to. */
  blockingEntryForDeskExit({ mint, callId }) {
    const expectedMint = String(mint || "");
    if (!expectedMint) throw new Error("desk exit mint is required");
    const expectedCallId = requirePositiveCallId(callId, "desk exit call_id");
    const rows = this.db.prepare(`SELECT * FROM intents
      WHERE kind='entry' AND mint=?
        AND state IN ('signed','submitted','confirmed','ambiguous')
      ORDER BY created_at,id`).all(expectedMint);
    for (const row of rows) {
      const intent = this._intent(row);
      if (Number(intent.context?.event?.call_id) === expectedCallId) return intent;
    }
    return null;
  }

  /**
   * Persist an exit that arrived after a buy was disclosed but before its position
   * could be accounted. The feed cursor may then advance without losing the exit.
   */
  deferDeskExitForEntry({ entryIntentId, eventId, feedId, callId, mint, reason,
    observedAt = this.now() }) {
    const entry = this.getIntent(entryIntentId);
    if (!entry || entry.kind !== "entry" ||
        !["signed", "submitted", "confirmed", "ambiguous"].includes(entry.state))
      throw new Error("deferred desk exit requires an unresolved entry intent");
    const values = {
      entryIntentId: String(entryIntentId), eventId: String(eventId || ""),
      feedId: Number(feedId), callId: Number(callId), mint: String(mint || ""),
      reason: String(reason || "desk exit"), observedAt: Number(observedAt),
    };
    if (!values.eventId || !Number.isSafeInteger(values.feedId) || values.feedId <= 0 ||
        !Number.isSafeInteger(values.callId) || values.callId <= 0 ||
        !values.mint || values.mint !== entry.mint ||
        Number(entry.context?.event?.call_id) !== values.callId ||
        !Number.isSafeInteger(values.observedAt) || values.observedAt <= 0)
      throw new Error("deferred desk exit does not match its entry/call context");
    const existing = this.deferredDeskExitForEntry(values.entryIntentId);
    if (existing) {
      for (const key of ["eventId", "feedId", "callId", "mint", "reason"]) {
        if (String(existing[key]) !== String(values[key]))
          throw new Error(`deferred desk exit changed ${key}; refusing replay`);
      }
      return existing;
    }
    this.db.prepare(`INSERT INTO deferred_desk_exits
      (entry_intent_id,event_id,feed_id,call_id,mint,reason,observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(values.entryIntentId, values.eventId, values.feedId,
        values.callId, values.mint, values.reason, values.observedAt);
    return this.deferredDeskExitForEntry(values.entryIntentId);
  }

  deferredDeskExitForEntry(entryIntentId) {
    const row = this.db.prepare("SELECT * FROM deferred_desk_exits WHERE entry_intent_id=?")
      .get(String(entryIntentId));
    return row ? {
      entryIntentId: row.entry_intent_id, eventId: row.event_id, feedId: row.feed_id,
      callId: row.call_id, mint: row.mint, reason: row.reason, observedAt: row.observed_at,
    } : null;
  }

  attempts(id) {
    return this.db.prepare("SELECT * FROM tx_attempts WHERE intent_id=? ORDER BY attempt").all(id)
      .map((row) => this._attempt(row));
  }

  latestAttempt(id) {
    return this._attempt(this.db.prepare(
      "SELECT * FROM tx_attempts WHERE intent_id=? ORDER BY attempt DESC LIMIT 1").get(id));
  }

  _attempt(row) {
    if (!row) return null;
    return {
      intentId: row.intent_id, attempt: row.attempt, state: row.state,
      requestId: row.request_id, signedTx: Buffer.from(row.signed_tx), signature: row.signature,
      blockhash: row.blockhash, lastValidBlockHeight: row.last_valid_block_height,
      quotedOutputRaw: row.quoted_output_raw, minOutputRaw: row.min_output_raw,
      protocol: row.protocol ?? null,
      order: parse(row.order_json, { fallback: {}, label: `attempt ${row.intent_id}/${row.attempt} order` }),
      execute: parse(row.execute_json, { label: `attempt ${row.intent_id}/${row.attempt} execute` }), error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  recordSigned(id, attempt) {
    const intent = this.getIntent(id);
    if (!intent) throw new Error(`unknown intent ${id}`);
    if (!["planned", "failed", "expired"].includes(intent.state))
      throw new Error(`intent ${id} is ${intent.state}; cannot attach a fresh signature`);
    const n = Number(attempt.attempt);
    if (!Number.isInteger(n) || n < 1) throw new Error("attempt must be a positive integer");
    const now = this.now();
    this.immediate(() => {
      this.db.prepare(`INSERT INTO tx_attempts
        (intent_id,attempt,state,request_id,signed_tx,signature,blockhash,last_valid_block_height,
         quoted_output_raw,min_output_raw,order_json,protocol,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, n, "signed", attempt.requestId, Buffer.from(attempt.signedTx), attempt.signature,
          attempt.blockhash, Number(attempt.lastValidBlockHeight), String(attempt.quotedOutputRaw),
          String(attempt.minOutputRaw), json(attempt.order), CURRENT_TX_ATTEMPT_PROTOCOL, now, now,
        );
      this.db.prepare("UPDATE intents SET state='signed',signature=?,error=NULL,updated_at=? WHERE id=?")
        .run(attempt.signature, now, id);
    });
    return this.latestAttempt(id);
  }

  markSubmitted(id, attemptNo) { this._setAttemptState(id, attemptNo, "submitted"); }

  recordExecuteResponse(id, attemptNo, execute) {
    const now = this.now();
    this.db.prepare(`UPDATE tx_attempts SET execute_json=?,updated_at=?
      WHERE intent_id=? AND attempt=?`).run(json(execute), now, id, attemptNo);
  }

  _setAttemptState(id, attemptNo, state, error = null, execute = undefined) {
    if (!INTENT_STATES.has(state)) throw new Error(`invalid intent state ${state}`);
    const now = this.now();
    this.immediate(() => {
      this.db.prepare(`UPDATE tx_attempts SET state=?,error=?,execute_json=COALESCE(?,execute_json),updated_at=?
        WHERE intent_id=? AND attempt=?`).run(state, error, execute === undefined ? null : json(execute), now, id, attemptNo);
      this.db.prepare("UPDATE intents SET state=?,error=?,updated_at=? WHERE id=?")
        .run(state, error, now, id);
    });
  }

  markFailed(id, attemptNo, error, execute) { this._setAttemptState(id, attemptNo, "failed", error, execute); }
  markFinalizedFailure(id, attemptNo, error, feeEvidence, execute) {
    const fee = Number(feeEvidence?.networkFeeLamports);
    const occurredAt = Number(feeEvidence?.finalizedAtMs || this.now());
    if (!Number.isSafeInteger(fee) || fee < 0) throw new Error("finalized failure fee is invalid");
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error("finalized failure time is invalid");
    const now = this.now();
    this.immediate(() => {
      const attempt = this.db.prepare("SELECT signature FROM tx_attempts WHERE intent_id=? AND attempt=?")
        .get(id, attemptNo);
      if (!attempt) throw new Error(`unknown attempt ${id}/${attemptNo}`);
      this.db.prepare(`INSERT INTO attempt_fee_events
        (intent_id,attempt,network_fee_lamports,occurred_at) VALUES(?,?,?,?)`)
        .run(id, attemptNo, fee, occurredAt);
      this.db.prepare(`UPDATE tx_attempts SET state='failed',error=?,execute_json=COALESCE(?,execute_json),updated_at=?
        WHERE intent_id=? AND attempt=?`).run(error, execute === undefined ? null : json(execute), now, id, attemptNo);
      this.db.prepare("UPDATE intents SET state='failed',error=?,updated_at=? WHERE id=?")
        .run(error, now, id);
    });
  }
  markExpired(id, attemptNo, error) { this._setAttemptState(id, attemptNo, "expired", error); }
  markAmbiguous(id, attemptNo, error, execute) { this._setAttemptState(id, attemptNo, "ambiguous", error, execute); }

  markConfirmed(id, attemptNo, fill, execute) {
    const input = String(fill.totalInputAmount);
    const output = String(fill.totalOutputAmount);
    if (!/^\d+$/.test(input) || !/^\d+$/.test(output) || BigInt(input) <= 0n || BigInt(output) <= 0n)
      throw new Error("confirmed fill amounts must be positive integers");
    const fee = String(fill.networkFeeLamports ?? "");
    if (!/^\d+$/.test(fee)) throw new Error("confirmed network fee must be a non-negative integer");
    const now = this.now();
    const suppliedConfirmedAt = Number(fill.finalizedAtMs);
    const confirmedAt = Number.isSafeInteger(suppliedConfirmedAt) && suppliedConfirmedAt > 0 &&
      suppliedConfirmedAt <= now + 5 * 60_000 ? suppliedConfirmedAt : now;
    this.immediate(() => {
      this.db.prepare(`UPDATE tx_attempts SET state='confirmed',execute_json=?,error=NULL,updated_at=?
        WHERE intent_id=? AND attempt=?`).run(json(execute), now, id, attemptNo);
      this.db.prepare(`UPDATE intents SET state='confirmed',actual_input_raw=?,actual_output_raw=?,
        network_fee_lamports=?,signature=?,error=NULL,confirmed_at=?,updated_at=? WHERE id=?`)
        .run(input, output, fee, fill.signature, confirmedAt, now, id);
    });
    return this.getIntent(id);
  }

  markAccounted(id, runtime, { consumeDeferredDeskExit = false } = {}) {
    const intent = this.getIntent(id);
    if (!intent) throw new Error(`unknown intent ${id}`);
    if (intent.state === "accounted") return intent;
    if (intent.state !== "confirmed") throw new Error(`intent ${id} is ${intent.state}, not confirmed`);
    validateRiskState(runtime.state, { now: this.now() });
    for (const [mint, value] of Object.entries(runtime.positions || {})) validatePosition(mint, value);
    const riskEvent = this._riskEvent(intent);
    this.immediate(() => {
      const now = this.now();
      this.db.prepare("UPDATE intents SET state='accounted',updated_at=? WHERE id=?").run(now, id);
      this.db.prepare(`INSERT INTO risk_events
        (intent_id,kind,deployed_lamports,realized_lamports,network_fee_lamports,occurred_at)
        VALUES(?,?,?,?,?,?)`).run(id, riskEvent.kind, riskEvent.deployedLamports,
          riskEvent.realizedLamports, riskEvent.networkFeeLamports, riskEvent.occurredAt);
      Object.assign(runtime.state, this.rollingRisk(now));
      if (runtime.cursor != null) this.setMeta("cursor", Number(runtime.cursor));
      if (runtime.primed != null) this.setMeta("primed", Boolean(runtime.primed));
      this.setMeta("risk_state", runtime.state);
      const keep = new Set(Object.keys(runtime.positions || {}));
      const upsert = this.db.prepare(`INSERT INTO positions(mint,data,updated_at) VALUES(?,?,?)
        ON CONFLICT(mint) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`);
      for (const [mint, value] of Object.entries(runtime.positions || {})) upsert.run(mint, json(value), now);
      for (const row of this.db.prepare("SELECT mint FROM positions").all()) {
        if (!keep.has(row.mint)) this.db.prepare("DELETE FROM positions WHERE mint=?").run(row.mint);
      }
      if (consumeDeferredDeskExit) {
        const removed = this.db.prepare("DELETE FROM deferred_desk_exits WHERE entry_intent_id=?").run(id);
        if (Number(removed.changes) !== 1)
          throw new Error(`deferred desk exit for ${id} disappeared before accounting`);
      }
    });
    return this.getIntent(id);
  }

  _riskEvent(intent) {
    const input = BigInt(String(intent.actualInputRaw));
    const output = BigInt(String(intent.actualOutputRaw));
    const fee = BigInt(String(intent.networkFeeLamports));
    const occurredAt = Number(intent.confirmedAt || intent.updatedAt || this.now());
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error(`intent ${intent.id} has invalid confirmation time`);
    if (fee > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`intent ${intent.id} network fee is too large`);
    if (intent.kind === "entry") {
      const deployed = input + fee;
      if (deployed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`intent ${intent.id} deployment is too large`);
      return { kind: "deployment", deployedLamports: Number(deployed), realizedLamports: 0,
        networkFeeLamports: Number(fee), occurredAt };
    }
    if (!EXIT_INTENT_KINDS.includes(intent.kind))
      throw new Error(`intent ${intent.id} has no risk-ledger accounting rule`);
    const before = intent.context?.position;
    const beforeRaw = BigInt(String(before?.qtyRaw || "0"));
    const basis = BigInt(String(before?.costBasisLamports || "0"));
    if (beforeRaw <= 0n || basis <= 0n || input <= 0n || input > beforeRaw)
      throw new Error(`intent ${intent.id} has invalid durable exit basis`);
    const allocatedBasis = input === beforeRaw ? basis : basis * input / beforeRaw;
    const realized = output - fee - allocatedBasis;
    if (realized > BigInt(Number.MAX_SAFE_INTEGER) || realized < BigInt(Number.MIN_SAFE_INTEGER))
      throw new Error(`intent ${intent.id} realized result is too large`);
    return { kind: "realized", deployedLamports: 0, realizedLamports: Number(realized),
      networkFeeLamports: Number(fee), occurredAt };
  }
}

/** Decide whether the executor may act on its full durable position quantity.
 * A balance below the journal is never treated as permission to sell a partial amount
 * and retire the full record. RPC disagreement and two matching under-reads are both
 * reconciliation states, not evidence that custody disappeared. */
export function trackedBalanceDecision({ trackedRaw, primaryRaw, secondaryRaw = null }) {
  const parseRaw = (value, label) => {
    const text = String(value ?? "");
    if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
    return BigInt(text);
  };
  const tracked = parseRaw(trackedRaw, "tracked balance");
  const primary = parseRaw(primaryRaw, "primary balance");
  if (tracked <= 0n) throw new Error("tracked balance must be positive");
  if (primary >= tracked) return { verified: true, amountRaw: tracked.toString() };
  const secondary = secondaryRaw == null ? null : parseRaw(secondaryRaw, "secondary balance");
  const reason = secondary == null
    ? `primary RPC reports ${primary} below tracked ${tracked}; secondary balance unavailable`
    : secondary >= tracked
      ? `RPC balance disagreement: primary ${primary}, secondary ${secondary}, tracked ${tracked}`
      : `both RPCs report below tracked balance: primary ${primary}, secondary ${secondary}, tracked ${tracked}`;
  return { verified: false, reason, primaryRaw: primary.toString(),
    secondaryRaw: secondary?.toString() ?? null, trackedRaw: tracked.toString() };
}

export function acquireProcessLock(file) {
  const lock = path.resolve(file);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const claim = () => {
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  };
  while (true) {
    try { claim(); break; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let pid;
      try { pid = Number(fs.readFileSync(lock, "utf8").trim()); }
      catch { throw new Error(`executor lock already exists with an unreadable owner: ${lock}`); }
      if (!Number.isInteger(pid) || pid <= 1)
        throw new Error(`executor lock already exists with an invalid owner: ${lock}`);
      try {
        process.kill(pid, 0);
        throw new Error(`executor lock already exists (active pid ${pid})`);
      } catch (probe) {
        if (probe?.message?.startsWith("executor lock already exists")) throw probe;
        if (probe?.code === "EPERM") throw new Error(`executor lock already exists (active pid ${pid})`);
        if (probe?.code !== "ESRCH") throw probe;
      }
      // Atomically move exactly the stale inode we inspected. If two restarters race,
      // only one rename succeeds; both then compete on O_EXCL and still yield one owner.
      const quarantine = `${lock}.stale-${pid}-${process.pid}-${Date.now()}`;
      try { fs.renameSync(lock, quarantine); }
      catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      try { fs.unlinkSync(quarantine); } catch {}
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const pid = Number(fs.readFileSync(lock, "utf8").trim());
      if (pid === process.pid) fs.unlinkSync(lock);
    } catch {}
  };
}
