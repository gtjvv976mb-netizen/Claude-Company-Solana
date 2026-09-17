/**
 * ── THE COIN'S OWN METADATA, AND WHETHER ANYONE PUT A NAME TO IT ──────────────────────
 *
 * Owner, 2026-09-17, after four losing round trips in twenty minutes: "make the bot only
 * trade tokens that has a social attached to when its created."
 *
 * A pump.fun `create` carries a `uri` — an off-chain JSON document with the coin's name,
 * image and, when the deployer bothered, a `twitter`, `telegram` or `website`. A launch
 * with none of those is a deployer who did not spend thirty seconds attaching an identity
 * to the thing. That is not proof of anything, and this module does not pretend it is:
 * a link is trivially faked, points at an account that may be three minutes old, and is
 * checked here for EXISTENCE and never for reputation. What it filters is the floor of
 * effort, which on a launch feed is most of the volume.
 *
 * ── WHAT THIS MODULE REFUSES TO DO ────────────────────────────────────────────────────
 *
 * It does not follow the link, score it, or ask any third party about it. Fetching the
 * metadata is already one request to a host the coin's deployer chose; fetching what the
 * metadata points AT would be a second request to a host the deployer chose, on the
 * sniper's hot path, and a bot that can be made to issue arbitrary outbound requests by
 * anyone who can launch a coin for a fraction of a SOL is a bot with a hole in it.
 *
 * ── THE HAZARDS, EACH HANDLED RATHER THAN NOTED ───────────────────────────────────────
 *
 * The URI is ATTACKER-CONTROLLED. Anybody can launch a coin, so anybody can choose what
 * this bot is asked to fetch, and it will be asked from a machine holding a funded key.
 * So:
 *
 *   · ONLY http AND https. `file://` reads the operator's disk, `ftp://` and the rest are
 *     not fetches this needs to make, and a `data:` URI is a way to smuggle a body past
 *     every limit below.
 *   · A DEADLINE, ALWAYS. A launch is decided in seconds. A host that accepts the socket
 *     and then dribbles a byte a minute would otherwise hold a slot open forever, and
 *     "forever" on this path means the lane stops taking launches at all.
 *   · A SIZE CAP, ENFORCED WHILE READING rather than after. Content-Length is a claim by
 *     the same party that chose the URL. The body is read in chunks and abandoned the
 *     moment it passes the cap, so a gigabyte answer costs the cap and not the gigabyte.
 *   · NOTHING IS TRUSTED TO BE A STRING. The document is JSON somebody else wrote; every
 *     field is checked for type and length before it is looked at.
 *
 * ── FAILING CLOSED, AND SAYING SO ─────────────────────────────────────────────────────
 *
 * An unreadable document is NOT a pass. When the filter is on, "I could not check" and
 * "there is nothing there" both refuse — a filter that opens when its input is missing is
 * not a filter — but they return DIFFERENT reasons, because one is a fact about the coin
 * and the other is a fact about the network, and an operator reading a log full of the
 * second one is looking at their own gateway rather than at bad launches.
 *
 * Pure except for the injected `fetch`. No clock, no globals, no cache of its own.
 */

/** The three fields a pump.fun metadata document can carry. Ordered, so the reason string
 *  a refusal prints is stable and a test can pin it. */
export const SOCIAL_FIELDS = Object.freeze(["twitter", "telegram", "website"]);

/** Every way this module can decline to confirm a social, as stable codes. A caller
 *  branches on these, never on the English beside them. */
export const SOCIAL_CLAUSES = Object.freeze([
  "no_uri",              // the create event carried no metadata link at all
  "uri_not_http",        // …or one this module will not fetch
  "fetch_failed",        // the host refused, reset, or could not be reached
  "fetch_timeout",       // the deadline passed
  "too_large",           // the body went past the cap while being read
  "not_json",            // it answered, but not with a document
  "no_socials",          // a good document, with no link in it
]);

/** Bounds. Small on purpose: this runs on the hot path of a launch sniper, where a slow
 *  answer is worth no more than no answer. */
export const SOCIAL_DEFAULTS = Object.freeze({
  timeoutMs: 1_500,
  maxBytes: 64 * 1024,
});

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * A social link, or null — from a value some stranger's JSON put under that key.
 *
 * Length-capped so a megabyte of text in a one-line field cannot become a log line, and
 * whitespace-trimmed because " " is not a Twitter account. A handle (`@someone`) counts:
 * pump.fun's own form accepts one, and this asks whether the deployer attached an
 * identity, not whether they typed a well-formed URL.
 */
export function socialValue(raw) {
  if (!isStr(raw)) return null;
  const text = raw.trim();
  if (text.length > 400) return null;
  /* A bare "null"/"undefined"/"n/a" written as a string is an empty field with extra
     steps, and metadata generators emit all three. */
  if (/^(null|undefined|none|n\/?a|-)$/i.test(text)) return null;
  return text;
}

/**
 * The socials in a parsed metadata document.
 *
 * Reads the three fields at the top level and, because several metadata generators nest
 * them, under `extensions` and `properties` as well. Anything that is not a plain object
 * is simply not searched — a metadata document that is an array is not an error to throw
 * over, it is a document with no socials in it.
 */
export function socialsFromMetadata(doc) {
  const out = { twitter: null, telegram: null, website: null };
  const look = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const field of SOCIAL_FIELDS) {
      if (out[field] === null) out[field] = socialValue(obj[field]);
    }
  };
  look(doc);
  look(doc?.extensions);
  look(doc?.properties);
  const present = SOCIAL_FIELDS.filter((f) => out[f] !== null);
  return Object.freeze({
    ...out,
    present: Object.freeze(present),
    any: present.length > 0,
  });
}

/** http and https only — see the header. Returns the URL, or null. */
export function fetchableUri(uri) {
  if (!isStr(uri)) return null;
  let parsed;
  try { parsed = new URL(uri.trim()); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/**
 * Read a launch's metadata and report its socials.
 *
 * Never throws: every failure is a `{ ok: false, clause }` the caller can put in a row.
 * `fetchImpl` is injected so the test drives a hostile server without one existing.
 */
export async function readSocials({
  uri, fetchImpl = globalThis.fetch,
  timeoutMs = SOCIAL_DEFAULTS.timeoutMs, maxBytes = SOCIAL_DEFAULTS.maxBytes,
} = {}) {
  if (!isStr(uri)) return Object.freeze({ ok: false, clause: "no_uri", message: "the launch carried no metadata uri" });
  const url = fetchableUri(uri);
  if (url === null)
    return Object.freeze({ ok: false, clause: "uri_not_http",
      message: `the metadata uri is not an http(s) url: ${String(uri).slice(0, 120)}` });
  if (typeof fetchImpl !== "function")
    return Object.freeze({ ok: false, clause: "fetch_failed", message: "no fetch implementation was supplied" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || SOCIAL_DEFAULTS.timeoutMs));
  let timedOut = false;
  controller.signal.addEventListener("abort", () => { timedOut = true; }, { once: true });
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!response || response.ok === false)
      return Object.freeze({ ok: false, clause: "fetch_failed",
        message: `the metadata host answered ${response?.status ?? "nothing"}` });

    /* READ THE BODY UNDER THE CAP, not after it. A declared Content-Length is a claim by
       the party that chose the URL; the only honest limit is one enforced on the bytes as
       they arrive. Falls back to text() for a response object with no stream, which is
       what a test double and some runtimes give. */
    const cap = Math.max(1, Number(maxBytes) || SOCIAL_DEFAULTS.maxBytes);
    let text;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.length ?? 0;
        if (total > cap) {
          await reader.cancel().catch(() => {});
          return Object.freeze({ ok: false, clause: "too_large",
            message: `the metadata document passed ${cap} bytes and was abandoned` });
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    } else {
      text = String(await response.text());
      if (text.length > cap)
        return Object.freeze({ ok: false, clause: "too_large",
          message: `the metadata document is ${text.length} bytes, over the ${cap} cap` });
    }

    let doc;
    try { doc = JSON.parse(text); }
    catch { return Object.freeze({ ok: false, clause: "not_json", message: "the metadata document is not JSON" }); }

    const socials = socialsFromMetadata(doc);
    if (!socials.any)
      return Object.freeze({ ok: false, clause: "no_socials", socials,
        message: "the metadata names no twitter, telegram or website" });
    return Object.freeze({ ok: true, socials,
      message: `the launch names ${socials.present.join(" and ")}` });
  } catch (error) {
    if (timedOut || error?.name === "AbortError")
      return Object.freeze({ ok: false, clause: "fetch_timeout",
        message: `the metadata host did not answer inside ${timeoutMs}ms` });
    return Object.freeze({ ok: false, clause: "fetch_failed",
      message: `the metadata could not be read: ${String(error?.message ?? error).slice(0, 160)}` });
  } finally {
    clearTimeout(timer);
  }
}
