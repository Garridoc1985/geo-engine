---
description: Motor de agenda, zonas horarias y escritura concurrente de reservas
paths:
  - "src/server/booking/**"
  - "src/data/**"
---

# Motor de reservas

- Zona única: `America/Santiago` (constante `TIMEZONE` de `rules.ts`). Horas de negocio como texto `HH:MM` local; conversión a instantes solo con luxon en `slots.ts`.
- Nunca sumar 24 horas a un instante para "mañana": usar `addDays` sobre fechas locales.
- Una hora local inexistente (cambio de horario) devuelve `null` en `localToInstant` y no genera bloque.
- Funciones puras con `now: Date` inyectado; prohibido `new Date()` o `Date.now()` dentro de la lógica.
- La disponibilidad es consultiva; `createBooking` revalida todas las reglas dentro de la transacción (horario, feriado, bloqueos, antelación 120 min, horizonte 30 días, tope 4, teléfono).
- Orden de locks fijo: `booking_days` (`FOR UPDATE`) → `pg_advisory_xact_lock(hashtext(phone))`. Nunca al revés.
- Nada de red ni correos dentro de la transacción; se notifica después del commit.
- Violación única (`isUniqueViolation`) → `slot_unavailable`, nunca 500.
- `retiro` ocupa 2 bloques consecutivos y cuenta como 1 de las 4 reservas del día.
- Feriados solo desde `src/data/feriados-cl.json`; nunca inventar años no publicados.
