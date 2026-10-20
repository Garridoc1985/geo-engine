"""Paquete instalable en un sitio/CMS; la construcción no realiza despliegues."""
from hashlib import sha256
from html import escape
import ipaddress
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from .publication import build_publication, _base_url, _json, _LABELS


_FILES = {"index.html", "body-fragment.html", "head-fragment.html", "home-link.html",
          "knowledge.json", "manifest.json", "sitemap.xml", "robots-merge.txt", "INSTALL.md"}


def _public_base_url(value: str) -> str:
    base = _base_url(value)
    parts = urlsplit(base)
    hostname = parts.hostname.rstrip(".").lower()
    if parts.scheme != "https" or "//" in parts.path or hostname == "localhost" or hostname.endswith(
        (".localhost", ".local", ".internal", ".test", ".lan", ".home", ".invalid")
    ):
        raise ValueError("La instalación requiere una URL HTTPS de destino público")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("La URL de instalación no puede ser una dirección privada o local")
    if address is None and ("." not in hostname or hostname.replace(".", "").isdigit()):
        raise ValueError("La instalación requiere un dominio público explícito")
    return base


def _paragraphs(content: str) -> str:
    """Texto visible seguro, sin interpretar HTML o instrucciones de los documentos."""
    paragraphs = []
    for block in re.split(r"\n\s*\n", content.strip()):
        lines = [re.sub(r"^#{1,6}\s+", "", line.strip()) for line in block.splitlines()]
        paragraphs.append("<p>" + escape(" ".join(lines)) + "</p>")
    return "".join(paragraphs)


def build_integration_bundle(database_url: str, company_id: str, name: str, base_url: str) -> dict[str, str]:
    """Entrega HTML visible y datos con permisos vigentes; no instala ni llama a IA."""
    base_url = _public_base_url(base_url)
    publication = build_publication(database_url, company_id, name, base_url)
    knowledge = json.loads(publication["knowledge.json"])
    previous_manifest = json.loads(publication["manifest.json"])
    version = previous_manifest["content_version"]
    sources = previous_manifest["sources"]
    articles = []
    for item in knowledge["items"]:
        reference = item["source"]["reference"]
        title = _LABELS.get(item["title"], item["title"])
        articles.append(
            f'<article class="geo-engine__item"><h3>{escape(title)}</h3>'
            f'{_paragraphs(item["content"])}<p class="geo-engine__source">Fuente: '
            f'<a href="{escape(reference, quote=True)}" rel="noopener noreferrer">{escape(reference)}</a></p></article>'
        )
    body = f'''<!-- GEO Engine: contenido visible para integrar en la página declarada. -->
<section class="geo-engine" data-geo-company="{company_id}" data-geo-version="{version}" aria-label="Información de {escape(name, quote=True)}">
  <h2>{escape(name)} · Información y servicios</h2>
  {''.join(articles)}
  <p class="geo-engine__formats"><a href="{escape(base_url + 'knowledge.json', quote=True)}">Información estructurada y fuentes</a></p>
</section>
'''
    dataset = {"@context": "https://schema.org", "@type": "Dataset", "@id": base_url + "#knowledge",
               "name": f"Conocimiento público de {name}", "url": base_url, "version": version,
               "inLanguage": "es", "about": {"@type": "Organization", "name": name}, "citation": sources,
               "distribution": {"@type": "DataDownload", "encodingFormat": "application/json",
                                "contentUrl": base_url + "knowledge.json"}}
    encoded = _json(dataset).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    head = ('<!-- Conservar la canonical y LocalBusiness existentes en el CMS. -->\n'
            f'<link rel="alternate" type="application/json" href="{escape(base_url + "knowledge.json", quote=True)}">\n'
            f'<script type="application/ld+json" data-geo-engine="{company_id}">{encoded}</script>\n')
    home_link = f'<a href="{escape(base_url, quote=True)}">Información y servicios de {escape(name)}</a>\n'
    prefix = urlsplit(base_url).path
    robots = ("# Fusionar con el robots.txt existente; no sustituir sus otras reglas.\n"
              "# Integrar en un grupo OAI-SearchBot existente si ya está definido.\n"
              f"User-agent: OAI-SearchBot\nAllow: {prefix}\n\nSitemap: {base_url}sitemap.xml\n")
    install = f'''# Integración GEO de {name}

Estado: paquete preparado. No instalado ni desplegado por esta construcción.
Empresa: `{company_id}`. Destino propuesto: {base_url}
Versión del conocimiento: `{version}`.

## Instalación en HTML o servidor

1. Servir index.html, knowledge.json, manifest.json y sitemap.xml en {base_url}.
2. Añadir home-link.html como enlace visible en la portada o navegación del sitio.
3. Fusionar robots-merge.txt con el robots.txt de la raíz; conservar las demás
   reglas y la política de entrenamiento. No desplegar los fragmentos ni INSTALL.md
   como páginas del sitio.

## Instalación mediante CMS

Crear una página en el destino indicado. Insertar body-fragment.html en su contenido
HTML y head-fragment.html una sola vez en su plantilla/cabecera. Configurar en el
CMS la URL canónica de esa página a {base_url}; conservar la canonical de la portada.
Servir knowledge.json y manifest.json junto a esa página y añadir su URL al sitemap
existente, o servir sitemap.xml y fusionar robots-merge.txt. No insertar index.html
completo dentro del contenido de otra página. Conservar los datos LocalBusiness
existentes; no instalar otra entidad contradictoria. Insertar home-link.html en
un lugar visible del sitio para enlazar la nueva página.

El fragmento no necesita JavaScript, iframe ni claves de OpenAI en el navegador.
El contenido se entrega en HTML visible y en JSON con las mismas fuentes.

## Actualizaciones desde GEO Engine

Después de revisar cambios de conocimiento/permisos en PostgreSQL, volver a ejecutar
publish-integration para generar un directorio de release nuevo. El proceso de
despliegue del sitio deberá reemplazar juntos HTML, JSON y manifest, invalidar las
cachés y retirar las versiones públicas antiguas. La construcción es determinista:
misma entrada produce los mismos archivos. Puede ejecutarse desde el proceso de
despliegue existente, con acceso autorizado y secreto de base en su entorno.
Este paquete no instala por sí mismo un job ni una conexión al CMS o al servidor.

## Comprobación posterior a la instalación

- GET {base_url} devuelve 200 y muestra el contenido sin ejecutar scripts.
- GET {base_url}knowledge.json devuelve JSON y solo la empresa `{company_id}`.
- La versión de manifest.json coincide con data-geo-version del contenido servido.
- La portada tiene el enlace visible y mantiene su canonical original.
- robots.txt y el sitemap permiten descubrir la página; revisar reglas existentes
  y bloqueos del alojamiento. Permitir búsqueda y permitir entrenamiento son
  decisiones diferentes: https://developers.openai.com/api/docs/bots.
- Comparar consultas sobre servicios y cobertura antes/después; registrar consulta,
  fecha, modelo/canal, URLs citadas y presencia de la empresa. Una llamada a OpenAI
  con el contexto inyectado no demuestra descubrimiento orgánico ni citas externas.

Se automatiza la publicación técnica al integrar el despliegue. La aparición y
posición en respuestas externas se observan; no se garantizan por instalar metadatos.
'''
    files = {"index.html": publication["index.html"], "body-fragment.html": body,
             "head-fragment.html": head, "home-link.html": home_link,
             "knowledge.json": publication["knowledge.json"], "sitemap.xml": publication["sitemap.xml"],
             "robots-merge.txt": robots, "INSTALL.md": install}
    manifest = {"schema_version": "1", "format": "site-integration", "status": "prepared",
                "company_id": company_id, "canonical_url": base_url, "content_version": version,
                "item_count": len(knowledge["items"]), "source_count": len(sources), "sources": sources,
                "files": {filename: sha256(content.encode()).hexdigest() for filename, content in files.items()}}
    files["manifest.json"] = _json(manifest)
    return files


def export_integration(bundle: dict[str, str], output: Path) -> None:
    if set(bundle) != _FILES or any(not isinstance(value, str) for value in bundle.values()):
        raise ValueError("Paquete de integración inválido")
    output = Path(output)
    if output.exists():
        raise ValueError("La salida de integración debe ser un directorio nuevo")
    output.mkdir(parents=True, exist_ok=False)
    for filename, content in bundle.items():
        (output / filename).write_text(content, encoding="utf-8")
