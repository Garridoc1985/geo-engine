"""Publicación local verificable: empresa, permisos y retiro de evidencia."""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from geo_engine.company_knowledge import KnowledgeRecord
from geo_engine.company_store import import_company
from geo_engine.config import Config
from geo_engine.publication import (
    build_publication,
    create_publication_server,
    export_publication,
)
from geo_engine.public_catalog import read_public_catalog
from geo_engine.storage import initialize


def record(identifier, content, reference="https://example.test/about", *, visibility="public"):
    return KnowledgeRecord(identifier, "Ficha empresarial", content, reference, visibility, ())


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class PublicationPostgreSQLTests(unittest.TestCase):
    def setUp(self):
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_publication_test_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        initialize(self.url)
        self.records = (
            record("domain:company_profile", "Empresa de demostración Alfa."),
            record("domain:products_services", "Alfa ofrece mantenimiento industrial.", "https://example.test/services"),
            record("domain:commercial_context", "SECRETO_INTERNO_ALFA", visibility="internal"),
        )
        import_company(self.url, "alfa", self.records)

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def build(self):
        return build_publication(self.url, "alfa", "Alfa", "https://alfa.example.test")

    def start_server(self, canonical="https://alfa.example.test"):
        server = create_publication_server(
            Config("127.0.0.1", 0, self.url), "alfa", "Alfa", canonical
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_bundle_preserves_public_evidence_and_provenance(self):
        bundle = self.build()
        self.assertEqual(set(bundle), {"index.html", "knowledge.json", "manifest.json", "sitemap.xml", "robots.txt"})
        for filename in ("knowledge.json", "manifest.json"):
            self.assertIsInstance(json.loads(bundle[filename]), dict)
        public = bundle["knowledge.json"]
        self.assertIn("Empresa de demostración Alfa", public)
        self.assertIn("https://example.test/about", public)
        self.assertIn("https://example.test/services", public)
        self.assertIn("scw:alfa:domain:company_profile:chunk:1", public)
        self.assertIn("scw:alfa:domain:company_profile:document", public)
        self.assertIn("scw:alfa:domain:company_profile:source", public)
        self.assertIn("Alfa", bundle["index.html"])
        self.assertIn("application/ld+json", bundle["index.html"])
        self.assertIn("https://alfa.example.test", bundle["sitemap.xml"])
        self.assertIn("sitemap.xml", bundle["robots.txt"])
        self.assertNotIn("SECRETO_INTERNO_ALFA", "\n".join(bundle.values()))

    def test_company_scope_excludes_other_company_and_unassigned_catalog(self):
        import_company(self.url, "beta", (
            record("domain:company_profile", "MARCADOR_OTRA_EMPRESA", "https://beta.example.test"),
        ))
        with psycopg.connect(self.url) as db:
            db.execute("INSERT INTO sources VALUES ('unassigned:source','https://unassigned.example.test','Otra ficha')")
            db.execute("INSERT INTO documents VALUES ('unassigned:document','unassigned:source','Otra ficha','public','{}')")
            db.execute("INSERT INTO chunks VALUES ('unassigned:chunk','unassigned:document','MARCADOR_SIN_EMPRESA','public','{}')")
        serialized = "\n".join(self.build().values())
        self.assertNotIn("MARCADOR_OTRA_EMPRESA", serialized)
        self.assertNotIn("MARCADOR_SIN_EMPRESA", serialized)

    def test_document_and_chunk_must_both_be_public(self):
        with psycopg.connect(self.url) as db:
            db.execute("UPDATE chunks SET visibility='public' WHERE id='scw:alfa:domain:commercial_context:chunk:1'")
            db.execute("UPDATE chunks SET visibility='internal' WHERE id='scw:alfa:domain:company_profile:chunk:1'")
        serialized = "\n".join(self.build().values())
        self.assertNotIn("SECRETO_INTERNO_ALFA", serialized)
        self.assertNotIn("Empresa de demostración Alfa", serialized)
        self.assertIn("Alfa ofrece mantenimiento industrial", serialized)

    def test_inconsistent_public_acl_fails_closed_for_document_and_chunk(self):
        with psycopg.connect(self.url) as db:
            db.execute("UPDATE documents SET allowed_principals=ARRAY['restricted'] WHERE id='scw:alfa:domain:company_profile:document'")
            db.execute("UPDATE chunks SET allowed_principals=ARRAY['restricted'] WHERE id='scw:alfa:domain:products_services:chunk:1'")
        self.assertEqual(read_public_catalog(self.url, company_id="alfa")["items"], [])
        self.assertEqual(read_public_catalog(self.url)["items"], [])
        with self.assertRaises(ValueError):
            self.build()

    def test_removed_evidence_disappears_without_destroying_history(self):
        import_company(self.url, "alfa", (self.records[0],))
        serialized = "\n".join(self.build().values())
        self.assertNotIn("Alfa ofrece mantenimiento industrial", serialized)
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 3)
        import_company(self.url, "alfa", ())
        with self.assertRaises(ValueError):
            self.build()

    def test_non_web_or_credentialed_references_block_publication(self):
        references = (
            "scw://gamma/products_services.md", "demo://gamma/commercial",
            "javascript:alert(1)", "file:///home/gamma/internal.md",
            "https://user:secret@example.test/about", "https://example.test/with space",
            "https://example.test/\nprivate", "https://example.test:invalid/about",
        )
        for index, reference in enumerate(references):
            company = f"invalid{index}"
            with self.subTest(reference=reference):
                import_company(self.url, company, (
                    record("domain:company_profile", "NO_PUBLICAR_REFERENCIA_INVALIDA", reference),
                ))
                with self.assertRaises(ValueError):
                    build_publication(self.url, company, "Prueba", "https://invalid.example.test")

    def test_html_escapes_content_and_embedded_json_script_termination(self):
        injection = '</script><script>alert("xss")</script><img src=x onerror=alert(1)>'
        import_company(self.url, "unsafe", (
            record("domain:company_profile", injection, "https://example.test/about"),
        ))
        bundle = build_publication(self.url, "unsafe", 'Empresa <img src=x onerror=alert(2)>', "https://unsafe.example.test")
        html = bundle["index.html"]
        self.assertNotIn('<script>alert("xss")</script>', html)
        self.assertNotIn("<img src=x", html)
        self.assertIn("&lt;", html)
        self.assertTrue(any(item["content"] == injection for item in json.loads(bundle["knowledge.json"])["items"]))

    def test_identical_source_snapshot_has_stable_bundle(self):
        self.assertEqual(self.build(), self.build())
        from hashlib import sha256
        bundle = self.build()
        manifest = json.loads(bundle["manifest.json"])
        self.assertEqual(manifest["content_version"], sha256(bundle["knowledge.json"].encode()).hexdigest())
        self.assertEqual(manifest["item_count"], 2)
        self.assertEqual(manifest["source_count"], 2)
        for filename, digest in manifest["files"].items():
            self.assertEqual(digest, sha256(bundle[filename].encode()).hexdigest())

    def test_changed_public_snapshot_changes_versioned_manifest(self):
        before = self.build()["manifest.json"]
        import_company(self.url, "alfa", (self.records[0],))
        after = self.build()["manifest.json"]
        self.assertNotEqual(before, after)

    def test_missing_company_has_no_publication(self):
        with self.assertRaises(ValueError):
            build_publication(self.url, "missing", "Missing", "https://missing.example.test")

    def test_base_url_and_company_validation_before_publication(self):
        for company in ("../alfa", "alfa/beta", "UPPERCASE", "", None):
            with self.subTest(company=company), self.assertRaises(ValueError):
                build_publication(self.url, company, "Alfa", "https://alfa.example.test")
        for url in ("javascript:alert(1)", "https://user:secret@example.test", "https://example.test/?token=secret",
                    "https://example.test/#fragment", "https://example.test/../private", "https://example.test/has space"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                build_publication(self.url, "alfa", "Alfa", url)
        with self.assertRaises(ValueError):
            create_publication_server(Config("0.0.0.0", 0, self.url), "alfa", "Alfa", "https://alfa.example.test")

    def test_export_writes_only_new_directory_and_refuses_overwrite(self):
        bundle = self.build()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "publication"
            export_publication(bundle, output)
            self.assertEqual({path.name for path in output.iterdir()}, set(bundle))
            for filename, content in bundle.items():
                self.assertEqual((output / filename).read_text(encoding="utf-8"), content)
            with self.assertRaises((ValueError, FileExistsError)):
                export_publication(bundle, output)
            self.assertEqual((output / "index.html").read_text(encoding="utf-8"), bundle["index.html"])

    def test_http_serves_current_public_data_without_admin_or_mutation_routes(self):
        base = self.start_server()
        for route, expected_type in (("/", "text/html"), ("/knowledge.json", "application/json"),
                                     ("/manifest.json", "application/json"), ("/sitemap.xml", "xml"),
                                     ("/robots.txt", "text/plain")):
            with self.subTest(route=route):
                with urlopen(base + route, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn(expected_type, response.headers["Content-Type"])
                    self.assertIn("no-store", response.headers.get("Cache-Control", ""))
                    self.assertNotIn(b"SECRETO_INTERNO_ALFA", response.read())
        for route in ("/v1/public/catalog", "/v1/router/plan", "/../knowledge.json"):
            with self.subTest(route=route), self.assertRaises(HTTPError) as error:
                urlopen(base + route, timeout=5)
            self.assertEqual(error.exception.code, 404)
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(base + "/", data=b"{}", method="POST"), timeout=5)
        self.assertIn(error.exception.code, (404, 405, 501))

    def test_http_refresh_withdraws_evidence_and_then_returns_not_found(self):
        base = self.start_server()
        with urlopen(base + "/knowledge.json", timeout=5) as response:
            self.assertIn("Alfa ofrece mantenimiento industrial", response.read().decode())
        import_company(self.url, "alfa", (self.records[0],))
        with urlopen(base + "/knowledge.json", timeout=5) as response:
            self.assertNotIn("Alfa ofrece mantenimiento industrial", response.read().decode())
        import_company(self.url, "alfa", ())
        with self.assertRaises(HTTPError) as error:
            urlopen(base + "/knowledge.json", timeout=5)
        self.assertEqual(error.exception.code, 404)

    def test_http_prefix_and_canonical_are_configured_independent_of_host_header(self):
        base = self.start_server("https://alfa.example.test/geo/")
        request = Request(base + "/geo/knowledge.json", headers={"Host": "attacker.example.test"})
        with urlopen(request, timeout=5) as response:
            knowledge = json.load(response)
        self.assertEqual(knowledge["canonical_url"], "https://alfa.example.test/geo/")
        with urlopen(Request(base + "/geo/", method="HEAD"), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")
            self.assertGreater(int(response.headers["Content-Length"]), 0)
        with urlopen(base + "/robots.txt", timeout=5) as response:
            self.assertIn("https://alfa.example.test/geo/sitemap.xml", response.read().decode())
        with self.assertRaises(HTTPError) as error:
            urlopen(base + "/knowledge.json", timeout=5)
        self.assertEqual(error.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
