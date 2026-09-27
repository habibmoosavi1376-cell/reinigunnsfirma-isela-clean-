/**
 * Loading UI for protected areas. Deliberately NOT placed at app/loading.tsx: a root-level
 * Suspense boundary starts streaming (HTTP 200) before the area layouts run their server-side
 * guards, so unauthorized()/forbidden() could no longer set 401/403 status codes. Segment-level
 * loading files sit inside the guarded layouts and keep the status codes correct.
 */
export function LoadingState() {
  return (
    <section className="section" aria-busy="true">
      <div className="container">
        <p role="status">Wird geladen …</p>
      </div>
    </section>
  );
}
