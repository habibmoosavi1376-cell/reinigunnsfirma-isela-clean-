"use client";

/** Generic error boundary: no stack traces or internal details are shown to users. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="section">
      <div className="container">
        <h1>Es ist ein Fehler aufgetreten</h1>
        <p>Bitte versuchen Sie es erneut. Wenn das Problem bleibt, kontaktieren Sie uns.</p>
        {error.digest === undefined ? null : <p className="muted">Referenz: {error.digest}</p>}
        <button className="button" type="button" onClick={reset}>
          Erneut versuchen
        </button>
      </div>
    </section>
  );
}
