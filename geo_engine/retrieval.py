"""Puerto de recuperación: aplicar permisos de documento Y fragmento."""
from typing import Protocol
from .contracts import Evidence, Query


class Retrieval(Protocol):
    def search(self, query: Query) -> tuple[Evidence, ...]: ...
