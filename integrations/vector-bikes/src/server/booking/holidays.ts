import feriados from "../../data/feriados-cl.json" with { type: "json" };

/** Fecha `YYYY-MM-DD` → nombre del feriado. */
export const HOLIDAYS: ReadonlyMap<string, string> = new Map(
  feriados.map((feriado) => [feriado.date, feriado.name]),
);

/** Años (texto) que el archivo de feriados cubre. */
export const HOLIDAY_YEARS: ReadonlySet<string> = new Set(
  feriados.map((feriado) => feriado.date.slice(0, 4)),
);

/**
 * Años que toca el rango `[fromDate, fromDate + days]` y que el archivo no cubre.
 * El panel admin lo usa para avisar antes de que la agenda se quede sin feriados.
 */
export function missingHolidayYears(fromDate: string, days: number): string[] {
  const from = new Date(`${fromDate}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) {
    return [];
  }
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const missing = new Set<string>();
  for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year += 1) {
    const text = String(year);
    if (!HOLIDAY_YEARS.has(text)) {
      missing.add(text);
    }
  }
  return [...missing].sort();
}
