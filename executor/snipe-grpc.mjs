/**
 * YELLOWSTONE gRPC — the fastest notice a launch can give us, and the honest caveats.
 *
 * The owner, 2026-09-18: "I WANT THE FASTEST SNIPER BOT."
 *
 * The lane currently learns about a launch two ways: a websocket `logsSubscribe` on the
 * venue's program, and a 5-second HTTP poll of the listing as corroboration. Measured on
 * the burner's own 64 trades, the median entry was 5 seconds behind the curve's first
 * trade — which is the poll's interval to the second, and the reason snipe-shadow.mjs now
 * ships a source race: `firstShare` says which of the two is actually winning.
 *
 * This is the third source. A Yellowstone Geyser stream is pushed from the validator's own
 * plugin rather than fanned out through an RPC node's subscription machinery, and the
 * published gap is 5–20ms against 150–300ms for `logsSubscribe`. Helius's LaserStream is a
 * drop-in Yellowstone endpoint and is included in the plan the owner already pays for.
 *
 * WHAT THIS FILE KNOWS, AND HOW IT KNOWS IT
 *
 * Field numbers are not guessable and are not guessed. Every constant in FIELDS below was
 * read out of the published schema:
 *
 *   https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/geyser.proto
 *   https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/solana-storage.proto
 *
 * They are listed as a table rather than scattered through the code so that checking this
 * file against the .proto is a two-minute job rather than an audit. Two of them are worth
 * naming because memory gets them wrong: on SubscribeRequestFilterTransactions,
 * `account_include` is field 3 and `account_exclude` is 4 — NOT 4 and 5.
 *
 * WHY THE MINT PARSER IS NOT IN HERE
 *
 * A transaction update carries `meta.log_messages`: the same log lines the websocket
 * delivers, byte for byte. So this file decodes down to `{slot, signature, logs}` and stops.
 * The mint comes out of those logs by the venue adapter's own `eventsFromLogs`, which is
 * already pinned against bytes a real pump.fun transaction emitted. Reusing it means the
 * new source adds a TRANSPORT risk and no PARSING risk, and a launch found here decodes to
 * exactly the same notice the socket would have produced — which is what makes the two
 * comparable on the latency axis at all.
 *
 * THE SELF-CHECK
 *
 * A schema that drifts does not announce itself. It produces updates whose oneof branch
 * this file does not recognise, and the source then sits there looking healthy and
 * delivering nothing — the worst failure a feed has, because every other part of the
 * system reads it as a quiet market. So the transport counts: if SCHEMA_PROBE_UPDATES
 * messages arrive and not one of them decodes to a branch we know, it fails loudly with
 * `schema_mismatch`. Being wrong is survivable. Being wrong and silent is not.
 *
 * WHAT THIS FILE CANNOT PROMISE
 *
 * It has never been run against a real endpoint from inside this repository — there is no
 * Yellowstone server in CI and no credential in the tree. Every test here is a round-trip
 * or a fake transport. What that proves is that the codec and the framing are right and
 * that the wiring reports its failures; what it does NOT prove is that Helius's field
 * layout matches the published proto on the day the owner subscribes. The self-check above
 * exists precisely because that last step can only be taken on the owner's machine.
 */

import {
  GrpcWireError, GrpcStatusError, openGrpcStream,
  varintField, boolField, stringField, messageField, concat,
  decodeFields, readSafeInt, readBool, readBytes, readStrings, readMessage, firstOf,
} from "./grpc-wire.mjs";

export const SNIPE_GRPC_VERSION = "snipe-grpc-v1";

/** The bidirectional streaming method every Yellowstone endpoint exposes. */
export const GEYSER_SUBSCRIBE_PATH = "/geyser.Geyser/Subscribe";

/** CommitmentLevel, geyser.proto. PROCESSED is the only one a sniper can use: CONFIRMED is
 *  already a slot or more too late to be first into a curve. */
export const COMMITMENT = Object.freeze({ processed: 0, confirmed: 1, finalized: 2 });

/**
 * THE SCHEMA, as a table. Every number here is from the published .proto; nothing in this
 * file derives a field number from anything else.
 */
export const FIELDS = Object.freeze({
  /* geyser.SubscribeRequest */
  request: Object.freeze({ transactions: 3, commitment: 6, ping: 9, fromSlot: 11 }),
  /* proto3 map entry — every map<K,V> on the wire is a repeated message of this shape */
  mapEntry: Object.freeze({ key: 1, value: 2 }),
  /* geyser.SubscribeRequestFilterTransactions — note account_include is 3, not 4 */
  txFilter: Object.freeze({ vote: 1, failed: 2, accountInclude: 3, accountExclude: 4, signature: 5, accountRequired: 6 }),
  /* geyser.SubscribeRequestPing */
  ping: Object.freeze({ id: 1 }),
  /* geyser.SubscribeUpdate — the oneof branches share the message's field-number space */
  update: Object.freeze({
    filters: 1, account: 2, slot: 3, transaction: 4, block: 5, ping: 6,
    blockMeta: 7, entry: 8, pong: 9, transactionStatus: 10, createdAt: 11,
  }),
  /* geyser.SubscribeUpdateTransaction */
  updateTx: Object.freeze({ transaction: 1, slot: 2 }),
  /* geyser.SubscribeUpdateTransactionInfo */
  txInfo: Object.freeze({ signature: 1, isVote: 2, transaction: 3, meta: 4, index: 5 }),
  /* solana.storage.ConfirmedBlock.TransactionStatusMeta */
  meta: Object.freeze({ err: 1, fee: 2, logMessages: 6, logMessagesNone: 11 }),
  /* geyser.SubscribeUpdatePong */
  pong: Object.freeze({ id: 1 }),
  /* google.protobuf.Timestamp */
  timestamp: Object.freeze({ seconds: 1, nanos: 2 }),
});

/** Which oneof branch of SubscribeUpdate a field number names. */
const BRANCH_BY_FIELD = Object.freeze(new Map([
  [FIELDS.update.account, "account"],
  [FIELDS.update.slot, "slot"],
  [FIELDS.update.transaction, "transaction"],
  [FIELDS.update.block, "block"],
  [FIELDS.update.ping, "ping"],
  [FIELDS.update.blockMeta, "blockMeta"],
  [FIELDS.update.entry, "entry"],
  [FIELDS.update.pong, "pong"],
  [FIELDS.update.transactionStatus, "transactionStatus"],
]));

/** How many unrecognised updates in a row mean the schema moved rather than the market
 *  being quiet. Fifty is comfortably more than the handful of pings a healthy stream opens
 *  with and far fewer than a minute of pump.fun traffic. */
export const SCHEMA_PROBE_UPDATES = 50;

export class SnipeGrpcError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "SnipeGrpcError";
    this.reason = reason;
    Object.assign(this, detail);
  }
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ── the request ───────────────────────────────────────────────────────────────────── */

/** One proto3 map entry: `{key, value}` as a nested message under the map's field. */
const mapEntry = (field, key, valueParts) =>
  messageField(field, [stringField(FIELDS.mapEntry.key, key), messageField(FIELDS.mapEntry.value, valueParts)]);

/**
 * A SubscribeRequest that asks for every non-vote, non-failed transaction touching a given
 * program.
 *
 * `failed: false` is deliberate and load-bearing. A failed transaction cannot have created
 * a coin, and pump.fun's program emits a great many of them — every buy that lost a race.
 * Filtering them at the validator is the difference between a stream this machine can keep
 * up with and one it spends its CPU discarding.
 *
 * `vote: false` likewise: votes are the overwhelming majority of Solana's transaction
 * volume and none of them is ever a launch.
 */
export function encodeSubscribeRequest({
  label = "launches", accountInclude = [], commitment = "processed",
  vote = false, failed = false, fromSlot = null,
} = {}) {
  const keys = (Array.isArray(accountInclude) ? accountInclude : [accountInclude]).filter(Boolean).map(String);
  if (keys.length === 0)
    throw new SnipeGrpcError("filter_empty", "encodeSubscribeRequest needs at least one accountInclude key: an unfiltered Geyser stream is every transaction on Solana");
  for (const key of keys)
    if (!BASE58.test(key))
      throw new SnipeGrpcError("filter_invalid", `accountInclude ${JSON.stringify(key)} is not a 32-byte base58 key`);
  const level = COMMITMENT[String(commitment)];
  if (level === undefined)
    throw new SnipeGrpcError("commitment_invalid", `commitment ${JSON.stringify(commitment)} must be one of ${Object.keys(COMMITMENT).join(", ")}`);

  const filter = [
    boolField(FIELDS.txFilter.vote, vote),
    boolField(FIELDS.txFilter.failed, failed),
    ...keys.map((k) => stringField(FIELDS.txFilter.accountInclude, k)),
  ];
  const parts = [
    mapEntry(FIELDS.request.transactions, label, filter),
    varintField(FIELDS.request.commitment, level),
  ];
  if (fromSlot != null) {
    if (!Number.isSafeInteger(fromSlot) || fromSlot < 0)
      throw new SnipeGrpcError("from_slot_invalid", `fromSlot ${JSON.stringify(fromSlot)} must be a non-negative integer`);
    parts.push(varintField(FIELDS.request.fromSlot, fromSlot));
  }
  return concat(parts);
}

/** The keepalive. The server sends SubscribeUpdatePing; a client that does not answer is
 *  disconnected, and a disconnected sniper is a sniper that misses the next hour. */
export function encodePingRequest(id = 1) {
  const n = Number.isSafeInteger(id) && id >= 0 ? id : 1;
  return messageField(FIELDS.request.ping, [varintField(FIELDS.ping.id, n)]);
}

/* ── the update ────────────────────────────────────────────────────────────────────── */

const timestampMs = (fields) => {
  if (!fields) return null;
  const seconds = readSafeInt(fields, FIELDS.timestamp.seconds);
  if (seconds === null) return null;
  const nanosHit = firstOf(fields, FIELDS.timestamp.nanos);
  const nanos = nanosHit && nanosHit.wireType === 0 ? Number(nanosHit.value) : 0;
  const ms = seconds * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1e6);
  return Number.isSafeInteger(ms) ? ms : null;
};

/**
 * One SubscribeUpdate, narrowed to what a launch feed needs.
 *
 * Returns a frozen record whose `kind` is the oneof branch. `unknown` is a real outcome and
 * is what the self-check counts — it means the bytes decoded as protobuf but named a branch
 * this file has no constant for, which is what schema drift looks like from here.
 *
 * `createdAtMs` is the SERVER's clock and is never used as an arrival stamp. snipe-feed.mjs
 * is explicit about this: an arrival is stamped by the machine that received it, and a
 * remote clock lands in `originAtMs` where nothing ranks sources by it.
 */
export function decodeSubscribeUpdate(bytes) {
  const fields = decodeFields(bytes);
  const filters = readStrings(fields, FIELDS.update.filters);
  const createdAtMs = timestampMs(readMessage(fields, FIELDS.update.createdAt));

  let kind = "unknown";
  for (const [field, name] of BRANCH_BY_FIELD) {
    if (fields.has(field)) { kind = name; break; }
  }

  const base = { kind, filters: Object.freeze(filters), createdAtMs, slot: null, signature: null, isVote: false, failed: false, logs: Object.freeze([]) };

  if (kind === "transaction") {
    const tx = readMessage(fields, FIELDS.update.transaction);
    const slot = readSafeInt(tx, FIELDS.updateTx.slot);
    const info = readMessage(tx, FIELDS.updateTx.transaction);
    const meta = readMessage(info, FIELDS.txInfo.meta);
    /* `err` PRESENT means the transaction failed. The filter asks the server not to send
       these, but a filter is a request and this is the check that makes it a fact — a
       failed transaction's logs can contain a create that never happened. */
    const failed = meta ? meta.has(FIELDS.meta.err) : false;
    return Object.freeze({
      ...base, slot,
      signature: readBytes(info, FIELDS.txInfo.signature),
      isVote: readBool(info, FIELDS.txInfo.isVote) === true,
      failed,
      logs: Object.freeze(meta ? readStrings(meta, FIELDS.meta.logMessages) : []),
    });
  }
  if (kind === "slot") {
    const s = readMessage(fields, FIELDS.update.slot);
    return Object.freeze({ ...base, slot: readSafeInt(s, 1) });
  }
  if (kind === "pong") {
    const p = readMessage(fields, FIELDS.update.pong);
    return Object.freeze({ ...base, pongId: readSafeInt(p, FIELDS.pong.id) });
  }
  return Object.freeze(base);
}

/* ── the transport ─────────────────────────────────────────────────────────────────── */

/** Hex, not base58. A signature is an identifier here, and hex needs no dependency; the
 *  poller injects bs58.encode so the value on a notice is one you can paste into an
 *  explorer. Named rather than inlined so the default is visible in a log. */
export const hexSignature = (bytes) => (bytes ? Buffer.from(bytes).toString("hex") : null);

/**
 * A Yellowstone endpoint as the same tiny transport `logsSubscribeSource` already takes:
 * `{subscribe({programId, commitment, onNotice, onError}) -> {unsubscribe()}}`.
 *
 * Matching that shape is the point. The feed, the ledger, the dedupe, the health summary
 * and the source race all work on this source the day it is added, with no changes, and
 * the new endpoint is measured against the old one by machinery that already exists.
 *
 * The token goes in the `x-token` header, which is what every Yellowstone deployment reads
 * and what Helius documents for LaserStream. It is never logged, never put in a URL, and
 * never carried on an error — a credential in a stack trace ends up in the desk's journal.
 */
export function laserstreamTransport({
  endpoint, token, label = "launches", http2 = undefined, openStream = openGrpcStream,
  schemaProbeUpdates = SCHEMA_PROBE_UPDATES, encodeSignature = hexSignature,
  log = () => {},
} = {}) {
  if (!isNonEmptyString(endpoint) || !/^https:\/\//i.test(endpoint))
    throw new SnipeGrpcError("endpoint_invalid", `gRPC endpoint ${JSON.stringify(endpoint)} must be an https:// URL`);
  if (!isNonEmptyString(token))
    throw new SnipeGrpcError("token_missing", "a Yellowstone endpoint needs an x-token; refusing to open an unauthenticated stream");
  if (typeof encodeSignature !== "function")
    throw new SnipeGrpcError("encode_signature_invalid", "encodeSignature must be a function");

  return {
    endpoint,
    subscribe({ programId, commitment = "processed", onNotice, onError } = {}) {
      const request = encodeSubscribeRequest({ label, accountInclude: [programId], commitment });

      let seen = 0, recognised = 0, closed = false;
      let handle = null;

      const report = (error) => { if (!closed) onError?.(error); };

      handle = openStream({
        url: endpoint,
        path: GEYSER_SUBSCRIBE_PATH,
        headers: { "x-token": token },
        ...(http2 ? { http2 } : {}),
        onError: report,
        onMessage(message) {
          let update;
          try { update = decodeSubscribeUpdate(message); }
          catch (error) {
            /* Bytes that are not protobuf are a transport fault, not a parse miss, and the
               stream is no longer trustworthy from here: the framer's position is fine but
               the peer is sending something this client cannot read. */
            report(error instanceof GrpcWireError ? error : new SnipeGrpcError("decode_failed", error?.message ?? String(error)));
            return;
          }
          seen++;
          if (update.kind !== "unknown") recognised++;

          if (update.kind === "ping") { handle?.send?.(encodePingRequest(1)); return; }
          if (update.kind === "transaction") {
            if (update.isVote || update.failed || update.logs.length === 0) return;
            onNotice?.(
              { logs: update.logs, signature: encodeSignature(update.signature), slot: update.slot, originAtMs: update.createdAtMs },
              { slot: update.slot },
            );
            return;
          }
          /* THE SELF-CHECK. A stream that talks and says nothing this file understands is
             the silent-failure case, and it is reported once, as an error, rather than
             left to look like a quiet market. */
          if (recognised === 0 && seen >= schemaProbeUpdates) {
            report(new SnipeGrpcError("schema_mismatch",
              `${seen} updates arrived and none named a oneof branch this build knows; the endpoint's geyser.proto has moved`,
              { seen }));
          }
        },
      });

      /* The request is written AFTER the handlers are attached. Writing first is the classic
         way to lose the first update on a fast endpoint — and on this endpoint the first
         update is the one worth the money. */
      handle.send(request);
      log(`grpc: subscribed to ${programId} at ${commitment} via ${new URL(endpoint).host}`);

      return { unsubscribe() { closed = true; handle?.close?.(); } };
    },
  };
}

/** Whether the operator has configured a gRPC source at all. Both halves or neither: an
 *  endpoint without a token opens nothing, and a token without an endpoint is a secret
 *  sitting in an env file for no reason. */
export function grpcFromEnv(env = process.env) {
  const endpoint = String(env.SNIPE_GRPC_URL ?? "").replace(/^"|"$/g, "").trim();
  const token = String(env.SNIPE_GRPC_TOKEN ?? "").replace(/^"|"$/g, "").trim();
  if (!endpoint && !token) return null;
  if (!endpoint || !token)
    throw new SnipeGrpcError("env_incomplete",
      `SNIPE_GRPC_URL and SNIPE_GRPC_TOKEN must be set together (${endpoint ? "token" : "url"} is missing)`);
  if (!/^https:\/\//i.test(endpoint))
    throw new SnipeGrpcError("endpoint_invalid", `SNIPE_GRPC_URL must be an https:// URL; got ${JSON.stringify(endpoint.slice(0, 12))}…`);
  const commitment = String(env.SNIPE_GRPC_COMMITMENT ?? "processed").replace(/^"|"$/g, "").trim() || "processed";
  if (COMMITMENT[commitment] === undefined)
    throw new SnipeGrpcError("commitment_invalid", `SNIPE_GRPC_COMMITMENT must be one of ${Object.keys(COMMITMENT).join(", ")}`);
  return { endpoint, token, commitment };
}

export { GrpcStatusError };
