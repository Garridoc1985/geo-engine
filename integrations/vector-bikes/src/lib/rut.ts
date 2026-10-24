export function normalizeRut(raw: string): string | null {
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  if (!/^\d{7,8}[\dK]$/.test(compact)) return null;
  const body = compact.slice(0, -1);
  const digit = compact.slice(-1);
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
  return digit === expected ? `${body}-${digit}` : null;
}

export function formatRut(normalized: string): string {
  const [body, digit] = normalized.split("-");
  return `${body?.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${digit}`;
}
