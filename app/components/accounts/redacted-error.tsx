"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/**
 * The coarse failure categories the connection-test route can return
 * (`/api/accounts/test`). These mirror `ConnectionTestResult["category"]` from
 * the server-only STS module but are duplicated here as a browser-safe literal
 * union so this client component never imports a `server-only` module.
 */
export type ConnectionErrorCategory =
  | "invalid_input"
  | "assume_failed"
  | "query_failed"
  | "timeout";

/**
 * Friendly, fully-redacted messages for each failure category (Req 4.5). Each
 * message describes the failure class only — it never contains the External_Id,
 * role credentials, ARNs, or any internal identifier.
 */
const CATEGORY_MESSAGES: Record<ConnectionErrorCategory, string> = {
  invalid_input:
    "The role ARN or details look invalid. Double-check the values and try again.",
  assume_failed:
    "We couldn't assume the role. Confirm the trust policy principal and External ID match the template, then retry.",
  query_failed:
    "The role was assumed, but the Cost Explorer test query failed. Confirm the read-only permissions from the template are attached.",
  timeout:
    "The connection test didn't finish in time. Check the role setup and try again.",
};

/** Fallback used when no recognized category or explicit message is provided. */
const GENERIC_MESSAGE = "Something went wrong. Please try again.";

export interface RedactedErrorProps {
  /** Failure category returned by the server (drives the default message). */
  category?: ConnectionErrorCategory | string;
  /**
   * An explicit, already-redacted message. When provided it wins over the
   * category-derived text. Callers must ensure this contains no secrets.
   */
  message?: string;
  /** Optional heading; defaults to a neutral title. */
  title?: string;
  className?: string;
}

/**
 * Resolve the browser-safe message for a category, if recognized.
 */
function messageForCategory(
  category: RedactedErrorProps["category"],
): string | undefined {
  if (typeof category === "string" && category in CATEGORY_MESSAGES) {
    return CATEGORY_MESSAGES[category as ConnectionErrorCategory];
  }
  return undefined;
}

/**
 * Shared, accessible error presentation used across the account wizard.
 *
 * It renders a destructive {@link Alert} (which carries `role="alert"`) with a
 * short, redacted description. Only recognized categories or an explicit,
 * caller-supplied message are shown; nothing about the failure's internals is
 * ever surfaced. Returns `null` when there is nothing to show.
 */
export function RedactedError({
  category,
  message,
  title = "Connection failed",
  className,
}: RedactedErrorProps) {
  const body = message ?? messageForCategory(category) ?? GENERIC_MESSAGE;

  if (category === undefined && message === undefined) {
    return null;
  }

  return (
    <Alert variant="destructive" className={cn(className)}>
      <HugeiconsIcon icon={Alert02Icon} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </Alert>
  );
}

export { CATEGORY_MESSAGES as CONNECTION_ERROR_MESSAGES };
