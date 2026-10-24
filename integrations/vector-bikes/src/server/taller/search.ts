import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizeRut } from "../../lib/rut.ts";
import { normalizePhone } from "../api/handlers.ts";
import type { SessionUser } from "../auth/admin-auth.ts";
import { can } from "../auth/permissions.ts";
import type { AppDb } from "../db/client.ts";
import { workOrders } from "../db/schema-orders.ts";
import { customers } from "../db/schema-taller.ts";
import { formatOrderNumber } from "./orders.ts";
import { canAccessOrder } from "./status.ts";

export const searchQuerySchema = z.string().trim().min(1).max(80);
type CustomerHit = Pick<typeof customers.$inferSelect, "id" | "name" | "phoneE164" | "rut">;
type OrderHit = Pick<typeof workOrders.$inferSelect, "id" | "number" | "status"> & {
  label: string;
};
type SearchResult = { customers: CustomerHit[]; orders: OrderHit[] };

async function searchOrder(db: AppDb, actor: SessionUser, number: number): Promise<OrderHit[]> {
  const [order] = await db
    .select()
    .from(workOrders)
    .where(
      and(
        eq(workOrders.branchId, actor.branchId),
        eq(workOrders.number, number),
        isNull(workOrders.voidedAt),
      ),
    )
    .limit(1);
  if (!order || !canAccessOrder(actor, order)) return [];
  return [
    {
      id: order.id,
      number: order.number,
      label: formatOrderNumber(order.number),
      status: order.status,
    },
  ];
}

function searchFilter(q: string) {
  const rut = normalizeRut(q);
  if (rut) return eq(customers.rut, rut);
  const phone = normalizePhone(q);
  if (phone) return eq(customers.phoneE164, phone);
  const pattern = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  return sql`${customers.name} ilike ${pattern} escape ${"\\"}`;
}

export async function searchTaller(
  db: AppDb,
  actor: SessionUser,
  q: string,
): Promise<SearchResult> {
  const empty: SearchResult = { customers: [], orders: [] };
  if (!can(actor.role, "customers.manage") && !can(actor.role, "reception.perform")) return empty;
  const parsed = searchQuerySchema.safeParse(q);
  if (!parsed.success) return empty;
  const orderNumber = /^(?:ot-?)?0*(\d{1,6})$/i.exec(parsed.data);
  if (orderNumber)
    return { customers: [], orders: await searchOrder(db, actor, Number(orderNumber[1])) };
  const matches = await db
    .select({
      id: customers.id,
      name: customers.name,
      phoneE164: customers.phoneE164,
      rut: customers.rut,
    })
    .from(customers)
    .where(and(eq(customers.branchId, actor.branchId), searchFilter(parsed.data)))
    .orderBy(asc(customers.name))
    .limit(20);
  return { customers: matches, orders: [] };
}
