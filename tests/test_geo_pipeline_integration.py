import json
import io
import os
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4
from unittest.mock import patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from geo_engine.api import create_server
from geo_engine.company_knowledge import CompanyKnowledge
from geo_engine.company_store import import_company
from geo_engine.config import Config
from geo_engine.retrieval import search_public, task_context
from geo_engine.router import Router, RouterQuery
from geo_engine.runs import PostgresRunStore
from geo_engine.storage import initialize
from geo_engine.providers import build_providers_from_env


class OfflineProvider:
    name = "claude"
    model = "test-model"
    available = True

    def __init__(self):
        self.prompts = []

    def generate(self, prompt):
        self.prompts.append(prompt)
        return "Salida GEO ficticia de Aurora"


@unittest.skipUnless(os.getenv("GEO_TEST_DATABASE_URL"), "Requiere GEO_TEST_DATABASE_URL")
class GeoPipelineIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.base = os.environ["GEO_TEST_DATABASE_URL"]
        self.schema = "geo_pipeline_test_" + uuid4().hex
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        self.addCleanup(self.drop_schema)
        self.url = make_conninfo(self.base, options=f"-c search_path={self.schema}")
        initialize(self.url)
        root = Path(__file__).resolve().parents[1] / "fixtures" / "scw_demo"
        import_company(self.url, "demo_company", CompanyKnowledge(root, "demo_company").load())
        self.provider = OfflineProvider()
        self.store = PostgresRunStore(self.url)
        self.router = Router([self.provider],
                             lambda text, company_id=None: search_public(self.url, text, company_id=company_id),
                             self.store, lambda company, task: task_context(self.url, company, task))

    def drop_schema(self):
        with psycopg.connect(self.base) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema)))

    def test_general_company_tasks_use_scw_domains_and_persist_pipeline(self):
        for task, expected_format in [("company_profile", "company_profile"), ("catalog", "catalog_list"),
                                      ("faq", "faq_pairs"), ("geo_content", "geo_brief")]:
            with self.subTest(task=task):
                result = self.router.route(RouterQuery("prepara la información de esta empresa", company_id="demo_company", task=task), execute=True)
                self.assertEqual(result["status"], "draft")
                self.assertEqual(result["pipeline"]["task"], task)
                self.assertEqual(result["pipeline"]["output_format"], expected_format)
                self.assertEqual(result["pipeline"]["phase"], "provider_completed")
                self.assertEqual(result["pipeline"]["selection_reason"], "explicit_task")
                self.assertTrue(result["sources"])
                self.assertTrue(all(s["document_id"].startswith("scw:demo_company:") for s in result["sources"]))
                self.assertNotIn("MARCADOR_INTERNO", self.provider.prompts[-1])
                self.assertNotIn("MARCADOR_RETIRADO", self.provider.prompts[-1])
                self.assertEqual(self.store.get(result["request_id"])["pipeline"], result["pipeline"])

    def test_no_company_knowledge_prevents_generation(self):
        result = self.router.route(RouterQuery("genera preguntas frecuentes", company_id="missing", task="faq"), execute=True)
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertEqual(result["pipeline"]["phase"], "no_evidence")
        self.assertFalse(self.provider.prompts)

    def test_natural_factual_question_recovers_relevant_company_context(self):
        result = self.router.route(RouterQuery("¿Qué incluye el servicio de mantenimiento predictivo?", company_id="demo_company"))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["pipeline"]["task"], "answer")
        self.assertTrue(result["sources"])
        self.assertFalse(self.provider.prompts)

    def test_public_task_context_excludes_internal_and_inactive_records(self):
        with psycopg.connect(self.url) as db:
            db.execute("UPDATE company_documents SET active=false WHERE document_id LIKE '%products_services:document'")
            db.execute("UPDATE documents SET visibility='internal' WHERE id LIKE '%company_profile:document'")
        context = task_context(self.url, "demo_company", "faq")
        self.assertEqual(len(context), 1)
        self.assertIn("evidence:EV-000001", context[0].document_id)

    def test_http_geo_contract_plans_with_explicit_company_and_task(self):
        server = create_server(Config("127.0.0.1", 0, self.url), self.router)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base + "/v1/geo", timeout=5) as response:
                capabilities = json.load(response)
            self.assertIn("faq", capabilities["tasks"])
            for body, expected_status in [({"query": "crea preguntas frecuentes", "company_id": "demo_company", "task": "faq", "origin": "perplexity"}, 200),
                                           ({"query": "crea preguntas frecuentes", "task": "faq"}, 400),
                                           ({"query": "hola", "company_id": "demo_company", "task": "not_supported"}, 400),
                                           ({"query": "hola", "company_id": "demo_company", "execute": True}, 400)]:
                request = Request(base + "/v1/geo/plan", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
                if expected_status == 200:
                    with urlopen(request, timeout=5) as response:
                        result = json.load(response)
                    self.assertEqual(result["status"], "ready")
                    self.assertEqual(result["pipeline"]["task"], "faq")
                    self.assertEqual(result["provider"], "claude")
                    self.assertEqual(result["origin"], "perplexity")
                else:
                    with self.assertRaises(HTTPError) as error:
                        urlopen(request, timeout=5)
                    self.assertEqual(error.exception.code, expected_status)
            self.assertFalse(self.provider.prompts)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_chatgpt_only_flow_with_simulated_responses_and_real_postgresql(self):
        with patch.dict(os.environ, {"OPENAI_MODEL": "test-model", "OPENAI_API_KEY": "dummy-test-key",
                                     "CLAUDE_MODEL": "test-other", "ANTHROPIC_API_KEY": "dummy-other",
                                     "PERPLEXITY_MODEL": "test-other", "PERPLEXITY_API_KEY": "dummy-other"}, clear=True):
            providers = build_providers_from_env(only="chatgpt")
        router = Router(providers, lambda text, company_id=None: search_public(self.url, text, company_id=company_id),
                        self.store, lambda company, task: task_context(self.url, company, task))
        for task in ("answer", "company_profile", "faq"):
            with self.subTest(task=task):
                simulated = {"status": "completed", "output": [{"type": "message", "status": "completed", "content": [
                    {"type": "output_text", "text": f"Respuesta simulada de prueba para {task}"}]}]}
                with patch("geo_engine.providers.urlopen", return_value=io.BytesIO(json.dumps(simulated).encode())) as transport:
                    result = router.route(RouterQuery("mantenimiento predictivo", company_id="demo_company", task=task), execute=True)
                self.assertEqual(result["provider"], "chatgpt")
                self.assertEqual(result["status"], "draft")
                self.assertEqual(len(result["attempts"]), 1)
                self.assertEqual(result["pipeline"]["task"], task)
                request = transport.call_args.args[0]
                self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
                prompt = json.loads(request.data)["input"]
                self.assertIn("Aurora", prompt)
                self.assertNotIn("MARCADOR_INTERNO", prompt)
                saved = self.store.get(result["request_id"])
                self.assertEqual(saved["text"], result["text"])
                self.assertEqual(saved["sources"], result["sources"])
                self.assertEqual(saved["pipeline"], result["pipeline"])
