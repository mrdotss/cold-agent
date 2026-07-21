/**
 * Pure chat-composer enablement rule (Req 6.1, 6.2, 6.3, 6.4).
 *
 * This module is intentionally free of `"use client"`/`"use server"` and of any
 * DOM or server-only dependency so the enablement decision can be imported and
 * property-tested in isolation. The `Composer` component
 * (`components/chat/composer.tsx`) derives its disabled/enabled state from
 * {@link isComposerEnabled}, so the test exercises the SAME logic that runs in
 * production.
 *
 * The core rule (Req 6.1, 6.2): the composer is ENABLED (accepts text entry and
 * submission) if and only if the authenticated user has at least one connected
 * account; with zero connected accounts it is DISABLED. Because enablement is a
 * pure function of the current connected-account count, the transitions in
 * Req 6.3 (connecting the first account enables it) and Req 6.4 (disconnecting
 * the last account disables it) follow directly from re-evaluating the rule
 * against the new count.
 */

/** Optional gating inputs beyond the account count. */
export interface ComposerGateOptions {
  /**
   * Explicit disable override. When defined it wins over the account-count
   * gate (mirrors the component's `disabled` prop), e.g. to force-disable while
   * some parent state requires it. Leave undefined to gate purely on the count.
   */
  disabled?: boolean;
}

/**
 * Decide whether the chat composer should be enabled given how many connected
 * accounts the authenticated user currently holds.
 *
 * Enabled if and only if `accountCount >= 1` (Req 6.1, 6.2). An explicit
 * `disabled` override, when provided, takes precedence over the count gate.
 */
export function isComposerEnabled(
  accountCount: number,
  opts?: ComposerGateOptions,
): boolean {
  if (opts?.disabled !== undefined) return !opts.disabled;
  return accountCount >= 1;
}
