export { attachIdentities, getCustomer, registerCustomer, updateCustomer } from "./customers.ts";
export type { CustomerView, RegisterCustomerResult } from "./customers.ts";
export { addCustomerAddress, checkAddressServiceArea } from "./addresses.ts";
export { createProperty, listProperties } from "./properties.ts";
export type { PropertyView } from "./properties.ts";
export { addLeadContact, createLead, suppressLeadContact, transitionLead } from "./leads.ts";
export { getEffectiveConsent, recordConsent } from "./consent.ts";
export {
  LEAD_STATUSES,
  LEAD_TRANSITIONS,
  assertLeadTransition,
  isLeadStatus,
} from "./lead-state-machine.ts";
export type { LeadStatus, LeadTransitionContext } from "./lead-state-machine.ts";
export {
  UNIQUE_IDENTITY_KINDS,
  assertCrmConfig,
  hashIdentity,
  identityHashesFor,
  normalizeAddress,
  normalizeTaxId,
} from "./identity.ts";
export type { CrmConfig, IdentityHash, IdentityKind } from "./identity.ts";
