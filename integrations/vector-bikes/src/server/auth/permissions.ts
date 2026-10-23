export const ROLES = ["owner", "admin", "reception", "mechanic"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Dueño",
  admin: "Administrador",
  reception: "Recepción",
  mechanic: "Mecánico",
};

export const ACTIONS = [
  "admin.panel",
  "customers.manage",
  "bookings.manage",
  "orders.view_all",
  "orders.assign",
  "orders.cancel",
  "items.add_part",
  "tax_doc.edit",
  "warranty.open",
  "approvals.create",
  "payments.record",
  "delivery.complete",
  "reports.generate",
  "dashboard.admin",
  "dashboard.finance",
  "catalog.edit",
  "items.override_price",
  "items.void",
  "payments.void",
  "users.manage",
  "audit.view",
  "qc.approve",
  "reception.perform",
  "catalog.view",
  "orders.edit",
  "items.add_catalog",
  "photos.upload",
  "components.manage",
  "dashboard.mechanic",
] as const;
export type Action = (typeof ACTIONS)[number];

const staff = ["owner", "admin", "reception"] as const;
const administrators = ["owner", "admin"] as const;
const permissions: Record<Action, readonly Role[]> = {
  "admin.panel": staff,
  "customers.manage": staff,
  "bookings.manage": staff,
  "orders.view_all": staff,
  "orders.assign": staff,
  "orders.cancel": staff,
  "items.add_part": staff,
  "tax_doc.edit": staff,
  "warranty.open": staff,
  "approvals.create": staff,
  "payments.record": staff,
  "delivery.complete": staff,
  "reports.generate": staff,
  "dashboard.admin": staff,
  "dashboard.finance": administrators,
  "catalog.edit": administrators,
  "items.override_price": administrators,
  "items.void": administrators,
  "payments.void": administrators,
  "users.manage": ["owner"],
  "audit.view": ["owner"],
  "qc.approve": ["owner"],
  "reception.perform": ROLES,
  "catalog.view": ROLES,
  "orders.edit": ROLES,
  "items.add_catalog": ROLES,
  "photos.upload": ROLES,
  "components.manage": ROLES,
  "dashboard.mechanic": ["mechanic"],
};

export function isRole(value: unknown): value is Role {
  return ROLES.some((role) => role === value);
}

export function can(role: Role, action: Action): boolean {
  return permissions[action].includes(role);
}

export function forbiddenResponse(): Response {
  return Response.json(
    { error: "No tienes permiso para realizar esta acción.", code: "forbidden" },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
