/**
 * Pure message-ordering contract (Req 8.5).
 *
 * When a user opens an owned thread, its messages are displayed ordered by
 * `created_at` ascending (oldest first). The database read in
 * `lib/actions/threads.ts#getThreadMessages` enforces this via
 * `ORDER BY created_at ASC`; this module captures the SAME ordering contract as
 * a pure, framework-agnostic function so it can be unit- and property-tested
 * without a live database, and reused as a defense-in-depth sort wherever
 * messages are rendered.
 */

/** Minimal shape required to order messages: anything with a `createdAt`. */
export interface OrderableMessage {
  createdAt: Date;
}

/**
 * Return a new array of the given messages ordered by `createdAt` ascending
 * (oldest first). The sort is STABLE: messages sharing the same timestamp keep
 * their original relative order. The input array is not mutated.
 *
 * The output is always a permutation of the input (same elements, same count);
 * only the order changes.
 */
export function orderMessagesByCreatedAtAsc<T extends OrderableMessage>(
  messages: readonly T[],
): T[] {
  // Decorate with original index so ties resolve to insertion order, giving a
  // stable sort independent of the engine's Array.prototype.sort stability.
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const delta = a.message.createdAt.getTime() - b.message.createdAt.getTime();
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map((entry) => entry.message);
}
