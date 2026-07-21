"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Settings02Icon, Loading03Icon } from "@hugeicons/core-free-icons";

import { RedactedError } from "@/components/accounts/redacted-error";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { currencySchema, timezoneSchema } from "@/lib/validation";
import type { AccountMutationResult } from "@/lib/actions/accounts";
import type { ConnectedAccountView } from "@/lib/db/views";

/**
 * Common ISO 4217 currency codes offered in the settings picker. The account's
 * currently-stored value is always merged in (see {@link withValue}) so an
 * out-of-list value still displays and stays selectable.
 */
const COMMON_CURRENCIES = [
  "IDR",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "SGD",
  "AUD",
  "CAD",
  "INR",
  "CNY",
  "CHF",
  "HKD",
  "KRW",
  "MYR",
  "THB",
] as const;

/**
 * Common IANA time zones offered in the settings picker. As with currencies,
 * the stored value is merged in so it always appears.
 */
const COMMON_TIMEZONES = [
  "UTC",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
] as const;

type SelectItemOption = { label: string; value: string };

/** Build a deduped `{ label, value }` list that always includes `current`. */
function withValue(
  options: readonly string[],
  current: string,
): SelectItemOption[] {
  const values = new Set<string>([current, ...options]);
  return Array.from(values).map((value) => ({ label: value, value }));
}

type SaveState = "idle" | "pending" | "success" | "error";

export interface AccountSettingsProps {
  /** The account whose per-account currency/timezone are being edited. */
  account: ConnectedAccountView;
  /**
   * Persist the settings (server action wrapper). Returns the mutation result so
   * this component can surface a redacted error without owning list state.
   */
  onSave: (
    accountId: string,
    settings: { displayCurrency: string; timezone: string },
  ) => Promise<AccountMutationResult>;
  className?: string;
}

/**
 * Per-account currency + timezone settings (Req 17.1, 17.2, 17.3).
 *
 * Presented in a {@link Popover} anchored to a compact trigger. The two selects
 * are seeded with the account's stored `displayCurrency`/`timezone`, so the
 * current values are always shown (Req 17.1). Before persisting, the chosen
 * values are validated client-side against the shared `currencySchema`
 * (ISO 4217) and `timezoneSchema` (IANA) so an invalid selection never reaches
 * the server (Req 17.2, 17.3); the server re-validates as the authority.
 */
export function AccountSettings({
  account,
  onSave,
  className,
}: AccountSettingsProps) {
  const [open, setOpen] = React.useState(false);
  const [currency, setCurrency] = React.useState(account.displayCurrency);
  const [timezone, setTimezone] = React.useState(account.timezone);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [state, setState] = React.useState<SaveState>("idle");

  // Re-seed from the account's stored values on open (so the picker always
  // reflects the current settings, even after a server refresh) and clear any
  // prior outcome on close. Done in the open handler rather than an effect.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setCurrency(account.displayCurrency);
        setTimezone(account.timezone);
      }
      setState("idle");
      setError(undefined);
    },
    [account.displayCurrency, account.timezone],
  );

  const currencyItems = React.useMemo(
    () => withValue(COMMON_CURRENCIES, account.displayCurrency),
    [account.displayCurrency],
  );
  const timezoneItems = React.useMemo(
    () => withValue(COMMON_TIMEZONES, account.timezone),
    [account.timezone],
  );

  const onSubmit = React.useCallback(async () => {
    // Client-side validation gate (Req 17.2, 17.3): never send an invalid
    // currency/timezone to the server.
    if (!currencySchema.safeParse(currency).success) {
      setState("error");
      setError("Choose a valid ISO 4217 currency code.");
      return;
    }
    if (!timezoneSchema.safeParse(timezone).success) {
      setState("error");
      setError("Choose a valid IANA time zone.");
      return;
    }

    setState("pending");
    setError(undefined);
    const result = await onSave(account.id, {
      displayCurrency: currency,
      timezone,
    });
    if (result.ok) {
      setState("success");
      setOpen(false);
    } else {
      setState("error");
      setError(result.message);
    }
  }, [account.id, currency, timezone, onSave]);

  const saving = state === "pending";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className={className} />
        }
      >
        <HugeiconsIcon icon={Settings02Icon} data-icon="inline-start" />
        Settings
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            {account.alias}
          </p>
          <h4 className="font-heading text-base">Report preferences</h4>
          <p className="text-sm text-muted-foreground">
            Currency and time zone used when the agent analyzes this account.
          </p>
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`currency-${account.id}`}>
              Display currency
            </FieldLabel>
            <Select
              items={currencyItems}
              value={currency}
              onValueChange={(value) => setCurrency(value as string)}
            >
              <SelectTrigger
                id={`currency-${account.id}`}
                className="w-full"
                aria-label="Display currency"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {currencyItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>ISO 4217 code (e.g. IDR, USD).</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`timezone-${account.id}`}>
              Time zone
            </FieldLabel>
            <Select
              items={timezoneItems}
              value={timezone}
              onValueChange={(value) => setTimezone(value as string)}
            >
              <SelectTrigger
                id={`timezone-${account.id}`}
                className="w-full"
                aria-label="Time zone"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {timezoneItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>IANA identifier (e.g. Asia/Jakarta).</FieldDescription>
          </Field>

          {state === "error" ? (
            <RedactedError title="Couldn't save settings" message={error} />
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void onSubmit()}
              disabled={saving}
            >
              {saving ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}
