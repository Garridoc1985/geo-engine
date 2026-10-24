import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  can,
  forbiddenResponse,
  isRole,
  ROLE_LABELS,
  ROLES,
} from "../../src/server/auth/permissions.ts";
import type { Action, Role } from "../../src/server/auth/permissions.ts";

const expected: Record<Role, readonly Action[]> = {
  owner: ACTIONS.filter((action) => action !== "dashboard.mechanic"),
  admin: [
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
    "reception.perform",
    "catalog.view",
    "orders.edit",
    "items.add_catalog",
    "photos.upload",
    "components.manage",
  ],
  reception: [
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
    "reception.perform",
    "catalog.view",
    "orders.edit",
    "items.add_catalog",
    "photos.upload",
    "components.manage",
  ],
  mechanic: [
    "reception.perform",
    "catalog.view",
    "orders.edit",
    "items.add_catalog",
    "photos.upload",
    "components.manage",
    "dashboard.mechanic",
  ],
};

describe("permisos del taller", () => {
  it("expone las 29 acciones sin duplicados", () => {
    expect(ACTIONS).toHaveLength(29);
    expect(new Set(ACTIONS).size).toBe(29);
    expect(new Set(Object.values(expected).flat())).toEqual(new Set(ACTIONS));
  });

  for (const role of ROLES) {
    for (const action of ACTIONS) {
      it(`${role}: ${action}`, () => {
        expect(can(role, action)).toBe(expected[role].includes(action));
      });
    }
  }
});

describe("roles y respuesta sin permiso", () => {
  it("reconoce solo los cuatro roles", () => {
    expect(ROLES).toEqual(["owner", "admin", "reception", "mechanic"]);
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const value of ["", "Owner", "customer", "toString", null, undefined, 1, {}]) {
      expect(isRole(value)).toBe(false);
    }
  });

  it("etiqueta los roles en español", () => {
    expect(ROLE_LABELS).toEqual({
      owner: "Dueño",
      admin: "Administrador",
      reception: "Recepción",
      mechanic: "Mecánico",
    });
  });

  it("responde 403 sin caché y con un error en español", async () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "No tienes permiso para realizar esta acción.",
      code: "forbidden",
    });
  });
});
