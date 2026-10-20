"""Prueba manual real: ejecutar desde Ubuntu con OPENAI_API_KEY en la sesion."""
import json
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4
import os

ROOT = Path(__file__).resolve().parents[1]
MODEL = "gpt-6.1-sol"


def command(*args):
    result = subprocess.run(
        [sys.executable, "-m", "geo_engine.cli", *args],
        cwd=ROOT, env={**os.environ, "OPENAI_MODEL": MODEL},
        capture_output=True, text=True,
    )
    # No mostrar stderr ni respuestas HTTP completas en el informe.
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError("cli_failed_exit_" + str(result.returncode)) from None
    return result.returncode, data


def main():
    started = time.monotonic()
    report = {"model": MODEL, "company_id": "dg_medios", "status": "failed", "checks": {}}
    try:
        code, access = command("check-provider", "--provider", "chatgpt", "--check-access")
        report["checks"]["model_access"] = code == 0 and access.get("status") == "model_accessible"
        if not report["checks"]["model_access"]:
            report["code"] = access.get("code", access.get("status"))
            report["missing"] = access.get("missing", [])
            return report
        # Primero planificar: no consumir API si falta contexto de esta empresa.
        code, plan = command("geo", "Describe brevemente la empresa DG Medios en espanol.",
                             "--company", "dg_medios", "--task", "company_profile", "--provider", "chatgpt")
        report["checks"]["public_context"] = code == 0 and plan.get("status") == "ready" and bool(plan.get("sources"))
        if not report["checks"]["public_context"]:
            report["code"] = plan.get("status")
            return report
        run_id = str(uuid4())
        report["request_id"] = run_id
        code, generated = command("geo", "Describe brevemente la empresa DG Medios en espanol.",
            "--company", "dg_medios", "--task", "company_profile", "--provider", "chatgpt",
            "--execute", "--request-id", run_id)
        report["checks"]["generation"] = (code == 0 and generated.get("status") == "draft"
            and generated.get("model") == MODEL and bool(generated.get("text")))
        report["checks"]["recorded"] = generated.get("recorded") is True
        if not report["checks"]["generation"]:
            report["code"] = generated.get("status")
            report["attempts"] = generated.get("attempts", [])
            return report
        code, saved = command("show-run", run_id)
        report["checks"]["database_roundtrip"] = (code == 0 and saved.get("status") == "draft"
            and saved.get("company_id") == "dg_medios" and saved.get("model") == MODEL
            and saved.get("text") == generated["text"] and saved.get("sources") == generated["sources"]
            and saved.get("pipeline", {}).get("phase") == "provider_completed")
        report["source_count"] = len(saved.get("sources", []))
        report["output_characters"] = len(generated["text"])
        report["status"] = "passed" if all(report["checks"].values()) else "failed"
    except RuntimeError as error:
        report["code"] = str(error)
    finally:
        report["duration_seconds"] = round(time.monotonic() - started, 2)
    return report


if __name__ == "__main__":
    result = main()
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["status"] == "passed" else 2)
