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
        providers = [FakeProvider("other_ai"), FakeProvider("chatgpt"), FakeProvider("claude")]
        for origin in ("claude", "chatgpt", "perplexity", "another_ai"):
            response = Router(providers, lambda _: EVIDENCE).route(RouterQuery("Diagnóstico", origin))
            self.assertEqual(response["provider"], "claude")
            self.assertEqual(response["origin"], origin)
            self.assertEqual(response["status"], "ready")
        self.assertTrue(all(not p.calls for p in providers))

    def test_unconfigured_skipped_and_first_success_stops(self):
        providers = [FakeProvider("claude", available=False), FakeProvider("chatgpt"), FakeProvider("other_ai")]
        response = Router(providers, lambda _: EVIDENCE).route(RouterQuery("Diagnóstico"), execute=True)
        self.assertEqual(response["provider"], "chatgpt")
        self.assertEqual(response["status"], "draft")
        self.assertEqual(len(providers[1].calls), 1)
        self.assertFalse(providers[2].calls)
        self.assertIn("demo://public", providers[1].calls[0])
        self.assertEqual(response["sources"][0]["source_id"], "s1")

    def test_search_engine_cannot_be_registered_as_generation_fallback(self):
        for name in ("perplexity", "Perplexity"):
            with self.subTest(name=name):
                search = FakeProvider(name)
                with self.assertRaisesRegex(ValueError, "buscador"):
                    Router([FakeProvider("claude"), search], lambda _: EVIDENCE)
                self.assertFalse(search.calls)

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

    def test_journal_reserves_before_provider_and_completes_after(self):
        events = []

        class Journal:
            def begin(self, request_id, origin, execute):
                events.append("begin")

            def complete(self, result, execute):
                events.append("complete")

            def fail(self, request_id):
                events.append("fail")

        provider = FakeProvider("claude")

        def retrieve(_):
            events.append("retrieve")
            return EVIDENCE

        result = Router([provider], retrieve, Journal()).route(RouterQuery("Diagnóstico"), execute=True)
        self.assertEqual(events, ["begin", "retrieve", "complete"])
        self.assertTrue(result["recorded"])

    def test_failed_reservation_prevents_provider_call(self):
        class Journal:
            def begin(self, request_id, origin, execute):
                raise ValueError("Ya registrado")

        provider = FakeProvider("claude")
        with self.assertRaises(ValueError):
            Router([provider], lambda _: EVIDENCE, Journal()).route(RouterQuery("Diagnóstico"), execute=True)
        self.assertFalse(provider.calls)

    def test_failed_persistence_does_not_repeat_generation(self):
        events = []

        class Journal:
            def begin(self, request_id, origin, execute): pass

            def complete(self, result, execute):
                raise RuntimeError("database down")

            def fail(self, request_id):
                events.append(request_id)

        provider = FakeProvider("claude")
        query = RouterQuery("Diagnóstico")
        with self.assertRaises(RuntimeError):
            Router([provider], lambda _: EVIDENCE, Journal()).route(query, execute=True, allow_fallback=True)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(events, [query.request_id])

    def test_specific_match_precedes_general_company_context(self):
        general = tuple(Evidence(f"general-{n}", f"domain-{n}", Source(f"source-{n}", "demo://general", "General"), "Contexto general") for n in range(5))
        router = Router([FakeProvider("claude")], lambda text, company_id=None: EVIDENCE,
                        domain_retrieve=lambda company, task: general)
        result = router.route(RouterQuery("preguntas frecuentes de diagnóstico", company_id="demo_company", task="faq"))
        self.assertEqual(result["sources"][0]["chunk_id"], "c1")
        self.assertEqual(len(result["sources"]), 5)
        self.assertEqual(result["pipeline"]["task"], "faq")
