"""Carga conocimiento empresarial SCW sin convertir datos internos en públicos.

Adapta el contrato de ``reference/scw/organizational_intelligence.py`` al runtime
de GEO Engine. No importa módulos ni clientes del workspace de origen.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


DOMINIOS = (
    "company_profile", "business_model", "organization", "stakeholders",
    "products_services", "glossary", "commercial_process", "operational_process",
    "technology_stack", "data_sources", "financial_context", "commercial_context",
    "operational_context", "strategic_objectives", "pain_points", "risks",
    "opportunities", "current_projects", "documents", "meetings", "emails",
    "dashboards", "kpis", "decisions", "historical_context", "knowledge_evolution",
)

_COMPANY_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
_EVIDENCE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_EVIDENCE_LINK = re.compile(r"\[([^\]\r\n]+)\]\((evidence/[^)\r\n]+\.md)\)\Z")
_RETIRED = ("superseded", "archived", "rejected", "invalid", "deprecated")


@dataclass(frozen=True)
class KnowledgeRecord:
    id: str
    title: str
    content: str
    reference: str
    visibility: str
    allowed_principals: tuple[str, ...]

    def __post_init__(self):
        if not isinstance(self.id, str) or not re.fullmatch(
            r"(?:domain|evidence):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", self.id
        ):
            raise ValueError("ID de conocimiento inválido")
        for name in ("title", "content", "reference"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or "\x00" in value:
                raise ValueError("El conocimiento contiene texto inválido")
            if len(value) > 20000:
                raise ValueError("Un campo de conocimiento supera el límite de texto")
        if self.visibility not in ("public", "internal"):
            raise ValueError("Visibilidad de conocimiento inválida")
        if not isinstance(self.allowed_principals, tuple) or any(
            not isinstance(principal, str) or not principal.strip()
            or principal != principal.strip() or "\x00" in principal
            or len(principal) > 200 for principal in self.allowed_principals
        ) or len(set(self.allowed_principals)) != len(self.allowed_principals):
            raise ValueError("ACL de conocimiento inválida")
        if self.visibility == "public" and self.allowed_principals:
            raise ValueError("El conocimiento público no puede declarar una ACL restringida")


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("access.json contiene claves duplicadas")
        result[key] = value
    return result


class CompanyKnowledge:
    """Conocimiento de ``workspace/clients/<company_id>`` con ACL explícita.

    ``access.json`` asigna permisos por ruta Markdown relativa a la empresa.
    La ausencia del manifiesto o de una entrada conserva el contenido interno
    con ACL vacía. Ninguna ruta puede resolver fuera de la empresa seleccionada.
    """

    def __init__(self, workspace: Path, company_id: str):
        if not isinstance(company_id, str) or not _COMPANY_ID.fullmatch(company_id):
            raise ValueError("company_id inválido")
        self.workspace = Path(workspace).resolve()
        self.company_id = company_id
        self.root = self.workspace / "clients" / company_id

    def _path(self, relative: str) -> Path:
        if not isinstance(relative, str) or not relative or any(
            char in relative for char in ("\\", ":", "\x00", "\r", "\n")
        ):
            raise ValueError("Ruta de conocimiento inválida")
        path = PurePosixPath(relative)
        if not path.parts or path.is_absolute() or path.as_posix() != relative or any(
            part in {".", ".."} for part in path.parts
        ):
            raise ValueError("Ruta de conocimiento inválida")
        try:
            resolved = (self.root / relative).resolve()
        except (OSError, RuntimeError):
            raise ValueError("No se puede resolver una ruta de conocimiento") from None
        if not resolved.is_relative_to(self.root):
            raise ValueError("Una ruta de conocimiento sale de la empresa")
        return resolved

    @staticmethod
    def _text(path: Path) -> str:
        try:
            if path.stat().st_size > 200000:
                raise ValueError("Un archivo de conocimiento supera el límite de tamaño")
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError):
            raise ValueError("No se puede leer un archivo de conocimiento") from None
        if "\x00" in text:
            raise ValueError("Un archivo de conocimiento contiene texto inválido")
        return text

    def _manifest(self) -> dict[str, dict]:
        path = self._path("access.json")
        if not path.exists():
            return {}
        try:
            manifest = json.loads(self._text(path), object_pairs_hook=_unique_object)
        except (ValueError, TypeError):
            raise ValueError("access.json inválido") from None
        if not isinstance(manifest, dict):
            raise ValueError("access.json debe ser un mapa de rutas y permisos")
        for relative, entry in manifest.items():
            self._path(relative)
            if not isinstance(entry, dict) or not {
                "visibility", "allowed_principals"
            } <= set(entry) or set(entry) - {
                "visibility", "allowed_principals", "source_reference"
            }:
                raise ValueError("access.json contiene campos faltantes o desconocidos")
            if entry["visibility"] not in ("public", "internal"):
                raise ValueError("access.json contiene una visibilidad inválida")
            principals = entry["allowed_principals"]
            if not isinstance(principals, list) or any(
                not isinstance(principal, str) or not principal.strip()
                or principal != principal.strip() or "\x00" in principal
                or len(principal) > 200 for principal in principals
            ) or len(set(principals)) != len(principals):
                raise ValueError("access.json contiene una ACL inválida")
            if entry["visibility"] == "public" and principals:
                raise ValueError("El conocimiento público no puede declarar una ACL restringida")
            if "source_reference" in entry:
                reference = entry["source_reference"]
                if not isinstance(reference, str) or not reference.strip() or (
                    "\x00" in reference or len(reference) > 20000
                ):
                    raise ValueError("access.json contiene una referencia inválida")
        return manifest

    def _record(
        self, record_id: str, title: str, relative: str, content: str, manifest: dict
    ) -> KnowledgeRecord:
        access = manifest.get(relative, {})
        return KnowledgeRecord(
            id=record_id, title=title, content=content,
            reference=access.get("source_reference", f"scw://{self.company_id}/{relative}"),
            visibility=access.get("visibility", "internal"),
            allowed_principals=tuple(sorted(access.get("allowed_principals", []))),
        )

    @staticmethod
    def _cells(line: str) -> list[str]:
        return [cell.strip() for cell in line.strip().strip("|").split("|")]

    def _evidence(self, manifest: dict) -> list[KnowledgeRecord]:
        path = self._path("evidence_registry.md")
        if not path.exists():
            return []
        records = []
        seen = set()
        header = None
        in_table = False
        text = self._text(path)
        for line in text.splitlines():
            if not line.lstrip().startswith("|"):
                in_table = False
                continue
            cells = self._cells(line)
            if "Evidence ID" in cells:
                if header is not None or not {"Evidence ID", "Status"} <= set(cells) or (
                    len(set(cells)) != len(cells) or any(not cell for cell in cells)
                ):
                    raise ValueError("Encabezado de evidence_registry.md inválido")
                header, in_table = cells, True
                continue
            if not in_table:
                continue
            if len(cells) != len(header):
                raise ValueError("Fila de evidence_registry.md mal formada")
            if all(re.fullmatch(r":?-+:?", cell) for cell in cells):
                continue
            if not any(cells):
                continue
            row = dict(zip(header, cells))
            status = row["Status"].lower().strip("* ")
            if status.startswith(_RETIRED):
                continue
            link = _EVIDENCE_LINK.fullmatch(row["Evidence ID"])
            if link is None:
                # La única fila inicial del template original no enlaza contenido.
                if re.fullmatch(r"EV-\d{6}", row["Evidence ID"]) and status == "new" and not any(
                    value for key, value in row.items() if key not in {"Evidence ID", "Status"}
                ):
                    continue
                raise ValueError("Registro de evidencia sin enlace Markdown válido")
            evidence_id, relative = link.groups()
            if not _EVIDENCE_ID.fullmatch(evidence_id) or evidence_id in seen or not status:
                raise ValueError("ID de evidencia inválido, duplicado o sin estado")
            evidence_path = self._path(relative)
            if not evidence_path.is_file():
                raise ValueError("Falta un archivo enlazado desde evidence_registry.md")
            content = self._text(evidence_path)
            if not content.strip():
                raise ValueError("Un archivo de evidencia está vacío")
            seen.add(evidence_id)
            records.append(self._record(
                f"evidence:{evidence_id}", evidence_id, relative, content, manifest
            ))
        if header is None and text.strip():
            raise ValueError("Falta la tabla de evidence_registry.md")
        return records

    def load(self) -> tuple[KnowledgeRecord, ...]:
        try:
            root = self.root.resolve()
        except (OSError, RuntimeError):
            raise ValueError("No se puede resolver la empresa seleccionada") from None
        if root != self.root or not root.is_dir():
            raise ValueError("La empresa no existe o su directorio no es seguro")
        manifest = self._manifest()
        records = []
        for domain in DOMINIOS:
            relative = f"{domain}.md"
            path = self._path(relative)
            if path.exists():
                content = self._text(path)
                if content.strip():
                    records.append(self._record(
                        f"domain:{domain}", domain, relative, content, manifest
                    ))
        records.extend(self._evidence(manifest))
        return tuple(records)
