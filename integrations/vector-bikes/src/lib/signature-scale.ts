import type { PointGroup } from "signature_pad";

/**
 * Reescala los trazos de `signature_pad` cuando el canvas cambia de ancho (al girar la tablet).
 *
 * Solo las `x` y el grosor del trazo se escalan: el canvas de la firma tiene alto fijo, así que
 * escalar las `y` sacaría el trazo del recuadro. Con anchos iguales o inservibles devuelve los
 * trazos tal cual, que es lo que pasa cuando Safari avisa de un resize al ocultar su barra.
 */
export function scaleSignatureStrokes(
  strokes: PointGroup[],
  fromWidth: number,
  toWidth: number,
): PointGroup[] {
  if (
    fromWidth === toWidth ||
    !Number.isFinite(fromWidth) ||
    !Number.isFinite(toWidth) ||
    fromWidth <= 0 ||
    toWidth <= 0
  ) {
    return strokes;
  }
  const ratio = toWidth / fromWidth;
  return strokes.map((stroke) => ({
    ...stroke,
    dotSize: stroke.dotSize * ratio,
    minWidth: stroke.minWidth * ratio,
    maxWidth: stroke.maxWidth * ratio,
    points: stroke.points.map((point) => ({ ...point, x: point.x * ratio })),
  }));
}
