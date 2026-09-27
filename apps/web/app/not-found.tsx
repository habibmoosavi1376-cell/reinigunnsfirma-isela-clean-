import Link from "next/link";

export default function NotFound() {
  return (
    <section className="section">
      <div className="container">
        <h1>Seite nicht gefunden</h1>
        <p>Die angeforderte Seite existiert nicht.</p>
        <Link href="/">Zur Startseite</Link>
      </div>
    </section>
  );
}
