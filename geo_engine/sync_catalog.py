"""Sincronización local de snapshots web completos, aislados por empresa y ámbito."""
import hashlib
import json
from pathlib import Path
import re

from .company_knowledge import CompanyKnowledge
from .company_store import import_company
from .web_reader import snapshot_version, validate_url


def load_web_snapshot(workspace, company_id):
    loader = CompanyKnowledge(Path(workspace), company_id)
    root = Path(workspace).resolve()
    receipt = root / "snapshot.json"
    if receipt.is_symlink() or not receipt.is_file():
        raise ValueError("Falta el comprobante de captura completa; regenerar el snapshot")
    data = json.loads(receipt.read_text(encoding="utf-8"))
    records = loader.load()
    if (not records or not isinstance(data, dict)
            or set(data) != {"company_id", "content_version", "item_count"}
            or data["company_id"] != company_id or data["item_count"] != len(records)
            or data["content_version"] != snapshot_version(company_id, records)):
        raise ValueError("Snapshot incompleto, modificado o de otra empresa")
    for record in records:
        validate_url(record.reference)
        expected_id = "evidence:WEB-" + hashlib.sha256(record.reference.encode()).hexdigest()
        if record.id != expected_id or record.visibility != "public" or record.allowed_principals:
            raise ValueError("El snapshot no corresponde a una captura web pública autorizada")
    return records, data["content_version"]


def sync_catalog(database_url, company_id, scope, *, workspace=None, clear=False, apply=False, expected_version=None):
    if not isinstance(scope, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", scope):
        raise ValueError("Ámbito de sincronización inválido")
    if clear == (workspace is not None):
        raise ValueError("Elegir un snapshot o el retiro explícito del ámbito")
    if clear:
        records = ()
        version = snapshot_version(company_id, records)
    else:
        records, version = load_web_snapshot(workspace, company_id)
    if expected_version is not None and expected_version != version:
        raise ValueError("La versión aprobada no coincide con el snapshot")
    report = import_company(database_url, company_id, records, allow_revisions=True,
                            sync_scope=scope, dry_run=not apply)
    report["content_version"] = version
    return report
