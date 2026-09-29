import Link from "next/link";

export default function Forbidden() {
  return (
    <section className="section">
      <div className="container">
        <h1>Kein Zugriff</h1>
        <p>
          Für diesen Bereich fehlen Ihrem Konto die nötigen Berechtigungen. Wenn Sie Kunde sind und
          Ihr Konto noch nicht mit Ihren Kundendaten verknüpft ist, wenden Sie sich bitte an uns.
        </p>
        <Link href="/">Zur Startseite</Link>
      </div>
    </section>
  );
}
