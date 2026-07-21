import { describe, it, expect } from "vitest";

import { toConnectedAccountView } from "@/lib/db/views";
import { maskAccountId } from "@/lib/validation";
import type { ConnectedAccount } from "@/lib/db/schema";

/**
 * Unit test for the `ConnectedAccountView` projection (Req 5.9, 18.2).
 *
 * The projection is the ONLY connected-account shape allowed to cross the
 * server/browser boundary, so these tests assert it (a) exposes the safe fields
 * with a masked account id and (b) never carries the secret columns
 * `role_arn` / `external_id_enc` in any form.
 */

/** Secret values that must never appear in the projected view. */
const ROLE_ARN = "arn:aws:iam::123456789012:role/CloudBillAnalystReadOnly";
const EXTERNAL_ID_ENC = "v1:9f8e7d6c5b4a39281706:ZmFrZS1jaXBoZXJ0ZXh0LXNlY3JldA==";
const AWS_ACCOUNT_ID = "123456789012";

/** Build a full `connected_accounts` row fixture with realistic secrets. */
function makeAccount(): ConnectedAccount {
  return {
    id: "acct_01HZX9K3V2Q7R8S5T6U7V8W9X0",
    userId: "user_01HZX0000000000000000000",
    alias: "Production",
    roleArn: ROLE_ARN,
    externalIdEnc: EXTERNAL_ID_ENC,
    awsAccountId: AWS_ACCOUNT_ID,
    displayCurrency: "IDR",
    timezone: "Asia/Jakarta",
    createdAt: new Date("2024-06-01T00:00:00.000Z"),
  };
}

describe("toConnectedAccountView", () => {
  it("masks the account id, revealing only the last 4 digits", () => {
    const view = toConnectedAccountView(makeAccount());

    expect(view.maskedAccountId).toBe(maskAccountId(AWS_ACCOUNT_ID));
    expect(view.maskedAccountId).toBe("••••••••9012");
    // The raw, unmasked account id must not survive the projection.
    expect(view.maskedAccountId).not.toBe(AWS_ACCOUNT_ID);
  });

  it("carries only the browser-safe fields", () => {
    const view = toConnectedAccountView(makeAccount());

    expect(view).toEqual({
      id: "acct_01HZX9K3V2Q7R8S5T6U7V8W9X0",
      alias: "Production",
      maskedAccountId: "••••••••9012",
      displayCurrency: "IDR",
      timezone: "Asia/Jakarta",
    });
  });

  it("omits the secret role_arn / external_id_enc columns", () => {
    const view = toConnectedAccountView(makeAccount());

    // No secret field survives, under either the camelCase (row) or
    // snake_case (column) name.
    expect(view).not.toHaveProperty("roleArn");
    expect(view).not.toHaveProperty("role_arn");
    expect(view).not.toHaveProperty("externalIdEnc");
    expect(view).not.toHaveProperty("external_id_enc");
    // Nor the raw account id column.
    expect(view).not.toHaveProperty("awsAccountId");
    expect(view).not.toHaveProperty("aws_account_id");

    expect(Object.keys(view).sort()).toEqual([
      "alias",
      "displayCurrency",
      "id",
      "maskedAccountId",
      "timezone",
    ]);
  });

  it("does not leak secret values through JSON serialization", () => {
    const view = toConnectedAccountView(makeAccount());
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain(ROLE_ARN);
    expect(serialized).not.toContain(EXTERNAL_ID_ENC);
  });
});
