import { afterEach, describe, it, expect, vi } from "vitest";

import {
  COST_EXPLORER_ACTIONS,
  buildCfnTemplate,
  launchStackUrl,
} from "@/lib/aws/cfn-template";
import { prepareConnection } from "@/lib/actions/prepare-connection";

/**
 * Unit tests for `prepareConnection()` — the server action that seeds the
 * account-connection wizard (Req 3.3).
 *
 * Nothing here is mocked beyond the environment: `prepareConnection` reads
 * `CBA_RUNTIME_ROLE_ARN` + `AWS_REGION` (and the optional `CBA_CFN_TEMPLATE_URL`)
 * from `process.env`, generates a real External_Id, and builds the real
 * CloudFormation template. We stub the env with `vi.stubEnv` and cross-check the
 * output against `buildCfnTemplate` / `launchStackUrl` directly.
 */

const RUNTIME_ROLE_ARN =
  "arn:aws:iam::999988887777:role/cloud-bill-analyst-runtime";
const REGION = "us-east-1";
const TEMPLATE_URL = "https://cba-templates.example.com/read-only-role.json";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("prepareConnection — template presentation + Launch Stack link (Req 3.3)", () => {
  it("returns a template generated via buildCfnTemplate that embeds the External_Id", async () => {
    vi.stubEnv("CBA_RUNTIME_ROLE_ARN", RUNTIME_ROLE_ARN);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("CBA_CFN_TEMPLATE_URL", TEMPLATE_URL);

    const prepared = await prepareConnection();

    // The template is exactly what buildCfnTemplate produces for the returned
    // External_Id (deterministic) — i.e. it is generated server-side, not ad hoc.
    expect(prepared.template).toBe(
      buildCfnTemplate(RUNTIME_ROLE_ARN, prepared.externalId),
    );
    // The External_Id is embedded in the presented template.
    expect(prepared.template).toContain(prepared.externalId);
    expect(prepared.region).toBe(REGION);
  });

  it("embeds exactly the three read-only Cost Explorer actions and the ExternalId trust condition", async () => {
    vi.stubEnv("CBA_RUNTIME_ROLE_ARN", RUNTIME_ROLE_ARN);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("CBA_CFN_TEMPLATE_URL", TEMPLATE_URL);

    const prepared = await prepareConnection();
    const template = JSON.parse(prepared.template);

    const role = template.Resources.CloudBillAnalystReadOnlyRole;

    // Trust: sole principal is the runtime role ARN, condition pins ExternalId.
    const trust = role.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Principal).toEqual({ AWS: RUNTIME_ROLE_ARN });
    expect(trust.Condition.StringEquals["sts:ExternalId"]).toBe(
      prepared.externalId,
    );

    // Permissions: EXACTLY the three read-only CE actions, nothing else.
    const permission = role.Properties.Policies[0].PolicyDocument.Statement[0];
    expect(permission.Action).toEqual([...COST_EXPLORER_ACTIONS]);
    expect(permission.Action).toHaveLength(3);
  });

  it("produces a Launch Stack link via launchStackUrl when CBA_CFN_TEMPLATE_URL is set", async () => {
    vi.stubEnv("CBA_RUNTIME_ROLE_ARN", RUNTIME_ROLE_ARN);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("CBA_CFN_TEMPLATE_URL", TEMPLATE_URL);

    const prepared = await prepareConnection();

    expect(prepared.launchStackUrl).toBe(launchStackUrl(TEMPLATE_URL, REGION));
    // The link is a region-scoped CloudFormation console deep link carrying the
    // URL-encoded hosted template.
    expect(prepared.launchStackUrl).toContain(
      `${REGION}.console.aws.amazon.com/cloudformation`,
    );
    expect(prepared.launchStackUrl).toContain(
      encodeURIComponent(TEMPLATE_URL),
    );
  });

  it("omits the Launch Stack link when no hosted template URL is configured", async () => {
    vi.stubEnv("CBA_RUNTIME_ROLE_ARN", RUNTIME_ROLE_ARN);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("CBA_CFN_TEMPLATE_URL", "");

    const prepared = await prepareConnection();

    expect(prepared.launchStackUrl).toBeUndefined();
    // The template is still produced for the copy/download + console fallback.
    expect(prepared.template).toContain(prepared.externalId);
  });
});
