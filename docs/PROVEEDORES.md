# Adaptadores HTTP del router

19 de octubre de 2026. Cada adaptador envía una única petición de texto. El router
elige un proveedor elegible en el orden Claude → ChatGPT → Perplexity y decide si
corresponde fallback. Este módulo no hace reintentos ni llamadas a varios proveedores.

| Proveedor del router | API oficial | Clave | Modelo explícito |
| --- | --- | --- | --- |
| `claude` | `POST https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` | `CLAUDE_MODEL` |
| `chatgpt` | `POST https://api.openai.com/v1/responses` | `OPENAI_API_KEY` | `OPENAI_MODEL` |
| `perplexity` | `POST https://api.perplexity.ai/v1/agent` | `PERPLEXITY_API_KEY` | `PERPLEXITY_MODEL` |

Las variables se definen en Ubuntu y no se imprimen ni guardan en el repositorio.
Una clave sin modelo, o un modelo sin clave, deja el adaptador no disponible.
La fábrica admite `only="chatgpt"` y la CLI `--provider chatgpt`: restringen la
selección sin construir los otros adaptadores. La etapa vigente inicia la
conexión API real exclusivamente con OpenAI; las pruebas automatizadas siguen
usando respuestas simuladas.
No se asumen modelos, suscripciones, saldo ni acceso de la cuenta. `chatgpt` es el
nombre de prioridad indicado por el propietario; la ejecución usa OpenAI API y su
facturación, no una sesión del producto ChatGPT.

El propietario debe elegir identificadores vigentes disponibles en sus cuentas.
En Perplexity, `PERPLEXITY_MODEL` corresponde al campo `model` de Agent API, no a un
preset ni a un nombre de suscripción. Agent API puede ejecutar modelos de terceros;
que el proveedor sea Perplexity no identifica por sí solo la familia del modelo.

## Contratos y límites

`HTTPProvider.generate(prompt)` devuelve texto o `ProviderError(code, retryable)`.
`available` solo comprueba configuración completa; no comprueba saldo o conectividad.
`HTTPProvider.check_model_access()` consulta `GET /v1/models/{model}` solo para
OpenAI. La CLI `check-provider --provider chatgpt` revisa configuración sin red ni
PostgreSQL; `--check-access` agrega esa consulta autenticada. Solo devuelve estado,
modelo, variables faltantes y códigos seguros; nunca imprime la clave. El estado
`model_accessible` verifica acceso a metadatos, sin garantizar saldo ni generación.
La configuración y el recorrido real están en [integración OpenAI](INTEGRACION-OPENAI.md).
La respuesta Responses se recorre por elementos `message` y bloques `output_text`;
no se asume que el primer elemento sea texto ni se usa la comodidad de SDK
`output_text`, porque el transporte trabaja con JSON HTTP.

Se usa un tiempo máximo de 30 segundos y hasta 2048 tokens de salida por defecto.
Ambos se pueden fijar al crear el adaptador. Una respuesta incompleta o una negativa
del proveedor detiene esa ejecución con error no reintentable, evitando convertir
una negativa en intentos sucesivos con otros modelos. La red y HTTP 408, 429 y 5xx
son errores transitorios; el router conserva la decisión final sobre fallback.

Solo hay destinos HTTPS oficiales fijados en código. Los redirects están
bloqueados para no reenviar claves a otro destino. No se registran cuerpos de
error HTTP, prompts ni claves. Las respuestas tienen límite de 2 MB. OpenAI y
Perplexity reciben `store: false`; eso controla visibilidad mediante recuperación,
no constituye una promesa de ausencia total de retención del proveedor.

No se habilitan herramientas web, MCP ni búsqueda externa en estos adaptadores.
El prompt debe llegar al adaptador después de la selección de evidencia pública
y los controles de acceso del router. No se envía evidencia interna mediante este
incremento. Las pruebas usan respuestas HTTP simuladas; no consumen APIs pagadas.

## Decisión de Perplexity

Para proyectos nuevos, la documentación vigente recomienda Agent API. El soporte
de Sonar Chat Completions terminó el 27 de septiembre de 2026; sus solicitudes
síncronas antiguas se reformulan gradualmente como Agent API. Por eso no se adopta
el endpoint heredado `/chat/completions` ni `/v1/sonar`. El endpoint usado es
`/v1/agent`, que acepta `model`, `input`, `max_output_tokens` y `store`, y devuelve
una lista tipada `output` compatible con Responses.

Documentación oficial verificada el 19 de octubre de 2026:

- [Claude: API overview](https://platform.claude.com/docs/en/api/overview),
  [Messages: request and response](https://platform.claude.com/docs/en/build-with-claude/working-with-messages).
- [OpenAI: text generation](https://developers.openai.com/api/docs/guides/text),
  [Responses: create](https://developers.openai.com/api/reference/resources/responses/methods/create).
- [Perplexity: Agent API](https://docs.perplexity.ai/docs/agent-api/quickstart),
  [compatibilidad Responses](https://docs.perplexity.ai/docs/agent-api/openai-compatibility),
  [migración desde Sonar](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).
