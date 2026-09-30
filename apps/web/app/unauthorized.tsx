import Link from "next/link";

export default function Unauthorized() {
  return (
    <section className="section">
      <div className="container">
        <h1>Anmeldung erforderlich</h1>
        <p>Bitte melden Sie sich an, um diesen Bereich zu nutzen.</p>
        <Link className="button" href="/auth/login">
          Anmelden
        </Link>
      </div>
    </section>
  );
}
