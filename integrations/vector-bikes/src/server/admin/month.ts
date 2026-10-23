import { DateTime } from "luxon";
import { z } from "zod";
import { readRange } from "../booking/availability.ts";
import { DAILY_CAPACITY, HORIZON_DAYS, TIMEZONE } from "../booking/rules.ts";
import { addDays, calendarClosure, localToday } from "../booking/slots.ts";
import type { AppDb } from "../db/client.ts";

export type MonthDayState = "free" | "booked" | "full" | "blocked" | "holiday" | "closed";

export type MonthDay = {
  date: string;
  day: number;
  state: MonthDayState;
  holidayName: string | null;
  used: number;
  /** `past` antes de hoy, `horizon` más allá del horizonte de reservas. */
  outside: "past" | "horizon" | null;
  isToday: boolean;
  label: string;
};

export type MonthView = {
  month: string;
  title: string;
  prev: string;
  next: string;
  /** Celdas vacías antes del día 1 (semana de lunes a domingo). */
  offset: number;
  capacity: number;
  days: MonthDay[];
};

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** `YYYY-MM` válido o `null`. */
export function parseMonth(value: string | null | undefined): string | null {
  return monthSchema.safeParse(value).success ? String(value) : null;
}

function stateOf(closure: ReturnType<typeof calendarClosure>, used: number): MonthDayState {
  if (closure !== null) {
    return closure.status;
  }
  if (used >= DAILY_CAPACITY) {
    return "full";
  }
  return used > 0 ? "booked" : "free";
}

const STATE_TEXT: Record<MonthDayState, string> = {
  free: "libre",
  booked: "",
  full: "completo",
  blocked: "bloqueado por el taller",
  holiday: "feriado",
  closed: "cerrado",
};

/** "Lunes 28 de septiembre, 2 de 4 reservas", con el estado y si está fuera de plazo. */
function labelOf(day: Omit<MonthDay, "label">): string {
  const local = DateTime.fromISO(day.date, { zone: TIMEZONE }).setLocale("es");
  const name = local.toFormat("cccc d 'de' LLLL");
  const parts = [name.charAt(0).toUpperCase() + name.slice(1)];
  if (day.isToday) {
    parts.push("hoy");
  }
  const state = STATE_TEXT[day.state];
  parts.push(day.state === "holiday" ? `${state}: ${day.holidayName}` : state);
  const open = day.state === "free" || day.state === "booked" || day.state === "full";
  if (open || day.used > 0) {
    parts.push(`${day.used} de ${DAILY_CAPACITY} reservas`);
  }
  if (day.outside === "past") {
    parts.push("pasado");
  } else if (day.outside === "horizon") {
    parts.push("fuera del horizonte de reservas");
  }
  return parts.filter((part) => part !== "").join(", ");
}

/** Estado de cada día del mes, con una sola lectura del rango completo. */
export async function monthOverview(db: AppDb, month: string, now: Date): Promise<MonthView> {
  const first = DateTime.fromISO(`${month}-01`, { zone: TIMEZONE }).setLocale("es");
  const count = first.daysInMonth ?? 0;
  const dates = Array.from({ length: count }, (_, index) =>
    first.plus({ days: index }).toFormat("yyyy-MM-dd"),
  );
  const dayData = await readRange(db, `${month}-01`, dates.at(-1) ?? `${month}-01`);
  const today = localToday(now);
  const horizon = addDays(today, HORIZON_DAYS);

  const days = dates.map((date, index) => {
    const data = dayData(date);
    const closure = calendarClosure(date, data.blocked);
    const day: Omit<MonthDay, "label"> = {
      date,
      day: index + 1,
      state: stateOf(closure, data.usedCount),
      holidayName: closure?.holidayName ?? null,
      used: data.usedCount,
      outside: date < today ? "past" : date > horizon ? "horizon" : null,
      isToday: date === today,
    };
    return { ...day, label: labelOf(day) };
  });

  const title = first.toFormat("LLLL yyyy");
  return {
    month,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    prev: first.minus({ months: 1 }).toFormat("yyyy-MM"),
    next: first.plus({ months: 1 }).toFormat("yyyy-MM"),
    offset: first.weekday - 1,
    capacity: DAILY_CAPACITY,
    days,
  };
}
