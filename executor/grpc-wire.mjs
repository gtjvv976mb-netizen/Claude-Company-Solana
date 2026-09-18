/**
 * gRPC ON NODE BUILTINS — protobuf wire format and length-prefixed framing, no dependencies.
 *
 * The owner bought a Helius Business plan for LaserStream, which is a Yellowstone gRPC
 * endpoint. The obvious way to speak to one is `@grpc/grpc-js` plus `@grpc/proto-loader`,
 * which is roughly fifty transitive packages. This repo's deploy runs `npm ci && npm test`
 * as the build command for the live API, so every package added here is a package that can
 * break a production deploy at 3am for reasons that have nothing to do with trading.
 *
 * So this file implements the two things a client actually needs, both of which are
 * SPECIFICATIONS rather than schemas, and therefore cannot be guessed wrong:
 *
 *   · THE PROTOBUF WIRE FORMAT. Tag = (field << 3) | wireType, then a varint, a 64-bit
 *     block, a length-delimited block, or a 32-bit block. That is the whole encoding.
 *     Nothing here knows what a field MEANS — `decodeFields` hands back a map of field
 *     number to raw values, and the meaning is applied one layer up, in snipe-grpc.mjs,
 *     against field numbers copied from the published .proto.
 *   · gRPC FRAMING OVER HTTP/2. Each message on the wire is one byte of compression flag,
 *     four bytes of big-endian length, then that many bytes. Status arrives in the HTTP/2
 *     trailers as `grpc-status` and `grpc-message`.
 *
 * Both halves are exercised offline. The wire codec is proven by round-trip — encode,
 * decode, compare — which is the only test that can prove a codec without a server. The
 * framing is proven by feeding it chunk boundaries chosen to be hostile: a length prefix
 * split across two TCP reads, three messages in one read, a message arriving one byte at a
 * time. Those are the cases that break hand-rolled framers, and they are the cases a real
 * socket produces under load, which is exactly when a sniper cannot afford to be wrong.
 *
 * WHAT THIS FILE REFUSES TO DO:
 *
 *   · It does not compress. `grpc-encoding: identity` is sent and a frame that arrives
 *     with the compressed flag set is an ERROR, not something to skip. A compressed frame
 *     silently dropped is a launch silently missed.
 *   · It does not grow without bound. A length prefix is checked against a ceiling before
 *     a single byte is buffered, because the length is attacker-supplied in the general
 *     case and "allocate what the peer says" is how a process dies.
 *   · It does not open a socket at import. `openGrpcStream` is the only function that can,
 *     and it is called by exactly one caller, which is the feed's start().
 */

import http2Builtin from "node:http2";

/* ── errors ────────────────────────────────────────────────────────────────────────── */

export class GrpcWireError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "GrpcWireError";
    Object.assign(this, detail);
  }
}

/** A non-OK gRPC status, carried with the numeric code so a caller can branch on it. */
export class GrpcStatusError extends Error {
  constructor(code, message, detail = {}) {
    super(`gRPC ${GRPC_STATUS[code] ?? code}: ${message || "(no message)"}`);
    this.name = "GrpcStatusError";
    this.code = code;
    this.status = GRPC_STATUS[code] ?? String(code);
    Object.assign(this, detail);
  }
}

/** https://grpc.github.io/grpc/core/md_doc_statuscodes.html */
export const GRPC_STATUS = Object.freeze({
  0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT", 4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND", 6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION", 10: "ABORTED", 11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED",
  13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED",
});

/* ── protobuf wire format ──────────────────────────────────────────────────────────── */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

/** The largest field number protobuf allows, and the largest this codec will emit. */
export const MAX_FIELD_NUMBER = 536_870_911; // 2^29 - 1

/**
 * A varint, base-128 little-endian with the high bit as the continuation flag.
 *
 * BigInt throughout rather than Number. A u64 field — `slot`, `lamports` — exceeds
 * Number.MAX_SAFE_INTEGER, and a codec that silently loses the low bits of a slot number
 * is a codec that reports the wrong slot when it matters most.
 */
export function encodeVarint(value) {
  let v = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
  if (v < 0n) throw new GrpcWireError(`varint ${value} is negative; signed fields must be zigzagged by the caller`);
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

/**
 * Reads one varint. Returns the value as a BigInt and the offset past it.
 *
 * Bounded at ten bytes, which is the maximum a u64 can occupy. Without that bound a buffer
 * of 0xff bytes spins until the buffer ends, and a malformed frame becomes a hang rather
 * than an error — the difference between a feed that reports itself dead and one that
 * simply stops delivering launches.
 */
export function readVarint(buf, offset = 0) {
  let value = 0n, shift = 0n, i = offset;
  for (let read = 0; read < 10; read++) {
    if (i >= buf.length) throw new GrpcWireError(`varint at offset ${offset} runs past the end of a ${buf.length}-byte buffer`);
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: i };
    shift += 7n;
  }
  throw new GrpcWireError(`varint at offset ${offset} is longer than the 10 bytes a u64 can occupy`);
}

export function encodeTag(field, wireType) {
  if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD_NUMBER)
    throw new GrpcWireError(`field number ${field} is outside 1..${MAX_FIELD_NUMBER}`);
  if (![WIRE_VARINT, WIRE_FIXED64, WIRE_BYTES, WIRE_FIXED32].includes(wireType))
    throw new GrpcWireError(`wire type ${wireType} is not one this codec emits`);
  return encodeVarint((BigInt(field) << 3n) | BigInt(wireType));
}

export const varintField = (field, value) => Buffer.concat([encodeTag(field, WIRE_VARINT), encodeVarint(value)]);

/** proto3 bools are varints. `false` is still EMITTED here, because every bool this client
 *  sends sits on an `optional` field where presence is the point: `vote: false` means "and
 *  I do not want votes", while an absent field means "server's choice". */
export const boolField = (field, value) => varintField(field, value ? 1 : 0);

export function bytesField(field, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  return Buffer.concat([encodeTag(field, WIRE_BYTES), encodeVarint(body.length), body]);
}

export const stringField = (field, value) => bytesField(field, Buffer.from(String(value ?? ""), "utf8"));

/** A nested message: the same length-delimited shape, over the concatenation of its parts. */
export const messageField = (field, parts) => bytesField(field, concat(parts));

export const concat = (parts) => Buffer.concat((Array.isArray(parts) ? parts : [parts]).filter(Boolean));

/**
 * Every field in a message, as a Map of field number to an array of occurrences.
 *
 * ALWAYS AN ARRAY, even for a scalar. proto3 says a repeated field may arrive as several
 * occurrences of the same tag, and the difference between `repeated string account_keys`
 * and `string blockhash` is schema knowledge this layer does not have and must not pretend
 * to. The layer above picks `[0]` when it knows the field is singular.
 *
 * An unknown wire type is fatal rather than skipped. Protobuf's forward-compatibility rule
 * is that unknown FIELDS are skippable; an unknown WIRE TYPE means the bytes are not a
 * protobuf message at all, and continuing past it means decoding noise into a structure
 * that looks plausible.
 */
export function decodeFields(buf, { maxDepthBytes = 0 } = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const out = new Map();
  let i = 0;
  while (i < bytes.length) {
    const tag = readVarint(bytes, i);
    i = tag.offset;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);
    if (field < 1) throw new GrpcWireError(`field number ${field} is not valid at offset ${i}`);
    let value;
    if (wireType === WIRE_VARINT) {
      const v = readVarint(bytes, i); value = v.value; i = v.offset;
    } else if (wireType === WIRE_BYTES) {
      const len = readVarint(bytes, i); i = len.offset;
      const n = Number(len.value);
      if (!Number.isSafeInteger(n) || n < 0) throw new GrpcWireError(`length-delimited field ${field} declares ${len.value} bytes`);
      if (i + n > bytes.length) throw new GrpcWireError(`field ${field} declares ${n} bytes but only ${bytes.length - i} remain`);
      if (maxDepthBytes > 0 && n > maxDepthBytes) throw new GrpcWireError(`field ${field} declares ${n} bytes, over the ${maxDepthBytes}-byte ceiling`);
      value = bytes.subarray(i, i + n); i += n;
    } else if (wireType === WIRE_FIXED64) {
      if (i + 8 > bytes.length) throw new GrpcWireError(`fixed64 field ${field} runs past the end`);
      value = bytes.subarray(i, i + 8); i += 8;
    } else if (wireType === WIRE_FIXED32) {
      if (i + 4 > bytes.length) throw new GrpcWireError(`fixed32 field ${field} runs past the end`);
      value = bytes.subarray(i, i + 4); i += 4;
    } else {
      throw new GrpcWireError(`wire type ${wireType} on field ${field} is not protobuf; these bytes are not a message`);
    }
    const list = out.get(field);
    if (list) list.push({ wireType, value });
    else out.set(field, [{ wireType, value }]);
  }
  return out;
}

/* Readers the schema layer uses once it knows what a field means. Each returns null rather
   than throwing on absence, because an absent optional field is the normal case and a
   decoder that throws on it cannot read a real message. */

export const firstOf = (fields, field) => fields?.get?.(field)?.[0] ?? null;

export function readU64(fields, field) {
  const hit = firstOf(fields, field);
  if (!hit || hit.wireType !== WIRE_VARINT) return null;
  return hit.value;
}

/** A u64 as a JS number, and null — never a rounded number — when it will not fit. A slot
 *  silently rounded is worse than a slot absent: absent is visible, rounded is not. */
export function readSafeInt(fields, field) {
  const v = readU64(fields, field);
  if (v === null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

export function readBool(fields, field) {
  const v = readU64(fields, field);
  return v === null ? null : v !== 0n;
}

export function readBytes(fields, field) {
  const hit = firstOf(fields, field);
  if (!hit || hit.wireType !== WIRE_BYTES) return null;
  return hit.value;
}

export function readString(fields, field) {
  const b = readBytes(fields, field);
  return b === null ? null : b.toString("utf8");
}

export function readStrings(fields, field) {
  const hits = fields?.get?.(field);
  if (!Array.isArray(hits)) return [];
  return hits.filter((h) => h.wireType === WIRE_BYTES).map((h) => h.value.toString("utf8"));
}

export function readMessage(fields, field, opts) {
  const b = readBytes(fields, field);
  return b === null ? null : decodeFields(b, opts);
}

/* ── gRPC framing ──────────────────────────────────────────────────────────────────── */

export const GRPC_FRAME_HEADER_BYTES = 5;
/** Large enough for any transaction update; small enough that a bad length prefix cannot
 *  make this process the reason the machine swaps. */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** One message as it goes on the wire: uncompressed flag, big-endian length, body. */
export function frame(message) {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(message ?? []);
  const header = Buffer.alloc(GRPC_FRAME_HEADER_BYTES);
  header[0] = 0;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * A stream of TCP chunks into whole gRPC messages.
 *
 * The contract a hand-rolled framer usually gets wrong is that a chunk is not a message.
 * Five bytes of header can arrive split across two reads; three messages can arrive in
 * one. This keeps a pending list and only ever emits complete bodies.
 *
 * A frame flagged compressed is an ERROR. The client advertises `identity` and a server
 * that compresses anyway has produced bytes this codec cannot read — reporting that is the
 * difference between a loud failure and a feed that quietly delivers fewer launches than
 * the market had.
 */
export function createFrameReader({ maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? []);
      pending = pending.length === 0 ? next : Buffer.concat([pending, next]);
      const messages = [];
      for (;;) {
        if (pending.length < GRPC_FRAME_HEADER_BYTES) break;
        const compressed = pending[0];
        const length = pending.readUInt32BE(1);
        if (compressed !== 0)
          throw new GrpcWireError(`server sent a compressed frame (flag ${compressed}) though this client advertises identity only`);
        if (length > maxMessageBytes)
          throw new GrpcWireError(`frame declares ${length} bytes, over the ${maxMessageBytes}-byte ceiling`, { length });
        if (pending.length < GRPC_FRAME_HEADER_BYTES + length) break;
        messages.push(pending.subarray(GRPC_FRAME_HEADER_BYTES, GRPC_FRAME_HEADER_BYTES + length));
        pending = pending.subarray(GRPC_FRAME_HEADER_BYTES + length);
      }
      return messages;
    },
    /** How many bytes are held mid-frame — a number worth logging when a stream stalls. */
    pendingBytes: () => pending.length,
  };
}

/* ── the HTTP/2 stream ─────────────────────────────────────────────────────────────── */

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/**
 * One bidirectional gRPC call over HTTP/2.
 *
 * `http2` is injected so the whole transport is drivable from a test with no socket and no
 * server: the fake needs `connect()` returning something with `request()`, and `request()`
 * returning a duplex-ish emitter. Everything this function does to a real stream, it does
 * to the fake, so the test proves the sequencing — headers, then frames, then trailers —
 * rather than proving a mock.
 *
 * Errors arrive by exactly one route, `onError`, and exactly once. A transport that can
 * report the same failure twice makes the feed's restart logic count two deaths for one
 * socket, and the health summary then reads a source as flapping when it dropped once.
 */
export function openGrpcStream({
  url, path, headers = {}, http2 = http2Builtin,
  onMessage, onError, onEnd,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  connectTimeoutMs = 10_000,
} = {}) {
  if (typeof url !== "string" || !/^https:\/\/[^\s/]+/i.test(url))
    throw new GrpcWireError(`gRPC endpoint ${JSON.stringify(url)} must be an https:// URL`);
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new GrpcWireError(`gRPC path ${JSON.stringify(path)} must start with /`);
  if (!isPlainObject(http2) || typeof http2.connect !== "function")
    throw new GrpcWireError("openGrpcStream needs an http2 module with connect()");
  if (typeof onMessage !== "function") throw new GrpcWireError("openGrpcStream needs onMessage()");

  const reader = createFrameReader({ maxMessageBytes });
  let closed = false, reported = false, session = null, stream = null, timer = null;

  const fail = (error) => {
    if (reported || closed) return;
    reported = true;
    try { onError?.(error); } catch { /* a throwing handler must not take the socket with it */ }
    close();
  };

  function close() {
    if (closed) return;
    closed = true;
    if (timer != null) { clearTimeout(timer); timer = null; }
    try { stream?.close?.(); } catch { /* already gone */ }
    try { session?.close?.(); } catch { /* already gone */ }
  }

  try {
    session = http2.connect(url);
    session.on?.("error", (error) => fail(error));
    /* A connect that never completes is the failure mode that looks like a quiet market.
       The feed's own silence timer would eventually notice, minutes later; this notices in
       seconds and names the real reason. */
    timer = setTimeout(() => fail(new GrpcWireError(`gRPC connect to ${url} did not produce headers within ${connectTimeoutMs}ms`)), connectTimeoutMs);
    timer?.unref?.();

    stream = session.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc+proto",
      "grpc-encoding": "identity",
      "grpc-accept-encoding": "identity",
      te: "trailers",
      ...headers,
    });

    stream.on?.("response", (responseHeaders) => {
      if (timer != null) { clearTimeout(timer); timer = null; }
      const httpStatus = Number(responseHeaders?.[":status"]);
      /* A gRPC error can arrive as a "trailers-only" response: HTTP 200 with grpc-status in
         the HEADERS. Reading status from only the trailers misses every auth failure,
         which is the single most likely thing to go wrong with a new token. */
      const inlineStatus = responseHeaders?.["grpc-status"];
      if (Number.isFinite(httpStatus) && httpStatus !== 200)
        fail(new GrpcWireError(`gRPC endpoint answered HTTP ${httpStatus}`, { httpStatus }));
      else if (inlineStatus != null && Number(inlineStatus) !== 0)
        fail(new GrpcStatusError(Number(inlineStatus), String(responseHeaders["grpc-message"] ?? "")));
    });

    stream.on?.("data", (chunk) => {
      if (closed) return;
      let messages;
      try { messages = reader.push(chunk); }
      catch (error) { fail(error); return; }
      for (const message of messages) {
        try { onMessage(message); }
        catch (error) { fail(error); return; }
      }
    });

    stream.on?.("trailers", (trailers) => {
      const code = Number(trailers?.["grpc-status"] ?? 0);
      if (code !== 0) fail(new GrpcStatusError(code, String(trailers?.["grpc-message"] ?? "")));
    });

    stream.on?.("error", (error) => fail(error));
    stream.on?.("end", () => {
      /* A stream that ENDS on a subscription is a dead source, not a quiet one — the same
         distinction sourceFromVenueWatch draws. Reported so health says dead at once
         instead of waiting out a silence threshold. */
      if (closed || reported) return;
      try { onEnd?.(); } catch { /* handler's problem, not the socket's */ }
      fail(new GrpcWireError("gRPC stream ended; a subscription that ends is a dead source"));
    });
  } catch (error) {
    close();
    throw error;
  }

  return {
    /** One message, framed. Returns false when the stream is already gone, so a keepalive
     *  on a dead socket is a no-op rather than a throw from inside a data handler. */
    send(message) {
      if (closed) return false;
      try { stream.write(frame(message)); return true; }
      catch (error) { fail(error); return false; }
    },
    close,
    get closed() { return closed; },
    pendingBytes: () => reader.pendingBytes(),
  };
}
