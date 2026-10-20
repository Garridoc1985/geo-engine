# Integración de la capa GEO en HTML, CMS o servidor existente

19 de octubre de 2026. Ampliación de `publication.py` mediante `integration.py`.

El destino de esta integración es el sitio de la empresa. No se instalan scripts
en ChatGPT ni se entregan instrucciones promocionales a los modelos. El motor
debe poder descubrir y leer el contenido autorizado publicado en la web.

## Construcción

```bash
cd ~/geo-engine
.venv/bin/python -m geo_engine.cli publish-integration \
  --company vectorbikes --name 'Vector Bikes' \
  --base-url https://vectorbikes.cl/geo/ --output data/releases/vectorbikes/release-001
```

La ruta `/geo/` es una propuesta de instalación, no un endpoint que ya exista.
El comando no se conecta al CMS ni publica archivos remotamente. Requiere la base
local con el conocimiento público ya importado; no necesita credenciales de OpenAI.

Entrega index.html (opción de página autónoma), body-fragment.html y
head-fragment.html (opción para CMS), knowledge.json, manifest.json, sitemap.xml,
home-link.html, robots-merge.txt e instrucciones de instalación. El HTML del
fragmento es visible, usa H2/H3 y texto escapado y hereda los estilos del sitio.
El fragmento de cabecera incluye un Dataset y un enlace JSON, sin otra canonical
ni otra entidad LocalBusiness. No se requiere JavaScript ni iframe.

Se preserva la selección de publicación: empresa explícita, documentos activos,
visibilidad pública y ACL vacía en documento y fragmento, fuentes HTTP(S).
La URL de instalación exige HTTPS y rechaza destinos locales/IP no globales.
Esta validación es sintáctica: no conecta al destino ni comprueba DNS o propiedad.

## Vector Bikes

La portada pública ya tiene description, canonical `https://vectorbikes.cl/` y
JSON-LD LocalBusiness con dirección y horarios. La integración complementa esos
datos mediante una página vinculada, sin reemplazar la portada ni sus reservas.
No se copian los formularios ni datos de clientes. Los datos reales seleccionados
quedan fuera del repositorio de código.

El paquete propone una página `/geo/` y un enlace visible desde la web. Se debe
servir la página y sus datos en ese mismo sitio o ajustar explícitamente la URL
antes de generar. Para CMS se integran los fragmentos en esa página y se configuran
sus rutas; para HTML estático puede instalarse index.html y los JSON directamente.
Los fragmentos e instrucciones no son páginas que deban exponerse públicamente.

robots-merge.txt es un fragmento de fusión de configuración para OAI-SearchBot y el
sitemap: conserva la política de los demás rastreadores y de entrenamiento del
sitio. Nunca instalar el robots.txt de la vista local sobre un sitio existente.
La política de búsqueda es independiente de GPTBot/entrenamiento según la
[documentación oficial de OpenAI](https://developers.openai.com/api/docs/bots).

## Conexión y evolución

Integrar este comando en el proceso de despliegue del sitio permite reconstruir
la capa después de revisar cambios en PostgreSQL. Cada salida usa un directorio
nuevo y un manifest con versión/hashes; el despliegue reemplaza el release activo
completo y retira contenido/cachés antiguos. La ingesta actual rechaza modificaciones
de contenido bajo el mismo ID: el versionado de conocimiento debe preceder al build.

No hay sincronización automática mientras falte ese punto de despliegue autorizado.
La plataforma Sites conectada no devolvió sitios disponibles y no se encontró el
código original del sitio en las carpetas de desarrollo revisadas. Por eso se
prepara un paquete instalable; no se afirma que la web esté modificada o conectada.

Luego del despliegue, verificar HTTP, contenido sin JavaScript, equivalencia
HTML/JSON, enlace desde la portada, canonical y reglas de rastreo. Medir por separado
consultas, citas y presencia de la empresa en resultados de IA. Construir, instalar
o llamar a OpenAI con contexto no garantiza ni acredita posicionamiento externo.

Actualización del 20 de octubre: la ingesta estricta mantiene el rechazo de cambios
bajo un mismo ID; `--allow-revisions` permite versiones inmutables explícitas antes
del build. Ver [actualización controlada](ACTUALIZACION-CONOCIMIENTO.md).
