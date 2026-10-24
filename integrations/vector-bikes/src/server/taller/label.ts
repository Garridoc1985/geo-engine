import QRCode from "qrcode";
import type { SessionUser } from "../auth/admin-auth.ts";
import type { AppDb } from "../db/client.ts";
import { formatOrderNumber, getOrderHeader } from "./orders.ts";
import { LABEL_WIDTH_MM } from "./rules.ts";
import { canAccessOrder } from "./status.ts";

export function qrPayload(siteUrl: string, orderId: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/taller/ordenes/${orderId}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type LabelData = {
  number: number;
  customerName: string;
  estimatedDate: string | null;
  qrUrl: string;
  svg: string;
};

export function renderLabelHtml(
  { number, customerName, estimatedDate, qrUrl, svg }: LabelData,
  widthMm = LABEL_WIDTH_MM,
): string {
  const label = escapeHtml(formatOrderNumber(number));
  const date = estimatedDate ? estimatedDate.split("-").reverse().join("-") : "sin fecha";
  const width = escapeHtml(String(widthMm));
  // El SVG proviene únicamente del generador QR de confianza, nunca de una entrada externa.
  return `<!doctype html>
<html lang="es-CL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Etiqueta ${label} — Vector Bikes</title>
  <style>
    @page { size: ${width}mm auto; margin: 0; }
    body { width: ${width}mm; margin: 0; font-family: sans-serif; color: black; background: white; }
    main { padding: 3mm; overflow-wrap: anywhere; }
    h1 { font-family: monospace; font-variant-numeric: tabular-nums; }
    .qr svg { display: block; width: 100%; height: auto; }
    button { min-width: 48px; min-height: 48px; margin: 8px; }
    @media print { button { display: none; } }
  </style>
</head>
<body>
  <main>
    <h1>${label}</h1>
    <p>${escapeHtml(customerName)}</p>
    <p>Entrega estimada: ${escapeHtml(date)}</p>
    <div class="qr" data-qr-url="${escapeHtml(qrUrl)}">${svg}</div>
  </main>
  <button type="button" onclick="window.print()">Imprimir</button>
</body>
</html>`;
}

type LabelDeps = { toSvg?: (text: string) => Promise<string> };

export async function buildLabel(
  db: AppDb,
  actor: SessionUser,
  orderId: string,
  siteUrl: string,
  deps: LabelDeps = {},
) {
  const header = await getOrderHeader(db, actor, orderId);
  if (!header || header.order.voidedAt) return { ok: false, code: "not_found" } as const;
  if (!canAccessOrder(actor, header.order)) return { ok: false, code: "forbidden" } as const;
  const qrUrl = qrPayload(siteUrl, orderId);
  const toSvg =
    deps.toSvg ??
    ((text: string) =>
      QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" }));
  const html = renderLabelHtml({
    number: header.order.number,
    customerName: header.customer.name,
    estimatedDate: header.order.estimatedDeliveryDate,
    qrUrl,
    svg: await toSvg(qrUrl),
  });
  return { ok: true, html } as const;
}
