# Vector Bikes — instrucciones para agentes

Sitio y reservas en línea del taller Vector Bikes (Vitacura) y su área interna `/taller` (recepción en tablet, órdenes de trabajo, historial): Astro 7 + Preact + Postgres (Drizzle) en Replit.

**Antes de terminar cualquier tarea:** `pnpm format` y después `pnpm gate` en verde. Nunca se marca una tarea como hecha con la compuerta fallando ni se edita un comando de Verify para que pase.

## Comandos

| Tarea | Comando |
|---|---|
| Instalar | `pnpm install --frozen-lockfile` |
| Formatear | `pnpm format` |
| Chequeo estático | `pnpm check` |
| Tests | `pnpm test` · un archivo: `pnpm test <ruta>` |
| Build + tests del build | `pnpm build && pnpm test:build` |
| Tests de tablet (existe desde F1-06) | `pnpm build && pnpm test:tablet` · un spec: `pnpm test:tablet e2e/<archivo>.spec.ts` |
| Navegador de Playwright | `pnpm exec playwright install chromium` (solo en el Mac) |
| Smoke | `pnpm smoke` |
| Compuerta completa | `pnpm gate` (check + test + build + test:build + smoke; `test:tablet` entra a la compuerta desde F1-06, el paso que la agrega) |
| Migraciones (solo base dev) | `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:check` |

Orden de trabajo de la fase 1: `blueprints/vector-taller-f1/tasks.json` y `blueprints/vector-taller-f1/epics/`. `blueprints/vector-bikes/` es el registro del sitio terminado y no se toca (única excepción: paso F1-02). Todo comando se ejecuta desde la raíz del proyecto.

## Reglas de código

1. Importaciones relativas con extensión `.ts`/`.tsx` explícita (`../db/client.ts`). Sin alias, sin barrels.
2. Nada de `enum`, `namespace` ni parameter properties (`erasableSyntaxOnly`): Node ejecuta `scripts/` quitando tipos.
3. Importaciones solo de tipos con `import type` (`verbatimModuleSyntax`).
4. La lógica de `src/server/**` recibe `db: AppDb` y `now: Date`; nunca `new Date()` dentro de la lógica.
5. Toda entrada externa pasa por zod antes de tocar `src/server/**`.
6. Ningún correo, `fetch`, subida al almacenamiento ni espera larga dentro de una transacción.
7. Archivos < 400 líneas, funciones < 50 líneas. Única excepción: `src/styles/global.css` (diseño aprobado; no partirlo).
8. Textos para el usuario en español de Chile; identificadores en inglés.
9. Todo elemento no-void cerrado en `.astro` (Astro 7 falla si no).
10. `set:html` solo para el JSON-LD de `Base.astro`.
11. Entorno solo por `src/lib/env.ts`; nunca `process.env` en otro lado (excepción: `e2e/**` y `playwright.config.ts`, que son infraestructura de pruebas). Logs por `src/lib/log.ts`.
12. En `/taller` y `/admin`, cada página y endpoint: sesión (`requireAdmin`) → permiso (`can` de `src/server/auth/permissions.ts`) → zod → `src/server/taller/**`. El permiso se decide en el servidor.
13. Primero se sube el objeto al almacenamiento, después se escribe la fila; si la fila falla, se borra el objeto.

## Fronteras de importación

| Capa | Puede importar | Nunca |
|---|---|---|
| `src/pages/**` | `server`, `lib`, `components`, `layouts` | SQL propio o lógica de negocio |
| `src/layouts/**` | `src/lib/**`, componentes, `src/server/auth/permissions.ts` (pura) | el resto de `src/server/**` |
| `src/components/**` | otros componentes, `booking-state.ts` | `src/server/**` (habla por `fetch` a `/api/*` o por un `input` del formulario) |
| `src/server/**` (incluye `taller/` y `storage/`) | `src/server/**`, `src/lib/**`, `src/data/**` | `astro`, `astro:*`, componentes |
| `src/lib/**` | paquetes npm | `src/server/**`, `astro` |
| `scripts/**` | `src/server/**`, `src/lib/**` | `astro` |
| `tests/**` | todo lo anterior | red real |
| `e2e/**` | `@playwright/test`, `e2e/fixtures.ts`; `global-setup.ts` además `hashPassword` de `src/server/auth/admin-auth.ts` | el resto de `src/` (habla por HTTP) |

## Esquema

El esquema vive en cuatro archivos, que importan en un solo sentido: `src/server/db/schema.ts` (base, sucursal, usuarios) ← `schema-taller.ts` (auditoría, catálogo, clientes, bicis) ← `schema-orders.ts` (órdenes y lo que cuelga) ← `schema-reports.ts` (informe final). Después, `pnpm db:generate` → `pnpm db:migrate`. Cada tabla nueva va al arreglo de su archivo (`allTables`, `tallerTables`, `orderTables` o `reportTables`). Detalle en `.claude/rules/database.md`.

## Reglas por carpeta

Antes de tocar archivos en estas rutas, leer el archivo de reglas correspondiente. No son opcionales.

| Archivo | Aplica a |
|---|---|
| `.claude/rules/database.md` | `src/server/db/**`, `drizzle/**`, `scripts/db-*.ts` |
| `.claude/rules/booking-engine.md` | `src/server/booking/**`, `src/data/**` |
| `.claude/rules/server-api.md` | `src/server/api/**`, `src/server/auth/**`, `src/pages/api/**`, `src/pages/admin/**`, `src/pages/reservas/**`, `src/pages/taller/**`, `src/pages/aprobacion/**`, `src/pages/informe/**`, `src/server/taller/**`, `src/server/storage/**` |
| `.claude/rules/ui-design.md` | `src/components/**`, `src/layouts/**`, `src/styles/**`, `src/pages/*.astro` |
| `.claude/rules/taller-ui.md` | `src/pages/taller/**`, `src/components/taller/**`, `src/layouts/TallerLayout.astro` |
| `.claude/rules/taller-domain.md` | `src/server/taller/**`, `src/server/storage/**` |
| `.claude/rules/e2e.md` | `e2e/**`, `playwright.config.ts` |

## Al recibir un encargo delegado

- Trabajar solo en los archivos que nombra el encargo. Si hace falta tocar otro, detenerse y reportarlo en vez de ampliarlo.
- No cambiar firmas exportadas ni comportamiento fuera del alcance pedido.
- No agregar dependencias nuevas sin que el encargo lo autorice.
- Si una prueba existente se rompe, detenerse y reportarlo: no borrarla ni ajustarla para que pase.
- Terminar con un resumen archivo por archivo: qué cambió, qué se verificó y qué quedó pendiente.

## No negociable

1. Nunca más de 1 bici por bloque ni más de 4 reservas por día: la garantía vive en la base (índice único parcial + locks), no solo en la UI.
2. `pnpm db:migrate` solo contra la base del workspace; la app nunca migra al arrancar ni contra producción.
3. Nunca borrar reservas: se cambia `status`.
4. Nunca commitear secretos ni `.env`; nunca registrar correos, teléfonos ni tokens sin redactar.
5. Nunca editar a mano `drizzle/` (se regenera desde el esquema); nunca `drizzle-kit generate --custom`.
6. No construir nada de los No-Objetivos de `blueprint.md` §1 (pago en línea, cuentas de clientes, reprogramación, E2E con navegador fuera de `/taller`, feriados 2027 inventados) ni de la cerca de FASE1 §2.4 (inventario, caja/POS, proveedores, códigos de barra, Strava/kilómetros, asistente de WhatsApp, multi-sucursal).
7. Nunca marcar una tarea como hecha con una compuerta fallando, ni editar un comando de Verify para que pase.
8. `branch_id` NOT NULL en toda tabla de operación nueva.
9. Nunca borrar una orden, línea, componente, aprobación ni foto de informe: se marcan con `voided_at`.
10. Saldo cero antes de `entregada` y control de calidad antes de `lista_para_retirar`: garantizados por CHECK en la base.
11. Token de aprobación de un solo uso, guardado como hash; nunca en claro.
12. El mecánico nunca cambia un precio: el servidor responde 403.
13. La recepción y el control de calidad se prueban en tablet (spec de Playwright + tablet real) antes de darse por hechos.

Arquitectura completa, fronteras y tokens de diseño: `CLAUDE.md` en este mismo directorio.
