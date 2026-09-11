/**
 * THE SECOND BOOK — the sniper lane's own positions, and the invariant that keeps the
 * two lanes from ever touching each other's money.
 *
 * ── WHY A SECOND BOOK AND NOT A `lane` FIELD ─────────────────────────────────────────
 *
 * The cheap-looking option was one book with `pos.lane === "snipe"` on the sniper rows.
 * It was rejected on a measurement, not on taste. `poller.mjs:726` reads
 *
 *     const openList = () => Object.values(S.positions);
 *
 * and that one expression feeds `manageOpen`, `mirrorTick`, `recordPositionFailure`,
 * book heat, `positionEntryBlock` and `reconcileHeldCalls`. A lane field means auditing
 * every one of those call sites and every one written after today, and being right each
 * time; the day somebody adds a seventh consumer without reading this comment, a snipe
 * row is a desk row. A SECOND BOOK means `openList()` CANNOT SEE A SNIPE BY
 * CONSTRUCTION — the fence is the data structure, not a convention that has to be
 * remembered. Nothing in this file reads `S.positions` except the invariant, and the
 * invariant reads it only to prove the two books are disjoint.
 *
 * The same reasoning runs the other way: `stepPosition` is never called for a snipe and
 * `snipeStep` never for a desk position, because neither engine can reach the other's
 * book. The desk path stays byte-identical, which is an owner decision taken after a
 * measured incident (desk-led-v4), and this file imports nothing from trade-policy.mjs,
 * strategy.mjs or desk-mirror.mjs to keep it that way.
 *
 * ── RAW AMOUNTS ARE STORED AS DIGIT STRINGS, AND THAT IS MEASURED ────────────────────
 *
 * All the arithmetic on this lane is BigInt, because a standard pump.fun curve holds
 * ~1.07e15 base units and doubles stop counting by ones at 2^53. But the runtime state
 * this book lives in is JOURNALLED AS JSON: `journal.mjs:971` writes each position with
 * `json(value)` = `JSON.stringify`, and `JSON.stringify(1n)` THROWS
 * "Do not know how to serialize a BigInt". A BigInt in this book would therefore not
 * fail here, where it would be seen — it would fail at the next durable write, on the
 * money path, with a position already open. That is exactly why the desk's own rows
 * store `qtyRaw: String(...)` and `costBasisLamports: ...toString()`
 * (`poller.mjs:1084-1086`), and this book follows it: every raw amount goes in as a
 * BigInt, a digit string or a safe integer and comes back out as a DIGIT STRING —
 * the form `snipe-curve.mjs rawAmount()` already accepts unchanged. `test-snipe-book.mjs`
 * asserts the whole book survives a JSON round trip and that a BigInt left in it does not.
 *
 * ── WHAT "THE BOOK REFUSES A POSITION IT CANNOT PRICE" MEANS ─────────────────────────
 *
 * The sniper's ruler is a simulated sell:
 *
 *     markX = sellExactIn(curve, pos.qtyRaw) / pos.entryInputLamports
 *
 * so a row without a positive `qtyRaw` and a positive `entryInputLamports` HAS NO MARK.
 * Not a stale mark, not a wide mark — no mark at all, on a lane whose every downward
 * trigger (floor, armed stop, take) is a comparison against one. A position with no mark
 * cannot be exited by price and would sit in the book until the clock fired, which is a
 * silent hold, which is the failure `strategy.mjs:433-436` already produces for a
 * position that lands in the wrong book. The lane may not enter what it cannot exit, and
 * the book will not FILE what it cannot price.
 *
 * The same test runs on the fee economics. `frictionXFor()` from snipe-curve.mjs is the
 * single definition of round-trip friction in this repo; the book calls it at open, so a
 * row that cannot produce a finite breakeven multiple is refused at the moment it is
 * created rather than discovered by a determiner that has to decide something about it.
 * And a fill whose fee per leg is not strictly smaller than its ticket has NO breakeven
 * multiple at all — proceeds never reach outlay at any mark — so it is refused by name
 * instead of being stored with an Infinity nobody prints.
 *
 * ── THE ECONOMICS ARE FROZEN AT OPEN ─────────────────────────────────────────────────
 *
 * `frictionX` is a fact about the lamports that were actually paid, so it must not drift
 * after the fill: `updateSnipe()` refuses any change to `sizeSol`, `feeSolPerLeg`,
 * `entry`, `openedAt`, `entryInputLamports`, `entryFeeLamports`, `creator`, `venue`,
 * `mint` or `lane`, and refuses a `qtyRaw` that has GROWN — a snipe never adds to a
 * position, it only sells part or all of one. The determiner's own working fields (the
 * confirmed high, the witness record, whatever it arms) are free to move; the fill is not.
 *
 * ── PURITY AND CLOCKS ────────────────────────────────────────────────────────────────
 *
 * `openSnipe`, `updateSnipe` and `closeSnipe` are the book's writers, so they mutate
 * `S.snipes` — that is their job — but they never mutate their argument, never call
 * `Date.now()` and never read the network. `openedAt` and `closedAt` ARRIVE AS
 * PARAMETERS, which is what makes a replay of a captured sample produce byte-identical
 * rows. `snipeList` and `assertLaneInvariant` are pure reads.
 *
 * NOTE ON THE NAME `openSnipe`. snipe-policy.mjs exports an opener of the same name and
 * they are different jobs, deliberately: the POLICY's opener authors the record the
 * determiner will step, and THIS one validates a record and FILES it. The book does not
 * import the policy — a book that imports the determiner is a cycle the moment the
 * determiner wants to read the book, and the book has to be the thing both lanes can be
 * checked against rather than a participant in either. Import them aliased.
 */
import bs58 from "bs58";
import { frictionXFor } from "./snipe-curve.mjs";

export const SNIPE_BOOK_VERSION = "snipe-book-v1";

/** The lane tag, stamped by this file and immutable for the life of the position
 *  (§2.2 of the build spec: `pos` carries `lane: "snipe"`, immutable for its life). It is
 *  belt to the second book's braces — the book is the fence, the tag is how a log line,
 *  a journal row or a crash dump says which lane a row came from. */
export const SNIPE_LANE = "snipe";

/** The fill economics the determiner consumes. snipe-policy.mjs prices every arm and
 *  every stop off these four; a row missing one of them is a row the determiner cannot
 *  decide about, so the book refuses it rather than filing it and finding out later. */
export const REQUIRED_SNIPE_ECONOMICS = Object.freeze([
  "entry", "openedAt", "sizeSol", "feeSolPerLeg",
]);

/** The two operands of the mark. Without both there is no markX, hence no floor, no
 *  armed stop and no take — see the header. */
export const REQUIRED_SNIPE_PRICING = Object.freeze(["qtyRaw", "entryInputLamports"]);

/** Fixed at the fill. `updateSnipe` refuses a change to any of them. `qtyRaw` is absent
 *  on purpose: it may fall (a partial or full sell) and may never rise. */
export const IMMUTABLE_SNIPE_FIELDS = Object.freeze([
  "mint", "lane", "venue", "entry", "openedAt", "sizeSol", "feeSolPerLeg",
  "entryInputLamports", "entryFeeLamports", "creator",
]);

/** Every refusal this file can produce, in one frozen ordered list so a caller can branch
 *  on the reason without parsing English — the shape `snipe-venue.mjs
 *  VENUE_CONTRACT_CLAUSES` and `entry-contract.mjs ENTRY_GATES` already use. */
export const LANE_INVARIANT_CLAUSES = Object.freeze([
  "state_invalid",
  "book_invalid",
  "desk_book_invalid",
  "snipe_invalid",
  "book_key_mismatch",
  "mint_invalid",
  "lane_invalid",
  "venue_invalid",
  "entry_invalid",
  "opened_at_invalid",
  "economics_missing",
  "economics_invalid",
  "economics_unpriceable",
  "economics_inconsistent",
  "quantity_unpriceable",
  "entry_input_unpriceable",
  "raw_amount_not_durable",
  "creator_invalid",
  "duplicate_snipe",
  "cross_book_collision",
  "snipe_unknown",
  "immutable_field_changed",
  "quantity_increased",
  "close_invalid",
]);

const CLAUSE_SET = new Set(LANE_INVARIANT_CLAUSES);

/** Thrown by every writer and by the invariant. Carries the clause and the mint so a log
 *  line, a journal row and a test all name the same thing. */
export class LaneInvariantError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "LaneInvariantError";
    /* A clause that is not in the frozen list would make `LANE_INVARIANT_CLAUSES` a lie
     * the first time somebody added a refusal without registering it, and a caller
     * branching on the list would then treat it as a pass. Fail loudly instead. */
    if (!CLAUSE_SET.has(clause))
      throw new Error(`LaneInvariantError: unregistered clause ${JSON.stringify(clause)} — ` +
        "add it to LANE_INVARIANT_CLAUSES");
    this.clause = clause;
    this.detail = Object.freeze({ ...detail });
    this.mint = detail?.mint ?? null;
  }
}

const refuse = (clause, message, detail = {}) => { throw new LaneInvariantError(clause, message, detail); };

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const LAMPORTS = 1_000_000_000;

/** A base58 32-byte account key. Measured by DECODED BYTE LENGTH, never by character
 *  count: base58 of 32 bytes runs 32-44 characters depending on leading zeros, so a
 *  length window accepts strings that are not keys at all. snipe-venue.mjs makes the
 *  same measurement and keeps its helper private, so this is eight lines rather than a
 *  claimed reuse of something that is not exported. */
function isAccountKey(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let bytes;
  try { bytes = bs58.decode(value); } catch { return false; }
  if (!bytes || bytes.length !== 32) return false;
  return !bytes.every((b) => b === 0);          // the all-zero default is never a real key
}

/**
 * A raw on-chain amount on its way INTO the book. Accepts the three forms the repo
 * actually produces — a BigInt from the curve math, a digit string from the journal, a
 * safe-integer Number from a hand-written fixture — and returns the DURABLE form, a digit
 * string. A float is refused rather than truncated: `1.5` silently becoming `1` is the
 * failure this guard exists for.
 */
function durableRaw(value, field, clause, mint, { positive = true } = {}) {
  let out;
  if (typeof value === "bigint") out = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      refuse(clause, `${field} must be a whole amount inside 2^53, got ${value}`, { mint, field, value });
    out = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) out = BigInt(value.trim());
  else refuse(clause, `${field} must be an integer raw amount, got ${JSON.stringify(value)}`,
    { mint, field, value: String(value) });
  if (out < 0n) refuse(clause, `${field} must not be negative, got ${out}`, { mint, field, value: out.toString() });
  if (positive && out === 0n)
    refuse(clause, `${field} must be positive — a position with ${field} 0 has no mark and cannot be exited by price`,
      { mint, field, value: "0" });
  return { text: out.toString(), value: out };
}

/** The same amount once it is already IN the book. Stricter on purpose: the durable form
 *  is a digit string, and a BigInt that reached the book would throw at the next
 *  `JSON.stringify` on the journal's write path rather than here. */
function storedRaw(value, field, clause, mint, { positive = true } = {}) {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    refuse("raw_amount_not_durable",
      `${field} must be stored as a digit STRING (a BigInt cannot be journalled — JSON.stringify throws on it), got ` +
      `${typeof value} ${JSON.stringify(typeof value === "bigint" ? value.toString() : value)}`,
      { mint, field });
  return durableRaw(value, field, clause, mint, { positive });
}

const solToLamports = (sol) => BigInt(Math.round(Number(sol) * LAMPORTS));

/**
 * THE PRICEABILITY TEST, and the reason it is two tests rather than one.
 *
 * (1) A fill whose fee per leg is not strictly smaller than its ticket has no breakeven
 *     multiple at any mark: proceeds are `size*m - fee` and outlay is `size + fee`, so
 *     `size <= fee` never closes. That is Infinity, and a book that stores Infinity has
 *     handed the determiner a threshold it can never cross.
 * (2) `frictionXFor()` — the repo's single definition of round-trip friction, imported
 *     rather than restated — must produce a finite multiple >= 1 from the lamports that
 *     were actually paid. At the live cap that is 1.2222x with the fee inside the 0.005
 *     SOL budget and 1.2000x with it beside; at an observe-mode zero fee reserve it is
 *     exactly 1. Anything else means the lamports on the row do not describe a fill.
 *
 * The number is NOT stored. The book's job is to refuse a row it cannot price, not to
 * tell the determiner what breakeven is — two files holding two copies of one threshold
 * is how the copies diverge.
 */
function assertPriceable(record, mint) {
  const size = Number(record.sizeSol);
  const fee = Number(record.feeSolPerLeg);
  if (!(size > fee))
    refuse("economics_unpriceable",
      `no breakeven multiple exists: feeSolPerLeg ${fee} is not below sizeSol ${size}, so proceeds never reach outlay ` +
      "at any mark", { mint, sizeSol: size, feeSolPerLeg: fee });
  const feeLamports = solToLamports(fee);
  let friction;
  try {
    friction = frictionXFor({
      entryInputLamports: record.entryInputLamports,
      entryFeeLamports: feeLamports,
      expectedExitFeeLamports: feeLamports,
    });
  } catch (error) {
    refuse("economics_unpriceable",
      `the fill's round-trip friction could not be computed: ${error.message}`,
      { mint, entryInputLamports: record.entryInputLamports, feeLamports: feeLamports.toString() });
  }
  if (!Number.isFinite(friction) || friction < 1)
    refuse("economics_unpriceable", `round-trip friction is ${friction}, which is not a usable breakeven multiple`,
      { mint, friction });
  return friction;
}

/**
 * THE TICKET AND THE SWAP INPUT MUST DESCRIBE THE SAME FILL.
 *
 * `sizeSol` is the ticket; `entryInputLamports` is what actually reached the swap. The
 * spec names exactly two sizing conventions and the book admits both and nothing else:
 * the fee comes out of the ticket (0.005 SOL ticket, 4,500,000 lamports swapped) or it is
 * carried beside it (0.005 SOL ticket, 5,000,000 lamports swapped). So
 *
 *     sizeLamports - feeLamports  <=  entryInputLamports  <=  sizeLamports
 *
 * with one lamport of slack at each end for the float->lamport rounding of a `sizeSol`
 * that arrives as a Number. A row outside that window has two different fills written on
 * it, and `frictionX` computed from the wrong one is wrong in the direction that arms a
 * stop below cost.
 */
function assertEconomicsAgree(record, mint) {
  const sizeLamports = solToLamports(record.sizeSol);
  const feeLamports = solToLamports(record.feeSolPerLeg);
  const input = BigInt(record.entryInputLamports);
  const hi = sizeLamports + 1n;
  const lo = sizeLamports - feeLamports - 1n;
  if (input > hi || input < lo)
    refuse("economics_inconsistent",
      `entryInputLamports ${input} does not describe a ${record.sizeSol} SOL ticket paying ` +
      `${record.feeSolPerLeg} SOL a leg — the swap input must sit in [${lo < 0n ? 0n : lo}, ${hi}] lamports`,
      { mint, entryInputLamports: input.toString(), sizeLamports: sizeLamports.toString(),
        feeLamports: feeLamports.toString() });
  if (record.entryFeeLamports != null) {
    const declared = BigInt(record.entryFeeLamports);
    const drift = declared > feeLamports ? declared - feeLamports : feeLamports - declared;
    if (drift > 1n)
      refuse("economics_inconsistent",
        `entryFeeLamports ${declared} disagrees with feeSolPerLeg ${record.feeSolPerLeg} (${feeLamports} lamports)`,
        { mint, entryFeeLamports: declared.toString(), feeLamports: feeLamports.toString() });
  }
}

const finitePositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const finiteNonNegative = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Print a value the way it actually is. `JSON.stringify(NaN)` is `null` and
 *  `JSON.stringify(1n)` throws, and a refusal message that says "got null" about a NaN
 *  sends the reader looking for the wrong bug. */
const show = (v) => {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v) ?? String(v);
};

/** Compare one fixed-at-the-fill field across the stored row and a proposed update. Raw
 *  amounts are compared as NUMBERS OF LAMPORTS, not as text: the stored form is a digit
 *  string and a determiner that hands back `4500000n` or `4500000` has changed nothing,
 *  so a string comparison there would refuse an honest update and teach callers to skip
 *  this function. Everything else is `Object.is`. */
function sameFillValue(a, b) {
  if (Object.is(a, b)) return true;
  const big = (v) => {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
  };
  const x = big(a), y = big(b);
  return x !== null && y !== null && x === y;
}

/**
 * The whole shape test, run on a record that is already in durable form. Used by the
 * normalizer on what it just built AND by `assertLaneInvariant` on whatever is actually
 * in the book — including rows nobody filed through `openSnipe`. That second caller is
 * the point: a book is only as good as what it refuses to have been corrupted into.
 */
function assertSnipeRecord(record, { key = null } = {}) {
  if (!isPlainObject(record))
    refuse("snipe_invalid", `a snipe must be an object, got ${record === null ? "null" : typeof record}`,
      { mint: key });
  const mint = record.mint;
  if (!isAccountKey(mint))
    refuse("mint_invalid", `a snipe needs a base58 32-byte mint, got ${JSON.stringify(mint)}`, { mint: key });
  if (key !== null && key !== mint)
    refuse("book_key_mismatch", `S.snipes["${key}"] holds a position whose mint is ${mint}`, { mint, key });
  if (record.lane !== SNIPE_LANE)
    refuse("lane_invalid", `a snipe must carry lane "${SNIPE_LANE}", got ${JSON.stringify(record.lane)} — ` +
      "a row with the wrong lane tag is a row the wrong engine will step", { mint });
  if (!isNonEmptyString(record.venue))
    refuse("venue_invalid", `a snipe needs the venue it was filled on, got ${JSON.stringify(record.venue)} — ` +
      "the exit adapter is chosen by it", { mint });

  for (const field of REQUIRED_SNIPE_ECONOMICS)
    if (record[field] === undefined || record[field] === null)
      refuse("economics_missing",
        `a snipe is missing ${field}; snipe-policy.mjs prices every arm and every stop off ` +
        `[${REQUIRED_SNIPE_ECONOMICS.join(", ")}] and cannot decide about a position without them`,
        { mint, field });

  if (!finitePositive(record.entry))
    refuse("entry_invalid", `entry must be a positive finite number, got ${show(record.entry)}`,
      { mint, entry: record.entry });
  if (!finitePositive(record.openedAt))
    refuse("opened_at_invalid", `openedAt must be a positive epoch-ms number, got ${show(record.openedAt)}`,
      { mint, openedAt: record.openedAt });
  if (record.openedAtSlot != null &&
      !(Number.isInteger(record.openedAtSlot) && record.openedAtSlot >= 0))
    refuse("opened_at_invalid", `openedAtSlot must be a whole slot number, got ${show(record.openedAtSlot)}`,
      { mint, openedAtSlot: record.openedAtSlot });
  if (!finitePositive(record.sizeSol))
    refuse("economics_invalid", `sizeSol must be a positive finite number, got ${show(record.sizeSol)}`,
      { mint, sizeSol: record.sizeSol });
  if (!finiteNonNegative(record.feeSolPerLeg))
    refuse("economics_invalid",
      `feeSolPerLeg must be a finite number >= 0, got ${show(record.feeSolPerLeg)}`,
      { mint, feeSolPerLeg: record.feeSolPerLeg });

  for (const field of REQUIRED_SNIPE_PRICING)
    if (record[field] === undefined || record[field] === null)
      refuse(field === "qtyRaw" ? "quantity_unpriceable" : "entry_input_unpriceable",
        `a snipe is missing ${field}; markX = sellExactIn(curve, qtyRaw) / entryInputLamports, so without it the ` +
        "position has no mark and no price trigger can ever fire on it", { mint, field });
  storedRaw(record.qtyRaw, "qtyRaw", "quantity_unpriceable", mint);
  storedRaw(record.entryInputLamports, "entryInputLamports", "entry_input_unpriceable", mint);
  if (record.entryFeeLamports != null)
    storedRaw(record.entryFeeLamports, "entryFeeLamports", "economics_invalid", mint, { positive: false });

  if (record.creator != null && !isAccountKey(record.creator))
    refuse("creator_invalid",
      `creator must be a base58 32-byte key or null, got ${JSON.stringify(record.creator)} — the CREATOR-SOLD ` +
      "trigger compares against it", { mint, creator: record.creator });

  assertEconomicsAgree(record, mint);
  assertPriceable(record, mint);
  return mint;
}

/** `S.snipes ||= {}`, mirroring `poller.mjs:581` for `S.positions`. A null-prototype
 *  object is deliberately NOT used: the runtime is `structuredClone`d and JSON-serialised
 *  on the journal's write path, and a null prototype survives neither round trip
 *  unchanged. */
export function ensureSnipeBook(S) {
  if (!isPlainObject(S)) refuse("state_invalid", `the runtime state must be an object, got ${typeof S}`);
  if (S.snipes === undefined || S.snipes === null) S.snipes = {};
  if (!isPlainObject(S.snipes))
    refuse("book_invalid", `S.snipes must be an object keyed by mint, got ${Array.isArray(S.snipes) ? "an array" : typeof S.snipes}`);
  return S.snipes;
}

/** The sniper's `openList()`. It reads `S.snipes` and NOTHING ELSE — the desk's book is
 *  not consulted, cannot be returned, and `test-snipe-book.mjs` asserts that from this
 *  function's own source text as well as from its behaviour. */
export function snipeList(S) {
  if (!isPlainObject(S)) refuse("state_invalid", `the runtime state must be an object, got ${typeof S}`);
  const book = S.snipes;
  if (book === undefined || book === null) return Object.freeze([]);
  if (!isPlainObject(book))
    refuse("book_invalid", `S.snipes must be an object keyed by mint, got ${Array.isArray(book) ? "an array" : typeof book}`);
  return Object.freeze(Object.values(book));
}

/** One row, or null. Never falls through to the desk book. */
export function snipeFor(S, mint) {
  if (!isPlainObject(S)) refuse("state_invalid", `the runtime state must be an object, got ${typeof S}`);
  if (!isPlainObject(S.snipes)) return null;
  return Object.prototype.hasOwnProperty.call(S.snipes, mint) ? S.snipes[mint] : null;
}

const deskMints = (S) => {
  const positions = S?.positions;
  if (positions === undefined || positions === null) return [];
  if (!isPlainObject(positions))
    refuse("desk_book_invalid",
      `S.positions must be an object keyed by mint, got ${Array.isArray(positions) ? "an array" : typeof positions}`);
  /* Both the KEY and the row's own `mint` are collected. The desk keys by mint today
   * (`poller.mjs:1035`), but an invariant that trusts the key would miss a row filed
   * under something else, and the point of this function is to not have to trust. */
  const out = new Set(Object.keys(positions));
  for (const row of Object.values(positions))
    if (isPlainObject(row) && isNonEmptyString(row.mint)) out.add(row.mint);
  return [...out];
};

/**
 * THE INVARIANT. Three things, and a test rather than a convention for each:
 *
 *  1. NO MINT IS IN BOTH BOOKS. One mint held by two engines is two sell decisions
 *     against one token balance: the desk's `manageOpen` and the lane's `snipeStep` would
 *     each size an exit from a quantity the other is also selling, and the second one to
 *     sign spends a balance that is already gone. The books are disjoint or the process
 *     stops.
 *  2. EVERY OPEN SNIPE CARRIES THE FILL ECONOMICS THE DETERMINER NEEDS and can be priced
 *     — the full shape test above, run against whatever is actually in the book rather
 *     than against what `openSnipe` would have produced.
 *  3. EVERY KEY IS ITS ROW'S MINT, so `S.snipes[mint]` and `row.mint` can never name two
 *     different tokens.
 *
 * Pure: reads, never writes, no clock. Returns a frozen report so a caller can log the
 * counts it proved rather than the counts it assumed.
 */
export function assertLaneInvariant(S) {
  if (!isPlainObject(S)) refuse("state_invalid", `the runtime state must be an object, got ${typeof S}`);
  const book = S.snipes === undefined || S.snipes === null ? {} : S.snipes;
  if (!isPlainObject(book))
    refuse("book_invalid", `S.snipes must be an object keyed by mint, got ${Array.isArray(book) ? "an array" : typeof book}`);

  const mints = [];
  for (const [key, record] of Object.entries(book)) mints.push(assertSnipeRecord(record, { key }));

  const desk = new Set(deskMints(S));
  const collisions = mints.filter((mint) => desk.has(mint));
  if (collisions.length)
    refuse("cross_book_collision",
      `${collisions.length} mint(s) are open in BOTH books — ${collisions.join(", ")} — and two engines would each ` +
      "size an exit from a token balance the other is also selling", { mint: collisions[0], collisions });

  return Object.freeze({
    bookVersion: SNIPE_BOOK_VERSION,
    snipeCount: mints.length,
    deskCount: desk.size,
    snipeMints: Object.freeze([...mints]),
  });
}

/** Build the durable, frozen row from a caller's draft. The draft is never mutated. */
function normalizeSnipe(draft) {
  if (!isPlainObject(draft))
    refuse("snipe_invalid", `a snipe draft must be an object, got ${draft === null ? "null" : typeof draft}`);
  const mint = draft.mint;
  if (!isAccountKey(mint))
    refuse("mint_invalid", `a snipe needs a base58 32-byte mint, got ${JSON.stringify(mint)}`, { mint: null });
  if (draft.lane !== undefined && draft.lane !== SNIPE_LANE)
    refuse("lane_invalid",
      `this book files ${SNIPE_LANE} positions only; the draft declared lane ${JSON.stringify(draft.lane)}`, { mint });

  for (const field of REQUIRED_SNIPE_ECONOMICS)
    if (draft[field] === undefined || draft[field] === null)
      refuse("economics_missing",
        `a snipe is missing ${field}; snipe-policy.mjs prices every arm and every stop off ` +
        `[${REQUIRED_SNIPE_ECONOMICS.join(", ")}] and cannot decide about a position without them`,
        { mint, field });
  for (const field of REQUIRED_SNIPE_PRICING)
    if (draft[field] === undefined || draft[field] === null)
      refuse(field === "qtyRaw" ? "quantity_unpriceable" : "entry_input_unpriceable",
        `a snipe is missing ${field}; markX = sellExactIn(curve, qtyRaw) / entryInputLamports, so without it the ` +
        "position has no mark and no price trigger can ever fire on it", { mint, field });

  const { lane, mint: _mint, qtyRaw, entryInputLamports, entryFeeLamports, ...rest } = draft;
  const record = {
    ...rest,                                   // whatever the determiner wants to carry
    mint,
    lane: SNIPE_LANE,                          // stamped here, never taken from the caller
    qtyRaw: durableRaw(qtyRaw, "qtyRaw", "quantity_unpriceable", mint).text,
    entryInputLamports:
      durableRaw(entryInputLamports, "entryInputLamports", "entry_input_unpriceable", mint).text,
    bookVersion: SNIPE_BOOK_VERSION,
  };
  if (entryFeeLamports !== undefined && entryFeeLamports !== null)
    record.entryFeeLamports =
      durableRaw(entryFeeLamports, "entryFeeLamports", "economics_invalid", mint, { positive: false }).text;
  assertSnipeRecord(record);
  return Object.freeze(record);
}

/**
 * File a fill. Refuses anything the determiner could not decide about, anything the ruler
 * could not price, and any mint already open on either lane.
 *
 * FAIL-CLOSED, INCLUDING ON ITS OWN WRITE: the row goes in, the whole-book invariant is
 * re-run, and if that refuses the row is REMOVED before the error leaves this function.
 * A writer that throws and leaves its half-written row behind turns one refusal into a
 * permanently poisoned book, and the next caller inherits it.
 */
export function openSnipe(S, draft) {
  const book = ensureSnipeBook(S);
  const record = normalizeSnipe(draft);
  const mint = record.mint;
  if (Object.prototype.hasOwnProperty.call(book, mint))
    refuse("duplicate_snipe", `${mint} is already open in the snipe book — one mint, one position`, { mint });
  const desk = new Set(deskMints(S));
  if (desk.has(mint))
    refuse("cross_book_collision",
      `${mint} is already held by the DESK; a snipe on the same mint would size its exit from a token balance the ` +
      "desk is also selling", { mint });

  book[mint] = record;
  try { assertLaneInvariant(S); }
  catch (error) { delete book[mint]; throw error; }
  return record;
}

/**
 * Replace an open row with the determiner's updated one. The fill is immutable — see the
 * header — so every field in IMMUTABLE_SNIPE_FIELDS must match, and `qtyRaw` may only
 * fall. Everything else the determiner carries (a confirmed high, a witness record, an
 * armed flag) is free to move, which is the whole reason this exists rather than callers
 * assigning into `S.snipes` and skipping the shape test.
 */
export function updateSnipe(S, next) {
  const book = ensureSnipeBook(S);
  if (!isPlainObject(next))
    refuse("snipe_invalid", `an update must be an object, got ${next === null ? "null" : typeof next}`);
  const mint = next.mint;
  if (!Object.prototype.hasOwnProperty.call(book, mint))
    refuse("snipe_unknown", `${JSON.stringify(mint)} is not open in the snipe book`, { mint: mint ?? null });
  const before = book[mint];

  /* THE IMMUTABILITY TEST RUNS BEFORE THE SHAPE TEST, AND THE ORDER IS THE POINT. Change
   * `sizeSol` on an open row and the ticket no longer agrees with the swap input, so the
   * normalizer would refuse it first as `economics_inconsistent` — a true statement about
   * the row and the WRONG statement about what the caller did. The refusal has to name
   * the thing that actually happened: somebody tried to rewrite a fill. */
  for (const field of IMMUTABLE_SNIPE_FIELDS) {
    const a = before[field] ?? null, b = next[field] ?? null;
    if (!sameFillValue(a, b))
      refuse("immutable_field_changed",
        `${field} is fixed at the fill and may not change: ${show(a)} -> ${show(b)} — ` +
        "frictionX is a fact about the lamports that were actually paid", { mint, field, from: show(a), to: show(b) });
  }
  const candidate = normalizeSnipe({ ...next, lane: SNIPE_LANE });
  if (BigInt(candidate.qtyRaw) > BigInt(before.qtyRaw))
    refuse("quantity_increased",
      `qtyRaw may only fall: ${before.qtyRaw} -> ${candidate.qtyRaw} — a snipe sells part or all of a position and ` +
      "never adds to one", { mint, from: before.qtyRaw, to: candidate.qtyRaw });

  book[mint] = candidate;
  try { assertLaneInvariant(S); }
  catch (error) { book[mint] = before; throw error; }
  return candidate;
}

/**
 * Close a row and hand it back. The reason and the clock ARRIVE AS PARAMETERS — a book
 * that reads `Date.now()` cannot be replayed, and `test-snipe-replay.mjs` replays a
 * captured sample and asserts byte-identical decisions.
 *
 * This does not journal, does not sell and does not decide; it removes a position the
 * lane has already exited, so the mint is free for the desk (or for a later snipe) the
 * moment it is flat.
 */
export function closeSnipe(S, mint, { reason, closedAt, ...rest } = {}) {
  const book = ensureSnipeBook(S);
  if (!Object.prototype.hasOwnProperty.call(book, mint))
    refuse("snipe_unknown", `${JSON.stringify(mint)} is not open in the snipe book`, { mint: mint ?? null });
  if (!isNonEmptyString(reason))
    refuse("close_invalid", `closing ${mint} needs the reason it closed, got ${JSON.stringify(reason)} — ` +
      "a book row that leaves without one is an exit nobody can audit", { mint });
  if (!finitePositive(closedAt))
    refuse("close_invalid",
      `closing ${mint} needs closedAt as a positive epoch-ms number, got ${show(closedAt)} — this book ` +
      "never reads a clock of its own", { mint, closedAt });

  const position = book[mint];
  delete book[mint];
  /* SYMMETRIC WITH THE OTHER TWO WRITERS, AND FOR A SHARPER REASON. If some OTHER row in
   * the book is corrupt, the invariant throws here — after the delete. Without this
   * restore the caller would see a refusal and believe the close did not happen while the
   * position had in fact left the book, and a position that exists nowhere is a position
   * nothing will ever exit. Either the close happens and is returned, or the book is
   * exactly as it was. */
  try { assertLaneInvariant(S); }
  catch (error) { book[mint] = position; throw error; }
  return Object.freeze({
    bookVersion: SNIPE_BOOK_VERSION,
    mint, position, reason: String(reason), closedAt: Number(closedAt), ...rest,
  });
}
