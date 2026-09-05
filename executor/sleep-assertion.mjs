/**
 * macOS AC sleep inhibition for the supervised WALL-ST-E process.
 *
 * The Node runner remains the journal-lock owner. A direct, shell-free caffeinate
 * child watches that exact pid while pmset proves both idle-system-sleep and
 * system-sleep assertions are active on AC power. A protected sidecar binds the two
 * pids so launch readiness and the independent monitor can verify the same identity.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";

export const CAFFEINATE_PATH = "/usr/bin/caffeinate";
export const PMSET_PATH = "/usr/bin/pmset";
export const PS_PATH = "/bin/ps";
const RECORD_VERSION = 1;
const OWNER_ONLY_MASK = 0o077;
const GROUP_OR_OTHER_WRITE_MASK = 0o022;

export const sleepAssertionRecordPath = (lockFile) => `${path.resolve(lockFile)}.sleep-assertion`;
export const sleepAssertionFaultPath = (lockFile) => `${path.resolve(lockFile)}.sleep-assertion-fault`;

const protectedRecord = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK);
  }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("sleep assertion record is not a regular file");
    if (stat.size > 4_096) throw new Error("sleep assertion record is too large");
    if ((stat.mode & OWNER_ONLY_MASK) !== 0) throw new Error("sleep assertion record is not owner-only");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("sleep assertion record has the wrong owner");
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (value?.version !== RECORD_VERSION || !Number.isInteger(value.ownerPid) || value.ownerPid <= 1 ||
        !Number.isInteger(value.assertionPid) || value.assertionPid <= 1 ||
        value.kind !== "caffeinate-is-w") throw new Error("sleep assertion record is invalid");
    return value;
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Inspect a local safety sentinel without following a final-component symlink.
 * Anything other than a proven ENOENT is conservatively active. This matters for a
 * dangling symlink: fs.existsSync() follows it and incorrectly reports "unpaused".
 */
export function inspectOwnerControlFile(file, {
  label = "safety control",
  ownerUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  const absolute = path.resolve(file || "");
  if (!file) return { path: absolute, present: true, valid: false,
    reason: `${label} path is missing` };
  let fd;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: absolute, present: false, valid: true, reason: null };
    return { path: absolute, present: true, valid: false,
      reason: `${label} cannot be safely opened (${error?.code || "read error"})` };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { path: absolute, present: true, valid: false,
      reason: `${label} is not a regular file` };
    if ((stat.mode & OWNER_ONLY_MASK) !== 0) return { path: absolute, present: true, valid: false,
      reason: `${label} is not owner-only` };
    if (ownerUid !== null && stat.uid !== ownerUid)
      return { path: absolute, present: true, valid: false,
        reason: `${label} has the wrong owner` };
    return { path: absolute, present: true, valid: true, reason: null };
  } catch (error) {
    return { path: absolute, present: true, valid: false,
      reason: `${label} cannot be inspected (${error?.code || "read error"})` };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

const protectedControlParent = (file, label) => {
  const parent = path.dirname(file);
  let stat;
  try { stat = fs.lstatSync(parent); }
  catch (error) { throw new Error(`${label} parent is unavailable (${error?.code || "read error"})`); }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${label} parent must be a regular non-symlink directory`);
  if ((stat.mode & GROUP_OR_OTHER_WRITE_MASK) !== 0)
    throw new Error(`${label} parent must not be writable by group or other`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error(`${label} parent has the wrong owner`);
  return parent;
};

const ensureOwnerControlFile = (file, { label, reason }) => {
  const absolute = path.resolve(file || "");
  if (!file) throw new Error(`${label} path is missing`);
  const prior = inspectOwnerControlFile(absolute, { label });
  if (prior.present) {
    if (!prior.valid) throw new Error(prior.reason);
    return { ...prior, created: false };
  }
  const parent = protectedControlParent(absolute, label);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    fs.writeFileSync(fd, `${String(reason).replace(/[\r\n]/g, " ").slice(0, 160)}\n`, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (created) {
    try {
      const directory = fs.openSync(parent, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {}
  }
  const published = inspectOwnerControlFile(absolute, { label });
  if (!published.present || !published.valid)
    throw new Error(published.reason || `${label} was not atomically published`);
  return { ...published, created };
};

/** Atomically publish and durably validate the owner-only entry-pause sentinel. */
export function ensureEntryPauseFile(file, { reason = "macOS power safety" } = {}) {
  return ensureOwnerControlFile(file, { label: "entry-pause sentinel", reason });
}

/**
 * Persist a second, canonical fail-closed record when the configured pause path
 * cannot be safely published. This latch is deliberately never cleared by the
 * supervisor: only an operator may remove it after repairing and reviewing the
 * pause control.
 */
export function ensureSleepAssertionFault(lockFile, {
  reason = "automatic entry-pause publication failed",
} = {}) {
  if (!lockFile) throw new Error("sleep assertion fault requires the canonical lock path");
  return ensureOwnerControlFile(sleepAssertionFaultPath(lockFile), {
    label: "sleep assertion fault latch", reason,
  });
}

const publishAutomaticPause = ({ lockFile, pauseEntriesFile, reason }) => {
  try {
    return { paused: ensureEntryPauseFile(pauseEntriesFile, { reason }), fault: null,
      pauseError: null };
  } catch (pauseError) {
    // The fallback is anchored beside the canonical process lock, not beside an
    // operator-configurable pause path. A bad/dangling pause path therefore cannot
    // erase the failure on the next launchd restart.
    const faultReason = `${reason}; entry pause publication failed: ${pauseError.message}`;
    let fault;
    try { fault = ensureSleepAssertionFault(lockFile, { reason: faultReason }); }
    catch (faultError) {
      throw new Error(`entry pause could not be validated (${pauseError.message}); ` +
        `sleep assertion fault could not be latched (${faultError.message})`);
    }
    return { paused: null, fault, pauseError };
  }
};

const processAlive = (pid, killFn = process.kill.bind(process)) => {
  try { killFn(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

const commandIdentity = (output, { ownerPid, assertionPid, caffeinatePath }) => {
  const match = /^\s*(\d+)\s+([\s\S]+?)\s*$/.exec(String(output || ""));
  if (!match || Number(match[1]) !== ownerPid) return false;
  const tokens = match[2].split(/\s+/);
  return tokens.length === 5 && tokens[0] === caffeinatePath &&
    tokens[1] === "-i" && tokens[2] === "-s" && tokens[3] === "-w" &&
    tokens[4] === String(ownerPid) && assertionPid > 1;
};

/** Verify the protected record, exact parent/child command, AC source, and both IOPM assertions. */
/* THE PAUSE THE BOT PUBLISHES TO ITSELF ON THE WAY OUT, AND THEN CANNOT LIFT.
 *
 * stop() publishes an entry pause on EVERY process exit — its own comment says so: a
 * startup refusal, an uncaught exception, a SIGTERM, an operator upgrade and a clean
 * exit code 0 all take that path. That is right: an exit is not proof that anything is
 * safe, and a machine that sleeps with an open position must not keep entering.
 *
 * What was missing is the other half. NOTHING in the poller ever removed that pause.
 * The only remover was an `rm -f` inside an interactive shell script, so the bot could
 * not restart itself into a trading state: one crash, one upgrade, one power flap and
 * it came back alive, healthy, holding both sleep assertions on AC power — and skipping
 * every call it was offered until a human intervened. Measured over two days of the
 * live log: 74 automatic pauses published, and at 06:39:38 on 2026-09-03 a real call
 * was refused with "SKIP Shrek: PAUSE ENTRIES file is present", 31 minutes after the
 * crash loop that wrote it, on a process that was by then perfectly healthy.
 *
 * So a pause this supervisor wrote is lifted at startup, and ONLY that kind. The
 * conditions are deliberately narrow:
 *   - the fault latch must be absent, because a latched fault outranks everything;
 *   - the pause file must be owner-only and well formed, as always;
 *   - its recorded reason must begin with the exact prefix stop() writes.
 * An operator-authored pause reads as anything else and is left exactly where it is,
 * as is a pause whose reason cannot be read. The publish-on-exit behaviour is not
 * touched, so nothing that protects an open position across a sleep is weakened. The
 * pause simply stops outliving the condition that caused it.
 *
 * The caller must only reach here AFTER the sleep assertion has started and verified,
 * which is what makes "the condition is over" a fact rather than a hope.
 */
export const AUTOMATIC_PAUSE_PREFIX = "automatic pause:";

export function liftAutomaticEntryPause({ lockFile, pauseEntriesFile } = {}) {
  const absolute = path.resolve(pauseEntriesFile || "");
  if (!pauseEntriesFile) return { lifted: false, reason: "no entry pause path configured" };

  // A latched sleep-assertion fault outranks every other consideration.
  const fault = inspectOwnerControlFile(sleepAssertionFaultPath(lockFile),
    { label: "sleep assertion fault latch" });
  if (fault.present)
    return { lifted: false, reason: "sleep assertion fault latch is present" };

  const pause = inspectOwnerControlFile(absolute, { label: "entry pause" });
  if (!pause.present) return { lifted: false, reason: "no entry pause to lift" };
  if (!pause.valid) return { lifted: false, reason: pause.reason };

  let recorded;
  try { recorded = fs.readFileSync(absolute, "utf8"); }
  catch (error) { return { lifted: false, reason: `entry pause is unreadable (${error?.code || "read error"})` }; }

  const text = String(recorded).trim();
  if (!text.startsWith(AUTOMATIC_PAUSE_PREFIX))
    return { lifted: false, reason: "the entry pause was not published by this supervisor", recorded: text.slice(0, 160) };

  try { fs.unlinkSync(absolute); }
  catch (error) { return { lifted: false, reason: `entry pause could not be cleared (${error?.code || "unlink error"})` }; }
  return { lifted: true, reason: text.slice(0, 160) };
}

export function verifyMacSleepAssertion({
  ownerPid, lockFile, caffeinatePath = CAFFEINATE_PATH, pmsetPath = PMSET_PATH,
  psPath = PS_PATH, execFile = execFileSync, killFn = process.kill.bind(process),
} = {}) {
  const result = { required: true, ok: false, commandBound: false, assertionPid: null,
    powerSource: null, acPower: false, idleSystemSleep: false, systemSleep: false,
    reason: "sleep assertion is unavailable" };
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || !lockFile)
    return { ...result, reason: "sleep assertion owner identity is invalid" };
  let record;
  try { record = protectedRecord(sleepAssertionRecordPath(lockFile)); }
  catch (error) { return { ...result, reason: error.message }; }
  if (!record) return { ...result, reason: "sleep assertion record is missing" };
  result.assertionPid = record.assertionPid;
  if (record.ownerPid !== ownerPid)
    return { ...result, reason: "sleep assertion record belongs to a different lock owner" };
  if (!processAlive(record.assertionPid, killFn))
    return { ...result, reason: "caffeinate process is not alive" };
  try {
    const identity = execFile(psPath, ["-ww", "-p", String(record.assertionPid),
      "-o", "ppid=,command="], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    if (!commandIdentity(identity, { ownerPid, assertionPid: record.assertionPid, caffeinatePath }))
      return { ...result, reason: "caffeinate command is not bound to the journal-lock owner" };
    result.commandBound = true;
    const battery = execFile(pmsetPath, ["-g", "batt"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    if (/Now drawing from ['\"]AC Power['\"]/i.test(battery)) result.powerSource = "ac";
    else if (/Now drawing from ['\"]Battery Power['\"]/i.test(battery)) result.powerSource = "battery";
    result.acPower = result.powerSource === "ac";
    const assertions = execFile(pmsetPath, ["-g", "assertions"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    });
    const marker = new RegExp(`\\bpid\\s+${record.assertionPid}\\(caffeinate\\):`, "i");
    const owned = String(assertions).split(/\r?\n/).filter((line) => marker.test(line)).join("\n");
    result.idleSystemSleep = /PreventUserIdleSystemSleep/i.test(owned);
    result.systemSleep = /PreventSystemSleep/i.test(owned);
  } catch {
    return { ...result, reason: "macOS power assertion evidence could not be read" };
  }
  result.ok = result.acPower && result.idleSystemSleep && result.systemSleep;
  result.reason = result.ok ? null : result.powerSource === "battery" ? "host is drawing battery power"
    : result.powerSource !== "ac" ? "host power source could not be verified"
    : "caffeinate does not hold both required sleep assertions";
  return result;
}

export const batteryPowerIsOperational = (evidence) => evidence?.commandBound === true &&
  evidence?.powerSource === "battery" && evidence?.idleSystemSleep === true;

/** Strict, synchronous entry boundary: pause first, then refuse if AC proof is absent. */
export function requireMacEntryPower({
  ownerPid = process.pid, lockFile, pauseEntriesFile, verify = verifyMacSleepAssertion,
  allowBatteryEntries = batteryEntriesAllowed(),
} = {}) {
  if (!lockFile)
    throw new Error("entry power gate is closed (canonical lock path is missing)");
  const priorFault = inspectOwnerControlFile(sleepAssertionFaultPath(lockFile), {
    label: "sleep assertion fault latch",
  });
  if (priorFault.present) {
    throw new Error(priorFault.valid
      ? "sleep assertion fault is latched; explicit operator repair and review are required"
      : `sleep assertion fault latch is unsafe (${priorFault.reason})`);
  }
  const evidence = verify({ ownerPid, lockFile });
  if (evidence?.ok === true) return evidence;
  /* The same operator decision the supervisor honours, enforced at the moment of entry.
     It accepts battery ONLY when the idle-sleep assertion is genuinely held by a
     caffeinate bound to this process — every other way of failing this gate, including
     unreadable evidence or a dead caffeinate, still pauses and refuses. */
  if (allowBatteryEntries && batteryPowerIsOperational(evidence)) return evidence;
  let result;
  try {
    result = publishAutomaticPause({ lockFile, pauseEntriesFile,
      reason: `automatic pause: ${evidence?.reason || "entry power assertion unavailable"}`,
    });
  } catch (error) {
    throw new Error(`entry power gate is closed (${evidence?.reason || "strict AC assertion unavailable"}); ` +
      error.message);
  }
  throw new Error(`entry power gate is closed (${evidence?.reason || "strict AC assertion unavailable"})` +
    (result.pauseError
      ? `; entry pause failed and the sleep assertion fault was durably latched (${result.pauseError.message})`
      : "; entries were durably paused"));
}

const writeRecord = (file, value) => {
  const parent = path.dirname(file);
  const temporary = `${file}.next-${process.pid}-${Date.now()}`;
  const bytes = `${JSON.stringify(value)}\n`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.chmodSync(temporary, 0o600);
  try {
    // link is an atomic no-replace publication on the same filesystem. A racing
    // supervisor cannot overwrite another process's assertion identity.
    fs.linkSync(temporary, file);
    fs.unlinkSync(temporary);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    const dir = fs.openSync(parent, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch {}
};

const unlinkMatchingRecord = (file, ownerPid, assertionPid) => {
  try {
    const record = protectedRecord(file);
    if (record?.ownerPid === ownerPid && record?.assertionPid === assertionPid) fs.unlinkSync(file);
  } catch {}
};

/** Start and continuously supervise the exact caffeinate assertion for this runner pid. */
/* RUNNING ON BATTERY, BY EXPLICIT CHOICE.
 *
 * On AC, macOS grants caffeinate both PreventUserIdleSystemSleep and PreventSystemSleep.
 * On battery it grants only the first, so the machine still will not sleep from idle but
 * CAN sleep if the lid closes or the battery runs out — and a position open across that
 * is a position with no stop until the machine wakes. That is why battery has always
 * paused entries.
 *
 * It is a real risk and it is the operator's to take, so it is a setting rather than a
 * rule: WALLSTE_ALLOW_BATTERY_ENTRIES=1 keeps entries armed while the host is on battery.
 * Everything else is unchanged and still fail-closed — the idle-sleep assertion must
 * genuinely be held by a caffeinate bound to this process, and if that evidence is lost,
 * unreadable, or the caffeinate dies, entries pause and the runner exits exactly as
 * before. This flag says "battery alone is not a reason to stop"; it does not say
 * "stop checking". */
export const batteryEntriesAllowed = (env = process.env) =>
  String(env.WALLSTE_ALLOW_BATTERY_ENTRIES ?? "0").trim() === "1";

export async function startMacSleepAssertion({
  ownerPid = process.pid, lockFile, pauseEntriesFile, caffeinatePath = CAFFEINATE_PATH,
  verify = verifyMacSleepAssertion, spawnFn = spawn, intervalMs = 15_000,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  allowBatteryEntries = batteryEntriesAllowed(),
  onDegraded = (reason) => console.error(
    `WALL-ST-E launchd: battery power detected; entries paused (${reason})`),
  onRestored = () => console.error(
    "WALL-ST-E launchd: AC sleep assertions restored; entry pause remains until explicit readiness review"),
  onFailure = (reason) => {
    console.error(`WALL-ST-E launchd: macOS sleep assertion lost (${reason})`);
    process.exit(70);
  },
} = {}) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || !lockFile || !pauseEntriesFile)
    throw new Error("sleep assertion requires the exact runner pid, canonical lock, and entry-pause path");
  if (caffeinatePath !== CAFFEINATE_PATH)
    throw new Error("production sleep assertion must use /usr/bin/caffeinate");
  const recordFile = sleepAssertionRecordPath(lockFile);
  // If neither the configured pause nor the canonical fault latch can be
  // published, retain the already-fsynced assertion record as a third durable
  // fail-closed witness. A later restart must pause/latch before replacing it.
  let preserveAssertionRecord = false;
  let prior;
  try { prior = protectedRecord(recordFile); }
  catch (error) {
    try {
      publishAutomaticPause({ lockFile, pauseEntriesFile,
        reason: `automatic pause: invalid sleep assertion startup record (${error.message})` });
    } catch {}
    throw error;
  }
  if (prior) {
    if (processAlive(prior.ownerPid)) throw new Error("another live sleep assertion record exists");
    // A clean stop removes this record. Its survival across a dead owner proves an
    // abnormal termination, so pause before replacing it on a launchd restart.
    publishAutomaticPause({ lockFile, pauseEntriesFile,
      reason: "automatic pause: stale sleep assertion record after unclean shutdown" });
    fs.unlinkSync(recordFile);
  }

  let child;
  try {
    child = spawnFn(caffeinatePath, ["-i", "-s", "-w", String(ownerPid)], {
      stdio: "ignore", detached: false,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("caffeinate did not start in time")), 2_000);
      child.once("spawn", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    child.unref();
    if (!Number.isInteger(child.pid) || child.pid <= 1)
      throw new Error("caffeinate returned an invalid process id");
    writeRecord(recordFile, { version: RECORD_VERSION, ownerPid,
      assertionPid: child.pid, kind: "caffeinate-is-w" });
  } catch (error) {
    let safety = "; entries were durably paused";
    try {
      const result = publishAutomaticPause({ lockFile, pauseEntriesFile,
        reason: `automatic pause: sleep assertion startup failed (${error.message})` });
      if (result.pauseError) safety = "; entry pause failed and the sleep assertion fault was durably latched";
    } catch (safetyError) {
      preserveAssertionRecord = true;
      safety = `; ${safetyError.message}; any published sleep assertion record was retained for restart safety`;
    }
    if (!preserveAssertionRecord && Number.isInteger(child?.pid))
      unlinkMatchingRecord(recordFile, ownerPid, child.pid);
    try { child?.kill("SIGTERM"); } catch {}
    throw new Error(`caffeinate could not be started (${error.message})${safety}`);
  }

  let evidence = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    evidence = verify({ ownerPid, lockFile });
    if (evidence?.ok || batteryPowerIsOperational(evidence)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!evidence?.ok && !batteryPowerIsOperational(evidence)) {
    let safety = "; entries were durably paused";
    try {
      const result = publishAutomaticPause({ lockFile, pauseEntriesFile,
      reason: `automatic pause: ${evidence?.reason || "sleep assertion startup failure"}`,
      });
      if (result.pauseError) safety = "; entry pause failed and the sleep assertion fault was durably latched";
    } catch (error) {
      preserveAssertionRecord = true;
      safety = `; ${error.message}; sleep assertion record retained for restart safety`;
    }
    if (!preserveAssertionRecord) unlinkMatchingRecord(recordFile, ownerPid, child.pid);
    try { child.kill("SIGTERM"); } catch {}
    throw new Error(`${evidence?.reason || "caffeinate assertion could not be verified"}${safety}`);
  }

  let batteryDegraded = false;
  const enterBatteryMode = (current) => {
    /* The operator has accepted the battery risk. The idle-sleep assertion is still
       required and still verified on every tick — this branch only declines to publish
       the pause that battery alone would otherwise cause. */
    if (allowBatteryEntries) {
      if (!batteryDegraded)
        onDegraded(`${current?.reason || "battery power"} — entries CONTINUE, ` +
          "WALLSTE_ALLOW_BATTERY_ENTRIES=1; the machine can still sleep on a closed lid " +
          "or a flat battery, and a position open across that has no stop until it wakes");
      batteryDegraded = true;
      return;
    }
    const result = publishAutomaticPause({ lockFile, pauseEntriesFile,
      reason: `automatic pause: ${current?.reason || "battery power"}`,
    });
    if (result.pauseError)
      throw new Error(`entry pause could not be validated (${result.pauseError.message}); ` +
        "sleep assertion fault was durably latched");
    if (!batteryDegraded) onDegraded(current?.reason || "battery power");
    batteryDegraded = true;
  };
  if (batteryPowerIsOperational(evidence)) {
    try { enterBatteryMode(evidence); }
    catch (error) {
      preserveAssertionRecord = true;
      try { child.kill("SIGTERM"); } catch {}
      throw error;
    }
  }

  let stopping = false;
  let failed = false;
  const failOnce = (reason) => {
    if (stopping || failed) return;
    failed = true;
    onFailure(reason);
  };
  const pauseThenFail = (reason) => {
    let detail = reason;
    try {
      const result = publishAutomaticPause({ lockFile, pauseEntriesFile,
        reason: `automatic pause: ${reason}` });
      if (result.pauseError)
        detail += `; entry pause failed and the sleep assertion fault was durably latched (${result.pauseError.message})`;
    } catch (error) {
      preserveAssertionRecord = true;
      detail += `; ${error.message}; sleep assertion record retained for restart safety`;
    }
    failOnce(detail);
  };
  child.once("exit", () => {
    pauseThenFail("caffeinate process exited");
  });
  const timer = setIntervalFn(() => {
    const current = verify({ ownerPid, lockFile });
    if (current?.ok) {
      if (batteryDegraded) onRestored();
      batteryDegraded = false;
      return;
    }
    if (batteryPowerIsOperational(current)) {
      try { enterBatteryMode(current); }
      catch (error) {
        preserveAssertionRecord = true;
        failOnce(`entry pause could not be validated (${error.message}); ` +
          "sleep assertion record retained for restart safety");
      }
      return;
    }
    pauseThenFail(current?.reason || "sleep assertion evidence is unavailable");
  }, Math.max(1_000, Number(intervalMs) || 15_000));
  timer?.unref?.();

  let onProcessExit;
  const stop = (reason = "sleep assertion supervisor stopped") => {
    if (stopping) return;
    stopping = true;
    // A Node `exit` event is not proof of an intentional operator unload: poller
    // startup refusals, uncaught exceptions, SIGTERM handlers and explicit
    // process.exit() all take this same path. Publish a durable pause (or the
    // canonical fault latch) before removing the assertion record. If neither
    // control can be published, retain the record so the next launch must treat it
    // as an unclean shutdown and fail closed before replacing it.
    try {
      publishAutomaticPause({ lockFile, pauseEntriesFile,
        reason: `automatic pause: ${String(reason).replace(/[\r\n]/g, " ").slice(0, 120)}`,
      });
    } catch {
      preserveAssertionRecord = true;
    }
    clearIntervalFn(timer);
    if (!preserveAssertionRecord) unlinkMatchingRecord(recordFile, ownerPid, child.pid);
    try { child.kill("SIGTERM"); } catch {}
    if (onProcessExit) process.removeListener("exit", onProcessExit);
  };
  onProcessExit = (code) => stop(`runner process exited with code ${String(code)}`);
  process.once("exit", onProcessExit);
  return { assertionPid: child.pid, recordFile, evidence, stop };
}
