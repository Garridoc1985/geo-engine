# GEO Engine — definición vigente y desarrollo habilitado

19 de octubre de 2026. Directiva explícita del propietario en esta conversación.
Este documento prevalece sobre el alcance inicial del sprint en caso de conflicto.

## Propósito

Preparar, verificar y entregar conocimiento empresarial para que sistemas de IA,
incluidos Claude, ChatGPT y Perplexity, puedan descubrirlo, recuperarlo y citarlo.
El consumidor objetivo es un sistema de IA. Una interfaz de preguntas para usuarios
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
Claude, ChatGPT o Perplexity. Cada canal deberá implementarse y validarse por separado.

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

Orden vigente: **Claude → ChatGPT → Perplexity → otras IA**.
Son familias de proveedores, no identificadores concretos de modelos API.

| Prioridad | Proveedor | Participación |
| --- | --- | --- |
| 1 | Claude | Primera opción para las consultas compatibles y autorizadas |
| 2 | ChatGPT | Segunda opción según compatibilidad y política de enrutamiento |
| 3 | Perplexity | Tercera opción según compatibilidad y política de enrutamiento |
| 4 | Otras IA | Adaptadores futuros posteriores a las tres prioritarias |

El router recibe consultas de distintos sistemas de IA, normaliza su formato,
identifica la tarea y los permisos, recupera evidencia autorizada y adapta el
mensaje y la respuesta al proveedor elegido. La IA que origina una consulta y el
proveedor que la procesa son conceptos independientes.

La prioridad se aplica entre proveedores elegibles. Una consulta no debe enviarse
a los tres automáticamente. No se asignan especialidades fijas por marca sin
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
