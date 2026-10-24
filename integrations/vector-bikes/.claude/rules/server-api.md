---
description: Handlers HTTP, páginas de servidor, sesión, permisos y chequeos de seguridad
paths:
  - "src/server/api/**"
  - "src/server/auth/**"
  - "src/pages/api/**"
  - "src/pages/admin/**"
  - "src/pages/reservas/**"
  - "src/pages/taller/**"
  - "src/pages/aprobacion/**"
  - "src/pages/informe/**"
  - "src/server/taller/**"
  - "src/server/storage/**"
---

# API y servidor

- Las páginas y endpoints son envoltorios: parsean, llaman a `src/server/**` y devuelven su resultado. Sin SQL en `src/pages/**`.
- Error siempre `{ error, code, fields? }` con los códigos `validation_error` 422, `turnstile_failed` 403, `slot_unavailable`/`phone_limit` 409, `rate_limited` 429 (`Retry-After`), `internal_error` 500.
- Éxito de `POST /api/reservas`: 201 `{ code, service_date, start, end, mode, fee }`, sin envoltorio.
- Orden en `POST /api/reservas`: rate limit → zod → Turnstile → transacción → correos post-commit (un fallo de correo nunca cambia el 201).
- Todo POST de admin y de `/taller` (login, logout, formularios, subida de fotos) llama `isAllowedOrigin(request)` antes de leer el cuerpo: ahí protege una sesión con cookie.
- El POST de `/reservas/cancelar` **no** chequea `Origin`: el token del correo es la defensa contra CSRF (no es adivinable, vive como HMAC en base, deja de servir al empezar la reserva y al usarse). Exigir `Origin` rompía la cancelación desde visores de correo, que mandan otro origen o ninguno. Registra el origen recibido con `originForLog(request)` para tener visibilidad, nunca para decidir.
- `/aprobacion/[token]` e `/informe/[token]` siguen la misma regla que la cancelación: el token es la defensa, sin chequeo de `Origin`, con `originForLog`. Tokens de 32 bytes base64url guardados como sha256 hex; solo el primer nombre del cliente; nunca teléfono, correo ni RUT.
- Toda página de `/admin` y `/taller` empieza con `requireAdmin(...)`; si devuelve `null`, 303 a `loginRedirect(ruta)` (`/admin/login?next=…`). Después `can(user.role, acción)`; sin permiso, `forbiddenResponse()` (403). El mecánico recibe 403 en `/admin/**`. Nunca confiar solo en middleware.
- El permiso se revisa en el servidor en cada handler, también en los POST. El mecánico que intenta cambiar un precio recibe 403 y no cambia ninguna fila.
- `/api/tareas/*`: `Authorization: Bearer <TASKS_SECRET>` comparado en tiempo constante con `isAuthorizedTask` de `src/server/api/task-handlers.ts`. Sin cabecera, con un valor distinto o sin secreto configurado: 401 `{"ok":false,"error":"unauthorized"}` y log `tasks.unauthorized` sin IP ni datos personales.
- Respuestas con datos personales o sesión: `cache-control: no-store`; páginas admin, taller, cancelación, aprobación e informe con `noindex`; aprobación e informe además con `referrer-policy: no-referrer`.
- Fotos y firmas se sirven solo por `/taller/media/[...key]` (sesión + acceso a la orden, `cache-control: private, max-age=300`) o, las del informe, incrustadas en `/informe/[token]`. Nunca una URL pública del almacenamiento.
- Tokens (cancelación, sesión, aprobación, informe) en base solo como hash; comparar claves con `timingSafeEqual`.
- Logs vía `src/lib/log.ts`; nunca `console.log` de objetos con correo, teléfono, RUT o tokens.
