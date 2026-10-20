# Paso 5 — pipeline GEO sobre SCW

## Recorrido implementado

```text
Consulta + canal de origen + empresa + tarea opcional
    → interpretar tarea
    → extraer términos de búsqueda
    → recuperar conocimiento público de esa empresa
    → complementar con los dominios SCW pertinentes
    → preparar contexto y formato de respuesta
    → router Claude → ChatGPT → otras IA futuras
    → registrar tarea, estado, fuentes y resultado en PostgreSQL
```

La interpretación es local y determinista, sin una llamada adicional a un modelo.
La tarea explícita prevalece sobre la detección automática por patrones ES/EN.
El patrón adapta el procesamiento de SCW al conocimiento empresarial y a tareas GEO;
no ejecuta los ocho pasos de diagnóstico y propuesta de consultoría del original.

| Tarea | Propósito | Formato preparado |
| --- | --- | --- |
| answer | Resolver una consulta concreta | direct_answer |
| company_profile | Preparar un perfil de la empresa | company_profile |
| catalog | Organizar productos y servicios | catalog_list |
| faq | Preparar preguntas y respuestas | faq_pairs |
| geo_content | Preparar contenido empresarial para IA | geo_brief |

Estos formatos indican qué se solicita al proveedor. La salida actual sigue siendo
texto; los contratos estructurados de entrega por plataforma pertenecen al paso 7.

## Conocimiento y contexto

Se buscan términos de la consulta usando el recuperador PostgreSQL existente.
Para perfil, catálogo, FAQ y contenido GEO también se cargan dominios SCW de la
empresa seleccionada, como `company_profile` y `products_services`, y evidencias
vigentes. Las coincidencias de búsqueda tienen prioridad sobre el contexto general.
Documento y fragmento deben ser públicos y su vínculo empresarial debe estar activo.

Se eliminan duplicados por ID de fragmento y se usan hasta cinco fragmentos con
un máximo de 12000 caracteres de contenido. Si es necesario se recorta el último
fragmento manteniendo identificadores y procedencia. El límite es de caracteres
de contenido, no un cómputo exacto de tokens ni del tamaño total de la petición.

El prompt contiene instrucciones por tarea seguidas de un objeto JSON de datos:
consulta, tarea, formato y contexto. Las consultas y documentos se tratan como datos.
La clasificación reconoce patrones comunes; no ofrece comprensión universal ni
traducción automática. La búsqueda textual sigue usando configuración española.

## Uso desde Ubuntu

Tras importar la empresa de demostración:

```bash
.venv/bin/python -m geo_engine.cli ingest-company demo_company --workspace fixtures/scw_demo
.venv/bin/python -m geo_engine.cli geo "¿Qué servicios ofrece Aurora?" --company demo_company
.venv/bin/python -m geo_engine.cli geo "Prepara preguntas frecuentes" --company demo_company --task faq --origin perplexity
```

Por defecto sólo planifica. Sin proveedor configurado devuelve `no_provider`, junto
con la tarea detectada, el contexto seleccionado y sus referencias. La ejecución
real requiere modelos y credenciales; `--execute` puede generar cargos.
El comando `route` anterior sigue disponible y también admite `--task`.

## Entrada para sistemas IA

```bash
curl --fail http://127.0.0.1:8000/v1/geo
curl --fail http://127.0.0.1:8000/v1/geo/plan \
  -H 'Content-Type: application/json' \
  -d '{"query":"Prepara preguntas frecuentes","company_id":"demo_company","task":"faq","origin":"perplexity"}'
```

`company_id` es obligatorio en esta nueva entrada. `task` admite `auto` o las cinco
tareas de la tabla. `origin` identifica al sistema o canal de origen y no cambia
prioridades ni concede permisos. `origin=perplexity` etiqueta al buscador; no es
una selección de proveedor ni una llamada de búsqueda. No hay conexión activa
con Perplexity. El endpoint planifica y nunca llama a proveedores.
La API local anterior `/v1/router/plan` conserva compatibilidad y acepta task.

## Registro y alcance

La respuesta y `show-run` incluyen `pipeline`: versión, tarea, formato solicitado,
motivo de selección, cantidad de fragmentos, caracteres usados y fase alcanzada.
Esos metadatos se guardan en PostgreSQL sin consulta, términos de búsqueda ni prompt.
La incorporación del campo es aditiva; las ejecuciones anteriores conservan `{}`.

Este paso se prueba con proveedores simulados. No activa conexiones de cuentas,
no publica datos en Internet y no incluye revisión de citas ni aprobación editorial.

Validación del paso 5: 100 pruebas aprobadas en Ubuntu/PostgreSQL, incluyendo
clasificación ES/EN, prioridad de coincidencias pertinentes, tareas por empresa,
contexto público, contratos HTTP/CLI y metadatos persistidos sin consultas ni prompts.
