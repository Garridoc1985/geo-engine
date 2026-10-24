import { DateTime } from "luxon";
import { HOLIDAYS } from "./holidays.ts";
import {
  BLOCK_MINUTES,
  type BookingMode,
  BLOCKS_PER_MODE,
  DAILY_CAPACITY,
  HORIZON_DAYS,
  hoursFor,
  MIN_NOTICE_MINUTES,
  TIMEZONE,
} from "./rules.ts";

export type DayStatus = "open" | "closed" | "holiday" | "full" | "blocked";
export type BlockState = "free" | "taken" | "late" | "noroom";

export type DayInput = {
  date: string;
  mode: BookingMode;
  now: Date;
  activeBlockStarts: string[];
  blocked: { startTime: string | null; endTime: string | null }[];
  usedCount: number;
};

export type DayAvailability = {
  date: string;
  status: DayStatus;
  holidayName: string | null;
  used: number;
  blocks: { start: string; state: BlockState }[];
};

export type CheckStartResult =
  | { ok: true; blockStarts: string[]; startsAt: Date; endsAt: Date }
  | {
      ok: false;
      reason:
        | "closed"
        | "holiday"
        | "blocked"
        | "full"
        | "invalid_start"
        | "late"
        | "taken"
        | "noroom";
    };

function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function hhmmOf(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Fecha local `YYYY-MM-DD` del instante dado. */
export function localToday(now: Date): string {
  return DateTime.fromJSDate(now).setZone(TIMEZONE).toFormat("yyyy-MM-dd");
}

/** Suma días sobre la fecha local, nunca sobre el instante. */
export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: TIMEZONE }).plus({ days }).toFormat("yyyy-MM-dd");
}

/** Instante de una hora local, o `null` si esa hora no existe (cambio de horario). */
export function localToInstant(date: string, hhmm: string): Date | null {
  const local = DateTime.fromISO(`${date}T${hhmm}`, { zone: TIMEZONE });
  if (!local.isValid || local.toFormat("HH:mm") !== hhmm) {
    return null;
  }
  return local.toJSDate();
}

/** Inicios de bloque del día, cada 30 min, mientras el bloque termine antes del cierre. */
export function gridForDate(date: string, mode: BookingMode = "taller"): string[] {
  const local = DateTime.fromISO(date, { zone: TIMEZONE });
  if (!local.isValid) {
    return [];
  }
  const hours = hoursFor(mode, local.weekday);
  if (!hours) {
    return [];
  }
  const close = minutesOf(hours.close);
  const starts: string[] = [];
  for (let start = minutesOf(hours.open); start + BLOCK_MINUTES <= close; start += BLOCK_MINUTES) {
    const hhmm = hhmmOf(start);
    if (localToInstant(date, hhmm) !== null) {
      starts.push(hhmm);
    }
  }
  return starts;
}

function isTaken(input: DayInput, start: string): boolean {
  if (input.activeBlockStarts.includes(start)) {
    return true;
  }
  return input.blocked.some(
    (period) =>
      period.startTime !== null &&
      period.endTime !== null &&
      start >= period.startTime &&
      start < period.endTime,
  );
}

function isLate(date: string, start: string, now: Date): boolean {
  const instant = localToInstant(date, start);
  return instant !== null && instant.getTime() < now.getTime() + MIN_NOTICE_MINUTES * 60_000;
}

function stateFor(input: DayInput, grid: string[], index: number, start: string): BlockState {
  if (isTaken(input, start)) {
    return "taken";
  }
  if (isLate(input.date, start, input.now)) {
    return "late";
  }
  if (input.mode === "retiro") {
    const next = grid[index + 1];
    if (next === undefined || isTaken(input, next)) {
      return "noroom";
    }
  }
  return "free";
}

export type DayClosure = { status: "closed" | "holiday" | "blocked"; holidayName: string | null };

/** Por qué el día no recibe bicis según calendario (sin horario, feriado o bloqueo de día completo), o `null`. */
export function calendarClosure(
  date: string,
  blocked: DayInput["blocked"],
  mode: BookingMode = "taller",
): DayClosure | null {
  if (gridForDate(date, mode).length === 0) {
    return { status: "closed", holidayName: null };
  }
  const holidayName = HOLIDAYS.get(date);
  if (holidayName !== undefined) {
    return { status: "holiday", holidayName };
  }
  if (blocked.some((period) => period.startTime === null && period.endTime === null)) {
    return { status: "blocked", holidayName: null };
  }
  return null;
}

/** Disponibilidad consultiva de un día. `createBooking` revalida todo dentro de la transacción. */
export function computeDay(input: DayInput): DayAvailability {
  const closed = (status: DayStatus, holidayName: string | null = null): DayAvailability => ({
    date: input.date,
    status,
    holidayName,
    used: input.usedCount,
    blocks: [],
  });

  if (input.date > addDays(localToday(input.now), HORIZON_DAYS)) {
    return closed("closed");
  }
  const closure = calendarClosure(input.date, input.blocked, input.mode);
  if (closure !== null) {
    return closed(closure.status, closure.holidayName);
  }
  const grid = gridForDate(input.date, input.mode);
  if (input.usedCount >= DAILY_CAPACITY) {
    return closed("full");
  }
  return {
    date: input.date,
    status: "open",
    holidayName: null,
    used: input.usedCount,
    blocks: grid.map((start, index) => ({ start, state: stateFor(input, grid, index, start) })),
  };
}

/** Valida un inicio concreto y devuelve los bloques que ocuparía. */
export function checkStart(input: DayInput & { start: string }): CheckStartResult {
  const day = computeDay(input);
  if (day.status !== "open") {
    return { ok: false, reason: day.status };
  }
  const grid = gridForDate(input.date, input.mode);
  const index = grid.indexOf(input.start);
  const block = day.blocks[index];
  if (index < 0 || block === undefined) {
    return { ok: false, reason: "invalid_start" };
  }
  if (block.state !== "free") {
    return { ok: false, reason: block.state };
  }
  const startsAt = localToInstant(input.date, input.start);
  if (startsAt === null) {
    return { ok: false, reason: "invalid_start" };
  }
  const count = BLOCKS_PER_MODE[input.mode];
  const blockStarts = grid.slice(index, index + count);
  return {
    ok: true,
    blockStarts,
    startsAt,
    endsAt: new Date(startsAt.getTime() + count * BLOCK_MINUTES * 60_000),
  };
}
