# GEO Engine — definición vigente y desarrollo habilitado

19 de octubre de 2026. Directiva explícita del propietario en esta conversación.
Clasificación de Perplexity actualizada el 20 de octubre de 2026.
Este documento prevalece sobre el alcance inicial del sprint en caso de conflicto.

## Propósito

### Precisión vigente del propietario — capa GEO

GEO Engine desarrolla una capa backend evolutiva para la visibilidad de empresas
en respuestas de IA. El conocimiento se entrega mediante HTML, CMS o servidor de
la empresa; el primer destino de descubrimiento es ChatGPT, y otros se incorporan
según necesidades. El destinatario comercial es la empresa; el consumidor técnico
del contenido publicado es el motor IA. SEO tradicional y Google Ads no forman
parte del producto solicitado. La reutilización de HTML, metadatos y rastreo es
infraestructura de entrega; no cambia ese alcance de producto.

La conexión de salida a OpenAI genera o evalúa borradores. Sus pruebas exitosas no
verifican que ChatGPT encuentre, cite o recomiende contenido en búsquedas externas.
El router de generación auxiliar conserva su prioridad; no define el orden de
desarrollo de canales de descubrimiento. No se publican borradores automáticamente.

Primera superficie implementada: proyección pública por empresa en HTML y JSON,
manifest de versión, sitemap y configuración de rastreo. Vista loopback con lectura
vigente de PostgreSQL por petición; exportación portable a un release nuevo para
integración posterior en el sitio/CMS. Fuentes web obligatorias, documentos y
fragmentos públicos activos con ACL vacía. Detalle en `PUBLICACION-GEO.md`.

Automatización vigente: regeneración de la proyección al leer la vista local y
construcción determinista al ejecutar `publish-company`. El despliegue automático
desde GitHub y los adaptadores de escritura a CMS aún no están implementados.
Requieren destino y credenciales de despliegue propios, separados de OpenAI.

Preparar, verificar y entregar conocimiento empresarial para que sistemas de IA,
como Claude y ChatGPT, y buscadores como Perplexity, puedan descubrirlo, recuperarlo
y citarlo. Perplexity se clasifica como buscador y canal de descubrimiento del
producto; no participa como proveedor de generación. Su conexión de búsqueda es
futura y todavía no está implementada.
El consumidor objetivo es un sistema de IA o un canal de descubrimiento. Una interfaz de preguntas para usuarios
no constituye el producto ni es necesaria para iniciar su desarrollo.

La información debe representar hechos de la empresa y conservar fuentes. No se
pretende dar instrucciones a motores externos para que recomienden a la empresa,
ni afirmar que exponer un endpoint garantiza indexación, citas o recomendaciones.

## Autorización de arquitectura

```yaml
execution_mode: active_development
permissions:
  implement_code: true
  modify_architecture: true
  develop_publication: true
  develop_ai_adapters: true
architecture_freeze: inactive
```

Estos permisos corresponden exclusivamente a geo-engine. No modifican las reglas
del repositorio de origen. Ningún freeze o prohibición de implementar de SCW se
hereda. Se pueden evolucionar código, esquema, contratos, arquitectura y plan.
No requieren un ADR o playbook de SCW para comenzar.

Los controles de acceso, exclusión de datos internos y gestión de secretos se
mantienen. Habilitar desarrollo de publicación no publica datos en Internet ni
crea conexiones con proveedores por sí solo.

## Arquitectura objetivo

```text
Fuentes empresariales → ingesta → PostgreSQL → validación y procedencia
                                             ↓
                                 selección de contenido publicable
                                             ↓
                       salidas web y datos legibles por máquinas
                                             ↓
                       descubrimiento / herramientas de sistemas IA
                                             ↓
                                 medición con evidencia observable
```

Separar dos vías: contenido web público para descubrimiento y adaptadores/herramientas
para acceso explícito de agentes. Un endpoint propio no instala una integración en
Claude o ChatGPT, ni una conexión con el buscador Perplexity. Cada canal deberá
implementarse y validarse por separado.

## Primer desarrollo alineado

1. Exponer un catálogo público JSON local con IDs y referencias de fuente.
2. Excluir documentos y fragmentos internos antes de serializar cualquier contenido.
3. Preparar después páginas públicas canónicas, metadatos y procedencia verificable.
4. Diseñar adaptadores para agentes según capacidades verificadas de cada proveedor.
5. Medir accesibilidad, recuperación y citas observadas sin prometer posicionamiento.

El endpoint inicial es de desarrollo y usa el catálogo sintético de una sola empresa.
No es publicación web, integración con proveedores ni aprobación editorial automatizada.
La exposición externa requiere decidir dominio, despliegue y datos aprobados.

## Router de IA — jerarquía indicada por el propietario

Orden vigente: **Claude → ChatGPT → otras IA futuras**.
Es la prioridad de proveedores de generación auxiliar, no de canales de
descubrimiento ni de modelos API concretos. Perplexity queda fuera de este router.

| Prioridad | Proveedor | Participación |
| --- | --- | --- |
| 1 | Claude | Primera opción para las consultas compatibles y autorizadas |
| 2 | ChatGPT | Segunda opción según compatibilidad y política de enrutamiento |
| 3 | Otras IA futuras | Adaptadores de generación que se incorporen después de Claude y ChatGPT |

El router recibe consultas con una etiqueta de origen, normaliza su formato,
identifica la tarea y los permisos, recupera evidencia autorizada y adapta el
mensaje y la respuesta al proveedor elegido. El sistema o buscador de origen y el
proveedor de generación son conceptos independientes. `origin=perplexity` registra
el buscador de origen; no selecciona Perplexity para generar ni inicia búsquedas.

La prioridad se aplica entre proveedores elegibles. Una consulta no debe enviarse
a varios proveedores automáticamente. No se asignan especialidades fijas por marca sin
verificar capacidades. El cambio de proveedor ante un error o incompatibilidad
se regirá por una política explícita, preservando confidencialidad y trazabilidad.

Registrar por ejecución: ID de consulta, proveedor/modelo seleccionado, motivo de
selección, IDs de evidencia, estado y fallos. No registrar secretos ni contenido
interno completo en logs.

Implementados contrato de consulta de texto, recuperación pública, router,
adaptadores HTTP configurables y fallback explícito ante fallos temporales.
Las pruebas no consumen APIs externas. La ejecución real requiere credenciales y
modelos concretos por entorno. Ver `ROUTER.md` para estado y límites.

Las ejecuciones ya se registran en PostgreSQL sin guardar consulta/prompt original;
los borradores y vínculos a evidencia se guardan atómicamente. Un ID de ejecución
reservado no puede reutilizarse para volver a consumir un proveedor.

## Desarrollo funcional sobre SCW

El propietario descarta el incremento de revisión de citas y prioriza el desarrollo
de GEO Engine sobre SCW. Se adapta su cargador de conocimiento empresarial al runtime:
perfil, productos/servicios, dominios y evidencias alimentan PostgreSQL y el router.
La recuperación admite `company_id` y mantiene los documentos internos excluidos.
Ver `DESARROLLO-SOBRE-SCW.md` para ejecutar el recorrido con una empresa ficticia.

El paso 5 está implementado en `pipeline.py`: interpreta la tarea, extrae términos,
recupera contexto público empresarial y prepara las instrucciones/formato antes
del router. Los metadatos se registran en PostgreSQL. Ver `PIPELINE-GEO.md`.

Actualización del 20 de octubre de 2026: se incorpora ingesta de revisiones
inmutables con activación transaccional del snapshot empresarial mediante
`ingest-company --allow-revisions`. No requiere cambiar el esquema PostgreSQL;
las revisiones se representan en IDs derivados del contenido y la fuente.
Contrato y límites en `ACTUALIZACION-CONOCIMIENTO.md`.


Incremento del 20 de octubre: `web_reader.py` incorpora captura explícita de URLs
públicas HTTPS a snapshots SCW revisables. Usa conexión fijada a una IP global
validada y TLS del dominio, sin redirecciones, cookies, crawling ni escritura en
PostgreSQL. La importación continúa siendo explícita y de empresa completa.
Ver `LECTOR-WEB-PUBLICA.md`; no se incorpora scheduler ni despliegue CMS.


Incremento de sincronización del 20 de octubre: `sync-catalog` aplica snapshots web
cerrados por empresa y ámbito. Namespace propio de IDs, sin migración de esquema;
previsualización con rollback por defecto y activación transaccional explícita.
Conserva fuentes manuales y otros ámbitos. La ingesta SCW ya no desactiva ámbitos
sincronizados. No se añade scheduler ni despliegue. Contrato en
`SINCRONIZACION-CATALOGO.md`.
