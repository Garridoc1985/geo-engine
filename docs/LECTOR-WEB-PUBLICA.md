# Lector de páginas públicas autorizadas

20 de octubre de 2026. Primer lector explícito, sin rastreo de enlaces ni APIs de IA.

## Preparar la selección

Crear un manifiesto fuera del repositorio con una lista revisada de páginas:

```json
{
  "company_id": "empresa",
  "pages": [
    {
      "url": "https://example.com/servicios/",
      "title": "Servicios de la empresa",
      "public_authorized": true
    }
  ]
}
```

El ejemplo es sintético; usar URLs reales autorizadas. `public_authorized` es una
declaración del operador: el lector no comprueba propiedad ni aprobación editorial.
Admite entre 1 y 50 URLs. No descubre automáticamente nuevas páginas ni sigue
sitemaps, enlaces o redirecciones. No utiliza sesiones, cookies ni credenciales.

## Capturar y revisar

```bash
.venv/bin/python -m geo_engine.cli read-public-web \
  --manifest /ruta/pages.json --output /ruta/snapshot-nuevo
```

Lee todas las páginas antes de escribir la salida. Un fallo de red, HTTP, formato
o extracción cancela la captura sin escribir un snapshot. No abre PostgreSQL ni
llama a proveedores IA. Rechaza directorios existentes. Si falla la escritura,
la salida puede quedar incompleta: descartarla y repetir en otro directorio;
solo usar una captura cuyo comando finalice con éxito.

La salida usa `clients/<empresa>/evidence/`, `evidence_registry.md` y `access.json`,
compatibles con `CompanyKnowledge`. Los IDs WEB se derivan de la URL y las fuentes
conservan esa URL; cada registro contiene el título declarado y texto capturado.
El estado `captured` del registro indica captura, no corroboración factual.
Revisar el texto y los permisos antes de importarlo; se marca público porque el
manifiesto exige autorización pública explícita.

## Importar la selección revisada

```bash
.venv/bin/python -m geo_engine.cli ingest-company empresa \
  --workspace /ruta/snapshot-nuevo --allow-revisions
```

**Este comando reemplaza la selección activa completa de la empresa.** Si ya hay
conocimiento adicional, combinar primero las evidencias, el registro y access.json
en un workspace completo revisado. No importar una selección parcial de páginas
sobre una empresa con otros registros que deban conservarse. El lector no ejecuta
esa importación automáticamente. Para conservar otras fuentes, usar preferentemente
`sync-catalog`, descrito en [sincronización por fuente](SINCRONIZACION-CATALOGO.md).

Cada captura requiere un directorio nuevo. Repetir captura e importación con el
mismo texto y fuentes reutiliza revisiones; un cambio genera una revisión nueva.
La extracción no conserva HTML ejecutable. Prefiere `<main>` si contiene texto;
si no, usa texto del documento. Omite head, scripts, estilos, navegación, footer,
formularios, SVG y elementos con hidden/aria-hidden. No ejecuta JavaScript ni
calcula CSS: una web dinámica o con contenido oculto mediante estilos requiere
revisión específica. No se inventan resúmenes ni hechos.

## Límites de acceso

Solo HTTPS en puerto 443, sin credenciales, query ni fragmento. Excluye rutas de
clientes, órdenes, usuarios, cuentas, administración y API, incluidas variantes
codificadas habituales. El manifiesto validado completo precede a la primera petición.
Resuelve DNS y exige que todas las direcciones sean globales; conecta a una IP
validada fijada para esa conexión conservando SNI y validación TLS del dominio.
No usa proxies del entorno ni sigue redirecciones. Acepta solo HTTP 200 con
text/html sin compresión, máximo 1 MB y hasta 20000 caracteres de texto por página.
El bloqueo de rutas complementa la selección explícita; no determina por sí solo
si una página contiene información personal o está autorizada.

## Estado del ciclo completo

Implementado: URLs explícitas → captura pública → snapshot SCW → revisión manual
→ ingesta con revisiones → PostgreSQL → construcción HTML/JSON existente.

Pendiente: planificación periódica, comparación previa a importar, revisión editorial
registrada, adaptador WordPress, despliegue
y comprobación pública. Durable sigue como destino particular previsto de Vector Bikes.
El lector no consulta robots.txt; antes de autorizar capturas, el operador debe
revisar condiciones de acceso y reglas aplicables. No es un rastreador automático.

Incremento posterior: el lector cierra las capturas exitosas con snapshot.json.
`sync-catalog` verifica ese comprobante antes de aplicar el snapshot por ámbito.
