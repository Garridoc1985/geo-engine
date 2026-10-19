# Router de IA — primer incremento

## Contrato

Una consulta normalizada contiene `query` (texto de hasta 4000 caracteres) y `origin`
(etiqueta de la IA de origen, por ejemplo `claude`, `chatgpt`, `perplexity` u otra).
El servidor genera un `request_id`. La etiqueta origin no concede permisos ni fija
el proveedor de destino. En esta versión solo se admite texto y evidencia pública.

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
No persiste todavía el historial ni los borradores en PostgreSQL.
Con `--execute`, la CLI devuelve código 2 si no pudo generar por falta de proveedor,
evidencia o por un error de API. Los errores de entrada/configuración devuelven 1.
Un plan sin proveedor configurado sigue siendo una planificación válida (código 0).

Detalles de endpoints y fuentes oficiales: [adaptadores HTTP](PROVEEDORES.md).

## Validación y límites

Las pruebas emplean transportes simulados: prioridad, proveedor omitido, corte al
primer éxito, fallback explícito, errores permanentes, salida vacía, falta de evidencia,
formatos de proveedor y exclusión de datos internos en el recorrido HTTP/PostgreSQL.
La compatibilidad real con cuentas/modelos debe probarse cuando se configuren.
Pendientes: autenticación para ejecución remota, auditoría persistida, validación de
citas/suficiencia, más organizaciones, adaptadores de entrada específicos y despliegue.

La entrada JSON es común para cualquier IA capaz de usar HTTP; no instala conectores
ni MCP automáticamente en las aplicaciones de Claude, ChatGPT o Perplexity.
