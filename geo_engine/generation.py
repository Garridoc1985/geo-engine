"""Puerto GEO: evaluar suficiencia y conservar referencias de evidencia."""
from typing import Protocol
from .contracts import Evidence, Query, Result


class Generation(Protocol):
    def generate(self, query: Query, evidence: tuple[Evidence, ...]) -> Result: ...
