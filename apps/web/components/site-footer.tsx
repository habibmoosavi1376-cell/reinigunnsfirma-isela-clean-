import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <nav aria-label="Rechtliches und Service">
          <ul>
            <li>
              <Link href="/anfrage">Reinigung anfragen</Link>
            </li>
            <li>
              <Link href="/auth/login">Anmelden</Link>
            </li>
            <li>
              <Link href="/impressum">Impressum</Link>
            </li>
            <li>
              <Link href="/datenschutz">Datenschutz</Link>
            </li>
          </ul>
        </nav>
        <p>© {new Date().getFullYear()} ISELA CLEAN</p>
      </div>
    </footer>
  );
}
