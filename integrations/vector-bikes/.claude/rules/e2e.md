---
description: Pruebas de tablet con Playwright
paths:
  - "e2e/**"
  - "playwright.config.ts"
---

# Pruebas de tablet (Playwright)

- Solo flujos de `/taller`. El sitio público no tiene E2E con navegador (No-Objetivo).
- Un solo proyecto, `tablet`: Chromium, 820×1180, `hasTouch`, `isMobile`, `deviceScaleFactor: 2`, `locale: es-CL`, `timezoneId: America/Santiago`. Los botones y opciones se presionan con `.tap()`.
- Sin capturas ni comparaciones de píxeles: se afirman textos, roles, URL y estados.
- Corre contra el build (`node dist/server/entry.mjs` en el puerto 4322): siempre `pnpm build` antes de `pnpm test:tablet`.
- Base de datos: solo la de `E2E_DATABASE_URL` (por defecto `vector_bikes_e2e`). `e2e/global-setup.ts` se niega si el nombre no termina en `_e2e`, la crea si falta, migra desde `drizzle/`, vacía todas las tablas de `public` y siembra con los ids fijos de `e2e/fixtures.ts`. Nunca la base de desarrollo.
- `e2e/**` y `playwright.config.ts` pueden leer `process.env`: son infraestructura de pruebas (excepción declarada a la regla 11 de `AGENTS.md`).
- Los specs ubican controles por rol y nombre accesible (`getByRole`, `getByLabel`); si un control no se encuentra así, el defecto está en la página, no en el spec.
- Imágenes de prueba: se generan en el spec con sharp (`sharp({ create: … }).jpeg().toBuffer()`), nunca archivos binarios en el repo.
- Cada spec es independiente: usa sus propias filas sembradas o crea las suyas, y no afirma números de orden nuevos exactos (usa `/OT-\d{5}/`).
- Los specs solo importan `@playwright/test`, `sharp` y `e2e/fixtures.ts`.
- `playwright.config.ts`, `e2e/global-setup.ts` y `e2e/fixtures.ts` los entrega el `workspace/` del blueprint: ningún paso los edita.
