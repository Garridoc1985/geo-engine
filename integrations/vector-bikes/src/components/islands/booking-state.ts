export type Mode = "taller" | "retiro";

export type ApiDay = {
  date: string;
  status: "open" | "closed" | "holiday" | "full" | "blocked";
  holidayName: string | null;
  used: number;
  blocks: { start: string; state: "free" | "taken" | "late" | "noroom" }[];
};

export type FormValues = {
  nombre: string;
  telefono: string;
  correo: string;
  bicicleta: string;
  descripcion: string;
  comuna: string;
  direccion: string;
  consentimiento: boolean;
  whatsappConsent: boolean;
};

export type BookingResult = {
  code: string;
  service_date: string;
  start: string;
  end: string;
  mode: Mode;
  fee: number;
};

export type State = {
  mode: Mode;
  availability:
    | { status: "idle" | "loading" | "error" }
    | { status: "ready"; days: ApiDay[]; capacity: number };
  selectedDate: string | null;
  selectedStart: string | null;
  form: FormValues;
  errors: Partial<Record<keyof FormValues | "bloque", string>>;
  turnstileToken: string | null;
  submit: { status: "idle" | "submitting" | "success" | "failed"; message: string | null };
  result: BookingResult | null;
};

export type Action =
  | { type: "setMode"; mode: Mode }
  | { type: "loadStart" }
  | { type: "loadSuccess"; days: ApiDay[]; capacity: number }
  | { type: "loadError" }
  | { type: "selectDate"; date: string }
  | { type: "selectStart"; start: string }
  | { type: "setField"; field: keyof FormValues; value: string | boolean }
  | { type: "setTurnstile"; token: string | null }
  | { type: "turnstileUnavailable" }
  | { type: "submitStart" }
  | { type: "submitSuccess"; result: BookingResult }
  | {
      type: "submitFailed";
      status: number;
      body: { error?: string; code?: string; fields?: Record<string, string> };
    };

const MESSAGES = {
  turnstile: "No pudimos verificar que eres una persona. Recarga e intenta de nuevo.",
  rate: "Demasiados intentos. Espera unos minutos e intenta de nuevo.",
  network: "No pudimos confirmar tu reserva. Intenta de nuevo en un momento.",
  block: "Elige un bloque libre para continuar.",
  fields: "Revisa los campos marcados y vuelve a intentar.",
  turnstileLoad:
    "No pudimos cargar la verificación anti-spam. Recarga la página e intenta de nuevo.",
} as const;

export type FormErrors = Partial<Record<keyof FormValues | "bloque", string>>;

/** Orden visual de los campos: el primero con error recibe el foco. */
export const FIELD_ORDER: readonly (keyof FormValues)[] = [
  "nombre",
  "telefono",
  "correo",
  "bicicleta",
  "descripcion",
  "comuna",
  "direccion",
  "consentimiento",
];

/** Dónde llevar al usuario: el bloque va antes que los campos, igual que en pantalla. */
export function firstErrorTarget(errors: FormErrors): "bloque" | keyof FormValues | null {
  if (errors.bloque) {
    return "bloque";
  }
  return FIELD_ORDER.find((field) => errors[field]) ?? null;
}

/** Errores del servidor con las claves de la isla: `service_date` y `start` son el bloque. */
export function formErrorsFrom(fields: Record<string, string>): FormErrors {
  const { service_date: serviceDate, start, ...rest } = fields;
  const bloque = start ?? serviceDate;
  return { ...(rest as FormErrors), ...(bloque ? { bloque } : {}) };
}

/** 422 local o del servidor: marca los campos y deja siempre un mensaje general. */
function failedValidation(
  state: State,
  body: { error?: string; fields?: Record<string, string> },
): State {
  const errors = formErrorsFrom(body.fields ?? {});
  const message = errors.bloque ? MESSAGES.block : (body.error ?? MESSAGES.fields);
  return { ...state, turnstileToken: null, errors, submit: { status: "failed", message } };
}

const EMPTY_FORM: FormValues = {
  nombre: "",
  telefono: "",
  correo: "",
  bicicleta: "",
  descripcion: "",
  comuna: "",
  direccion: "",
  consentimiento: false,
  whatsappConsent: false,
};

export const initialState: State = {
  mode: "taller",
  availability: { status: "idle" },
  selectedDate: null,
  selectedStart: null,
  form: EMPTY_FORM,
  errors: {},
  turnstileToken: null,
  submit: { status: "idle", message: null },
  result: null,
};

function dayOf(state: State, date: string): ApiDay | undefined {
  return state.availability.status === "ready"
    ? state.availability.days.find((day) => day.date === date)
    : undefined;
}

/** Respaldo por estado si la API no trae `error`. */
const FALLBACK_BY_STATUS: Record<number, string> = {
  403: MESSAGES.turnstile,
  409: "El bloque ya no está disponible",
  429: MESSAGES.rate,
};

/** El mensaje del servidor manda en 403, 409 y 429 (el 422 va por `failedValidation`). */
function failureMessage(status: number, body: { error?: string; code?: string }): string {
  if (status in FALLBACK_BY_STATUS) {
    return body.error ?? FALLBACK_BY_STATUS[status] ?? MESSAGES.network;
  }
  return MESSAGES.network;
}

function failedSubmit(state: State, action: Extract<Action, { type: "submitFailed" }>): State {
  if (action.status === 422) {
    return failedValidation(state, action.body);
  }
  const base: State = {
    ...state,
    turnstileToken: null,
    submit: { status: "failed", message: failureMessage(action.status, action.body) },
  };
  return action.status === 409 ? { ...base, selectedStart: null } : base;
}

export function bookingReducer(state: State, action: Action): State {
  switch (action.type) {
    case "setMode":
      return { ...state, mode: action.mode, selectedStart: null, errors: {} };
    case "loadStart":
      return { ...state, availability: { status: "loading" } };
    case "loadSuccess":
      return {
        ...state,
        availability: { status: "ready", days: action.days, capacity: action.capacity },
      };
    case "loadError":
      return { ...state, availability: { status: "error" } };
    case "selectDate": {
      const day = dayOf(state, action.date);
      if (day?.status !== "open") {
        return state;
      }
      return { ...state, selectedDate: action.date, selectedStart: null };
    }
    case "selectStart": {
      const day = state.selectedDate === null ? undefined : dayOf(state, state.selectedDate);
      const block = day?.blocks.find((item) => item.start === action.start);
      if (block?.state !== "free") {
        return state;
      }
      return {
        ...state,
        selectedStart: action.start,
        errors: { ...state.errors, bloque: undefined },
      };
    }
    case "setField":
      return {
        ...state,
        form: {
          ...state.form,
          [action.field]:
            action.field === "telefono" && typeof action.value === "string"
              ? formatPhoneLocal(action.value)
              : action.value,
        },
        errors: { ...state.errors, [action.field]: undefined },
      };
    case "setTurnstile":
      return { ...state, turnstileToken: action.token };
    case "turnstileUnavailable":
      return {
        ...state,
        turnstileToken: null,
        submit: { status: "failed", message: MESSAGES.turnstileLoad },
      };
    case "submitStart":
      return { ...state, submit: { status: "submitting", message: null }, errors: {} };
    case "submitSuccess":
      return {
        ...state,
        submit: { status: "success", message: null },
        result: action.result,
        turnstileToken: null,
      };
    case "submitFailed":
      return failedSubmit(state, action);
    default:
      return state;
  }
}

/** Mismas reglas y mensajes que el servidor; la autoridad sigue siendo la API. */
export function validateForm(state: State): FormErrors {
  const errors: FormErrors = {};
  const { form } = state;

  if (state.selectedDate === null || state.selectedStart === null) {
    errors.bloque = MESSAGES.block;
  }
  if (form.nombre.trim().length < 2 || form.nombre.trim().length > 80) {
    errors.nombre = "Escribe tu nombre.";
  }
  if (phoneE164(form.telefono) === null) {
    errors.telefono = "Faltan dígitos: son 8 después del +56 9.";
  }
  const correo = form.correo.trim();
  if (correo.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    errors.correo = "Escribe un correo válido, por ejemplo nombre@correo.cl.";
  }
  if (form.bicicleta.trim().length < 2 || form.bicicleta.trim().length > 120) {
    errors.bicicleta = "Cuéntanos la marca y el tipo de bici.";
  }
  if (form.descripcion.trim().length < 5 || form.descripcion.trim().length > 1000) {
    errors.descripcion = "Cuéntanos qué necesita tu bici.";
  }
  if (state.mode === "retiro") {
    if (form.comuna !== "Vitacura" && form.comuna !== "Las Condes") {
      errors.comuna = "Elige Vitacura o Las Condes.";
    }
    if (form.direccion.trim().length < 5 || form.direccion.trim().length > 200) {
      errors.direccion = "Escribe la dirección de retiro.";
    }
  }
  if (!form.consentimiento) {
    errors.consentimiento = "Acepta el aviso de privacidad para confirmar.";
  }
  return errors;
}

/** Dígitos tras el `+56 9` fijo; de un número pegado completo quedan los 8 finales. */
export function phoneLocalDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 8 ? digits.slice(-8) : digits;
}

/** `12345678` → `1234 5678`, también a medio escribir. */
export function formatPhoneLocal(raw: string): string {
  const digits = phoneLocalDigits(raw);
  return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}

/** `1234 5678` → `+56912345678`, el formato que espera la API. */
export function phoneE164(raw: string): string | null {
  const digits = phoneLocalDigits(raw);
  return digits.length === 8 ? `+569${digits}` : null;
}

/** `HH:MM` más `minutes` minutos. */
function addMinutes(hhmm: string, minutes: number): string {
  const parts = hhmm.split(":");
  const total = Number(parts[0]) * 60 + Number(parts[1]) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** `retiro` ocupa el bloque elegido y el siguiente. */
export function selectedBlocks(state: State): string[] {
  if (state.selectedStart === null) {
    return [];
  }
  if (state.mode === "taller") {
    return [state.selectedStart];
  }
  return [state.selectedStart, addMinutes(state.selectedStart, 30)];
}

/** `17:00 – 18:00`: del inicio del primer bloque al fin del último (bloques de 30 min). */
export function timeRange(blocks: string[]): string | null {
  const first = blocks[0];
  const last = blocks.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  return `${first} – ${addMinutes(last, 30)}`;
}

export type ResponseBody = BookingResult & {
  error?: string;
  code?: string;
  fields?: Record<string, string>;
};

/** Cuerpo de la API; un proxy puede responder HTML o vacío (p. ej. un 429 propio). */
export function parseResponseBody(text: string): Partial<ResponseBody> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Partial<ResponseBody>) : {};
  } catch {
    return {};
  }
}

export function ticketCode(date: string, start: string): string {
  return `VB-${date.slice(2).replaceAll("-", "")}-${start.replace(":", "")}`;
}

/** `$15.000`, sin `toLocaleString` (depende del ICU del navegador). */
export function formatClp(amount: number): string {
  return `$${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}
/** Recargo del retiro, espejo de rules.ts para la vista. */
export const PICKUP_FEE_CLP = 15000;
