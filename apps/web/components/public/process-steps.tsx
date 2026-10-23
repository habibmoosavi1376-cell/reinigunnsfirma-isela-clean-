/**
 * How a request is handled – exactly the process implemented in the platform (request →
 * personal review → written quote → appointment after acceptance). No automatic price,
 * no automatic appointment.
 */
const STEPS = [
  {
    title: "Anfrage senden",
    text: "Sie beschreiben Leistung, Objekt und gewünschte Häufigkeit – online oder per Rückrufwunsch.",
  },
  {
    title: "Persönliche Prüfung",
    text: "Wir prüfen Ihre Angaben und ob Ihre Adresse in unserem Servicegebiet liegt. Bei Fragen melden wir uns.",
  },
  {
    title: "Schriftliches Angebot",
    text: "Sie erhalten ein Angebot mit den vereinbarten Leistungen. Bis zu Ihrer Annahme ist nichts verbindlich.",
  },
  {
    title: "Termin und Reinigung",
    text: "Nach Ihrer Annahme stimmen wir den Termin mit Ihnen ab. Den Stand sehen Sie im Kundenbereich.",
  },
] as const;

export function ProcessSteps({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h3" : "h4";
  return (
    <ol className="steps" role="list">
      {STEPS.map((step, index) => (
        <li key={step.title} className="steps__item">
          <span className="steps__number" aria-hidden="true">
            {index + 1}
          </span>
          <Heading className="steps__title">{step.title}</Heading>
          <p>{step.text}</p>
        </li>
      ))}
    </ol>
  );
}
