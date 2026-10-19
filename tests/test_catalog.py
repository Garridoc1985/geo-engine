import copy
import csv
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from uuid import uuid4
from urllib.request import urlopen, Request
from urllib.error import HTTPError

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from geo_engine.catalog import FIELDS, import_catalog, load_catalog, save_catalog, validate_catalog
from geo_engine.storage import initialize
from geo_engine.api import create_server
from geo_engine.config import Config
from geo_engine.retrieval import search_public
from geo_engine.router import Router

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "catalog.demo.json"


def sample():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class CatalogValidationTests(unittest.TestCase):
    def test_json_csv_and_memory_have_same_contract(self):
        records = sample()
        expected = validate_catalog(records)
        self.assertEqual(load_catalog(FIXTURE), expected)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "catalog.csv"
            with path.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=sorted(FIELDS))
                writer.writeheader()
                for record in records:
                    writer.writerow({**record, "allowed_principals": json.dumps(record["allowed_principals"])})
            self.assertEqual(load_catalog(path), expected)

    def test_invalid_batches_rejected(self):
        invalid = [[], {}, [None]]
        for key, value in [("visibility", "secret"), ("visibility", None), ("allowed_principals", "admin"),
                           ("allowed_principals", [{}]), ("allowed_principals", ["admin", "admin"]),
                           ("source_reference", " "), ("id", "../escape"), ("kind", "unknown")]:
            records = sample()
            records[-1][key] = value
            invalid.append(records)
        duplicate = sample()
        duplicate[-1]["id"] = duplicate[0]["id"]
        invalid.append(duplicate)
        missing_acl = sample()
        del missing_acl[-1]["allowed_principals"]
        invalid.append(missing_acl)
        for records in invalid:
            with self.subTest(records=repr(records)[:60]):
                with self.assertRaises(ValueError):
                    validate_catalog(records)

    def test_validation_before_connecting(self):
        with self.assertRaises(ValueError):
            import_catalog("postgresql://invalid", [{"id": "bad"}])

    def test_internal_without_acl_is_not_public(self):
        record = sample()[-1]
        record["allowed_principals"] = []
        self.assertEqual(validate_catalog([record])[0].visibility, "internal")


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class CatalogPostgreSQLTests(unittest.TestCase):
    def setUp(self):
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_catalog_test_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        initialize(self.url)

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def test_ten_items_idempotence_sources_and_permissions(self):
        items = load_catalog(FIXTURE)
        self.assertEqual(save_catalog(self.url, items), {"processed": 10, "imported": 10, "unchanged": 0})
        self.assertEqual(save_catalog(self.url, items), {"processed": 10, "imported": 0, "unchanged": 10})
        with psycopg.connect(self.url) as db:
            for table in ("sources", "documents", "chunks"):
                count = db.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]
                self.assertEqual(count, 10)
            rows = db.execute("""SELECT d.visibility, d.allowed_principals, c.visibility, c.allowed_principals, s.reference
                FROM documents d JOIN chunks c ON c.document_id=d.id JOIN sources s ON s.id=d.source_id
                WHERE d.visibility='internal' ORDER BY d.id""").fetchall()
            self.assertEqual(rows, [
                ("internal", ["demo-sales"], "internal", ["demo-sales"], "demo://catalog/demo-09"),
                ("internal", ["demo-admin"], "internal", ["demo-admin"], "demo://catalog/demo-10"),
            ])

    def test_conflict_rolls_back_earlier_insert(self):
        records = sample()
        import_catalog(self.url, [records[0]])
        conflict = copy.deepcopy(records[0])
        conflict["description"] = "Contenido diferente"
        with self.assertRaises(ValueError):
            import_catalog(self.url, [records[1], conflict])
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sources").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0], 1)

    def test_invalid_batch_leaves_database_empty(self):
        records = sample()
        records[-1]["visibility"] = "invalid"
        with self.assertRaises(ValueError):
            import_catalog(self.url, records)
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 0)

    def test_database_error_rolls_back_batch(self):
        with psycopg.connect(self.url) as db:
            db.execute("ALTER TABLE documents ADD CONSTRAINT simulated_failure CHECK (title <> 'Organización documental')")
        with self.assertRaises(psycopg.errors.CheckViolation):
            import_catalog(self.url, sample())
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sources").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0], 0)

    def test_public_api_excludes_internal_documents_and_chunks(self):
        import_catalog(self.url, sample())
        with psycopg.connect(self.url) as db:
            # Aunque un fragmento se marque público, su documento interno lo excluye.
            db.execute("UPDATE chunks SET visibility='public' WHERE id='catalog:demo-09:chunk:1'")
            # Aunque el documento sea público, su fragmento interno queda excluido.
            db.execute("UPDATE chunks SET visibility='internal' WHERE id='catalog:demo-01:chunk:1'")
        server = create_server(Config("127.0.0.1", 0, self.url))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(f"http://127.0.0.1:{server.server_port}/v1/public/catalog", timeout=5) as response:
                self.assertEqual(response.status, 200)
                body = json.load(response)
            self.assertEqual(len(body["items"]), 7)
            serialized = json.dumps(body)
            for excluded in ("demo-01", "demo-09", "demo-10", "CONTENIDO_INTERNO", "demo-sales", "demo-admin"):
                self.assertNotIn(excluded, serialized)
            for item in body["items"]:
                self.assertTrue(item["source"]["reference"].startswith("demo://catalog/"))
                self.assertTrue(item["chunk_id"])
                self.assertTrue(item["document_id"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_router_plan_recovers_sources_without_calling_provider(self):
        import_catalog(self.url, sample())

        class UncalledProvider:
            name = "claude"
            model = "test-model"
            available = True

            def generate(self, prompt):
                raise AssertionError("El endpoint plan no debe consumir APIs")

        router = Router([UncalledProvider()], lambda text: search_public(self.url, text))
        server = create_server(Config("127.0.0.1", 0, self.url), router)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            for query, status in [("diagnóstico comercial", "ready"), ("CONTENIDO_INTERNO_DEMO_09", "insufficient_evidence"), ("astronomía galáctica", "insufficient_evidence")]:
                request = Request(base + "/v1/router/plan", data=json.dumps({"query": query, "origin": "perplexity"}).encode(), headers={"Content-Type": "application/json"})
                with urlopen(request, timeout=5) as response:
                    body = json.load(response)
                self.assertEqual(body["status"], status)
                self.assertEqual(body["origin"], "perplexity")
                if status == "ready":
                    self.assertEqual(body["provider"], "claude")
                    self.assertTrue(body["sources"])
                else:
                    self.assertEqual(body["sources"], [])
            for payload in [{"query": "diagnóstico", "principal": "admin"}, {"query": "diagnóstico", "execute": True}, {"query": []}]:
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/v1/router/plan", data=json.dumps(payload).encode()), timeout=5)
                self.assertEqual(error.exception.code, 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
