import { describe, expect, it } from "vitest";
import { hoursFor } from "../../src/server/booking/rules.ts";
import { checkStart, gridForDate } from "../../src/server/booking/slots.ts";

/** 2026-09-15 12:00 hora local, un martes. */
const NOW = new Date("2026-09-15T15:00:00.000Z");
const LUNES = "2026-09-21";
const SABADO = "2026-09-19";
const DOMINGO = "2026-09-20";

function intento(date: string, start: string, mode: "taller" | "retiro") {
  return checkStart({
    date,
    mode,
    now: NOW,
    start,
    activeBlockStarts: [],
    blocked: [],
    usedCount: 0,
  });
}

describe("horario por modalidad", () => {
  it("el retiro abre a las 09:00 de lunes a viernes y el taller sigue a las 15:00", () => {
    expect(gridForDate(LUNES, "retiro").at(0)).toBe("09:00");
    expect(gridForDate(LUNES, "taller").at(0)).toBe("15:00");
    // Sin modalidad sigue siendo el horario del taller: lo usan la agenda y la fecha de entrega.
    expect(gridForDate(LUNES)).toEqual(gridForDate(LUNES, "taller"));
  });

  it("las dos modalidades cierran a las 20:00", () => {
    expect(gridForDate(LUNES, "retiro").at(-1)).toBe("19:30");
    expect(gridForDate(LUNES, "taller").at(-1)).toBe("19:30");
    expect(gridForDate(LUNES, "retiro")).toHaveLength(22);
    expect(gridForDate(LUNES, "taller")).toHaveLength(10);
  });

  it("el sábado y el domingo no cambian en ninguna modalidad", () => {
    for (const mode of ["taller", "retiro"] as const) {
      expect(gridForDate(SABADO, mode).at(0)).toBe("10:00");
      expect(gridForDate(SABADO, mode).at(-1)).toBe("13:30");
      expect(gridForDate(DOMINGO, mode)).toEqual([]);
    }
  });

  it("un retiro de las 19:00 alcanza a terminar a las 20:00 y uno de las 19:30 no", () => {
    const cabe = intento(LUNES, "19:00", "retiro");
    expect(cabe.ok).toBe(true);
    if (cabe.ok) expect(cabe.blockStarts).toEqual(["19:00", "19:30"]);

    expect(intento(LUNES, "19:30", "retiro").ok).toBe(false);
  });

  it("el taller no acepta la mañana y el retiro sí", () => {
    expect(intento(LUNES, "09:00", "retiro").ok).toBe(true);
    expect(intento(LUNES, "09:00", "taller")).toEqual({ ok: false, reason: "invalid_start" });
  });

  it("hoursFor es la única fuente del horario de cada modalidad", () => {
    expect(hoursFor("retiro", 1)).toEqual({ open: "09:00", close: "20:00" });
    expect(hoursFor("taller", 1)).toEqual({ open: "15:00", close: "20:00" });
    expect(hoursFor("retiro", 6)).toEqual({ open: "10:00", close: "14:00" });
    expect(hoursFor("taller", 6)).toEqual({ open: "10:00", close: "14:00" });
    expect(hoursFor("retiro", 7)).toBeNull();
    expect(hoursFor("taller", 7)).toBeNull();
  });
});
