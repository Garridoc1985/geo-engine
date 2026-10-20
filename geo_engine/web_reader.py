"""Lectura explícita de páginas públicas; sin crawling ni escritura en PostgreSQL."""
import hashlib
import http.client
import ipaddress
import json
from html.parser import HTMLParser
from pathlib import Path
import re
import socket
import ssl
from urllib.parse import unquote, urlsplit

from dataclasses import asdict
from .company_knowledge import CompanyKnowledge

MAX_BYTES = 1_000_000
BLOCKED = re.compile(r"(?:^|[/_.-])(clients?|clientes?|customers?|orders?|ordenes|pedidos?|users?|usuarios?|accounts?|cuentas?|admin|wp-admin|wp-json|wp-login|login|logout|signin|checkout|cart|carrito|my-account|api)(?:$|[/_.-])", re.I)


def validate_url(url):
    if not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url) or "\\" in url:
        raise ValueError("URL pública inválida")
    parts = urlsplit(url)
    if (parts.scheme != "https" or not parts.hostname or parts.username is not None
            or parts.password is not None or parts.port not in (None, 443)
            or parts.query or parts.fragment):
        raise ValueError("Se requiere HTTPS sin credenciales, consulta ni fragmento")
    path = parts.path or "/"
    for _ in range(5):
        decoded = unquote(path)
        if decoded == path:
            break
        path = decoded
    if "%" in path or "\\" in path or ";" in path or "//" in path or any(p in {".", ".."} for p in path.split("/")) or BLOCKED.search(path):
        raise ValueError("Ruta excluida de lectura pública")
    host = parts.hostname
    if host.endswith(".") or "." not in host or host.endswith((".local", ".internal", ".localhost", ".test", ".invalid")):
        raise ValueError("Se requiere un dominio público")
    return parts


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, timeout=15, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # Connect to the validated numeric address, preserving TLS hostname checks.
        sock = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def fetch_html(url):
    parts = validate_url(url)
    host = parts.hostname.encode("idna").decode("ascii")
    addresses = sorted({row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
    if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
        raise ValueError("El destino no resuelve exclusivamente a direcciones públicas")
    connection = _PinnedHTTPS(host, addresses[0])
    try:
        connection.request("GET", parts.path or "/", headers={"User-Agent": "GeoEngine-PublicReader/1.0", "Accept": "text/html", "Accept-Encoding": "identity"})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("La página no devuelve HTTP 200; no se siguen redirecciones")
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            raise ValueError("Codificación de transporte no admitida")
        if response.headers.get_content_type() != "text/html":
            raise ValueError("La página no devuelve HTML")
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("La página supera el límite de tamaño")
        return body.decode(response.headers.get_content_charset() or "utf-8", errors="strict")
    finally:
        connection.close()


class _VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.text = []
        self.main = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        parent_hidden = self.stack[-1][1] if self.stack else False
        hidden = parent_hidden or tag in {"head", "script", "style", "noscript", "template", "nav", "footer", "form", "svg"} or "hidden" in attrs or attrs.get("aria-hidden", "").lower() == "true"
        in_main = tag == "main" or (self.stack[-1][2] if self.stack else False)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append((tag, hidden, in_main))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if self.stack and self.stack[-1][1]:
            return
        data = " ".join(data.split())
        if data:
            self.text.append(data)
            if self.stack and self.stack[-1][2]:
                self.main.append(data)


def extract_text(html):
    parser = _VisibleText()
    parser.feed(html)
    text = "\n\n".join(parser.main or parser.text)
    if not text or len(text) > 20000 or "\x00" in text:
        raise ValueError("Texto vacío, inválido o demasiado extenso; revisar la página")
    return text


def read_manifest(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Claves duplicadas en el manifiesto")
            result[key] = value
        return result
    data = json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique)
    if not isinstance(data, dict) or set(data) != {"company_id", "pages"}:
        raise ValueError("Manifiesto inválido")
    if not isinstance(data["company_id"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", data["company_id"]):
        raise ValueError("Empresa inválida")
    pages = data["pages"]
    if not isinstance(pages, list) or not 1 <= len(pages) <= 50:
        raise ValueError("Se requieren entre 1 y 50 páginas autorizadas")
    seen = set()
    for page in pages:
        if not isinstance(page, dict) or set(page) != {"url", "title", "public_authorized"} or page["public_authorized"] is not True:
            raise ValueError("Cada página requiere autorización pública explícita")
        validate_url(page["url"])
        if not isinstance(page["title"], str) or not page["title"].strip() or len(page["title"]) > 200 or any(c in page["title"] for c in "\x00\r\n"):
            raise ValueError("Título inválido")
        if page["url"] in seen:
            raise ValueError("URL duplicada")
        seen.add(page["url"])
    return data


def snapshot_version(company_id, records):
    payload = {"company_id": company_id, "records": [asdict(r) for r in sorted(records, key=lambda r: r.id)]}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read_public_web(manifest_path, output):
    """Build a complete review workspace only after every authorized page succeeds."""
    data = read_manifest(manifest_path)
    output = Path(output)
    if output.exists():
        raise ValueError("El snapshot requiere un directorio nuevo")
    records = []
    for page in data["pages"]:
        try:
            content = extract_text(fetch_html(page["url"]))
        except (OSError, http.client.HTTPException, UnicodeError, LookupError):
            raise ValueError("No se pudo leer una página autorizada; snapshot cancelado") from None
        record_id = "WEB-" + hashlib.sha256(page["url"].encode()).hexdigest()
        records.append((record_id, page, content))
    # Nothing has been written and no database connection has been made until here.
    root = output / "clients" / data["company_id"]
    (root / "evidence").mkdir(parents=True, exist_ok=False)
    access = {}
    registry = ["| Evidence ID | Status |", "| --- | --- |"]
    for record_id, page, content in records:
        relative = f"evidence/{record_id}.md"
        (root / relative).write_text(page["title"] + "\n\n" + content, encoding="utf-8")
        access[relative] = {"visibility": "public", "allowed_principals": [], "source_reference": page["url"]}
        registry.append(f"| [{record_id}]({relative}) | captured |")
    (root / "access.json").write_text(json.dumps(access, ensure_ascii=False, indent=2), encoding="utf-8")
    (root / "evidence_registry.md").write_text("\n".join(registry) + "\n", encoding="utf-8")
    loaded = CompanyKnowledge(output, data["company_id"]).load()
    version = snapshot_version(data["company_id"], loaded)
    (output / "snapshot.json").write_text(json.dumps({"company_id": data["company_id"], "content_version": version, "item_count": len(loaded)}), encoding="utf-8")
    return {"content_version": version, "status": "prepared_for_review", "company_id": data["company_id"], "pages": len(loaded), "workspace": str(output.resolve())}
