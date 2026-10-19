"""Puerto para la futura ingesta CSV, JSON y catálogo."""
from typing import Protocol
from .contracts import Chunk, Document, Source


class Ingestion(Protocol):
    def ingest(self, source: Source, document: Document, chunks: tuple[Chunk, ...]) -> None: ...
