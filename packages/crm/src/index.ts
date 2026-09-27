export {
  attachIdentities,
  getCustomer,
  registerCustomer,
  registerCustomerInTransaction,
  updateCustomer,
} from "./customers.ts";
export type { CustomerView, RegisterCustomerResult } from "./customers.ts";
export { addCustomerAddress, checkAddressServiceArea } from "./addresses.ts";
export { createProperty, listProperties } from "./properties.ts";
export type { PropertyView } from "./properties.ts";
export { addLeadContact, createLead, suppressLeadContact, transitionLead } from "./leads.ts";
export { getEffectiveConsent, recordConsent, withdrawLeadContactConsent } from "./consent.ts";
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
  normalizePaymentReference,
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
export {
  correctRequestAddress,
  geocodeSubmittedRequest,
  rerunRequestGeocoding,
  reviewGeocodingCandidate,
} from "./request-geocoding.ts";
export type { GeocodingDeps, GeocodingRunResult, GeocodingRunStatus } from "./request-geocoding.ts";
export {
  LEAD_PAGE_SIZE_MAX,
  getLeadDetail,
  leadListQuerySchema,
  likePattern,
  listLeadSourceOptions,
  listLeads,
  offeredTransitions,
} from "./lead-admin.ts";
export type { LeadDetail, LeadListItem, LeadListPage, LeadListQuery } from "./lead-admin.ts";
export { linkAccountToCustomer, linkLeadToCustomer } from "./customer-linking.ts";
export type { LinkAccountResult, LinkLeadResult } from "./customer-linking.ts";
