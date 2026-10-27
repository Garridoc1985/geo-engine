# Vector Bikes Test — contraste con la fuente pública

27 de octubre de 2026. Fuente revisada mediante el navegador: https://vectorbikes.cl/.

## Información observada

| Sección de la fuente | Información incorporada |
| --- | --- |
| Portada y `#como-funciona` | Taller de mecánica de bicicletas en Vitacura; descripción de lo solicitado por el cliente, revisión, diagnóstico y repuestos cotizados en el taller; aprobación de trabajos adicionales |
| `#retiro` | Retiro y devolución por $15.000, cobertura Vitacura y Las Condes; devolución coordinada por teléfono; pago al devolver y POS para tarjeta |
| `#reservar` | Recepción lunes a viernes 15:00–20:00 y sábados 10:00–14:00; retiros desde las 09:00 de lunes a viernes |
| `#como-funciona` y `#retiro` | Efectivo, transferencia o tarjeta al recibir la bicicleta terminada |
| `#taller` y pie de página | Avenida Kennedy 7666, Vitacura; teléfono +56 9 8509 5780; correo info@vectorbikes.cl; domingos y feriados cerrado |

La fuente permite describir la oferta pública de mecánica, diagnóstico/cotización
y retiro/devolución. En la portada revisada no hay un catálogo separado de
reparaciones por componente, marcas o especialidades: no se infieren servicios
específicos de frenos, suspensiones u otras especialidades desde la palabra mecánica.
Tampoco se infieren tarifas de reparación, garantías ni tiempos de entrega.

## Diferencia de entorno preservada

La web original muestra una interfaz de reservas. El sitio `vectorbikestest.cl`
mantiene su alcance informativo y deriva disponibilidad al taller. Copiar el
hecho de que la web original permite reservas no habilita esa funcionalidad en
el entorno de prueba. Las dos condiciones no se presentan como equivalentes.

## Estado de entrega

El contenido se incorpora al release público de GEO Engine y se sirve en HTML y
JSON. La página de servicios y el asistente usan esa misma versión. El dominio
canónico de la publicación de prueba se conserva en `vectorbikestest.cl`; los
enlaces a `vectorbikes.cl` se utilizan como fuentes, no como canonical de destino.
La existencia de estas páginas no demuestra posición, indexación ni citas externas.
