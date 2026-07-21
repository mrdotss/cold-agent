/**
 * CloudFormation template generation for the account-connection wizard.
 *
 * This module is PURE and deterministic (no I/O, no AWS SDK, no secrets), which
 * is why it deliberately does NOT `import "server-only"`: it produces plain
 * strings from its arguments so it can be property-tested directly (Property 7).
 *
 * The generated template provisions a read-only cross-account IAM role that:
 *  - grants EXACTLY the three read-only Cost Explorer actions the agent needs
 *    (`ce:GetCostAndUsage`, `ce:GetDimensionValues`, `ce:GetCostForecast`) and
 *    no others (Req 3.2);
 *  - trusts the AgentCore runtime execution role ARN as its sole principal;
 *  - requires an `sts:ExternalId` condition equal to the per-account External_Id.
 *
 * The template is emitted as JSON (a valid CloudFormation format and a strict
 * subset of YAML) so it is deterministic and trivially parseable by tests.
 */

/** Logical resource id for the read-only role inside the template. */
export const ROLE_LOGICAL_ID = "CloudBillAnalystReadOnlyRole";

/** Name of the single inline permissions policy attached to the role. */
export const POLICY_NAME = "CloudBillAnalystCostExplorerReadOnly";

/**
 * The exact set of read-only Cost Explorer actions granted by the template, in
 * a fixed, deterministic order (Req 3.2). Kept as a readonly tuple so the shape
 * is stable across renders.
 */
export const COST_EXPLORER_ACTIONS = [
  "ce:GetCostAndUsage",
  "ce:GetDimensionValues",
  "ce:GetCostForecast",
] as const;

/**
 * Build the read-only cross-account role CloudFormation template.
 *
 * @param runtimeRoleArn - The AgentCore runtime execution role ARN
 *   (`CBA_RUNTIME_ROLE_ARN`) used as the sole trust principal.
 * @param externalId - The per-account External_Id required by the trust
 *   condition (`sts:ExternalId`).
 * @returns A deterministic CloudFormation template as a JSON string
 *   (2-space indented). No timestamps or random values are included.
 */
export function buildCfnTemplate(runtimeRoleArn: string, externalId: string): string {
  const template = {
    AWSTemplateFormatVersion: "2010-09-09",
    Description:
      "Cloud Bill Analyst read-only cross-account role granting Cost Explorer read access.",
    Resources: {
      [ROLE_LOGICAL_ID]: {
        Type: "AWS::IAM::Role",
        Properties: {
          Description:
            "Read-only role assumed by the Cloud Bill Analyst runtime to query Cost Explorer.",
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: runtimeRoleArn },
                Action: "sts:AssumeRole",
                Condition: {
                  StringEquals: { "sts:ExternalId": externalId },
                },
              },
            ],
          },
          Policies: [
            {
              PolicyName: POLICY_NAME,
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    // Cost Explorer does not support resource-level permissions,
                    // so "*" is the standard (and only valid) resource here.
                    Action: [...COST_EXPLORER_ACTIONS],
                    Resource: "*",
                  },
                ],
              },
            },
          ],
        },
      },
    },
    Outputs: {
      RoleArn: {
        Description: "ARN of the created read-only role. Paste this back into the wizard.",
        Value: { "Fn::GetAtt": [ROLE_LOGICAL_ID, "Arn"] },
      },
    },
  };

  return JSON.stringify(template, null, 2);
}

/**
 * Build an AWS console "Launch Stack" deep link that opens the CloudFormation
 * create-stack review screen pre-populated with the hosted template (Req 3.3).
 *
 * The `region` appears in both the console host and the query string (the
 * conventional shape for these links), and the template URL is URL-encoded so
 * it survives as a single query parameter.
 *
 * Pure: same inputs always yield the same string.
 *
 * @param templateUrl - Publicly reachable URL of the hosted template.
 * @param region - AWS region code (e.g. `us-east-1`).
 */
export function launchStackUrl(templateUrl: string, region: string): string {
  const encodedTemplateUrl = encodeURIComponent(templateUrl);
  return (
    `https://${region}.console.aws.amazon.com/cloudformation/home` +
    `?region=${region}` +
    `#/stacks/create/review?templateURL=${encodedTemplateUrl}`
  );
}
