/**
 * The shared vocabulary (roles, capabilities, Agent policies) for code that also runs in the
 * browser, from the shared package's browser entry: it has no zod and no request schemas, so
 * they stay out of the browser bundle.
 */
export {
  AGENT_POLICIES,
  AGENT_POLICIES_NEEDING_CONFIGURE,
  AGENT_POLICY_DESCRIPTIONS,
  AGENT_POLICY_KEYS,
  type AgentPolicy,
  type AgentPolicySwitches,
  CAPABILITIES,
  CAPABILITY_KEYS,
  type Capability,
  PRODUCTION_CONFIRMATION_PHRASE,
  ROLE_LABELS,
  type Role,
} from "@nearzero/shared/browser";
