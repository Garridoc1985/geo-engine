import { type State, formatClp, ticketCode, timeRange } from "./booking-state.ts";
import { PICKUP_FEE_CLP } from "./booking-state.ts";

export function BookingTicket({
  state,
  chosen,
  isPickup,
}: {
  state: State;
  chosen: string[];
  isPickup: boolean;
}) {
  const done = state.submit.status === "success" && state.result !== null;
  return (
    <aside class="ticket" aria-live="polite">
      <div class="ticket-head">
        <span class="label">Orden de reserva</span>
        <span class="mono" style="font-size:.8rem">
          {state.selectedDate && state.selectedStart
            ? ticketCode(state.selectedDate, state.selectedStart)
            : "VB-——"}
        </span>
      </div>
      <dl class="ticket-body">
        <div class="row">
          <dt>Modalidad</dt>
          <dd>{isPickup ? "Retiro y devolución" : "La dejo en el taller"}</dd>
        </div>
        <div class="row">
          <dt>Día</dt>
          <dd>{state.selectedDate ?? "—"}</dd>
        </div>
        <div class="row">
          <dt>Hora</dt>
          <dd class="mono">{timeRange(chosen) ?? "Elige un bloque"}</dd>
        </div>
        <div class="row">
          <dt>Pago</dt>
          <dd>Efectivo, transferencia o tarjeta, al recibir tu bici</dd>
        </div>
      </dl>
      <div class="ticket-total">
        <span class="label">Recargo</span>
        <strong>{formatClp(isPickup ? PICKUP_FEE_CLP : 0)}</strong>
      </div>
      {!done && (
        <div class="ticket-foot">
          {state.submit.message && (
            <p class="err" role="alert">
              {state.submit.message}
            </p>
          )}
          <button
            type="submit"
            class="btn"
            id="submit"
            disabled={state.submit.status === "submitting"}
          >
            {state.submit.status === "submitting" ? "Confirmando…" : "Confirmar reserva"}
          </button>
          <p>
            El diagnóstico y los repuestos se cotizan en el taller. Si hay un trabajo extra, te
            llamamos antes.
          </p>
        </div>
      )}
      {done && state.result && (
        <div class="done">
          <span class="label">Reserva confirmada</span>
          <strong>{state.result.code}</strong>
          <p>Te enviamos la confirmación a {state.form.correo}.</p>
          <p>Si necesitas cancelar, usa el enlace del correo.</p>
        </div>
      )}
    </aside>
  );
}
