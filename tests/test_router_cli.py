import contextlib
import io
import unittest
from unittest.mock import patch
from geo_engine.cli import main
from geo_engine.config import Config


class RouterCLITests(unittest.TestCase):
    def call(self, status, execute):
        args = ["geo", "route", "diagnóstico comercial"] + (["--execute"] if execute else [])
        with patch("sys.argv", args), patch("geo_engine.cli.Config.from_env", return_value=Config("127.0.0.1", 8000, "postgresql:///unused")), \
             patch("geo_engine.cli.build_providers_from_env", return_value=[]), patch("geo_engine.cli.Router") as router, contextlib.redirect_stdout(io.StringIO()):
            router.return_value.route.return_value = {"status": status}
            code = main()
            self.assertEqual(router.return_value.route.call_args.kwargs["execute"], execute)
            return code

    def test_failed_execution_is_not_a_success_exit_code(self):
        for status in ("provider_error", "no_provider", "insufficient_evidence"):
            with self.subTest(status=status):
                self.assertEqual(self.call(status, True), 2)

    def test_draft_and_offline_plans_are_successful_commands(self):
        self.assertEqual(self.call("draft", True), 0)
        self.assertEqual(self.call("ready", False), 0)
        self.assertEqual(self.call("no_provider", False), 0)
