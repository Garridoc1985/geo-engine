# Vector Bikes Test — conocimiento público compartido

27 de octubre de 2026. Integración preparada para revisión, sin publicación en producción.

## Alcance

La página `/servicios/`, el paquete público `/geo/` y el backend `/api/asistente`
consumen el mismo snapshot exportado desde PostgreSQL mediante GEO Engine.
`src/lib/public-knowledge.ts` importa el JSON estáticamente: Netlify incluye los
datos en el bundle de la función sin leer archivos del servidor en cada petición.
La respuesta SSE identifica su snapshot mediante `X-Knowledge-Version`.

Selección: siete registros públicos de Vector Bikes con mecánica de bicicletas,
diagnóstico/cotización, contacto, horarios, retiro/devolución, medios de pago y
consultas de disponibilidad. Fuente contrastada: `VECTORBIKES-FUENTE-PUBLICA-20261027.md`. Se usan los
datos aprobados por el propietario el 23 de octubre y las condiciones publicadas.
La selección anterior del 19 de octubre mencionaba reservas en línea: se conservó
como historial inactivo y se sustituyó por la condición vigente del sitio de prueba.
No se incorporaron documentos internos, notas de clientes ni datos de Company Brain.

Versión SHA-256 del conocimiento:
`2ba9fd191e2638399c7f4fd1708f7390a53b6c86282689e7c9222b84b7f9a451`.
Esta versión es una huella de contenido, no una firma de aprobación editorial.

## Entrega y controles

Se versionan exclusivamente `public/geo/index.html`, `knowledge.json`,
`manifest.json` y `sitemap.xml`. El resto de la carpeta sigue excluido. Git
conserva sus bytes y Biome no los reformatea para no invalidar el manifest.

La compilación pública verifica hashes, versión, empresa, URL canónica y cantidad
de registros antes de producir el sitio. El módulo compartido rechaza propiedades
no declaradas, datos de otra empresa y referencias sin HTTPS o con credenciales.
Los registros se muestran como texto escapado en Astro; no se interpretan como HTML.
El asistente conserva sus límites, controles de origen y política de no reservar
ni inventar precios, disponibilidad o garantías.
Los sitemaps tienen listas explícitas por entorno: el build operativo conserva
solo inicio/privacidad y el de prueba incorpora servicios/GEO, sin añadir rutas
internas ni el asistente a la lista de páginas indexables.

## Actualización y rollback

1. Revisar la selección pública y versionarla en PostgreSQL, conservando el historial.
2. Exportar un release nuevo con `publish-integration` para la empresa `vectorbikes`
   y URL canónica `https://vectorbikestest.cl/geo/`.
3. Instalarlo con `node scripts/geo-install.mjs RELEASE https://vectorbikestest.cl --reviewed`.
4. Revisar los cuatro archivos, ejecutar las pruebas y compilar. Si una instalación
   anterior dejó `.geo-backup`, conservarla fuera de Git antes de una nueva instalación.
5. Publicar una vista previa y comprobar servicios, GEO y el asistente antes de
   autorizar producción. Revertir el commit completo restaura código y snapshot juntos.

Esto entrega una instantánea versionada. No existe sincronización automática con
PostgreSQL en producción: los cambios requieren un nuevo release y despliegue.
No se habilitan reservas, taller operativo ni acceso jurídico. El resto del sitio
mantiene sus datos existentes; esta entrega unifica el contenido de servicios y
el contexto del asistente, no migra todo el frontend a un CMS.

## Validación

- Pruebas del asistente con proveedor simulado y coincidencia de versión/contexto.
- Renderizado de servicios comparado con cada registro del paquete.
- Rechazo de archivos alterados y datos de otra empresa con hashes recalculados.
- Compilación pública y revisión de rutas, canonical, enlaces y sitemap.
- No se afirma descubrimiento, indexación ni citas externas por estas pruebas.
