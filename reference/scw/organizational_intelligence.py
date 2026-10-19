"""Carga el conocimiento específico de cada cliente de Goea Engine.

El contrato productivo se basa en ``evidence_registry.md`` y en los registros
Markdown enlazados desde su tabla. Los antiguos archivos por dominio continúan
admitidos como compatibilidad, pero no son obligatorios para clientes existentes.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

_RAIZ = Path(__file__).resolve().parent.parent / "organizational_intelligence"
_RUTA_TEMPLATES = _RAIZ / "templates"
_RUTA_CLIENTES = _RAIZ / "clients"

# Contrato heredado. Se mantiene para workspaces antiguos y para consumidores
# que todavía consultan ``domains``/``missing_domains``.
DOMINIOS = [
    "company_profile", "business_model", "organization", "stakeholders",
    "products_services", "glossary", "commercial_process", "operational_process",
    "technology_stack", "data_sources", "financial_context", "commercial_context",
    "operational_context", "strategic_objectives", "pain_points", "risks",
    "opportunities", "current_projects", "documents", "meetings", "emails",
    "dashboards", "kpis", "decisions", "historical_context", "knowledge_evolution",
]

_CLIENT_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_LINK_EVIDENCIA = re.compile(r"\[([^]]+)]\((evidence/[^)]+\.md)\)")
_ESTADOS_RETIRADOS = ("superseded", "archived", "rejected", "invalid", "deprecated")


class OrganizationalIntelligence:
    """Conocimiento de ``organizational_intelligence/clients/<client_id>``."""

    def __init__(self, client_id: str):
        if not _CLIENT_ID.fullmatch(client_id):
            raise ValueError(
                "client_id inválido: use sólo minúsculas, números, guion o guion bajo"
            )
        self.client_id = client_id
        self.ruta = _RUTA_CLIENTES / client_id

    @property
    def existe(self) -> bool:
        return self.ruta.is_dir()

    @classmethod
    def crear_cliente(cls, client_id: str) -> "OrganizationalIntelligence":
        """Crea un cliente nuevo con el contrato vigente basado en evidencia."""
        cliente = cls(client_id)
        cliente.ruta.mkdir(parents=True, exist_ok=True)
        (cliente.ruta / "evidence").mkdir(exist_ok=True)
        plantilla = _RUTA_TEMPLATES / "evidence_registry.md"
        destino = cliente.ruta / "evidence_registry.md"
        if plantilla.exists() and not destino.exists():
            shutil.copy(plantilla, destino)
        return cliente

    def _ruta_dominio(self, dominio: str) -> Path:
        return self.ruta / f"{dominio}.md"

    def cargar_dominio(self, dominio: str) -> str:
        """Devuelve un dominio heredado, si existe."""
        ruta = self._ruta_dominio(dominio)
        return ruta.read_text(encoding="utf-8") if ruta.is_file() else ""

    def cargar_todo(self) -> dict[str, str]:
        """Devuelve los dominios heredados que tengan contenido."""
        return {
            dominio: contenido
            for dominio in DOMINIOS
            if (contenido := self.cargar_dominio(dominio)).strip()
        }

    def dominios_faltantes(self) -> list[str]:
        """Huecos del contrato heredado; no determina la validez del cliente."""
        presentes = self.cargar_todo()
        return [dominio for dominio in DOMINIOS if dominio not in presentes]

    @staticmethod
    def _fila_tabla(linea: str) -> list[str]:
        return [celda.strip() for celda in linea.strip().strip("|").split("|")]

    def _cargar_evidencia(self) -> tuple[list[dict[str, str]], list[str]]:
        """Lee filas vigentes del registry y resuelve sus Markdown enlazados."""
        registry = self.ruta / "evidence_registry.md"
        if not registry.is_file():
            return [], ["falta evidence_registry.md"]

        lineas = registry.read_text(encoding="utf-8").splitlines()
        encabezado: list[str] | None = None
        registros: list[dict[str, str]] = []
        advertencias: list[str] = []

        for linea in lineas:
            if not linea.lstrip().startswith("|"):
                continue
            celdas = self._fila_tabla(linea)
            if encabezado is None and celdas and celdas[0] == "Evidence ID":
                encabezado = celdas
                continue
            if encabezado is None or not celdas or set("".join(celdas)) <= {"-", ":"}:
                continue
            if len(celdas) != len(encabezado):
                advertencias.append(f"fila de registry mal formada: {linea[:80]}")
                continue

            fila = dict(zip(encabezado, celdas))
            estado = fila.get("Status", "").strip().lower().strip("* ")
            if any(estado.startswith(retirado) for retirado in _ESTADOS_RETIRADOS):
                continue

            enlace = _LINK_EVIDENCIA.search(fila.get("Evidence ID", ""))
            if not enlace:
                # La fila vacía de la plantilla no constituye evidencia utilizable.
                if any(fila.get(campo, "").strip() for campo in ("Client", "Summary", "Source")):
                    advertencias.append("registro sin enlace Markdown de evidencia")
                continue

            evidence_id, ruta_relativa = enlace.groups()
            ruta = self.ruta / ruta_relativa
            if not ruta.is_file():
                advertencias.append(f"{evidence_id}: no existe {ruta_relativa}")
                continue
            registros.append({
                "evidence_id": evidence_id,
                "status": fila.get("Status", ""),
                "confidence": fila.get("Confidence", ""),
                "odt_domain": fila.get("ODT Domain", ""),
                "summary": fila.get("Summary", ""),
                "path": ruta_relativa,
                "content": ruta.read_text(encoding="utf-8"),
            })
        return registros, advertencias

    def build_context(self) -> dict:
        """Construye el contexto trazable que consume el Decision Engine."""
        if not self.existe:
            return {
                "client_id": self.client_id, "exists": False, "source_format": None,
                "domains": {}, "missing_domains": list(DOMINIOS), "evidence": [],
                "evidence_count": 0, "warnings": ["cliente inexistente"], "as_text": "",
            }

        dominios = self.cargar_todo()
        evidencia, advertencias = self._cargar_evidencia()
        fragmentos: list[str] = []

        for registro in evidencia:
            fragmentos.append(
                f"### {registro['evidence_id']} — {registro['path']}\n"
                f"Estado del registry: {registro['status']}\n"
                f"Confianza: {registro['confidence'] or '(no declarada)'}\n"
                f"Dominio ODT: {registro['odt_domain'] or '(no asignado)'}\n"
                f"Resumen del registry: {registro['summary']}\n\n"
                f"{registro['content']}"
            )
        for dominio, contenido in dominios.items():
            fragmentos.append(f"### Dominio heredado: {dominio}\n{contenido}")

        if evidencia and dominios:
            formato = "hybrid"
        elif evidencia:
            formato = "evidence_registry"
        elif dominios:
            formato = "legacy_domains"
        else:
            formato = "empty"

        return {
            "client_id": self.client_id,
            "exists": True,
            "source_format": formato,
            "domains": dominios,
            "missing_domains": self.dominios_faltantes(),
            "evidence": evidencia,
            "evidence_count": len(evidencia),
            "warnings": advertencias,
            "as_text": "\n\n".join(fragmentos),
        }
