// Scoped to the dashboard: a loading boundary above pages that call notFound()/forbidden()
// (e.g. /admin/leads/[id]) would start streaming with HTTP 200 before the status is known.
export { LoadingState as default } from "@/components/loading-state";
