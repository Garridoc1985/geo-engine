# Router de IA — primer incremento

## Contrato

Una consulta normalizada contiene `query` (texto de hasta 4000 caracteres) y `origin`
(etiqueta de la IA de origen, por ejemplo `claude`, `chatgpt`, `perplexity` u otra).
El servidor genera un `request_id`. La etiqueta origin no concede permisos ni fija
el proveedor de destino. En esta versión solo se admite texto y evidencia pública.
También admite `company_id` y `task` (`auto` por defecto). El paso 5 prepara tareas
y contexto antes de elegir proveedor; ver [pipeline GEO](PIPELINE-GEO.md).

La recuperación PostgreSQL usa búsqueda textual española sobre fragmentos; exige
que documento y fragmento sean públicos. Devuelve hasta cinco evidencias ordenadas
por relevancia, con fuente e identificadores. Es coincidencia textual, no evaluación
semántica de suficiencia ni validación automática de afirmaciones.

El router ordena los proveedores elegibles como Claude → ChatGPT → Perplexity;
los adaptadores adicionales registrados quedan después. Se requiere tanto modelo
configurado como credencial para considerar un proveedor disponible. No se verifica
el acceso real a la cuenta hasta ejecutar una petición.

## Uso local sin consumir APIs

```bash
.venv/bin/python -m geo_engine.cli route "diagnóstico comercial" --origin perplexity
```

Con evidencia y un proveedor configurado: `status=ready`. Sin proveedor configurado:
`status=no_provider`. Sin coincidencias públicas: `status=insufficient_evidence`,
texto «información insuficiente» y ninguna llamada a un proveedor.

API local, con el backend iniciado:

```bash
curl --fail http://127.0.0.1:8000/v1/router
curl --fail http://127.0.0.1:8000/v1/router/plan \
  -H 'Content-Type: application/json' \
  -d '{"query":"diagnóstico comercial","origin":"perplexity"}'
```

Este endpoint solo planifica: rechaza `execute`, `principal`, evidencia y parámetros
arbitrarios. No tiene autenticación productiva ni se expone fuera de loopback.

## Ejecución explícita

Configurar por entorno las parejas `CLAUDE_MODEL`/`ANTHROPIC_API_KEY`,
`OPENAI_MODEL`/`OPENAI_API_KEY`, `PERPLEXITY_MODEL`/`PERPLEXITY_API_KEY`.
No se fijan modelos concretos ni se cargan automáticamente archivos `.env`.
Las credenciales nunca se imprimen en la respuesta ni se guardan en el repositorio.

```bash
.venv/bin/python -m geo_engine.cli route "diagnóstico comercial" --execute
```

`--execute` envía la consulta y su evidencia pública al primer proveedor disponible
y puede generar cargos. No se realizó ninguna llamada pagada durante el desarrollo.
Para permitir el siguiente proveedor tras un fallo temporal, añadir `--allow-fallback`.
Sin esa opción se detiene ante el primer error. Errores permanentes no activan fallback.

Un resultado `draft` contiene texto generado que requiere revisión; no certifica sus
afirmaciones ni sus citas. La lista `sources` identifica evidencia entregada al modelo,
no una prueba de que cada afirmación o cada referencia de su salida sea correcta.
La respuesta incluye proveedor, modelo, request_id y estados de los intentos.
La CLI y el router HTTP local guardan el registro en `router_runs` de PostgreSQL.
Las ejecuciones que generan guardan el borrador y sus vínculos a fragmentos en
`results` y `result_evidence`, dentro de la misma transacción de cierre.
Los planes no generan borradores ni consumen APIs.
Con `--execute`, la CLI devuelve código 2 si no pudo generar por falta de proveedor,
evidencia o por un error de API. Los errores de entrada/configuración devuelven 1.
Un plan sin proveedor configurado sigue siendo una planificación válida (código 0).

Detalles de endpoints y fuentes oficiales: [adaptadores HTTP](PROVEEDORES.md).

## Revisar ejecuciones guardadas

Usar el `request_id` devuelto por una consulta:

```bash
.venv/bin/python -m geo_engine.cli show-run ID_UUID_DE_LA_EJECUCION
```

Esta lectura es local y administrativa, no un endpoint público. Devuelve fechas,
proveedor/modelo, intentos, referencias, estado y texto de borrador cuando existe.
No se guardan la consulta original, el prompt completo ni claves de proveedores.
El borrador sí contiene la salida del modelo y debe tratarse como dato para revisión.

La reserva del ID ocurre antes de recuperar evidencia o llamar al proveedor. Un ID
existente se rechaza sin repetir la generación. Si el proceso se interrumpe puede
quedar `started`: revisar antes de lanzar otra consulta, porque el proveedor pudo
haber recibido la primera. No hay reanudación ni reintentos automáticos de esas filas.
Una pérdida de conexión después de generar no implica que no se haya consumido API.
La CLI imprime el ID por stderr antes de ejecutar; para automatizaciones se admite
`--request-id UUID_ESTABLE`. Reutilizarlo bloquea un segundo intento si ya se reservó.
Repetir un comando sin ese parámetro crea otro ID y constituye una ejecución nueva.

Las fuentes se revalidan al cerrar para comprobar que siguen siendo públicas y
coinciden sus referencias. Un fallo de persistencia revierte el borrador y sus
vínculos; se intenta marcar la ejecución como `failed` sin repetir la generación.
Si también falla esa conexión, la reserva permanece `started` para revisión.

El esquema se amplía de forma aditiva al iniciar la API o ejecutar la CLI. No se
eliminan tablas ni registros existentes. Conexiones y errores previos a reservar una
ejecución no tienen registro garantizado.

## Validación y límites

Las pruebas emplean transportes simulados: prioridad, proveedor omitido, corte al
primer éxito, fallback explícito, errores permanentes, salida vacía, falta de evidencia,
formatos de proveedor y exclusión de datos internos en el recorrido HTTP/PostgreSQL.
Validación del 19 de octubre de 2026: 54 pruebas aprobadas en Ubuntu/PostgreSQL,
incluyendo reserva única, guardado atómico, rollback, lectura local, revalidación
de fuentes y estados, y bloqueo de UUID repetido antes de llamar al proveedor.
La compatibilidad real con cuentas/modelos debe probarse cuando se configuren.
Pendientes: autenticación para ejecución remota, validación de citas/suficiencia,
revisión y aprobación editorial, más organizaciones, adaptadores de entrada y despliegue.

La entrada JSON es común para cualquier IA capaz de usar HTTP; no instala conectores
ni MCP automáticamente en las aplicaciones de Claude, ChatGPT o Perplexity.
