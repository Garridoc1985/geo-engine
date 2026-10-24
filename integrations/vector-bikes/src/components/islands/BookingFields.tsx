import type { Ref } from "preact";
import type { FormValues, State } from "./booking-state.ts";

export const FIELD_IDS: Record<keyof FormValues, string> = {
  nombre: "f-nombre",
  telefono: "f-tel",
  correo: "f-mail",
  bicicleta: "f-bici",
  descripcion: "f-desc",
  comuna: "f-comuna",
  direccion: "f-dir",
  consentimiento: "f-ok",
  whatsappConsent: "f-whatsapp",
};

type FieldsProps = {
  form: FormValues;
  errors: State["errors"];
  isPickup: boolean;
  turnstileRef: Ref<HTMLDivElement>;
  onField: (field: keyof FormValues, value: string | boolean) => void;
};

/** Atributos comunes de cada control: id, nombre, valor y accesibilidad del error. */
function bind(
  props: FieldsProps,
  field: Exclude<keyof FormValues, "consentimiento" | "whatsappConsent">,
) {
  const id = FIELD_IDS[field];
  const error = props.errors[field];
  return {
    id,
    name: field,
    value: props.form[field],
    "aria-invalid": error ? ("true" as const) : undefined,
    "aria-describedby": error ? `err-${id}` : undefined,
    onInput: (event: Event) =>
      props.onField(field, (event.currentTarget as HTMLInputElement).value),
  };
}

function Field({
  id,
  label,
  error,
  help,
  alert,
  hidden,
  full,
  children,
}: {
  id: string;
  label: preact.ComponentChildren;
  error?: string;
  help?: string;
  alert?: boolean;
  hidden?: boolean;
  full?: boolean;
  children: preact.ComponentChildren;
}) {
  const classes = ["field", full ? "full" : "", error ? "bad" : ""].filter(Boolean).join(" ");
  return (
    <div class={classes} hidden={hidden}>
      <label for={id}>{label}</label>
      {children}
      {help && !error && (
        <span class="help" id={`help-${id}`}>
          {help}
        </span>
      )}
      {error && (
        <span class="err" id={`err-${id}`} role={alert ? "alert" : undefined}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Prefijo `+56 9` fijo dentro del recuadro; el usuario escribe solo los 8 dígitos. */
function PhoneInput(props: FieldsProps) {
  const error = props.errors.telefono;
  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text") ?? "";
    // Sin esto, maxlength cortaría un +56912345678 pegado antes de normalizarlo.
    event.preventDefault();
    props.onField("telefono", text);
  };
  return (
    <div class="phone">
      <span class="phone-prefix" id="pre-f-tel">
        +56 9
      </span>
      <input
        {...bind(props, "telefono")}
        aria-describedby={`pre-f-tel ${error ? "err-f-tel" : "help-f-tel"}`}
        onPaste={onPaste}
        type="tel"
        autocomplete="tel-national"
        inputmode="numeric"
        maxlength={9}
        placeholder="1234 5678"
      />
    </div>
  );
}

export function BookingFields(props: FieldsProps) {
  const { errors, form, isPickup, onField, turnstileRef } = props;
  return (
    <fieldset>
      <legend>
        <span class="mono">4</span> Tus datos
      </legend>
      <div class="fields">
        <Field id="f-nombre" label="Nombre" error={errors.nombre}>
          <input {...bind(props, "nombre")} autocomplete="name" />
        </Field>
        <Field
          id="f-tel"
          label="Teléfono"
          help="8 dígitos, sin el 9 inicial."
          error={errors.telefono}
          alert
        >
          <PhoneInput {...props} />
        </Field>
        <Field
          id="f-mail"
          label="Correo"
          help="Aquí llega la confirmación y el enlace para cancelar."
          error={errors.correo}
        >
          <input {...bind(props, "correo")} type="email" autocomplete="email" />
        </Field>
        <Field
          id="f-bici"
          label={
            <>
              Bicicleta <em>marca y tipo</em>
            </>
          }
          error={errors.bicicleta}
        >
          <input {...bind(props, "bicicleta")} placeholder="Ej: Trek Marlin 7, MTB" />
        </Field>
        <Field id="f-desc" label="¿Qué necesita tu bici?" full error={errors.descripcion}>
          <textarea
            {...bind(props, "descripcion")}
            placeholder="Ej: los cambios saltan en la corona grande y el freno trasero está blando."
          />
        </Field>
        <Field id="f-comuna" label="Comuna" hidden={!isPickup} error={errors.comuna}>
          <select
            {...bind(props, "comuna")}
            onChange={(event) =>
              onField("comuna", (event.currentTarget as HTMLSelectElement).value)
            }
          >
            <option value="">Selecciona</option>
            <option>Vitacura</option>
            <option>Las Condes</option>
          </select>
        </Field>
        <Field id="f-dir" label="Dirección de retiro" hidden={!isPickup} error={errors.direccion}>
          <input
            {...bind(props, "direccion")}
            autocomplete="street-address"
            placeholder="Calle, número, depto."
          />
        </Field>
        <label class="consent full" for="f-ok">
          <input
            type="checkbox"
            id="f-ok"
            name="consentimiento"
            checked={form.consentimiento}
            aria-invalid={errors.consentimiento ? "true" : undefined}
            aria-describedby={errors.consentimiento ? "err-f-ok" : undefined}
            onChange={(event) =>
              onField("consentimiento", (event.currentTarget as HTMLInputElement).checked)
            }
          />
          <span>
            Acepto que Vector Bikes use estos datos solo para gestionar mi reserva, según el{" "}
            <a href="/privacidad">aviso de privacidad</a>.
          </span>
        </label>
        {errors.consentimiento && (
          <span class="err" id="err-f-ok">
            {errors.consentimiento}
          </span>
        )}
        <label class="consent full" for="f-whatsapp">
          <input
            type="checkbox"
            id="f-whatsapp"
            name="whatsapp_consentimiento"
            checked={form.whatsappConsent}
            onChange={(event) =>
              onField("whatsappConsent", (event.currentTarget as HTMLInputElement).checked)
            }
          />
          <span>
            Autorizo que Vector Bikes me contacte por WhatsApp al número indicado para coordinar
            aspectos operativos de esta reserva. Es opcional y no recibiré publicidad.
          </span>
        </label>
        <div class="field full" ref={turnstileRef}></div>
      </div>
    </fieldset>
  );
}
