"""Adaptadores de texto para las API oficiales, sin reintentos implícitos.

La selección y el fallback pertenecen al router. Cada llamada transmite solo el
prompt que aquel ya autorizó. No se conservan cuerpos de error ni credenciales en
los errores que salen de este módulo.
"""

from dataclasses import dataclass, field
from http.client import HTTPException
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


_ENDPOINTS = {
    "claude": "https://api.anthropic.com/v1/messages",
    "chatgpt": "https://api.openai.com/v1/responses",
}
_MAX_RESPONSE_BYTES = 2_000_000


class ProviderError(Exception):
    """Error público seguro; nunca contiene el cuerpo HTTP del proveedor."""

    def __init__(self, code: str, retryable: bool = False):
        # El código también puede acabar en la API o la trazabilidad del router.
        self.code = code if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) else "provider_error"
        self.retryable = bool(retryable)
        super().__init__(self.code)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Incluso un redirect al mismo dominio puede alterar el método o destino.
        # Se exige cambiar el endpoint en código tras verificar documentación.
        raise ProviderError("redirect_blocked")


def urlopen(request: Request, *, timeout: float):
    """Transporte aislado que no hereda un opener global con redirects."""
    return build_opener(_NoRedirect()).open(request, timeout=timeout)


def _request_json(request: Request, *, timeout: float) -> object:
    """Transporte común con errores seguros y lectura acotada."""
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        status = error.code
        error.close()
        raise ProviderError(
            f"http_{status}", retryable=status in {408, 429} or 500 <= status <= 599
        ) from None
    except (URLError, TimeoutError, OSError, HTTPException):
        raise ProviderError("transport_error", retryable=True) from None
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise ProviderError("response_too_large")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise ProviderError("invalid_response", retryable=True) from None


@dataclass(frozen=True)
class HTTPProvider:
    name: str
    model: str
    api_key: str = field(repr=False)
    timeout: float = 30.0
    max_output_tokens: int = 2048

    def __post_init__(self):
        if self.name not in _ENDPOINTS:
            raise ProviderError("unsupported_provider")
        if not isinstance(self.model, str) or not isinstance(self.api_key, str):
            raise ProviderError("invalid_configuration")
        if any(ch in self.model + self.api_key for ch in "\r\n"):
            raise ProviderError("invalid_configuration")
        if not isinstance(self.timeout, (int, float)) or not 0 < self.timeout <= 120:
            raise ProviderError("invalid_configuration")
        if type(self.max_output_tokens) is not int or not 1 <= self.max_output_tokens <= 32768:
            raise ProviderError("invalid_configuration")

    @property
    def available(self) -> bool:
        return bool(self.model.strip() and self.api_key.strip())

    def list_models(self) -> tuple[str, ...]:
        """Enumera modelos visibles para la clave OpenAI, sin requerir un modelo elegido."""
        if self.name != "chatgpt":
            raise ProviderError("unsupported_access_check")
        if not self.api_key.strip():
            raise ProviderError("not_configured")
        request = Request(
            "https://api.openai.com/v1/models",
            headers={"Authorization": "Bearer " + self.api_key, "Accept": "application/json"},
            method="GET",
        )
        data = _request_json(request, timeout=self.timeout)
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise ProviderError("invalid_response", retryable=True)
        items = data["data"]
        if any(not isinstance(item, dict) or not isinstance(item.get("id"), str)
               or not item["id"] for item in items):
            raise ProviderError("invalid_response", retryable=True)
        return tuple(sorted(item["id"] for item in items))

    def check_model_access(self) -> None:
        """Comprueba acceso al modelo OpenAI sin generar contenido empresarial."""
        if self.name != "chatgpt":
            raise ProviderError("unsupported_access_check")
        if not self.available:
            raise ProviderError("not_configured")
        request = Request(
            "https://api.openai.com/v1/models/" + quote(self.model, safe=""),
            headers={"Authorization": "Bearer " + self.api_key, "Accept": "application/json"},
            method="GET",
        )
        data = _request_json(request, timeout=self.timeout)
        if not isinstance(data, dict) or data.get("id") != self.model:
            raise ProviderError("invalid_response", retryable=True)

    def generate(self, prompt: str) -> str:
        if not self.available:
            raise ProviderError("not_configured")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ProviderError("invalid_prompt")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.name == "claude":
            headers.update({"x-api-key": self.api_key, "anthropic-version": "2023-06-01"})
            payload = {
                "model": self.model,
                "max_tokens": self.max_output_tokens,
                "messages": [{"role": "user", "content": prompt}],
            }
        else:
            headers["Authorization"] = "Bearer " + self.api_key
            payload = {
                "model": self.model,
                "input": prompt,
                "max_output_tokens": self.max_output_tokens,
                "store": False,
            }
        request = Request(
            _ENDPOINTS[self.name],
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        return self._text(_request_json(request, timeout=self.timeout))

    def _text(self, data: object) -> str:
        if not isinstance(data, dict):
            raise ProviderError("invalid_response", retryable=True)
        if self.name == "claude":
            if data.get("stop_reason") == "refusal":
                raise ProviderError("refused")
            if data.get("stop_reason") in {"max_tokens", "tool_use", "pause_turn"}:
                raise ProviderError("incomplete_response")
            blocks = data.get("content")
            if not isinstance(blocks, list):
                raise ProviderError("invalid_response", retryable=True)
            texts = [
                block["text"] for block in blocks
                if isinstance(block, dict) and block.get("type") == "text"
                and isinstance(block.get("text"), str)
            ]
        else:
            if data.get("status") != "completed":
                raise ProviderError("incomplete_response")
            output = data.get("output")
            if not isinstance(output, list):
                raise ProviderError("invalid_response", retryable=True)
            texts = []
            for item in output:
                if not isinstance(item, dict) or item.get("type") != "message":
                    continue
                if item.get("status", "completed") != "completed":
                    raise ProviderError("incomplete_response")
                content = item.get("content")
                if not isinstance(content, list):
                    raise ProviderError("invalid_response", retryable=True)
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "refusal":
                        raise ProviderError("refused")
                    if block.get("type") == "output_text" and isinstance(block.get("text"), str):
                        texts.append(block["text"])
        result = "\n".join(texts).strip()
        if not result:
            raise ProviderError("empty_response")
        return result


def build_providers_from_env(only: str | None = None) -> list[HTTPProvider]:
    """Modelos explícitos: una clave sin modelo no habilita un proveedor."""
    if only is not None and (not isinstance(only, str) or only not in _ENDPOINTS):
        raise ValueError("Proveedor no admitido")
    settings = (("claude", "CLAUDE_MODEL", "ANTHROPIC_API_KEY"),
                ("chatgpt", "OPENAI_MODEL", "OPENAI_API_KEY"))
    return [HTTPProvider(name, os.getenv(model, "").strip(), os.getenv(key, "").strip())
            for name, model, key in settings if only is None or name == only]
