import copy
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from geo_engine.runs import PostgresRunStore
from geo_engine.storage import initialize


def response(run_id, status="draft"):
    return {
        "request_id": run_id, "origin": "claude", "status": status,
        "provider": "claude", "model": "test-model",
        "text": "Borrador sintético [s1]",
        "attempts": [{"provider": "claude", "model": "test-model", "status": "completed"}],
        "sources": [{"chunk_id": "c1", "document_id": "d1", "source_id": "s1", "reference": "demo://one"}],
    }


class RunValidationTests(unittest.TestCase):
    def test_invalid_ids_and_modes_rejected_before_connecting(self):
        store = PostgresRunStore("postgresql://invalid")
        with patch("geo_engine.runs.psycopg.connect") as connect:
            for invalid in ("", "../admin", None, 123):
                for operation in (store.get, store.fail):
                    with self.assertRaises(ValueError):
                        operation(invalid)
                with self.assertRaises(ValueError):
                    store.begin(invalid, "claude", False)
            for origin, execute in (("../admin", False), ("claude", "false"), ("claude", 1)):
                with self.assertRaises(ValueError):
                    store.begin(str(uuid4()), origin, execute)
            connect.assert_not_called()

    def test_incompatible_result_and_unsafe_attempts_rejected_before_connecting(self):
        store = PostgresRunStore("postgresql://invalid")
        valid = response(str(uuid4()))
        invalid = [None, {**valid, "status": []}, {**valid, "status": "started"},
                   {**valid, "sources": []}, {**valid, "text": ""},
                   {**valid, "attempts": [{"provider": "claude", "status": []}]},
                   {**valid, "attempts": [{"provider": "claude", "status": "error", "code": "raw body\nsecret"}]}]
        with patch("geo_engine.runs.psycopg.connect") as connect:
            for item in invalid:
                with self.subTest(item=item):
                    with self.assertRaises(ValueError):
                        store.complete(item, True)
            with self.assertRaises(ValueError):
                store.complete(valid, False)
            connect.assert_not_called()


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class RunPostgreSQLTests(unittest.TestCase):
    def setUp(self):
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_run_test_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        initialize(self.url)
        self.store = PostgresRunStore(self.url)
        with psycopg.connect(self.url) as db:
            for number in (1, 2):
                db.execute("INSERT INTO sources VALUES (%s, %s, %s)",
                           (f"s{number}", "demo://one" if number == 1 else "demo://two", "Synthetic"))
                db.execute("INSERT INTO documents (id, source_id, title, visibility) VALUES (%s, %s, 'Synthetic', 'public')",
                           (f"d{number}", f"s{number}"))
                db.execute("INSERT INTO chunks (id, document_id, content, visibility) VALUES (%s, %s, 'Synthetic content', 'public')",
                           (f"c{number}", f"d{number}"))

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def count(self, table):
        with psycopg.connect(self.url) as db:
            return db.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]

    def begin(self, execute=True):
        run_id = str(uuid4())
        self.store.begin(run_id, "claude", execute)
        return run_id

    def test_duplicate_reservation_does_not_overwrite_started_or_completed(self):
        run_id = self.begin()
        for origin in ("claude", "perplexity"):
            with self.assertRaises(ValueError):
                self.store.begin(run_id, origin, True)
        reserved = self.store.get(run_id)
        self.assertEqual((reserved["status"], reserved["origin"]), ("started", "claude"))
        self.assertIsNone(reserved["finished_at"])
        self.store.complete(response(run_id), True)
        with self.assertRaises(ValueError):
            self.store.begin(run_id, "claude", True)
        self.assertEqual(self.count("router_runs"), 1)
        self.assertEqual(self.count("results"), 1)

    def test_draft_and_sources_are_persisted_and_readable_without_raw_payloads(self):
        run_id = self.begin()
        result = response(run_id)
        result.update(query="query-secret-marker", prompt="prompt-secret-marker")
        result["attempts"][0].update(error_body="error-secret-marker", api_key="key-secret-marker")
        result["sources"][0].update(content="content-secret-marker")
        self.store.complete(result, True)
        saved = self.store.get(run_id)
        self.assertEqual(saved["status"], "draft")
        self.assertEqual(saved["text"], result["text"])
        self.assertEqual(saved["result_id"], run_id)
        self.assertEqual(saved["mode"], "execute")
        self.assertEqual(saved["sources"], response(run_id)["sources"])
        self.assertIsInstance(saved["started_at"], str)
        self.assertIsInstance(saved["finished_at"], str)
        self.assertEqual(saved["attempts"], response(run_id)["attempts"])
        serialized = json.dumps(saved)
        for marker in ("query-secret", "prompt-secret", "error-secret", "key-secret", "content-secret"):
            self.assertNotIn(marker, serialized)
        with psycopg.connect(self.url) as db:
            self.assertEqual(db.execute("SELECT id, branch, status, content FROM results").fetchall(),
                             [(run_id, "geo", "draft", result["text"])])
            self.assertEqual(db.execute("SELECT result_id, chunk_id FROM result_evidence").fetchall(), [(run_id, "c1")])

    def test_plans_never_create_results_including_insufficient_evidence(self):
        for status in ("ready", "insufficient_evidence", "no_provider"):
            with self.subTest(status=status):
                run_id = self.begin(False)
                result = response(run_id, status)
                if status != "ready":
                    result.update(provider=None, model=None, attempts=[], sources=[])
                self.store.complete(result, False)
                saved = self.store.get(run_id)
                self.assertEqual(saved["status"], status)
                self.assertEqual(saved["mode"], "plan")
                self.assertIsNone(saved["result_id"])
                self.assertIsNone(saved["text"])
        self.assertEqual(self.count("results"), 0)
        self.assertEqual(self.count("result_evidence"), 0)

    def test_insufficient_execution_saves_fixed_message_without_draft_text(self):
        run_id = self.begin()
        result = response(run_id, "insufficient_evidence")
        result.update(provider=None, model=None, attempts=[], sources=[], text="untrusted-extra-marker")
        self.store.complete(result, True)
        saved = self.store.get(run_id)
        self.assertEqual(saved["text"], "información insuficiente")
        self.assertEqual(saved["result_id"], run_id)
        self.assertEqual(self.count("result_evidence"), 0)

    def test_failures_store_metadata_without_generated_results(self):
        for status in ("no_provider", "provider_error"):
            with self.subTest(status=status):
                run_id = self.begin()
                result = response(run_id, status)
                result.update(text="ignored-error-body", attempts=[{
                    "provider": "claude", "model": "test-model", "status": "error", "code": "http_429",
                }])
                self.store.complete(result, True)
                saved = self.store.get(run_id)
                self.assertEqual(saved["status"], status)
                self.assertIsNone(saved["text"])
                self.assertIsNone(saved["result_id"])
        self.assertEqual(self.count("results"), 0)

    def test_reference_mismatch_or_missing_evidence_rolls_back_whole_result(self):
        valid_second = {"chunk_id": "c2", "document_id": "d2", "source_id": "s2", "reference": "demo://two"}
        for field, invalid in (("chunk_id", "missing"), ("document_id", "d1"),
                               ("source_id", "s1"), ("reference", "demo://changed")):
            with self.subTest(field=field):
                run_id = self.begin()
                result = response(run_id)
                result["sources"].append({**valid_second, field: invalid})
                with self.assertRaises(ValueError):
                    self.store.complete(result, True)
                self.assertEqual(self.count("results"), 0)
                self.assertEqual(self.count("result_evidence"), 0)
                self.assertEqual(self.store.get(run_id)["status"], "started")

    def test_document_and_chunk_permissions_rechecked_after_generation(self):
        for table in ("documents", "chunks"):
            with self.subTest(table=table):
                run_id = self.begin()
                with psycopg.connect(self.url) as db:
                    db.execute(sql.SQL("UPDATE {} SET visibility='internal' WHERE id=%s").format(sql.Identifier(table)),
                               ("d1" if table == "documents" else "c1",))
                with self.assertRaises(ValueError):
                    self.store.complete(response(run_id), True)
                self.assertEqual(self.count("results"), 0)
                self.assertEqual(self.count("result_evidence"), 0)
                self.assertEqual(self.store.get(run_id)["status"], "started")
                with psycopg.connect(self.url) as db:
                    db.execute(sql.SQL("UPDATE {} SET visibility='public'").format(sql.Identifier(table)))

    def test_database_failure_rolls_back_result_references_and_completion(self):
        run_id = self.begin()
        result = response(run_id)
        result["sources"].append({"chunk_id": "c2", "document_id": "d2", "source_id": "s2", "reference": "demo://two"})
        with psycopg.connect(self.url) as db:
            db.execute("ALTER TABLE result_evidence ADD CONSTRAINT simulated_failure CHECK(chunk_id <> 'c2')")
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.store.complete(result, True)
        self.assertEqual(self.count("results"), 0)
        self.assertEqual(self.count("result_evidence"), 0)
        saved = self.store.get(run_id)
        self.assertEqual(saved["status"], "started")
        self.assertIsNone(saved["result_id"])
        self.assertIsNone(saved["finished_at"])

    def test_completing_wrong_mode_origin_or_finished_run_does_not_overwrite(self):
        run_id = self.begin()
        result = response(run_id)
        wrong_origin = {**result, "origin": "chatgpt"}
        for item, execute in ((wrong_origin, True), ({**result, "status": "ready"}, False)):
            with self.assertRaises(ValueError):
                self.store.complete(item, execute)
        self.store.complete(result, True)
        changed = copy.deepcopy(result)
        changed["text"] = "attempted-overwrite"
        with self.assertRaises(ValueError):
            self.store.complete(changed, True)
        self.assertEqual(self.store.get(run_id)["text"], result["text"])
        with self.assertRaises(ValueError):
            self.store.complete(response(str(uuid4())), True)
        self.assertEqual(self.count("results"), 1)

    def test_fail_only_changes_started_and_get_unknown_returns_none(self):
        run_id = self.begin()
        self.store.fail(run_id)
        failed = self.store.get(run_id)
        self.assertEqual(failed["status"], "failed")
        self.assertIsNotNone(failed["finished_at"])
        self.assertIsNone(failed["text"])
        self.store.fail(run_id)
        self.assertEqual(self.store.get(run_id), failed)
        with self.assertRaises(ValueError):
            self.store.complete(response(run_id), True)
        completed_id = self.begin()
        self.store.complete(response(completed_id), True)
        completed = self.store.get(completed_id)
        self.store.fail(completed_id)
        self.assertEqual(self.store.get(completed_id), completed)
        missing_id = str(uuid4())
        self.store.fail(missing_id)
        self.assertIsNone(self.store.get(missing_id))


if __name__ == "__main__":
    unittest.main()
