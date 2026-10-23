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
El título y la descripción corresponden al contenido visible. La página conserva
noindex durante la revisión; el sitio no se abrió a rastreadores en este paso.
Actualización desplegada: `6adb91abb0ed644d09a3c087`, estado ready confirmado por
Netlify. Portada y /servicios comprobadas en navegador autenticado; en viewport
1366 px, /servicios tiene contenido de 1351 px sin desbordamiento y cero formularios.
Se mantiene la protección privada y noindex. Pendiente: autorizar la habilitación
pública e indexación de las páginas aprobadas. No se afirma visibilidad ni citas medidas.
