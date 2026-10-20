import contextlib
from email.message import Message
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from geo_engine.company_knowledge import CompanyKnowledge
from geo_engine.company_store import import_company
from geo_engine.public_catalog import read_public_catalog
from geo_engine.storage import initialize
from geo_engine.web_reader import extract_text, fetch_html, read_public_web, validate_url, MAX_BYTES


class WebReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = self.root / "pages.json"
        self.output = self.root / "snapshot"
        self.data = {"company_id": "example", "pages": [
            {"url": "https://example.com/services/", "title": "Servicios", "public_authorized": True}]}
        self.write_manifest()

    def write_manifest(self):
        self.manifest.write_text(json.dumps(self.data), encoding="utf-8")

    def test_denied_urls_never_reach_transport(self):
        urls = ["http://example.com/", "https://user:pass@example.com/", "https://example.com/?token=x",
                "https://example.com/#part", "https://localhost/", "https://example.local/",
                "https://example.com:444/", "https://example.com/clientes/123", "https://example.com/orders/",
                "https://example.com/usuarios/", "https://example.com/wp-admin/", "https://example.com/wp-json/",
                "https://example.com/%2563lients/", "https://example.com/a/../services/",
                "https://example.com/my-account/", "https://example.com/a\\users/", "https://example.com/cart/"]
        with patch("geo_engine.web_reader.socket.getaddrinfo") as dns:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    fetch_html(url)
            dns.assert_not_called()

    def test_private_or_mixed_dns_is_rejected_before_connect(self):
        for addresses in [["127.0.0.1"], ["10.0.0.1"], ["::1"], ["169.254.169.254"], ["8.8.8.8", "192.168.1.1"]]:
            rows = [(2, 1, 6, "", (a, 443)) for a in addresses]
            with self.subTest(addresses=addresses), patch("geo_engine.web_reader.socket.getaddrinfo", return_value=rows), patch("geo_engine.web_reader._PinnedHTTPS") as conn:
                with self.assertRaises(ValueError):
                    fetch_html("https://example.com/")
                conn.assert_not_called()

    def test_transport_limits_status_type_encoding_and_size(self):
        headers = Message()
        headers["Content-Type"] = "text/html; charset=utf-8"
        for status, encoding, mime, body in [(302, "identity", "text/html", b"redirect"),
                (403, "identity", "text/html", b"denied"), (200, "gzip", "text/html", b"data"),
                (200, "identity", "application/json", b"{}"), (200, "identity", "text/html", b"x" * (MAX_BYTES+1))]:
            response = MagicMock()
            response.status = status
            response.getheader.return_value = encoding
            response.headers = Message()
            response.headers["Content-Type"] = mime
            response.read.return_value = body
            connection = MagicMock()
            connection.getresponse.return_value = response
            with self.subTest(status=status, mime=mime, encoding=encoding), patch("geo_engine.web_reader.socket.getaddrinfo", return_value=[(2,1,6,"",("8.8.8.8",443))]), patch("geo_engine.web_reader._PinnedHTTPS", return_value=connection):
                with self.assertRaises(ValueError):
                    fetch_html("https://example.com/")
                connection.close.assert_called_once()

    def test_success_uses_pinned_address_and_no_credentials(self):
        connection = MagicMock()
        response = connection.getresponse.return_value
        response.status = 200
        response.getheader.return_value = "identity"
        response.headers = Message()
        response.headers["Content-Type"] = "text/html; charset=utf-8"
        response.read.return_value = "<main>Información</main>".encode()
        with patch("geo_engine.web_reader.socket.getaddrinfo", return_value=[(2,1,6,"",("8.8.8.8",443))]), patch("geo_engine.web_reader._PinnedHTTPS", return_value=connection) as factory:
            self.assertIn("Información", fetch_html("https://example.com/services/"))
        factory.assert_called_once_with("example.com", "8.8.8.8")
        args, kwargs = connection.request.call_args
        self.assertEqual(args, ("GET", "/services/"))
        self.assertNotIn("Authorization", kwargs["headers"])
        self.assertNotIn("Cookie", kwargs["headers"])

    def test_extracts_main_without_scripts_forms_or_hidden_elements(self):
        html = '<head><title>Metadata</title></head><nav>Menu</nav><main><h1>Servicios</h1><p>Texto &amp; fuente</p><script>secret</script><form>Cliente</form><div hidden>Oculto</div><div aria-hidden="true">Otro</div></main><footer>Footer</footer>'
        self.assertEqual(extract_text(html), "Servicios\n\nTexto & fuente")
        for html in ["<script>only script</script>", "<p>" + "x" * 20001 + "</p>"]:
            with self.assertRaises(ValueError):
                extract_text(html)

    def test_snapshot_roundtrips_through_existing_company_loader(self):
        with patch("geo_engine.web_reader.fetch_html", return_value="<main>Servicio verificable</main>"):
            report = read_public_web(self.manifest, self.output)
        self.assertEqual(report["status"], "prepared_for_review")
        records = CompanyKnowledge(self.output, "example").load()
        self.assertEqual(len(records), 1)
        self.assertIn("Servicio verificable", records[0].content)
        self.assertEqual(records[0].reference, self.data["pages"][0]["url"])
        self.assertEqual(records[0].visibility, "public")
        self.assertEqual(records[0].allowed_principals, ())
        with self.assertRaises(ValueError):
            read_public_web(self.manifest, self.output)

    def test_second_page_failure_leaves_no_snapshot(self):
        self.data["pages"].append({"url": "https://example.com/about/", "title": "Empresa", "public_authorized": True})
        self.write_manifest()
        with patch("geo_engine.web_reader.fetch_html", side_effect=["<p>Servicio</p>", OSError("network")]):
            with self.assertRaises(ValueError):
                read_public_web(self.manifest, self.output)
        self.assertFalse(self.output.exists())

    def test_invalid_manifest_is_rejected_before_any_request(self):
        for modify in [lambda d: d.update(pages=[]), lambda d: d["pages"][0].update(public_authorized=False),
                       lambda d: d["pages"].append(dict(d["pages"][0])), lambda d: d.update(company_id="../other"),
                       lambda d: d["pages"][0].update(extra="field")]:
            data = json.loads(json.dumps(self.data))
            modify(data)
            self.manifest.write_text(json.dumps(data), encoding="utf-8")
            with patch("geo_engine.web_reader.fetch_html") as fetch:
                with self.assertRaises(ValueError):
                    read_public_web(self.manifest, self.output)
                fetch.assert_not_called()

    def test_cli_reader_does_not_initialize_database_or_providers(self):
        from geo_engine.cli import main
        stdout = io.StringIO()
        with patch("sys.argv", ["geo", "read-public-web", "--manifest", str(self.manifest), "--output", str(self.output)]), patch("geo_engine.web_reader.fetch_html", return_value="<p>Servicios</p>"), patch("geo_engine.cli.Config.from_env") as config, patch("geo_engine.cli.initialize") as initialize, contextlib.redirect_stdout(stdout):
            self.assertEqual(main(), 0)
        config.assert_not_called()
        initialize.assert_not_called()
        self.assertEqual(json.loads(stdout.getvalue())["pages"], 1)


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere PostgreSQL")
class WebReaderPostgreSQLTests(unittest.TestCase):
    setUp = WebReaderTests.setUp
    write_manifest = WebReaderTests.write_manifest

    def test_web_snapshot_revisions_withdraw_old_text_without_duplicates(self):
        base = os.environ["GEO_TEST_DATABASE_URL"]
        schema = "geo_web_test_" + uuid4().hex
        with psycopg.connect(base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            url = make_conninfo(base, options=f"-c search_path={schema}")
            initialize(url)
            for index, content in enumerate(["Servicio anterior", "Servicio actualizado", "Servicio actualizado"]):
                output = self.root / f"revision-{index}"
                with patch("geo_engine.web_reader.fetch_html", return_value=f"<main>{content}</main>"):
                    read_public_web(self.manifest, output)
                records = CompanyKnowledge(output, "example").load()
                result = import_company(url, "example", records, allow_revisions=True)
                self.assertEqual(result["imported"], 0 if index == 2 else 1)
                public = read_public_catalog(url, company_id="example")["items"]
                self.assertEqual(len(public), 1)
                self.assertIn(content, public[0]["content"])
            with psycopg.connect(url) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 2)
        finally:
            with psycopg.connect(base) as db:
                db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
