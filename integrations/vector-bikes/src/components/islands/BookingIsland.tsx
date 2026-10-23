import { useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import { BookingFields, FIELD_IDS } from "./BookingFields.tsx";
import { BLOCK_FIELDSET_ID, BlockFieldset, DayFieldset, ModeFieldset } from "./BookingSchedule.tsx";
import { BookingTicket } from "./BookingTicket.tsx";
import { useTurnstile } from "./turnstile.ts";
import {
  type ApiDay,
  type BookingResult,
  type FormErrors,
  type Mode,
  bookingReducer,
  firstErrorTarget,
  formErrorsFrom,
  initialState,
  parseResponseBody,
  phoneE164,
  selectedBlocks,
  validateForm,
} from "./booking-state.ts";

const TIMEZONE = "America/Santiago";

function todayInSantiago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
}

export default function BookingIsland({ siteKey }: { siteKey: string }) {
  const [state, dispatch] = useReducer(bookingReducer, initialState);
  const today = useMemo(todayInSantiago, []);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const turnstile = useTurnstile(siteKey, turnstileRef, (token) =>
    dispatch({ type: "setTurnstile", token }),
  );

  const days = state.availability.status === "ready" ? state.availability.days : [];
  const day = days.find((item) => item.date === state.selectedDate);
  const chosen = selectedBlocks(state);
  const isPickup = state.mode === "retiro";

  async function loadAvailability(mode: Mode): Promise<void> {
    dispatch({ type: "loadStart" });
    try {
      const response = await fetch(
        `/api/disponibilidad?desde=${todayInSantiago()}&dias=14&modo=${mode}`,
      );
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const payload = (await response.json()) as { days: ApiDay[]; capacity: number };
      dispatch({ type: "loadSuccess", days: payload.days, capacity: payload.capacity });
    } catch {
      dispatch({ type: "loadError" });
    }
  }

  useEffect(() => {
    void loadAvailability(state.mode);
  }, [state.mode]);

  /** Foco y desplazamiento al primer error; el bloque lleva a la regla de horarios. */
  function revealFirstError(errors: FormErrors): void {
    const target = firstErrorTarget(errors);
    const form = formRef.current;
    if (target === null || form === null) {
      return;
    }
    let focusOn: HTMLElement | null;
    let scrollTo: HTMLElement | null;
    if (target === "bloque") {
      const fieldset = form.querySelector<HTMLElement>(`#${BLOCK_FIELDSET_ID}`);
      scrollTo = fieldset?.querySelector<HTMLElement>(".ruler-box") ?? fieldset;
      focusOn =
        fieldset?.querySelector<HTMLElement>('.slot:not([aria-disabled="true"])') ?? fieldset;
    } else {
      focusOn = form.querySelector<HTMLElement>(`#${FIELD_IDS[target]}`);
      scrollTo = focusOn;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    focusOn?.focus({ preventScroll: true });
    scrollTo?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }

  function requestBody(turnstileToken: string): string {
    return JSON.stringify({
      mode: state.mode,
      service_date: state.selectedDate,
      start: state.selectedStart,
      nombre: state.form.nombre.trim(),
      telefono: phoneE164(state.form.telefono) ?? state.form.telefono,
      correo: state.form.correo.trim(),
      bicicleta: state.form.bicicleta.trim(),
      descripcion: state.form.descripcion.trim(),
      ...(isPickup ? { comuna: state.form.comuna, direccion: state.form.direccion.trim() } : {}),
      consentimiento: state.form.consentimiento,
      whatsapp_consentimiento: state.form.whatsappConsent,
      turnstile_token: turnstileToken,
    });
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const errors = validateForm(state);
    if (Object.keys(errors).length > 0) {
      dispatch({
        type: "submitFailed",
        status: 422,
        body: { fields: errors as Record<string, string> },
      });
      revealFirstError(errors);
      return;
    }
    // Sin widget o sin token no se envía: el servidor respondería 403 de todos modos.
    const token = state.turnstileToken ?? turnstile.token();
    if (turnstile.enabled && token === null) {
      dispatch({ type: "turnstileUnavailable" });
      return;
    }
    dispatch({ type: "submitStart" });
    try {
      const response = await fetch("/api/reservas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(token ?? ""),
      });
      // Se lee como texto: si el cuerpo no es JSON (HTML de un proxy), el estado HTTP sigue
      // eligiendo el mensaje en vez de caer al error de red.
      const body = parseResponseBody(await response.text());
      if (response.status === 201 && body.code) {
        dispatch({ type: "submitSuccess", result: body as BookingResult });
        return;
      }
      dispatch({ type: "submitFailed", status: response.status, body });
      turnstile.reset();
      if (response.status === 422) {
        revealFirstError(formErrorsFrom(body.fields ?? {}));
      }
      if (response.status === 409) {
        void loadAvailability(state.mode);
      }
    } catch {
      dispatch({ type: "submitFailed", status: 0, body: {} });
      turnstile.reset();
    }
  }

  return (
    <form class="booking" id="booking" novalidate ref={formRef} onSubmit={submit}>
      <div class="stage">
        <ModeFieldset mode={state.mode} onMode={(mode) => dispatch({ type: "setMode", mode })} />
        <DayFieldset
          availability={state.availability}
          days={days}
          selectedDate={state.selectedDate}
          today={today}
          onPick={(date) => dispatch({ type: "selectDate", date })}
          onRetry={() => void loadAvailability(state.mode)}
        />
        <BlockFieldset
          day={day}
          chosen={chosen}
          isPickup={isPickup}
          error={state.errors.bloque}
          onPick={(start) => dispatch({ type: "selectStart", start })}
        />
        <BookingFields
          form={state.form}
          errors={state.errors}
          isPickup={isPickup}
          turnstileRef={turnstileRef}
          onField={(field, value) => dispatch({ type: "setField", field, value })}
        />
      </div>
      <BookingTicket state={state} chosen={chosen} isPickup={isPickup} />
    </form>
  );
}
