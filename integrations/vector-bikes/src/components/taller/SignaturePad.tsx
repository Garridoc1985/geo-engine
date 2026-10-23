import { useEffect, useRef } from "preact/hooks";
import SignaturePad from "signature_pad";
import { scaleSignatureStrokes } from "../../lib/signature-scale.ts";

interface Props {
  name: string;
  label: string;
}

// La firma es un registro: se guarda como tinta oscura sobre papel blanco en cualquier tema.
// Son los valores claros aprobados de `--surface` y `--ink`; con `var(--ink)` en modo oscuro
// quedaría un trazo casi blanco sobre PNG transparente, invisible al imprimir.
const PAPER = "#FFFFFF";
const INK = "#0C0D0E";

function useSignaturePad() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (!canvas || !input) return;
    const pad = new SignaturePad(canvas, { backgroundColor: PAPER, penColor: INK });
    padRef.current = pad;
    let size = { width: 0, height: 0 };
    const endStroke = () => {
      input.value = pad.isEmpty() ? "" : pad.toDataURL("image/png");
    };
    const resize = () => {
      const { offsetWidth: width, offsetHeight: height } = canvas;
      if (width === size.width && height === size.height) return;
      const strokes = pad.toData();
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.getContext("2d")?.scale(ratio, ratio);
      pad.clear();
      if (strokes.length > 0 && size.width > 0) {
        pad.fromData(scaleSignatureStrokes(strokes, size.width, width));
      }
      size = { width, height };
      endStroke();
    };
    resize();
    pad.addEventListener("endStroke", endStroke);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => {
      pad.off();
      pad.removeEventListener("endStroke", endStroke);
      observer.disconnect();
      padRef.current = null;
    };
  }, []);

  function clear() {
    padRef.current?.clear();
    if (inputRef.current) inputRef.current.value = "";
  }

  return { canvasRef, inputRef, clear };
}

export default function SignatureField({ name, label }: Props) {
  const { canvasRef, inputRef, clear } = useSignaturePad();

  return (
    <fieldset style={{ display: "grid", gap: "8px" }}>
      <legend>{label}</legend>
      <canvas
        ref={canvasRef}
        aria-label={label}
        style={{
          height: "240px",
          width: "100%",
          touchAction: "none",
          background: PAPER,
          border: "1px solid var(--field-border)",
          borderRadius: "2px",
        }}
      />
      <input ref={inputRef} type="hidden" name={name} aria-label="Firma registrada" />
      <button type="button" class="btn ghost" onClick={clear}>
        Borrar
      </button>
    </fieldset>
  );
}
