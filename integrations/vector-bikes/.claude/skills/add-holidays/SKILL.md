---
name: add-holidays
description: Cargar los feriados nacionales de Chile de un año nuevo (por ejemplo 2027) en Vector Bikes. Usar cuando el panel admin avisa que faltan feriados o cuando se publican los feriados oficiales del año siguiente.
---

# Agregar feriados de un año

## Cuándo usar
- `/admin` muestra "Las reservas llegan a <año> y ese año no tiene feriados cargados".
- Se publicaron oficialmente los feriados del año siguiente.

## Pasos
1. Obtener la lista oficial del año en dos fuentes (https://www.feriadoslegales.cl/ y https://festivos.online/chile/) y confirmar que coinciden. No inventar fechas. Si una fuente todavía no publica el año, reemplazarla por otra y anotar el cambio al reportar.
2. Revisar las fechas que no son fijas antes de copiarlas: Viernes y Sábado Santo salen de la Pascua; San Pedro y San Pablo (29 de junio) y Encuentro de Dos Mundos (12 de octubre) se corren al lunes anterior cuando caen martes (ley 19.668); el 31 de octubre se mueve solo si cae martes o miércoles (ley 20.299); el 17 de septiembre es feriado cuando el 18 y el 19 caen sábado y domingo (ley 20.983); el Día Nacional de los Pueblos Indígenas es el día del solsticio de invierno en hora de Chile (ley 21.357), que no siempre es el 21 de junio.
3. Agregar cada feriado a `src/data/feriados-cl.json` como `{ "date": "AAAA-MM-DD", "name": "…" }`, uno por línea y en orden cronológico.
4. Agregar en `tests/unit/slots.test.ts` una aserción con un feriado del año nuevo (`computeDay` devuelve `status: "holiday"`), con un `now` dentro de los 30 días de esa fecha: fuera del horizonte el día sale `closed` antes de mirar el feriado.
5. Correr `pnpm test` y actualizar **toda** aserción que dependa de que ese año faltaba. Hoy son dos: `missingHolidayYears` en `tests/unit/slots.test.ts` y `holidayWarning` en `tests/integration/admin-panel.test.ts`. Correrlas un año, y dejar fijado que el año recién cargado ya no avisa.
6. Ejecutar `pnpm gate`, hacer commit y publicar (los feriados viajan en el build).

## Verify
```bash
pnpm test                            # expect: exit 0, 0 failed
pnpm gate                            # expect: exit 0
```

## No hacer
- Cargar feriados regionales o no confirmados oficialmente.
- Borrar años anteriores del archivo.
- Acomodar una prueba que falle por otra razón que no sea el año recién cargado.
