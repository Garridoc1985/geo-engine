import { describe, expect, it } from "vitest";
import {
  type ApiDay,
  type State,
  bookingReducer,
  firstErrorTarget,
  formErrorsFrom,
  formatClp,
  initialState,
  phoneE164,
  selectedBlocks,
  ticketCode,
  validateForm,
} from "../../src/components/islands/booking-state.ts";

function day(date: string, overrides: Partial<ApiDay> = {}): ApiDay {
  return {
    date,
    status: "open",
    holidayName: null,
    used: 1,
    blocks: [
      { start: "15:00", state: "late" },
      { start: "16:00", state: "free" },
      { start: "16:30", state: "free" },
      { start: "17:00", state: "taken" },
    ],
    ...overrides,
  };
}

function ready(days: ApiDay[]): State {
  return {
    ...initialState,
    availability: { status: "ready", days, capacity: 4 },
  };
}

describe("bookingReducer", () => {
  it("limpia el bloque al cambiar de modalidad", () => {
    const state: State = {
      ...ready([day("2026-09-16")]),
      selectedDate: "2026-09-16",
      selectedStart: "16:00",
    };
    expect(bookingReducer(state, { type: "setMode", mode: "retiro" })).toMatchObject({
      mode: "retiro",
      selectedStart: null,
    });
  });

  it("ignora un día que no está abierto", () => {
    const state = ready([
      day("2026-09-18", { status: "holiday", holidayName: "Independencia Nacional", blocks: [] }),
    ]);
    expect(bookingReducer(state, { type: "selectDate", date: "2026-09-18" })).toBe(state);
  });

  it("solo acepta bloques libres", () => {
    const state: State = { ...ready([day("2026-09-16")]), selectedDate: "2026-09-16" };
    expect(bookingReducer(state, { type: "selectStart", start: "17:00" })).toBe(state);
    expect(bookingReducer(state, { type: "selectStart", start: "16:00" }).selectedStart).toBe(
      "16:00",
    );
  });

  it("en retiro ocupa el bloque elegido y el siguiente", () => {
    const state: State = {
      ...ready([day("2026-09-16")]),
      mode: "retiro",
      selectedDate: "2026-09-16",
      selectedStart: "16:00",
    };
    expect(selectedBlocks(state)).toEqual(["16:00", "16:30"]);
  });

  it("valida comuna y consentimiento en retiro", () => {
    const state: State = { ...initialState, mode: "retiro" };
    const errors = validateForm(state);
    expect(errors.comuna).toBe("Elige Vitacura o Las Condes.");
    expect(errors.consentimiento).toBe("Acepta el aviso de privacidad para confirmar.");
  });

  it("mantiene WhatsApp desmarcado por defecto y no lo exige para reservar", () => {
    const state: State = {
      ...initialState,
      availability: { status: "ready", days: [day("2026-09-16")], capacity: 4 },
      selectedDate: "2026-09-16",
      selectedStart: "16:00",
      form: {
        ...initialState.form,
        nombre: "Javiera Rojas",
        telefono: "1234 5678",
        correo: "javiera@ejemplo.cl",
        bicicleta: "Ruta Specialized",
        descripcion: "Ajustar cambios y frenos",
        consentimiento: true,
      },
    };
    expect(state.form.whatsappConsent).toBe(false);
    expect(validateForm(state)).not.toHaveProperty("whatsappConsent");
    expect(validateForm(state)).not.toHaveProperty("consentimiento");
  });

  it("libera el bloque y muestra el mensaje del servidor tras un 409", () => {
    const state: State = {
      ...ready([day("2026-09-16")]),
      selectedDate: "2026-09-16",
      selectedStart: "16:00",
    };
    const next = bookingReducer(state, {
      type: "submitFailed",
      status: 409,
      body: { error: "El bloque ya no está disponible", code: "slot_unavailable" },
    });
    expect(next.selectedStart).toBeNull();
    expect(next.submit.message).toBe("El bloque ya no está disponible");
    expect(next.turnstileToken).toBeNull();
  });

  it("arma el código de la orden y el recargo", () => {
    expect(ticketCode("2026-09-16", "16:30")).toBe("VB-260916-1630");
    expect(formatClp(15000)).toBe("$15.000");
  });
});

describe("teléfono con prefijo +56 9", () => {
  const typed = (value: string) =>
    bookingReducer(initialState, { type: "setField", field: "telefono", value }).form.telefono;

  it.each(["+56912345678", "56912345678", "912345678", "12345678"])(
    "normaliza %s pegado a los 8 dígitos finales",
    (pasted) => {
      expect(typed(pasted)).toBe("1234 5678");
      expect(phoneE164(typed(pasted))).toBe("+56912345678");
    },
  );

  it("formatea mientras se escribe y descarta lo que no es dígito", () => {
    expect(typed("123")).toBe("123");
    expect(typed("12345")).toBe("1234 5");
    expect(typed("12a3-4 56")).toBe("1234 56");
  });

  it("7 dígitos siguen siendo inválidos", () => {
    const state: State = {
      ...initialState,
      form: { ...initialState.form, telefono: typed("1234567") },
    };
    expect(phoneE164(state.form.telefono)).toBeNull();
    expect(validateForm(state).telefono).toBe("Faltan dígitos: son 8 después del +56 9.");
  });
});

describe("mensajes de error del envío", () => {
  it.each([
    [429, "Demasiados intentos desde tu conexión. Vuelve a intentar en 10 minutos."],
    [403, "No pudimos verificar que eres una persona. Vuelve a intentar."],
    [409, "Ya tienes una reserva próxima con este teléfono."],
    [422, "Revisa los datos del formulario."],
  ])("muestra el mensaje del servidor en un %i", (status, error) => {
    const next = bookingReducer(initialState, {
      type: "submitFailed",
      status,
      body: { error, fields: status === 422 ? { correo: "Escribe un correo válido." } : undefined },
    });
    expect(next.submit.message).toBe(error);
  });

  it("en un 422 conserva los errores por campo", () => {
    const next = bookingReducer(initialState, {
      type: "submitFailed",
      status: 422,
      body: { error: "Revisa los datos del formulario.", fields: { correo: "Escribe un correo." } },
    });
    expect(next.errors.correo).toBe("Escribe un correo.");
  });

  it("un 422 del servidor sin texto general deja el mensaje de revisar campos", () => {
    const next = bookingReducer(initialState, {
      type: "submitFailed",
      status: 422,
      body: { fields: { nombre: "Escribe tu nombre." } },
    });
    expect(next.submit.message).toBe("Revisa los campos marcados y vuelve a intentar.");
  });

  it("usa un respaldo si la respuesta no trae mensaje", () => {
    const next = bookingReducer(initialState, { type: "submitFailed", status: 429, body: {} });
    expect(next.submit.message).toBe(
      "Demasiados intentos. Espera unos minutos e intenta de nuevo.",
    );
  });
});

describe("validación fallida", () => {
  const failLocally = (state: State) =>
    bookingReducer(state, {
      type: "submitFailed",
      status: 422,
      body: { fields: validateForm(state) as Record<string, string> },
    });

  const withBlock: State = {
    ...ready([day("2026-09-16")]),
    selectedDate: "2026-09-16",
    selectedStart: "16:00",
  };

  it("la validación local deja un mensaje general, no null", () => {
    const next = failLocally(withBlock);
    expect(next.submit.message).toBe("Revisa los campos marcados y vuelve a intentar.");
    expect(next.errors.nombre).toBe("Escribe tu nombre.");
  });

  it("sin bloque elegido, el mensaje general es el del bloque", () => {
    const next = failLocally(initialState);
    expect(next.submit.message).toBe("Elige un bloque libre para continuar.");
    expect(next.errors.bloque).toBe("Elige un bloque libre para continuar.");
  });

  it("elige el bloque antes que cualquier campo", () => {
    expect(firstErrorTarget(validateForm(initialState))).toBe("bloque");
  });

  it("elige el primer campo en el orden de la pantalla", () => {
    expect(firstErrorTarget({ correo: "x", telefono: "x", consentimiento: "x" })).toBe("telefono");
    expect(firstErrorTarget({ direccion: "x", comuna: "x" })).toBe("comuna");
    expect(firstErrorTarget(validateForm(withBlock))).toBe("nombre");
    expect(firstErrorTarget({})).toBeNull();
  });

  it("un 422 del servidor sobre service_date o start marca el bloque", () => {
    expect(formErrorsFrom({ start: "Elige un bloque.", correo: "x" })).toEqual({
      bloque: "Elige un bloque.",
      correo: "x",
    });
    const next = bookingReducer(initialState, {
      type: "submitFailed",
      status: 422,
      body: {
        error: "Revisa los datos del formulario.",
        fields: { service_date: "Elige un día." },
      },
    });
    expect(next.errors.bloque).toBe("Elige un día.");
    expect(firstErrorTarget(next.errors)).toBe("bloque");
  });
});
