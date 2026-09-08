// Audited Token-2022 mint acceptance for WALL-ST-E.
//
// Pump.fun mints are Token-2022 (MetadataPointer + TokenMetadata, no authorities), so
// a classic-only executor refuses nearly every call the desk publishes. Instead of a
// blanket refusal, the mint's extension TLV is parsed by hand (the executor carries no
// @solana/spl-token) and the mint is accepted only when no extension can tax, block,
// redirect, freeze, pause or re-denominate a transfer. Anything unknown fails closed.
//
// Layout facts this file depends on (spl-token-2022 `extension/mod.rs`):
//   base mint = 82 bytes for both programs: [0..4) mint-authority COption tag,
//   [4..36) key, [36..44) supply, 44 decimals, 45 is_initialized,
//   [46..50) freeze-authority COption tag, [50..82) key.
//   A Token-2022 mint with extensions is padded with zeros to 165 bytes, byte 165 is
//   the account type (1 = Mint, 2 = Account) and TLV entries start at 166:
//   u16 LE type, u16 LE length, then `length` bytes of value.
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const BASE_MINT_LENGTH = 82;
export const ACCOUNT_TYPE_OFFSET = 165;
export const TLV_START = 166;
export const ACCOUNT_TYPE_MINT = 1;

/** ExtensionType discriminants, in enum order. The enum is dense: no gaps. */
export const EXTENSION_NAMES = Object.freeze({
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
  25: "ScaledUiAmount",
  26: "Pausable",
  27: "PausableAccount",
});

/**
 * Mint extensions a trade can tolerate. Each one is descriptive only: it cannot take a
 * cut of a transfer (TransferFeeConfig), call out to third-party code on transfer
 * (TransferHook), move tokens without the owner (PermanentDelegate), block transfers
 * (NonTransferable, Pausable), open new accounts frozen (DefaultAccountState is allowed
 * only when the default state is Initialized, checked separately), hide balances
 * (Confidential*), or change what one raw unit means (InterestBearingConfig,
 * ScaledUiAmount: the desk's marks are per UI unit, so a re-denominating mint would
 * silently move the stop and target).
 */
export const ALLOWED_MINT_EXTENSIONS = Object.freeze(new Set([
  3,  // MintCloseAuthority: a mint can only be closed at zero supply; holders are unaffected
  6,  // DefaultAccountState: accepted only when the default is Initialized (see below)
  18, // MetadataPointer
  19, // TokenMetadata
  20, // GroupPointer
  21, // TokenGroup
  22, // GroupMemberPointer
  23, // TokenGroupMember
]));

/* Two RPC providers must describe the SAME mint, but hashing the whole account makes
 * honest providers disagree: `supply` (bytes 36..44) moves on every mint or burn, which
 * on a live bonding curve is every few seconds, and TokenMetadata's bytes and length
 * change whenever an update authority edits a name or URI. Hash exactly the bytes whose
 * value could change a decision made here: the base mint with `supply` masked out, then
 * every extension's type, plus each one's length and value except for the metadata
 * payload. A byte flip anywhere else — a pointer, a group, a default-state — still
 * shows up as a mismatch. */
const MUTABLE_VALUE_EXTENSIONS = new Set([19]); // TokenMetadata
const SUPPLY_OFFSET = 36;
const SUPPLY_END = 44;

function safetyDigest(data, extensions) {
  const base = Buffer.from(data.subarray(0, BASE_MINT_LENGTH));
  base.fill(0, SUPPLY_OFFSET, SUPPLY_END);
  const hash = createHash("sha256").update(base);
  const header = Buffer.alloc(4);
  for (const ext of extensions) {
    header.writeUInt16LE(ext.type, 0);
    if (MUTABLE_VALUE_EXTENSIONS.has(ext.type)) { hash.update(header.subarray(0, 2)); continue; }
    header.writeUInt16LE(ext.length, 2);
    hash.update(header);
    hash.update(ext.value);
  }
  return hash.digest("hex");
}

/* The rollback switch. It gates NEW Token-2022 ENTRIES only, at the entry path in the
 * poller — never a balance read, a custody check or an exit. Refusing to parse a mint
 * the wallet already holds would strand that position: the balance could not be
 * verified, the stop could not fire, and the block would gate every other entry too. */
export function token2022Enabled(env = process.env) {
  return String(env.CC_TOKEN_2022 ?? "1").trim() !== "0";
}

function accountBytes(account) {
  if (!account) return null;
  if (Buffer.isBuffer(account.data) || account.data instanceof Uint8Array) return Buffer.from(account.data);
  if (Array.isArray(account.data) && account.data[1] === "base64") return Buffer.from(account.data[0], "base64");
  throw new Error("RPC returned an unsupported account encoding");
}

function ownerOf(account) {
  return account?.owner?.toBase58?.() || String(account?.owner || "");
}

function optionKey(data, offset, label) {
  const tag = data.readUInt32LE(offset);
  if (tag === 0) return null;
  if (tag !== 1) throw new Error(`mint has an invalid ${label} option tag ${tag}`);
  return new PublicKey(data.subarray(offset + 4, offset + 36)).toBase58();
}

/**
 * Walk the TLV region of a Token-2022 mint. Returns [{ type, name, length, value }].
 * Fails closed on every malformed shape: short padding, wrong account type, a value
 * that runs past the end, a header that does not fit, duplicate entries, non-zero
 * bytes after the Uninitialized terminator, or a type this file does not know.
 */
export function parseMintExtensions(data) {
  if (data.length === BASE_MINT_LENGTH) return [];
  if (data.length < TLV_START)
    throw new Error(`Token-2022 mint has an invalid extension layout (${data.length} bytes)`);
  for (let i = BASE_MINT_LENGTH; i < ACCOUNT_TYPE_OFFSET; i++)
    if (data[i] !== 0) throw new Error("Token-2022 mint padding is not zero");
  if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT)
    throw new Error(`Token-2022 account type ${data[ACCOUNT_TYPE_OFFSET]} is not a mint`);
  const out = [];
  const seen = new Set();
  let offset = TLV_START;
  while (offset < data.length) {
    if (offset + 4 > data.length) {
      // spl-token-2022 tolerates a trailing fragment shorter than a header; accept it
      // only when it is zero-filled so nothing hides in it.
      for (let i = offset; i < data.length; i++)
        if (data[i] !== 0) throw new Error("Token-2022 mint has trailing bytes after the extension list");
      break;
    }
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (type === 0) {
      for (let i = offset + 2; i < data.length; i++)
        if (data[i] !== 0) throw new Error("Token-2022 mint has bytes after the extension terminator");
      break;
    }
    const name = EXTENSION_NAMES[type];
    if (!name) throw new Error(`Token-2022 mint carries unknown extension type ${type}`);
    if (seen.has(type)) throw new Error(`Token-2022 mint repeats extension ${name}`);
    seen.add(type);
    const valueStart = offset + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > data.length) throw new Error(`Token-2022 extension ${name} overruns the account`);
    out.push({ type, name, length, value: data.subarray(valueStart, valueEnd) });
    offset = valueEnd;
  }
  return out;
}

/** Throw when any mint extension could interfere with buying and later selling. */
export function assertTradeableExtensions(extensions, mint) {
  for (const ext of extensions) {
    if (!ALLOWED_MINT_EXTENSIONS.has(ext.type))
      throw new Error(`mint ${mint} Token-2022 extension ${ext.name} is refused`);
    if (ext.type === 6) {
      // DefaultAccountState: 0 uninitialized, 1 initialized, 2 frozen.
      const state = ext.value[0];
      if (ext.length !== 1 || state !== 1)
        throw new Error(`mint ${mint} opens new token accounts frozen (default state ${state})`);
    }
  }
}

/**
 * Inspect one RPC view of a mint account. Works for classic SPL Token and Token-2022.
 * Returns comparable metadata so two independent RPC views can be required to agree
 * field-by-field and byte-for-byte (`dataHash`) before an entry is priced.
 */
export function auditMintAccount(account, mint, { allowToken2022 = true } = {}) {
  if (!account) throw new Error(`mint account is unavailable: ${mint}`);
  const owner = ownerOf(account);
  const data = accountBytes(account);
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM)
    throw new Error(`mint ${mint} is not owned by classic SPL Token`);
  if (!data || data.length < BASE_MINT_LENGTH)
    throw new Error(`mint ${mint} does not have the classic SPL mint layout`);
  let extensions = [];
  if (owner === TOKEN_PROGRAM) {
    if (data.length !== BASE_MINT_LENGTH)
      throw new Error(`mint ${mint} does not have the classic SPL mint layout`);
  } else {
    if (!allowToken2022)
      throw new Error(`mint ${mint} uses Token-2022 and this caller accepts classic SPL Token only`);
    try { extensions = parseMintExtensions(data); }
    catch (error) { throw new Error(`mint ${mint}: ${error.message}`); }
    assertTradeableExtensions(extensions, mint);
  }
  if (data[45] !== 1) throw new Error(`mint ${mint} is not initialized`);
  const decimals = Number(data[44]);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error(`mint ${mint} decimal count ${decimals} is outside the live canary range`);
  const mintAuthority = optionKey(data, 0, "mint authority");
  const freezeAuthority = optionKey(data, 46, "freeze authority");
  if (owner === TOKEN_2022_PROGRAM && freezeAuthority)
    throw new Error(`mint ${mint} Token-2022 freeze authority ${freezeAuthority} could brick the exit`);
  return {
    owner,
    program: owner,
    dataLength: data.length,
    initialized: data[45],
    decimals,
    mintAuthority,
    freezeAuthority,
    extensions: extensions.map((ext) => ext.type).join(","),
    extensionNames: extensions.map((ext) => ext.name),
    dataHash: safetyDigest(data, extensions),
  };
}

/** Fields two RPC views must agree on. `dataHash` last so the first mismatch is legible. */
export const MINT_CONSENSUS_FIELDS = Object.freeze([
  "owner", "dataLength", "initialized", "decimals", "mintAuthority", "freezeAuthority",
  "extensions", "dataHash",
]);
