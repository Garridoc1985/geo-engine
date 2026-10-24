/**
 * Secciones de una orden de trabajo, en el orden en que se recorren.
 * `permission` se compara con `can(role, …)` en la página: este módulo no
 * importa `src/server/**` para no romper la frontera de `src/lib/**`.
 */
export const ORDER_TABS = [
  { suffix: "", label: "Detalle", permission: "orders.edit" },
  { suffix: "recepcion", label: "Recepción", permission: "reception.perform" },
  { suffix: "cierre", label: "Fotos y firma", permission: "reception.perform" },
  { suffix: "lineas", label: "Líneas", permission: "orders.edit" },
  { suffix: "galeria", label: "Galería", permission: "photos.upload" },
  { suffix: "adicional", label: "Adicional", permission: "approvals.create" },
  { suffix: "control", label: "Control de calidad", permission: "orders.edit" },
  { suffix: "entrega", label: "Entrega", permission: "delivery.complete" },
  { suffix: "componentes", label: "Componentes", permission: "components.manage" },
  { suffix: "informe", label: "Informe", permission: "reports.generate" },
  { suffix: "etiqueta", label: "Etiqueta", permission: "orders.edit", external: true },
] as const;

export type OrderTab = (typeof ORDER_TABS)[number];
