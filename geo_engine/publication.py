"""Publicación determinista de conocimiento público, sin generación ni claves IA."""
from hashlib import sha256
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from urllib.parse import urlsplit, urlunsplit
from xml.sax.saxutils import escape as xml_escape

import psycopg

from .config import Config
from .public_catalog import read_public_catalog


_COMPANY = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "knowledge.json": "application/json; charset=utf-8",
    "manifest.json": "application/json; charset=utf-8",
    "sitemap.xml": "application/xml; charset=utf-8",
    "robots.txt": "text/plain; charset=utf-8",
}
_LABELS = {"company_profile": "Perfil de la empresa", "products_services": "Actividad y servicios",
           "business_model": "Modelo de negocio", "historical_context": "Trayectoria"}


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def _web_url(value: str) -> str:
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError("Se requiere una URL web sin espacios ni caracteres de control")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise ValueError("URL web inválida") from None
    if (parts.scheme not in {"https", "http"} or not parts.hostname or parts.username
            or parts.password or "\\" in value or (port is not None and not 1 <= port <= 65535)):
        raise ValueError("Se requiere una URL HTTP(S) sin credenciales")
    return value


def _base_url(value: str) -> str:
    _web_url(value)
    parts = urlsplit(value)
    if parts.query or parts.fragment or not re.fullmatch(r"[/a-zA-Z0-9_-]*", parts.path):
        raise ValueError("La URL base no admite consulta, fragmento ni rutas ambiguas")
    path = parts.path.rstrip("/") + "/"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def build_publication(database_url: str, company_id: str, name: str, base_url: str) -> dict[str, str]:
    """Selecciona datos autorizados de una empresa y produce un paquete portable.

    No lee borradores generados ni llama a proveedores. La base canónica se declara
    por configuración, nunca se deriva de una cabecera Host o de la empresa fuente.
    """
    if not isinstance(company_id, str) or not _COMPANY.fullmatch(company_id):
        raise ValueError("Identificador de empresa inválido")
    if (not isinstance(name, str) or not name.strip() or len(name) > 200
            or any(ord(c) < 32 for c in name)):
        raise ValueError("Nombre público de empresa inválido")
    base_url = _base_url(base_url)
    catalog = read_public_catalog(database_url, company_id=company_id)
    items = catalog["items"]
    if not items:
        raise ValueError("La empresa no tiene conocimiento público vigente")
    for item in items:
        _web_url(item["source"]["reference"])
    knowledge = {"schema_version": "1", "company_id": company_id, "name": name,
                 "canonical_url": base_url, "items": items}
    encoded = _json(knowledge)
    version = sha256(encoded.encode("utf-8")).hexdigest()
    sources = sorted({item["source"]["reference"] for item in items})
    structured = {
        "@context": "https://schema.org", "@type": "Dataset", "name": f"Conocimiento público de {name}",
        "url": base_url, "version": version, "inLanguage": "es",
        "about": {"@type": "Organization", "name": name}, "citation": sources,
        "distribution": {"@type": "DataDownload", "encodingFormat": "application/json",
                         "contentUrl": base_url + "knowledge.json"},
    }
    # Impide cerrar el bloque JSON-LD mediante texto procedente de una fuente.
    structured_json = _json(structured).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    articles = []
    for item in items:
        reference = item["source"]["reference"]
        articles.append(
            f'<article id="e-{sha256(item["chunk_id"].encode()).hexdigest()[:16]}">'
            f'<h2>{escape(_LABELS.get(item["title"], item["title"]))}</h2><div class="content">{escape(item["content"])}</div>'
            f'<p class="source">Fuente: <a href="{escape(reference, quote=True)}" rel="noopener noreferrer">'
            f'{escape(reference)}</a></p></article>'
        )
    html = f'''<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(name)} · Conocimiento empresarial</title>
<meta name="description" content="Información empresarial de {escape(name, quote=True)} con fuentes verificables.">
<link rel="canonical" href="{escape(base_url, quote=True)}">
<link rel="alternate" type="application/json" href="{escape(base_url + 'knowledge.json', quote=True)}">
<script type="application/ld+json">{structured_json}</script>
<style>body{{font:18px/1.65 system-ui,sans-serif;background:#f8fafc;color:#172033;margin:0}}
main{{max-width:880px;margin:auto;padding:56px 24px}}h1{{font-size:2.4rem;line-height:1.15}}
article{{background:white;border:1px solid #dce3ec;padding:24px;margin:24px 0;border-radius:12px}}
.content{{white-space:pre-wrap;overflow-wrap:anywhere}}a{{color:#1555a2;overflow-wrap:anywhere}}
.source,footer{{font-size:.85rem;color:#475569}}nav a{{margin-right:20px}}</style></head>
<body><main><header><p>Conocimiento empresarial · Fuentes públicas</p><h1>{escape(name)}</h1>
<p>Información documentada con referencias a sus fuentes.</p>
<nav aria-label="Formatos de lectura"><a href="knowledge.json">Datos JSON</a><a href="manifest.json">Versión y procedencia</a></nav></header>
{''.join(articles)}
<footer>Preparado con GEO Engine · Información documentada en las fuentes enlazadas.</footer></main></body></html>\n'''
    sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
               f'<url><loc>{xml_escape(base_url)}</loc></url></urlset>\n')
    prefix = urlsplit(base_url).path
    robots = (f"User-agent: OAI-SearchBot\nAllow: {prefix}\n\n"
              "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /\n\n"
              f"Sitemap: {base_url}sitemap.xml\n")
    files = {"index.html": html, "knowledge.json": encoded, "sitemap.xml": sitemap, "robots.txt": robots}
    manifest = {"schema_version": "1", "company_id": company_id, "canonical_url": base_url,
                "content_version": version, "source_count": len(sources), "item_count": len(items),
                "sources": sources, "files": {filename: sha256(content.encode()).hexdigest()
                                             for filename, content in files.items()}}
    files["manifest.json"] = _json(manifest)
    return files


def export_publication(bundle: dict[str, str], output: Path) -> None:
    """Escribe un release nuevo; no sobrescribe archivos ni deja salidas antiguas."""
    if set(bundle) != set(_TYPES) or any(not isinstance(value, str) for value in bundle.values()):
        raise ValueError("Paquete de publicación inválido")
    output = Path(output)
    if output.exists():
        raise ValueError("La salida debe ser un directorio nuevo para este release")
    output.mkdir(parents=True, exist_ok=False)
    for filename, content in bundle.items():
        (output / filename).write_text(content, encoding="utf-8")


def create_publication_server(config: Config, company_id: str, name: str, base_url: str) -> ThreadingHTTPServer:
    """Vista local de lectura. No expone catálogo global, consultas ni administración."""
    if config.host not in {"127.0.0.1", "localhost"}:
        raise ValueError("La vista de publicación local requiere loopback")
    base_url = _base_url(base_url)
    # Rechaza empresa sin material antes de abrir el puerto.
    build_publication(config.database_url, company_id, name, base_url)
    prefix = urlsplit(base_url).path

    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.serve(send_body=False)

        def do_GET(self):
            self.serve(send_body=True)

        def serve(self, send_body):
            path = urlsplit(self.path).path
            filename = (path[len(prefix):] or "index.html") if path.startswith(prefix) else None
            # robots.txt se consulta en la raíz del dominio, aunque la capa tenga prefijo.
            if path == "/robots.txt":
                filename = "robots.txt"
            if filename not in _TYPES:
                self.respond(404, "not_found\n", "text/plain; charset=utf-8", send_body)
                return
            try:
                bundle = build_publication(config.database_url, company_id, name, base_url)
                self.respond(200, bundle[filename], _TYPES[filename], send_body)
            except ValueError:
                self.respond(404, "public_content_unavailable\n", "text/plain; charset=utf-8", send_body)
            except psycopg.Error:
                self.respond(503, "database_unavailable\n", "text/plain; charset=utf-8", send_body)

        def respond(self, status, body, content_type, send_body):
            payload = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            if send_body:
                self.wfile.write(payload)

    return ThreadingHTTPServer((config.host, config.port), Handler)
