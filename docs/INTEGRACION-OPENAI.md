# Primera integración API: OpenAI

19 de octubre de 2026. El propietario autorizó comenzar con APIs después de la
validación local. Se inicia con el proveedor `chatgpt`, que usa OpenAI Responses.
La prioridad automática Claude → ChatGPT → otras IA futuras se mantiene; estas pruebas
seleccionan exclusivamente ChatGPT. Perplexity se clasifica como buscador y
canal de descubrimiento futuro, sin conexión activa; queda fuera de la generación.

## Estado verificado

- El flujo simulado pasó 110 pruebas en Ubuntu con PostgreSQL.
- Tras incorporar el diagnóstico, la suite completa pasó 120 pruebas en Ubuntu
  con PostgreSQL; sus llamadas a modelos siguen siendo simuladas.
- La comprobación real `GET https://api.openai.com/v1/models` devolvió HTTP 401
  con la credencial disponible en el proceso Windows. No se guardó ni transfirió.
- Ubuntu no tenía `OPENAI_API_KEY` ni `OPENAI_MODEL` configurados.
- No se ha generado todavía un borrador con la API real. La credencial válida
  y el modelo explícito son necesarios para completar esa comprobación.

## Configurar en Ubuntu

Abrir una terminal Ubuntu en la carpeta del proyecto. Introducir la clave con
entrada oculta para evitar guardarla en el historial. La configuración vive solo
en esa sesión; no se escribe en archivos del repositorio. `.env` no se carga
automáticamente.

```bash
cd /mnt/c/Users/Usuario/Desktop/Postulaciones/geo-engine
read -r -s -p 'Clave API OpenAI: ' OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY
read -r -p 'Identificador del modelo habilitado: ' OPENAI_MODEL
export OPENAI_MODEL
export DATABASE_URL=postgresql:///geo_engine
```

La clave se crea o administra en el [panel oficial de OpenAI](https://platform.openai.com/api-keys).
No pegarla en el chat ni incorporarla al repositorio. Elegir un identificador
disponible para ese proyecto en el [catálogo oficial de modelos](https://developers.openai.com/api/docs/models).
No se adopta un modelo predeterminado sin configuración explícita.

## Diagnosticar antes de generar

```bash
.venv/bin/python -m geo_engine.cli check-provider --provider chatgpt
.venv/bin/python -m geo_engine.cli check-provider --provider chatgpt --check-access
```

El primer comando no usa red. Informa `configured` o `not_configured` y los nombres
de variables faltantes. El segundo, si la configuración está completa, realiza un
GET autenticado del modelo, sin enviar consulta ni conocimiento empresarial.
Ambos funcionan sin conexión PostgreSQL. Devuelven código de salida 0 cuando
su comprobación pasa y 2 si falta configuración o falla el acceso.

`model_accessible` confirma acceso a los metadatos de ese modelo; la generación
debe comprobarse aparte. `http_401` indica rechazo de autenticación; `http_404`
indica que ese modelo no está disponible para la solicitud. Los errores muestran
únicamente códigos seguros, sin cuerpos HTTP ni credenciales.

## Primera generación con empresa ficticia

Con PostgreSQL iniciado y el diagnóstico de acceso aprobado, importar el fixture
público y ejecutar una sola tarea:

```bash
.venv/bin/python -m geo_engine.cli ingest-company demo_company --workspace fixtures/scw_demo
.venv/bin/python -m geo_engine.cli geo 'Describe brevemente la empresa Aurora' \
  --company demo_company --task company_profile --provider chatgpt --execute
```

Esta ejecución sí utiliza la API y puede generar cargos. No activa fallback.
El router recupera únicamente evidencia pública de la empresa, construye el
prompt y guarda el borrador, las fuentes y el estado en PostgreSQL. El identificador
`request_id` permite consultar el registro con:

```bash
.venv/bin/python -m geo_engine.cli show-run UUID_DEVUELTO
```

El resultado esperado es `draft`, proveedor `chatgpt`, texto no vacío, fase
`provider_completed` y `recorded: true`. Un error de proveedor conserva su código
seguro en el registro, sin considerarse una generación validada. El servidor HTTP
local continúa ofreciendo planificación; la ejecución API se realiza desde la CLI.

Referencias verificadas en documentación oficial de OpenAI:
[consulta de modelo](https://developers.openai.com/api/reference/resources/models/methods/retrieve),
[Responses](https://developers.openai.com/api/reference/responses/overview) y
[configuración inicial](https://developers.openai.com/api/docs/quickstart).
