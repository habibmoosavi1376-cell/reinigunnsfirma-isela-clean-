import type { LeadDetail } from "@isela/crm";

/**
 * Suggests the next manual step for a lead. Advisory only – nothing is automated, and every
 * suggested step is executed (and authorised) by the corresponding server action.
 */
export function nextActions(detail: LeadDetail, geocodingConfigured: boolean): string[] {
  const actions: string[] = [];
  const request = detail.request;
  if (request !== null) {
    if (request.geocodingStatus === "NEEDS_REVIEW") {
      actions.push("Unsicheres Geocoding-Ergebnis prüfen (bestätigen oder verwerfen).");
    } else if (request.geocodingStatus === "PENDING") {
      actions.push(
        geocodingConfigured
          ? "Geocoding erneut ausführen (Anbieter war nicht erreichbar)."
          : "Verfügbarkeit manuell klären – kein Geocoding-Anbieter konfiguriert.",
      );
    } else if (request.geocodingStatus === "FAILED") {
      actions.push("Adresse mit der anfragenden Person klären und korrigieren.");
    }
    if (request.serviceAreaStatus === "NOT_AVAILABLE") {
      actions.push(
        "Adresse liegt außerhalb der aktiven Servicegebiete – Absage oder Ausnahme klären.",
      );
    }
  }
  switch (detail.lead.status) {
    case "DISCOVERED":
      actions.push("Anfrage sichten und qualifizieren (oder als Angebotsanfrage übernehmen).");
      break;
    case "QUOTE_REQUEST":
      actions.push(
        request !== null && request.customerId === null
          ? "Kundendatensatz verknüpfen und den Angebotsentwurf in der Kundenakte manuell erstellen – es gibt keine automatische Preiszusage."
          : "Angebotsentwurf in der Kundenakte manuell erstellen – es gibt keine automatische Preiszusage.",
      );
      break;
    case "WON":
      if (request !== null && request.customerId === null) {
        actions.push("Kundendatensatz verknüpfen.");
      }
      break;
    default:
      break;
  }
  return actions;
}
