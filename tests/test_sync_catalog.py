import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from geo_engine.company_knowledge import KnowledgeRecord
from geo_engine.company_store import import_company
from geo_engine.public_catalog import read_public_catalog
from geo_engine.storage import initialize
from geo_engine.sync_catalog import sync_catalog
from geo_engine.web_reader import read_public_web


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.counter = 0

    def capture(self, pages=("services",), content="Servicio vigente"):
        self.counter += 1
        manifest = self.root / f"manifest-{self.counter}.json"
        output = self.root / f"snapshot-{self.counter}"
        manifest.write_text(json.dumps({"company_id": "example", "pages": [
            {"url": f"https://example.com/{page}/", "title": page, "public_authorized": True}
            for page in pages]}), encoding="utf-8")
        with patch("geo_engine.web_reader.fetch_html", return_value=f"<main>{content}</main>"):
            read_public_web(manifest, output)
        return output

    def test_incomplete_or_modified_snapshot_never_connects(self):
        for alteration in ("receipt", "content", "missing"):
            snapshot = self.capture()
            if alteration == "receipt":
                (snapshot / "snapshot.json").unlink()
            else:
                evidence = next((snapshot / "clients/example/evidence").glob("*.md"))
                if alteration == "content":
                    evidence.write_text("Texto manipulado", encoding="utf-8")
                else:
                    evidence.unlink()
            with self.subTest(alteration=alteration), patch("geo_engine.company_store.psycopg.connect") as connect:
                with self.assertRaises(ValueError):
                    sync_catalog("unused", "example", "website", workspace=snapshot, apply=True)
                connect.assert_not_called()

    def test_wrong_company_scope_and_expected_version_are_rejected(self):
        snapshot = self.capture()
        for company, scope, expected in [("other", "website", None), ("example", "../bad", None), ("example", "website", "wrong")]:
            with patch("geo_engine.company_store.psycopg.connect") as connect:
                with self.assertRaises(ValueError):
                    sync_catalog("unused", company, scope, workspace=snapshot, expected_version=expected)
                connect.assert_not_called()

    def test_clear_must_be_explicit_and_exclusive(self):
        for kwargs in ({}, {"workspace": self.capture(), "clear": True}):
            with self.assertRaises(ValueError):
                sync_catalog("unused", "example", "website", **kwargs)


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere PostgreSQL")
class SyncCatalogTests(unittest.TestCase):
    capture = SnapshotTests.capture

    def setUp(self):
        SnapshotTests.setUp(self)
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_sync_test_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        initialize(self.url)

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def test_preview_rolls_back_all_content_and_company_writes(self):
        snapshot = self.capture()
        report = sync_catalog(self.url, "example", "website", workspace=snapshot)
        self.assertEqual(report["status"], "preview")
        self.assertTrue(report["changed"])
        with psycopg.connect(self.url) as db:
            for table in ("companies", "sources", "documents", "chunks", "company_documents"):
                self.assertEqual(db.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0], 0)

    def test_revisions_and_removals_preserve_other_sources_and_companies(self):
        manual = KnowledgeRecord("domain:company_profile", "Perfil", "Perfil manual", "https://example.com/", "public", ())
        import_company(self.url, "example", (manual,))
        import_company(self.url, "other", (manual,))
        snapshot = self.capture(pages=("services", "about"), content="Versión inicial")
        sync_catalog(self.url, "example", "website", workspace=snapshot, apply=True)
        sync_catalog(self.url, "example", "secondary", workspace=snapshot, apply=True)
        newer = self.capture(content="Versión nueva")
        report = sync_catalog(self.url, "example", "website", workspace=newer, apply=True)
        self.assertEqual(report["deactivated"], 2)
        self.assertEqual(report["activated"], 1)
        public = read_public_catalog(self.url, "example")["items"]
        self.assertEqual(len(public), 4)
        self.assertEqual(len(read_public_catalog(self.url, "other")["items"]), 1)
        self.assertTrue(any("Perfil manual" in i["content"] for i in public))
        repeated = sync_catalog(self.url, "example", "website", workspace=newer, apply=True)
        self.assertFalse(repeated["changed"])
        self.assertEqual(repeated["imported"], 0)
        sync_catalog(self.url, "example", "website", clear=True, apply=True)
        self.assertEqual(len(read_public_catalog(self.url, "example")["items"]), 3)
        # Conventional imports cannot deactivate a synchronized source.
        import_company(self.url, "example", ())
        self.assertEqual(len(read_public_catalog(self.url, "example")["items"]), 2)
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 7)

    def test_changed_preview_preserves_current_public_version(self):
        first = self.capture(content="Texto anterior")
        sync_catalog(self.url, "example", "website", workspace=first, apply=True)
        before = read_public_catalog(self.url)
        second = self.capture(content="Texto nuevo")
        preview = sync_catalog(self.url, "example", "website", workspace=second)
        self.assertEqual(preview["deactivated"], 1)
        self.assertEqual(read_public_catalog(self.url), before)

    def test_transaction_failure_keeps_previous_snapshot(self):
        first = self.capture()
        sync_catalog(self.url, "example", "website", workspace=first, apply=True)
        before = read_public_catalog(self.url)
        with psycopg.connect(self.url) as db:
            db.execute("ALTER TABLE chunks ADD CONSTRAINT reject_marker CHECK (content NOT LIKE '%REJECT_MARKER%')")
        bad = self.capture(pages=("services", "about"), content="REJECT_MARKER")
        with self.assertRaises(psycopg.Error):
            sync_catalog(self.url, "example", "website", workspace=bad, apply=True)
        self.assertEqual(read_public_catalog(self.url), before)

    def test_cli_defaults_to_preview_and_apply_uses_same_snapshot(self):
        from geo_engine.cli import main
        from geo_engine.config import Config
        snapshot = self.capture()
        args = ["geo", "sync-catalog", "--company", "example", "--scope", "website", "--workspace", str(snapshot)]
        for extra, status in [([], "preview"), (["--apply"], "applied")]:
            output = io.StringIO()
            with patch("sys.argv", args + extra), patch("geo_engine.cli.Config.from_env", return_value=Config("127.0.0.1", 8000, self.url)), contextlib.redirect_stdout(output):
                self.assertEqual(main(), 0)
            self.assertEqual(json.loads(output.getvalue())["status"], status)
