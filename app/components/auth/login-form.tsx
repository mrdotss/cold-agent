"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";

import { login } from "@/lib/actions/login";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * Login form (Req 2.2, 2.3) — a client component wired to the `login` server
 * action.
 *
 * Behaviour:
 *  - On submit, calls `login({ email, password })` and branches on the typed
 *    result (never relies on a thrown error).
 *  - `{ ok: false }` with a `field` (an empty email/password, Req 2.3) renders a
 *    field-level message and marks that control `aria-invalid`.
 *  - `{ ok: false }` without a `field` (invalid credentials or lockout, Req 2.2)
 *    renders the generic message in a form-level alert — never revealing which
 *    field was wrong.
 *  - The entered email is always retained from the result's echoed `email`
 *    (Req 2.2, 2.3); the controlled state also keeps it on the client.
 *  - `{ ok: true }` navigates to `/dashboard` and refreshes so the guarded shell
 *    re-reads the new session.
 */
export function LoginForm() {
  const router = useRouter();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState<{
    field: "email" | "password";
    message: string;
  } | null>(null);
  const [pending, setPending] = React.useState(false);

  const emailInvalid = fieldError?.field === "email";
  const passwordInvalid = fieldError?.field === "password";

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPending(true);
      setFormError(null);
      setFieldError(null);

      try {
        const result = await login({ email, password });
        if (result.ok) {
          router.push("/dashboard");
          router.refresh();
          return;
        }

        // Retain the entered email exactly as echoed back (Req 2.2, 2.3).
        setEmail(result.email);
        if (result.field) {
          setFieldError({ field: result.field, message: result.message });
        } else {
          setFormError(result.message);
        }
      } finally {
        setPending(false);
      }
    },
    [email, password, router],
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">
          Welcome back
        </p>
        <h2 className="font-heading text-2xl font-semibold">Sign in</h2>
        <p className="text-sm text-muted-foreground">
          Enter your credentials to continue to your dashboard.
        </p>
      </header>

      {formError ? (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <form noValidate onSubmit={onSubmit}>
        <FieldGroup className="gap-6">
          <Field data-invalid={emailInvalid || undefined}>
            <FieldLabel htmlFor="login-email">Email</FieldLabel>
            <Input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              aria-invalid={emailInvalid || undefined}
              aria-describedby={emailInvalid ? "login-email-error" : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                if (emailInvalid) setFieldError(null);
              }}
            />
            {emailInvalid ? (
              <FieldError id="login-email-error">
                {fieldError?.message}
              </FieldError>
            ) : null}
          </Field>

          <Field data-invalid={passwordInvalid || undefined}>
            <FieldLabel htmlFor="login-password">Password</FieldLabel>
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={passwordInvalid || undefined}
              aria-describedby={
                passwordInvalid ? "login-password-error" : undefined
              }
              onChange={(event) => {
                setPassword(event.target.value);
                if (passwordInvalid) setFieldError(null);
              }}
            />
            {passwordInvalid ? (
              <FieldError id="login-password-error">
                {fieldError?.message}
              </FieldError>
            ) : null}
          </Field>

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </FieldGroup>
      </form>

      <p className="text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-medium text-primary underline underline-offset-4"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
