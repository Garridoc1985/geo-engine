import json
import os
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from geo_engine.api import create_server
from geo_engine.company_knowledge import CompanyKnowledge, KnowledgeRecord
from geo_engine.company_store import import_company
from geo_engine.config import Config
from geo_engine.retrieval import search_public
from geo_engine.router import Router, RouterQuery
from geo_engine.runs import PostgresRunStore
from geo_engine.storage import initialize
from geo_engine.public_catalog import read_public_catalog

WORKSPACE = Path(__file__).resolve().parents[1] / "fixtures" / "scw_demo"


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class CompanyStoreTests(unittest.TestCase):
    def setUp(self):
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_company_test_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        initialize(self.url)
        self.records = CompanyKnowledge(WORKSPACE, "demo_company").load()

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def test_scw_import_and_reload_preserve_company_and_private_default(self):
        self.assertEqual(len(self.records), 4)
        first = import_company(self.url, "demo_company", self.records)
        self.assertEqual(first["imported"], 4)
        second = import_company(self.url, "demo_company", self.records)
        self.assertEqual(second["existing"], 4)
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM company_documents").fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT visibility,count(*) FROM documents GROUP BY visibility ORDER BY visibility").fetchall(), [("internal", 1), ("public", 3)])
            self.assertEqual(db.execute("SELECT count(*) FROM chunks WHERE content LIKE '%MARCADOR_RETIRADO%'").fetchone()[0], 0)
        self.assertEqual(search_public(self.url, "MARCADOR_INTERNO_AURORA", company_id="demo_company"), ())

    def test_retrieval_is_scoped_to_requested_company(self):
        import_company(self.url, "demo_company", self.records)
        other = KnowledgeRecord("domain:products_services", "Boreal", "Boreal realiza mantenimiento predictivo industrial.", "demo://boreal/products", "public", ())
        import_company(self.url, "boreal", (other,))
        aurora = search_public(self.url, "mantenimiento predictivo", company_id="demo_company")
        boreal = search_public(self.url, "mantenimiento predictivo", company_id="boreal")
        self.assertTrue(aurora)
        self.assertTrue(boreal)
        self.assertTrue(all(e.document_id.startswith("scw:demo_company:") for e in aurora))
        self.assertTrue(all(e.document_id.startswith("scw:boreal:") for e in boreal))
        self.assertNotIn("Boreal", " ".join(e.content for e in aurora))
        self.assertEqual(search_public(self.url, "mantenimiento predictivo", company_id="missing"), ())

    def test_conflict_rolls_back_new_records(self):
        import_company(self.url, "demo_company", self.records)
        new = KnowledgeRecord("domain:current_projects", "Proyecto", "Proyecto ficticio nuevo", "demo://new", "internal", ())
        conflict = replace(self.records[0], content="Contenido distinto")
        with self.assertRaises(ValueError):
            import_company(self.url, "demo_company", (new, conflict))
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT count(*) FROM sources").fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT count(*) FROM company_documents").fetchone()[0], 4)

    def test_reload_withdraws_removed_evidence_from_all_public_outputs(self):
        import_company(self.url, "demo_company", self.records)
        before = search_public(self.url, "anomalías", company_id="demo_company")
        self.assertTrue(before)
        remaining = tuple(record for record in self.records if not record.id.startswith("evidence:"))
        result = import_company(self.url, "demo_company", remaining)
        self.assertEqual(result["deactivated"], 1)
        self.assertEqual(search_public(self.url, "anomalías", company_id="demo_company"), ())
        self.assertEqual(search_public(self.url, "anomalías"), ())
        public_ids = [item["document_id"] for item in read_public_catalog(self.url)["items"]]
        self.assertNotIn(before[0].document_id, public_ids)
        store = PostgresRunStore(self.url)
        run_id = str(uuid4())
        store.begin(run_id, "generic", True)
        evidence = before[0]
        with self.assertRaises(ValueError):
            store.complete({"request_id": run_id, "origin": "generic", "company_id": "demo_company", "status": "draft",
                            "provider": "claude", "model": "test-model", "text": "Borrador ficticio", "attempts": [],
                            "sources": [{"chunk_id": evidence.chunk_id, "document_id": evidence.document_id,
                                         "source_id": evidence.source.id, "reference": evidence.source.reference}]}, True)

    def test_reload_applies_permission_changes_without_overwriting_content(self):
        import_company(self.url, "demo_company", self.records)
        self.assertTrue(search_public(self.url, "automatización industrial", company_id="demo_company"))
        private = tuple(replace(record, visibility="internal", allowed_principals=()) if record.id == "domain:company_profile" else record for record in self.records)
        import_company(self.url, "demo_company", private)
        self.assertEqual(search_public(self.url, "automatización industrial", company_id="demo_company"), ())

    def test_empty_snapshot_deactivates_company_without_deleting_history(self):
        import_company(self.url, "demo_company", self.records)
        result = import_company(self.url, "demo_company", ())
        self.assertEqual(result["deactivated"], 4)
        self.assertEqual(search_public(self.url, "mantenimiento predictivo", company_id="demo_company"), ())
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 4)

    def test_scw_knowledge_reaches_router_and_saved_company_context(self):
        import_company(self.url, "demo_company", self.records)

        class DemoProvider:
            name = "claude"
            model = "test-model"
            available = True

            def generate(self, prompt):
                self.prompt = prompt
                return "Aurora ofrece mantenimiento predictivo industrial."

        provider = DemoProvider()
        store = PostgresRunStore(self.url)
        router = Router([provider], lambda text, company_id=None: search_public(self.url, text, company_id=company_id), store)
        result = router.route(RouterQuery("mantenimiento predictivo", "perplexity", company_id="demo_company"), execute=True)
        self.assertEqual(result["status"], "draft")
        self.assertEqual(result["company_id"], "demo_company")
        self.assertIn("Aurora", provider.prompt)
        self.assertNotIn("MARCADOR_INTERNO", provider.prompt)
        self.assertNotIn("MARCADOR_RETIRADO", provider.prompt)
        saved = store.get(result["request_id"])
        self.assertEqual(saved["company_id"], "demo_company")
        self.assertEqual(saved["text"], result["text"])

    def test_http_plan_accepts_company_scope(self):
        import_company(self.url, "demo_company", self.records)
        router = Router([], lambda text, company_id=None: search_public(self.url, text, company_id=company_id), PostgresRunStore(self.url))
        server = create_server(Config("127.0.0.1", 0, self.url), router)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(f"http://127.0.0.1:{server.server_port}/v1/router/plan", data=json.dumps({"query": "mantenimiento predictivo", "company_id": "demo_company", "origin": "chatgpt"}).encode())
            with urlopen(request, timeout=5) as response:
                body = json.load(response)
            self.assertEqual(body["company_id"], "demo_company")
            self.assertTrue(body["sources"])
            self.assertTrue(all(s["document_id"].startswith("scw:demo_company:") for s in body["sources"]))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
