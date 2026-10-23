import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it } from "vitest";
import MonthCalendar from "../../src/components/admin/MonthCalendar.astro";
import { agendaForDate, createBlock, parseDate } from "../../src/server/admin/agenda.ts";
import { type MonthView, monthOverview, parseMonth } from "../../src/server/admin/month.ts";
import { createBooking } from "../../src/server/booking/create-booking.ts";
import type { AppDb } from "../../src/server/db/client.ts";
import { type TestDb, createTestDb } from "../helpers/pglite.ts";

/** 2026-09-15 12:00 hora local: horizonte hasta el 2026-10-15. */
const NOW = new Date("2026-09-15T15:00:00.000Z");

async function book(db: AppDb, serviceDate: string, start: string, phone: string) {
  const result = await createBooking(
    db,
    {
      mode: "taller",
      serviceDate,
      start,
      customerName: "Camila Soto",
      phoneE164: phone,
      email: "camila@ejemplo.cl",
      bike: "Gravel Canyon",
      description: "Mantención general",
      comuna: null,
      address: null,
      ipHash: null,
    },
    NOW,
  );
  if (!result.ok) {
    throw new Error(`no se pudo crear la reserva: ${result.code}`);
  }
}

/** Envuelve la base y cuenta cada `select` que se le hace. */
function countingDb(db: AppDb): { db: AppDb; selects: () => number } {
  let selects = 0;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        if (property === "select") {
          selects += 1;
        }
        return value.apply(target, args);
      };
    },
  });
  return { db: proxy, selects: () => selects };
}

function dayOf(view: MonthView, date: string) {
  const day = view.days.find((item) => item.date === date);
  if (!day) {
    throw new Error(`sin ${date}`);
  }
  return day;
}

async function render(view: MonthView, selected: string): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(MonthCalendar, { props: { month: view, selected } });
}

function buttonFor(html: string, date: string): string {
  const match = html.match(new RegExp(`<button[^>]*value="${date}"[^>]*>`));
  return match?.[0] ?? "";
}

describe("vista de mes del panel", () => {
  let test: TestDb;

  beforeEach(async () => {
    test = await createTestDb();
    await book(test.db, "2026-09-16", "15:00", "+56911111111");
    await book(test.db, "2026-09-16", "16:00", "+56922222222");
    for (const [index, start] of ["15:00", "16:00", "17:00", "18:00"].entries()) {
      await book(test.db, "2026-09-17", start, `+5693333333${index}`);
    }
    await createBlock(test.db, {
      serviceDate: "2026-09-22",
      startTime: null,
      endTime: null,
      reason: "Vacaciones",
    });
    return () => test.close();
  });

  it("clasifica días libres, con reservas, completos, bloqueados, feriados y domingos", async () => {
    const view = await monthOverview(test.db, "2026-09", NOW);

    expect(view.title).toBe("Septiembre 2026");
    expect(view.days).toHaveLength(30);
    expect(view.offset).toBe(1);
    expect(dayOf(view, "2026-09-21")).toMatchObject({ state: "free", used: 0, outside: null });
    expect(dayOf(view, "2026-09-16")).toMatchObject({ state: "booked", used: 2 });
    expect(dayOf(view, "2026-09-17")).toMatchObject({ state: "full", used: 4 });
    expect(dayOf(view, "2026-09-22")).toMatchObject({ state: "blocked" });
    expect(dayOf(view, "2026-09-18")).toMatchObject({
      state: "holiday",
      holidayName: "Independencia Nacional",
    });
    expect(dayOf(view, "2026-09-20")).toMatchObject({ state: "closed" });
    expect(dayOf(view, "2026-09-14").outside).toBe("past");
    expect(dayOf(view, "2026-09-15")).toMatchObject({ isToday: true, outside: null });
  });

  it("describe cada día en su aria-label", async () => {
    const view = await monthOverview(test.db, "2026-09", NOW);

    expect(dayOf(view, "2026-09-16").label).toBe("Miércoles 16 de septiembre, 2 de 4 reservas");
    expect(dayOf(view, "2026-09-17").label).toBe(
      "Jueves 17 de septiembre, completo, 4 de 4 reservas",
    );
    expect(dayOf(view, "2026-09-21").label).toBe("Lunes 21 de septiembre, libre, 0 de 4 reservas");
    expect(dayOf(view, "2026-09-22").label).toBe(
      "Martes 22 de septiembre, bloqueado por el taller",
    );
    expect(dayOf(view, "2026-09-18").label).toBe(
      "Viernes 18 de septiembre, feriado: Independencia Nacional",
    );
    expect(dayOf(view, "2026-09-20").label).toBe("Domingo 20 de septiembre, cerrado");
    expect(dayOf(view, "2026-09-14").label).toContain(", pasado");
  });

  it("atenúa los días más allá del horizonte de reservas", async () => {
    const view = await monthOverview(test.db, "2026-10", NOW);

    expect(dayOf(view, "2026-10-15").outside).toBeNull();
    expect(dayOf(view, "2026-10-16").outside).toBe("horizon");
    expect(dayOf(view, "2026-10-16").label).toContain("fuera del horizonte de reservas");
    expect(dayOf(view, "2026-10-12").state).toBe("holiday");
    expect(view.prev).toBe("2026-09");
    expect(view.next).toBe("2026-11");
  });

  it("lee todo el mes con las mismas tres consultas, sin importar cuántos días tenga", async () => {
    const september = countingDb(test.db);
    const october = countingDb(test.db);

    await monthOverview(september.db, "2026-09", NOW);
    await monthOverview(october.db, "2026-10", NOW);

    expect(september.selects()).toBe(3);
    expect(october.selects()).toBe(3);
  });

  it("cada día es un botón que envía su fecha a la agenda y el elegido queda marcado", async () => {
    const view = await monthOverview(test.db, "2026-09", NOW);
    const before = await render(view, "2026-09-16");

    expect(before).toMatch(/<form[^>]*method="get"[^>]*action="\/admin"/);
    expect(before.match(/<button[^>]*name="fecha"/g)).toHaveLength(30);
    const target = buttonFor(before, "2026-09-17");
    expect(target).toContain('type="submit"');
    expect(target).toContain('aria-label="Jueves 17 de septiembre, completo, 4 de 4 reservas"');
    expect(buttonFor(before, "2026-09-16")).toContain('aria-current="date"');
    expect(target).not.toContain("aria-current");

    // El envío del formulario lleva a /admin?fecha=2026-09-17: la página parsea y carga ese día.
    const date = parseDate(
      new URL("/admin?fecha=2026-09-17", "https://x.cl").searchParams.get("fecha"),
    );
    expect(date).toBe("2026-09-17");
    expect(await agendaForDate(test.db, date ?? "")).toHaveLength(4);
    const after = await render(view, date ?? "");
    expect(buttonFor(after, "2026-09-17")).toContain('aria-current="date"');
    expect(after.match(/aria-current="date"/g)).toHaveLength(1);
  });

  it("muestra la ocupación en formato 2/4 y el estado en texto", async () => {
    const view = await monthOverview(test.db, "2026-09", NOW);
    const html = await render(view, "2026-09-16");

    expect(html).toContain(">2/4<");
    expect(html).toContain(">4/4<");
    expect(html).toContain("Completo");
    expect(html).toContain("Bloqueado");
    expect(html).toContain("Feriado");
    expect(html).toContain("Cerrado");
  });

  it("valida el parámetro de mes", () => {
    expect(parseMonth("2026-09")).toBe("2026-09");
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseMonth("sept")).toBeNull();
    expect(parseMonth(null)).toBeNull();
  });
});
