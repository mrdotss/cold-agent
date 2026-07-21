import { maskAccountId } from "@/lib/validation";
import type { ConnectedAccount } from "@/lib/db/schema";

/**
 * Browser-safe projection of a connected AWS account (design "Derived /
 * non-persisted types"; Req 5.9, 18.2).
 *
 * This is the ONLY shape of a connected account that may cross the
 * server/browser boundary. It deliberately EXCLUDES the secret columns
 * `role_arn` and `external_id_enc`, which are resolved server-side per account
 * and must never be sent to or held by the client. It also exposes the account
 * id only in masked form (`maskedAccountId`) rather than the raw
 * `aws_account_id`.
 */
export type ConnectedAccountView = {
  /** Stable connected-account id (safe: opaque application id). */
  id: string;
  /** User-chosen display alias. */
  alias: string;
  /** Account id with all but the last 4 digits masked (Req 5.3). */
  maskedAccountId: string;
  /** Display currency (e.g. `IDR`). */
  displayCurrency: string;
  /** IANA timezone (e.g. `Asia/Jakarta`). */
  timezone: string;
};

/**
 * Map a full {@link ConnectedAccount} row to its browser-safe
 * {@link ConnectedAccountView}. The secret fields (`roleArn`, `externalIdEnc`)
 * are dropped and `awsAccountId` is masked via {@link maskAccountId}; only the
 * five safe fields are carried through.
 */
export function toConnectedAccountView(
  account: ConnectedAccount,
): ConnectedAccountView {
  return {
    id: account.id,
    alias: account.alias,
    maskedAccountId: maskAccountId(account.awsAccountId),
    displayCurrency: account.displayCurrency,
    timezone: account.timezone,
  };
}
