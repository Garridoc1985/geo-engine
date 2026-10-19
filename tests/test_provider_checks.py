"""Diagnóstico de configuración y acceso de ChatGPT con transporte simulado."""

import contextlib
import io
import json
import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from geo_engine.cli import main
from geo_engine.providers import HTTPProvider, ProviderError


TEST_ENV = {"OPENAI_MODEL": "dummy-model", "OPENAI_API_KEY": "dummy-private-key"}


class ProviderAccessCheckTests(unittest.TestCase):
    def test_model_check_uses_encoded_model_get_without_generation(self):
        model = "organization/model with space?version=1#fragment"
        payload = json.dumps({"id": model, "object": "model"}).encode()
        provider = HTTPProvider("chatgpt", model, "dummy-private-key")
        with patch("geo_engine.providers.urlopen", return_value=io.BytesIO(payload)) as transport, \
             patch.object(HTTPProvider, "generate") as generate:
            self.assertIsNone(provider.check_model_access())
        transport.assert_called_once()
        request = transport.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url, "https://api.openai.com/v1/models/organization%2Fmodel%20with%20space%3Fversion%3D1%23fragment")
        self.assertEqual(request.get_header("Authorization"), "Bearer dummy-private-key")
        self.assertIsNone(request.data)
        self.assertEqual(transport.call_args.kwargs, {"timeout": 30.0})
        generate.assert_not_called()

    def test_missing_configuration_never_calls_transport(self):
        for model, key in [("", "dummy-private-key"), ("dummy-model", ""), ("", "")]:
            with self.subTest(model_present=bool(model), key_present=bool(key)), \
                 patch("geo_engine.providers.urlopen") as transport:
                with self.assertRaises(ProviderError) as caught:
                    HTTPProvider("chatgpt", model, key).check_model_access()
                self.assertEqual(caught.exception.code, "not_configured")
                self.assertFalse(caught.exception.retryable)
                transport.assert_not_called()

    def test_other_providers_cannot_use_openai_access_check(self):
        for name in ("claude", "perplexity"):
            with self.subTest(provider=name), patch("geo_engine.providers.urlopen") as transport:
                with self.assertRaises(ProviderError) as caught:
                    HTTPProvider(name, "dummy-model", "dummy-private-key").check_model_access()
                self.assertEqual(caught.exception.code, "unsupported_access_check")
                transport.assert_not_called()

    def test_invalid_or_mismatched_model_response_is_rejected(self):
        for payload in [b"not json", b"[]", b"null", b'{}', b'{"id":42}', b'{"id":"different-model"}']:
            with self.subTest(payload=payload), \
                 patch("geo_engine.providers.urlopen", return_value=io.BytesIO(payload)):
                with self.assertRaises(ProviderError) as caught:
                    HTTPProvider("chatgpt", "dummy-model", "dummy-private-key").check_model_access()
                self.assertEqual(caught.exception.code, "invalid_response")
                self.assertTrue(caught.exception.retryable)

    def test_http_authentication_and_missing_model_errors_are_safe(self):
        for status in (401, 404):
            error = HTTPError("https://api.openai.com/v1/models/dummy-model", status,
                              "dummy-private-key sensitive-message", {}, io.BytesIO(b"sensitive body"))
            with self.subTest(status=status), patch("geo_engine.providers.urlopen", side_effect=error) as transport:
                with self.assertRaises(ProviderError) as caught:
                    HTTPProvider("chatgpt", "dummy-model", "dummy-private-key").check_model_access()
                self.assertEqual(caught.exception.code, f"http_{status}")
                self.assertFalse(caught.exception.retryable)
                self.assertNotIn("sensitive", str(caught.exception))
                self.assertNotIn("dummy-private-key", repr(caught.exception))
                self.assertTrue(error.fp.closed)
                transport.assert_called_once()


class ProviderCheckCLITests(unittest.TestCase):
    def invoke(self, env, *, check_access=False, access_error=None):
        args = ["geo-engine", "check-provider", "--provider", "chatgpt"]
        if check_access:
            args.append("--check-access")
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch("sys.argv", args), \
             patch("geo_engine.cli.Config.from_env") as config, \
             patch("geo_engine.cli.initialize") as initialize, \
             patch("geo_engine.cli.PostgresRunStore") as journal, \
             patch("geo_engine.cli.Router") as router, \
             patch("geo_engine.providers.urlopen") as transport, \
             patch.object(HTTPProvider, "check_model_access", side_effect=access_error) as access, \
             patch.object(HTTPProvider, "generate") as generate, \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main()
        config.assert_not_called()
        initialize.assert_not_called()
        journal.assert_not_called()
        router.assert_not_called()
        generate.assert_not_called()
        transport.assert_not_called()
        self.assertNotIn("dummy-private-key", stdout.getvalue() + stderr.getvalue())
        return code, json.loads(stdout.getvalue()), access

    def test_local_configured_check_requires_neither_database_nor_network(self):
        code, result, access = self.invoke(TEST_ENV)
        self.assertEqual(code, 0)
        self.assertEqual(result["provider"], "chatgpt")
        self.assertEqual(result["model"], "dummy-model")
        self.assertTrue(result["configured"])
        self.assertEqual(result["missing"], [])
        self.assertEqual(result["status"], "configured")
        access.assert_not_called()

    def test_missing_key_is_reported_without_database_or_access_request(self):
        for check_access in (False, True):
            with self.subTest(check_access=check_access):
                code, result, access = self.invoke({"OPENAI_MODEL": "dummy-model"}, check_access=check_access)
                self.assertEqual(code, 2)
                self.assertEqual(result["provider"], "chatgpt")
                self.assertEqual(result["model"], "dummy-model")
                self.assertFalse(result["configured"])
                self.assertEqual(result["missing"], ["OPENAI_API_KEY"])
                self.assertEqual(result["status"], "not_configured")
                access.assert_not_called()

    def test_missing_model_and_empty_configuration_name_missing_variables(self):
        for env, missing in [({"OPENAI_API_KEY": "dummy-private-key"}, {"OPENAI_MODEL"}),
                             ({}, {"OPENAI_MODEL", "OPENAI_API_KEY"})]:
            with self.subTest(missing=missing):
                code, result, access = self.invoke(env)
                self.assertEqual(code, 2)
                self.assertFalse(result["configured"])
                self.assertEqual(set(result["missing"]), missing)
                self.assertEqual(result["status"], "not_configured")
                access.assert_not_called()

    def test_explicit_access_check_succeeds_without_database_or_generation(self):
        code, result, access = self.invoke(TEST_ENV, check_access=True)
        self.assertEqual(code, 0)
        self.assertEqual(result["provider"], "chatgpt")
        self.assertEqual(result["model"], "dummy-model")
        self.assertTrue(result["configured"])
        self.assertEqual(result["missing"], [])
        self.assertEqual(result["status"], "model_accessible")
        access.assert_called_once_with()

    def test_access_error_uses_safe_code_and_failure_exit_without_database(self):
        for error_code in ("http_401", "http_404", "transport_error"):
            with self.subTest(error_code=error_code):
                code, result, access = self.invoke(TEST_ENV, check_access=True,
                                                   access_error=ProviderError(error_code))
                self.assertEqual(code, 2)
                self.assertTrue(result["configured"])
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["code"], error_code)
                access.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
