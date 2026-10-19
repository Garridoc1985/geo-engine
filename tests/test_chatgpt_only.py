"""Pruebas aisladas de ChatGPT; nunca utilizan credenciales ni transporte real."""

import contextlib
import io
import json
import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from geo_engine.cli import main
from geo_engine.config import Config
from geo_engine.contracts import Evidence, Source
from geo_engine.providers import HTTPProvider, ProviderError, build_providers_from_env
from geo_engine.router import Router, RouterQuery


ENV = {
    "CLAUDE_MODEL": "dummy-claude-model",
    "ANTHROPIC_API_KEY": "dummy-claude-key",
    "OPENAI_MODEL": "dummy-openai-model",
    "OPENAI_API_KEY": "dummy-openai-key",
    "PERPLEXITY_MODEL": "dummy-perplexity-model",
    "PERPLEXITY_API_KEY": "dummy-perplexity-key",
}
PUBLIC_EVIDENCE = (
    Evidence("public-chunk", "public-document", Source("public-source", "demo://public", "Fuente ficticia"),
             "El diagnóstico comercial ficticio incluye una evaluación inicial."),
)


class ChatGPTOnlyTests(unittest.TestCase):
    def test_explicit_selection_excludes_higher_and_lower_priority_providers(self):
        with patch.dict(os.environ, ENV, clear=True), \
             patch("geo_engine.providers.HTTPProvider", wraps=HTTPProvider) as constructor, \
             patch("geo_engine.providers.urlopen") as transport:
            providers = build_providers_from_env(only="chatgpt")
            result = Router(providers, lambda _: PUBLIC_EVIDENCE).route(RouterQuery("diagnóstico comercial"))
        self.assertEqual([provider.name for provider in providers], ["chatgpt"])
        self.assertEqual(constructor.call_count, 1)
        self.assertEqual(constructor.call_args.args[0], "chatgpt")
        self.assertEqual(result["provider"], "chatgpt")
        self.assertEqual(result["status"], "ready")
        transport.assert_not_called()

    def test_invalid_configuration_of_unselected_providers_is_not_validated(self):
        env = dict(ENV, CLAUDE_MODEL="invalid\nmodel", ANTHROPIC_API_KEY="invalid\nkey",
                   PERPLEXITY_MODEL="invalid\nmodel", PERPLEXITY_API_KEY="invalid\nkey")
        with patch.dict(os.environ, env, clear=True):
            providers = build_providers_from_env(only="chatgpt")
        self.assertEqual([provider.name for provider in providers], ["chatgpt"])
        self.assertTrue(providers[0].available)

    def test_missing_openai_key_or_model_never_contacts_transport(self):
        for missing in ("OPENAI_API_KEY", "OPENAI_MODEL"):
            env = {name: value for name, value in ENV.items() if name != missing}
            with self.subTest(missing=missing), patch.dict(os.environ, env, clear=True), \
                 patch("geo_engine.providers.urlopen") as transport:
                providers = build_providers_from_env(only="chatgpt")
                self.assertEqual(len(providers), 1)
                self.assertFalse(providers[0].available)
                with self.assertRaises(ProviderError) as error:
                    providers[0].generate("Consulta ficticia")
                self.assertEqual(error.exception.code, "not_configured")
                result = Router(providers, lambda _: PUBLIC_EVIDENCE).route(
                    RouterQuery("diagnóstico comercial"), execute=True, allow_fallback=True)
                self.assertEqual(result["status"], "no_provider")
                self.assertIsNone(result["provider"])
                self.assertEqual(result["attempts"], [
                    {"provider": "chatgpt", "status": "skipped", "code": "not_configured"},
                ])
                transport.assert_not_called()

    def test_execution_uses_openai_responses_with_public_context_only(self):
        payload = {"status": "completed", "output": [
            {"type": "message", "status": "completed", "content": [
                {"type": "output_text", "text": "Respuesta ficticia de ChatGPT"},
            ]},
        ]}
        with patch.dict(os.environ, ENV, clear=True), \
             patch("geo_engine.providers.urlopen", return_value=io.BytesIO(json.dumps(payload).encode())) as transport:
            result = Router(build_providers_from_env(only="chatgpt"), lambda _: PUBLIC_EVIDENCE).route(
                RouterQuery("diagnóstico comercial", origin="claude"), execute=True, allow_fallback=True)
        transport.assert_called_once()
        request = transport.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer dummy-openai-key")
        body = json.loads(request.data)
        self.assertEqual(body["model"], "dummy-openai-model")
        self.assertFalse(body["store"])
        self.assertIn(PUBLIC_EVIDENCE[0].content, body["input"])
        self.assertIn(PUBLIC_EVIDENCE[0].source.reference, body["input"])
        self.assertEqual(result["provider"], "chatgpt")
        self.assertEqual(result["origin"], "claude")
        self.assertEqual(result["status"], "draft")
        self.assertEqual(result["text"], "Respuesta ficticia de ChatGPT")
        self.assertEqual([attempt["provider"] for attempt in result["attempts"]], ["chatgpt"])
        self.assertEqual(result["sources"][0]["source_id"], "public-source")

    def test_retryable_failure_cannot_fallback_to_unselected_providers(self):
        error = HTTPError("https://api.openai.com/v1/responses", 429, "dummy-limit", {}, io.BytesIO(b""))
        with patch.dict(os.environ, ENV, clear=True), \
             patch("geo_engine.providers.urlopen", side_effect=error) as transport:
            result = Router(build_providers_from_env(only="chatgpt"), lambda _: PUBLIC_EVIDENCE).route(
                RouterQuery("diagnóstico comercial"), execute=True, allow_fallback=True)
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0].full_url, "https://api.openai.com/v1/responses")
        self.assertEqual(result["status"], "provider_error")
        self.assertEqual(result["provider"], "chatgpt")
        self.assertEqual(result["attempts"], [
            {"provider": "chatgpt", "model": "dummy-openai-model", "status": "error", "code": "http_429"},
        ])

    def test_unknown_selection_is_rejected_without_initializing_providers(self):
        with patch.dict(os.environ, ENV, clear=True), \
             patch("geo_engine.providers.HTTPProvider") as constructor, \
             patch("geo_engine.providers.urlopen") as transport:
            with self.assertRaises(ValueError):
                build_providers_from_env(only="unsupported")
        constructor.assert_not_called()
        transport.assert_not_called()

    def test_default_selection_preserves_priority_candidates(self):
        with patch.dict(os.environ, ENV, clear=True):
            providers = build_providers_from_env(only=None)
        self.assertEqual([provider.name for provider in providers], ["claude", "chatgpt", "perplexity"])
        self.assertTrue(all(provider.available for provider in providers))


class ChatGPTOnlyCLITests(unittest.TestCase):
    def test_route_and_geo_pass_explicit_provider_selection_to_factory(self):
        for command in ("route", "geo"):
            for execute in (False, True):
                args = ["geo-engine", command, "diagnóstico comercial", "--provider", "chatgpt"]
                if command == "geo":
                    args += ["--company", "demo_company"]
                if execute:
                    args += ["--execute"]
                with self.subTest(command=command, execute=execute), patch("sys.argv", args), \
                     patch("geo_engine.cli.Config.from_env", return_value=Config("127.0.0.1", 8000, "postgresql:///unused")), \
                     patch("geo_engine.cli.initialize"), patch("geo_engine.cli.PostgresRunStore"), \
                     patch("geo_engine.cli.build_providers_from_env", return_value=[]) as factory, \
                     patch("geo_engine.cli.Router") as router, contextlib.redirect_stdout(io.StringIO()), \
                     contextlib.redirect_stderr(io.StringIO()):
                    router.return_value.route.return_value = {"status": "draft" if execute else "ready"}
                    self.assertEqual(main(), 0)
                    factory.assert_called_once_with(only="chatgpt")
                    self.assertEqual(router.return_value.route.call_args.kwargs["execute"], execute)

    def test_default_cli_selection_keeps_automatic_priority(self):
        with patch("sys.argv", ["geo-engine", "route", "diagnóstico comercial"]), \
             patch("geo_engine.cli.Config.from_env", return_value=Config("127.0.0.1", 8000, "postgresql:///unused")), \
             patch("geo_engine.cli.initialize"), patch("geo_engine.cli.PostgresRunStore"), \
             patch("geo_engine.cli.build_providers_from_env", return_value=[]) as factory, \
             patch("geo_engine.cli.Router") as router, contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            router.return_value.route.return_value = {"status": "no_provider"}
            self.assertEqual(main(), 0)
        factory.assert_called_once_with(only=None)


if __name__ == "__main__":
    unittest.main()
