import json
import unittest
from geo_engine.contracts import Evidence, Source
from geo_engine.providers import ProviderError
from geo_engine.router import Router, RouterQuery

EVIDENCE = (Evidence("c1", "d1", Source("s1", "demo://public", "Public"), "Diagnóstico comercial ficticio"),)


class FakeProvider:
    def __init__(self, name, available=True, error=None):
        self.name = name
        self.model = "test-model"
        self.available = available
        self.error = error
        self.calls = []

    def generate(self, prompt):
        self.calls.append(prompt)
        if self.error:
            raise self.error
        return "Borrador [s1]"


class RouterTests(unittest.TestCase):
    def test_priority_independent_of_input_order_and_origin(self):
        providers = [FakeProvider("perplexity"), FakeProvider("chatgpt"), FakeProvider("claude")]
        for origin in ("claude", "chatgpt", "perplexity", "another_ai"):
            response = Router(providers, lambda _: EVIDENCE).route(RouterQuery("Diagnóstico", origin))
            self.assertEqual(response["provider"], "claude")
            self.assertEqual(response["origin"], origin)
            self.assertEqual(response["status"], "ready")
        self.assertTrue(all(not p.calls for p in providers))

    def test_unconfigured_skipped_and_first_success_stops(self):
        providers = [FakeProvider("claude", available=False), FakeProvider("chatgpt"), FakeProvider("perplexity")]
        response = Router(providers, lambda _: EVIDENCE).route(RouterQuery("Diagnóstico"), execute=True)
        self.assertEqual(response["provider"], "chatgpt")
        self.assertEqual(response["status"], "draft")
        self.assertEqual(len(providers[1].calls), 1)
        self.assertFalse(providers[2].calls)
        self.assertIn("demo://public", providers[1].calls[0])
        self.assertEqual(response["sources"][0]["source_id"], "s1")

    def test_no_evidence_means_no_call(self):
        provider = FakeProvider("claude")
        response = Router([provider], lambda _: ()).route(RouterQuery("Sin respaldo"), execute=True)
        self.assertEqual(response["text"], "información insuficiente")
        self.assertFalse(provider.calls)
        self.assertEqual(response["attempts"], [])

    def test_retry_requires_explicit_fallback_and_temporary_error(self):
        for enabled, retryable, expected in [(False, True, "provider_error"), (True, False, "provider_error"), (True, True, "draft")]:
            with self.subTest(enabled=enabled, retryable=retryable):
                providers = [FakeProvider("claude", error=ProviderError("rate_limited", retryable=retryable)), FakeProvider("chatgpt")]
                response = Router(providers, lambda _: EVIDENCE).route(RouterQuery("Diagnóstico"), execute=True, allow_fallback=enabled)
                self.assertEqual(response["status"], expected)
                self.assertEqual(bool(providers[1].calls), enabled and retryable)

    def test_no_provider_available(self):
        response = Router([FakeProvider("claude", available=False)], lambda _: EVIDENCE).route(RouterQuery("Diagnóstico"))
        self.assertEqual(response["status"], "no_provider")
        self.assertIsNone(response["provider"])

    def test_trace_contains_no_query_or_content(self):
        query = "private-query-marker"
        response = Router([FakeProvider("claude")], lambda _: EVIDENCE).route(RouterQuery(query), execute=True)
        self.assertNotIn(query, json.dumps(response))
        self.assertNotIn(EVIDENCE[0].content, json.dumps(response))

    def test_invalid_queries_and_duplicate_providers(self):
        for query, origin in [("", "generic"), (None, "generic"), ("x" * 4001, "generic"), ("hi", "../admin")]:
            with self.assertRaises(ValueError):
                RouterQuery(query, origin)
        with self.assertRaises(ValueError):
            Router([FakeProvider("claude"), FakeProvider("claude")], lambda _: EVIDENCE)
