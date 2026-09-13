/**
 * THE LAUNCH LANE'S SIGNING PATH — the one file in the sniper that holds a key.
 *
 * snipe-lane.mjs decides; this file executes, and it is reached only as a port handed into
 * createSnipeLane({ executor }) on a live install. The lane's own test scans its source
 * for Keypair, sendRawTransaction and the rest and must keep finding nothing, which is why
 * every one of those words lives here and nowhere upstream.
 *
 * WHAT A BUY IS, END TO END, AND WHY EACH STEP IS WHERE IT IS:
 *
 *   1. GATES FIRST. The owner's pause and hard-stop sentinels, the launchd power proof
 *      (injected as `boundary`, the same function the desk runs before its own entries),
 *      and the journal's exposure lock: an unresolved intent on ANY mint freezes new
 *      exposure on BOTH lanes, because the wallet is one wallet.
 *   2. THE INTENT BEFORE THE BYTES. snipe-entry:<mint> is written to the journal as
 *      `planned` with the plan in its context, so a crash at any later step leaves a row
 *      that says what was about to happen. Immutable fields (mint, amount) cannot be
 *      replayed with different numbers.
 *   3. ONE TRANSACTION: compute budget, an idempotent ATA create for the base mint, and
 *      the venue's buy_v2 — the exact instruction the entry contract already decoded back
 *      (gate 20). Nothing is rebuilt between the check and the signature.
 *   4. SIMULATED ON BOTH RPCs IN PARALLEL, unsigned, with the wallet and the ATA returned
 *      post-state. The custody rule is the desk's: SOL out may not exceed the ceiling plus
 *      the fee cap plus the rent cap, the base delivered must be at least what the
 *      instruction asked for, and the two providers must agree on the spend within 1%.
 *      A provider that errs, disagrees, or shows an unexplained drain refuses the buy.
 *   5. SIGNED, JOURNALED, THEN SENT. recordSigned() stores the bytes and the signature
 *      under the sniper's own protocol marker before any RPC sees them, so recovery can
 *      tell a curve buy from a Jupiter order and never reconciles one with the other's
 *      rules. Sent raw to both RPCs at once with preflight skipped — the simulation above
 *      was the preflight, and a second one on the send path is latency spent to learn
 *      what is already known.
 *   6. CONFIRMED FAST, FINALIZED IN THE BACKGROUND. The fill is read from the confirmed
 *      transaction's own balances — what the chain charged and delivered, never the plan —
 *      and returned to the lane the moment the cluster has confirmed it, so the position
 *      is under management within a second of landing. Finality is awaited afterwards
 *      and the journal moves to confirmed/accounted only then; a confirmed transaction
 *      that fails to finalize is logged as loudly as this file can, because it means the
 *      book holds a position the chain does not.
 *
 * A SELL is the same path on sell_v2 for the whole position, with the exit's floor set
 * from the curve's own quote less the exit tolerance. A hard stop refuses sells as it
 * refuses everything (the README's rule: no automated submissions of any kind); a pause
 * refuses buys only.
 *
 * RECOVERY. On boot the poller asks this file to recover the sniper's own pending intents
 * — signed or submitted attempts are checked against the chain and moved to confirmed,
 * expired or ambiguous, exactly as jupiter.mjs does for the desk's, and jupiter.mjs skips
 * snipe_* kinds for the same reason this file never touches the desk's.
 *
 * LATENCY. Every network call that can run beside another does: the pre-state read and
 * the blockhash, the two simulations, the two sends, and the status polls at a quarter
 * second. The one serial dependency that cannot be removed is sign-after-simulate.
 */
import {
  ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage,
  VersionedTransaction, SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

import { associatedTokenAddress, ATA_PROGRAM, WSOL } from "./jupiter.mjs";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./token2022.mjs";
import { decodeGlobalFeeRecipients } from "./snipe-venue-pumpfun.mjs";
import { SNIPE_TX_ATTEMPT_PROTOCOL } from "./journal.mjs";

export const SNIPE_EXECUTE_VERSION = "snipe-execute-v1";
/** The provenance marker on every tx_attempts row this file writes. Never the desk's; the
 *  journal owns the name so it can refuse any marker it was not taught. */
export const SNIPE_TX_PROTOCOL = SNIPE_TX_ATTEMPT_PROTOCOL;

export const SNIPE_EXECUTE_CLAUSES = Object.freeze([
  "port_invalid",        // the executor could not be built: no key, one RPC, no journal
  "refused",             // a gate said no before any bytes existed
  "exposure_frozen",     // an unresolved journal intent locks new exposure
  "in_flight",           // this mint already has an unresolved attempt
  "prepare_failed",      // the instruction could not be built from the read
  "simulation_failed",   // a provider erred, disagreed, or showed an unexplained drain
  "send_failed",         // no provider accepted the bytes
  "expired",             // the blockhash lifetime passed with no status on either provider
  "failed_on_chain",     // the transaction landed and errored
  "ambiguous",           // the chain could not be read to a verdict inside the timeout
  "malformed",           // an argument this file cannot act on
]);

export class SnipeExecuteError extends Error {
  constructor(clause, message, detail = {}) {
    super(message);
    this.name = "SnipeExecuteError";
    if (!SNIPE_EXECUTE_CLAUSES.includes(clause))
      throw new Error(`SnipeExecuteError given clause ${JSON.stringify(clause)}, which is not in SNIPE_EXECUTE_CLAUSES`);
    this.clause = clause;
    this.detail = Object.freeze({ ...detail });
  }
}

export const SNIPE_EXECUTE_DEFAULTS = Object.freeze({
  /* Requested compute, and what it is bid at. A pump.fun buy_v2 with an ATA create runs
     well under this on mainnet; the request is what the scheduler ranks the bid by, so it
     is kept close to the need rather than at the 1.4M default. */
  computeUnitLimit: 260_000,
  /* microlamports per CU. Multiplied by the limit above this is the priority fee; the lane's
     priorityFeeLamports dial, when set, overrides it as a total and is divided back. */
  computeUnitPriceMicroLamports: 5_000,
  maxNetworkFeeLamports: 2_000_000,
  maxRentLamports: 4_200_000,
  /* The exit floor below the curve's own quote. Ten percent: a launch's book moves in
     slots, and a sell refused by its own floor is a position still held. */
  exitSlippageBps: 1_000,
  /* Both providers must put the simulated spend within this of each other. */
  providerAgreementPct: 1,
  statusPollMs: 250,
  confirmTimeoutMs: 25_000,
  finalityTimeoutMs: 90_000,
});

const ZERO_KEY = "11111111111111111111111111111111";
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const LAMPORTS = 1_000_000_000n;
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isRaw = (v) => /^\d+$/.test(String(v ?? ""));

const toBig = (value, label) => {
  if (typeof value === "bigint") return value;
  if (!isRaw(value)) throw new SnipeExecuteError("malformed", `${label} must be a non-negative integer, got ${JSON.stringify(String(value))}`);
  return BigInt(String(value));
};

const ownerOf = (account) => {
  const o = account?.owner;
  if (!o) return null;
  return typeof o === "string" ? o : (typeof o.toBase58 === "function" ? o.toBase58() : String(o));
};

const bytesOf = (data) => {
  if (data == null) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "base64");
  if (Array.isArray(data) && typeof data[0] === "string") return Buffer.from(data[0], data[1] || "base64");
  return null;
};

/** The u64 amount of an SPL or Token-2022 token account, or 0n for an absent/foreign one. */
export function tokenAmountOf(account, { mint = null, owner = null } = {}) {
  if (!account) return 0n;
  const program = ownerOf(account);
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) return 0n;
  const data = bytesOf(account.data);
  if (!data || data.length < 72) return 0n;
  if (mint && new PublicKey(data.subarray(0, 32)).toBase58() !== mint) return 0n;
  if (owner && new PublicKey(data.subarray(32, 64)).toBase58() !== owner) return 0n;
  return data.readBigUInt64LE(64);
}

/** The idempotent associated-token-account create, hand-encoded: one byte of data, and
 *  the six accounts the ATA program documents. A pre-existing account is a no-op. */
export function createAtaIdempotentIx({ payer, ata, owner, mint, tokenProgram }) {
  return new TransactionInstruction({
    programId: new PublicKey(ATA_PROGRAM),
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** The venue's plain {programId, keys, data} instruction as web3's TransactionInstruction. */
export function toTransactionInstruction(ix) {
  if (!isPlainObject(ix) || !ix.programId || !Array.isArray(ix.keys))
    throw new SnipeExecuteError("malformed", "the venue instruction has no program id or key list");
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner === true, isWritable: k.isWritable === true })),
    data: Buffer.from(ix.data),
  });
}

/**
 * Read the fill out of a landed transaction's own balances. Payer is account 0 by
 * construction (this file builds every message with the wallet as payer).
 *   spentLamports  — everything that left the wallet, fee included (the cost basis)
 *   feeLamports    — the network fee the chain charged
 *   rentLamports   — lamports that funded accounts which did not exist before
 *   quoteInRaw     — spent less fee less rent: what actually went into the curve
 *   qtyRaw         — base tokens the wallet gained (buy) or lost (sell)
 */
export function fillFromTransaction(tx, { wallet, mint, side }) {
  const meta = tx?.meta;
  if (!meta) throw new SnipeExecuteError("malformed", "the transaction has no meta");
  if (meta.err) throw new SnipeExecuteError("failed_on_chain", `the transaction landed and failed: ${JSON.stringify(meta.err)}`);
  const pre = meta.preBalances, post = meta.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length || !pre.length)
    throw new SnipeExecuteError("malformed", "the transaction has no balance arrays");
  const fee = BigInt(meta.fee ?? 0);
  const payerDelta = BigInt(pre[0]) - BigInt(post[0]);          // positive when SOL left
  let rent = 0n;
  for (let i = 1; i < pre.length; i++) {
    const before = BigInt(pre[i]), after = BigInt(post[i]);
    if (before === 0n && after > 0n) rent += after;              // a brand-new account was funded
  }
  const amountFor = (list) => {
    let total = 0n;
    for (const b of list ?? []) {
      if (b?.mint === mint && b?.owner === wallet && b?.uiTokenAmount?.amount != null)
        total += BigInt(b.uiTokenAmount.amount);
    }
    return total;
  };
  const baseBefore = amountFor(meta.preTokenBalances);
  const baseAfter = amountFor(meta.postTokenBalances);
  if (side === "buy") {
    const qtyRaw = baseAfter - baseBefore;
    if (qtyRaw <= 0n) throw new SnipeExecuteError("malformed", "the buy delivered no base tokens to the wallet");
    const spent = payerDelta;
    const quoteIn = spent - fee - rent;
    if (quoteIn <= 0n) throw new SnipeExecuteError("malformed", `the buy spent ${spent} lamports but fee ${fee} plus rent ${rent} leaves no swap input`);
    return Object.freeze({ side, qtyRaw: qtyRaw.toString(), spentLamports: spent.toString(),
      feeLamports: fee.toString(), rentLamports: rent.toString(), quoteInRaw: quoteIn.toString(),
      slot: Number(tx.slot) || null });
  }
  const sold = baseBefore - baseAfter;
  if (sold <= 0n) throw new SnipeExecuteError("malformed", "the sell moved no base tokens out of the wallet");
  const gross = (-payerDelta) + fee;                              // proceeds before the fee
  if (gross <= 0n) throw new SnipeExecuteError("malformed", "the sell returned no SOL to the wallet");
  return Object.freeze({ side, qtyRaw: sold.toString(), quoteOutRaw: gross.toString(),
    feeLamports: fee.toString(), rentLamports: rent.toString(), slot: Number(tx.slot) || null });
}

/**
 * Build the executor. Every dependency is handed in; nothing here opens a connection or
 * reads a file, so a test drives it with fakes and the poller with the real ones.
 *
 *   keypair      — the burner (web3 Keypair); its public key is the wallet this signs for
 *   connections  — [primary, secondary] web3 Connections; both simulate, both send
 *   journal      — the ExecutionJournal, shared with the desk on purpose (one wallet)
 *   venue        — the pump.fun adapter (encoders reachable — the lane hands the armed one)
 *   control      — () => ({ hardStop, pauseEntries }), the desk's own sentinel readers
 *   boundary     — ({ side }) => void, throws to refuse; the desk's entry boundary proof
 *   runtime      — () => the poller's runtime state for accounting, or null
 *   persist      — () => void, the poller's save(); called after every journal move
 */
export function createSnipeExecutor({
  keypair, connections = [], journal, venue, cfg = {},
  control = () => ({ hardStop: false, pauseEntries: false }),
  boundary = () => {},
  runtime = () => null,
  persist = () => {},
  clock = () => Date.now(),
  sleep = sleepDefault,
  log = () => {},
} = {}) {
  if (!keypair || typeof keypair.publicKey?.toBase58 !== "function" || !(keypair.secretKey?.length > 0))
    throw new SnipeExecuteError("port_invalid", "a signing keypair is required");
  if (!Array.isArray(connections) || connections.length < 2 ||
      connections.some((c) => !c || typeof c.simulateTransaction !== "function" || typeof c.sendRawTransaction !== "function"))
    throw new SnipeExecuteError("port_invalid",
      "two RPC connections are required: both simulate and both send, and one lying node must not be the whole story");
  if (!journal || typeof journal.ensureIntent !== "function" || typeof journal.recordSigned !== "function")
    throw new SnipeExecuteError("port_invalid", "an ExecutionJournal is required");
  if (!venue || typeof venue.buyIx !== "function" || typeof venue.sellIx !== "function" || typeof venue.accountsFor !== "function")
    throw new SnipeExecuteError("port_invalid", "a venue with reachable buyIx/sellIx encoders is required");

  const conf = Object.freeze({ ...SNIPE_EXECUTE_DEFAULTS, ...cfg });
  const wallet = keypair.publicKey.toBase58();
  const [primary, secondary] = connections;
  const counters = { signed: 0, sent: 0, confirmed: 0, finalized: 0, failed: 0, expired: 0, ambiguous: 0, refused: 0 };
  const inFlight = new Set();

  const feeForUnits = () => {
    const total = Number(conf.priorityFeeLamports);
    const units = Number(conf.computeUnitLimit);
    if (Number.isFinite(total) && total > 0 && units > 0)
      return Math.max(1, Math.round((total * 1_000_000) / units));
    return Math.max(1, Math.round(Number(conf.computeUnitPriceMicroLamports) || 1));
  };

  const gate = (side) => {
    const c = control() ?? {};
    if (c.hardStop === true)
      throw new SnipeExecuteError("refused", "HARD STOP is present — no automated submission of any kind");
    if (side === "buy" && c.pauseEntries === true)
      throw new SnipeExecuteError("refused", "entries are paused — no new exposure");
    try { boundary({ side }); }
    catch (error) { throw new SnipeExecuteError("refused", `the entry boundary refused: ${error?.message ?? error}`); }
  };

  const pickRecipient = (list, label) => {
    const hit = (list ?? []).find((k) => typeof k === "string" && k !== ZERO_KEY);
    if (!hit) throw new SnipeExecuteError("prepare_failed", `the Global account names no ${label}`);
    return hit;
  };

  /**
   * The buy instruction, from the lane's own two-endpoint read: the Global account's fee
   * recipient sets, the mint's token program, and the wallet's ATA. Pure and synchronous;
   * the lane calls it before the entry contract so gate 20 can decode these exact bytes.
   */
  function prepareBuy({ mint, curve, read, baseOutRaw, maxQuoteInRaw }) {
    if (!isPlainObject(curve)) throw new SnipeExecuteError("prepare_failed", "a decoded curve is required");
    const accounts = read?.accounts ?? [];
    const global = accounts[1], mintAccount = accounts[2];
    if (!global?.data) throw new SnipeExecuteError("prepare_failed", "the Global account was not in the read");
    if (!mintAccount) throw new SnipeExecuteError("prepare_failed", "the mint account was not in the read");
    const baseTokenProgram = ownerOf(mintAccount);
    if (baseTokenProgram !== TOKEN_PROGRAM && baseTokenProgram !== TOKEN_2022_PROGRAM)
      throw new SnipeExecuteError("prepare_failed", `the mint is owned by ${baseTokenProgram}, not a token program`);
    const sets = decodeGlobalFeeRecipients(bytesOf(global.data));
    const feeRecipient = pickRecipient(sets.feeRecipients, "fee recipient");
    const buybackFeeRecipient = pickRecipient(sets.buybackFeeRecipients, "buyback fee recipient");
    const associatedBaseUser = associatedTokenAddress(wallet, mint, baseTokenProgram);
    const amountRaw = toBig(baseOutRaw, "baseOutRaw");
    const ceiling = toBig(maxQuoteInRaw, "maxQuoteInRaw");
    if (amountRaw <= 0n || ceiling <= 0n) throw new SnipeExecuteError("prepare_failed", "the plan has no quantity or no ceiling");
    const instruction = venue.buyIx({
      mint, user: wallet, curve, curveReadSlot: read?.slot ?? null, buildingForSlot: read?.slot ?? null,
      feeRecipient, buybackFeeRecipient, baseTokenProgram, quoteTokenProgram: TOKEN_PROGRAM,
      associatedBaseUser, associatedBaseUserOwner: wallet, globalFeeRecipients: sets,
      amountRaw, maxQuoteInRaw: ceiling,
    });
    return Object.freeze({
      instruction, associatedBaseUser, baseTokenProgram, feeRecipient, buybackFeeRecipient,
      globalFeeRecipients: sets, curveReadSlot: read?.slot ?? null,
      baseOutRaw: amountRaw.toString(), maxQuoteInRaw: ceiling.toString(),
    });
  }

  /** A sell instruction from a fresh single-provider read of Global and the mint. */
  async function prepareSell({ mint, curve, curveReadSlot, qtyRaw, minQuoteOutRaw }) {
    const addresses = venue.accountsFor(mint).map((a) => new PublicKey(String(a)));
    const res = await primary.getMultipleAccountsInfoAndContext(addresses, { commitment: "processed" });
    const accounts = res?.value ?? [];
    const global = accounts[1], mintAccount = accounts[2];
    if (!global?.data) throw new SnipeExecuteError("prepare_failed", "the Global account could not be read");
    const baseTokenProgram = ownerOf(mintAccount);
    if (baseTokenProgram !== TOKEN_PROGRAM && baseTokenProgram !== TOKEN_2022_PROGRAM)
      throw new SnipeExecuteError("prepare_failed", `the mint is owned by ${baseTokenProgram}, not a token program`);
    const sets = decodeGlobalFeeRecipients(bytesOf(global.data));
    const associatedBaseUser = associatedTokenAddress(wallet, mint, baseTokenProgram);
    const slot = Number(res?.context?.slot);
    const instruction = venue.sellIx({
      mint, user: wallet, curve,
      curveReadSlot: Number.isFinite(Number(curveReadSlot)) ? Number(curveReadSlot) : slot,
      buildingForSlot: Number.isFinite(Number(curveReadSlot)) ? Number(curveReadSlot) : slot,
      feeRecipient: pickRecipient(sets.feeRecipients, "fee recipient"),
      buybackFeeRecipient: pickRecipient(sets.buybackFeeRecipients, "buyback fee recipient"),
      baseTokenProgram, quoteTokenProgram: TOKEN_PROGRAM,
      associatedBaseUser, associatedBaseUserOwner: wallet, globalFeeRecipients: sets,
      amountRaw: toBig(qtyRaw, "qtyRaw"), minQuoteOutRaw: toBig(minQuoteOutRaw, "minQuoteOutRaw"),
    });
    return Object.freeze({ instruction, associatedBaseUser, baseTokenProgram, slot });
  }

  async function buildTransaction(instructions) {
    const { blockhash, lastValidBlockHeight } = await primary.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: keypair.publicKey, recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: Number(conf.computeUnitLimit) }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: feeForUnits() }),
        ...instructions,
      ],
    }).compileToV0Message();
    return { tx: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
  }

  /**
   * Both providers simulate the unsigned bytes and return the wallet and the ATA
   * afterwards. Returns the agreed spend and delivery, or refuses.
   */
  async function simulateBoth({ tx, ata, mint, side, expected }) {
    const addresses = [wallet, ata];
    const runs = await Promise.allSettled(connections.map((c) =>
      c.simulateTransaction(tx, {
        sigVerify: false, replaceRecentBlockhash: false, commitment: "processed",
        accounts: { encoding: "base64", addresses },
      })));
    const views = runs.map((r, i) => {
      if (r.status !== "fulfilled") return { id: i === 0 ? "primary" : "secondary", error: String(r.reason?.message ?? r.reason) };
      const v = r.value?.value;
      if (v?.err) return { id: i === 0 ? "primary" : "secondary", error: `simulation failed: ${JSON.stringify(v.err)}` +
        (Array.isArray(v.logs) ? ` — ${v.logs.slice(-3).join(" | ")}` : "") };
      const post = v?.accounts;
      if (!Array.isArray(post) || post.length !== addresses.length)
        return { id: i === 0 ? "primary" : "secondary", error: "simulation omitted the requested accounts" };
      return { id: i === 0 ? "primary" : "secondary", walletLamports: BigInt(post[0]?.lamports ?? 0),
        base: tokenAmountOf(post[1] ? { owner: post[1].owner, data: post[1].data } : null, { mint, owner: wallet }),
        units: Number(v.unitsConsumed) || null };
    });
    const bad = views.filter((v) => v.error);
    if (bad.length)
      throw new SnipeExecuteError("simulation_failed",
        bad.map((v) => `${v.id}: ${v.error}`).join("; "), { views });
    const spends = views.map((v) => expected.preLamports - v.walletLamports);
    const deltas = views.map((v) => side === "buy" ? v.base - expected.preBase : expected.preBase - v.base);
    const [a, b] = spends;
    const tolerance = (x) => (x < 0n ? -x : x) * 100n <= (a < 0n ? -a : a) * BigInt(Math.round(Number(conf.providerAgreementPct)));
    if (!tolerance(a - b))
      throw new SnipeExecuteError("simulation_failed",
        `the two providers disagree on the spend: ${a} vs ${b} lamports — not acting on one node's word`, { spends: spends.map(String) });
    const spend = a > b ? a : b;                                   // the worse of the two
    const delta = deltas[0] < deltas[1] ? deltas[0] : deltas[1];  // the lesser delivery
    if (side === "buy") {
      const allowance = expected.maxQuoteInRaw + BigInt(conf.maxNetworkFeeLamports) + BigInt(conf.maxRentLamports);
      if (spend > allowance)
        throw new SnipeExecuteError("simulation_failed",
          `the buy would spend ${spend} lamports against a ceiling of ${expected.maxQuoteInRaw} plus ` +
          `${conf.maxNetworkFeeLamports} fee cap and ${conf.maxRentLamports} rent cap — an unexplained drain`);
      if (delta < expected.baseOutRaw)
        throw new SnipeExecuteError("simulation_failed",
          `the buy would deliver ${delta} base against the ${expected.baseOutRaw} the instruction asked for`);
    } else {
      if (delta !== expected.qtyRaw)
        throw new SnipeExecuteError("simulation_failed",
          `the sell would move ${delta} base, not the ${expected.qtyRaw} the position holds`);
      const proceeds = -spend;                                      // SOL gained
      if (proceeds < expected.minQuoteOutRaw - BigInt(conf.maxNetworkFeeLamports))
        throw new SnipeExecuteError("simulation_failed",
          `the sell would return ${proceeds} lamports, under the ${expected.minQuoteOutRaw} floor less the fee cap`);
    }
    return Object.freeze({ spend, delta, units: views.map((v) => v.units) });
  }

  async function readEither(fn) {
    try { const v = await fn(primary); if (v != null) return v; } catch { /* fall through */ }
    return fn(secondary);
  }

  async function statusOf(signature) {
    return readEither(async (c) => {
      const r = await c.getSignatureStatuses([signature], { searchTransactionHistory: false });
      return r?.value?.[0] ?? null;
    });
  }

  async function blockHeight() {
    const heights = await Promise.allSettled(connections.map((c) => c.getBlockHeight("confirmed")));
    const ok = heights.filter((h) => h.status === "fulfilled").map((h) => Number(h.value)).filter(Number.isFinite);
    return ok.length ? Math.max(...ok) : null;
  }

  async function transactionAt(signature, commitment) {
    return readEither((c) => c.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 }));
  }

  /** Poll to a confirmed (or better) status, an on-chain error, or expiry. */
  async function awaitConfirmed({ signature, lastValidBlockHeight }) {
    const deadline = clock() + Number(conf.confirmTimeoutMs);
    for (;;) {
      let status = null;
      try { status = await statusOf(signature); } catch { status = null; }
      if (status) {
        if (status.err) return { outcome: "failed", err: status.err };
        const s = status.confirmationStatus;
        if (s === "confirmed" || s === "finalized" || status.confirmations === null) return { outcome: "confirmed", status };
      }
      const height = await blockHeight();
      if (height != null && height > Number(lastValidBlockHeight)) {
        // One more look: a status can land in the same window the height passed.
        try { status = await statusOf(signature); } catch { status = null; }
        if (status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus))
          return { outcome: "confirmed", status };
        if (status?.err) return { outcome: "failed", err: status.err };
        return { outcome: "expired" };
      }
      if (clock() >= deadline) return { outcome: "pending" };
      await sleep(Number(conf.statusPollMs));
    }
  }

  async function awaitFinalized(signature) {
    const deadline = clock() + Number(conf.finalityTimeoutMs);
    for (;;) {
      let status = null;
      try { status = await statusOf(signature); } catch { status = null; }
      const done = status && (status.confirmationStatus === "finalized" || status.confirmations === null);
      if (done) {
        if (status.err) return { outcome: "failed", err: status.err };
        const tx = await transactionAt(signature, "finalized").catch(() => null);
        if (tx) return { outcome: "finalized", tx };
      }
      if (clock() >= deadline) return { outcome: "pending" };
      await sleep(1_000);
    }
  }

  /** Finality bookkeeping, off the trade path. */
  async function finalizeInBackground({ intentId, attemptNo, signature, side, mint, fill }) {
    try {
      const result = await awaitFinalized(signature);
      if (result.outcome === "finalized") {
        const final = fillFromTransaction(result.tx, { wallet, mint, side });
        /* `signature` rides in the fill: the journal writes it onto the intent row, and a
           fill without it is a bind error that left every finalized buy stuck at
           `submitted` — still blocking new exposure — until this test caught it. */
        journal.markConfirmed(intentId, attemptNo, {
          totalInputAmount: side === "buy" ? final.quoteInRaw : final.qtyRaw,
          totalOutputAmount: side === "buy" ? final.qtyRaw : final.quoteOutRaw,
          networkFeeLamports: final.feeLamports, finalizedAtMs: clock(), signature,
        }, { protocol: SNIPE_TX_PROTOCOL, signature, slot: final.slot });
        counters.finalized++;
        const rt = runtime();
        if (rt && rt.state !== undefined && rt.positions) {
          try { journal.markAccounted(intentId, rt); }
          catch (error) { log(`snipe execute ${mint}: accounting deferred — ${error?.message ?? error}`); }
        }
        try { persist(); } catch { /* the poller's own save logs itself */ }
        return;
      }
      if (result.outcome === "failed") {
        counters.failed++;
        const tx = await transactionAt(signature, "finalized").catch(() => null);
        journal.markFinalizedFailure(intentId, attemptNo, `finalized with error ${JSON.stringify(result.err)}`,
          { networkFeeLamports: Number(tx?.meta?.fee ?? 0), finalizedAtMs: clock() }, { signature });
        log(`snipe execute ${mint}: ${side.toUpperCase()} ${signature} was CONFIRMED and then FINALIZED AS FAILED — ` +
          `the book ${side === "buy" ? "holds a position the chain does not" : "closed a position the chain still holds"}; ` +
          "review the wallet by hand");
        try { persist(); } catch { /* logged by the poller */ }
        return;
      }
      counters.ambiguous++;
      journal.markAmbiguous(intentId, attemptNo, `no finalized verdict on ${signature} inside ${conf.finalityTimeoutMs}ms`);
      log(`snipe execute ${mint}: ${side.toUpperCase()} ${signature} confirmed but not finalized inside ${conf.finalityTimeoutMs}ms — ` +
        "intent marked ambiguous; new exposure stays frozen until recovery resolves it");
      try { persist(); } catch { /* logged by the poller */ }
    } catch (error) {
      log(`snipe execute ${mint}: finality bookkeeping failed — ${error?.message ?? error}`);
    }
  }

  async function submit({ intentId, kind, side, mint, instructions, ata, expected, order }) {
    const attemptNo = (journal.latestAttempt(intentId)?.attempt ?? 0) + 1;
    const [pre, built] = await Promise.all([
      primary.getMultipleAccountsInfo([keypair.publicKey, new PublicKey(ata)], { commitment: "processed" }),
      buildTransaction(instructions),
    ]);
    const preLamports = BigInt(pre?.[0]?.lamports ?? 0);
    const preBase = tokenAmountOf(pre?.[1] ?? null, { mint, owner: wallet });
    const sim = await simulateBoth({ tx: built.tx, ata, mint, side, expected: { ...expected, preLamports, preBase } });

    built.tx.sign([keypair]);
    const signature = bs58.encode(built.tx.signatures[0]);
    const bytes = Buffer.from(built.tx.serialize());
    journal.recordSigned(intentId, {
      attempt: attemptNo, requestId: signature, signedTx: bytes, signature,
      blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight,
      quotedOutputRaw: side === "buy" ? expected.baseOutRaw.toString() : expected.minQuoteOutRaw.toString(),
      minOutputRaw: side === "buy" ? expected.baseOutRaw.toString() : expected.minQuoteOutRaw.toString(),
      order: { ...order, simulatedSpendLamports: sim.spend.toString(), simulatedDelta: sim.delta.toString(),
        unitsConsumed: sim.units, computeUnitLimit: conf.computeUnitLimit, computeUnitPriceMicroLamports: feeForUnits() },
      protocol: SNIPE_TX_PROTOCOL,
    });
    counters.signed++;

    const sends = await Promise.allSettled(connections.map((c) =>
      c.sendRawTransaction(bytes, { skipPreflight: true, preflightCommitment: "processed", maxRetries: 2 })));
    // Bytes were disclosed the moment the first request left; the journal says so whatever the RPCs answered.
    journal.markSubmitted(intentId, attemptNo);
    counters.sent++;
    if (sends.every((s) => s.status === "rejected")) {
      log(`snipe execute ${mint}: no provider accepted ${signature} (${sends.map((s) => s.reason?.message ?? s.reason).join("; ")}) — awaiting expiry`);
    }

    const verdict = await awaitConfirmed({ signature, lastValidBlockHeight: built.lastValidBlockHeight });
    if (verdict.outcome === "expired") {
      counters.expired++;
      journal.markExpired(intentId, attemptNo, `blockhash expired at height ${built.lastValidBlockHeight} with no status`);
      throw new SnipeExecuteError("expired", `${side} ${signature} expired unlanded`, { signature, attempt: attemptNo });
    }
    if (verdict.outcome === "failed") {
      counters.failed++;
      const tx = await transactionAt(signature, "confirmed").catch(() => null);
      journal.markFinalizedFailure(intentId, attemptNo, `failed on chain: ${JSON.stringify(verdict.err)}`,
        { networkFeeLamports: Number(tx?.meta?.fee ?? 0), finalizedAtMs: clock() }, { signature });
      throw new SnipeExecuteError("failed_on_chain", `${side} ${signature} failed on chain: ${JSON.stringify(verdict.err)}`,
        { signature, attempt: attemptNo });
    }
    if (verdict.outcome === "pending") {
      counters.ambiguous++;
      journal.markAmbiguous(intentId, attemptNo, `no status on ${signature} inside ${conf.confirmTimeoutMs}ms`);
      throw new SnipeExecuteError("ambiguous", `${side} ${signature} has no status after ${conf.confirmTimeoutMs}ms — exposure frozen until recovery`,
        { signature, attempt: attemptNo });
    }
    const tx = await transactionAt(signature, "confirmed");
    if (!tx) {
      counters.ambiguous++;
      journal.markAmbiguous(intentId, attemptNo, `confirmed status but the transaction could not be fetched`);
      throw new SnipeExecuteError("ambiguous", `${side} ${signature} confirmed but unreadable — exposure frozen until recovery`, { signature });
    }
    const fill = fillFromTransaction(tx, { wallet, mint, side });
    counters.confirmed++;
    // Off the trade path: finality, the journal's confirmed/accounted moves, persistence.
    void finalizeInBackground({ intentId, attemptNo, signature, side, mint, fill });
    return Object.freeze({ ...fill, signature, intentId, attempt: attemptNo, confirmedAtMs: clock() });
  }

  async function buy({ mint, curve, prepared, baseOutRaw, maxQuoteInRaw, curveReadSlot = null, creator = null }) {
    if (!isPlainObject(prepared) || !prepared.instruction)
      throw new SnipeExecuteError("malformed", "buy() needs the prepared instruction the contract decoded");
    const amountRaw = toBig(baseOutRaw, "baseOutRaw");
    const ceiling = toBig(maxQuoteInRaw, "maxQuoteInRaw");
    if (prepared.baseOutRaw !== amountRaw.toString() || prepared.maxQuoteInRaw !== ceiling.toString())
      throw new SnipeExecuteError("malformed",
        `the prepared instruction (${prepared.baseOutRaw} base, ${prepared.maxQuoteInRaw} ceiling) is not the plan ` +
        `(${amountRaw} base, ${ceiling} ceiling) — nothing is signed that the contract did not decode`);
    gate("buy");
    const blocking = journal.hasBlockingIntent();
    if (blocking) throw new SnipeExecuteError("exposure_frozen", `intent ${blocking} is unresolved — no new exposure on either lane`);
    const intentId = `snipe-entry:${mint}`;
    if (inFlight.has(intentId)) throw new SnipeExecuteError("in_flight", `${mint} already has a buy in flight`);
    const existing = journal.getIntent(intentId);
    if (existing && !["planned", "failed", "expired"].includes(existing.state))
      throw new SnipeExecuteError("in_flight", `${mint} already has a ${existing.state} entry intent`);
    inFlight.add(intentId);
    try {
      journal.ensureIntent({
        id: intentId, kind: "snipe_entry", mint, inputMint: WSOL, outputMint: mint, amountRaw: ceiling.toString(),
        context: { lane: "snipe", side: "buy", version: SNIPE_EXECUTE_VERSION, baseOutRaw: amountRaw.toString(),
          maxQuoteInRaw: ceiling.toString(), curveReadSlot: curveReadSlot ?? prepared.curveReadSlot ?? null,
          creator, associatedBaseUser: prepared.associatedBaseUser, baseTokenProgram: prepared.baseTokenProgram,
          feeRecipient: prepared.feeRecipient, buybackFeeRecipient: prepared.buybackFeeRecipient, plannedAt: clock() },
      });
      const instructions = [
        createAtaIdempotentIx({ payer: wallet, ata: prepared.associatedBaseUser, owner: wallet, mint, tokenProgram: prepared.baseTokenProgram }),
        toTransactionInstruction(prepared.instruction),
      ];
      return await submit({
        intentId, kind: "snipe_entry", side: "buy", mint, instructions, ata: prepared.associatedBaseUser,
        expected: { baseOutRaw: amountRaw, maxQuoteInRaw: ceiling },
        order: { side: "buy", mint, amountRaw: amountRaw.toString(), maxQuoteInRaw: ceiling.toString(), venue: venue.id ?? null },
      });
    } finally { inFlight.delete(intentId); }
  }

  async function sell({ mint, curve, curveReadSlot = null, qtyRaw, position = null, reason = null }) {
    const qty = toBig(qtyRaw, "qtyRaw");
    if (qty <= 0n) throw new SnipeExecuteError("malformed", "sell() needs a positive quantity");
    if (!isPlainObject(curve)) throw new SnipeExecuteError("malformed", "sell() needs the decoded curve");
    gate("sell");
    if (typeof venue.isComplete === "function" && venue.isComplete(curve))
      throw new SnipeExecuteError("refused", "the curve has graduated — the position must leave through a pool route, which this path does not build; sell by hand");
    const intentId = `snipe-exit:${mint}`;
    if (inFlight.has(intentId)) throw new SnipeExecuteError("in_flight", `${mint} already has a sell in flight`);
    const existing = journal.getIntent(intentId);
    if (existing && !["planned", "failed", "expired"].includes(existing.state))
      throw new SnipeExecuteError("in_flight", `${mint} already has a ${existing.state} exit intent`);
    const quote = venue.sellExactIn(curve, qty);
    const quoted = toBig(quote?.quoteOutRaw ?? 0n, "quoteOutRaw");
    if (quoted <= 0n) throw new SnipeExecuteError("refused", "the curve quotes nothing for this position");
    const floor = quoted * BigInt(10_000 - Math.round(Number(conf.exitSlippageBps))) / 10_000n;
    inFlight.add(intentId);
    try {
      const prepared = await prepareSell({ mint, curve, curveReadSlot, qtyRaw: qty, minQuoteOutRaw: floor });
      const basis = isRaw(position?.costBasisLamports) ? String(position.costBasisLamports)
        : (BigInt(String(position?.entryInputLamports ?? 0)) + BigInt(String(position?.entryFeeLamports ?? 0))).toString();
      journal.ensureIntent({
        id: intentId, kind: "snipe_exit", mint, inputMint: mint, outputMint: WSOL, amountRaw: qty.toString(),
        context: { lane: "snipe", side: "sell", version: SNIPE_EXECUTE_VERSION, reason,
          position: { qtyRaw: qty.toString(), costBasisLamports: basis, mint },
          quotedOutRaw: quoted.toString(), minQuoteOutRaw: floor.toString(), plannedAt: clock() },
      });
      return await submit({
        intentId, kind: "snipe_exit", side: "sell", mint, instructions: [toTransactionInstruction(prepared.instruction)],
        ata: prepared.associatedBaseUser,
        expected: { qtyRaw: qty, minQuoteOutRaw: floor },
        order: { side: "sell", mint, amountRaw: qty.toString(), minQuoteOutRaw: floor.toString(), quotedOutRaw: quoted.toString(), venue: venue.id ?? null },
      });
    } finally { inFlight.delete(intentId); }
  }

  /**
   * Boot recovery for the sniper's own intents. Never builds or discloses bytes: it reads
   * the chain for a verdict on what was already sent and moves the journal accordingly.
   * Returns what it found so the lane can reconcile its book.
   */
  async function recoverPending() {
    const out = [];
    for (const intent of journal.pendingIntents()) {
      if (!String(intent.kind).startsWith("snipe_")) continue;
      const side = intent.kind === "snipe_entry" ? "buy" : "sell";
      const mint = intent.mint;
      try {
        if (intent.state === "confirmed") {
          const rt = runtime();
          if (rt && rt.state !== undefined && rt.positions) journal.markAccounted(intent.id, rt);
          out.push({ id: intent.id, mint, side, outcome: "accounted" });
          continue;
        }
        const attempt = journal.latestAttempt(intent.id);
        if (!attempt || !attempt.signature) { out.push({ id: intent.id, mint, side, outcome: "no_attempt" }); continue; }
        const result = await awaitFinalized(attempt.signature);
        if (result.outcome === "finalized") {
          const fill = fillFromTransaction(result.tx, { wallet, mint, side });
          journal.markConfirmed(intent.id, attempt.attempt, {
            totalInputAmount: side === "buy" ? fill.quoteInRaw : fill.qtyRaw,
            totalOutputAmount: side === "buy" ? fill.qtyRaw : fill.quoteOutRaw,
            networkFeeLamports: fill.feeLamports, finalizedAtMs: clock(), signature: attempt.signature,
          }, { protocol: SNIPE_TX_PROTOCOL, signature: attempt.signature, slot: fill.slot });
          const rt = runtime();
          if (rt && rt.state !== undefined && rt.positions) journal.markAccounted(intent.id, rt);
          log(`snipe execute recovery ${mint}: ${side} ${attempt.signature} FINALIZED — ` +
            (side === "buy" ? `${fill.qtyRaw} base for ${fill.quoteInRaw} lamports; the book must hold this position`
              : `${fill.quoteOutRaw} lamports back; the book must close this position`));
          out.push({ id: intent.id, mint, side, outcome: "finalized", fill: { ...fill, signature: attempt.signature } });
        } else if (result.outcome === "failed") {
          journal.markFinalizedFailure(intent.id, attempt.attempt, `finalized with error ${JSON.stringify(result.err)}`,
            { networkFeeLamports: 0, finalizedAtMs: clock() });
          out.push({ id: intent.id, mint, side, outcome: "failed" });
        } else {
          const height = await blockHeight();
          if (height != null && height > Number(attempt.lastValidBlockHeight)) {
            journal.markExpired(intent.id, attempt.attempt, `expired unlanded at height ${height}`);
            out.push({ id: intent.id, mint, side, outcome: "expired" });
          } else {
            journal.markAmbiguous(intent.id, attempt.attempt, "no verdict on boot; still inside its blockhash lifetime");
            out.push({ id: intent.id, mint, side, outcome: "ambiguous" });
          }
        }
      } catch (error) {
        log(`snipe execute recovery ${mint}: ${error?.message ?? error}`);
        out.push({ id: intent.id, mint, side, outcome: "error", error: String(error?.message ?? error) });
      }
    }
    try { persist(); } catch { /* logged by the poller */ }
    return Object.freeze(out);
  }

  return Object.freeze({
    version: SNIPE_EXECUTE_VERSION,
    protocol: SNIPE_TX_PROTOCOL,
    wallet,
    cfg: conf,
    prepareBuy, buy, sell, recoverPending,
    stats() { return Object.freeze({ ...counters, keypairsLoaded: 1 }); },
  });
}
