# Adaptadores HTTP del router

19 de octubre de 2026. Cada adaptador envía una única petición de texto. El router
elige un proveedor elegible en el orden Claude → ChatGPT → otras IA futuras y decide si
corresponde fallback. Este módulo no hace reintentos ni llamadas a varios proveedores.

| Proveedor del router | API oficial | Clave | Modelo explícito |
| --- | --- | --- | --- |
| `claude` | `POST https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` | `CLAUDE_MODEL` |
| `chatgpt` | `POST https://api.openai.com/v1/responses` | `OPENAI_API_KEY` | `OPENAI_MODEL` |

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
Los adaptadores implementados de generación son `claude` y `chatgpt`; las otras IA
son una extensión futura. Perplexity queda fuera de esta selección.

## Contratos y límites

`HTTPProvider.generate(prompt)` devuelve texto o `ProviderError(code, retryable)`.
`available` solo comprueba configuración completa; no comprueba saldo o conectividad.
`HTTPProvider.check_model_access()` consulta `GET /v1/models/{model}` solo para
OpenAI. La CLI `check-provider --provider chatgpt` revisa configuración sin red ni
PostgreSQL; `--check-access` agrega esa consulta autenticada. Solo devuelve estado,
modelo, variables faltantes y códigos seguros; nunca imprime la clave. El estado
`model_accessible` verifica acceso a metadatos, sin garantizar saldo ni generación.
`--list-models` requiere solo la clave API y lista los identificadores visibles.
`--check-generation` prueba la generación con una frase sintética y solo devuelve
estado y longitud de salida; puede generar cargos y tampoco requiere PostgreSQL.
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
error HTTP, prompts ni claves. Las respuestas tienen límite de 2 MB. OpenAI
recibe `store: false`; eso controla visibilidad mediante recuperación,
no constituye una promesa de ausencia total de retención del proveedor.

No se habilitan herramientas web, MCP ni búsqueda externa en estos adaptadores.
El prompt debe llegar al adaptador después de la selección de evidencia pública
y los controles de acceso del router. No se envía evidencia interna mediante este
incremento. Las pruebas usan respuestas HTTP simuladas; no consumen APIs pagadas.

## Clasificación de Perplexity

Por decisión de producto del 20 de octubre de 2026, Perplexity es un buscador y
canal de descubrimiento futuro. No es un proveedor de generación del router y
no tiene adaptador `HTTPProvider`, selector `--provider` ni configuración de
modelo/clave para generación. No hay conexión de búsqueda activa ni un
adaptador de búsqueda implementado.

`origin=perplexity` se conserva como etiqueta de procedencia de una consulta.
Es independiente del proveedor que genere el borrador; no activa llamadas
al buscador. Una integración futura requerirá su propio contrato y validación.

Documentación oficial verificada el 19 de octubre de 2026:

- [Claude: API overview](https://platform.claude.com/docs/en/api/overview),
  [Messages: request and response](https://platform.claude.com/docs/en/build-with-claude/working-with-messages).
- [OpenAI: text generation](https://developers.openai.com/api/docs/guides/text),
  [Responses: create](https://developers.openai.com/api/reference/resources/responses/methods/create).
