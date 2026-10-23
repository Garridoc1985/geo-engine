# Vector Bikes

Sitio y reservas en línea del taller de bicicletas Vector Bikes (Av. Kennedy 7666, Vitacura): landing Astro, isla Preact de reserva, API, panel `/admin`, recordatorios y el área interna `/taller` (recepción en tablet, órdenes de trabajo, historial), en Replit.

## Comandos

| Tarea | Comando |
|---|---|
| Instalar | `pnpm install --frozen-lockfile` |
| Dev | `pnpm dev` — http://localhost:4321 |
| Formatear | `pnpm format` |
| Chequeo estático | `pnpm check` (biome ci + astro check + tsc --noEmit) |
| Tests unit + integración | `pnpm test` · un archivo: `pnpm test tests/unit/slots.test.ts` |
| Build | `pnpm build` |
| Tests sobre el build | `pnpm test:build` (requiere `pnpm build` antes) |
| Tests de tablet (Playwright, solo `/taller`; existe desde F1-06) | `pnpm test:tablet` · un archivo: `pnpm test:tablet e2e/login.spec.ts` (requiere `pnpm build` antes y Postgres local) |
| Navegador de Playwright | `pnpm exec playwright install chromium` (solo en el Mac; nunca en el build de Replit) |
| Smoke del servidor | `pnpm smoke` (= `sh scripts/smoke.sh`) |
| Compuerta completa | `pnpm gate` = check + test + build + test:build + smoke; `test:tablet` entra a la compuerta desde F1-06, el paso que la agrega (nunca `pnpm ci`: es un comando propio de pnpm) |
| Generar migración | `pnpm db:generate` |
| Aplicar migraciones (solo base dev) | `pnpm db:migrate` |
| Verificar base | `pnpm db:check` |
| Clave del dueño | `ADMIN_EMAIL=… ADMIN_PASSWORD=… pnpm admin:set-password` (escribe en `users`, rol dueño) |
| Recordatorios (respaldo manual) | `pnpm reminders:send` |

**Compuerta:** `pnpm gate` pasa antes de marcar cualquier tarea como hecha y antes de publicar. Antes de cada Verify, `pnpm format`.

Node 24 (`.nvmrc`), pnpm 12.4.2. La versión de pnpm se fija en el `build` de `[deployment]` en `.replit` (`corepack pnpm@12.4.2 …`), no en `packageManager`: Replit reescribe `package.json` al publicar y, si el campo existe, su instalación con pnpm 10 intenta autoinstalar pnpm 12 y aborta. No agregues `packageManager` a `package.json`. Las versiones exactas están en `pnpm-lock.yaml`: léelo, no adivines.

## Estado del build

Orden de construcción de la fase 1: `blueprints/vector-taller-f1/tasks.json` (una tarea = un paso) y `blueprints/vector-taller-f1/epics/`. Decisiones: `blueprints/vector-taller-f1/blueprint.md`; definición de la fase: `blueprints/vector-taller-f1/FASE1.md`. `blueprints/vector-bikes/` es el registro del sitio ya terminado: solo lectura, salvo la única excepción de FASE1 §3.0 (paso F1-02). Diseño visual aprobado: `docs/design-preview.html`.

## Stack

Astro 7 (output server, @astrojs/node standalone) · TypeScript 6 · Preact (islas: reserva, firma, fotos) · Tailwind 4 + CSS portado del prototipo · Postgres 16 de Replit · Drizzle ORM · sesión propia sobre `users` con roles · Resend · Cloudflare Turnstile · sharp · @replit/object-storage · Playwright (solo `/taller`) · Replit Autoscale + cron externo (Make.com).

## Arquitectura

**Camino de una reserva.** navegador → `src/components/islands/BookingIsland.tsx` → `POST /api/reservas` (`src/pages/api/reservas.ts`, envoltorio) → `handleCreateBooking` en `src/server/api/handlers.ts` (rate limit → zod → Turnstile) → `createBooking` en `src/server/booking/create-booking.ts` (transacción: lock de `booking_days`, advisory lock por teléfono, revalidación con `src/server/booking/slots.ts`, insert de `bookings` + `booking_blocks`) → commit → `notifyBookingCreated` en `src/server/email/notifications.ts` → 201.

**Camino de una recepción.** tablet → `src/pages/taller/recepcion/nueva.astro` (POST) → `startReception` en `src/server/taller/orders.ts` (transacción: cliente y bici, número desde `branches.next_order_number`, orden `reservada`, historial y auditoría) → `/taller/ordenes/<id>/recepcion` (checklist, líneas, fecha) → `/taller/ordenes/<id>/cierre`: `PhotoCapture` sube cada foto a `src/pages/taller/ordenes/[id]/fotos.ts` (sharp → almacenamiento → fila) y `SignaturePad` deja la firma en el POST de cierre → `finalizeReception` en `src/server/taller/reception.ts` → `recibida`.

**Fronteras.**

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

**Dónde vive cada cosa.**

| Tema | Única fuente de verdad |
|---|---|
| Esquema | `src/server/db/schema.ts` (base, sucursal, usuarios) ← `schema-taller.ts` (auditoría, catálogo, clientes, bicis) ← `schema-orders.ts` (órdenes y lo que cuelga) ← `schema-reports.ts` (informe final) → `pnpm db:generate` → `pnpm db:migrate` |
| Conexión | `src/server/db/client.ts` (`getDb()`, tipo `AppDb`); los módulos reciben `db` como argumento |
| Entorno | `src/lib/env.ts` (accesores por funcionalidad); nunca `process.env` en otro lado |
| Reglas del negocio (reservas) | `src/server/booking/rules.ts` |
| Reglas del taller (estados, transiciones, checklists, capacidad, etiqueta) | `src/server/taller/rules.ts` |
| Permisos | `src/server/auth/permissions.ts` (`can(role, action)`) |
| Sesión | `src/server/auth/admin-auth.ts` (`requireAdmin`, `loginRedirect`) |
| Auditoría | `src/server/taller/audit.ts` (`recordAudit`, dentro de la transacción) |
| Almacenamiento de imágenes | `src/server/storage/storage.ts` (`getStorage()`); pipeline en `src/server/storage/images.ts` |
| Feriados | `src/data/feriados-cl.json` |
| Datos del taller | `src/lib/site.ts` |
| Tokens de diseño | `src/styles/global.css` (`:root`) |
| Logs | `src/lib/log.ts` |

## Reglas de código

1. Importaciones relativas con extensión `.ts`/`.tsx` explícita (`../db/client.ts`). Sin alias, sin barrels.
2. Nada de `enum`, `namespace` ni parameter properties (`erasableSyntaxOnly`): Node ejecuta `scripts/` quitando tipos.
3. Importaciones solo de tipos con `import type` (`verbatimModuleSyntax`).
4. La lógica de `src/server/**` recibe `db: AppDb` y `now: Date`; nunca `new Date()` dentro de la lógica.
5. Toda entrada externa pasa por zod antes de tocar `src/server/**`.
6. Ningún correo, `fetch`, subida al almacenamiento ni espera larga dentro de una transacción.
7. Archivos < 400 líneas, funciones < 50 líneas. **Única excepción: `src/styles/global.css`** — es el diseño aprobado portado desde `docs/design-preview.html` y partirlo fragmentaría el sistema visual; su tamaño lo fija el prototipo, no el autor.
8. Textos para el usuario en español de Chile; identificadores en inglés.
9. Todo elemento no-void cerrado en `.astro` (Astro 7 falla si no).
10. `set:html` solo para el JSON-LD de `Base.astro`.
11. En `/taller` y `/admin`, cada página y endpoint: sesión (`requireAdmin`) → permiso (`can`) → zod → `src/server/taller/**`. El permiso se decide en el servidor; un botón oculto no es un permiso.
12. Primero se sube el objeto al almacenamiento, después se escribe la fila; si la fila falla, se borra el objeto.

## Sistema de diseño

Fuente: `docs/design-preview.html`. Monocromo, reglas de 1px, radio 2px, sin sombras.

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--ground` | #F6F6F4 | #0C0D0E | Fondo |
| `--surface` | #FFFFFF | #151618 | Controles, ticket |
| `--ink` | #0C0D0E | #F1F1EE | Texto, botón primario, foco |
| `--ink-2` | #2A2C2F | #C8C9CB | Texto secundario |
| `--steel` | #5A5E63 | #9C9FA4 | Etiquetas, ayudas |
| `--rule` | #D9D9D5 | #2B2D30 | Divisores (solo decorativos) |
| `--hatch` | #E3E3DF | #1E2022 | Rayado reservado/deshabilitado |
| `--on-ink` | #F6F6F4 | #0C0D0E | Texto sobre `--ink` |
| `--field-border` | = `--steel` | = `--steel` | Bordes de controles |

- **Tipos:** Michroma 400 (h1/h2, con moderación) · Archivo Variable 400/600, cuerpo 16px/1.55 · IBM Plex Mono 400/500, etiquetas .72rem mayúsculas tracking .14em, `tabular-nums`.
- **Botón primario:** `--ink` + `--on-ink`; **hover invierte** (fondo `--surface`, texto y borde `--ink`). Nav: `.nav a:not(.btn)`.
- **Formularios:** etiqueta arriba; `.fields{align-items:start}`, `.field{align-content:start}`.
- **Movimiento:** `--dur-fast` 140ms, `--dur` 160ms, máx. 250ms, `--ease: cubic-bezier(.2,.7,.2,1)`; `prefers-reduced-motion` → 0ms.
- **Layout:** `.wrap` máx. 1180px; objetivos táctiles ≥ 44px.
- **Área `/taller`:** mismos tokens, ningún hex nuevo; objetivos táctiles ≥ 48px; estados con forma + texto (nunca solo color); tablas densas con `tabular-nums`. Detalle en `.claude/rules/taller-ui.md`.

## Entorno

| Variable | Requerida desde | Usada por |
|---|---|---|
| `DATABASE_URL` | paso 2 | `client.ts`, scripts |
| `CANCEL_TOKEN_SECRET` | paso 4 | `tokens.ts` |
| `TURNSTILE_SECRET_KEY`, `SESSION_SECRET` | paso 5 | `handlers.ts` |
| `PUBLIC_WHATSAPP_NUMBER` (opcional) | paso 6 | `Base.astro` (build) |
| `PUBLIC_TURNSTILE_SITE_KEY` | paso 7 | `index.astro` (build) |
| `PUBLIC_SITE_URL`, `EMAIL_TRANSPORT`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `SHOP_NOTIFY_EMAIL` | paso 8 | correos, chequeo de Origin, QR y enlaces del taller |
| `RESEND_API_KEY` | paso 8, solo con `resend` | `transport.ts` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | solo el script | `admin-set-password.ts` |
| `WHATSAPP_*` (opcionales) | existentes | `src/server/whatsapp/**` |
| `CRON_SECRET` (≥ 32, opcional) | existente; vía `getCronEnv()` desde F1-02 | `src/server/whatsapp/cron.ts` |
| `TASKS_SECRET` (≥ 32) | F1-01 | `src/server/api/task-handlers.ts` (`/api/tareas/*`) |
| `E2E_DATABASE_URL` (opcional; por defecto `…/vector_bikes_e2e`) | F1-06 | `e2e/**`, `playwright.config.ts` |
| `STORAGE_DRIVER` (`local`/`replit`), `STORAGE_LOCAL_DIR`, `STORAGE_BUCKET_ID` | F1-08 | `src/server/storage/storage.ts` |

`.env.example` se commitea y se mantiene al día. En Replit, los valores reales van en *Secrets*.

## Reglas diferidas

| Archivo | Aplica a |
|---|---|
| `.claude/rules/database.md` | `src/server/db/**`, `drizzle/**`, `scripts/db-*.ts` |
| `.claude/rules/booking-engine.md` | `src/server/booking/**`, `src/data/**` |
| `.claude/rules/server-api.md` | `src/server/api/**`, `src/server/auth/**`, `src/pages/api/**`, `src/pages/admin/**`, `src/pages/reservas/**`, `src/pages/taller/**`, `src/pages/aprobacion/**`, `src/pages/informe/**`, `src/server/taller/**`, `src/server/storage/**` |
| `.claude/rules/ui-design.md` | `src/components/**`, `src/layouts/**`, `src/styles/**`, `src/pages/*.astro` |
| `.claude/rules/taller-ui.md` | `src/pages/taller/**`, `src/components/taller/**`, `src/layouts/TallerLayout.astro` |
| `.claude/rules/taller-domain.md` | `src/server/taller/**`, `src/server/storage/**` |
| `.claude/rules/e2e.md` | `e2e/**`, `playwright.config.ts` |

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

## Reparto con Codex

Me quedo con entender el problema, planear, decidir la arquitectura y revisar lo que vuelve. Esa parte no se delega.

La construcción repetitiva, los refactors grandes y los errores atorados se le pasan a Codex con el subagente `codex-rescue`, por mi cuenta, sin esperar que me lo pidan. Una tarea de `tasks.json` = un pase a Codex. Nunca dos pases a la vez: espero el resultado, lo leo y recién entonces sigo.

Codex lee `AGENTS.md`, no este archivo ni `.claude/rules/`. Por eso cada encargo incluye:

- La tarea de `tasks.json` y los archivos exactos que toca.
- La regla de `.claude/rules/` que aplica a esos archivos, nombrada por ruta para que la lea antes de empezar.
- Los puntos de "No negociable" que tocan esa tarea (siempre: no editar `drizzle/`, no migrar fuera de la base dev, no commitear secretos ni `.env`).
- Qué NO debe cambiar (firmas exportadas, otros módulos, el diseño aprobado).
- El cierre: `pnpm format`, el Verify de la tarea y `pnpm gate` en verde.

Antes de cada pase el árbol de git está limpio (commiteado). Si lo que vuelve está mal, se revierte con `git checkout .` y no se parcha encima.

Nada de lo que vuelve de Codex se da por bueno sin que yo lo revise y sin `pnpm gate` en verde. En cada pase cuento qué le pedí y qué volvió, en dos líneas.

Si Codex falla dos veces en la misma tarea, esa tarea vuelve a mí. No hay tercer intento: cuando algo se atora dos veces, lo que está mal es el encargo, no quién lo ejecuta.
