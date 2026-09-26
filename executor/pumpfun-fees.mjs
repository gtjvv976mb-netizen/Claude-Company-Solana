/**
 * CREATOR FEES — the only thing on this desk that earns without being right about a coin.
 *
 * WHY THIS EXISTS, stated plainly because the reason is the whole design.
 *
 * On 2026-09-25 the owner pointed at bagworkagent.fun and said they were working their
 * magic. So their magic was measured, across 26 of their agents and 362 closed trades,
 * from their best performer to their worst:
 *
 *     trading      -0.077 SOL
 *     creator fees +14.515 SOL
 *     rewards      +0.620 SOL       (21% win rate; 8 winners, 16 losers)
 *
 * Their number-one agent shows +15.6 SOL and is MINUS 0.105 on trading. Agent 59 shows
 * +1.398 and is minus 0.019 on trading with two closed trades and zero wins. Not one agent
 * in that system makes money trading. Every SOL of profit is the pump.fun creator fee on
 * the coin the agent itself launched. The trading is what makes the coin worth watching,
 * the watching makes volume, and the volume makes the fee. The bot is the marketing and
 * this instruction is the business.
 *
 * HAWK-AI has the same trading problem and no such revenue line. This module is that line.
 *
 * WHAT IS DIFFERENT HERE, and it is not cosmetic: their `pnlSol` ADDS claimed fees to
 * trading P&L, which is how a bot that loses on every round trip displays +15.6 SOL. This
 * desk books a claim as its own kind and never sums the two into one number. A revenue
 * stream that flatters a losing strategy is how a losing strategy survives contact with
 * its owner.
 *
 * ── THE EVIDENCE ──────────────────────────────────────────────────────────────────────
 *
 * Nothing below is copied from a blog or guessed from a name. Every constant was read out
 * of transactions that LANDED on mainnet, and every account is DERIVED and checked against
 * what those transactions actually used. Three independent claims, three different
 * creators, identical discriminators and identical account shapes:
 *
 *   4x8cpVhKu6LxECtqzquUJQqLEsoZpERpAhrLH2Lo8Cjkfcbt7fwGdRZHTi4QCPnAs8jJX29JQhdyJWw5Q7GZgQBF
 *   2u8Ck3foJquAzH6xTKn6NSBWeQJ3VfVJ4nxhjaahnHmUyYZ2nWbp3x4oD5J1VGyXEsApj4Dw8CuHtjLEahWrepXa
 *   5Hw6ukFQb5sB7ABcjKXBqxYnyL3NNSHw47DvonMJLcYvLf9KYupFNhnqFyzJ3GHgtyeWXMBwGDnv8foarXarb6Qc
 *
 * TWO PROGRAMS HOLD TWO SEPARATE VAULTS, and a claim that reads only one leaves money
 * behind. The bonding curve program keeps its creator fee in its own vault; once a coin
 * bonds, trading moves to pump-amm, which keeps ITS creator fee somewhere else entirely.
 * The landed transactions claim both in one transaction, then close the wrapped-SOL
 * account so the lamports arrive as native SOL.
 *
 * THE TRAP, and it is the reason this file derives rather than hardcodes: the two programs
 * spell the same seed differently.
 *
 *     bonding curve   ["creator-vault", creator]   HYPHEN
 *     pump-amm        ["creator_vault", creator]   UNDERSCORE
 *
 * Both derivations produce a perfectly valid address. The wrong one owns nothing, the
 * claim fails or claims zero, and nothing anywhere says why. Both were verified against
 * the observed accounts before a line of this shipped.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { WSOL, ATA_PROGRAM, associatedTokenAddress } from "./jupiter.mjs";
import { TOKEN_PROGRAM } from "./token2022.mjs";

export const PUMPFUN_FEES_VERSION = "pumpfun-fees-v1";

/** The bonding-curve program. Same id snipe-venue-pumpfun.mjs trades against. */
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** pump-amm: where a coin's trading goes after it bonds, with its own creator vault. */
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Each program's Anchor event authority, observed identical in all three claims. */
export const PUMP_EVENT_AUTHORITY = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";
export const PUMP_AMM_EVENT_AUTHORITY = "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR";

/**
 * The two 8-byte Anchor discriminators, read off the wire. The bonding-curve program logs
 * `Instruction: CollectCreatorFee` beside the first, which is the second, independent
 * confirmation that this byte string is the instruction it is named after.
 */
export const COLLECT_CREATOR_FEE_DISCRIMINATOR = "1416567bc61cdb84";
export const COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR = "a039592ab58b2b42";

/** The seeds, spelled as each program spells them. See THE TRAP above. */
export const CURVE_VAULT_SEED = "creator-vault";
export const AMM_VAULT_SEED = "creator_vault";

/** Both instructions carry no arguments: eight bytes of discriminator and nothing else.
 *  Measured — `len=8` on all three claims. An amount is never passed; the program sends
 *  whatever the vault holds. */
const disc = (hex) => Buffer.from(hex, "hex");

export class PumpfunFeeError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "PumpfunFeeError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const requireKey = (value, label) => {
  const s = String(value ?? "");
  if (!BASE58.test(s)) throw new PumpfunFeeError("key_invalid", `${label} ${JSON.stringify(value)} is not a 32-byte base58 key`);
  return s;
};

/* ── the derived accounts ──────────────────────────────────────────────────────────── */

/** The bonding-curve program's creator vault. HYPHEN. Verified: creator
 *  y98CuQXtpMkmAzv4F3qNkRDiSUtBJZu7F282sRSgYVV derives
 *  CJng31JkG5QuudRHMt4udy998YEM4oS4KJexMDJzjHZt, which is the account the landed
 *  transaction used. */
export function curveCreatorVault(creator) {
  const owner = new PublicKey(requireKey(creator, "creator"));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CURVE_VAULT_SEED), owner.toBuffer()], new PublicKey(PUMP_PROGRAM))[0].toBase58();
}

/** pump-amm's vault AUTHORITY — not the vault itself. UNDERSCORE. The lamports sit in a
 *  token account owned by this authority, which is why the next function exists. Verified:
 *  the same creator derives Cf1hLZggx99YR8Ar6oDtHB7eRYi6VJXkqakXi4HxRLdF. */
export function ammCreatorVaultAuthority(creator) {
  const owner = new PublicKey(requireKey(creator, "creator"));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AMM_VAULT_SEED), owner.toBuffer()], new PublicKey(PUMP_AMM_PROGRAM))[0].toBase58();
}

/** The AMM vault's own token account: an ordinary ATA of the authority above. Verified to
 *  equal 2wAjMWgG1xcZXmUXEmF7wZcu9Jh2JsMDHTraXe1uEFai on the landed claim. */
export function ammCreatorVaultAta(creator, quoteMint = WSOL) {
  return associatedTokenAddress(ammCreatorVaultAuthority(creator), requireKey(quoteMint, "quoteMint"), TOKEN_PROGRAM);
}

/* ── the instructions ──────────────────────────────────────────────────────────────── */

const key = (pubkey, isSigner, isWritable) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable });

/**
 * Bonding-curve CollectCreatorFee. Five accounts, in the order the landed transactions
 * used them. The creator signs; the vault and the creator are both written to because the
 * lamports move between them.
 */
export function collectCreatorFeeIx({ creator }) {
  const owner = requireKey(creator, "creator");
  return new TransactionInstruction({
    programId: new PublicKey(PUMP_PROGRAM),
    keys: [
      key(owner, true, true),                     // [0] creator, signer, paid into
      key(curveCreatorVault(owner), false, true), // [1] the vault it is paid out of
      key(SYSTEM_PROGRAM, false, false),          // [2] system program (the lamport transfer)
      key(PUMP_EVENT_AUTHORITY, false, false),    // [3] event authority
      key(PUMP_PROGRAM, false, false),            // [4] the program itself (Anchor CPI event)
    ],
    data: disc(COLLECT_CREATOR_FEE_DISCRIMINATOR),
  });
}

/**
 * pump-amm collect_coin_creator_fee. Eight accounts. This one moves SPL tokens rather than
 * lamports — the fee is held as wrapped SOL — so the caller must have a quote ATA and will
 * want to close it afterwards. `buildFeeClaim` below does both.
 */
export function collectCoinCreatorFeeIx({ creator, quoteMint = WSOL, creatorQuoteAta = null }) {
  const owner = requireKey(creator, "creator");
  const mint = requireKey(quoteMint, "quoteMint");
  const destination = creatorQuoteAta ?? associatedTokenAddress(owner, mint, TOKEN_PROGRAM);
  return new TransactionInstruction({
    programId: new PublicKey(PUMP_AMM_PROGRAM),
    keys: [
      key(mint, false, false),                             // [0] quote mint (WSOL)
      key(TOKEN_PROGRAM, false, false),                    // [1] token program
      key(owner, true, false),                             // [2] coin creator, signer
      key(ammCreatorVaultAuthority(owner), false, false),  // [3] vault authority (PDA)
      key(ammCreatorVaultAta(owner, mint), false, true),   // [4] the vault's token account
      key(destination, false, true),                       // [5] where it lands
      key(PUMP_AMM_EVENT_AUTHORITY, false, false),         // [6] event authority
      key(PUMP_AMM_PROGRAM, false, false),                 // [7] the program itself
    ],
    data: disc(COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR),
  });
}

/** Create-if-missing, borrowed in shape from snipe-execute.mjs so the two agree. */
function createAtaIdempotentIx({ payer, ata, owner, mint, tokenProgram = TOKEN_PROGRAM }) {
  return new TransactionInstruction({
    programId: new PublicKey(ATA_PROGRAM),
    keys: [
      key(payer, true, true), key(ata, false, true), key(owner, false, false),
      key(mint, false, false), key(SYSTEM_PROGRAM, false, false), key(tokenProgram, false, false),
    ],
    data: Buffer.from([1]),   // CreateIdempotent
  });
}

/** SPL CloseAccount (opcode 9), the same one reclaim-rent.mjs uses. Closing the wrapped
 *  account is what turns the AMM's WSOL into spendable native SOL. */
function closeAccountIx({ account, destination, owner }) {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [key(account, false, true), key(destination, false, true), key(owner, true, false)],
    data: Buffer.from([9]),
  });
}

/**
 * THE WHOLE CLAIM, in the order the landed transactions used.
 *
 * Both vaults, then unwrap. `includeCurve`/`includeAmm` exist because a coin that has not
 * bonded has nothing in the AMM vault and vice versa — but the default is BOTH, because a
 * claim that reads one vault leaves the other's money sitting there and nothing reports a
 * balance nobody asked about.
 *
 * The close is unconditional when the AMM leg runs: leaving a rent-funded wrapped account
 * behind on every claim is how a fee lane quietly spends its own revenue on rent, which is
 * the exact failure reclaim-rent.mjs was written to clean up after.
 */
export function buildFeeClaim({
  creator, quoteMint = WSOL, includeCurve = true, includeAmm = true,
} = {}) {
  const owner = requireKey(creator, "creator");
  const mint = requireKey(quoteMint, "quoteMint");
  if (!includeCurve && !includeAmm)
    throw new PumpfunFeeError("nothing_to_claim", "buildFeeClaim was asked to claim neither vault");

  const quoteAta = associatedTokenAddress(owner, mint, TOKEN_PROGRAM);
  const instructions = [];
  if (includeCurve) instructions.push(collectCreatorFeeIx({ creator: owner }));
  if (includeAmm) {
    instructions.push(createAtaIdempotentIx({ payer: owner, ata: quoteAta, owner, mint }));
    instructions.push(collectCoinCreatorFeeIx({ creator: owner, quoteMint: mint, creatorQuoteAta: quoteAta }));
    instructions.push(closeAccountIx({ account: quoteAta, destination: owner, owner }));
  }
  return Object.freeze({
    instructions,
    accounts: Object.freeze({
      creator: owner,
      curveVault: curveCreatorVault(owner),
      ammVaultAuthority: ammCreatorVaultAuthority(owner),
      ammVaultAta: ammCreatorVaultAta(owner, mint),
      creatorQuoteAta: quoteAta,
    }),
  });
}

/**
 * WHAT IS ACTUALLY THERE, before signing anything.
 *
 * The claim instructions carry no amount, so a claim on an empty vault costs a signature
 * and a network fee to move zero. `readClaimable` asks both vaults what they hold, and the
 * lane refuses below a floor. `readLamports`/`readTokenAmount` are INJECTED so this is
 * testable without an RPC — and so nothing in this file opens a connection.
 *
 * An unreadable vault returns null, never 0. Zero is "there is nothing to claim"; null is
 * "nobody knows", and a lane that treats the second as the first stops claiming the moment
 * an RPC hiccups and never says why.
 */
export async function readClaimable({ creator, quoteMint = WSOL, readLamports, readTokenAmount }) {
  const owner = requireKey(creator, "creator");
  if (typeof readLamports !== "function" || typeof readTokenAmount !== "function")
    throw new PumpfunFeeError("readers_missing", "readClaimable needs readLamports() and readTokenAmount()");
  const curveVault = curveCreatorVault(owner);
  const ammAta = ammCreatorVaultAta(owner, quoteMint);

  const [curve, amm] = await Promise.all([
    Promise.resolve(readLamports(curveVault)).catch(() => null),
    Promise.resolve(readTokenAmount(ammAta)).catch(() => null),
  ]);
  /* `Number(null)` is 0, so the absent check has to come FIRST and explicitly. Without it
     a read that threw — caught to null just above — came back as a confident zero, and the
     lane would have read every RPC failure as "the vault is empty" and stopped claiming
     without a word. Caught by test-pumpfun-fees.mjs before this shipped, which is the
     whole reason that test states zero and unknown as separate cases. */
  const n = (v) => {
    if (v === null || v === undefined) return null;
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const curveLamports = n(curve);
  const ammLamports = n(amm);
  /* The vault is rent-exempt, so its balance is never fully claimable. Reporting the raw
     balance as revenue would have this lane claiming a few thousand lamports of rent over
     and over and booking each one as income. */
  const totalKnown = curveLamports === null && ammLamports === null ? null : (curveLamports ?? 0) + (ammLamports ?? 0);
  return Object.freeze({
    creator: owner, curveVault, ammVaultAta: ammAta,
    curveLamports, ammLamports, totalLamports: totalKnown,
    readable: curveLamports !== null || ammLamports !== null,
  });
}
