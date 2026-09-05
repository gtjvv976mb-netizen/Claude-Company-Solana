const positive = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive and finite`);
  return number;
};
const raw = (value, label) => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw new Error(`${label} must be a positive integer`);
  return BigInt(text);
};
const breached = (trigger, mark) => trigger.direction === "below"
  ? mark <= trigger.threshold : mark >= trigger.threshold;

/** Price a held token only from the chain-simulated executable SOL delta. */
export function executableExitMark(position, actualOutputRaw, currentSolUsd) {
  const output = raw(actualOutputRaw, "chain-simulated exit output");
  const entryLamports = raw(position?.entryInputLamports, "position entry input");
  const solUsdRatio = positive(currentSolUsd, "current SOL/USD") /
    positive(position?.solUsdAtEntry, "entry SOL/USD");
  const scale = 1_000_000_000n;
  const mark = Number(output * scale / entryLamports) / Number(scale) * solUsdRatio;
  if (!Number.isFinite(mark) || mark <= 0) throw new Error("chain-simulated executable exit mark is invalid");
  return mark;
}

export class ExitTriggerNotMetError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExitTriggerNotMetError";
    this.code = "EXIT_TRIGGER_NOT_MET";
  }
}

/** Convert a shared price-policy sell into a durable, executable threshold. */
export function priceExitTrigger(position, decision, mark, solUsd, nowMs = Date.now()) {
  const reason = String(decision?.reason || "");
  let direction = null;
  let threshold = null;
  if (reason === "stop loss" || reason === "ratcheted stop") {
    direction = "below"; threshold = positive(position?.stop, "position stop");
  } else if (reason.startsWith("take profit:")) {
    direction = "above";
    threshold = positive(position?.entry, "position entry") * positive(position?.takeProfitX, "take-profit rule");
  } else if (reason === "desk target hit") {
    direction = "above"; threshold = positive(position?.target, "position target");
  } else return null; // age and explicit desk/rug exits are not price-only exits
  const observedMark = positive(mark, "exit trigger mark");
  if (!breached({ direction, threshold }, observedMark))
    throw new Error(`price policy requested ${reason} without a breached threshold`);
  return { kind: "price", direction, threshold, observedMark,
    solUsd: positive(solUsd, "exit SOL/USD"), observedAt: Number(nowMs), reason };
}

/** A price-only exit needs two distinct, consecutive observations. */
export function confirmPriceExitWitness(position, trigger, {
  minGapMs = 1, maxGapMs = 60_000,
} = {}) {
  if (!trigger) {
    delete position.pendingPriceExit;
    return { confirmed: true, trigger: null };
  }
  const prior = position?.pendingPriceExit;
  const gap = Number(trigger.observedAt) - Number(prior?.observedAt || 0);
  const same = prior?.kind === "price" && prior.direction === trigger.direction &&
    Math.abs(Number(prior.threshold) - Number(trigger.threshold)) <=
      Math.max(1e-12, Math.abs(Number(trigger.threshold)) * 1e-9);
  if (same && gap >= minGapMs && gap <= maxGapMs &&
      breached(prior, Number(prior.observedMark)) && breached(trigger, Number(trigger.observedMark))) {
    delete position.pendingPriceExit;
    return { confirmed: true, trigger: { ...trigger, firstObservedAt: Number(prior.observedAt), witnesses: 2 } };
  }
  position.pendingPriceExit = { ...trigger, witnesses: 1 };
  return { confirmed: false, trigger: position.pendingPriceExit };
}

export function clearPriceExitWitness(position) {
  if (position && Object.hasOwn(position, "pendingPriceExit")) delete position.pendingPriceExit;
}

/**
 * Missing executable marks are a HEALTH signal, no longer a sell.
 *
 * Until desk-led-v4 this witness latched a risk-reducing exit on two consecutive
 * non-transport mark failures, and a sustained transport outage latched one too — the
 * threat being an order service that hides a breached stop by refusing every exit
 * quote. Under desk-led-v4 the bot has no stop of its own to hide: the desk determines
 * the exit on its own ruler and the bot sells what it hears, so an unreadable
 * executable mark cannot delay a desk exit (desk_exit intents never consult the mark)
 * and must not manufacture one either (Shrek, call 55, 2026-09-05 — a bot-originated
 * sell nine minutes before the desk's determination). The classification survives
 * because it is still useful: it tells the operator whether the mark is unreadable for
 * transport reasons (weather) or because the order service answered and was refused
 * (worth a look). Both now flag `markUnavailableSince` on the position and nothing else.
 */
export function confirmExitMarkFailureWitness(position, failure, {
  minGapMs = 1, maxGapMs = 60_000,
} = {}) {
  const observedAt = Number(failure?.observedAt);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0)
    throw new Error("exit-mark failure observation time is invalid");
  const prior = position?.pendingExitMarkFailure;
  const gap = observedAt - Number(prior?.observedAt || 0);
  if (prior?.kind === "executable-mark-unavailable" && gap >= minGapMs && gap <= maxGapMs) {
    delete position.pendingExitMarkFailure;
    return { confirmed: true, trigger: {
      kind: "risk-data", reason: "independent executable exit mark unavailable",
      firstObservedAt: Number(prior.observedAt), observedAt, witnesses: 2,
    } };
  }
  position.pendingExitMarkFailure = {
    kind: "executable-mark-unavailable", observedAt,
    reason: String(failure?.reason || "executable exit mark unavailable"), witnesses: 1,
  };
  return { confirmed: false, trigger: position.pendingExitMarkFailure };
}

export function clearExitMarkFailureWitness(position) {
  if (position && Object.hasOwn(position, "pendingExitMarkFailure"))
    delete position.pendingExitMarkFailure;
}

/**
 * Record that the executable exit mark could not be read this tick. Health only:
 * the first failure timestamps `markUnavailableSince` and later failures leave the
 * anchor where it is, so the age reported is the age of the OUTAGE, not of the last
 * error. Returns the outage age in ms. Never a sell — see the note above.
 */
export function noteMarkUnavailable(position, { observedAt, reason, transient = true } = {}) {
  const at = Number(observedAt);
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("mark-unavailable observation time is invalid");
  const since = Number(position.markUnavailableSince) > 0 && Number(position.markUnavailableSince) <= at
    ? Number(position.markUnavailableSince) : at;
  position.markUnavailableSince = since;
  position.markUnavailableAt = at;
  position.markUnavailableReason = String(reason || "executable exit mark unavailable");
  position.markUnavailableTransient = Boolean(transient);
  return at - since;
}

export function clearMarkUnavailable(position) {
  if (!position) return;
  for (const key of ["markUnavailableSince", "markUnavailableAt", "markUnavailableReason",
    "markUnavailableTransient", "exitMarkOutageSince", "pendingExitMarkFailure", "pendingPriceExit"])
    if (Object.hasOwn(position, key)) delete position[key];
}

/** Re-price a latched price exit using the exact final order before signing. */
export function validateExecutableExitOrder(intent, order, {
  nowMs = Date.now(), maxExitTriggerAgeMs = 60_000,
} = {}) {
  if (intent?.kind === "entry") return null;
  /* A DETERMINED exit is executed, never re-litigated. A desk_exit carries the desk's
   * decision and a mirror_exit carries the desk's decision evaluated by the mirror on the
   * desk's own levels; re-validating either against a chain-simulated price threshold
   * would be the bot second-guessing the desk — the exact behaviour desk-led-v4 removes.
   * Only a legacy risk_exit that still carries a price trigger (a latch persisted by a
   * pre-v4 journal) is re-priced below, and only so it cannot fire on a stale trigger.
   *
   * A mirror_exit can still be CANCELLED, but never here and never on a price: the bot's
   * stand-in determination expires upstream, in manageOpen, when the desk it stood in for
   * is reachable and marking that call again (desk-mirror.mjs mirrorLatchExpiry). By the
   * time an order exists the determination has already been re-checked; re-pricing it
   * against a chain-simulated threshold would be the second-guessing v4 removed. */
  if (intent?.kind === "desk_exit" || intent?.kind === "mirror_exit") return null;
  const trigger = intent?.context?.trigger;
  if (!trigger || trigger.kind !== "price") return null;
  const age = Number(nowMs) - Number(trigger.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > Number(maxExitTriggerAgeMs))
    throw new ExitTriggerNotMetError(`price-exit trigger is stale (${Math.max(0, Math.round(age))}ms)`);
  if (!['below', 'above'].includes(trigger.direction)) throw new Error("price-exit direction is invalid");

  const position = intent?.context?.position;
  const heldRaw = raw(position?.qtyRaw, "position quantity");
  const sellRaw = raw(intent?.amountRaw, "exit amount");
  if (sellRaw > heldRaw) throw new Error("exit amount exceeds its durable position");
  const entryLamports = raw(position?.entryInputLamports, "position entry input");
  const proportionalBasis = sellRaw === heldRaw ? entryLamports : entryLamports * sellRaw / heldRaw;
  if (proportionalBasis <= 0n) throw new Error("proportional exit basis rounded to zero");
  const solUsdRatio = positive(trigger.solUsd, "exit SOL/USD") /
    positive(position?.solUsdAtEntry, "entry SOL/USD");
  const markFor = (outputRaw) => {
    const scale = 1_000_000_000n;
    const ratio = raw(outputRaw, "exit output") * scale / proportionalBasis;
    const mark = Number(ratio) / Number(scale) * solUsdRatio;
    if (!Number.isFinite(mark) || mark <= 0) throw new Error("executable exit mark is invalid");
    return mark;
  };
  const quotedMark = markFor(order?.outAmount);
  const minimumMark = markFor(order?.otherAmountThreshold);
  const threshold = positive(trigger.threshold, "price-exit threshold");
  const stillTriggered = trigger.direction === "below"
    ? quotedMark <= threshold
    : minimumMark >= threshold;
  if (!stillTriggered)
    throw new ExitTriggerNotMetError(`final executable mark no longer confirms ${trigger.reason || "price exit"}: ` +
      `quote ${quotedMark.toFixed(6)}, minimum ${minimumMark.toFixed(6)}, threshold ${threshold.toFixed(6)}`);
  return { quotedMark, minimumMark, threshold, direction: trigger.direction, observedAt: trigger.observedAt };
}
