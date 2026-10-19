"""API local de catálogo y planificación del router, sin ejecución pagada HTTP."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from .config import Config
from .storage import initialize, ready
from .public_catalog import read_public_catalog
from .retrieval import search_public
from .router import PRIORITY, Router, RouterQuery
from .providers import build_providers_from_env
from .runs import PostgresRunStore
import psycopg


def create_server(config: Config, router: Router | None = None) -> ThreadingHTTPServer:
    initialize(config.database_url)
    router = router or Router(build_providers_from_env(), lambda text, company_id=None: search_public(config.database_url, text, company_id=company_id), PostgresRunStore(config.database_url))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/health":
                self.respond(200, {"status": "ok", "service": "geo-engine"})
            elif self.path == "/ready":
                available = ready(config.database_url)
                self.respond(200 if available else 503, {"database": "ready" if available else "unavailable"})
            elif self.path == "/v1/public/catalog":
                try:
                    self.respond(200, read_public_catalog(config.database_url))
                except psycopg.Error:
                    self.respond(503, {"error": "database_unavailable"})
            elif self.path == "/v1/router":
                self.respond(200, {"priority": list(PRIORITY), "tasks": ["text"],
                                   "execution": "local_cli_only", "plan_endpoint": "/v1/router/plan"})
            else:
                self.respond(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path != "/v1/router/plan":
                self.respond(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= 16384:
                    self.respond(413, {"error": "invalid_body_size"})
                    return
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict) or not {"query"} <= payload.keys() or payload.keys() - {"query", "origin", "company_id"}:
                    raise ValueError("Campos no admitidos")
                request = RouterQuery(**payload)
                self.respond(200, router.route(request))
            except (ValueError, UnicodeError):
                self.respond(400, {"error": "invalid_request"})
            except psycopg.Error:
                self.respond(503, {"error": "database_unavailable"})

        def respond(self, status: int, body: dict) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return ThreadingHTTPServer((config.host, config.port), Handler)


def main() -> None:
    config = Config.from_env()
    server = create_server(config)
    print(f"GEO Engine: http://{config.host}:{config.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
