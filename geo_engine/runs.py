"""Diario local del router: metadatos seguros y resultados con evidencia pública.

La reserva se confirma antes de invocar proveedores. Completar una ejecución y
guardar su borrador y referencias es una sola transacción; nunca se conserva la
consulta, el prompt ni el cuerpo de los errores en el diario.
"""

import re
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


_FINAL_STATUSES = {"ready", "draft", "insufficient_evidence", "no_provider", "provider_error"}
_SOURCE_FIELDS = ("chunk_id", "document_id", "source_id", "reference")
_ATTEMPT_FIELDS = ("provider", "model", "status", "code")


def _request_id(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("request_id debe ser un UUID válido")
    try:
        return str(UUID(value))
    except (ValueError, AttributeError):
        raise ValueError("request_id debe ser un UUID válido") from None


def _origin(value: str) -> str:
    if (not isinstance(value, str) or not 1 <= len(value) <= 100
            or not all(c.isalnum() or c in "_-" for c in value)):
        raise ValueError("origin debe ser un identificador de hasta 100 caracteres")
    return value


def _mode(execute: bool) -> str:
    if type(execute) is not bool:
        raise ValueError("execute debe ser booleano")
    return "execute" if execute else "plan"


def _identifier(value: object, field: str) -> str:
    if (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}", value)):
        raise ValueError(f"{field} debe ser un identificador válido")
    return value


def _attempts(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError("Lista de intentos inválida")
    attempts = []
    for item in value:
        if (not isinstance(item, dict) or not isinstance(item.get("status"), str)
                or item["status"] not in {"skipped", "error", "completed"}):
            raise ValueError("Intento inválido")
        safe = {key: item[key] for key in _ATTEMPT_FIELDS if key in item}
        _identifier(safe.get("provider"), "provider")
        if "model" in safe:
            _identifier(safe["model"], "model")
        if "code" in safe and (not isinstance(safe["code"], str)
                               or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", safe["code"])):
            raise ValueError("Código de intento inválido")
        attempts.append(safe)
    return attempts


def _sources(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError("Lista de evidencia inválida")
    sources = []
    seen = set()
    for item in value:
        if (not isinstance(item, dict)
                or any(not isinstance(item.get(key), str) or not item[key]
                       or "\x00" in item[key] or len(item[key]) > 20000 for key in _SOURCE_FIELDS)
                or item["chunk_id"] in seen):
            raise ValueError("Referencia de evidencia inválida")
        seen.add(item["chunk_id"])
        sources.append({key: item[key] for key in _SOURCE_FIELDS})
    return sources


class PostgresRunStore:
    def __init__(self, database_url: str):
        self.database_url = database_url

    def begin(self, request_id: str, origin: str, execute: bool) -> None:
        run_id, origin, mode = _request_id(request_id), _origin(origin), _mode(execute)
        try:
            with psycopg.connect(self.database_url, connect_timeout=5) as db:
                db.execute("""
                    INSERT INTO router_runs (request_id, origin, mode, status)
                    VALUES (%s, %s, %s, 'started')
                """, (run_id, origin, mode))
        except psycopg.errors.UniqueViolation:
            raise ValueError("request_id ya reservado; no se repite la ejecución") from None

    def complete(self, result: dict, execute: bool) -> None:
        if not isinstance(result, dict):
            raise ValueError("Resultado del router inválido")
        run_id = _request_id(result.get("request_id"))
        origin, mode = _origin(result.get("origin")), _mode(execute)
        status = result.get("status")
        if (not isinstance(status, str) or status not in _FINAL_STATUSES
                or (status == "draft" and not execute) or (status == "ready" and execute)):
            raise ValueError("Estado incompatible con el modo de ejecución")
        provider, model = result.get("provider"), result.get("model")
        if provider is not None:
            _identifier(provider, "provider")
        if model is not None:
            _identifier(model, "model")
        if (provider is None) != (model is None) or (status in {"draft", "ready"} and provider is None):
            raise ValueError("Proveedor y modelo inválidos para el resultado")
        attempts = _attempts(result.get("attempts", []))
        sources = _sources(result.get("sources", []))
        content = None
        if execute and status == "draft":
            content = result.get("text")
            if (not isinstance(content, str) or not content.strip() or "\x00" in content
                    or len(content) > 2_000_000 or not sources):
                raise ValueError("Un borrador requiere texto y evidencia pública")
        elif execute and status == "insufficient_evidence":
            content = "información insuficiente"

        with psycopg.connect(self.database_url, connect_timeout=5) as db:
            reserved = db.execute("""
                SELECT origin, mode, status FROM router_runs WHERE request_id=%s FOR UPDATE
            """, (run_id,)).fetchone()
            if reserved != (origin, mode, "started"):
                raise ValueError("La ejecución no está reservada, terminó o no coincide con su modo y origen")
            # El permiso se vuelve a verificar después de generar. Los bloqueos
            # mantienen referencias y visibilidad estables durante esta escritura.
            for source in sources:
                match = db.execute("""
                    SELECT c.id FROM chunks c
                    JOIN documents d ON d.id=c.document_id
                    JOIN sources s ON s.id=d.source_id
                    WHERE c.id=%s AND d.id=%s AND s.id=%s AND s.reference=%s
                      AND c.visibility='public' AND d.visibility='public'
                    FOR SHARE OF c, d, s
                """, tuple(source[key] for key in _SOURCE_FIELDS)).fetchone()
                if match is None:
                    raise ValueError("La evidencia no existe, cambió o no es pública")
            result_id = None
            if content is not None:
                result_id = run_id
                db.execute("""
                    INSERT INTO results (id, branch, status, content)
                    VALUES (%s, 'geo', %s, %s)
                """, (result_id, status, content))
                for source in sources:
                    db.execute("INSERT INTO result_evidence (result_id, chunk_id) VALUES (%s, %s)",
                               (result_id, source["chunk_id"]))
            db.execute("""
                UPDATE router_runs
                SET status=%s, provider=%s, model=%s, attempts=%s, evidence=%s,
                    result_id=%s, finished_at=CURRENT_TIMESTAMP
                WHERE request_id=%s
            """, (status, provider, model, Jsonb(attempts), Jsonb(sources), result_id, run_id))

    def fail(self, request_id: str) -> None:
        run_id = _request_id(request_id)
        with psycopg.connect(self.database_url, connect_timeout=5) as db:
            db.execute("""
                UPDATE router_runs SET status='failed', finished_at=CURRENT_TIMESTAMP
                WHERE request_id=%s AND status='started'
            """, (run_id,))

    def get(self, request_id: str) -> dict | None:
        """Consulta de administración local; no publicar por la API HTTP."""
        run_id = _request_id(request_id)
        with psycopg.connect(self.database_url, connect_timeout=5, row_factory=dict_row) as db:
            row = db.execute("""
                SELECT r.request_id, r.origin, r.mode, r.status, r.provider, r.model,
                       r.attempts, r.evidence AS sources, r.result_id,
                       r.started_at, r.finished_at, result.content AS text
                FROM router_runs r LEFT JOIN results result ON result.id=r.result_id
                WHERE r.request_id=%s
            """, (run_id,)).fetchone()
        if row is None:
            return None
        row["request_id"] = str(row["request_id"])
        for key in ("started_at", "finished_at"):
            row[key] = row[key].isoformat() if row[key] is not None else None
        return row
