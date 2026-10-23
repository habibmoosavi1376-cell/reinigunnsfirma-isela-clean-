import Link from "next/link";

interface NavItem {
  readonly href: string;
  readonly label: string;
  /** false = only in the mobile menu (keeps the desktop header on one line). */
  readonly desktop: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/leistungen", label: "Leistungen", desktop: true },
  { href: "/#privat", label: "Privat", desktop: true },
  { href: "/#gewerbe", label: "Gewerbe", desktop: true },
  { href: "/#immobilien", label: "Hausverwaltungen", desktop: true },
  { href: "/#servicegebiet", label: "Servicegebiet", desktop: false },
  { href: "/rueckruf", label: "Rückruf anfordern", desktop: true },
  { href: "/customer", label: "Kundenbereich", desktop: true },
];

function NavList({ desktop }: { desktop: boolean }) {
  return (
    <ul>
      {desktop ? null : (
        <li className="site-nav__cta-item">
          <Link href="/anfrage">
            <strong>Reinigung anfragen</strong>
          </Link>
        </li>
      )}
      {NAV_ITEMS.filter((item) => !desktop || item.desktop).map((item) => (
        <li key={item.href}>
          <Link href={item.href}>{item.label}</Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Desktop: inline navigation. Mobile: a native <details> disclosure ("Menü") – keyboard and
 * screen-reader accessible without client JavaScript, so the header stays compact.
 */
export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link className="brand" href="/">
          ISELA CLEAN
        </Link>
        <nav className="site-nav site-nav--desktop" aria-label="Hauptnavigation">
          <NavList desktop />
        </nav>
        <Link className="button site-header__cta" href="/anfrage">
          Reinigung anfragen
        </Link>
        <details className="site-nav site-nav--mobile">
          <summary>Menü</summary>
          <nav aria-label="Hauptnavigation (mobil)">
            <NavList desktop={false} />
          </nav>
        </details>
      </div>
    </header>
  );
}
