"""Puerto de persistencia; implementación funcional en el siguiente punto."""
from typing import Protocol
from .contracts import Chunk, Document, Result, Source


class Persistence(Protocol):
    def save_document(
        self, source: Source, document: Document, chunks: tuple[Chunk, ...]
    ) -> None:
        """Guardar atómicamente; validar IDs de documento y fuente de cada fragmento."""
        ...

    def save_result(self, result: Result, branch: str) -> None:
        """Guardar resultado y vínculos a evidencia en una transacción."""
        ...
