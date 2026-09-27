import Link from "next/link";

const NAV_ITEMS = [
  { href: "/#leistungen", label: "Leistungen" },
  { href: "/#privat", label: "Privat" },
  { href: "/#gewerbe", label: "Gewerbe" },
  { href: "/#immobilien", label: "Hausverwaltungen" },
  { href: "/#servicegebiet", label: "Servicegebiet" },
] as const;

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link className="brand" href="/">
          ISELA CLEAN
        </Link>
        <nav className="site-nav" aria-label="Hauptnavigation">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
            <li>
              <Link href="/customer">Kundenbereich</Link>
            </li>
          </ul>
        </nav>
        <Link className="button" href="/anfrage">
          Reinigung anfragen
        </Link>
      </div>
    </header>
  );
}
