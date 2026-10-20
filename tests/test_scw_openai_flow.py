"""Recorrido real CLI/SCW/PostgreSQL; solo el transporte HTTP se simula."""
import contextlib
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from geo_engine.cli import main
from geo_engine.config import Config
from geo_engine.providers import ProviderError
from geo_engine.runs import PostgresRunStore


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class SCWOpenAIFlowTests(unittest.TestCase):
    def setUp(self):
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_openai_flow_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        environment = patch.dict(os.environ, {
            "DATABASE_URL": self.url, "OPENAI_API_KEY": "synthetic-test-key",
            "OPENAI_MODEL": "synthetic-model", "GEO_HOST": "127.0.0.1", "GEO_PORT": "8000",
        })
        environment.start()
        self.addCleanup(environment.stop)
        config = patch("geo_engine.cli.Config.from_env", return_value=Config("127.0.0.1", 8000, self.url))
        config.start()
        self.addCleanup(config.stop)
        self.transport = patch("geo_engine.providers.urlopen")
        self.http = self.transport.start()
        self.addCleanup(self.transport.stop)
        workspace = Path(__file__).resolve().parents[1] / "fixtures" / "scw_demo"
        code, imported = self.cli("ingest-company", "demo_company", "--workspace", str(workspace))
        self.assertEqual(code, 0)
        self.assertEqual(imported["imported"], 4)

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def cli(self, *args):
        output = io.StringIO()
        with patch("sys.argv", ["geo", *args]), contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            code = main()
        return code, json.loads(output.getvalue()) if output.getvalue() else None

    def generate(self, request_id, company="demo_company"):
        return self.cli("geo", "Describe la empresa GEO Engine", "--company", company,
                        "--task", "company_profile", "--provider", "chatgpt",
                        "--execute", "--request-id", request_id)

    def test_scw_to_responses_and_persisted_draft_without_internal_context(self):
        text = "GEO Engine ofrece mantenimiento predictivo."
        body = {"status": "completed", "output": [{"type": "message", "status": "completed",
                "content": [{"type": "output_text", "text": text}]}]}
        self.http.return_value.__enter__.return_value.read.return_value = json.dumps(body).encode()
        run_id = str(uuid4())
        code, result = self.generate(run_id)
        self.assertEqual((code, result["status"], result["recorded"]), (0, "draft", True))
        self.http.assert_called_once()
        request = self.http.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
        payload = json.loads(request.data)
        self.assertFalse(payload["store"])
        self.assertEqual(payload["model"], "synthetic-model")
        context = json.loads(payload["input"].splitlines()[-1])
        self.assertTrue(context["evidence"])
        self.assertNotIn("MARCADOR_INTERNO_AURORA", payload["input"])
        self.assertNotIn("MARCADOR_RETIRADO", payload["input"])
        self.assertTrue(all(e["document_id"].startswith("scw:demo_company:") for e in context["evidence"]))
        self.assertEqual({e["chunk_id"] for e in context["evidence"]},
                         {e["chunk_id"] for e in result["sources"]})
        code, saved = self.cli("show-run", run_id)
        self.assertEqual((code, saved["text"], saved["provider"], saved["company_id"]),
                         (0, text, "chatgpt", "demo_company"))
        self.assertEqual(saved["sources"], result["sources"])
        self.assertEqual(saved["pipeline"]["phase"], "provider_completed")
        self.assertEqual(self.generate(run_id)[0], 1)
        self.http.assert_called_once()

    def test_provider_failure_is_recorded_without_draft_or_retry(self):
        self.http.side_effect = ProviderError("http_429", retryable=True)
        run_id = str(uuid4())
        code, result = self.generate(run_id)
        self.assertEqual((code, result["status"]), (2, "provider_error"))
        self.http.assert_called_once()
        saved = PostgresRunStore(self.url).get(run_id)
        self.assertEqual(saved["attempts"][0]["code"], "http_429")
        self.assertIsNone(saved["text"])
        self.assertIsNone(saved["result_id"])

    def test_unknown_company_never_sends_another_company_to_provider(self):
        run_id = str(uuid4())
        code, result = self.generate(run_id, company="missing_company")
        self.assertEqual((code, result["status"], result["sources"]), (2, "insufficient_evidence", []))
        self.http.assert_not_called()
        saved = PostgresRunStore(self.url).get(run_id)
        self.assertEqual(saved["text"], "información insuficiente")
        self.assertEqual(saved["company_id"], "missing_company")
