/**
 * THE SHADOW BOOK, ON DISK — because a measurement that dies with the process is not
 * evidence, it is a rehearsal.
 *
 * snipe-shadow.mjs computes `creator_profile` and `launch_share` on every launch the lane
 * evaluates, records a row per notice, samples each row's forward path, and can grade both
 * rulers against the realised outcome with `snipeScorecard()`. All of the science was
 * already there. What was missing was one line: `createSnipeShadow()` defaults to
 * `sink: null` and the poller never passed one, so the whole book lived in a bounded Map
 * and died on every restart — every upgrade, every crash, every reboot.
 *
 * Measured cost of that omission: the owner's 64 traded launches have known outcomes and
 * NO retained measurements, so the one experiment worth running — do either of these two
 * rulers actually separate winners from losers — could not be run at all. The README said
 * "the shadow book has been recording both measurements the whole time", which was true
 * and useless in the same sentence.
 *
 * WHY JSONL, AND NOT THE SQLITE JOURNAL
 *
 * The journal is the money record. It is the thing that must never be corrupted, never
 * grow unboundedly, and never be written by anything whose failure mode is "lost some
 * rows". This book is the opposite on every axis: it is research data, an occasional lost
 * line costs one row of a scorecard, and it is append-only by nature. Mixing the two would
 * put a high-volume research writer inside the transaction boundary that protects the
 * owner's positions, which is a trade nobody should make for a report.
 *
 * So: one line of JSON per row, appended, 0600, rotated at a ceiling, at most two files.
 *
 * WHAT THIS FILE REFUSES TO DO
 *
 *   · It never throws into the lane. `createSnipeShadow` already swallows and COUNTS sink
 *     errors (`counters.sinkErrors`), which is the right shape: a row that could not be
 *     persisted is a row missing from a scorecard, not a decision that failed. This module
 *     keeps its own error count too, so a disk that filled up three days ago is a number
 *     someone can read rather than a silence.
 *   · It never grows without bound. Two files, a byte ceiling on each. A sniper that runs
 *     for a month at 29 launches a minute writes a lot of rows, and "research data" is not
 *     a licence to fill the disk the trading process lives on.
 *   · It never writes a row it cannot read back. Every line is JSON.stringify'd and the
 *     reader skips — and counts — anything that will not parse, so a truncated final line
 *     from a hard kill costs one row and not the file.
 */

import fs from "node:fs";
import path from "node:path";

export const SHADOW_SINK_VERSION = "shadow-sink-v1";

/** 64 MiB per file, two files. At ~29 launches a minute and ~1 KB a row that is a bit over
 *  a day of live history retained at all times, which is the window any of these gates
 *  would be graded over anyway. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Where the book lives, given the state database's path. Beside it, named after it, the
 *  same convention the pause and hard-stop sentinels already use. */
export const shadowBookPath = (stateDb) => `${String(stateDb)}.shadow.jsonl`;

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/**
 * An append-only sink for `createSnipeShadow({ sink })`.
 *
 * Returns a function the shadow calls with each frozen row. It is deliberately synchronous:
 * the lane records at most a few rows a second, an async write would need a queue, and a
 * queue is a place for rows to be lost on exit. `appendFileSync` at this rate costs
 * microseconds and cannot reorder.
 *
 * `fsImpl` and `clock` are injected so the whole thing is testable without a disk.
 */
export function createShadowSink({
  file, maxBytes = DEFAULT_MAX_BYTES, fsImpl = fs, onError = null,
} = {}) {
  if (typeof file !== "string" || !file.trim())
    throw new TypeError("createShadowSink needs a file path");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0)
    throw new TypeError(`maxBytes must be a positive number, got ${maxBytes}`);

  const target = path.resolve(file);
  const rotated = `${target}.1`;
  const counters = { written: 0, bytes: 0, rotations: 0, errors: 0, skipped: 0 };

  /* Rotation is a rename, not a copy: it is atomic, it cannot half-succeed, and the reader
     below reads BOTH files so nothing is invisible between the rename and the next write. */
  const rotateIfNeeded = () => {
    let size = 0;
    try { size = fsImpl.statSync(target).size; } catch { return; }   // no file yet is not an error
    if (size < maxBytes) return;
    try { fsImpl.rmSync(rotated, { force: true }); } catch { /* best effort */ }
    fsImpl.renameSync(target, rotated);
    counters.rotations++;
  };

  const sink = (row) => {
    if (!isPlainObject(row)) { counters.skipped++; return; }
    let line;
    /* Serialise BEFORE touching the disk. A row that will not stringify — a BigInt that
       slipped through the recorder's normalisation — must cost one row, not a broken file
       with half a record in it. */
    try { line = JSON.stringify(row) + "\n"; }
    catch (error) { counters.skipped++; onError?.(error); return; }
    try {
      rotateIfNeeded();
      fsImpl.appendFileSync(target, line, { mode: 0o600 });
      counters.written++;
      counters.bytes += Buffer.byteLength(line);
    } catch (error) {
      counters.errors++;
      onError?.(error);
      /* Rethrow: createSnipeShadow catches and counts it as sinkErrors, which is where the
         lane's own reporting already looks. Swallowing here would hide the count from both. */
      throw error;
    }
  };

  sink.stats = () => ({ ...counters, file: target, rotated, maxBytes });
  sink.path = target;
  return sink;
}

/**
 * Read the book back — the rotated file first, then the live one, so rows come out oldest
 * first and a scorecard reads the whole retained history in order.
 *
 * A line that will not parse is COUNTED and skipped, never fatal. The common case is the
 * last line of a file whose process was killed mid-append, and losing one row of research
 * data to that is correct; refusing to read the other four hundred thousand is not.
 */
export function readShadowRows({ file, fsImpl = fs, limit = 0 } = {}) {
  if (typeof file !== "string" || !file.trim())
    throw new TypeError("readShadowRows needs a file path");
  const target = path.resolve(file);
  const rows = [];
  let malformed = 0, files = 0;

  for (const candidate of [`${target}.1`, target]) {
    let text;
    try { text = fsImpl.readFileSync(candidate, "utf8"); }
    catch { continue; }                                   // absent is normal, not an error
    files++;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (isPlainObject(row)) rows.push(row); else malformed++;
      } catch { malformed++; }
    }
  }

  /* A limit keeps the RECENT window, because that is the question a scorecard asks: is
     this ruler working NOW, on the market as it is now. Taking the oldest N instead would
     grade a build and a market that no longer exist. */
  const kept = limit > 0 && rows.length > limit ? rows.slice(-limit) : rows;
  return { rows: kept, malformed, files, total: rows.length };
}
