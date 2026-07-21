"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";

import { registerUser } from "@/lib/actions/register";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PASSWORD_MIN_LENGTH } from "@/lib/validation";

/**
 * Registration form (Req 1.1, 1.3, 1.4) — a client component wired to the
 * `registerUser` server action.
 *
 * Behaviour:
 *  - On submit, calls `registerUser({ email, password })` and branches on the
 *    typed result (never relies on a thrown error).
 *  - `{ ok: false, field: "email" }` (invalid/duplicate email, Req 1.3) renders
 *    an email-field message; `{ field: "password" }` (invalid password, Req 1.4)
 *    renders a password-field message. The matching control is `aria-invalid`.
 *  - A `{ ok: false }` without a `field` (an unexpected server failure) renders
 *    a generic form-level alert.
 *  - The entered email is retained on failure (controlled state).
 *  - `{ ok: true }` (successful registration, Req 1.1) navigates to `/dashboard`
 *    and refreshes so the guarded shell re-reads the new session.
 */
export function RegisterForm() {
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
        const result = await registerUser({ email, password });
        if (result.ok) {
          router.push("/dashboard");
          router.refresh();
          return;
        }

        // Email is retained via controlled state; map the failure to a field.
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
          Get started
        </p>
        <h2 className="font-heading text-2xl font-semibold">Create account</h2>
        <p className="text-sm text-muted-foreground">
          Sign up with your email to connect an account and start analyzing
          spend.
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
            <FieldLabel htmlFor="register-email">Email</FieldLabel>
            <Input
              id="register-email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              aria-invalid={emailInvalid || undefined}
              aria-describedby={
                emailInvalid ? "register-email-error" : undefined
              }
              onChange={(event) => {
                setEmail(event.target.value);
                if (emailInvalid) setFieldError(null);
              }}
            />
            {emailInvalid ? (
              <FieldError id="register-email-error">
                {fieldError?.message}
              </FieldError>
            ) : null}
          </Field>

          <Field data-invalid={passwordInvalid || undefined}>
            <FieldLabel htmlFor="register-password">Password</FieldLabel>
            <Input
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              aria-invalid={passwordInvalid || undefined}
              aria-describedby={
                passwordInvalid
                  ? "register-password-error"
                  : "register-password-hint"
              }
              onChange={(event) => {
                setPassword(event.target.value);
                if (passwordInvalid) setFieldError(null);
              }}
            />
            {passwordInvalid ? (
              <FieldError id="register-password-error">
                {fieldError?.message}
              </FieldError>
            ) : (
              <FieldDescription id="register-password-hint">
                At least {PASSWORD_MIN_LENGTH} characters.
              </FieldDescription>
            )}
          </Field>

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </FieldGroup>
      </form>

      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-primary underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
