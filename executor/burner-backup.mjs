#!/usr/bin/env node
/**
 * THE BURNER EXISTS ON EXACTLY ONE DISK.
 *
 * The install flow generates burner.json locally, prints its public key, and tells
 * the operator to send SOL to it. Nothing in this repo has ever offered a way to
 * copy that key somewhere else or to check that a copy still works. A dead host, a
 * reimaged VPS or a mistyped `rm` has therefore always meant the funds in it are
 * gone — and every improvement to install ergonomics multiplies the number of hosts
 * this is true of.
 *
 * This tool is local and offline. It opens no socket, and it is deliberately the
 * only file in the executor that imports nothing capable of one.
 *
 *   node burner-backup.mjs                     public key and status only. Safe.
 *   node burner-backup.mjs --out <file>        write a 0600 recovery file.
 *   node burner-backup.mjs --verify <file>     prove a recovery file still restores
 *                                              the same wallet. Do this BEFORE you
 *                                              need it; an unverified backup is a
 *                                              guess.
 *   node burner-backup.mjs --show --i-understand
 *                                              print the secret to this terminal.
 *
 * The recovery file holds the key in base58, which is the form Phantom, Solflare and
 * Backpack accept under "import private key" — so recovery needs no part of this
 * software, which is the point of a recovery path.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const die = (msg) => { console.error(`burner-backup: ${msg}`); process.exit(1); };

/* Under systemd, stdout is the journal. A journal is a log with a retention policy,
   a permission model and a shipping pipeline, and none of those are places for a
   private key. systemd sets JOURNAL_STREAM on every unit it starts. */
if (process.env.JOURNAL_STREAM && (flag("--show") || flag("--out")))
  die("refusing to emit key material from a systemd unit — its output is the journal. Run this from a shell.");

const KEYPAIR_FILE = path.resolve(process.env.KEYPAIR || value("--keypair") || "./burner.json");

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

/* Accepts either form a wallet or this tool can produce, so a recovery file written
   by hand from a wallet export verifies too. */
export function keypairFromBackupText(text) {
  const line = String(text).split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) throw new Error("no key found in the recovery file");
  if (line.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(line)));
  const raw = bs58.decode(line);
  if (raw.length !== 64) throw new Error(`expected a 64-byte secret key, got ${raw.length}`);
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const kp = loadKeypair();
const pubkey = kp.publicKey.toBase58();

if (flag("--verify")) {
  const file = value("--verify");
  if (!file) die("--verify needs a path");
  let restored;
  try { restored = keypairFromBackupText(fs.readFileSync(path.resolve(file), "utf8")); }
  catch (e) { die(`that recovery file does not restore a wallet: ${e.message}`); }
  const got = restored.publicKey.toBase58();
  if (got !== pubkey) die(`that recovery file restores ${got}, which is NOT this bot's wallet ${pubkey}`);
  console.log(`verified — ${path.resolve(file)} restores ${pubkey}`);
  process.exit(0);
}

if (flag("--out")) {
  const file = value("--out");
  if (!file) die("--out needs a path");
  const out = path.resolve(file);
  if (fs.existsSync(out)) die(`${out} already exists — refusing to overwrite a recovery file`);
  const body = [
    `# WALL-ST-E burner recovery key`,
    `# wallet ${pubkey}`,
    `# written ${new Date().toISOString()} on ${os.hostname()}`,
    `#`,
    `# ANYONE WITH THE LINE BELOW CONTROLS THIS WALLET AND EVERYTHING IN IT.`,
    `# It is base58, the form Phantom, Solflare and Backpack accept under`,
    `# "import private key" — you do not need this software to recover the funds.`,
    `# Keep it off any machine that runs the bot, and out of any backup that syncs.`,
    ``,
    bs58.encode(Buffer.from(kp.secretKey)),
    ``,
  ].join("\n");
  const fd = fs.openSync(out, "wx", 0o600);
  try { fs.writeFileSync(fd, body); } finally { fs.closeSync(fd); }
  fs.chmodSync(out, 0o600);
  console.log(`wrote ${out} (0600) for wallet ${pubkey}`);
  console.log(`now prove it: node burner-backup.mjs --verify ${out}`);
  process.exit(0);
}

if (flag("--show")) {
  if (!flag("--i-understand"))
    die("--show prints a private key to this terminal. Add --i-understand if that is what you want.");
  console.log(bs58.encode(Buffer.from(kp.secretKey)));
  process.exit(0);
}

const st = fs.lstatSync(KEYPAIR_FILE);
console.log(`wallet   ${pubkey}`);
console.log(`keyfile  ${KEYPAIR_FILE} (mode ${(st.mode & 0o777).toString(8)})`);
console.log(`\nThis key exists on this disk and nowhere else. To change that:`);
console.log(`  node burner-backup.mjs --out ~/wall-st-e-recovery.txt`);
console.log(`  node burner-backup.mjs --verify ~/wall-st-e-recovery.txt`);
console.log(`then move that file somewhere this machine cannot reach.`);
