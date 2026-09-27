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
  keyedHash,
  identityHashesFor,
  normalizeAddress,
  normalizeTaxId,
} from "./identity.ts";
export type { CrmConfig, IdentityHash, IdentityKind } from "./identity.ts";
export {
  REQUEST_CUSTOMER_TYPES,
  REQUEST_FREQUENCIES,
  REQUEST_PROPERTY_TYPES,
  WEBSITE_REQUEST_SOURCE_KEY,
  getLeadOverview,
  listCustomerServiceRequests,
  serviceRequestInputSchema,
  submitServiceRequest,
} from "./service-requests.ts";
export type {
  CustomerRequestView,
  LeadOverview,
  ServiceRequestInput,
  SubmitServiceRequestDeps,
  SubmitServiceRequestResult,
} from "./service-requests.ts";
