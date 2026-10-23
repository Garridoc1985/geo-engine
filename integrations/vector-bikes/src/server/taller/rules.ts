export const BIKE_TYPES = ["mtb", "ruta", "gravel", "urbana", "ebike"] as const;
export type BikeType = (typeof BIKE_TYPES)[number];
export const BIKE_TYPE_LABELS: Record<BikeType, string> = {
  mtb: "MTB",
  ruta: "Ruta",
  gravel: "Gravel",
  urbana: "Urbana",
  ebike: "E-bike",
};

export const DISCOVERY_CHANNELS = [
  "instagram",
  "google",
  "recomendacion",
  "sitio_web",
  "paso_por_el_taller",
  "otro",
] as const;
export const DISCOVERY_CHANNEL_LABELS: Record<(typeof DISCOVERY_CHANNELS)[number], string> = {
  instagram: "Instagram",
  google: "Google",
  recomendacion: "Recomendación",
  sitio_web: "Sitio web",
  paso_por_el_taller: "Paso por el taller",
  otro: "Otro",
};

export const ORDER_STATUSES = [
  "reservada",
  "recibida",
  "diagnostico",
  "esperando_aprobacion",
  "esperando_repuesto",
  "en_reparacion",
  "control_calidad",
  "lista_para_retirar",
  "entregada",
  "cancelada",
  "trabajo_rechazado",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const STATUS_LABELS: Record<OrderStatus, string> = {
  reservada: "Reservada",
  recibida: "Recibida",
  diagnostico: "Diagnóstico",
  esperando_aprobacion: "Esperando aprobación",
  esperando_repuesto: "Esperando repuesto",
  en_reparacion: "En reparación",
  control_calidad: "Control de calidad",
  lista_para_retirar: "Lista para retirar",
  entregada: "Entregada",
  cancelada: "Cancelada",
  trabajo_rechazado: "Trabajo rechazado",
};
export const TERMINAL_STATUSES = ["entregada", "cancelada", "trabajo_rechazado"] as const;
export const MECHANIC_UNASSIGNED_ACCESS_STATUSES = [
  "reservada",
  "recibida",
  "diagnostico",
] as const;
export const LOAD_EXCLUDED_STATUSES = ["lista_para_retirar", ...TERMINAL_STATUSES] as const;
export const ORDER_TRANSITIONS = {
  reservada: ["recibida", "cancelada"],
  recibida: ["diagnostico", "cancelada"],
  diagnostico: [
    "esperando_aprobacion",
    "esperando_repuesto",
    "en_reparacion",
    "trabajo_rechazado",
    "cancelada",
  ],
  esperando_aprobacion: ["en_reparacion", "trabajo_rechazado", "cancelada"],
  esperando_repuesto: ["en_reparacion", "esperando_aprobacion", "cancelada"],
  en_reparacion: ["esperando_repuesto", "esperando_aprobacion", "control_calidad", "cancelada"],
  control_calidad: ["en_reparacion", "lista_para_retirar"],
  lista_para_retirar: ["entregada"],
  entregada: [],
  cancelada: [],
  trabajo_rechazado: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;
export const MANUAL_TRANSITIONS = {
  reservada: ["cancelada"],
  recibida: ["diagnostico", "cancelada"],
  diagnostico: ["esperando_repuesto", "en_reparacion", "trabajo_rechazado", "cancelada"],
  esperando_aprobacion: ["trabajo_rechazado", "cancelada"],
  esperando_repuesto: ["en_reparacion", "cancelada"],
  en_reparacion: ["esperando_repuesto", "control_calidad", "cancelada"],
  control_calidad: ["en_reparacion"],
  lista_para_retirar: [],
  entregada: [],
  cancelada: [],
  trabajo_rechazado: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

export function isAllowedTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] as readonly OrderStatus[]).includes(to);
}

export function isManualTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (MANUAL_TRANSITIONS[from] as readonly OrderStatus[]).includes(to);
}

export const INTAKE_CHECK_KEYS = [
  "frenos",
  "cadena",
  "transmision",
  "ruedas",
  "neumaticos",
  "estado_general",
  "problemas_visibles",
] as const;
export const INTAKE_CHECK_LABELS: Record<(typeof INTAKE_CHECK_KEYS)[number], string> = {
  frenos: "Frenos",
  cadena: "Cadena",
  transmision: "Transmisión",
  ruedas: "Ruedas",
  neumaticos: "Neumáticos",
  estado_general: "Estado general",
  problemas_visibles: "Problemas visibles",
};
export const INTAKE_RESULTS = ["ok", "revisar", "malo"] as const;
export const INTAKE_RESULT_LABELS: Record<(typeof INTAKE_RESULTS)[number], string> = {
  ok: "OK",
  revisar: "Revisar",
  malo: "Malo",
};
export const QC_CHECK_KEYS = [
  "frenos",
  "cambios",
  "ruedas",
  "apriete",
  "neumaticos",
  "prueba_de_rodaje",
  "limpieza",
] as const;
export const QC_CHECK_LABELS: Record<(typeof QC_CHECK_KEYS)[number], string> = {
  frenos: "Frenos",
  cambios: "Cambios",
  ruedas: "Ruedas",
  apriete: "Apriete de componentes",
  neumaticos: "Neumáticos y presión",
  prueba_de_rodaje: "Prueba de rodaje",
  limpieza: "Limpieza",
};
export const QC_RESULTS = ["ok", "falla"] as const;
export const QC_RESULT_LABELS: Record<(typeof QC_RESULTS)[number], string> = {
  ok: "OK",
  falla: "Falla",
};
export const PHOTO_STAGES = ["recepcion", "reparacion", "terminado"] as const;
export const PHOTO_STAGE_LABELS: Record<(typeof PHOTO_STAGES)[number], string> = {
  recepcion: "Recepción",
  reparacion: "Reparación",
  terminado: "Trabajo terminado",
};
export const PAYMENT_KINDS = ["abono", "final"] as const;
export const PAYMENT_KIND_LABELS: Record<(typeof PAYMENT_KINDS)[number], string> = {
  abono: "Abono",
  final: "Pago final",
};
export const PAYMENT_METHODS = ["transferencia", "tarjeta", "efectivo", "otro"] as const;
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  transferencia: "Transferencia",
  tarjeta: "Tarjeta",
  efectivo: "Efectivo",
  otro: "Otro",
};
export const TAX_DOC_TYPES = ["boleta", "factura"] as const;
export const TAX_DOC_TYPE_LABELS: Record<(typeof TAX_DOC_TYPES)[number], string> = {
  boleta: "Boleta",
  factura: "Factura",
};
export const WORKSHOP_MINUTES_PER_DAY = 360;
export const LABEL_WIDTH_MM = 62;
export const QC_REQUIRE_SECOND_PERSON = false;
