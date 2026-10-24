import { describe, expect, it } from "vitest";
import { missingHolidayYears } from "../../src/server/booking/holidays.ts";
import type { BookingMode } from "../../src/server/booking/rules.ts";
import {
  type DayInput,
  checkStart,
  computeDay,
  gridForDate,
  localToInstant,
} from "../../src/server/booking/slots.ts";

/** 2026-09-16 16:04 hora local (UTC-3). */
const NOW = new Date("2026-09-16T19:04:00.000Z");

function dayInput(date: string, mode: BookingMode, extra: Partial<DayInput> = {}): DayInput {
  return {
    date,
    mode,
    now: NOW,
    activeBlockStarts: [],
    blocked: [],
    usedCount: 0,
    ...extra,
  };
}

function stateOf(day: ReturnType<typeof computeDay>, start: string): string | undefined {
  return day.blocks.find((block) => block.start === start)?.state;
}

describe("grilla", () => {
  it("abre de tarde entre semana, de mañana el sábado y cierra el domingo", () => {
    const wednesday = gridForDate("2026-09-16");
    expect(wednesday.at(0)).toBe("15:00");
    expect(wednesday.at(-1)).toBe("19:30");

    const saturday = gridForDate("2026-09-26");
    expect(saturday.at(0)).toBe("10:00");
    expect(saturday.at(-1)).toBe("13:30");

    expect(gridForDate("2026-09-20")).toEqual([]);
  });
});

describe("zonas horarias", () => {
  it("convierte 15:00 local según verano e invierno", () => {
    expect(localToInstant("2026-01-15", "15:00")?.toISOString()).toBe("2026-01-15T18:00:00.000Z");
    expect(localToInstant("2026-06-15", "15:00")?.toISOString()).toBe("2026-06-15T19:00:00.000Z");
  });

  it("maneja los dos fines de semana de cambio de horario", () => {
    expect(localToInstant("2026-09-05", "10:00")?.toISOString()).toBe("2026-09-05T14:00:00.000Z");
    expect(localToInstant("2026-09-07", "15:00")?.toISOString()).toBe("2026-09-07T18:00:00.000Z");
    expect(localToInstant("2026-09-06", "00:00")).toBeNull();

    expect(localToInstant("2026-04-02", "15:00")?.toISOString()).toBe("2026-04-02T18:00:00.000Z");
    expect(localToInstant("2026-04-06", "15:00")?.toISOString()).toBe("2026-04-06T19:00:00.000Z");
  });
});

describe("computeDay", () => {
  it("marca el feriado con su nombre y sin bloques", () => {
    const day = computeDay(dayInput("2026-09-18", "taller"));
    expect(day.status).toBe("holiday");
    expect(day.holidayName).toBe("Independencia Nacional");
    expect(day.blocks).toEqual([]);
  });

  it("marca también los feriados de 2027", () => {
    // Cada caso necesita su propio `now`: fuera del horizonte de 30 días el día sale "closed"
    // antes de mirar el feriado.
    const junio = { now: new Date("2027-06-10T19:04:00.000Z") };
    // El 29 de junio cae martes y la ley 19.668 corre el feriado al lunes 28: copiar la fecha
    // fija del año anterior abriría el taller un feriado y lo cerraría un día hábil.
    const trasladado = computeDay(dayInput("2027-06-28", "taller", junio));
    expect(trasladado.status).toBe("holiday");
    expect(trasladado.holidayName).toBe("San Pedro y San Pablo");
    expect(computeDay(dayInput("2027-06-29", "taller", junio)).status).not.toBe("holiday");

    const septiembre = { now: new Date("2027-09-01T19:04:00.000Z") };
    expect(computeDay(dayInput("2027-09-17", "taller", septiembre)).holidayName).toBe(
      "Feriado adicional de Fiestas Patrias",
    );
  });

  it("marca late los bloques dentro de las 2 horas de antelación", () => {
    const day = computeDay(dayInput("2026-09-16", "taller"));
    for (const start of ["15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00"]) {
      expect(stateOf(day, start)).toBe("late");
    }
    expect(stateOf(day, "18:30")).toBe("free");
  });

  it("respeta el horizonte de 30 días", () => {
    expect(computeDay(dayInput("2026-10-16", "taller")).status).toBe("open");
    expect(computeDay(dayInput("2026-10-17", "taller")).status).toBe("closed");
  });

  it("cierra el día al llegar al tope diario", () => {
    const day = computeDay(dayInput("2026-09-17", "taller", { usedCount: 4 }));
    expect(day.status).toBe("full");
    expect(day.blocks).toEqual([]);
  });

  it("en retiro necesita dos bloques seguidos", () => {
    expect(stateOf(computeDay(dayInput("2026-09-17", "retiro")), "19:30")).toBe("noroom");

    const withTaken = computeDay(
      dayInput("2026-09-17", "retiro", { activeBlockStarts: ["16:30"] }),
    );
    expect(stateOf(withTaken, "16:00")).toBe("noroom");
    expect(stateOf(withTaken, "16:30")).toBe("taken");

    expect(stateOf(computeDay(dayInput("2026-09-17", "taller")), "19:30")).toBe("free");
  });

  it("aplica los bloqueos de día completo y por rango", () => {
    const wholeDay = computeDay(
      dayInput("2026-09-17", "taller", { blocked: [{ startTime: null, endTime: null }] }),
    );
    expect(wholeDay.status).toBe("blocked");
    expect(wholeDay.blocks).toEqual([]);

    const range = computeDay(
      dayInput("2026-09-17", "taller", { blocked: [{ startTime: "16:00", endTime: "17:00" }] }),
    );
    expect(stateOf(range, "16:00")).toBe("taken");
    expect(stateOf(range, "16:30")).toBe("taken");
    expect(stateOf(range, "17:00")).toBe("free");
  });
});

describe("checkStart", () => {
  it("reserva retiro ocupando dos bloques de media hora", () => {
    const result = checkStart({ ...dayInput("2026-09-17", "retiro"), start: "16:00" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`esperaba ok: ${result.reason}`);
    }
    expect(result.blockStarts).toEqual(["16:00", "16:30"]);
    expect(result.endsAt.getTime() - result.startsAt.getTime()).toBe(3_600_000);
  });

  it("rechaza un inicio fuera de la grilla", () => {
    const result = checkStart({ ...dayInput("2026-09-17", "retiro"), start: "16:15" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("esperaba invalid_start");
    }
    expect(result.reason).toBe("invalid_start");
  });
});

describe("feriados", () => {
  it("avisa del año que falta dentro del horizonte", () => {
    expect(missingHolidayYears("2027-12-10", 30)).toEqual(["2028"]);
    expect(missingHolidayYears("2026-12-10", 30)).toEqual([]);
    expect(missingHolidayYears("2026-09-16", 30)).toEqual([]);
  });
});
