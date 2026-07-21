"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading03Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";

import {
  RedactedError,
  type ConnectionErrorCategory,
} from "@/components/accounts/redacted-error";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { aliasSchema, roleArnSchema } from "@/lib/validation";
import { cn } from "@/lib/utils";
import type { ConnectedAccountView } from "@/lib/db/views";

/** Async status shared by the test and save controls. */
type AsyncState = "idle" | "pending" | "success" | "error";

export interface ConnectAccountFormProps {
  /** External_Id generated server-side for this pending connection. */
  externalId: string;
  /** Called with the browser-safe view once the account is stored. */
  onConnected?: (account: ConnectedAccountView) => void;
  /** Optional step index shown in the eyebrow label (e.g. 3). */
  stepNumber?: number;
  className?: string;
}

/**
 * Field-level validation for the alias. Distinguishes an empty/whitespace value
 * (Req 3.7) from a value that fails the length bound, and returns the trimmed
 * value on success. Returns `null` message when valid.
 */
function validateAlias(raw: string): string | null {
  if (raw.trim().length === 0) {
    return "Enter an account alias.";
  }
  const parsed = aliasSchema.safeParse(raw);
  if (!parsed.success) {
    return "Alias must be 1–100 characters.";
  }
  return null;
}

/**
 * Field-level validation for the role ARN. Distinguishes empty/whitespace
 * (Req 3.7) from a malformed ARN (Req 3.6). Returns `null` when valid.
 */
function validateRoleArn(raw: string): string | null {
  if (raw.trim().length === 0) {
    return "Enter the role ARN you created.";
  }
  if (!roleArnSchema.safeParse(raw).success) {
    return "That doesn't look like an IAM role ARN (arn:aws:iam::<account>:role/<name>).";
  }
  return null;
}

/**
 * Wizard step 3 — collect the role ARN + alias, test the connection, and store
 * the account (Req 3.4, 3.6, 3.7, 4.2, 4.5).
 *
 * Values are controlled and are always retained on rejection. Each field shows
 * a field-specific error. "Test connection" is guarded client-side so an
 * obviously-invalid submission never reaches the server (the server enforces the
 * same rule), and any failure is shown through the shared redacted-error
 * display. A store is only offered once a test has succeeded.
 */
export function ConnectAccountForm({
  externalId,
  onConnected,
  stepNumber,
  className,
}: ConnectAccountFormProps) {
  const [alias, setAlias] = React.useState("");
  const [roleArn, setRoleArn] = React.useState("");
  const [aliasError, setAliasError] = React.useState<string | null>(null);
  const [roleArnError, setRoleArnError] = React.useState<string | null>(null);

  const [testState, setTestState] = React.useState<AsyncState>("idle");
  const [testCategory, setTestCategory] = React.useState<
    ConnectionErrorCategory | undefined
  >(undefined);

  const [saveState, setSaveState] = React.useState<AsyncState>("idle");
  const [saveError, setSaveError] = React.useState<string | undefined>(
    undefined,
  );

  // Live, non-blocking validity used only to guard the Test control so patently
  // invalid input is caught before any network call (Req 4.2). Full validation
  // (with messages) runs on blur and on submit.
  const fieldsLookValid =
    validateAlias(alias) === null && validateRoleArn(roleArn) === null;

  /**
   * Reset any prior test/save outcome whenever the inputs change, so a stale
   * "success" can never let a since-edited value be stored.
   */
  const invalidateOutcome = React.useCallback(() => {
    setTestState("idle");
    setTestCategory(undefined);
    setSaveState("idle");
    setSaveError(undefined);
  }, []);

  const onTest = React.useCallback(async () => {
    const aErr = validateAlias(alias);
    const rErr = validateRoleArn(roleArn);
    setAliasError(aErr);
    setRoleArnError(rErr);
    if (aErr !== null || rErr !== null) {
      return; // Guard: do not call the server on invalid input (Req 4.2).
    }

    setTestState("pending");
    setTestCategory(undefined);
    try {
      const response = await fetch("/api/accounts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias, roleArn, externalId }),
      });
      const result: { ok?: boolean; category?: ConnectionErrorCategory } =
        await response.json().catch(() => ({}));

      if (response.ok && result.ok === true) {
        setTestState("success");
      } else {
        setTestState("error");
        setTestCategory(result.category ?? "assume_failed");
      }
    } catch {
      setTestState("error");
      setTestCategory("timeout");
    }
  }, [alias, roleArn, externalId]);

  const onSave = React.useCallback(async () => {
    setSaveState("pending");
    setSaveError(undefined);
    try {
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias, roleArn, externalId }),
      });
      const payload: { account?: ConnectedAccountView; error?: string } =
        await response.json().catch(() => ({}));

      if (response.ok && payload.account !== undefined) {
        setSaveState("success");
        onConnected?.(payload.account);
      } else {
        setSaveState("error");
        setSaveError(payload.error ?? "Could not save the account.");
      }
    } catch {
      setSaveState("error");
      setSaveError("Could not save the account. Please try again.");
    }
  }, [alias, roleArn, externalId, onConnected]);

  const testing = testState === "pending";
  const saving = saveState === "pending";

  return (
    <section className={cn("flex flex-col gap-4", className)}>
      <header className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          {stepNumber ? `Step ${stepNumber} · ` : ""}Connect
        </p>
        <h3 className="font-heading text-lg">Paste the role ARN and name it</h3>
        <p className="text-sm text-muted-foreground">
          After the stack finishes, copy the role ARN from its Outputs and paste
          it below. We never ask for AWS access keys.
        </p>
      </header>

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onTest();
        }}
      >
        <FieldGroup>
          <Field data-invalid={aliasError !== null || undefined}>
            <FieldLabel htmlFor="account-alias">Account alias</FieldLabel>
            <Input
              id="account-alias"
              name="alias"
              value={alias}
              autoComplete="off"
              placeholder="Production billing"
              aria-invalid={aliasError !== null || undefined}
              onChange={(event) => {
                setAlias(event.target.value);
                if (aliasError !== null) {
                  setAliasError(validateAlias(event.target.value));
                }
                invalidateOutcome();
              }}
              onBlur={() => setAliasError(validateAlias(alias))}
            />
            <FieldDescription>
              A label to recognize this account (1–100 characters).
            </FieldDescription>
            <FieldError>{aliasError}</FieldError>
          </Field>

          <Field data-invalid={roleArnError !== null || undefined}>
            <FieldLabel htmlFor="role-arn">Role ARN</FieldLabel>
            <Input
              id="role-arn"
              name="roleArn"
              value={roleArn}
              autoComplete="off"
              spellCheck={false}
              placeholder="arn:aws:iam::123456789012:role/CloudBillAnalystReadOnlyRole"
              aria-invalid={roleArnError !== null || undefined}
              onChange={(event) => {
                setRoleArn(event.target.value);
                if (roleArnError !== null) {
                  setRoleArnError(validateRoleArn(event.target.value));
                }
                invalidateOutcome();
              }}
              onBlur={() => setRoleArnError(validateRoleArn(roleArn))}
            />
            <FieldError>{roleArnError}</FieldError>
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="outline"
              disabled={!fieldsLookValid || testing}
            >
              {testing ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {testing ? "Testing…" : "Test connection"}
            </Button>

            <Button
              type="button"
              onClick={() => void onSave()}
              disabled={testState !== "success" || saving}
            >
              {saving ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {saving ? "Saving…" : "Save account"}
            </Button>

            {testState === "success" ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  className="size-4 text-primary"
                />
                Connection verified
              </span>
            ) : null}
          </div>

          <span aria-live="polite" className="sr-only">
            {testState === "pending"
              ? "Testing connection"
              : testState === "success"
                ? "Connection verified"
                : testState === "error"
                  ? "Connection test failed"
                  : ""}
          </span>

          {testState === "error" ? (
            <RedactedError category={testCategory} />
          ) : null}

          {saveState === "error" ? (
            <RedactedError title="Couldn't save" message={saveError} />
          ) : null}
        </FieldGroup>
      </form>
    </section>
  );
}
