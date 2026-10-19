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
             patch("geo_engine.cli.build_providers_from_env", return_value=[]), patch("geo_engine.cli.initialize"), patch("geo_engine.cli.Router") as router, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
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

    def test_stable_request_id_and_empty_id_validation(self):
        run_id = "599d2979-5d27-4d2b-8403-c7443c105e92"
        for supplied_id in (run_id, ""):
            args = ["geo", "route", "diagnóstico", "--request-id", supplied_id]
            with self.subTest(supplied_id=supplied_id), patch("sys.argv", args), \
                 patch("geo_engine.cli.Config.from_env", return_value=Config("127.0.0.1", 8000, "postgresql:///unused")), \
                 patch("geo_engine.cli.initialize"), patch("geo_engine.cli.build_providers_from_env", return_value=[]), \
                 patch("geo_engine.cli.Router") as router, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                router.return_value.route.return_value = {"status": "ready"}
                code = main()
                if supplied_id:
                    self.assertEqual(code, 0)
                    self.assertEqual(router.return_value.route.call_args.args[0].request_id, run_id)
                else:
                    self.assertEqual(code, 1)
                    router.return_value.route.assert_not_called()

    def test_geo_command_passes_company_task_and_does_not_execute_by_default(self):
        with patch("sys.argv", ["geo", "geo", "prepara información", "--company", "demo_company", "--task", "catalog"]), \
             patch("geo_engine.cli.Config.from_env", return_value=Config("127.0.0.1", 8000, "postgresql:///unused")), \
             patch("geo_engine.cli.initialize"), patch("geo_engine.cli.build_providers_from_env", return_value=[]), \
             patch("geo_engine.cli.Router") as router, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            router.return_value.route.return_value = {"status": "no_provider"}
            self.assertEqual(main(), 0)
            request = router.return_value.route.call_args.args[0]
            self.assertEqual((request.company_id, request.task), ("demo_company", "catalog"))
            self.assertFalse(router.return_value.route.call_args.kwargs["execute"])
