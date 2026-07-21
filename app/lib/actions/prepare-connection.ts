"use server";

import { buildCfnTemplate, launchStackUrl } from "@/lib/aws/cfn-template";
import { requireEnv } from "@/lib/env";
import { newExternalId } from "@/lib/external-id";

/**
 * Server-side preparation for the account-connection wizard.
 *
 * This action exists so the wizard's client components never import a
 * server-only or Node-only module: the External_Id (Node `crypto`), the
 * CloudFormation template (needs `CBA_RUNTIME_ROLE_ARN`), and the region all
 * originate here on the server and are handed to the client as plain data.
 *
 * The External_Id is surfaced deliberately — the user must place it in their
 * role's trust condition, and it is also embedded in the returned template. No
 * other secret is produced or returned.
 */

/** Browser-safe payload used to seed the wizard UI. */
export interface PreparedConnection {
  /** Freshly generated External_Id for this pending connection. */
  externalId: string;
  /** CloudFormation template text (JSON) including the External_Id + trust. */
  template: string;
  /** AWS region used for the console fallback link. */
  region: string;
  /**
   * A "Launch Stack" console deep link, present only when a publicly reachable
   * template URL has been configured (`CBA_CFN_TEMPLATE_URL`). Otherwise the
   * client falls back to a region-scoped create-stack console link into which
   * the user uploads the downloaded template.
   */
  launchStackUrl?: string;
}

/**
 * Generate a pending connection's External_Id and CloudFormation template.
 *
 * Reads `CBA_RUNTIME_ROLE_ARN` (trust principal) and `AWS_REGION` at call time;
 * a missing/empty value throws a `MissingEnvError` naming only the variable.
 */
export async function prepareConnection(): Promise<PreparedConnection> {
  const runtimeRoleArn = requireEnv("CBA_RUNTIME_ROLE_ARN");
  const region = requireEnv("AWS_REGION");

  const externalId = newExternalId();
  const template = buildCfnTemplate(runtimeRoleArn, externalId);

  // Only produce a pre-populated Launch Stack link when a hosted template URL is
  // available; otherwise the client renders a console create-stack fallback.
  const hostedTemplateUrl = process.env.CBA_CFN_TEMPLATE_URL;
  const stackUrl =
    hostedTemplateUrl !== undefined && hostedTemplateUrl !== ""
      ? launchStackUrl(hostedTemplateUrl, region)
      : undefined;

  return { externalId, template, region, launchStackUrl: stackUrl };
}
