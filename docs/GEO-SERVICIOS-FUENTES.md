# Servicios: contenido limitado al código fuente

Fecha: 23 de octubre de 2026. Autorización del responsable: usar exclusivamente lo
que aparece en el código fuente.

| Contenido preparado | Evidencia en integrations/vector-bikes | Límite |
| --- | --- | --- |
| Diagnóstico y cotización en el taller | src/components/islands/BookingTicket.tsx; src/server/email/templates.ts | Sin precio de diagnóstico ni promesa de gratuidad |
| Contacto previo y decisión del cliente ante trabajos adicionales | src/lib/faq.ts; src/components/Landing.astro | Sin garantías, plazos ni reparaciones específicas añadidas |
| Retiro y devolución, $15.000, Vitacura y Las Condes | src/components/Landing.astro; src/lib/faq.ts; confirmación del dueño | No es el precio de una reparación |
| Revisión de recepción: frenos, cadena, transmisión, ruedas, neumáticos, estado general y problemas visibles | src/server/taller/rules.ts: INTAKE_CHECK_KEYS e INTAKE_CHECK_LABELS | Es una revisión de recepción; no servicios independientes ni paquetes comerciales |

El catálogo se obtiene de las tablas services y servicePrices mediante
src/server/taller/catalog.ts. No hay una semilla comercial fija en scripts ni drizzle
que permita publicar nombres, tarifas o plazos adicionales a partir del código.
No se consultó una base de negocio para esta tarea.

Exclusiones: datos de tests y e2e; copias de blueprints; categorías internas de
bicicletas como prueba de especialización; marcas, certificaciones, garantías y
reparaciones específicas no declaradas. Las categorías MTB, ruta, gravel, urbana
y e-bike del sistema no se convirtieron en promesas de capacidad técnica.

Se preparó /servicios en el build informativo y un enlace desde la portada.
El título y la descripción corresponden al contenido visible.

Estado vigente: el [PR #3](https://github.com/Garridoc1985/geo-engine/pull/3)
continúa en borrador y la [vista previa](https://deploy-preview-3--vectorbikestestgeo.netlify.app/)
es pública. El dominio definitivo aprobado es `vectorbikestest.cl`. La publicación
de esta versión en producción sigue pendiente por decisión expresa del usuario de
mantenerla en vista previa. La disponibilidad pública de la vista previa no acredita
indexación externa, descubrimiento por agentes ni citas medidas.

En la revisión del código del 23 de octubre se detectó que la portada conservaba
instrucciones para reservar bloques aunque las reservas en línea están deshabilitadas.
El FAQ visible y su JSON-LD también describían un enlace de cancelación por correo
y el bloqueo automático de feriados, funciones del sistema de reservas que no forma
parte de este despliegue informativo. La portada, la navegación de sus cuatro páginas
y el FAQ ahora dirigen las consultas al teléfono. El FAQ visible y el JSON-LD usan
la misma variante informativa; el flujo original conserva su formulario y textos.

Validación de esta corrección:

- Formato y chequeo estático aprobados: cero errores; permanecen dos advertencias
  CSS y 61 sugerencias de tipos preexistentes.
- Build original aprobado y sus 37 pruebas existentes aprobadas.
- Build público aprobado con cuatro páginas. Inspección de sus archivos locales:
  cinco preguntas y respuestas idénticas entre HTML y `FAQPage`, un `h1` por página,
  CTA de consulta en las cuatro páginas y ausencia de promesas de reservas en la portada.
- `LocalBusiness` conserva dirección, teléfono, correo y horarios aprobados.
  Canonicals del dominio definitivo; sitemap con inicio, servicios y privacidad.
  El asistente conserva `noindex` y queda fuera del sitemap.

Esta revisión no repite la batería de base de datos y backend ya documentada en
`integrations/vector-bikes/docs/VALIDACION-BACKEND-20261023.md`: no cambió esa lógica.
La comprobación del artefacto fue local, sin solicitudes HTTP anónimas, y no se
ejecutaron pruebas de tablet. El despliegue y la revisión visual se siguen en el PR.
