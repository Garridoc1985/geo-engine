import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    database_url: str = field(repr=False)

    @classmethod
    def from_env(cls) -> "Config":
        host = os.getenv("GEO_HOST", "127.0.0.1")
        if host not in {"127.0.0.1", "localhost"}:
            raise ValueError("ARQ-01 solo admite una interfaz local de loopback")
        port = int(os.getenv("GEO_PORT", "8000"))
        if not 1 <= port <= 65535:
            raise ValueError("GEO_PORT fuera de rango")
        database_url = os.getenv("DATABASE_URL", "postgresql:///geo_engine")
        if not database_url.startswith(("postgresql://", "postgres://")):
            raise ValueError("DATABASE_URL debe apuntar a PostgreSQL")
        return cls(host, port, database_url)
