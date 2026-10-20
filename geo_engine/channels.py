"""Roles de los canales de GEO Engine; no implica una conexión externa activa."""

# Solo estos canales son candidatos actuales para generación auxiliar.
GENERATION_PROVIDERS = ("claude", "chatgpt")

# Canales de búsqueda y descubrimiento; nunca son fallback de generación.
SEARCH_ENGINES = ("perplexity",)
