/**
 * CLAUDE COMPANY — REFERENCE EXECUTOR
 *
 * Legacy inbound-webhook adapter. The desk (Claude or Grok)
 * is the BRAIN: it researches and publishes calls, and never touches a wallet.
 * This script is the HANDS: it runs on YOUR machine, holds YOUR burner wallet,
 * and obeys YOUR caps. This retired design accepts signed JSON for dry-run logging;
 * it never trades. The durable outbound polling service is poller.mjs.
 *
 * SAFETY MODEL:
 *   - This legacy webhook path is DRY RUN ONLY and rejects EXECUTE=1 at startup.
 *   - Use an unfunded BURNER identity; do not fund it for auto-trading.
 *   - Per-trade and daily SOL caps are enforced here, not trusted from anyone.
 *   - The desk cannot reach this wallet: it only sends suggestions, signed, and
 *     an attacker without your floor's secret cannot forge one.
 *
 * SETUP
 *   1) On your floor's Calls tab → Desk settings → "Your executor":
 *      paste this machine's public URL (e.g. from `cloudflared tunnel` or a VPS)
 *      and copy the signing secret it shows you.
 *   2) npm install
 *   3) Run:
 *      CC_SECRET=<signing secret> \
 *      KEYPAIR=./burner.json            # solana-keygen new -o burner.json
 *      MAX_SOL_PER_TRADE=0.05 DAILY_SOL_CAP=0.5 \
 *      EXECUTE=0 node executor.mjs      # signed-event verification and logging only
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.CC_SECRET || "";
const EXPECTED_FLOOR = Number(process.env.CC_FLOOR || 0);
const EXECUTE = process.env.EXECUTE === "1";
const MAX_SOL = Number(process.env.MAX_SOL_PER_TRADE || 0.05);
const DAILY_CAP = Number(process.env.DAILY_SOL_CAP || 0.5);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 300);
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const WSOL = "So11111111111111111111111111111111111111112";

if (EXECUTE) {
  console.error("LIVE webhook execution is disabled; use the reviewed polling executor for paper mode or the explicit local canary.");
  process.exit(1);
}

if (!SECRET) { console.error("CC_SECRET is required (from your floor's executor panel)"); process.exit(1); }
const keypair = (() => {
  const p = process.env.KEYPAIR || "./burner.json";
  if (!fs.existsSync(p)) { console.error(`no keypair at ${p} — create one: solana-keygen new -o ${p}`); process.exit(1); }
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
})();
const conn = new Connection(RPC, "confirmed");

let spentToday = 0, dayStart = Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function jupiterSwap({ inputMint, outputMint, amountRaw }) {
  const base = (process.env.JUPITER_API_BASE || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
  const q = await fetch(`${base}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`).then((r) => r.json());
  if (!q?.outAmount) throw new Error("no route: " + JSON.stringify(q).slice(0, 120));
  const s = await fetch(`${base}/swap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: keypair.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  }).then((r) => r.json());
  if (!s?.swapTransaction) throw new Error("no swap tx: " + JSON.stringify(s).slice(0, 120));
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, "base64"));
  tx.sign([keypair]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  return { sig, outAmount: q.outAmount };
}

async function tokenBalanceRaw(mint) {
  const r = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new (await import("@solana/web3.js")).PublicKey(mint) });
  return r.value.reduce((a, v) => a + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
}

async function onEvent(ev) {
  if (Date.now() - dayStart > 86400e3) { spentToday = 0; dayStart = Date.now(); }
  const c = ev.call || {};
  if (ev.type === "entry") {
    const wantSol = Math.min(Number(c.size_sol || MAX_SOL), MAX_SOL);
    if (spentToday + wantSol > DAILY_CAP) return log(`SKIP entry ${c.symbol}: daily cap (${spentToday.toFixed(3)}/${DAILY_CAP} SOL spent)`);
    log(`ENTRY ${c.symbol} (${c.mint}) — desk sized ${c.size_sol} SOL, capped to ${wantSol} SOL`,
      `| stop ${c.stop} target ${c.target}`);
    if (!EXECUTE) return log("DRY RUN — live signing is intentionally disabled in this release");
    const { sig } = await jupiterSwap({ inputMint: WSOL, outputMint: c.mint,
      amountRaw: Math.round(wantSol * 1e9) });
    spentToday += wantSol;
    log(`BOUGHT ${c.symbol} — https://solscan.io/tx/${sig}`);
  }
  if (ev.type === "exit") {
    log(`EXIT ${c.symbol} (${c.code}, ${c.urgency}) — ${c.detail}`);
    if (!EXECUTE) return log("DRY RUN — live signing is intentionally disabled in this release");
    const bal = await tokenBalanceRaw(c.mint);
    if (bal <= 0n) return log(`nothing held in ${c.symbol}`);
    const { sig } = await jupiterSwap({ inputMint: c.mint, outputMint: WSOL, amountRaw: bal.toString() });
    log(`SOLD ALL ${c.symbol} — https://solscan.io/tx/${sig}`);
  }
}

http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 65536) req.destroy(); });
  req.on("end", async () => {
    const theirs = String(req.headers["x-cc-signature"] || "");
    const ours = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    if (!/^[a-f0-9]{64}$/i.test(theirs) ||
        !crypto.timingSafeEqual(Buffer.from(theirs, "hex"), Buffer.from(ours, "hex"))) {
      log("REJECTED: bad signature"); res.writeHead(401); return res.end("bad signature");
    }
    try {
      const ev = JSON.parse(body);
      const fresh = Number(ev.ts) > Date.now() - 5 * 60000 && Number(ev.ts) < Date.now() + 60000;
      if (ev.v !== 2 || !ev.event_id || !fresh || (EXPECTED_FLOOR > 0 && ev.floor !== EXPECTED_FLOOR)) {
        res.writeHead(400); return res.end("invalid or stale event");
      }
      await onEvent(ev);
      res.writeHead(200); res.end("ok");
    } catch (e) {
      log("ERROR:", e.message); res.writeHead(500); res.end("failed");
    }
  });
}).listen(PORT, () => log(`executor up on :${PORT} — wallet ${keypair.publicKey.toBase58()} — ` +
  `${EXECUTE ? "LIVE" : "DRY RUN"} — max ${MAX_SOL} SOL/trade, ${DAILY_CAP} SOL/day`));
