import type { PointGroup } from "signature_pad";
import { describe, expect, it } from "vitest";
import { scaleSignatureStrokes } from "../../src/lib/signature-scale.ts";

/** Un trazo como lo devuelve `pad.toData()`, en píxeles CSS del canvas. */
function stroke(points: Array<[number, number]>): PointGroup {
  return {
    points: points.map(([x, y], index) => ({ x, y, pressure: 0.5, time: 1000 + index })),
    dotSize: 2,
    minWidth: 0.5,
    maxWidth: 2.5,
    penColor: "#0C0D0E",
    velocityFilterWeight: 0.7,
    compositeOperation: "source-over",
  };
}

const PORTRAIT = 740;
const LANDSCAPE = 1100;
const RATIO = LANDSCAPE / PORTRAIT;

describe("escalar los trazos de la firma al cambiar el ancho del canvas", () => {
  it("estira las x en la proporción del ancho y deja las y como están", () => {
    const scaled = scaleSignatureStrokes(
      [
        stroke([
          [100, 40],
          [370, 200],
        ]),
      ],
      PORTRAIT,
      LANDSCAPE,
    );

    expect(scaled[0]?.points[0]?.x).toBeCloseTo(100 * RATIO, 6);
    expect(scaled[0]?.points[1]?.x).toBeCloseTo(370 * RATIO, 6);
    expect(scaled[0]?.points.map((point) => point.y)).toEqual([40, 200]);
  });

  it("escala el grosor del trazo con el mismo factor", () => {
    const [scaled] = scaleSignatureStrokes([stroke([[10, 10]])], PORTRAIT, LANDSCAPE);

    expect(scaled?.minWidth).toBeCloseTo(0.5 * RATIO, 6);
    expect(scaled?.maxWidth).toBeCloseTo(2.5 * RATIO, 6);
    expect(scaled?.dotSize).toBeCloseTo(2 * RATIO, 6);
  });

  it("girar el iPad y volver deja la firma donde estaba", () => {
    const original = [
      stroke([
        [100, 40],
        [370, 200],
      ]),
    ];

    const there = scaleSignatureStrokes(original, PORTRAIT, LANDSCAPE);
    const back = scaleSignatureStrokes(there, LANDSCAPE, PORTRAIT);

    expect(back[0]?.points[0]?.x).toBeCloseTo(100, 6);
    expect(back[0]?.points[1]?.x).toBeCloseTo(370, 6);
    expect(back[0]?.maxWidth).toBeCloseTo(2.5, 6);
  });

  it("conserva la presión, el tiempo, el color y el resto de las opciones", () => {
    const original = stroke([
      [10, 20],
      [30, 40],
    ]);

    const [scaled] = scaleSignatureStrokes([original], PORTRAIT, LANDSCAPE);

    expect(scaled?.points.map((point) => point.pressure)).toEqual([0.5, 0.5]);
    expect(scaled?.points.map((point) => point.time)).toEqual([1000, 1001]);
    expect(scaled?.penColor).toBe("#0C0D0E");
    expect(scaled?.velocityFilterWeight).toBe(0.7);
    expect(scaled?.compositeOperation).toBe("source-over");
  });

  // El scroll de Safari dispara "resize" sin cambiar el canvas: ahí no hay nada que escalar.
  it("con el mismo ancho devuelve los trazos tal cual", () => {
    const original = [stroke([[100, 40]])];

    expect(scaleSignatureStrokes(original, PORTRAIT, PORTRAIT)).toEqual(original);
  });

  it("con un ancho inservible devuelve los trazos tal cual", () => {
    const original = [stroke([[100, 40]])];

    for (const [from, to] of [
      [0, LANDSCAPE],
      [PORTRAIT, 0],
      [-10, LANDSCAPE],
      [Number.NaN, LANDSCAPE],
      [PORTRAIT, Number.POSITIVE_INFINITY],
    ]) {
      expect(scaleSignatureStrokes(original, from as number, to as number)).toEqual(original);
    }
  });

  it("no toca los trazos que recibe", () => {
    const original = [stroke([[100, 40]])];
    const copy = structuredClone(original);

    scaleSignatureStrokes(original, PORTRAIT, LANDSCAPE);

    expect(original).toEqual(copy);
  });

  it("sin trazos no devuelve nada", () => {
    expect(scaleSignatureStrokes([], PORTRAIT, LANDSCAPE)).toEqual([]);
  });
});
