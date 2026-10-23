---
name: add-migration
description: Cambiar el esquema de Postgres de Vector Bikes (agregar tabla, columna, índice o check). Usar cuando se pide "agregar un campo", "nueva tabla", "cambiar el esquema" o "migración".
---

# Agregar una migración

## Cuándo usar
- Cualquier cambio en `src/server/db/schema.ts`.
- Un campo nuevo en `bookings`, `blocked_periods` u otra tabla de `blueprint.md` §4.

## Pasos
1. Editar solo `src/server/db/schema.ts`. Cambios destructivos (renombrar, borrar, NOT NULL nuevo): primero la parte aditiva y publicar; quitar lo viejo en una publicación posterior.
2. Ejecutar `pnpm db:generate` y leer el SQL que emite (no editarlo a mano).
3. Agregar o ajustar un test en `tests/integration/` que use `createTestDb()` y ejercite la columna o restricción nueva.
4. Ejecutar `pnpm db:migrate` (solo contra la base del workspace).
5. Publicar desde Replit: la plataforma propaga el esquema a producción; confirmarlo en el panel *Database*.

## Verify
```bash
pnpm check        # expect: exit 0
pnpm test         # expect: exit 0, 0 failed
pnpm db:migrate   # expect: exit 0
pnpm db:check     # expect: exit 0
```

## No hacer
- Ejecutar `drizzle-kit push` o migrar contra la base de producción.
- Editar archivos dentro de `drizzle/`.
- Borrar filas de `bookings`.
