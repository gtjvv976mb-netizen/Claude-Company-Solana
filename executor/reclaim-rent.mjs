#!/usr/bin/env node
/**
 * RECLAIM THE RENT SITTING IN EMPTY TOKEN ACCOUNTS.
 *
 * Every SPL token this wallet has ever held opened an associated token account, and
 * every one of those accounts locked about 0.002 SOL of rent to stay alive. Selling
 * the token empties the account; it does NOT close it. A bot that has round-tripped
 * a hundred launches is therefore a bot with a hundred empty accounts and a fifth of
 * a SOL it cannot spend — money that is neither lost nor available, which is the
 * worst of the two.
 *
 * Closing an empty account returns its rent to the owner. That is all this does.
 *
 *   node reclaim-rent.mjs                 look, and say what is reclaimable. Sends nothing.
 *   node reclaim-rent.mjs --send          close them and take the rent back.
 *
 * Options: --keypair FILE --rpc URL --state-db FILE --batch N --max N --json
 *
 * WHAT MAKES THIS SAFE IS NOT THIS FILE. The SPL Token program refuses to close an
 * account that still holds a balance — CloseAccount fails on a non-empty account, on
 * chain, whatever this process believed when it built the instruction. So the worst
 * case of a race with a live bot is a REJECTED TRANSACTION, never a burned token.
 * The checks below exist to avoid wasting fees and to stay out of the lane's way;
 * they are not what stands between you and losing a position.
 *
 * On top of that:
 *   · An account with a non-zero balance is never included.
 *   · A mint with an in-flight intent in the journal is never included, so this
 *     cannot close an account out from under a buy that is mid-signature.
 *   · Wrapped SOL is never included. The swap path opens and closes its own WSOL
 *     account as part of a trade, and that is the one account where interfering
 *     mid-flight is a real cost rather than a failed transaction.
 *   · It signs ONLY CloseAccount instructions. It never transfers, never swaps,
 *     never touches a mint, and has no path that can send SOL anywhere but back to
 *     the wallet that owns the accounts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./token2022.mjs";

const WSOL = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1e9;
/** SPL Token's CloseAccount. One byte of data, three accounts, no variants. */
const CLOSE_ACCOUNT_IX = 9;
/** Measured: a close costs ~3k CU. 8k each plus a floor leaves room and still fits. */
const CU_PER_CLOSE = 8000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const die = (msg) => { console.error(`reclaim-rent: ${msg}`); process.exit(1); };

const SEND = flag("--send");
const JSON_OUT = flag("--json");
const KEYPAIR_FILE = path.resolve(value("--keypair") || process.env.KEYPAIR || "./burner.json");
const RPC = value("--rpc") || process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const STATE_DB = path.resolve(value("--state-db") || process.env.STATE_DB || "./.cc-executor.sqlite");

function boundedInteger(name, raw, fallback, { min, max }) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) die(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
/* Twelve, not forty. A batch is all-or-nothing on chain: one account that stopped
   being empty between the read and the send takes every close in its transaction
   down with it. Small batches make that cost one retry instead of the whole run. */
const BATCH = boundedInteger("--batch", value("--batch"), 12, { min: 1, max: 24 });
const MAX = boundedInteger("--max", value("--max"), 1000, { min: 1, max: 100000 });

/* Same checks the poller and burner-backup make, for the same reason: a key that is
   group- or world-readable is a key that has already left the building. */
function loadKeypair() {
  let st;
  try { st = fs.lstatSync(KEYPAIR_FILE); } catch { die(`no keypair at ${KEYPAIR_FILE}`); }
  if (!st.isFile() || st.isSymbolicLink()) die("the keypair must be a regular, non-symlink file");
  if ((st.mode & 0o077) !== 0) die(`keypair permissions must be 0600 (chmod 600 ${KEYPAIR_FILE})`);
  let bytes;
  try { bytes = JSON.parse(fs.readFileSync(KEYPAIR_FILE, "utf8")); }
  catch { die("the keypair is not readable JSON"); }
  if (!Array.isArray(bytes) || bytes.length !== 64) die("the keypair is not a 64-byte Solana secret key array");
  try { return Keypair.fromSecretKey(Uint8Array.from(bytes)); }
  catch { die("the keypair does not contain a valid Solana secret key"); }
}

/**
 * Mints the journal believes are mid-flight — an intent that is signed, submitted,
 * confirmed or ambiguous. Their accounts are left alone even when they read empty,
 * because "empty" and "the buy has not landed yet" look identical from here.
 *
 * A missing or unreadable journal is NOT fatal and NOT silently ignored: this tool
 * is useful on a host where the bot never ran, and the caller is told plainly that
 * the in-flight guard could not be applied so they can decide.
 */
export function inFlightMints(db) {
  const rows = db.prepare(`SELECT DISTINCT mint FROM intents
    WHERE state IN ('signed','submitted','confirmed','ambiguous') AND mint IS NOT NULL`).all();
  return new Set(rows.map((r) => String(r.mint)));
}

/** CloseAccount: close `account`, send its lamports to `destination`, signed by `owner`. */
export function closeAccountInstruction({ programId, account, destination, owner }) {
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(destination), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT_IX]),
  });
}

/**
 * Split the wallet's token accounts into the ones worth closing and the ones that are
 * deliberately left. Pure, so the refusal reasons can be tested without a chain.
 *
 * `accounts` are getTokenAccountsByOwner jsonParsed values.
 */
export function selectClosable(accounts, { inFlight = new Set(), max = Infinity } = {}) {
  const closable = [], skipped = [];
  for (const entry of accounts) {
    const info = entry?.account?.data?.parsed?.info;
    const pubkey = String(entry?.pubkey ?? "");
    const mint = String(info?.mint ?? "");
    const amount = String(info?.tokenAmount?.amount ?? "");
    const lamports = Number(entry?.account?.lamports ?? 0);
    const programId = String(entry?.programId ?? entry?.account?.owner ?? "");
    const note = (reason) => skipped.push({ pubkey, mint, amount, lamports, reason });
    if (!pubkey || !mint || !programId) { note("unreadable account"); continue; }
    if (mint === WSOL || info?.isNative) { note("wrapped SOL — the swap path owns this one"); continue; }
    if (amount !== "0") { note(`holds ${amount}`); continue; }
    if (inFlight.has(mint)) { note("an intent for this mint is in flight"); continue; }
    if (!(lamports > 0)) { note("no rent to reclaim"); continue; }
    if (closable.length >= max) { note("over --max for this run"); continue; }
    closable.push({ pubkey, mint, lamports, programId });
  }
  return { closable, skipped };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const isEntrypoint = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntrypoint) {
  const kp = loadKeypair();
  const owner = kp.publicKey.toBase58();
  const conn = new Connection(RPC, "confirmed");

  let inFlight = new Set(), journalRead = true;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    inFlight = inFlightMints(new DatabaseSync(STATE_DB, { readOnly: true }));
  } catch { journalRead = false; }

  const accounts = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey(programId) });
    for (const v of res.value) accounts.push({ ...v, pubkey: v.pubkey.toBase58(), programId });
  }

  const { closable, skipped } = selectClosable(accounts, { inFlight, max: MAX });
  const rent = closable.reduce((n, a) => n + a.lamports, 0);
  const before = await conn.getBalance(kp.publicKey);

  if (JSON_OUT) {
    console.log(JSON.stringify({ owner, accounts: accounts.length, closable: closable.length,
      reclaimableLamports: rent, reclaimableSol: rent / LAMPORTS, journalRead, sent: SEND }, null, 2));
  } else {
    console.log(`wallet          ${owner}`);
    console.log(`balance         ${(before / LAMPORTS).toFixed(6)} SOL`);
    console.log(`token accounts  ${accounts.length}`);
    console.log(`empty & closable ${closable.length}`);
    console.log(`rent locked in them  ${(rent / LAMPORTS).toFixed(6)} SOL`);
    if (!journalRead)
      console.log(`NOTE: no readable journal at ${STATE_DB}, so the in-flight guard was NOT applied.`);
    const reasons = new Map();
    for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) || 0) + 1);
    for (const [reason, n] of reasons) console.log(`left alone      ${n}  ${reason}`);
  }

  if (!SEND) {
    if (!JSON_OUT) console.log(closable.length
      ? `\nNothing was sent. Run again with --send to close them and take the ${(rent / LAMPORTS).toFixed(6)} SOL back.`
      : "\nNothing to reclaim.");
    process.exit(0);
  }
  if (!closable.length) process.exit(0);

  let closed = 0, failed = 0;
  for (const group of chunk(closable, BATCH)) {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 10000 + CU_PER_CLOSE * group.length }));
    for (const a of group)
      tx.add(closeAccountInstruction({ programId: a.programId, account: a.pubkey, destination: owner, owner }));
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = kp.publicKey;
      tx.sign(kp);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      closed += group.length;
      if (!JSON_OUT) console.log(`closed ${String(closed).padStart(4)}  ${sig}`);
    } catch (error) {
      failed += group.length;
      /* Named, not swallowed. The likeliest cause is the good one: an account stopped
         being empty between the read and the send, and the program said no. */
      if (!JSON_OUT) console.log(`batch of ${group.length} refused — ${error?.message || error}`);
    }
  }

  const after = await conn.getBalance(kp.publicKey);
  if (JSON_OUT) {
    console.log(JSON.stringify({ owner, closed, failed,
      recoveredLamports: after - before, recoveredSol: (after - before) / LAMPORTS }, null, 2));
  } else {
    console.log(`\nclosed ${closed}, refused ${failed}`);
    console.log(`balance ${(before / LAMPORTS).toFixed(6)} -> ${(after / LAMPORTS).toFixed(6)} SOL ` +
      `(${((after - before) / LAMPORTS).toFixed(6)} recovered, net of fees)`);
  }
}
