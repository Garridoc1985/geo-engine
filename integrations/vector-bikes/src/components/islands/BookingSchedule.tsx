import type { ApiDay, Mode, State } from "./booking-state.ts";
import { timeRange } from "./booking-state.ts";

const CAPACITY = 4;
const TIMEZONE_LABEL = "es-CL";

function partsOf(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(TIMEZONE_LABEL, { timeZone: "UTC", ...options }).format(
    new Date(`${date}T12:00:00.000Z`),
  );
}

function dayCaption(day: ApiDay): string {
  if (day.status === "holiday") return "Feriado";
  if (day.status === "closed") return "Cerrado";
  if (day.status === "full") return "Completo";
  if (day.status === "blocked") return "Bloqueado";
  return `${day.used}/${CAPACITY} bicis`;
}

function blockLabel(state: ApiDay["blocks"][number]["state"], start: string): string {
  if (state === "taken") return `${start}, reservado`;
  if (state === "late") return `${start}, fuera de plazo`;
  return start;
}

export function ModeFieldset({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  return (
    <fieldset>
      <legend>
        <span class="mono">1</span> Cómo nos entregas la bici
      </legend>
      <div class="modes">
        <button
          type="button"
          class="mode"
          id="mode-taller"
          aria-pressed={mode === "taller"}
          onClick={() => onMode("taller")}
        >
          <span class="t">La dejo en el taller</span>
          <span class="d">Av. Kennedy 7666, Vitacura</span>
          <span class="p">Sin recargo · usa 1 bloque</span>
        </button>
        <button
          type="button"
          class="mode"
          id="mode-retiro"
          aria-pressed={mode === "retiro"}
          onClick={() => onMode("retiro")}
        >
          <span class="t">Retiro y devolución</span>
          <span class="d">Vitacura y Las Condes</span>
          <span class="p">$15.000 · usa 2 bloques (1 hora)</span>
        </button>
      </div>
    </fieldset>
  );
}

function DayChips({
  days,
  selectedDate,
  today,
  onPick,
}: {
  days: ApiDay[];
  selectedDate: string | null;
  today: string;
  onPick: (date: string) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: marcado del prototipo
    <div class="days" role="group" aria-label="Días disponibles">
      {days.map((day) => (
        <button
          key={day.date}
          type="button"
          class="day"
          disabled={day.status !== "open"}
          aria-pressed={day.date === selectedDate}
          onClick={() => onPick(day.date)}
        >
          <span class="dw">{partsOf(day.date, { weekday: "short" })}</span>
          <span class="dn">
            {day.date === today ? "Hoy" : partsOf(day.date, { day: "2-digit", month: "short" })}
          </span>
          <span class="dc">{dayCaption(day)}</span>
        </button>
      ))}
    </div>
  );
}

export function DayFieldset({
  availability,
  days,
  selectedDate,
  today,
  onPick,
  onRetry,
}: {
  availability: State["availability"];
  days: ApiDay[];
  selectedDate: string | null;
  today: string;
  onPick: (date: string) => void;
  onRetry: () => void;
}) {
  const empty = availability.status === "ready" && days.every((day) => day.status !== "open");
  return (
    <fieldset aria-busy={availability.status === "loading"}>
      <legend>
        <span class="mono">2</span> Día
      </legend>
      {availability.status === "loading" && <p class="ruler-note">Cargando disponibilidad…</p>}
      {availability.status === "error" && (
        <p class="ruler-note">
          No pudimos cargar la disponibilidad.{" "}
          <button type="button" class="btn ghost" onClick={onRetry}>
            Reintentar
          </button>
        </p>
      )}
      {empty && (
        <p class="ruler-note">
          No hay días disponibles en las próximas dos semanas. Escríbenos a info@vectorbikes.cl.
        </p>
      )}
      {days.length > 0 && (
        <DayChips days={days} selectedDate={selectedDate} today={today} onPick={onPick} />
      )}
    </fieldset>
  );
}

function rulerSlots(day: ApiDay, chosen: string[], onPick: (start: string) => void) {
  const buttons = [];
  let skipNext = false;
  for (const [index, block] of day.blocks.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const selected = chosen.includes(block.start);
    const next = day.blocks[index + 1];
    const range =
      selected && next && chosen.includes(next.start) ? timeRange([block.start, next.start]) : null;
    skipNext = range !== null;
    const disabled = !selected && block.state !== "free";
    const classes = ["slot", selected ? "sel" : block.state === "free" ? "" : block.state]
      .filter(Boolean)
      .join(" ");
    buttons.push(
      <button
        key={block.start}
        type="button"
        class={classes}
        style={range ? "grid-column:span 2" : undefined}
        aria-disabled={disabled}
        aria-pressed={selected}
        aria-label={
          range
            ? `Retiro de ${range.replace(" – ", " a ")}, 1 hora, seleccionado`
            : blockLabel(block.state, block.start)
        }
        onClick={() => onPick(block.start)}
      >
        {range ?? (block.state === "taken" ? "—" : block.start)}
      </button>,
    );
  }
  return buttons;
}

function Ruler({
  day,
  chosen,
  onPick,
}: {
  day: ApiDay;
  chosen: string[];
  onPick: (start: string) => void;
}) {
  const columns = `repeat(${day.blocks.length},minmax(0,1fr))`;
  // `global.css` fija la regla en 560px, que con los 10 bloques del taller deja celdas de 56px.
  // El retiro de lunes a viernes tiene 22, así que la regla crece y `.ruler-box` la desplaza:
  // misma celda, mismo diseño, se corre para ver la mañana.
  const width = `${Math.max(560, day.blocks.length * 56)}px`;
  return (
    <div class="ruler-box">
      <div class="ruler" style={`min-width:${width}`}>
        <div class="ruler-ticks" style={`grid-template-columns:${columns}`}>
          {day.blocks.map((block) => (
            <div key={block.start} class={block.start.endsWith(":00") ? "hr" : ""}>
              {block.start.endsWith(":00") && <span>{block.start}</span>}
            </div>
          ))}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: marcado del prototipo */}
        <div
          class="slots"
          role="group"
          aria-label="Bloques del día"
          style={`grid-template-columns:${columns}`}
        >
          {rulerSlots(day, chosen, onPick)}
        </div>
      </div>
    </div>
  );
}

export const BLOCK_FIELDSET_ID = "f-bloque";

function blockNote(day: ApiDay | undefined, isPickup: boolean): string {
  if (!day) {
    return "Elige un día para ver sus bloques.";
  }
  if (day.blocks.every((block) => block.state !== "free")) {
    return "No quedan bloques para este día. Prueba otro día.";
  }
  const left = `Quedan ${CAPACITY - day.used} de ${CAPACITY} cupos este día.`;
  return isPickup ? `${left} El retiro usa el bloque que elijas y el siguiente.` : left;
}

export function BlockFieldset({
  day,
  chosen,
  isPickup,
  error,
  onPick,
}: {
  day: ApiDay | undefined;
  chosen: string[];
  isPickup: boolean;
  error?: string;
  onPick: (start: string) => void;
}) {
  return (
    <fieldset id={BLOCK_FIELDSET_ID} tabIndex={-1}>
      <legend>
        <span class="mono">3</span> Bloque
      </legend>
      {day && <Ruler day={day} chosen={chosen} onPick={onPick} />}
      <div class="legend">
        <span>
          <i class="l-free"></i>Libre
        </span>
        <span>
          <i class="l-taken"></i>Reservado
        </span>
        <span>
          <i class="l-sel"></i>Tu reserva
        </span>
      </div>
      <p class="ruler-note">{blockNote(day, isPickup)}</p>
      {error && <span class="err">{error}</span>}
    </fieldset>
  );
}
