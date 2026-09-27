"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="de">
      <body>
        <main>
          <h1>Es ist ein Fehler aufgetreten</h1>
          <p>Bitte laden Sie die Seite neu.</p>
          {error.digest === undefined ? null : <p>Referenz: {error.digest}</p>}
        </main>
      </body>
    </html>
  );
}
