---
description: Lógica de dominio del taller y capa de almacenamiento de imágenes
paths:
  - "src/server/taller/**"
  - "src/server/storage/**"
---

# Dominio del taller

- Cada función recibe `db: AppDb` (una transacción de Drizzle también lo es), el usuario de la sesión (`actor: SessionUser`) cuando hay autoría, y `now: Date`. Nunca `new Date()` ni `Date.now()` dentro de la lógica.
- Toda consulta filtra por `actor.branchId`; toda fila nueva lleva ese `branch_id`.
- El permiso se revisa al comienzo de cada función que escribe, con `can(actor.role, …)`; sin permiso devuelve `{ ok: false, code: "forbidden" }` sin tocar filas.
- Nunca se borra una orden, línea, accesorio, componente, aprobación ni foto: se marcan con `voided_at`/`voided_by`.
- `total_clp` y `estimated_minutes` se recalculan desde las filas con `recomputeOrderTotals` (`items.ts`) y `paid_clp` con `recomputePaid` (`payments.ts`), dentro de la misma transacción que cambia líneas o pagos.
- Todo cambio de estado valida `ORDER_TRANSITIONS` de `rules.ts` y escribe historial con `recordStatusChange` (`orders.ts`). Los saltos que solo ocurren por un flujo (`MANUAL_TRANSITIONS` no los incluye: cierre de recepción, propuesta y respuesta de adicional, control de calidad, entrega) nunca aparecen como botón manual.
- `recordAudit(tx, …)` se llama dentro de la misma transacción del cambio auditado; `details` pasa por `redactDetails`, que quita correos, teléfonos, RUT, tokens y claves.
- Nada de red, correo ni almacenamiento dentro de una transacción: subir el objeto primero, escribir la fila después; si la fila falla, borrar el objeto. Los correos van después del commit.
- Las claves de almacenamiento las arman `photos.ts` y `reception.ts` con ids generados por el servidor (`orders/<orderId>/<photoId>-full.jpg`, `-thumb.jpg`, `orders/<orderId>/signature-<recepcion|entrega>-<id>.png`); nunca con texto del usuario.
- Errores esperables se devuelven como `{ ok: false, code }`; solo lo inesperado se lanza.
- Tokens de aprobación e informe: `newShareToken()` y `hashShareToken()` de `share-tokens.ts`; en base solo el hash.
- Constantes del taller (estados, etiquetas, transiciones, checklists, capacidad diaria, ancho de etiqueta) solo en `src/server/taller/rules.ts`.
- La fase 1 no guarda costos ni márgenes: "el mecánico no ve costos" se cumple porque no existen. No agregar columnas de costo.
