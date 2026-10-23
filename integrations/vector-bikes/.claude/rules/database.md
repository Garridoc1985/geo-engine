---
description: Esquema, migraciones y acceso a Postgres de Vector Bikes
paths:
  - "src/server/db/**"
  - "drizzle/**"
  - "scripts/db-*.ts"
---

# Base de datos

- El esquema vive en cuatro archivos: `src/server/db/schema.ts` (tablas del sitio, `branches`, `users`), `src/server/db/schema-taller.ts` (auditoría, catálogo, clientes, bicicletas), `src/server/db/schema-orders.ts` (órdenes y todo lo que cuelga de ellas) y `src/server/db/schema-reports.ts` (informe final, `service_reports`). Importan en un solo sentido: `schema.ts` ← `schema-taller.ts` ← `schema-orders.ts` ← `schema-reports.ts`. `drizzle.config.ts` los lee con `./src/server/db/schema*.ts`. Cada archivo queda bajo 400 líneas; una tabla que no cabe va a un archivo nuevo al final de la cadena, nunca a uno anterior.
- `drizzle/` se regenera con `pnpm db:generate` y nunca se edita. Nunca `drizzle-kit generate --custom` ni SQL escrito a mano: si un cambio no se puede expresar en el esquema, se rediseña.
- Cambios de tabla siempre aditivos (tabla, columna, índice o CHECK nuevo; quitar un NOT NULL) para que `drizzle-kit generate` no pregunte por renombres. Un renombre o un borrado va en su propio paso de contracción, sin nada aditivo en la misma generación.
- Toda tabla nueva: `id uuid` con `defaultRandom()`, `created_at` y `updated_at` `timestamptz` (salvo tablas de bloqueo con PK natural, como `booking_days`).
- Toda tabla de operación lleva `branch_id uuid not null` con FK a `branches`; toda consulta filtra por la sucursal del usuario de la sesión.
- Instantes en `timestamptz` UTC; fechas y horas locales de negocio en `date` y `time`.
- Dinero en enteros CLP (`integer`), nunca decimales.
- Checks e índices parciales con SQL literal de columnas (`sql\`is_active = true\``), no referencias calificadas.
- Las reglas que viven en la base (saldo cero al entregar, control de calidad antes de `lista_para_retirar`, un solo abono vigente, número de orden único por sucursal, token único) son CHECK o índices únicos. Sin triggers.
- Nunca se borra: órdenes, líneas, accesorios, componentes, aprobaciones y fotos llevan `voided_at`/`voided_by`. Nunca borrar filas de `bookings`.
- FKs nuevas con `onDelete: "restrict"`; la única cascada nueva es `admin_sessions.user_id`.
- Cada tabla nueva se agrega al arreglo de su archivo (`allTables`, `tallerTables`, `orderTables` o `reportTables`): `pnpm db:check` y los tests lo recorren.
- Solo constructor de consultas de Drizzle o `sql\`\`` parametrizado; nunca `db.query.*` relacional (PGlite y postgres-js comparten solo esa API).
- `pnpm db:migrate` solo contra la base del workspace; nunca `drizzle-kit push`; la app nunca migra al arrancar.
- Cambios destructivos: expand → migrate → contract en publicaciones separadas (Replit propaga el esquema de dev a producción al publicar, sin datos y sin correr `drizzle/`).
