"""Ingesta local validada y transaccional de catálogos JSON/CSV."""
import csv
import json
import re
from dataclasses import dataclass
from pathlib import Path

import psycopg

FIELDS = {"id", "kind", "title", "description", "source_reference", "visibility", "allowed_principals"}
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


@dataclass(frozen=True)
class CatalogItem:
    id: str
    kind: str
    title: str
    description: str
    source_reference: str
    visibility: str
    allowed_principals: tuple[str, ...]


def validate_catalog(records: object) -> tuple[CatalogItem, ...]:
    if not isinstance(records, list) or not records:
        raise ValueError("El catálogo debe ser una lista no vacía")
    items = []
    seen = set()
    for index, record in enumerate(records, 1):
        prefix = f"Registro {index}"
        if not isinstance(record, dict) or set(record) != FIELDS:
            raise ValueError(f"{prefix}: campos faltantes o desconocidos")
        for field in FIELDS - {"allowed_principals"}:
            value = record[field]
            if not isinstance(value, str) or not value.strip() or "\x00" in value:
                raise ValueError(f"{prefix}: {field} debe ser texto no vacío sin NUL")
            if len(value) > 20000:
                raise ValueError(f"{prefix}: {field} supera 20000 caracteres")
        if not IDENTIFIER.fullmatch(record["id"]) or record["id"] in seen:
            raise ValueError(f"{prefix}: ID inválido o duplicado")
        if record["kind"] not in {"product", "service"}:
            raise ValueError(f"{prefix}: kind debe ser product o service")
        if record["visibility"] not in {"public", "internal"}:
            raise ValueError(f"{prefix}: visibility debe ser public o internal")
        principals = record["allowed_principals"]
        if not isinstance(principals, list) or any(
            not isinstance(p, str) or not p.strip() or p != p.strip() or "\x00" in p or len(p) > 200
            for p in principals
        ) or len(set(principals)) != len(principals):
            raise ValueError(f"{prefix}: allowed_principals debe ser una lista de identidades únicas")
        if record["visibility"] == "public" and principals:
            raise ValueError(f"{prefix}: una oferta pública no puede declarar una ACL restringida")
        seen.add(record["id"])
        items.append(CatalogItem(**{**record, "allowed_principals": tuple(sorted(principals))}))
    return tuple(items)


def load_catalog(path: Path) -> tuple[CatalogItem, ...]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        if path.suffix.lower() == ".json":
            records = json.load(stream)
        elif path.suffix.lower() == ".csv":
            reader = csv.DictReader(stream)
            if reader.fieldnames is None or len(reader.fieldnames) != len(FIELDS) or set(reader.fieldnames) != FIELDS:
                raise ValueError("CSV: encabezados faltantes, duplicados o desconocidos")
            records = []
            for row in reader:
                if None in row or row.get("allowed_principals") is None:
                    raise ValueError("CSV: fila con número incorrecto de columnas")
                row["allowed_principals"] = json.loads(row["allowed_principals"])
                records.append(row)
        else:
            raise ValueError("Formato no admitido: use .json o .csv")
    return validate_catalog(records)


def import_catalog(database_url: str, records: list[dict]) -> dict[str, int]:
    """Entrada de catálogo en memoria. Valida todo antes de abrir la transacción."""
    return save_catalog(database_url, validate_catalog(records))


def save_catalog(database_url: str, items: tuple[CatalogItem, ...]) -> dict[str, int]:
    """Persistir un lote ya validado; conflictos revierten todas las escrituras."""
    imported = 0
    with psycopg.connect(database_url, connect_timeout=5) as db:
        # Serializa las cargas de este importador y la verificación de recargas.
        db.execute("SELECT pg_advisory_xact_lock(739421001)")
        for item in items:
            source_id = f"catalog:{item.id}:source"
            document_id = f"catalog:{item.id}:document"
            chunk_id = f"catalog:{item.id}:chunk:1"
            source = (source_id, item.source_reference, item.title)
            document = (document_id, source_id, item.title, item.visibility, list(item.allowed_principals))
            content = f"{item.title}\nTipo: {item.kind}\n{item.description}"
            chunk = (chunk_id, document_id, content, item.visibility, list(item.allowed_principals))
            existing = db.execute("SELECT id FROM documents WHERE id = %s", (document_id,)).fetchone()
            db.execute("INSERT INTO sources (id, reference, title) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING", source)
            db.execute("INSERT INTO documents (id, source_id, title, visibility, allowed_principals) VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING", document)
            db.execute("INSERT INTO chunks (id, document_id, content, visibility, allowed_principals) VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING", chunk)
            actual_source = db.execute("SELECT id, reference, title FROM sources WHERE id = %s", (source_id,)).fetchone()
            actual_document = db.execute("SELECT id, source_id, title, visibility, allowed_principals FROM documents WHERE id = %s", (document_id,)).fetchone()
            actual_chunk = db.execute("SELECT id, document_id, content, visibility, allowed_principals FROM chunks WHERE id = %s", (chunk_id,)).fetchone()
            if (actual_source, actual_document, actual_chunk) != (source, document, chunk):
                raise ValueError(f"Conflicto de catálogo para {item.id}: los datos existentes son distintos")
            imported += existing is None
    return {"processed": len(items), "imported": imported, "unchanged": len(items) - imported}
