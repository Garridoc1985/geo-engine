"""API de arranque local. Aún no expone documentos ni generación."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from .config import Config
from .storage import initialize, ready


def create_server(config: Config) -> ThreadingHTTPServer:
    initialize(config.database_url)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/health":
                self.respond(200, {"status": "ok", "service": "geo-engine"})
            elif self.path == "/ready":
                available = ready(config.database_url)
                self.respond(200 if available else 503, {"database": "ready" if available else "unavailable"})
            else:
                self.respond(404, {"error": "not_found"})

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
