"""Contratos iniciales. Los permisos se aplican antes de devolver contenido."""
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Permissions:
    visibility: Literal["public", "internal"]
    allowed_principals: tuple[str, ...] = ()

    def allows(self, principal: str | None) -> bool:
        return self.visibility == "public" or (
            principal is not None and principal in self.allowed_principals
        )


@dataclass(frozen=True)
class Source:
    id: str
    reference: str
    title: str


@dataclass(frozen=True)
class Document:
    id: str
    source_id: str
    title: str
    permissions: Permissions


@dataclass(frozen=True)
class Chunk:
    id: str
    document_id: str
    source_id: str
    content: str
    permissions: Permissions


@dataclass(frozen=True)
class Query:
    text: str
    branch: Literal["commercial", "geo"]
    principal: str | None = None


@dataclass(frozen=True)
class Evidence:
    chunk_id: str
    document_id: str
    source: Source
    content: str


@dataclass(frozen=True)
class Result:
    id: str
    status: Literal["draft", "insufficient_evidence"]
    text: str
    evidence: tuple[Evidence, ...]
