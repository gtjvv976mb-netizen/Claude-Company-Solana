/**
 * Jupiter Swap V2 execution for WALL-ST-E.
 *
 * Only Metis is enabled for the first live release: one locally signed v0
 * transaction, one deterministic signature, and one recovery path. The exact
 * signed bytes are journaled before /execute ever sees them.
 */
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { validateExecutableEntryOrder } from "./entry-quote-guard.mjs";
import { validateExecutableExitOrder } from "./exit-trigger.mjs";
import { CURRENT_TX_ATTEMPT_PROTOCOL } from "./journal.mjs";

export const WSOL = "So11111111111111111111111111111111111111112";
export const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const EXECUTION_READINESS_ROUTE = "wsol-usdc";
// Exercise the default canary boundary when no active size is supplied. Live callers
// pass their configured per-trade cap so a raised-cap process cannot claim readiness
// from a smaller rehearsal. The probe never signs or submits.
export const EXECUTION_READINESS_AMOUNT_LAMPORTS = 5_000_000;
export const EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS = 50_000_000;
export const EXECUTION_READINESS_RESERVE_LAMPORTS = 10_000_000;
export const MAX_GROSS_RENT_LAMPORTS = 4_200_000;
export const WRITABLE_SNAPSHOT_ATTEMPTS = 3;
export const WRITABLE_SNAPSHOT_REQUEST_TIMEOUT_MS = 4_000;
export const PROCESSED_SLOT_ANCHOR_REQUEST_TIMEOUT_MS = 2_000;
export const MIN_SIGNABLE_BLOCKS_REMAINING = 32;
export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, auditMintAccount, MINT_CONSENSUS_FIELDS } from "./token2022.mjs";
export { TOKEN_PROGRAM, TOKEN_2022_PROGRAM };
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const COMPUTE_PROGRAM = ComputeBudgetProgram.programId.toBase58();

/* How far ABOVE the chain's own rent figure a quote may sit and still be accepted.
   Jupiter's stale constant is 1.09x the current chain value; 1.25 leaves room for that
   and for the next revision, while still refusing a quote that is simply wrong. An
   UNDER-estimate is never accepted at any margin. */
const RENT_OVER_ESTIMATE_MULTIPLE = 1.25;

/* What a healthy transaction's network fee actually is, for the two custody
   reconciliation checks below. Falls back to the refusal ceiling only when no expected
   figure is configured, so a caller that predates the split behaves exactly as before. */
const reconciliationFeeTolerance = (cfg) =>
  Number(cfg?.expectedNetworkFeeLamports ?? cfg?.maxNetworkFeeLamports ?? 500_000);
const SNAPSHOT_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const FINAL_HEIGHT_ATTEMPTS = 4;
const FINAL_HEIGHT_REQUEST_TIMEOUT_MS = 2_000;
const FINAL_HEIGHT_RETRY_DELAY_MS = 100;

// Anchor's eight-byte instruction discriminators. The first live canary accepts only
// v2 exact-in routes, whose safety fields have fixed offsets. Legacy v1 route plans put
// variable Borsh data before their limits; inferring those limits from a trailing tail
// is ambiguous and therefore fails closed.
const JUPITER_EXACT_IN = new Map([
  ["bb64facc31c4af14", { name: "route_v2", version: 2, shared: false }],
  ["d19853937cfed8e9", { name: "shared_accounts_route_v2", version: 2, shared: true }],
]);

const positiveRaw = (value, name) => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw new Error(`${name} must be a positive integer`);
  return text;
};

const finite = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite`);
  return number;
};

const sameKey = (key, expected) => key?.toBase58?.() === String(expected);
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
};
const sameRpcError = (left, right) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Normalize Jupiter's two historically-used impact fields to percentage points.
 * `priceImpact` is already percentage points; `priceImpactPct` is a fraction.
 * Missing or contradictory safety data is never interpreted as zero. */
export function priceImpactPercent(order) {
  const hasImpact = order?.priceImpact !== undefined && order?.priceImpact !== null && order?.priceImpact !== "";
  const hasImpactPct = order?.priceImpactPct !== undefined && order?.priceImpactPct !== null && order?.priceImpactPct !== "";
  if (!hasImpact && !hasImpactPct) throw new Error("price impact is missing");
  const direct = hasImpact ? finite(order.priceImpact, "price impact") : null;
  const fractional = hasImpactPct ? finite(order.priceImpactPct, "priceImpactPct") * 100 : null;
  if (direct != null && fractional != null) {
    const tolerance = Math.max(1e-9, Math.abs(direct) * 1e-9, Math.abs(fractional) * 1e-9);
    if (Math.abs(direct - fractional) > tolerance)
      throw new Error("Jupiter returned conflicting price-impact fields");
  }
  return Math.abs(direct ?? fractional);
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`${label} returned non-JSON (${response.status})`); }
  if (!response.ok) {
    /* An object error interpolated straight into a template renders "[object Object]",
     * which is the least useful string a failing money path can produce — it cost a
     * live diagnosis. Serialise structured errors so the reason survives to the log. */
    const raw = body?.error ?? body?.errorMessage ?? body?.message;
    const detail = raw == null ? "request failed"
      : typeof raw === "string" ? raw
      : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
    const code = body?.errorCode != null ? ` (code ${body.errorCode})` : "";
    throw new Error(`${label} ${response.status}: ${detail}${code}`);
  }
  return body;
}

export function validateOrderEnvelope(order, expected, cfg) {
  if (!order || typeof order !== "object") throw new Error("Jupiter order is missing");
  if (order.inputMint !== expected.inputMint) throw new Error("Jupiter changed the input mint");
  if (order.outputMint !== expected.outputMint) throw new Error("Jupiter changed the output mint");
  if (String(order.inAmount) !== String(expected.amountRaw)) throw new Error("Jupiter changed the raw input amount");
  if (order.taker !== expected.wallet) throw new Error("Jupiter changed the taker wallet");
  if (order.swapMode !== "ExactIn") throw new Error(`unsupported swap mode ${order.swapMode}`);
  if (order.router !== "metis") throw new Error(`unexpected router ${order.router}; first live release is Metis-only`);
  if (!order.transaction || typeof order.transaction !== "string")
    throw new Error(`Jupiter could not build the transaction (${order.errorCode ?? "no code"})`);
  if (!order.requestId || typeof order.requestId !== "string") throw new Error("Jupiter order omitted requestId");
  const expiry = Number(order.lastValidBlockHeight);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new Error("Jupiter order omitted a valid block-height expiry");
  positiveRaw(order.outAmount, "quoted output");
  positiveRaw(order.otherAmountThreshold, "minimum output");
  if (BigInt(order.otherAmountThreshold) > BigInt(order.outAmount)) throw new Error("minimum output exceeds quote output");
  const slippage = finite(order.slippageBps, "slippageBps");
  if (slippage < 0 || slippage > cfg.slippageBps) throw new Error(`slippage ${slippage} bps exceeds cap ${cfg.slippageBps}`);
  const impact = priceImpactPercent(order);
  if (impact > cfg.maxPriceImpactPct) throw new Error(`price impact ${impact}% exceeds cap ${cfg.maxPriceImpactPct}%`);
  const feeBps = finite(order.feeBps ?? 0, "feeBps");
  if (feeBps < 0 || feeBps > cfg.maxFeeBps) throw new Error(`Jupiter fee ${feeBps} bps exceeds cap ${cfg.maxFeeBps}`);
  const platformFeeBps = finite(order.platformFee?.feeBps ?? 0, "platformFee.feeBps");
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > feeBps || platformFeeBps > cfg.maxFeeBps)
    throw new Error(`Jupiter platform fee ${platformFeeBps} bps is invalid or exceeds the fee cap`);
  if (order.feeMint != null && ![expected.inputMint, expected.outputMint].includes(order.feeMint))
    throw new Error("Jupiter fee mint is outside the swap pair");
  if (order.platformFee?.feeMint != null && ![expected.inputMint, expected.outputMint].includes(order.platformFee.feeMint))
    throw new Error("Jupiter platform-fee mint is outside the swap pair");
  if (order.gasless === true) throw new Error("gasless orders are disabled for the local-custody canary");
  for (const field of ["signatureFeePayer", "prioritizationFeePayer", "rentFeePayer"]) {
    if (order[field] != null && order[field] !== expected.wallet)
      throw new Error(`${field} is not the local wallet`);
  }
  const signatureFee = finite(order.signatureFeeLamports ?? 0, "signature fee");
  const priorityFee = finite(order.prioritizationFeeLamports ?? 0, "priority fee");
  const rentFee = finite(order.rentFeeLamports ?? 0, "rent fee");
  if ([signatureFee, priorityFee, rentFee].some((value) => value < 0))
    throw new Error("Jupiter returned a negative fee estimate");
  const networkFees = signatureFee + priorityFee;
  if (networkFees > cfg.maxNetworkFeeLamports)
    throw new Error(`non-rent network fees ${networkFees} lamports exceed cap ${cfg.maxNetworkFeeLamports}`);
  const feeBasis = BigInt(String(expected.feeBasisLamports ?? expected.amountRaw));
  const maxNetworkFeePct = Number(cfg.maxNetworkFeePct ?? 10);
  if (feeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
      BigInt(Math.ceil(networkFees)) * 10_000n > feeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
    throw new Error(`estimated network fees exceed ${maxNetworkFeePct}% of the trade basis`);
  if (rentFee > (cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS))
    throw new Error(`rent ${rentFee} lamports exceeds cap ${cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS}`);
  return order;
}

export function priceImpactCapForIntent(kind, cfg) {
  return kind === "entry" ? Number(cfg.maxPriceImpactPct) : Number(cfg.maxExitPriceImpactPct);
}

async function lookupTables(connection, message) {
  const tables = [];
  for (const lookup of message.addressTableLookups || []) {
    const response = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
    if (!response?.value) throw new Error(`address lookup table unavailable: ${lookup.accountKey.toBase58()}`);
    tables.push(response.value);
  }
  return tables;
}

function u32(data, offset = 1) {
  if (data.length < offset + 4) throw new Error("truncated compute-budget instruction");
  return Buffer.from(data).readUInt32LE(offset);
}

function u64(data, offset = 1) {
  if (data.length < offset + 8) throw new Error("truncated u64 instruction");
  return Buffer.from(data).readBigUInt64LE(offset);
}

function exactKey(meta, expected, label, { signer = false, writable = false } = {}) {
  if (!sameKey(meta?.pubkey, expected)) throw new Error(`${label} is not ${expected}`);
  if (signer && !meta?.isSigner) throw new Error(`${label} is not a signer`);
  if (writable && !meta?.isWritable) throw new Error(`${label} is not writable`);
}

export function associatedTokenAddress(wallet, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync([
    new PublicKey(wallet).toBuffer(),
    new PublicKey(tokenProgram).toBuffer(),
    new PublicKey(mint).toBuffer(),
  ], new PublicKey(ATA_PROGRAM))[0].toBase58();
}

export async function mintTokenProgram(connection, mint) {
  if (mint === WSOL) return TOKEN_PROGRAM;
  const account = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
  // A Token-2022 mint is accepted only after token2022.mjs has audited its extension
  // list; the same audit prices the entry (independentClassicMintDecimals below).
  return auditMintAccount(account, mint).program;
}

/** Read the immutable decimals byte from a classic SPL mint account.
 *
 * Entry-price validation needs an on-chain unit conversion. Without this, a
 * Jupiter token/lamport rate can be declared equivalent to an unrelated USD mark
 * merely by treating the first quote as the conversion anchor. The first canary
 * deliberately rejects unusual (>18) decimal counts instead of doing floating
 * point arithmetic over an impractical scale.
 */
function classicMintMetadata(account, mint) {
  // Classic SPL Token mints keep the exact 82-byte rule; Token-2022 mints pass only with
  // an audited extension list, no freeze authority, and byte-identical RPC views.
  return auditMintAccount(account, mint);
}

export async function classicMintDecimals(connection, mint) {
  if (mint === WSOL) return 9;
  const account = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
  return classicMintMetadata(account, mint).decimals;
}

/**
 * Resolve entry unit conversion only when both independent RPC providers agree on
 * the classic SPL mint metadata that controls it. A forged decimals byte from one
 * provider would otherwise move the absolute USD entry anchor by powers of ten.
 */
export async function independentMintAudit(primaryConnection, secondaryConnection, mint) {
  if (mint === WSOL) return { program: TOKEN_PROGRAM, owner: TOKEN_PROGRAM, decimals: 9, extensions: "" };
  if (!primaryConnection || !secondaryConnection || primaryConnection === secondaryConnection)
    throw new Error("classic mint consensus requires two distinct RPC connections");
  const mintKey = new PublicKey(mint);
  const reads = await Promise.allSettled([
    primaryConnection.getAccountInfo(mintKey, "confirmed"),
    secondaryConnection.getAccountInfo(mintKey, "confirmed"),
  ]);
  if (reads[0].status !== "fulfilled" || reads[1].status !== "fulfilled")
    throw new Error("classic mint consensus requires successful reads from both RPC providers");

  let primary, secondary;
  try {
    primary = classicMintMetadata(reads[0].value, mint);
    secondary = classicMintMetadata(reads[1].value, mint);
  } catch (error) {
    throw new Error(`classic mint consensus rejected an RPC view: ${error.message}`);
  }
  for (const field of MINT_CONSENSUS_FIELDS) {
    if (primary[field] !== secondary[field])
      throw new Error(`classic mint RPC views disagree on ${field}`);
  }
  return primary;
}

export async function independentClassicMintDecimals(primaryConnection, secondaryConnection, mint) {
  return (await independentMintAudit(primaryConnection, secondaryConnection, mint)).decimals;
}

/** The token program that owns a mint, agreed by both RPC providers after the audit. */
export async function independentMintProgram(primaryConnection, secondaryConnection, mint) {
  return (await independentMintAudit(primaryConnection, secondaryConnection, mint)).program;
}

const accountOwner = (account) => account?.owner?.toBase58?.() || String(account?.owner || "");
const accountData = (account) => {
  if (!account) return null;
  if (Buffer.isBuffer(account.data) || account.data instanceof Uint8Array) return Buffer.from(account.data);
  if (Array.isArray(account.data) && account.data[1] === "base64") return Buffer.from(account.data[0], "base64");
  throw new Error("RPC returned an unsupported account encoding");
};

/** Solana simulation providers use both `null` and this exact object shape for an
 * account closed by the simulated transaction. It is safe to treat as absent only
 * where the caller already permits absence: no lamports, no data, no executable
 * capability, and System Program ownership. Any near miss remains an account. */
export function isClosedAccountTombstone(account) {
  if (!account || account.lamports !== 0 || account.executable !== false ||
      accountOwner(account) !== SYSTEM_PROGRAM) return false;
  let data;
  try { data = accountData(account); } catch { return false; }
  return data?.length === 0;
}

function tokenAccountDetails(account) {
  const program = accountOwner(account);
  const data = accountData(account);
  if (!data) return null;
  const classic = program === TOKEN_PROGRAM && data.length === 165;
  // The ATA program always adds ImmutableOwner (170 bytes), but a token account opened
  // directly under Token-2022 carries no extensions and is exactly 165 bytes. Both must
  // be classifiable, or the capability scan cannot tell that such an account is the
  // wallet's and would let it be writable in a signed route.
  const token2022 = program === TOKEN_2022_PROGRAM &&
    (data.length === 165 || (data.length >= 166 && data[165] === 2));
  if (!classic && !token2022) return null;
  const optionKey = (offset, label) => {
    const tag = data.readUInt32LE(offset);
    if (tag === 0) return null;
    if (tag !== 1) throw new Error(`token account has an invalid ${label} option`);
    return new PublicKey(data.subarray(offset + 4, offset + 36)).toBase58();
  };
  const nativeTag = data.readUInt32LE(109);
  if (nativeTag !== 0 && nativeTag !== 1)
    throw new Error("token account has an invalid native-reserve option");
  return {
    program,
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
    delegate: optionKey(72, "delegate"),
    state: data[108],
    isNative: nativeTag === 1,
    delegatedAmount: data.readBigUInt64LE(121),
    closeAuthority: optionKey(129, "close authority"),
  };
}

function assertSafeTokenAccount(details, label) {
  if (details.state !== 1) throw new Error(`${label} is not initialized and unfrozen`);
  if (details.delegate || details.delegatedAmount !== 0n)
    throw new Error(`${label} has delegated spending authority`);
  if (details.closeAuthority) throw new Error(`${label} has a close authority`);
}

function checkedTokenAmount(account, { program, mint, wallet, label, allowMissing = false }) {
  if (allowMissing && (!account || isClosedAccountTombstone(account))) return 0n;
  const details = tokenAccountDetails(account);
  if (!details) throw new Error(`${label} is not a supported token account`);
  if (details.program !== program || details.mint !== mint || details.owner !== wallet)
    throw new Error(`${label} is not the wallet's expected token account`);
  assertSafeTokenAccount(details, label);
  return details.amount;
}

export function classicWalletTokenAmount(account, { mint, wallet, allowMissing = false,
  label = "classic wallet token account" } = {}) {
  return checkedTokenAmount(account, {
    program: TOKEN_PROGRAM, mint, wallet, label, allowMissing,
  });
}

/** Same custody checks for a wallet token account under either token program. */
export function walletTokenAmount(account, { program, mint, wallet, allowMissing = false,
  label = "wallet token account" } = {}) {
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM)
    throw new Error(`${label} program ${program} is not a token program`);
  return checkedTokenAmount(account, { program, mint, wallet, label, allowMissing });
}

function foreignRentAllowance(value) {
  if (value === undefined || value === null) return 0n;
  const lamports = Number(value);
  if (!Number.isSafeInteger(lamports) || lamports < 0)
    throw new Error("third-party account-rent allowance is not a valid lamport count");
  return BigInt(lamports);
}

export function validateSimulationEffects(before, after, expected, cfg) {
  if (!before?.wallet || !after?.wallet) throw new Error("simulation omitted the local wallet account");
  for (const [label, account] of [["pre-simulation wallet", before.wallet], ["post-simulation wallet", after.wallet]]) {
    if (accountOwner(account) !== SYSTEM_PROGRAM) throw new Error(`${label} is no longer System Program owned`);
    if (account.executable !== false) throw new Error(`${label} executable flag is invalid`);
    const data = accountData(account);
    if (!data || data.length !== 0) throw new Error(`${label} contains unexpected account data`);
  }
  const walletLamports = (account, label) => {
    if (!Number.isSafeInteger(account.lamports) || account.lamports < 0)
      throw new Error(`${label} has an invalid lamport balance`);
    return BigInt(account.lamports);
  };
  walletLamports(before.wallet, "pre-simulation wallet");
  walletLamports(after.wallet, "post-simulation wallet");
  // A wrapped-SOL ATA may legitimately be absent before creation or after
  // CloseAccount. Whenever it does exist, it must still be canonical custody
  // with no delegate or close authority left behind by an inner CPI.
  if (expected.inputMint === WSOL) {
    checkedTokenAmount(before.input, {
      program: expected.inputProgram, mint: WSOL, wallet: expected.wallet,
      label: "pre-simulation wrapped-SOL source account", allowMissing: true,
    });
    checkedTokenAmount(after.input, {
      program: expected.inputProgram, mint: WSOL, wallet: expected.wallet,
      label: "post-simulation wrapped-SOL source account", allowMissing: true,
    });
  }
  if (expected.outputMint === WSOL) {
    checkedTokenAmount(before.output, {
      program: expected.outputProgram, mint: WSOL, wallet: expected.wallet,
      label: "pre-simulation wrapped-SOL destination account", allowMissing: true,
    });
    checkedTokenAmount(after.output, {
      program: expected.outputProgram, mint: WSOL, wallet: expected.wallet,
      label: "post-simulation wrapped-SOL destination account", allowMissing: true,
    });
  }
  const custodyLamports = (snapshot, label) => {
    let total = BigInt(snapshot.wallet.lamports);
    for (const account of [snapshot.input, snapshot.output]) {
      if (!account) continue;
      if (!Number.isSafeInteger(account.lamports) || account.lamports < 0)
        throw new Error(`${label} token account has an invalid lamport balance`);
      total += BigInt(account.lamports);
    }
    return total;
  };
  const custodyBefore = custodyLamports(before, "pre-simulation");
  const custodyAfter = custodyLamports(after, "post-simulation");
  const minOutput = BigInt(expected.minOutputRaw);
  if (expected.inputMint !== WSOL) {
    const pre = checkedTokenAmount(before.input, {
      program: expected.inputProgram, mint: expected.inputMint, wallet: expected.wallet,
      label: "pre-simulation source token account",
    });
    const post = checkedTokenAmount(after.input, {
      program: expected.inputProgram, mint: expected.inputMint, wallet: expected.wallet,
      label: "post-simulation source token account",
    });
    if (pre < post || pre - post !== BigInt(expected.amountRaw))
      throw new Error("simulation source-token delta does not equal the exact input");
  } else {
    // ATA rent moves lamports from the wallet into another wallet-owned account;
    // aggregate the observed custody set so only swap input + network fee leaves it.
    /* Some routes make the taker fund an account that is NOT the wallet's own ATA — a
     * venue fee or vault account. Measured on a live pump.fun buy, 2026-09-03: one extra
     * 165-byte token account, 2,039,280 lamports, created by an inner CPI and never
     * returned. Those lamports leave the custody set for good, so this check must know
     * what they may be or it refuses every such route. The allowance is Jupiter's own
     * quoted taker rent, already matched against chain-derived figures and bounded by
     * the gross rent cap, less the rent that lands in a wallet-owned account that stays
     * open — that part never leaves custody and must not be spendable twice. */
    const spent = custodyBefore - custodyAfter;
    const rentAllowance = foreignRentAllowance(expected.foreignRentAllowanceLamports);
    /* THE TOLERANCE IS NOT THE GATE. This is the only bound on unexplained lamports
       leaving custody during an entry, and it happened to be spelled with the fee
       ceiling. When that ceiling was raised to admit congested fills, this band would
       have widened with it — four times more undetectable drain, for a reason that has
       nothing to do with priority fees. It is pinned to the expected-fee constant, which
       is what a healthy transaction actually costs. */
    if (spent < BigInt(expected.amountRaw) ||
        spent > BigInt(expected.amountRaw) + BigInt(reconciliationFeeTolerance(cfg)) + rentAllowance)
      throw new Error(`simulation SOL spend ${spent} is outside the exact input ${expected.amountRaw} ` +
        `plus capped fees${rentAllowance > 0n ? ` and ${rentAllowance} lamports of quoted third-party account rent` : ""}`);
  }

  /* THE QUOTE MUST AGREE WITH THE CHAIN, NOT ONLY WITH ITSELF.
   * Until now every price-sanity number — impact, minOut, the round-trip preflight —
   * was authored by the same API response it was checking, so a low-balled quote
   * (outAmount at a fraction of fair value, minOut 3% under that) sailed through:
   * the instruction was self-consistent and the simulation check below only asked
   * `actual >= minOut`, which a garbage floor trivially passes. The wallet then signs
   * a transaction whose on-chain floor is far below fair value, and whoever sees it
   * in flight collects the difference.
   *
   * The simulation's ACTUAL output is the one number in this file the counterparty
   * cannot author — it comes from replaying the transaction against the real chain.
   * If the chain delivers materially MORE than the quote promised, the quote did not
   * describe the market; it described a floor somebody wanted signed. Refuse. */
  const quotedOutput = BigInt(positiveRaw(expected.quotedOutputRaw, "quoted output for simulation cross-check"));
  const shortfallCapPct = BigInt(Math.round(cfg.maxQuoteShortfallPct ?? 15));

  let actualOutput;
  if (expected.outputMint !== WSOL) {
    const pre = checkedTokenAmount(before.output, {
      program: expected.outputProgram, mint: expected.outputMint, wallet: expected.wallet,
      label: "pre-simulation destination token account", allowMissing: true,
    });
    const post = checkedTokenAmount(after.output, {
      program: expected.outputProgram, mint: expected.outputMint, wallet: expected.wallet,
      label: "post-simulation destination token account",
    });
    actualOutput = post - pre;
    if (post < pre || actualOutput < minOutput)
      throw new Error("simulation destination-token delta is below the signed minimum output");
    if (actualOutput * 100n > quotedOutput * (100n + shortfallCapPct))
      throw new Error(`the chain delivers ${actualOutput} against a quote of ${quotedOutput} — the quote is more than ` +
        `${cfg.maxQuoteShortfallPct ?? 15}% below reality, so the signed minimum-output floor protects nothing; refusing`);
  } else {
    const receivedNet = custodyAfter - custodyBefore;
    if (receivedNet <= 0n)
      throw new Error("simulation SOL proceeds are not positive");
    if (receivedNet + BigInt(reconciliationFeeTolerance(cfg)) < minOutput)
      throw new Error("simulation SOL proceeds are below the signed minimum after capped fees");
    if (receivedNet * 100n > quotedOutput * (100n + shortfallCapPct))
      throw new Error(`the chain delivers ${receivedNet} lamports against a quote of ${quotedOutput} — the quote is ` +
        `more than ${cfg.maxQuoteShortfallPct ?? 15}% below reality, so the signed minimum-output floor protects nothing; refusing`);
    actualOutput = receivedNet;
  }
  return { actualOutputRaw: String(actualOutput) };
}

/** Require independently simulated custody deltas to describe the same executable
 * transaction. The lower output is the only value safe to expose to policy. */
function agreeSimulationOutputs(primary, secondary, capPct = 1) {
  const primaryOutput = BigInt(positiveRaw(primary?.actualOutputRaw,
    "primary chain-simulated output"));
  const secondaryOutput = BigInt(positiveRaw(secondary?.actualOutputRaw,
    "secondary chain-simulated output"));
  const lower = primaryOutput < secondaryOutput ? primaryOutput : secondaryOutput;
  const upper = primaryOutput > secondaryOutput ? primaryOutput : secondaryOutput;
  const cap = Number(capPct);
  if (!Number.isFinite(cap) || cap <= 0 || cap > 5)
    throw new Error("simulation RPC divergence cap is invalid");
  const capPartsPerMillion = BigInt(Math.round(cap * 10_000));
  if ((upper - lower) * 1_000_000n > lower * capPartsPerMillion)
    throw new Error("independent RPC simulations diverge beyond the executable-output cap");
  return {
    actualOutputRaw: lower.toString(),
    divergencePct: Number((upper - lower) * 100_000_000n / lower) / 1_000_000,
  };
}

/** Decode and bind the fixed safety-critical fields of a Jupiter exact-in ix. */
export function decodeJupiterExactIn(data, expected) {
  const bytes = Buffer.from(data || []);
  if (bytes.length < 8) throw new Error("truncated Jupiter instruction discriminator");
  const variant = JUPITER_EXACT_IN.get(bytes.subarray(0, 8).toString("hex"));
  if (!variant) throw new Error("unsupported Jupiter instruction (exact-in route required)");

  const amountOffset = variant.shared ? 9 : 8;
  const routeCountOffset = variant.shared ? 31 : 30;
  if (bytes.length <= routeCountOffset + 4) throw new Error(`truncated Jupiter ${variant.name} instruction`);
  const amount = bytes.readBigUInt64LE(amountOffset);
  const quotedOut = bytes.readBigUInt64LE(amountOffset + 8);
  const slippageBps = bytes.readUInt16LE(amountOffset + 16);
  const platformFeeBps = bytes.readUInt16LE(amountOffset + 18);
  const positiveSlippageBps = bytes.readUInt16LE(amountOffset + 20);
  const routeSteps = bytes.readUInt32LE(routeCountOffset);

  if (!Number.isInteger(routeSteps) || routeSteps < 1 || routeSteps > 16)
    throw new Error(`Jupiter route-plan length ${routeSteps} is outside the canary limit`);
  if (amount !== BigInt(expected.amountRaw)) throw new Error("Jupiter instruction input amount does not match the intent");
  if (quotedOut !== BigInt(expected.quotedOutputRaw)) throw new Error("Jupiter instruction quote does not match the order");
  if (slippageBps !== Number(expected.slippageBps) || slippageBps > Number(expected.maxSlippageBps))
    throw new Error("Jupiter instruction slippage does not match the capped order");
  if (platformFeeBps !== Number(expected.platformFeeBps))
    throw new Error("Jupiter instruction platform fee does not match the capped order");
  if (positiveSlippageBps !== 0) throw new Error("Jupiter instruction contains an unrequested positive-slippage fee");
  const signedMinimum = quotedOut * BigInt(10_000 - slippageBps) / 10_000n;
  if (BigInt(expected.minOutputRaw) !== signedMinimum)
    throw new Error("Jupiter order minimum output does not match the signed instruction");
  return { ...variant, amount, quotedOut, slippageBps, platformFeeBps, positiveSlippageBps, routeSteps };
}

function validateRouteAccounts(ix, route, expected, tokenPrograms, atas) {
  const keys = ix.keys;
  const { input: inputProgram, output: outputProgram } = tokenPrograms;
  const { input: inputAta, output: outputAta } = atas;
  const sentinelOrDestination = (meta, label) => {
    const value = meta?.pubkey?.toBase58?.();
    if (value !== JUPITER_V6 && value !== outputAta) throw new Error(`${label} redirects output away from the local wallet`);
  };

  if (route.name === "route_v2") {
    if (keys.length < 10) throw new Error("Jupiter route_v2 account list is truncated");
    exactKey(keys[0], expected.wallet, "route_v2 transfer authority", { signer: true });
    exactKey(keys[1], inputAta, "route_v2 source token account", { writable: true });
    exactKey(keys[2], outputAta, "route_v2 destination token account", { writable: true });
    exactKey(keys[3], expected.inputMint, "route_v2 source mint");
    exactKey(keys[4], expected.outputMint, "route_v2 destination mint");
    exactKey(keys[5], inputProgram, "route_v2 source token program");
    exactKey(keys[6], outputProgram, "route_v2 destination token program");
    sentinelOrDestination(keys[7], "route_v2 optional destination");
    exactKey(keys[8], JUPITER_EVENT_AUTHORITY, "route_v2 event authority");
    exactKey(keys[9], JUPITER_V6, "route_v2 program account");
    return;
  }
  if (route.name === "shared_accounts_route_v2") {
    if (keys.length < 12) throw new Error("Jupiter shared route_v2 account list is truncated");
    exactKey(keys[1], expected.wallet, "shared route_v2 transfer authority", { signer: true });
    exactKey(keys[2], inputAta, "shared route_v2 source token account", { writable: true });
    exactKey(keys[5], outputAta, "shared route_v2 destination token account", { writable: true });
    exactKey(keys[6], expected.inputMint, "shared route_v2 source mint");
    exactKey(keys[7], expected.outputMint, "shared route_v2 destination mint");
    exactKey(keys[8], inputProgram, "shared route_v2 source token program");
    exactKey(keys[9], outputProgram, "shared route_v2 destination token program");
    exactKey(keys[10], JUPITER_EVENT_AUTHORITY, "shared route_v2 event authority");
    exactKey(keys[11], JUPITER_V6, "shared route_v2 program account");
  }
}

/** Obtain the one freshness floor used by the initial merged snapshot.
 *
 * The successful path performs exactly one RPC read. A transport that never settles
 * cannot wedge entry or emergency-exit preparation indefinitely; it loses authority
 * after the same strict, capped deadline used for every provider. */
export async function processedSlotFreshnessAnchor(connection, {
  requestTimeoutMs = PROCESSED_SLOT_ANCHOR_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!connection || typeof connection.getSlot !== "function")
    throw new Error("RPC lacks processed-slot freshness-anchor support");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      requestTimeoutMs > PROCESSED_SLOT_ANCHOR_REQUEST_TIMEOUT_MS)
    throw new Error("processed-slot freshness-anchor request timeout is invalid");
  let timer;
  let slot;
  try {
    slot = await Promise.race([
      Promise.resolve().then(() => connection.getSlot("processed")),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("RPC processed-slot freshness anchor timed out")),
          requestTimeoutMs);
      }),
    ]);
  } catch {
    throw new Error("RPC could not obtain a processed-slot freshness anchor");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!Number.isSafeInteger(slot) || slot <= 0)
    throw new Error("RPC returned an invalid processed-slot freshness anchor");
  return slot;
}

/** Read every requested account from one simulated bank.
 *
 * Provider-sized `getMultipleAccounts` chunks cannot prove an exact-bank view:
 * `minContextSlot` is only a lower bound, and consecutive chunks routinely land on
 * different slots. This probe instead includes every requested address as a static,
 * read-only transaction key and asks one `simulateTransaction` response to return
 * them. The fixed Memo ensures the probe actually executes while taking zero account
 * metas; the instruction has no path to mutate any loaded account. The probe stays
 * unsigned and is never broadcastable.
 *
 * Simulation account rows are post-state. A successful Memo changes only the fee
 * payer's lamports, so the same response's pre/post balance vectors and fee are
 * required and checked before the payer row is restored to its atomic pre-state. */
/* One Memo probe can carry at most ~34 static keys before it exceeds Solana's
 * 1232-byte packet, yet the writable-account cap above it is 64 — so any route in
 * between could not be snapshotted at all, and every exit on such a route was
 * refused. Hit live: a wrapped-SOL unwrap whose probe came to 1260 bytes at 35 keys.
 *
 * Split the address set into probes of SNAPSHOT_CHUNK_KEYS and keep the property the
 * single probe gave us — ONE exact slot for every row. The chunks are dispatched
 * CONCURRENTLY at the same floor so they reach the RPC inside one bank; sequential
 * dispatch never agreed on a slot live, because banks advance every ~400ms. Every
 * chunk must land on the identical slot; if any lands on a newer bank the set is not
 * coherent and the whole set is retried from that newer floor. No partial rows ever
 * survive. Callers see the same { accounts, slot } shape, rows in the order asked.
 * 30 addresses + payer + Memo = 32 static keys ≈ 1164 bytes, safely under 1232. */
export const SNAPSHOT_CHUNK_KEYS = 30;
export async function coherentAccountSnapshot(connection, publicKeys, options = {}) {
  if (!Array.isArray(publicKeys) || !publicKeys.length)
    throw new Error("coherent account snapshot requires at least one address");
  if (publicKeys.length <= SNAPSHOT_CHUNK_KEYS)
    return coherentAccountSnapshotChunk(connection, publicKeys, options);
  const addresses = publicKeys.map((key) => key instanceof PublicKey ? key.toBase58() : String(key));
  if (new Set(addresses).size !== addresses.length)
    throw new Error("coherent account snapshot addresses must be unique");
  const chunks = [];
  for (let i = 0; i < publicKeys.length; i += SNAPSHOT_CHUNK_KEYS)
    chunks.push(publicKeys.slice(i, i + SNAPSHOT_CHUNK_KEYS));
  const attempts = options.attempts ?? WRITABLE_SNAPSHOT_ATTEMPTS;
  let floor = options.minContextSlot ?? 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const settled = await Promise.allSettled(chunks.map((chunk) =>
      coherentAccountSnapshotChunk(connection, chunk, { ...options, attempts: 1, minContextSlot: floor })));
    const parts = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
    // Any bank observed, on success or failure, only ever raises the next floor.
    for (const part of parts) floor = Math.max(floor, part.slot);
    if (parts.length === chunks.length && parts.every((part) => part.slot === parts[0].slot))
      return Object.freeze({ accounts: Object.freeze(parts.flatMap((part) => [...part.accounts])), slot: parts[0].slot });
    // Either a chunk failed or the chunks straddled a bank boundary: retry the set.
  }
  throw new Error(`RPC could not produce one coherent exact-slot account snapshot after ${attempts} attempts`);
}

async function coherentAccountSnapshotChunk(connection, publicKeys, {
  transaction, commitment = "confirmed", minContextSlot = 0,
  attempts = WRITABLE_SNAPSHOT_ATTEMPTS,
  requestTimeoutMs = WRITABLE_SNAPSHOT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!connection || typeof connection.simulateTransaction !== "function")
    throw new Error("RPC lacks context-fenced account snapshot support");
  if (!Array.isArray(publicKeys) || !publicKeys.length)
    throw new Error("coherent account snapshot requires at least one address");
  if (!Number.isSafeInteger(attempts) || attempts < 1 ||
      attempts > WRITABLE_SNAPSHOT_ATTEMPTS)
    throw new Error("coherent account snapshot attempt count is invalid");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      requestTimeoutMs > WRITABLE_SNAPSHOT_REQUEST_TIMEOUT_MS)
    throw new Error("coherent account snapshot request timeout is invalid");
  const floor = minContextSlot;
  if (!Number.isSafeInteger(floor) || floor < 0)
    throw new Error("coherent account snapshot minContextSlot is invalid");
  const keys = publicKeys.map((key) => key instanceof PublicKey ? key : new PublicKey(key));
  const addresses = keys.map((key) => key.toBase58());
  if (new Set(addresses).size !== addresses.length)
    throw new Error("coherent account snapshot addresses must be unique");
  if (!transaction?.message || transaction.message.header?.numRequiredSignatures !== 1 ||
      transaction.signatures?.length !== 1 ||
      Buffer.from(transaction.signatures[0] || []).length !== 64 ||
      Buffer.from(transaction.signatures[0] || []).some((byte) => byte !== 0))
    throw new Error("coherent account snapshot source transaction is not unsigned or not exactly one-payer");
  const payer = transaction.message.staticAccountKeys?.[0];
  const recentBlockhash = transaction.message.recentBlockhash;
  if (!(payer instanceof PublicKey) || typeof recentBlockhash !== "string")
    throw new Error("coherent account snapshot source transaction is malformed");
  const memoProgram = new PublicKey(SNAPSHOT_MEMO_PROGRAM);
  const staticAccountKeys = [payer];
  const included = new Set([payer.toBase58()]);
  for (const key of keys) {
    const address = key.toBase58();
    if (!included.has(address)) {
      staticAccountKeys.push(key);
      included.add(address);
    }
  }
  if (!included.has(SNAPSHOT_MEMO_PROGRAM)) staticAccountKeys.push(memoProgram);
  const memoProgramIdIndex = staticAccountKeys.findIndex((key) => key.equals(memoProgram));
  const probe = new VersionedTransaction(new MessageV0({
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: staticAccountKeys.length - 1,
    },
    staticAccountKeys,
    recentBlockhash,
    compiledInstructions: [{
      programIdIndex: memoProgramIdIndex,
      accountKeyIndexes: [],
      // One fixed UTF-8 byte gives every compatibility Memo deterministic content.
      data: Buffer.from("W"),
    }],
    addressTableLookups: [],
  }));
  let probeLength;
  try { probeLength = probe.serialize().length; }
  catch (error) {
    // Keep the underlying reason: a swallowed cause turned a live exit failure into
    // a guess between packet overflow and a malformed key. Say which.
    throw new Error(`atomic account-snapshot probe cannot be serialized safely ` +
      `(${staticAccountKeys.length} keys): ${error?.message || error}`);
  }
  if (probeLength > 1232)
    throw new Error(`atomic account-snapshot probe is ${probeLength} bytes (Solana max 1232)`);
  if (probe.signatures.length !== 1 || Buffer.from(probe.signatures[0] || []).length !== 64 ||
      probe.signatures.some((signature) => Buffer.from(signature).some((byte) => byte !== 0)))
    throw new Error("atomic account-snapshot probe is not unsigned");

  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("RPC account snapshot request timed out")),
            requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  // Some RPC clients preserve a newer bank slot on a failed JSON-RPC response.
  // Treating that only as a stricter retry floor is safe: forged high evidence can
  // make the probe fail closed, but can never make an older bank acceptable.
  const errorContextSlot = (error) => {
    const candidates = [
      error?.context?.slot,
      error?.data?.context?.slot,
      error?.data?.contextSlot,
      error?.data?.slot,
      error?.slot,
    ].filter((slot) => Number.isSafeInteger(slot) && slot > 0);
    return candidates.length ? Math.max(...candidates) : 0;
  };
  let retryFloor = floor;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const requestedFloor = retryFloor;
    try {
      const response = await bounded(connection.simulateTransaction(probe, {
        commitment, sigVerify: false, replaceRecentBlockhash: false,
        accounts: { encoding: "base64", addresses },
        innerInstructions: false, minContextSlot: requestedFloor,
      }));
      const slot = response?.context?.slot;
      if (Number.isSafeInteger(slot) && slot > 0) retryFloor = Math.max(retryFloor, slot);
      if (!Number.isSafeInteger(slot) || slot <= 0 || slot < requestedFloor)
        throw new Error("RPC returned a missing, invalid, or below-anchor account context slot");
      if (response?.value?.err !== null)
        throw new Error("atomic account-snapshot Memo simulation failed");
      const accounts = response?.value?.accounts;
      if (!Array.isArray(accounts) || accounts.length !== keys.length)
        throw new Error("RPC omitted or reordered coherent account snapshot rows");
      const preBalances = response?.value?.preBalances;
      const postBalances = response?.value?.postBalances;
      const fee = response?.value?.fee;
      if (!Array.isArray(preBalances) || !Array.isArray(postBalances) ||
          preBalances.length !== staticAccountKeys.length ||
          postBalances.length !== staticAccountKeys.length ||
          typeof fee !== "number" || !Number.isSafeInteger(fee) || fee <= 0 ||
          [...preBalances, ...postBalances].some((balance) =>
            !Number.isSafeInteger(balance) || balance < 0))
        throw new Error("RPC omitted atomic account-snapshot balance evidence");
      if (preBalances[0] - postBalances[0] !== fee)
        throw new Error("atomic account-snapshot payer delta does not equal the simulated fee");
      for (let i = 1; i < staticAccountKeys.length; i++) {
        if (preBalances[i] !== postBalances[i])
          throw new Error("atomic account-snapshot Memo changed a non-payer balance");
      }
      const keyIndexes = new Map(staticAccountKeys.map((key, index) => [key.toBase58(), index]));
      const normalized = accounts.map((account, index) => {
        const keyIndex = keyIndexes.get(addresses[index]);
        if (!Number.isSafeInteger(keyIndex))
          throw new Error("atomic account-snapshot response address was not loaded by the probe");
        const observedLamports = account == null ? 0 : account.lamports;
        if (!Number.isSafeInteger(observedLamports) || observedLamports < 0 ||
            observedLamports !== postBalances[keyIndex])
          throw new Error("atomic account-snapshot row does not match its post-balance evidence");
        if (keyIndex !== 0) return account;
        if (account == null)
          throw new Error("atomic account-snapshot probe omitted its fee payer");
        return Object.freeze({ ...account, lamports: preBalances[0] });
      });
      return Object.freeze({ accounts: Object.freeze(normalized), slot });
    } catch (error) {
      retryFloor = Math.max(retryFloor, errorContextSlot(error));
      // Retry the complete snapshot only. No partial rows survive this attempt.
    }
  }
  throw new Error(`RPC could not produce one coherent exact-slot account snapshot after ${attempts} attempts`);
}

function writableAccountSafetyClass(account) {
  if (account == null) return Object.freeze({ exists: false });
  if (!Number.isSafeInteger(account.lamports) || account.lamports < 0 ||
      typeof account.executable !== "boolean")
    throw new Error("RPC returned malformed writable-account metadata");
  const program = accountOwner(account);
  try { new PublicKey(program); } catch { throw new Error("RPC returned an invalid writable-account program owner"); }
  const data = accountData(account);
  const details = tokenAccountDetails(account);
  if (!details) return Object.freeze({
    exists: true, program, executable: account.executable, dataLength: data.length,
  });
  return Object.freeze({
    exists: true, program, executable: account.executable, dataLength: data.length,
    token: true, mint: details.mint, authority: details.owner,
    delegate: details.delegate, state: details.state,
    isNative: details.isNative,
    closeAuthority: details.closeAuthority,
  });
}

/** Stable capability facts only: address/order and authority-bearing metadata are
 * retained, while lamports, token balances, rent epochs and arbitrary program bytes
 * are excluded so independently confirmed providers may agree across active slots. */
export function writableAccountSafetyFingerprint(addresses, accounts) {
  if (!Array.isArray(addresses) || !Array.isArray(accounts) || addresses.length !== accounts.length)
    throw new Error("writable-account fingerprint input is incomplete");
  return JSON.stringify(addresses.map((address, index) => [
    String(address), writableAccountSafetyClass(accounts[index]),
  ]));
}

/** Read a processed block height from the same bank that proves its own slot fence.
 *
 * `getBlockHeight` returns only a scalar, so a load-balanced RPC cannot give us
 * independent evidence that the answering backend actually evaluated the requested
 * `minContextSlot`. `getEpochInfo` returns `absoluteSlot` and `blockHeight` together.
 * We still send the official min-context fence, then independently reject a response
 * below it. Bounded retries tolerate a provider routing the first request to a backend
 * that has not yet caught up to a just-observed simulation slot; no unfenced fallback
 * is permitted. */
export async function fencedProcessedEpochHeight(connection, minContextSlot, {
  attempts = FINAL_HEIGHT_ATTEMPTS,
  requestTimeoutMs = FINAL_HEIGHT_REQUEST_TIMEOUT_MS,
  retryDelayMs = FINAL_HEIGHT_RETRY_DELAY_MS,
  sleep = sleepDefault,
} = {}) {
  if (!connection || typeof connection.getEpochInfo !== "function")
    throw new Error("RPC lacks context-fenced epoch-height support");
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot <= 0)
    throw new Error("final epoch-height minContextSlot is invalid");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > FINAL_HEIGHT_ATTEMPTS)
    throw new Error("final epoch-height attempt count is invalid");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      requestTimeoutMs > FINAL_HEIGHT_REQUEST_TIMEOUT_MS)
    throw new Error("final epoch-height request timeout is invalid");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 ||
      retryDelayMs > FINAL_HEIGHT_RETRY_DELAY_MS)
    throw new Error("final epoch-height retry delay is invalid");
  if (typeof sleep !== "function") throw new Error("final epoch-height sleep function is invalid");

  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("RPC epoch-height request timed out")),
            requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let retryFloor = minContextSlot;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const requestedFloor = retryFloor;
    try {
      const info = await bounded(connection.getEpochInfo({
        commitment: "processed", minContextSlot: requestedFloor,
      }));
      const absoluteSlot = info?.absoluteSlot;
      const blockHeight = info?.blockHeight;
      if (Number.isSafeInteger(absoluteSlot) && absoluteSlot > 0)
        retryFloor = Math.max(retryFloor, absoluteSlot);
      if (!Number.isSafeInteger(absoluteSlot) || absoluteSlot < requestedFloor)
        throw new Error("RPC returned a missing, invalid, or below-fence epoch slot");
      if (!Number.isSafeInteger(blockHeight) || blockHeight <= 0 || blockHeight > absoluteSlot)
        throw new Error("RPC returned a missing, invalid, or impossible epoch block height");
      return Object.freeze({ absoluteSlot, blockHeight });
    } catch {
      // Retry the complete same-bank observation only. No scalar height is retained.
    }
    if (attempt < attempts && retryDelayMs > 0) await sleep(retryDelayMs * attempt);
  }
  throw new Error(`RPC could not produce a processed epoch height at or above slot ` +
    `${minContextSlot} after ${attempts} attempts`);
}

/** Resolve every v0 lookup and reject top-level capabilities the swap does not need. */
export async function validateTransaction(transaction, expected, cfg, connection) {
  const tx = transaction;
  const wallet = String(expected.wallet);
  const required = tx.message.header.numRequiredSignatures;
  const signers = tx.message.staticAccountKeys.slice(0, required).map((key) => key.toBase58());
  if (required !== 1 || signers[0] !== wallet)
    throw new Error(`transaction signer set is not exactly the local wallet (${signers.join(",")})`);
  if (tx.message.staticAccountKeys[0]?.toBase58() !== wallet) throw new Error("local wallet is not fee payer");

  const tables = await lookupTables(connection, tx.message);
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  if (message.payerKey.toBase58() !== wallet) throw new Error("decompiled payer is not the local wallet");
  // Token-2022 mints reach this point only after auditMintAccount (via mintTokenProgram
  // below) accepted their extension list. A Token-2022 instruction at the top level of
  // the transaction is still refused by the program allow-list further down.
  const [inputProgram, outputProgram] = await Promise.all([
    mintTokenProgram(connection, expected.inputMint),
    mintTokenProgram(connection, expected.outputMint),
  ]);
  const inputAta = associatedTokenAddress(wallet, expected.inputMint, inputProgram);
  const outputAta = associatedTokenAddress(wallet, expected.outputMint, outputProgram);
  const ata = new Map([[inputAta, expected.inputMint], [outputAta, expected.outputMint]]);
  const writableAddresses = [...new Set(message.instructions.flatMap((ix) =>
    ix.keys.filter((key) => key.isWritable).map((key) => key.pubkey.toBase58())))];
  if (writableAddresses.length > 64) throw new Error("transaction has too many writable accounts for safe inspection");
  // One processed-bank response supplies both the capability scan and every custody
  // account needed as the actual swap simulation's pre-state. This removes the
  // formerly separate wallet/input/output snapshot without weakening either check.
  const observedAddresses = [wallet, inputAta, outputAta];
  const snapshotAddresses = [...new Set([...writableAddresses, ...observedAddresses])];
  const initialSnapshotMinContextSlot = await processedSlotFreshnessAnchor(connection);
  const writableSnapshot = await coherentAccountSnapshot(connection,
    snapshotAddresses.map((key) => new PublicKey(key)), {
      transaction: tx, commitment: "processed",
      minContextSlot: initialSnapshotMinContextSlot,
    });
  const snapshotByAddress = new Map(snapshotAddresses.map((address, index) =>
    [address, writableSnapshot.accounts[index]]));
  const writableInfos = writableAddresses.map((address) => snapshotByAddress.get(address));
  const preAccounts = observedAddresses.map((address) => snapshotByAddress.get(address));
  const writableCapabilityFingerprint = writableAccountSafetyFingerprint(
    writableAddresses, writableInfos);
  for (let i = 0; i < writableAddresses.length; i++) {
    const details = tokenAccountDetails(writableInfos[i]);
    if (details?.owner === wallet && !ata.has(writableAddresses[i]))
      throw new Error(`unexpected wallet-owned token account is writable: ${writableAddresses[i]}`);
  }
  let jupiterRoutes = 0;
  let systemTransferLamports = 0n;
  let computeLimit = 1_400_000;
  let computePrice = 0n;
  const createdAtas = new Set();
  // ATAs this same transaction closes again (the wrapped-SOL unwrap on every exit).
  // Rent paid to open them comes straight back inside the transaction, and Jupiter's
  // rentFeeLamports is quoted on that NET basis — see the rent guard below.
  const closedAtas = new Set();

  // First collect only wallet-owned ATAs for the two expected mints.
  for (const ix of message.instructions) {
    if (ix.programId.toBase58() !== ATA_PROGRAM) continue;
    const opcode = ix.data.length ? ix.data[0] : 0;
    if (![0, 1].includes(opcode) || ix.keys.length < 6) throw new Error("unsupported ATA instruction");
    if (!sameKey(ix.keys[0].pubkey, wallet) || !sameKey(ix.keys[2].pubkey, wallet))
      throw new Error("ATA payer/owner is not the local wallet");
    const mint = ix.keys[3].pubkey.toBase58();
    if (![expected.inputMint, expected.outputMint].includes(mint)) throw new Error(`unexpected ATA mint ${mint}`);
    const tokenProgram = mint === expected.inputMint ? inputProgram : outputProgram;
    const expectedAta = mint === expected.inputMint ? inputAta : outputAta;
    exactKey(ix.keys[1], expectedAta, "associated token account", { writable: true });
    exactKey(ix.keys[5], tokenProgram, "associated-account token program");
    createdAtas.add(expectedAta);
  }

  for (const ix of message.instructions) {
    const program = ix.programId.toBase58();
    if (program === COMPUTE_PROGRAM) {
      const opcode = ix.data[0];
      if (opcode === 2) {
        computeLimit = u32(ix.data);
        if (computeLimit <= 0 || computeLimit > cfg.maxComputeUnits)
          throw new Error(`compute-unit limit ${computeLimit} exceeds cap`);
      } else if (opcode === 3) {
        computePrice = u64(ix.data);
      } else {
        throw new Error(`unsupported compute-budget opcode ${opcode}`);
      }
      continue;
    }
    if (program === ATA_PROGRAM) continue;
    if (program === SYSTEM_PROGRAM) {
      let kind;
      try { kind = SystemInstruction.decodeInstructionType(ix); }
      catch { throw new Error("unrecognized System Program instruction"); }
      if (kind !== "Transfer") throw new Error(`System Program ${kind} is not allowed`);
      const transfer = SystemInstruction.decodeTransfer(ix);
      const destination = transfer.toPubkey.toBase58();
      if (transfer.fromPubkey.toBase58() !== wallet || ata.get(destination) !== WSOL || expected.inputMint !== WSOL)
        throw new Error("arbitrary System Program transfer rejected");
      systemTransferLamports += BigInt(transfer.lamports);
      if (systemTransferLamports > BigInt(expected.amountRaw))
        throw new Error("wrapped-SOL transfers exceed the intended input");
      continue;
    }
    if (program === TOKEN_PROGRAM) {
      const opcode = ix.data[0];
      const account = ix.keys[0]?.pubkey?.toBase58();
      if (opcode === 17) { // SyncNative
        if (ata.get(account) !== WSOL) throw new Error("SyncNative targets an unexpected account");
      } else if (opcode === 9) { // CloseAccount
        if (ata.get(account) !== WSOL || !sameKey(ix.keys[1]?.pubkey, wallet) || !sameKey(ix.keys[2]?.pubkey, wallet))
          throw new Error("token cleanup does not return wrapped SOL to the local wallet");
        closedAtas.add(account);
      } else {
        // In particular: no Approve, SetAuthority, MintTo or Burn capability.
        throw new Error(`top-level token opcode ${opcode} is not allowed`);
      }
      continue;
    }
    if (program === JUPITER_V6) {
      jupiterRoutes++;
      const route = decodeJupiterExactIn(ix.data, {
        amountRaw: expected.amountRaw,
        quotedOutputRaw: expected.quotedOutputRaw,
        minOutputRaw: expected.minOutputRaw,
        slippageBps: expected.slippageBps,
        maxSlippageBps: cfg.slippageBps,
        platformFeeBps: expected.platformFeeBps,
      });
      validateRouteAccounts(ix, route, expected,
        { input: inputProgram, output: outputProgram }, { input: inputAta, output: outputAta });
      continue;
    }
    throw new Error(`unexpected top-level program ${program}`);
  }
  if (jupiterRoutes !== 1) throw new Error(`expected one Jupiter route, found ${jupiterRoutes}`);
  if (expected.inputMint === WSOL && systemTransferLamports !== BigInt(expected.amountRaw))
    throw new Error("wrapped-SOL transfer does not equal the exact input amount");
  const priority = (computePrice * BigInt(computeLimit) + 999_999n) / 1_000_000n;
  if (priority > BigInt(cfg.maxNetworkFeeLamports))
    throw new Error(`compute price implies ${priority} lamports, over the network-fee cap`);
  const feeBasis = BigInt(String(expected.feeBasisLamports ?? expected.amountRaw));
  const maxNetworkFeePct = Number(cfg.maxNetworkFeePct ?? 10);
  if (feeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
      priority * 10_000n > feeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
    throw new Error(`compute priority fee exceeds ${maxNetworkFeePct}% of the trade basis`);
  return {
    message, tables, computeLimit, computePrice, jupiterRoutes,
    inputProgram, outputProgram, inputAta, outputAta,
    writableAddresses, writableSnapshotSlot: writableSnapshot.slot,
    writableCapabilityFingerprint, createdAtas: [...createdAtas], closedAtas: [...closedAtas],
    observedAddresses, preAccounts,
  };
}

function ownerTokenAmount(balances, owner, mint) {
  let total = 0n;
  for (const row of balances || []) {
    if (row.owner === owner && row.mint === mint) total += BigInt(row.uiTokenAmount?.amount || "0");
  }
  return total;
}

function finalizedNetworkFee(meta, intent, config) {
  const feeNumber = Number(meta?.fee);
  if (!Number.isSafeInteger(feeNumber) || feeNumber < 0)
    throw new Error("finalized transaction has an invalid network fee");
  const feeLamports = BigInt(feeNumber);
  const maxNetworkFeeLamports = Number(config.maxNetworkFeeLamports ?? 500_000);
  if (!Number.isSafeInteger(maxNetworkFeeLamports) || maxNetworkFeeLamports < 0 || feeNumber > maxNetworkFeeLamports)
    throw new Error(`finalized network fee ${feeNumber} lamports exceeds cap ${maxNetworkFeeLamports}`);
  const relativeBasis = intent.inputMint === WSOL
    ? BigInt(intent.amountRaw)
    : BigInt(String(intent.context?.position?.costBasisLamports || "0"));
  const maxNetworkFeePct = Number(config.maxNetworkFeePct ?? 10);
  if (relativeBasis <= 0n || !Number.isFinite(maxNetworkFeePct) || maxNetworkFeePct < 0 ||
      feeLamports * 10_000n > relativeBasis * BigInt(Math.floor(maxNetworkFeePct * 100)))
    throw new Error(`finalized network fee exceeds ${maxNetworkFeePct}% of the trade basis`);
  return { feeNumber, feeLamports };
}

function finalizedSignature(transaction) {
  const value = transaction?.transaction?.signatures?.[0];
  return typeof value === "string" ? value : null;
}

function finalizedAtMs(transaction) {
  const value = Number(transaction?.blockTime) > 0 ? Number(transaction.blockTime) * 1000 : null;
  return Number.isSafeInteger(value) ? value : null;
}

export function verifyFinalizedFailure(transaction, intent, signature, config = {}) {
  if (!transaction?.meta || transaction.meta.err == null)
    throw new Error("transaction is not a finalized on-chain failure");
  if (finalizedSignature(transaction) !== signature)
    throw new Error("finalized failed transaction signature mismatch");
  const owner = String(intent?.context?.wallet || "");
  const message = transaction.transaction?.message;
  const payer = message?.staticAccountKeys?.[0]?.toBase58?.() ||
    message?.accountKeys?.[0]?.toBase58?.() || String(message?.accountKeys?.[0] || "");
  if (!owner || payer !== owner)
    throw new Error("finalized failed transaction payer is not the intent wallet");
  const { feeNumber } = finalizedNetworkFee(transaction.meta, intent, config);
  return { networkFeeLamports: String(feeNumber), finalizedAtMs: finalizedAtMs(transaction) };
}

export function verifyFinalizedFill(transaction, intent, fill, config = {}) {
  if (!transaction?.meta || transaction.meta.err != null) throw new Error("transaction is not a successful finalized swap");
  const signature = transaction.transaction?.signatures?.[0];
  if (typeof signature !== "string" || signature !== fill.signature)
    throw new Error("finalized transaction signature mismatch");
  const claimedInput = fill.totalInputAmount == null ? null : positiveRaw(fill.totalInputAmount, "actual input");
  const claimedOutput = fill.totalOutputAmount == null ? null : positiveRaw(fill.totalOutputAmount, "actual output");
  const meta = transaction.meta;
  const owner = intent.context?.wallet;
  if (!owner) throw new Error("intent is missing its wallet binding");
  const message = transaction.transaction?.message;
  const payer = message?.staticAccountKeys?.[0]?.toBase58?.() || message?.accountKeys?.[0]?.toBase58?.() ||
    String(message?.accountKeys?.[0] || "");
  if (payer !== owner) throw new Error("finalized transaction payer is not the intent wallet");
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) ||
      !Number.isSafeInteger(meta.preBalances[0]) || !Number.isSafeInteger(meta.postBalances[0]))
    throw new Error("finalized transaction omitted wallet lamport balances");
  // Track the payer together with every touched wallet token account for this
  // pair. ATA creation/closure and pre-existing wrapped-SOL rent then cancel out,
  // leaving the actual SOL leg plus the transaction fee as an exact invariant.
  const walletIndices = new Set([0]);
  for (const row of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) {
    if (row.owner !== owner || ![intent.inputMint, intent.outputMint].includes(row.mint)) continue;
    const index = Number(row.accountIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= meta.preBalances.length || index >= meta.postBalances.length)
      throw new Error("finalized token balance has an invalid account index");
    walletIndices.add(index);
  }
  let beforeLamports = 0n;
  let afterLamports = 0n;
  for (const index of walletIndices) {
    if (!Number.isSafeInteger(meta.preBalances[index]) || !Number.isSafeInteger(meta.postBalances[index]))
      throw new Error("finalized transaction has an unsafe lamport balance");
    beforeLamports += BigInt(meta.preBalances[index]);
    afterLamports += BigInt(meta.postBalances[index]);
  }
  const { feeNumber, feeLamports } = finalizedNetworkFee(meta, intent, config);
  let actualInput;
  if (intent.inputMint !== WSOL) {
    const before = ownerTokenAmount(meta.preTokenBalances, owner, intent.inputMint);
    const after = ownerTokenAmount(meta.postTokenBalances, owner, intent.inputMint);
    actualInput = before - after;
    if (actualInput <= 0n) throw new Error("on-chain input-token delta is not positive");
    if (claimedInput != null && actualInput !== BigInt(claimedInput))
      throw new Error("on-chain input-token delta does not match Jupiter totals");
  } else {
    actualInput = beforeLamports - afterLamports - feeLamports;
    if (actualInput <= 0n) throw new Error("on-chain SOL spend is not positive");
    if (claimedInput != null && actualInput !== BigInt(claimedInput))
      throw new Error("on-chain SOL spend does not match Jupiter's actual input total");
  }
  if (actualInput !== BigInt(intent.amountRaw)) throw new Error("actual input does not match the exact-in intent");

  let actualOutput;
  if (intent.outputMint !== WSOL) {
    const before = ownerTokenAmount(meta.preTokenBalances, owner, intent.outputMint);
    const after = ownerTokenAmount(meta.postTokenBalances, owner, intent.outputMint);
    actualOutput = after - before;
    if (actualOutput <= 0n) throw new Error("on-chain output-token delta is not positive");
    if (claimedOutput != null && actualOutput !== BigInt(claimedOutput))
      throw new Error("on-chain output-token delta does not match Jupiter totals");
  } else {
    actualOutput = afterLamports - beforeLamports + feeLamports;
    if (actualOutput <= 0n) throw new Error("on-chain SOL proceeds are not positive");
    if (claimedOutput != null && actualOutput !== BigInt(claimedOutput))
      throw new Error("on-chain SOL proceeds do not match Jupiter's actual output total");
  }
  return { totalInputAmount: String(actualInput), totalOutputAmount: String(actualOutput),
    networkFeeLamports: String(feeNumber), finalizedAtMs: finalizedAtMs(transaction),
    signature: fill.signature };
}

export class JupiterV2Executor {
  constructor({ connection, secondaryConnection = null, keypair, journal, apiKey, baseUrl = "https://api.jup.ag/swap/v2",
    fetchFn = fetch, log = () => {}, now = () => Date.now(), sleep = sleepDefault,
    hardStop = () => false, submissionGate = () => {}, config = {} }) {
    if (!connection || !keypair || !journal) throw new Error("connection, keypair and journal are required");
    if (!apiKey) throw new Error("JUPITER_API_KEY is required for live execution");
    if (!String(baseUrl).startsWith("https://")) throw new Error("Jupiter API must use HTTPS");
    this.connection = connection;
    this.secondaryConnection = secondaryConnection;
    this.keypair = keypair;
    this.journal = journal;
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.fetch = fetchFn;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.hardStop = hardStop;
    this.submissionGate = submissionGate;
    // The process lock prevents a second poller, while this map closes the smaller
    // async race inside one process: two callers must not both pass the durable
    // conflict check while their transactions are still being built/simulated.
    this.inFlightIntents = new Map();
    // Bounded poller recovery must be fair across positions. Without a rotating
    // cursor, maxIntents:1 selected the oldest ambiguous/submitted exit on every tick
    // and later stops never received even a chain-observation pass.
    this.lastBoundedRecoveryIntentId = null;
    this.cfg = {
      slippageBps: 300,
      maxPriceImpactPct: 5,
      maxExitPriceImpactPct: 50,
      maxFeeBps: 100,
      maxNetworkFeeLamports: 500_000,
      maxNetworkFeePct: 10,
      maxRentLamports: MAX_GROSS_RENT_LAMPORTS,
      maxEntryRoundTripLossPct: 12,
      maxEntryQuoteDriftPct: 5,
      maxEntryPreflightAgeMs: 60_000,
      maxExitTriggerAgeMs: 60_000,
      maxExitMarkProviderDivergencePct: 1,
      maxComputeUnits: 1_400_000,
      maxAttempts: 3,
      finalityTimeoutMs: 30_000,
      ...config,
    };
  }

  get wallet() { return this.keypair.publicKey.toBase58(); }
  headers(extra = {}) { return { "x-api-key": this.apiKey, ...extra }; }

  _isSafetyExit(intent) {
    // mirror_exit (desk-led-v4): the desk's determination evaluated by the bot while the
    // desk is unreachable — a safety exit in every rule here, same route and snapshot proof.
    return (intent.kind === "risk_exit" || intent.kind === "desk_exit" || intent.kind === "mirror_exit") &&
      intent.inputMint === intent.mint && intent.outputMint === WSOL &&
      intent.context?.position?.mint === intent.mint;
  }

  _validateIntentSpec(intent) {
    if (intent.kind === "entry") {
      if (intent.inputMint !== WSOL || intent.outputMint !== intent.mint)
        throw new Error("entry intent must swap wrapped SOL into its named mint");
      return;
    }
    if (!this._isSafetyExit(intent))
      throw new Error("exit intent must reduce its durable named position into wrapped SOL");
  }

  _inFlightConflict(intent, exceptId = null) {
    const isSafetyExit = this._isSafetyExit(intent);
    for (const active of this.inFlightIntents.values()) {
      if (active.id === exceptId) continue;
      const activeIsSafetyExit = this._isSafetyExit(active);
      // Entries and unknown kinds take the strict global lock. Safety exits take
      // only their position lock, so an unrelated stop is never head-of-line
      // blocked by another mint's unresolved work.
      if (!isSafetyExit || (!activeIsSafetyExit && active.kind !== "entry") || active.mint === intent.mint)
        return active.id;
    }
    return null;
  }

  async _withIntentScope(intent, fn) {
    const conflict = this._inFlightConflict(intent);
    if (conflict)
      throw new Error(`in-flight intent ${conflict} conflicts with ${intent.id}; submission serialized`);
    this.inFlightIntents.set(intent.id, intent);
    try { return await fn(); }
    finally { this.inFlightIntents.delete(intent.id); }
  }

  async order({ inputMint, outputMint, amountRaw, taker = true }) {
    positiveRaw(amountRaw, "order amount");
    const params = new URLSearchParams({
      inputMint, outputMint, amount: String(amountRaw), swapMode: "ExactIn",
      slippageBps: String(this.cfg.slippageBps),
      excludeRouters: "jupiterz,dflow,okx",
    });
    if (taker) params.set("taker", this.wallet);
    const response = await this.fetch(`${this.baseUrl}/order?${params}`, {
      headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(12_000),
    });
    return jsonResponse(response, "Jupiter /order");
  }

  async quote(inputMint, outputMint, amountRaw) {
    const order = await this.order({ inputMint, outputMint, amountRaw, taker: false });
    if (order.inputMint !== inputMint || order.outputMint !== outputMint || String(order.inAmount) !== String(amountRaw))
      throw new Error("Jupiter quote did not echo the requested pair and amount");
    positiveRaw(order.outAmount, "quoted output");
    // Mark quotes must remain visible during a liquidity collapse so stop/age/desk-exit
    // policy can fire. The signed transaction applies the distinct entry/exit caps.
    priceImpactPercent(order);
    return order;
  }

  async preflightEntry(inputMint, outputMint, amountRaw) {
    const forward = await this.quote(inputMint, outputMint, amountRaw);
    const reverse = await this.quote(outputMint, inputMint, String(forward.outAmount));
    const input = BigInt(positiveRaw(amountRaw, "preflight input"));
    const returned = BigInt(positiveRaw(reverse.outAmount, "preflight returned amount"));
    const lossPct = Number(input > returned ? (input - returned) * 1_000_000n / input : 0n) / 10_000;
    const cap = Number(this.cfg.maxEntryRoundTripLossPct);
    if (!Number.isFinite(cap) || cap < 0 || cap > 100) throw new Error("invalid entry round-trip-loss cap");
    if (lossPct > cap) throw new Error(`entry round-trip loss ${lossPct}% exceeds cap ${cap}%`);
    return { forward, reverse, lossPct };
  }

  async _prepareUnsignedProvider({ connection, transactionBytes, order, intent,
    feeBasisLamports, label }) {
    let tx;
    try { tx = VersionedTransaction.deserialize(transactionBytes); }
    catch { throw new Error(`${label} RPC could not deserialize the exact unsigned transaction`); }
    const serializedUnsigned = Buffer.from(tx.serialize());
    if (serializedUnsigned.length > 1232)
      throw new Error(`serialized transaction is ${serializedUnsigned.length} bytes (Solana max 1232)`);
    const validation = await validateTransaction(tx, {
      inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, wallet: this.wallet,
      quotedOutputRaw: String(order.outAmount),
      minOutputRaw: String(order.otherAmountThreshold),
      slippageBps: Number(order.slippageBps),
      platformFeeBps: Number(order.platformFee?.feeBps ?? 0),
      feeBasisLamports,
    }, this.cfg, connection);
    const { observedAddresses, preAccounts } = validation;
    if (!preAccounts[0])
      throw new Error(`${label} RPC omitted pre-simulation wallet/account state`);
    // These independent scalar facts do not depend on one another, so read them in
    // parallel. The fresh-blockhash compatibility check already ran against the
    // processed atomic bank; retain the independently reviewed confirmed-height
    // bound here, then require a processed same-bank height again at the final fence.
    const [rentExemptionValue, chainHeight] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(165, "processed"),
      connection.getBlockHeight("confirmed"),
    ]);
    const rentExemptionLamports = Number(rentExemptionValue);
    if (!Number.isSafeInteger(rentExemptionLamports) || rentExemptionLamports <= 0)
      throw new Error(`${label} RPC returned an invalid classic-token account rent exemption`);
    /* Jupiter's rentFeeLamports is quoted NET: rent for accounts that remain open after
     * the transaction. Proved on mainnet — the buy (both ATAs stay open) reported
     * 4,078,560 and matched; the sell (wrapped-SOL ATA created AND closed in the same
     * transaction) reported 0, while this guard demanded the gross 2,039,280 and refused.
     * Every unwrap exit, i.e. every stop, was impossible. Net out same-transaction
     * closes; keep strict equality, so an exit that claims rent with nothing actually
     * missing is still refused. */
    const createdAtas = new Set(validation.createdAtas);
    const closedAtas = new Set(validation.closedAtas ?? []);
    const missingCreated = [
      [validation.inputAta, preAccounts[1]],
      [validation.outputAta, preAccounts[2]],
    ].filter(([address, account]) => createdAtas.has(address) &&
      (!account || isClosedAccountTombstone(account)));
    // GROSS: every account this order must fund up front — what the rent CAP bounds.
    // NET: gross minus accounts the same transaction closes again — what Jupiter quotes.
    /* A classic SPL token account is 165 bytes. The ATA program opens a Token-2022
     * account with the ImmutableOwner extension: 165 + 1 account-type byte + a 4-byte
     * TLV header = 170 bytes, so the chain charges more for it (2,074,080 vs 2,039,280
     * lamports at today's rent). Jupiter's rentFeeLamports, measured 2026-09-03 on a
     * SOL→pump.fun order, still quotes every ATA at the 165-byte figure (4,078,560 for
     * two accounts) — and quoted it GROSS although that same transaction created and
     * closed the wrapped-SOL account (a sell the day before quoted the same shape NET,
     * 0). So the estimate can be net or gross, classic-sized or chain-sized; every one
     * of those four figures is derived from chain facts, and the strict match accepts
     * exactly those four and nothing else. The gross CAP and the provider-agreement
     * facts use the true chain cost. Rent never enters the SOL-spend check:
     * validateSimulationEffects sums wallet + token-account lamports, so rent moving
     * into a wallet-owned ATA is not a loss there. The extra rent read happens only
     * when this order actually opens a Token-2022 account. */
    const programOf = (address) => address === validation.inputAta
      ? validation.inputProgram : validation.outputProgram;
    const opensToken2022Ata = missingCreated.some(([address]) => programOf(address) === TOKEN_2022_PROGRAM);
    const token2022RentLamports = opensToken2022Ata
      ? Number(await connection.getMinimumBalanceForRentExemption(170, "processed"))
      : rentExemptionLamports;
    if (!Number.isSafeInteger(token2022RentLamports) || token2022RentLamports < rentExemptionLamports)
      throw new Error(`${label} RPC returned an invalid Token-2022 account rent exemption`);
    const chainRentForAta = (address) => programOf(address) === TOKEN_2022_PROGRAM
      ? token2022RentLamports : rentExemptionLamports;
    const stillOpen = missingCreated.filter(([address]) => !closedAtas.has(address));
    const expectedGrossRentLamports = missingCreated
      .reduce((sum, [address]) => sum + chainRentForAta(address), 0);
    const expectedNetRentLamports = stillOpen
      .reduce((sum, [address]) => sum + chainRentForAta(address), 0);
    const classicQuotedNetRentLamports = stillOpen.length * rentExemptionLamports;
    const classicQuotedGrossRentLamports = missingCreated.length * rentExemptionLamports;
    const acceptableRentLamports = new Set([expectedNetRentLamports, classicQuotedNetRentLamports,
      expectedGrossRentLamports, classicQuotedGrossRentLamports]);
    const reportedRentLamports = Number(order.rentFeeLamports ?? 0);
    /* AN OVER-ESTIMATE IS THE SAFE DIRECTION, AND IT WAS BEING REFUSED.
     *
     * This demanded an EXACT match against one of the four chain-derived figures. On
     * 2026-09-04 that refused the bot's first ever autonomous entry — "SKIP Mobi:
     * secondary RPC canonical ATA rent facts do not match Jupiter's rent estimate" —
     * one second after it had sized the position and taken it to the last gate.
     *
     * Measured against public mainnet, the chain is right and Jupiter is stale: a
     * 165-byte token account is rent-exempt at 1,855,569 lamports and a 170-byte one at
     * 1,887,234, while Jupiter still quotes the older 2,039,280. Both of our providers
     * agreed with the chain; only Jupiter disagreed, and it disagreed HIGH.
     *
     * Quoting more rent than the chain will take cannot hurt us: the rent goes to an
     * account we own and comes back when it closes, validateSimulationEffects bounds
     * what actually leaves the wallet, and MAX_GROSS_RENT_LAMPORTS still caps the
     * absolute figure. Quoting LESS is the dangerous direction and is still refused
     * outright. So an over-estimate is accepted within a bounded margin of the chain's
     * own number — generous enough for a stale constant, tight enough that a wildly
     * wrong quote is still a refusal. */
    const chainGross = Math.max(...acceptableRentLamports);
    const overEstimateCeiling = Math.min(
      Math.floor(chainGross * RENT_OVER_ESTIMATE_MULTIPLE),
      Number(this.cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS));
    const rentIsAcceptable = acceptableRentLamports.has(reportedRentLamports) ||
      (reportedRentLamports > chainGross && reportedRentLamports <= overEstimateCeiling);
    if (!Number.isSafeInteger(reportedRentLamports) || !rentIsAcceptable)
      throw new Error(`${label} RPC canonical ATA rent facts do not match Jupiter's rent estimate ` +
        `(chain: ${expectedNetRentLamports} net of same-transaction closes, ${expectedGrossRentLamports} gross` +
        (classicQuotedGrossRentLamports !== expectedGrossRentLamports
          ? `; at Jupiter's classic 165-byte sizing ${classicQuotedNetRentLamports} net, ${classicQuotedGrossRentLamports} gross` : "") +
        `; Jupiter reports ${reportedRentLamports})`);
    if (expectedGrossRentLamports > Number(this.cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS))
      throw new Error(`${label} RPC canonical ATA rent exceeds the reviewed gross rent cap`);
    const claimedExpiry = Number(order.lastValidBlockHeight);
    if (!Number.isSafeInteger(chainHeight) || chainHeight <= 0)
      throw new Error(`${label} RPC could not read the chain block height to bound the order expiry`);
    if (claimedExpiry <= chainHeight)
      throw new Error(`order expiry ${claimedExpiry} is already behind the ${label} chain height ${chainHeight}`);
    if (claimedExpiry > chainHeight + (this.cfg.blockHeightWindow ?? 600))
      throw new Error(`order expiry ${claimedExpiry} is ${claimedExpiry - chainHeight} blocks ahead of the ${label} chain ` +
        `(cap ${this.cfg.blockHeightWindow ?? 600}) — an unbounded expiry wedges the journal and disarms every exit`);
    // Rent that stays in a wallet-owned account that remains open never leaves the
    // custody set, so only the remainder of the quoted taker rent can be spent outside it.
    const foreignRentAllowanceLamports = Math.max(0,
      Math.min(reportedRentLamports, Number(this.cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS)) -
      expectedNetRentLamports);
    const simulation = await this._simulateUnsigned({
      connection, tx, observedAddresses, preAccounts, validation, order, intent,
      minContextSlot: validation.writableSnapshotSlot, foreignRentAllowanceLamports,
    });
    const postWritableSnapshot = await coherentAccountSnapshot(connection,
      validation.writableAddresses.map((address) => new PublicKey(address)), {
        // The simulation itself is processed. Asking a lagging confirmed bank to
        // satisfy its head slot would systematically fail until confirmation and
        // burn the order's expiry window. Re-read the exact processed-or-newer bank;
        // the initial capability snapshot remains independently checked by both RPCs.
        transaction: tx, commitment: "processed", minContextSlot: simulation.contextSlot,
      });
    const postWritableFingerprint = writableAccountSafetyFingerprint(
      validation.writableAddresses, postWritableSnapshot.accounts);
    if (postWritableFingerprint !== validation.writableCapabilityFingerprint)
      throw new Error(`${label} RPC writable-account capabilities changed across simulation`);
    // Use a processed epoch-info observation whose returned bank slot independently
    // proves it is at-or-after the post-simulation capability scan. A bare scalar
    // getBlockHeight cannot provide that same-response slot evidence behind an RPC
    // load balancer.
    const finalHeightEvidence = await fencedProcessedEpochHeight(
      connection, postWritableSnapshot.slot, { sleep: this.sleep });
    const finalChainHeight = finalHeightEvidence.blockHeight;
    if (finalChainHeight < chainHeight)
      throw new Error(`${label} RPC block height regressed after the final capability fence`);
    const remainingBlocks = claimedExpiry - finalChainHeight;
    if (remainingBlocks < MIN_SIGNABLE_BLOCKS_REMAINING)
      throw new Error(`order has only ${remainingBlocks} blocks left after the ${label} final safety fence ` +
        `(minimum ${MIN_SIGNABLE_BLOCKS_REMAINING})`);
    if (remainingBlocks > (this.cfg.blockHeightWindow ?? 600))
      throw new Error(`order expiry remains outside the ${label} bounded block-height window`);
    return {
      tx, validation, observedAddresses, preAccounts, chainHeight: finalChainHeight,
      simulation, postWritableSnapshotSlot: postWritableSnapshot.slot,
      rentExemptionLamports, expectedGrossRentLamports,
    };
  }

  /** Build, independently inspect and independently chain-simulate a transaction
   * while every signature slot is still empty. Every signable entry/exit and the
   * read-only exit mark share this two-provider boundary. */
  async _prepareUnsigned(intent) {
    if (!this.secondaryConnection || this.secondaryConnection === this.connection)
      throw new Error("independent secondary RPC is required before any transaction may be signed");
    const order = await this.order({
      inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, taker: true,
    });
    const impactCap = priceImpactCapForIntent(intent.kind, this.cfg);
    if (!Number.isFinite(impactCap) || impactCap < 0 || impactCap > 100)
      throw new Error(`invalid ${intent.kind === "entry" ? "entry" : "exit"} price-impact cap`);
    const feeBasisLamports = intent.inputMint === WSOL
      ? String(intent.amountRaw)
      : (() => {
          const beforeRaw = BigInt(String(intent.context?.position?.qtyRaw || "0"));
          const basisRaw = BigInt(String(intent.context?.position?.costBasisLamports || "0"));
          const sellRaw = BigInt(String(intent.amountRaw));
          if (beforeRaw <= 0n || basisRaw <= 0n || sellRaw <= 0n || sellRaw > beforeRaw)
            throw new Error("exit intent has no valid proportional fee basis");
          return String(sellRaw === beforeRaw ? basisRaw : basisRaw * sellRaw / beforeRaw);
        })();
    validateOrderEnvelope(order, {
      inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, wallet: this.wallet, feeBasisLamports,
    }, { ...this.cfg, maxPriceImpactPct: impactCap });
    const transactionBytes = Buffer.from(order.transaction, "base64");
    const [primary, secondary] = await Promise.all([
      this._prepareUnsignedProvider({ connection: this.connection, transactionBytes,
        order, intent, feeBasisLamports, label: "primary" }),
      this._prepareUnsignedProvider({ connection: this.secondaryConnection, transactionBytes,
        order, intent, feeBasisLamports, label: "secondary" }),
    ]);
    if (primary.validation.inputAta !== secondary.validation.inputAta ||
        primary.validation.outputAta !== secondary.validation.outputAta ||
        primary.validation.inputProgram !== secondary.validation.inputProgram ||
        primary.validation.outputProgram !== secondary.validation.outputProgram)
      throw new Error("RPC providers disagree on the validated transaction custody accounts");
    if (primary.validation.writableCapabilityFingerprint !==
        secondary.validation.writableCapabilityFingerprint)
      throw new Error("RPC providers disagree on writable-account safety capabilities");
    if (primary.rentExemptionLamports !== secondary.rentExemptionLamports ||
        primary.expectedGrossRentLamports !== secondary.expectedGrossRentLamports)
      throw new Error("RPC providers disagree on canonical ATA gross rent facts");
    const simulation = agreeSimulationOutputs(primary.simulation, secondary.simulation,
      this.cfg.maxSimulationProviderDivergencePct ??
        this.cfg.maxExitMarkProviderDivergencePct ?? 1);

    /* SIMULATE BEFORE SIGNING — the invariant that dissolves a whole class of bug.
     *
     * Two designs failed here before this one. The original simulated AFTER signing
     * and BEFORE journaling: an RPC that broadcast what it was asked to simulate (or
     * a crash inside the call) produced an on-chain buy the journal never heard of.
     * The first repair journaled the signed bytes before simulating and marked a
     * refused simulation "submitted" — and the re-review proved that WORSE: _resume
     * treats any submitted attempt without an execute response as a transport retry
     * and BROADCASTS it, so every transaction the simulation refused was sent anyway
     * one tick later, converting the refusal into a send trigger.
     *
     * The root cause of both was the same: broadcastable bytes existed in a state the
     * journal could not express. So the bytes are now never broadcastable during the
     * simulation at all — the transaction is simulated UNSIGNED (sigVerify:false; the
     * signature does not change execution, only authorizes it), and a refusal of any
     * kind costs nothing, journals nothing, and retries with a fresh quote next tick.
     * Signing happens only after the chain has agreed with the quote, and the FIRST
     * disclosure of broadcastable bytes anywhere is the /execute POST, which happens
     * strictly after recordSigned and markSubmitted — the states the reconciliation
     * machinery was built to fence. "signed" once again truly means "undisclosed". */
    return {
      order, tx: primary.tx, validation: primary.validation,
      chainHeight: Math.max(primary.chainHeight, secondary.chainHeight),
      primaryChainHeight: primary.chainHeight, secondaryChainHeight: secondary.chainHeight,
      simulation, primarySimulation: primary.simulation, secondarySimulation: secondary.simulation,
      walletLamportsByProvider: [primary, secondary].map(({ preAccounts }) => {
        const value = Number(preAccounts?.[0]?.lamports);
        if (!Number.isSafeInteger(value) || value < 0)
          throw new Error("RPC returned an invalid pre-simulation wallet balance");
        return value;
      }),
      feeBasisLamports,
    };
  }

  /** Exercise the complete execution boundary without creating broadcastable bytes.
   * The active-cap WSOL→mainnet-USDC route checks Jupiter authentication/order
   * construction, ALT/account reads, both independent validators/simulators, and a
   * conservative wallet spend+fee+rent reserve on BOTH views. No signature, journal
   * mutation or /execute request exists anywhere on this path. */
  async probeExecutionReadiness({ amountLamports = EXECUTION_READINESS_AMOUNT_LAMPORTS } = {}) {
    const amount = Number(amountLamports);
    if (!Number.isSafeInteger(amount) || amount < 1 ||
        amount > EXECUTION_READINESS_MAX_AMOUNT_LAMPORTS)
      throw new Error("execution-readiness amount is outside the supported live-cap range");
    const amountRaw = String(amount);
    const intent = {
      kind: "entry", mint: MAINNET_USDC, inputMint: WSOL, outputMint: MAINNET_USDC,
      amountRaw, context: {},
    };
    const prepared = await this._prepareUnsigned(intent);
    const requiredLamports = BigInt(amount) +
      BigInt(Math.ceil(Number(this.cfg.maxNetworkFeeLamports ?? 500_000))) +
      BigInt(Math.ceil(Number(this.cfg.maxRentLamports ?? MAX_GROSS_RENT_LAMPORTS))) +
      BigInt(EXECUTION_READINESS_RESERVE_LAMPORTS);
    if (prepared.walletLamportsByProvider.some((balance) => BigInt(balance) < requiredLamports))
      throw new Error("execution-readiness wallet reserve is insufficient on one or both RPC providers");
    const observedAt = Number(this.now());
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0)
      throw new Error("execution-readiness observation time is invalid");
    return Object.freeze({
      ready: true,
      observedAt,
      route: EXECUTION_READINESS_ROUTE,
      providers: 2,
      amountLamports: amount,
      providerDivergencePct: prepared.simulation.divergencePct,
      chainHeight: prepared.chainHeight,
      lastValidBlockHeight: Number(prepared.order.lastValidBlockHeight),
      /* WHAT WE ARE ACTUALLY BIDDING WITH.
       *
       * Agave's central scheduler ranks buffered transactions by
       * `reward * 1_000_000 / (cost + 1)`, and `cost` is driven by the compute-unit
       * limit the transaction REQUESTS, not by what it consumes or what it pays. So a
       * transaction asking for the 1,400,000 default while really using ~70k carries a
       * ~20x penalty in the denominator against an identical bid that asked for what it
       * needs. The validator already parses both numbers out of the built transaction
       * and nothing ever looked at them, so we have never known which of those two we
       * are. Reporting them costs nothing and answers it from the next rehearsal.
       *
       * Deliberately NOT changing the request. This endpoint's parameters for trimming
       * the limit could not be confirmed without the live API key, and an unknown query
       * parameter that 400s would break every entry. Measure first. */
      computeUnitLimit: prepared.validation?.computeLimit ?? null,
      computeUnitPriceMicroLamports: prepared.validation?.computePrice != null
        ? String(prepared.validation.computePrice) : null,
    });
  }

  /** Read-only executable exit mark. It requests a wallet-bound ExactIn order and
   * runs the same envelope, transaction, program, account, expiry and unsigned
   * simulation checks as execution. It never signs, journals, or calls /execute. */
  async preflightExitMark({ mint, amountRaw, position } = {}) {
    const inputMint = String(mint || "");
    try { new PublicKey(inputMint); }
    catch { throw new Error("exit mark mint must be a valid public key"); }
    if (inputMint === WSOL) throw new Error("exit mark input must be a non-WSOL token mint");
    const amount = positiveRaw(amountRaw, "exit mark amount");
    const positionMint = String(position?.mint || "");
    const positionQtyRaw = positiveRaw(position?.qtyRaw, "exit mark position quantity");
    const costBasisLamports = positiveRaw(position?.costBasisLamports, "exit mark position cost basis");
    const intent = {
      kind: "risk_exit", mint: inputMint, inputMint, outputMint: WSOL, amountRaw: amount,
      context: { position: { mint: positionMint, qtyRaw: positionQtyRaw, costBasisLamports } },
    };
    this._validateIntentSpec(intent);
    if (!this.secondaryConnection || this.secondaryConnection === this.connection)
      throw new Error("independent secondary RPC is required for an executable exit mark");
    const { order, chainHeight, simulation } = await this._prepareUnsigned(intent);
    const actualOutputRaw = simulation.actualOutputRaw;
    const observedAt = Number(this.now());
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new Error("exit mark observation time is invalid");
    return Object.freeze({
      inputMint,
      outputMint: WSOL,
      inputAmountRaw: amount,
      actualOutputRaw,
      quotedOutputRaw: String(order.outAmount),
      minOutputRaw: String(order.otherAmountThreshold),
      priceImpactPct: priceImpactPercent(order),
      slippageBps: Number(order.slippageBps),
      router: "metis",
      measurement: "simulated_net_wallet_custody_delta",
      finalized: false,
      providers: 2,
      providerDivergencePct: simulation.divergencePct,
      chainHeight,
      lastValidBlockHeight: Number(order.lastValidBlockHeight),
      observedAt,
    });
  }

  async _buildSigned(intent) {
    if (this.hardStop()) throw new Error("HARD STOP is present — no transaction will be built");
    const { order, tx } = await this._prepareUnsigned(intent);

    // The order and chain simulation are the last executable facts before signing.
    // Recheck the local entry gate after those network calls, then bind the final
    // quote/minOut to the independently monitored authored zone. Nothing signed
    // exists if either condition changed while the transaction was being built.
    if (intent.kind === "entry") {
      this.submissionGate(intent);
      validateExecutableEntryOrder(intent, order, { ...this.cfg, nowMs: this.now() });
    } else validateExecutableExitOrder(intent, order, { ...this.cfg, nowMs: this.now() });

    tx.sign([this.keypair]);
    const signed = Buffer.from(tx.serialize());
    if (signed.length > 1232) throw new Error(`serialized transaction is ${signed.length} bytes (Solana max 1232)`);
    const signature = bs58.encode(Buffer.from(tx.signatures[0]));
    return {
      requestId: order.requestId,
      signedTx: signed,
      signature,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: Number(order.lastValidBlockHeight),
      quotedOutputRaw: String(order.outAmount),
      minOutputRaw: String(order.otherAmountThreshold),
      order,
    };
  }

  /** Pre-signing simulation of the UNSIGNED transaction — nothing disclosed here can
   * be broadcast, so a refusal is free and safe to retry with a fresh quote. */
  async _simulateUnsigned({ connection = this.connection, tx, observedAddresses, preAccounts,
    validation, order, intent, minContextSlot, foreignRentAllowanceLamports = 0 }) {
    if (!Array.isArray(tx?.signatures) || tx.signatures.length !== 1 ||
        tx.signatures.some((signature) => Buffer.from(signature).some((byte) => byte !== 0)))
      throw new Error("Jupiter transaction is not unsigned");
    const simulation = await connection.simulateTransaction(tx, {
      commitment: "processed", sigVerify: false, replaceRecentBlockhash: false,
      accounts: { encoding: "base64", addresses: observedAddresses },
      innerInstructions: true, minContextSlot,
    });
    const contextSlot = Number(simulation?.context?.slot);
    if (!Number.isSafeInteger(contextSlot) || contextSlot < minContextSlot)
      throw new Error("simulation returned a missing, invalid, or below-fence context slot");
    if (simulation?.value?.err) throw new Error(`unsigned transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const postAccounts = simulation?.value?.accounts;
    if (!Array.isArray(postAccounts) || postAccounts.length !== observedAddresses.length)
      throw new Error("simulation omitted requested wallet/token account state");
    const effects = validateSimulationEffects({ wallet: preAccounts[0], input: preAccounts[1], output: preAccounts[2] },
      { wallet: postAccounts[0], input: postAccounts[1], output: postAccounts[2] }, {
        wallet: this.wallet,
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        amountRaw: intent.amountRaw,
        minOutputRaw: String(order.otherAmountThreshold),
        quotedOutputRaw: String(order.outAmount),
        inputProgram: validation.inputProgram,
        outputProgram: validation.outputProgram,
        foreignRentAllowanceLamports,
      }, this.cfg);
    return { ...effects, contextSlot };
  }

  async _status(signature, connection = this.connection) {
    const result = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    return result?.value?.[0] || null;
  }

  async _finalizedTransaction(signature, connection = this.connection) {
    if (typeof connection?.getTransaction !== "function") return null;
    return connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  }

  /* PRESENCE-seeking read, fenced primary→secondary. Confirming that a signature IS
   * on chain is sound from either RPC — observation is evidence for existence on any
   * honest node — so a primary outage must not turn this wait into a throw. (The
   * ABSENCE proof is different: it names its connections explicitly elsewhere and is
   * untouched here — falling back silently there would collapse "two independent
   * histories" into one.) A read that fails on both counts as a miss for this
   * iteration, not an error: the sixth review found the unfenced first read threw
   * before the fast path's observedStatus OR could run, evaporating the exact
   * observation the replacement guard needed. */
  async _readEither(fn) {
    try {
      const value = await fn(this.connection);
      if (value != null || !this.secondaryConnection) return value;
      return fn(this.secondaryConnection);
    }
    catch (error) {
      if (!this.secondaryConnection) throw error;
      return fn(this.secondaryConnection);
    }
  }

  /** Like _readEither, but says WHICH connection answered — evidence needs provenance.
   * The seventh review found a finalized failure observed via the secondary being
   * passed downstream labeled as the PRIMARY's error, whereupon the two-RPC
   * consensus check read only the secondary again and confirmed it against itself. */
  async _readEitherTagged(fn) {
    try {
      const value = await fn(this.connection);
      if (value != null || !this.secondaryConnection) return { value, source: "primary" };
      return { value: await fn(this.secondaryConnection), source: "secondary" };
    }
    catch (error) {
      if (!this.secondaryConnection) throw error;
      return { value: await fn(this.secondaryConnection), source: "secondary" };
    }
  }

  async _waitFinalized(signature, timeoutMs = this.cfg.finalityTimeoutMs) {
    const deadline = this.now() + timeoutMs;
    let observedStatus = false;
    let observedFinalized = false;
    do {
      let status = null, statusSource = "primary";
      try {
        const read = await this._readEitherTagged((c) => this._status(signature, c));
        status = read.value; statusSource = read.source;
      } catch { status = null; }                     // both RPCs down: a miss, not a verdict
      if (status) observedStatus = true;
      const isFinalized = status?.confirmationStatus === "finalized" || (status && status.confirmations === null);
      if (isFinalized) {
        observedFinalized = true;
        let transaction = null;
        try { transaction = await this._readEither((c) => this._finalizedTransaction(signature, c)); }
        catch { transaction = null; }
        if (status.err)
          return { outcome: "failed", error: status.err, errorSource: statusSource,
                   transaction, observedStatus, observedFinalized };
        if (transaction) return { outcome: "finalized", transaction, observedStatus, observedFinalized };
      }
      if (this.now() >= deadline) break;
      await this.sleep(1_000);
    } while (true);
    return { outcome: "pending", observedStatus, observedFinalized };
  }

  async _confirmFinalizedFailure(signature, intent,
    { primaryError = null, secondaryError = null } = {}) {
    if (!this.secondaryConnection || this.secondaryConnection === this.connection)
      return { confirmed: false, reason: "no independent secondary RPC is configured" };
    let primaryStatus, secondaryStatus, primaryTransaction, secondaryTransaction;
    try {
      [primaryStatus, secondaryStatus, primaryTransaction, secondaryTransaction] = await Promise.all([
        primaryError == null ? this._status(signature, this.connection) : null,
        secondaryError == null ? this._status(signature, this.secondaryConnection) : null,
        this._finalizedTransaction(signature, this.connection),
        this._finalizedTransaction(signature, this.secondaryConnection),
      ]);
    } catch (error) {
      return { confirmed: false, reason: `independent failure check failed: ${error.message}` };
    }
    const primary = primaryError ?? ((primaryStatus?.confirmationStatus === "finalized" ||
      (primaryStatus && primaryStatus.confirmations === null)) ? primaryStatus.err : null);
    const secondary = secondaryError ?? ((secondaryStatus?.confirmationStatus === "finalized" ||
      (secondaryStatus && secondaryStatus.confirmations === null)) ? secondaryStatus.err : null);
    if (primary == null || secondary == null)
      return { confirmed: false, reason: "both RPCs did not report a finalized error" };
    if (!sameRpcError(primary, secondary))
      return { confirmed: false, reason: "RPCs reported different finalized errors" };
    if (!primaryTransaction || !secondaryTransaction)
      return { confirmed: false, reason: "both RPCs did not return finalized failed-transaction metadata" };
    if (!sameRpcError(primaryTransaction.meta?.err, primary) ||
        !sameRpcError(secondaryTransaction.meta?.err, secondary))
      return { confirmed: false, reason: "finalized transaction metadata disagrees with RPC failure status" };
    let primaryFee, secondaryFee;
    try {
      primaryFee = verifyFinalizedFailure(primaryTransaction, intent, signature, this.cfg);
      secondaryFee = verifyFinalizedFailure(secondaryTransaction, intent, signature, this.cfg);
    } catch (error) {
      return { confirmed: false, reason: `failed-transaction evidence rejected: ${error.message}` };
    }
    if (String(primaryFee.networkFeeLamports) !== String(secondaryFee.networkFeeLamports))
      return { confirmed: false, reason: "RPCs reported different finalized network fees" };
    if (String(primaryFee.finalizedAtMs) !== String(secondaryFee.finalizedAtMs))
      return { confirmed: false, reason: "RPCs reported different finalized block times" };
    return { confirmed: true, error: primary, feeEvidence: primaryFee };
  }

  async _acceptFinalized(intent, attempt, executeResult, _observedTransaction) {
    /* A single RPC's `finalized` JSON is not custody evidence: a compromised
     * provider can invent the status, payer balances and token deltas for a known
     * signature. For an exit that would retire the only durable position record while
     * the coins are still held. Re-read BOTH configured providers explicitly and
     * require independently finalized success plus matching verified effects. A lag,
     * outage or missing transaction is merely unresolved (state remains recoverable);
     * contradictory finalized evidence is durable AMBIGUOUS. */
    if (!this.secondaryConnection || this.secondaryConnection === this.connection)
      throw new Error(`transaction ${attempt.signature} awaits an independent second-provider finalized confirmation`);
    const providerReads = await Promise.allSettled([
      Promise.all([
        this._status(attempt.signature, this.connection),
        this._finalizedTransaction(attempt.signature, this.connection),
      ]),
      Promise.all([
        this._status(attempt.signature, this.secondaryConnection),
        this._finalizedTransaction(attempt.signature, this.secondaryConnection),
      ]),
    ]);
    if (providerReads.some((read) => read.status !== "fulfilled"))
      throw new Error(`transaction ${attempt.signature} awaits two-provider finalized evidence; an RPC read failed`);
    const observations = providerReads.map((read) => ({
      status: read.value[0], transaction: read.value[1],
    }));
    const finalized = (status) => status?.confirmationStatus === "finalized" ||
      (status && status.confirmations === null);
    if (observations.some(({ status }) => !finalized(status)))
      throw new Error(`transaction ${attempt.signature} awaits finalized confirmation from both RPC providers`);
    if (observations.some(({ status }) => status.err != null)) {
      const error = `RPC providers disagree on finalized success for ${attempt.signature}`;
      this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
      throw new Error(error);
    }
    if (observations.some(({ transaction }) => !transaction))
      throw new Error(`transaction ${attempt.signature} is finalized but its effects are not yet available from both RPC providers`);

    let fills;
    try {
      fills = observations.map(({ transaction }) => verifyFinalizedFill(transaction, intent,
        // Once both independent RPCs prove the journaled signature and custody
        // effects, Jupiter's transport response is diagnostic only. Its claimed
        // signature/totals may never veto stronger chain truth.
        { signature: attempt.signature }, this.cfg));
    }
    catch (error) {
      const conflict = `two-provider finalized-effect verification failed: ${error.message}`;
      this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
      throw error;
    }
    for (const key of ["signature", "totalInputAmount", "totalOutputAmount", "networkFeeLamports",
      "finalizedAtMs"]) {
      if (String(fills[0][key]) !== String(fills[1][key])) {
        const error = `RPC providers disagree on finalized ${key} for ${attempt.signature}`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
        throw new Error(error);
      }
    }
    const fill = fills[0];
    if (BigInt(fill.totalOutputAmount) < BigInt(attempt.minOutputRaw)) {
      const error = "actual output is below the signed order's minimum";
      this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
      throw new Error(error);
    }
    const evidence = executeResult ?? {
      status: "RecoveredFromFinalizedChain", signature: attempt.signature,
    };
    this.journal.markConfirmed(intent.id, attempt.attempt, fill, evidence);
    return this.journal.getIntent(intent.id);
  }

  /* `observedOnce` carries a caller's PRIOR observation of this signature into every
   * branch that treats "never seen" as replacement authority. Two reviews running
   * found the same defect at two different call sites — an escape path observed a
   * status, handed off, and the evidence evaporated because the next reader failed to
   * re-observe it. Evidence is threaded now, not re-derived; a signature seen ONCE by
   * anyone is never converted into markExpired's permission for a fresh signature. */
  async _reconcile(intent, attempt, executeResult = attempt.execute,
    { observedOnce = false, finalityTimeoutMs = null } = {}) {
    const durableJupiterSuccess = executeResult?.status === "Success" && Number(executeResult.code) === 0;
    const provablyUndisclosed = attempt.state === "signed" &&
      attempt.protocol === CURRENT_TX_ATTEMPT_PROTOCOL;
    /* A "signed" attempt has never been disclosed — its signature CANNOT be on chain —
     * so waiting the full finality timeout for it is pure stall: measured, a wedged
     * signed attempt cost ~30 seconds of every tick, exactly when a latched exit needs
     * the tick loop fast. One quick status read keeps the belt (the invariant could be
     * wrong) without the 30-second suspenders. Submitted attempts keep the full wait —
     * their bytes are genuinely in flight. */
    /* The fast path exists only for the common case: nothing on chain at all. The
     * moment ANY status is observed for a "signed" attempt, the invariant is already
     * breached and this is no longer the case to be fast in — hand it to the full
     * _waitFinalized, whose retry loop knows how to wait out the routine RPC race
     * where the transaction index lags the status index. A hand-rolled mirror of its
     * success shape dropped exactly that guard (`if (transaction)`) and turned a
     * sub-second index lag into a permanent AMBIGUOUS latch on a landed SUCCESS. */
    const waitFinalized = async () => finalityTimeoutMs == null
      ? await this._waitFinalized(attempt.signature)
      : await this._waitFinalized(attempt.signature, finalityTimeoutMs);
    let finality = provablyUndisclosed
      ? await (async () => {
          /* The fast read is fenced primary-then-secondary — it runs during the exact
           * outages that wedge signed attempts, and an unfenced throw here re-froze
           * every exit behind one dead attempt for the whole primary outage. */
          let status = null;
          try { status = await this._status(attempt.signature); }
          catch {
            if (!this.secondaryConnection) throw new Error("primary RPC unavailable for the signed-attempt status read");
            status = await this._status(attempt.signature, this.secondaryConnection);
          }
          if (!status) return { outcome: "pending", observedStatus: false, observedFinalized: false };
          /* The fast read's own observation must survive the handoff. _waitFinalized
           * starts observedStatus at false from its OWN reads — if the fork that
           * produced our observation drops before it looks, it times out with
           * observedStatus:false and the expiry branch reads that as permission for a
           * replacement signature. The one piece of evidence the belt collected would
           * be the one piece the guard never saw. OR it in. */
          const waited = await waitFinalized();
          return { ...waited, observedStatus: true };
        })()
      : await waitFinalized();
    if (observedOnce) finality = { ...finality, observedStatus: true };
    let signedObservationError = null;
    if (provablyUndisclosed && finality.observedStatus) {
      // Persist the loss of replacement authority BEFORE any further provider read.
      // A crash, lagging second provider, or pruned next read may otherwise erase this
      // observation while the durable row still says `signed`/never disclosed.
      signedObservationError = `supposedly undisclosed signature ${attempt.signature} was observed on chain; ` +
        "replacement authority is permanently withheld pending finalized reconciliation";
      this.journal.markAmbiguous(intent.id, attempt.attempt, signedObservationError, executeResult);
    }
    if (finality.outcome === "failed") {
      const error = `transaction finalized with error: ${JSON.stringify(finality.error)}`;
      /* The error's PROVENANCE decides which side the consensus check may reuse it
       * for. When the fence delivered this failure from the SECONDARY, labeling it
       * primaryError made _confirmFinalizedFailure skip the primary and compare the
       * secondary against itself — one RPC's word dressed as two-RPC consensus,
       * authorizing a phantom fee and a replacement swap. Tag it honestly and the
       * check reads the OTHER connection fresh. */
      const consensus = await this._confirmFinalizedFailure(attempt.signature, intent,
        finality.errorSource === "secondary"
          ? { secondaryError: finality.error }
          : { primaryError: finality.error });
      if (!consensus.confirmed) {
        const conflict = `${error}; independent RPC consensus unavailable (${consensus.reason}) — manual reconciliation required`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
        throw new Error(conflict);
      }
      this.journal.markFinalizedFailure(intent.id, attempt.attempt, error,
        consensus.feeEvidence, executeResult);
      throw new Error(error);
    }
    if (finality.outcome === "finalized") {
      return await this._acceptFinalized(intent, attempt, executeResult, finality.transaction);
    }
    if (signedObservationError) throw new Error(signedObservationError);
    // Fenced like every other height read on the recovery path: the primary being
    // down is the normal weather here, and the secondary can answer this question.
    let height;
    try { height = await this.connection.getBlockHeight("confirmed"); }
    catch {
      if (!this.secondaryConnection) throw new Error("primary RPC unavailable for the expiry height read");
      height = await this.secondaryConnection.getBlockHeight("confirmed");
    }
    if (height > attempt.lastValidBlockHeight) {
      // One RPC returning null is not proof that a transaction never landed. Cross-
      // check an independent history before permitting a replacement signature.
      if (!this.secondaryConnection) {
        const error = "primary RPC reports expiry but no secondary RPC can prove absence; manual reconciliation required";
        this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
        throw new Error(error);
      }
      let secondaryStatus, secondaryHeight;
      try {
        [secondaryStatus, secondaryHeight] = await Promise.all([
          this._status(attempt.signature, this.secondaryConnection),
          this.secondaryConnection.getBlockHeight("confirmed"),
        ]);
      } catch (error) {
        const reason = `secondary RPC could not prove expired signature absence: ${error.message}`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, reason, executeResult);
        throw new Error(reason);
      }
      const secondaryFinalized = secondaryStatus?.confirmationStatus === "finalized" ||
        (secondaryStatus && secondaryStatus.confirmations === null);
      if (secondaryStatus && provablyUndisclosed) {
        const observation = `supposedly undisclosed signature ${attempt.signature} was observed by the ` +
          "secondary RPC; replacement authority is permanently withheld pending finalized reconciliation";
        this.journal.markAmbiguous(intent.id, attempt.attempt, observation, executeResult);
      }
      if (secondaryFinalized && secondaryStatus.err) {
        const error = `transaction finalized with error on secondary RPC: ${JSON.stringify(secondaryStatus.err)}`;
        if (finality.observedFinalized) {
          const conflict = `${error}; conflicts with prior success evidence — manual reconciliation required`;
          this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
          throw new Error(conflict);
        }
        const consensus = await this._confirmFinalizedFailure(attempt.signature, intent,
          { secondaryError: secondaryStatus.err });
        if (!consensus.confirmed) {
          const conflict = `${error}; independent RPC consensus unavailable (${consensus.reason}) — manual reconciliation required`;
          this.journal.markAmbiguous(intent.id, attempt.attempt, conflict, executeResult);
          throw new Error(conflict);
        }
        this.journal.markFinalizedFailure(intent.id, attempt.attempt, error,
          consensus.feeEvidence, executeResult);
        throw new Error(error);
      }
      if (secondaryFinalized) {
        const transaction = await this._finalizedTransaction(attempt.signature, this.secondaryConnection);
        if (!transaction) {
          const error = "secondary RPC sees finality but cannot return transaction metadata";
          this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
          throw new Error(error);
        }
        return await this._acceptFinalized(intent, attempt, executeResult, transaction);
      }
      if (secondaryStatus || secondaryHeight <= attempt.lastValidBlockHeight)
        throw new Error(`transaction ${attempt.signature} is still unresolved on the secondary RPC`);

      // Jupiter code 0 is documented as confirmed, and any RPC observation means
      // the signature may have landed on a fork. Neither may ever be converted into
      // permission for a replacement signature merely because history is missing.
      if (durableJupiterSuccess || finality.observedStatus) {
        const evidence = durableJupiterSuccess ? "Jupiter reported confirmed success" :
          (finality.observedFinalized ? "primary RPC observed finality" : "primary RPC observed the signature");
        const error = `${evidence}, but finalized transaction metadata is unavailable; manual reconciliation required`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
        throw new Error(error);
      }

      let primaryBlockhash, secondaryBlockhash;
      try {
        [primaryBlockhash, secondaryBlockhash] = await Promise.all([
          this.connection.isBlockhashValid(attempt.blockhash, { commitment: "confirmed" }),
          this.secondaryConnection.isBlockhashValid(attempt.blockhash, { commitment: "confirmed" }),
        ]);
      } catch (error) {
        const reason = `two RPCs could not prove the signed blockhash expired: ${error.message}`;
        this.journal.markAmbiguous(intent.id, attempt.attempt, reason, executeResult);
        throw new Error(reason);
      }
      if (primaryBlockhash?.value !== false || secondaryBlockhash?.value !== false)
        throw new Error(`signed blockhash for ${attempt.signature} is still valid or unresolved; replacement refused`);
      const historyReads = await Promise.allSettled([
        this._status(attempt.signature, this.connection),
        this._status(attempt.signature, this.secondaryConnection),
      ]);
      if (historyReads.some((read) => read.status !== "fulfilled"))
        throw new Error(`signed blockhash for ${attempt.signature} is invalid, but both RPC histories ` +
          "did not independently prove signature absence; replacement refused");
      const freshObservation = historyReads.map((read) => read.value).find(Boolean);
      if (freshObservation) {
        const observation = `signature ${attempt.signature} was observed during the final two-RPC absence fence; ` +
          "replacement authority is permanently withheld pending finalized reconciliation";
        if (provablyUndisclosed)
          this.journal.markAmbiguous(intent.id, attempt.attempt, observation, executeResult);
        throw new Error(observation);
      }
      // History absence is not non-execution proof on a pruned/non-archival RPC. Only
      // an attempt STILL durably `signed` is known never to have left this process.
      // `ambiguous` deliberately does not remember whether its prior state was signed
      // or submitted, so it may never be converted into replacement authority here.
      if (!provablyUndisclosed) {
        const provenance = attempt.state === "signed"
          ? `unversioned signed-era protocol ${attempt.protocol ?? "missing"}`
          : attempt.state;
        const error = `${provenance} signature is absent from two RPC histories after blockhash expiry; ` +
          "its bytes may have been exposed, so replacement is forbidden and manual reconciliation is required";
        this.journal.markAmbiguous(intent.id, attempt.attempt, error, executeResult);
        throw new Error(error);
      }
      this.journal.markExpired(intent.id, attempt.attempt,
        "never-submitted signature absent and blockhash invalid on two independent RPCs after block-height expiry");
      throw new Error("never-submitted signed transaction expired on two RPCs; the intent may be rebuilt next tick");
    }
    throw new Error(`transaction ${attempt.signature} is unresolved; identical bytes will be retried`);
  }

  async _resume(intent, attempt) {
    // A received execute response is durable too; after a restart, query chain first
    // and never depend on building a replacement transaction.
    if (attempt.execute?.status === "Success" && Number(attempt.execute.code) === 0)
      return this._reconcile(intent, attempt, attempt.execute);

    /* Builds before the unsigned-preflight protocol used `signed`/`submitted` for
     * states whose bytes may already have reached an RPC simulation. In particular,
     * a refused signed simulation could be conservatively persisted as `submitted`
     * without ever reaching /execute. Null histories after expiry cannot prove those
     * bytes never executed, while actively POSTing them would turn a refusal into a
     * send trigger. Observe/finalize every non-current attempt, but never POST it or
     * convert its absence into replacement authority. */
    if (["signed", "submitted"].includes(attempt.state) &&
        attempt.protocol !== CURRENT_TX_ATTEMPT_PROTOCOL) {
      this.log(`recovery ${intent.id}: ${attempt.state} attempt protocol ${attempt.protocol ?? "missing"} is ` +
        "observation-only; disclosure and replacement are forbidden");
      return this._reconcile(intent, attempt, attempt.execute, { finalityTimeoutMs: 0 });
    }

    /* NEVER DISCLOSE PROVABLY-DEAD BYTES. A "signed" attempt has, by the new
     * invariant, never left this process — so after downtime longer than its
     * blockhash lifetime (a laptop sleep is enough) the transaction is provably
     * un-landable. POSTing it anyway did worse than waste a call: markSubmitted ran
     * first, so _reconcile then saw a "submitted" attempt whose absence it could
     * prove but whose state demanded the conservative verdict, and marked the intent
     * AMBIGUOUS — permanently disarming every exit over bytes that were never in
     * flight. Check the chain height BEFORE disclosing: an expired signed attempt
     * routes to _reconcile, whose "signed" branch takes the safe markExpired path and
     * clears the way for a fresh attempt. One getBlockHeight per resume, and only
     * bytes that can still land are ever disclosed. */
    if (["signed", "submitted"].includes(attempt.state) &&
        attempt.protocol === CURRENT_TX_ATTEMPT_PROTOCOL) {
      /* Three corrections across the fourth and fifth reviews. The bound is >= —
       * _buildSigned's own convention treats expiry <= chainHeight as dead, because a
       * transaction whose lastValidBlockHeight equals the tip can only be included in
       * the NEXT block, where it is invalid; the strict > left a one-block boundary
       * that disclosed un-landable bytes. Both independent providers must establish
       * the pre-disclosure bound; it runs mid-dump on restart, exactly when stale
       * views and RPC 429 storms are most likely.
       *
       * And when EITHER RPC cannot answer, the attempt is HELD, not disclosed. The first
       * fallback proceeded to the POST on the theory that a dead tx cannot land —
       * true, and beside the point: landing was never the risk, the STATE TRANSITION
       * was. markSubmitted before a doomed POST left a 'submitted' attempt whose
       * absence proof can only ever conclude AMBIGUOUS, permanently freezing every
       * exit — over bytes that were never in flight. Throwing keeps the attempt
       * 'signed'; the next tick, with any RPC back, takes the safe path. An exit
       * delayed one tick beats an exit disarmed forever. */
      /* First disclosure needs an independent answer from BOTH configured providers.
       * Falling back to the secondary only when the primary threw let a merely stale
       * primary authorize a POST after the secondary/current chain had already crossed
       * lastValidBlockHeight. The dead bytes then became `submitted`, where absence can
       * only resolve to AMBIGUOUS and permanently strand a risk exit. The providers do
       * not have to report the identical tip, but both must independently say the
       * transaction is still live. */
      // Start height reads without awaiting them. Two independently dead exact hashes
      // plus two explicit null histories are already sufficient to resolve an
      // undisclosed attempt; a method-specific/hung height endpoint must not prevent
      // that stronger proof from releasing a stop.
      const heightReadsPromise = Promise.allSettled([
        this.connection?.getBlockHeight?.("confirmed"),
        this.secondaryConnection?.getBlockHeight?.("confirmed"),
      ]);

      /* `lastValidBlockHeight` is authored by the order service; a plausible number
       * does not prove the transaction's exact recent blockhash is live on either
       * chain view. Before the first disclosure, BOTH providers must affirm that exact
       * blockhash. Two false answers route into observation/expiry without POSTing;
       * disagreement or outage holds the signed bytes until consensus is available.
       * This exact-hash proof deliberately precedes the height-disagreement hold: a
       * stale primary height must not strand a stop whose blockhash BOTH providers
       * independently reject and whose signature neither history has observed. */
      const validityReads = await Promise.allSettled([
        this.connection?.isBlockhashValid?.(attempt.blockhash, { commitment: "confirmed" }),
        this.secondaryConnection?.isBlockhashValid?.(attempt.blockhash, { commitment: "confirmed" }),
      ]);
      const validity = validityReads.map((read) => read.status === "fulfilled"
        ? read.value?.value : null);
      if (validity.every((value) => value === false)) {
        // The exact blockhash, not Jupiter's authored height, is the transaction's
        // liveness authority. Before granting a replacement, nevertheless prove that
        // neither history has EVER observed the supposedly undisclosed signature.
        const statusReads = await Promise.allSettled([
          this._status(attempt.signature, this.connection),
          this._status(attempt.signature, this.secondaryConnection),
        ]);
        if (statusReads.some((read) => read.status !== "fulfilled"))
          throw new Error(`both RPCs reject signed attempt ${intent.id}/${attempt.attempt}'s blockhash, ` +
            "but signature-history absence could not be proved; holding bytes undisclosed");
        const observed = statusReads.map((read) => read.value).find(Boolean);
        if (observed)
          return this._reconcile(intent, attempt, attempt.execute, { observedOnce: true });
        if (attempt.state === "signed") {
          this.journal.markExpired(intent.id, attempt.attempt,
            "never-submitted signature absent and exact blockhash invalid on two independent RPCs");
          throw new Error("never-submitted signed transaction has a two-RPC-invalid blockhash; the intent may be rebuilt next tick");
        }
        // `submitted` is a write-ahead state: a crash may have happened immediately
        // before OR after the POST. Dead bytes must never be retransmitted, and two
        // null histories cannot distinguish those crash sides. Reconciliation keeps
        // the no-replacement invariant and will conservatively quarantine absence.
        return this._reconcile(intent, attempt, attempt.execute);
      }
      if (!validity.every((value) => value === true)) {
        if (this.hardStop()) return this._reconcile(intent, attempt, attempt.execute);
        let observed = null;
        try { observed = await this._readEither((c) => this._status(attempt.signature, c)); }
        catch { observed = null; }
        if (observed) return this._reconcile(intent, attempt, attempt.execute, { observedOnce: true });
        throw new Error(`cannot prove signed attempt ${intent.id}/${attempt.attempt}'s exact blockhash is live ` +
          "on both RPC providers; holding bytes undisclosed");
      }

      const heightReads = await heightReadsPromise;
      const heights = heightReads.map((read) => read.status === "fulfilled" ? read.value : null);
      const validHeights = heights.every((height) => Number.isSafeInteger(height) && height > 0);
      if (!validHeights) {
        /* Either height read failed. Before holding, two escapes the sixth review
         * demanded: the operator's HARD STOP routes to reconciliation rather than
         * being unreachable behind this hold, and a fenced STATUS read — which needs
         * no height — gets a chance to resolve the attempt outright. */
        if (this.hardStop()) return this._reconcile(intent, attempt, attempt.execute);
        let observed = null;
        try { observed = await this._readEither((c) => this._status(attempt.signature, c)); }
        catch { observed = null; }
        if (observed) return this._reconcile(intent, attempt, attempt.execute, { observedOnce: true });
        throw new Error(`cannot bound signed attempt ${intent.id}/${attempt.attempt}'s expiry independently — ` +
          "both RPC height reads are required and no status is observable; holding the bytes undisclosed until both chain reads succeed");
      }
      const expiry = Number(attempt.lastValidBlockHeight);
      const blockHeightWindow = Number(this.cfg.blockHeightWindow ?? 600);
      if (!Number.isSafeInteger(expiry) || expiry <= 0 ||
          !Number.isFinite(blockHeightWindow) || blockHeightWindow <= 0)
        throw new Error(`signed attempt ${intent.id}/${attempt.attempt} has an invalid expiry bound`);
      const remainingByProvider = heights.map((height) => expiry - height);
      if (remainingByProvider.some((remaining) => remaining <= 0))
        return this._reconcile(intent, attempt, attempt.execute);
      if (remainingByProvider.some((remaining) => remaining > blockHeightWindow))
        throw new Error(`cannot bound signed attempt ${intent.id}/${attempt.attempt}'s expiry independently — ` +
          `both RPC providers must place it within ${blockHeightWindow} remaining blocks; holding bytes undisclosed`);
    }

    if (this.hardStop()) return this._reconcile(intent, attempt, attempt.execute);
    if (intent.kind === "entry") {
      try { this.submissionGate(intent); }
      catch (error) {
        // A gate may close after bytes have already left this process. Never let a
        // new pause/staleness result deadlock recovery. Submitted bytes may have
        // landed; never-submitted signed bytes may expire only after the two-RPC
        // proof in _reconcile. Neither path sends /execute while the gate is closed.
        return this._reconcile(intent, attempt, attempt.execute);
      }
    }

    this.journal.markSubmitted(intent.id, attempt.attempt);
    let result;
    try {
      const response = await this.fetch(`${this.baseUrl}/execute`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          signedTransaction: attempt.signedTx.toString("base64"),
          requestId: attempt.requestId,
          /* Jupiter's /execute validates this field as a STRING and rejects a number
           * with a ZodError. Sending the journal's numeric value 400'd EVERY live
           * submission — the single reason this executor had never completed a trade.
           * It stayed invisible while the error handler rendered structured bodies as
           * "[object Object]"; the first run after that was fixed named this exactly.
           * The journal keeps the number (it is compared against chain heights); only
           * the wire form is a string. */
          lastValidBlockHeight: String(attempt.lastValidBlockHeight),
        }),
      });
      result = await jsonResponse(response, "Jupiter /execute");
      this.journal.recordExecuteResponse(intent.id, attempt.attempt, result);
    } catch (error) {
      this.log(`execute transport: ${error.message}; reconciling ${attempt.signature}`);
      return this._reconcile(intent, this.journal.latestAttempt(intent.id));
    }
    if (result.status === "Success" && Number(result.code) === 0)
      return this._reconcile(intent, this.journal.latestAttempt(intent.id), result);

    // A Failed HTTP response is not proof that a submitted Solana transaction did
    // not land. The signature and expiry decide that, never the transport message.
    return this._reconcile(intent, this.journal.latestAttempt(intent.id), result);
  }

  async executeIntent(spec) {
    this._validateIntentSpec(spec);
    let intent = this.journal.ensureIntent({
      ...spec,
      context: { ...(spec.context || {}), wallet: this.wallet },
    });
    return this._withIntentScope(intent, async () => {
      // Re-read after taking the in-process scope: a concurrent reconciliation may
      // have changed the durable state before this caller acquired it.
      intent = this.journal.getIntent(intent.id);
      this._validateIntentSpec(intent);
      if (intent.state === "accounted" || intent.state === "confirmed") return intent;
      if (intent.state === "ambiguous")
        throw new Error(`intent ${intent.id} is AMBIGUOUS; existing signature is recovery-only`);
      const blocking = this.journal.hasConflictingIntent(intent);
      if (blocking)
        throw new Error(`unresolved intent ${blocking} conflicts with ${intent.kind} ${intent.id}`);

      let attempt = this.journal.latestAttempt(intent.id);
      if (attempt && ["signed", "submitted"].includes(attempt.state)) return this._resume(intent, attempt);
      const count = this.journal.attempts(intent.id).length;

    /* EXITS ARE NOT EXHAUSTIBLE THE WAY ENTRIES ARE.
     * A flat cap of 3 was correct for entries — money not spent is money kept — and
     * catastrophic for exits: three SlippageToleranceExceeded failures during the
     * exact dump that fired the stop (the normal condition, not the rare one) left the
     * intent permanently dead, the position riding to zero, and new entries frozen
     * behind the latch. An exit may retry past maxAttempts ONLY while every prior
     * attempt is terminally resolved (anything live already returned via _resume
     * above, and hasConflictingIntent holds same-position work), with a cooldown so a fast
     * dump cannot burn fees every tick, and never past maxExitAttempts — each
     * on-chain failure costs a real, accounted fee. */
      const isExit = intent.kind !== "entry";
      const exitCap = this.cfg.maxExitAttempts ?? 12;
    /* The exit cap binds from attempt ONE, not only past the entry cap. Nesting it
     * inside the count>=maxAttempts branch meant an operator who set
     * MAX_EXIT_TX_ATTEMPTS below MAX_TX_ATTEMPTS was silently ignored for the first
     * maxAttempts fee-burning tries — their fee-exposure model wrong by exactly the
     * bound they asked for.
     *
     * And it counts FEE-BEARING attempts, not rows. The cap's whole justification is
     * that each on-chain failure costs a real fee — but an 'expired' attempt (signed,
     * never disclosed, aged out during a laptop sleep) cost nothing and proved
     * nothing, and counting it let two free sleep-expiries consume a low-cap
     * operator's entire exit budget and permanently kill a stop. Only finalized
     * failures spend the budget; expiries retry for free, each one gated by a real
     * blockhash lifetime so this cannot hot-loop. */
      const exitFeeAttempts = isExit
        ? this.journal.attempts(intent.id).filter((a) => a.state === "failed").length
        : 0;
      if (isExit && exitFeeAttempts >= exitCap)
        throw new Error(`exit intent ${intent.id} exhausted ${exitCap} fee-bearing attempts — manual intervention required`);
      if (!isExit && count >= this.cfg.maxAttempts)
        throw new Error(`intent ${intent.id} exhausted ${this.cfg.maxAttempts} attempts`);
    /* The cooldown keys on the SAME counter as the cap — fee-bearing attempts. Keying
     * it on total rows charged free expiries the throttle the cap had just exempted
     * them from: three sleep-expiries armed a 60s-per-retry brake on a stop that had
     * spent nothing, during exactly the fast dump the exit ladder exists for. Mixed
     * semantics between two branches of one policy is how that happened. */
      if (isExit && exitFeeAttempts >= this.cfg.maxAttempts) {
      /* The cooldown's CLOCK reads the last FEE-BEARING attempt, matching its counter.
       * Reading latestAttempt stamped the brake from whatever row was touched last —
       * including a free expiry markExpired had just timestamped — so the exempt
       * attempts re-armed the throttle their exemption existed to avoid. Same defect
       * as the counter, one field over. */
        const lastFee = this.journal.attempts(intent.id).filter((a) => a.state === "failed").at(-1);
        const last = lastFee?.updatedAt ?? lastFee?.createdAt ?? 0;
        const coolMs = this.cfg.exitRetryCooldownMs ?? 60_000;
        if (this.now() - Number(last) < coolMs)
          throw new Error(`exit intent ${intent.id} is cooling down after ${exitFeeAttempts} fee-bearing attempts (${coolMs}ms between retries)`);
        this.log(`exit ${intent.id}: retrying past the entry cap — fee-bearing attempt ${exitFeeAttempts + 1} of ${exitCap}, all prior attempts terminally resolved`);
      }
      if (this.hardStop()) throw new Error("HARD STOP is present — no new submission");
      if (intent.kind === "entry") this.submissionGate(intent);

    /* _buildSigned simulates the UNSIGNED transaction before it ever signs, so a
     * refusal here (quote-vs-chain shortfall, output floors, plain simulation error)
     * has disclosed nothing broadcastable, journals nothing, and costs nothing — the
     * next tick retries with a fresh quote. Only a transaction the chain has already
     * agreed with reaches recordSigned, and the first broadcastable disclosure
     * anywhere is the /execute POST inside _resume, which the journal fences. */
      const signed = await this._buildSigned(intent);
      // A safety exit is allowed to start while an unrelated entry is still in its
      // pre-sign build. Re-check immediately before the durable signing boundary so
      // that newly unresolved work still freezes that entry; the unjournaled bytes
      // have never left memory and are safe to discard.
      const concurrent = this._inFlightConflict(intent, intent.id);
      const newlyBlocking = this.journal.hasConflictingIntent(intent);
      if (concurrent || newlyBlocking)
        throw new Error(`submission scope changed during build; unresolved intent ${concurrent || newlyBlocking} now conflicts with ${intent.id}`);
      attempt = this.journal.recordSigned(intent.id, { ...signed, attempt: count + 1 });
      intent = this.journal.getIntent(intent.id);
      return this._resume(intent, attempt);
    });
  }

  async recoverPending({ observationOnly = false, maxIntents = Infinity } = {}) {
    const recovered = [];
    const limit = maxIntents === Infinity ? Infinity : Number(maxIntents);
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error("recovery maxIntents must be a positive integer");
    // Confirmed intents have finished chain recovery and belong exclusively to the
    // poller's accounting quarantine path. Slice only after removing them: one
    // permanently malformed confirmed exit must not consume the single bounded slot
    // forever and starve every genuinely signed/submitted stop behind it.
    const ordered = this.journal.pendingIntents()
      .filter((intent) => intent.state !== "confirmed")
      .sort((left, right) =>
      Number(!this._isSafetyExit(left)) - Number(!this._isSafetyExit(right)) ||
      Number(left.createdAt) - Number(right.createdAt) || left.id.localeCompare(right.id));
    // Preserve the original exit-first contract: round-robin inside the highest
    // available priority class, rather than occasionally rotating an entry in front
    // of a still-unresolved stop.
    const safety = ordered.filter((intent) => this._isSafetyExit(intent));
    const pool = limit !== Infinity && safety.length ? safety : ordered;
    let rotated = pool;
    if (limit !== Infinity && pool.length > 1 && this.lastBoundedRecoveryIntentId) {
      const prior = pool.findIndex((intent) => intent.id === this.lastBoundedRecoveryIntentId);
      if (prior >= 0) rotated = [...pool.slice(prior + 1), ...pool.slice(0, prior + 1)];
    }
    const pending = rotated.slice(0, limit);
    if (limit !== Infinity && pending.length)
      this.lastBoundedRecoveryIntentId = pending.at(-1).id;
    for (const intent of pending) {
      const attempt = this.journal.latestAttempt(intent.id);
      if (!attempt) continue;
      try {
        const value = await this._withIntentScope(intent, async () => {
          const current = this.journal.getIntent(intent.id);
          const latest = this.journal.latestAttempt(intent.id);
          if (!latest || current.state === "confirmed" || current.state === "accounted") return current;
          // The poller's pre-risk pass is observation/finality only: no /execute POST,
          // no first disclosure and no full finality wait may sit ahead of fresh stop
          // evaluation. A later bounded background pass may retransmit identical bytes.
          if (observationOnly)
            return this._reconcile(current, latest, latest.execute, { finalityTimeoutMs: 0 });
          // AMBIGUOUS recovery is observation-only. Its prior signed/submitted state
          // was overwritten, so retransmission or expiry replacement would weaken
          // idempotency. Fresh finalized evidence may still resolve it safely. Use
          // a one-shot probe so a backlog of ambiguous entries cannot add 30s each
          // ahead of the poller's stop-management phase.
          if (current.state === "ambiguous")
            return this._reconcile(current, latest, latest.execute, { finalityTimeoutMs: 0 });
          try { this._validateIntentSpec(current); }
          catch (error) {
            this.log(`recovery ${current.id}: ${error.message}; reconciling malformed intent without submission`);
            return this._reconcile(current, latest, latest.execute, { finalityTimeoutMs: 0 });
          }
          const blocking = this.journal.hasConflictingIntent(current);
          if (blocking) {
            this.log(`recovery ${current.id}: conflicting intent ${blocking}; reconciling without submission`);
            return this._reconcile(current, latest, latest.execute);
          }
          return this._resume(current, latest);
        });
        recovered.push(value);
      }
      catch (error) { this.log(`recovery ${intent.id}: ${error.message}`); }
    }
    return recovered;
  }
}
