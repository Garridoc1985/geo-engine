import io
from http.client import IncompleteRead
import json
import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

from geo_engine.providers import HTTPProvider, ProviderError, _NoRedirect, build_providers_from_env


def responses_payload(text="Respuesta autorizada"):
    return {
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "status": "completed", "content": [
                {"type": "output_text", "text": text}
            ]},
        ],
    }


class ProviderTests(unittest.TestCase):
    def call_with_response(self, provider, payload):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        with patch("geo_engine.providers.urlopen", return_value=io.BytesIO(data)) as transport:
            text = provider.generate("Consulta pública con evidencia")
        return text, transport.call_args

    def test_claude_request_headers_payload_and_content(self):
        provider = HTTPProvider("claude", "configured-claude", "dummy-test-key")
        text, call = self.call_with_response(provider, {
            "stop_reason": "end_turn",
            "content": [{"type": "thinking", "thinking": "oculto"},
                        {"type": "text", "text": "Uno"}, {"type": "text", "text": "Dos"}],
        })
        request = call.args[0]
        self.assertEqual(text, "Uno\nDos")
        self.assertEqual(request.full_url, "https://api.anthropic.com/v1/messages")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("X-api-key"), "dummy-test-key")
        self.assertEqual(request.get_header("Anthropic-version"), "2023-06-01")
        self.assertEqual(json.loads(request.data), {
            "model": "configured-claude", "max_tokens": 2048,
            "messages": [{"role": "user", "content": "Consulta pública con evidencia"}],
        })
        self.assertEqual(call.kwargs, {"timeout": 30.0})

    def test_openai_and_perplexity_use_current_endpoints_and_typed_outputs(self):
        for name, endpoint in [("chatgpt", "https://api.openai.com/v1/responses"),
                               ("perplexity", "https://api.perplexity.ai/v1/agent")]:
            with self.subTest(provider=name):
                provider = HTTPProvider(name, "configured-model", "dummy-test-key")
                text, call = self.call_with_response(provider, responses_payload())
                request = call.args[0]
                self.assertEqual(text, "Respuesta autorizada")
                self.assertEqual(request.full_url, endpoint)
                self.assertEqual(request.get_header("Authorization"), "Bearer dummy-test-key")
                self.assertEqual(json.loads(request.data), {
                    "model": "configured-model", "input": "Consulta pública con evidencia",
                    "max_output_tokens": 2048, "store": False,
                })

    def test_configuration_requires_both_key_and_model(self):
        with patch.dict(os.environ, {}, clear=True):
            providers = build_providers_from_env()
        self.assertEqual([provider.name for provider in providers], ["claude", "chatgpt", "perplexity"])
        self.assertTrue(all(not provider.available for provider in providers))
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True):
            self.assertFalse(build_providers_from_env()[0].available)
        with patch.dict(os.environ, {"CLAUDE_MODEL": " chosen-model ", "ANTHROPIC_API_KEY": " test-key "}, clear=True):
            provider = build_providers_from_env()[0]
        self.assertTrue(provider.available)
        self.assertEqual(provider.model, "chosen-model")
        self.assertNotIn("test-key", repr(provider))
        with patch("geo_engine.providers.urlopen") as transport:
            with self.assertRaises(ProviderError) as caught:
                HTTPProvider("chatgpt", "", "").generate("consulta")
            self.assertEqual(caught.exception.code, "not_configured")
            transport.assert_not_called()

    def test_http_errors_are_safe_and_only_transient_errors_retryable(self):
        for status, retryable in [(400, False), (401, False), (403, False), (404, False),
                                   (408, True), (429, True), (500, True), (503, True)]:
            with self.subTest(status=status):
                error = HTTPError("https://api.openai.com/v1/responses", status,
                                  "sensitive test-key prompt", {}, io.BytesIO(b"secret body"))
                with patch("geo_engine.providers.urlopen", side_effect=error) as transport:
                    with self.assertRaises(ProviderError) as caught:
                        HTTPProvider("chatgpt", "test-model", "test-key").generate("secret prompt")
                self.assertEqual(caught.exception.code, f"http_{status}")
                self.assertEqual(caught.exception.retryable, retryable)
                self.assertNotIn("secret", str(caught.exception))
                self.assertNotIn("test-key", repr(caught.exception))
                self.assertIsNone(caught.exception.__cause__)
                self.assertEqual(transport.call_count, 1)
                self.assertTrue(error.fp.closed)

    def test_timeout_and_transport_errors_are_safe(self):
        for error in [TimeoutError("secret timeout"), URLError("secret transport"),
                      OSError("secret io"), IncompleteRead(b"secret partial")]:
            with self.subTest(error=type(error).__name__):
                with patch("geo_engine.providers.urlopen", side_effect=error):
                    with self.assertRaises(ProviderError) as caught:
                        HTTPProvider("claude", "test-model", "test-key").generate("secret prompt")
                self.assertEqual(caught.exception.code, "transport_error")
                self.assertTrue(caught.exception.retryable)
                self.assertNotIn("secret", str(caught.exception))

    def test_invalid_and_empty_responses(self):
        for payload, code in [(b"not json secret", "invalid_response"), ([], "invalid_response"),
                              ({"status": "completed", "output": {}}, "invalid_response"),
                              (responses_payload(""), "empty_response")]:
            with self.subTest(code=code, payload=type(payload).__name__):
                with self.assertRaises(ProviderError) as caught:
                    self.call_with_response(HTTPProvider("chatgpt", "test-model", "test-key"), payload)
                self.assertEqual(caught.exception.code, code)

    def test_refusal_or_incomplete_response_is_not_a_fallback_trigger(self):
        payload = responses_payload()
        payload["output"][1]["content"].append({"type": "refusal", "refusal": "sensitive refusal"})
        for provider, response, code in [
            ("chatgpt", payload, "refused"),
            ("perplexity", {"status": "incomplete", "output": []}, "incomplete_response"),
            ("claude", {"stop_reason": "refusal", "content": []}, "refused"),
            ("claude", {"stop_reason": "max_tokens", "content": []}, "incomplete_response"),
        ]:
            with self.subTest(provider=provider, code=code):
                with self.assertRaises(ProviderError) as caught:
                    self.call_with_response(HTTPProvider(provider, "test-model", "test-key"), response)
                self.assertEqual(caught.exception.code, code)
                self.assertFalse(caught.exception.retryable)

    def test_response_size_is_bounded(self):
        with self.assertRaises(ProviderError) as caught:
            self.call_with_response(HTTPProvider("claude", "test-model", "test-key"), b"x" * 2_000_001)
        self.assertEqual(caught.exception.code, "response_too_large")

    def test_redirects_are_blocked_before_a_second_request(self):
        handler = _NoRedirect()
        request = Request("https://api.openai.com/v1/responses", headers={"Authorization": "Bearer test-key"})
        for status in [301, 302, 303, 307, 308]:
            with self.subTest(status=status):
                with self.assertRaises(ProviderError) as caught:
                    handler.redirect_request(request, None, status, "Found", {}, "https://attacker.invalid/")
                self.assertEqual(caught.exception.code, "redirect_blocked")
                self.assertFalse(caught.exception.retryable)
        with patch("geo_engine.providers.build_opener") as builder:
            from geo_engine.providers import urlopen
            urlopen(request, timeout=7)
        self.assertIsInstance(builder.call_args.args[0], _NoRedirect)
        builder.return_value.open.assert_called_once_with(request, timeout=7)

    def test_no_arbitrary_endpoints_or_header_injection(self):
        for name, model, key in [("https://attacker.invalid", "test", "key"),
                                  ("claude", "test", "key\nAuthorization: stolen")]:
            with self.subTest(name=name):
                with self.assertRaises(ProviderError) as caught:
                    HTTPProvider(name, model, key)
                self.assertNotIn("stolen", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
