import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { buildCfnTemplate, COST_EXPLORER_ACTIONS, ROLE_LOGICAL_ID } from "./cfn-template";

describe("buildCfnTemplate property", () => {
  it("grants exactly the three Cost Explorer actions, sets the trust principal, and requires the ExternalId condition", () => {
    // Feature: cloud-bill-analyst-web, Property 7: For any runtime role ARN and External_Id, the CFN template grants exactly ce:GetCostAndUsage, ce:GetDimensionValues, ce:GetCostForecast, sets the trust principal to the ARN, and requires sts:ExternalId to equal the External_Id.

    // Plausible ARN-shaped strings alongside arbitrary strings so we exercise
    // both realistic inputs and adversarial ones.
    const arnShaped = fc
      .tuple(
        fc.string({ unit: fc.constantFrom(..."0123456789".split("")), minLength: 12, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 40 }),
      )
      .map(([id, name]) => `arn:aws:iam::${id}:role/${name}`);

    const runtimeRoleArn = fc.oneof(fc.string(), arnShaped);
    const externalId = fc.oneof(fc.string(), fc.uuid());

    const expectedActions = [...COST_EXPLORER_ACTIONS];
    const expectedActionSet = new Set(expectedActions);

    fc.assert(
      fc.property(runtimeRoleArn, externalId, (arn, extId) => {
        const t = JSON.parse(buildCfnTemplate(arn, extId));

        const role = t.Resources[ROLE_LOGICAL_ID];
        expect(role).toBeDefined();

        // Trust policy: sole principal is the runtime role ARN, assumes role,
        // and requires the ExternalId condition to equal the given External_Id.
        const trustStatements = role.Properties.AssumeRolePolicyDocument.Statement;
        const trust = trustStatements[0];
        expect(trust.Principal.AWS).toBe(arn);
        expect(trust.Action).toBe("sts:AssumeRole");
        expect(trust.Condition.StringEquals["sts:ExternalId"]).toBe(extId);

        // Permission statement: exactly the three actions (set equality, no more
        // and no fewer), resource "*".
        const permStatement = role.Properties.Policies[0].PolicyDocument.Statement[0];
        expect(Array.isArray(permStatement.Action)).toBe(true);
        expect(permStatement.Action).toHaveLength(3);
        expect(new Set(permStatement.Action)).toEqual(expectedActionSet);
        expect(permStatement.Resource).toBe("*");

        // No OTHER Allow statement grants additional actions: the union of all
        // Action entries across every policy statement is exactly those three.
        const grantedActions = new Set<string>();
        for (const policy of role.Properties.Policies) {
          for (const stmt of policy.PolicyDocument.Statement) {
            if (stmt.Effect !== "Allow") continue;
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            for (const a of actions) grantedActions.add(a);
          }
        }
        expect(grantedActions).toEqual(expectedActionSet);
      }),
    );
  });
});
