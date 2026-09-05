/**
 * Advance only across a batch whose exits have already been pre-latched/processed.
 * Entries crossed by this path are deliberately abandoned while exposure is frozen;
 * the next batch then becomes visible without forgetting any exit instruction.
 */
export function advanceFrozenBatchCursor(cursor, events) {
  let next = Number(cursor);
  if (!Number.isSafeInteger(next) || next < 0) throw new Error("feed cursor is invalid");
  if (!Array.isArray(events)) throw new Error("feed batch is invalid");
  for (const event of events) {
    const id = Number(event?.id);
    if (!Number.isSafeInteger(id) || id <= next)
      throw new Error("frozen feed batch is not strictly increasing above the cursor");
    next = id;
  }
  return next;
}

/** An authenticated feed may lag, but it may never rewrite durable history. */
export function authenticatedFeedCursorState(cursor, latestId) {
  const durable = Number(cursor);
  const latest = Number(latestId);
  if (!Number.isSafeInteger(durable) || durable < 0)
    throw new Error("feed cursor is invalid");
  if (!Number.isSafeInteger(latest) || latest < 0)
    throw new Error("feed omitted a safe non-negative latest_id");
  return Object.freeze({
    rollback: latest < durable,
    cursor: durable,
    latestId: latest,
    lag: latest >= durable ? latest - durable : null,
  });
}

/**
 * Give one already-running recovery pass a strict amount of foreground time.
 * The pass itself is deliberately not cancelled: it retains its in-process intent
 * lock while fresh position safety proceeds, which prevents a second tick from
 * duplicating a submission.
 */
export async function waitForRecoveryBudget(pass, budgetMs, {
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!pass || typeof pass.then !== "function")
    throw new Error("recovery pass must be a promise");
  const delay = Number(budgetMs);
  if (!Number.isSafeInteger(delay) || delay < 0)
    throw new Error("recovery budget must be a non-negative safe integer");
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(pass).then(() => "completed"),
      new Promise((resolve) => {
        timer = schedule(() => resolve("budget-exhausted"), delay);
      }),
    ]);
  } finally {
    if (timer !== undefined) cancel(timer);
  }
}
