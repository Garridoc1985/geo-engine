import { useEffect, useRef, useState } from "preact/hooks";

interface Props {
  uploadUrl: string;
  stage: "recepcion" | "reparacion" | "terminado";
  label?: string;
}

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const UPLOAD_ERROR = "No se pudo subir la foto. Intenta de nuevo.";

function uploadPhoto(
  url: string,
  stage: Props["stage"],
  file: File,
  onProgress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    form.append("foto", file);
    form.append("etapa", stage);
    request.open("POST", url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
    };
    request.onload = () => {
      if (request.status === 201) return resolve();
      reject(
        new Error(
          request.status === 413
            ? "La foto pesa más de 15 MB"
            : request.status === 415
              ? "Ese archivo no es una foto"
              : UPLOAD_ERROR,
        ),
      );
    };
    request.onerror = request.onabort = request.ontimeout = () => reject(new Error(UPLOAD_ERROR));
    request.send(form);
  });
}

function usePhotoUpload(uploadUrl: string, stage: Props["stage"]) {
  const busy = useRef(false);
  const [ready, setReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");

  useEffect(() => setReady(true), []);

  async function uploadFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (busy.current || files.length === 0) return;
    if (files.some((file) => file.size > MAX_PHOTO_BYTES)) {
      setMessage("La foto pesa más de 15 MB");
      return;
    }
    busy.current = true;
    setUploading(true);
    setMessage("");
    try {
      for (const [index, file] of files.entries()) {
        setProgress(0);
        setMessage(`Subiendo foto ${index + 1} de ${files.length}`);
        await uploadPhoto(uploadUrl, stage, file, setProgress);
      }
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : UPLOAD_ERROR);
    } finally {
      busy.current = false;
      setUploading(false);
    }
  }

  return { ready, uploading, progress, message, uploadFiles };
}

export default function PhotoCapture({ uploadUrl, stage, label }: Props) {
  const { ready, uploading, progress, message, uploadFiles } = usePhotoUpload(uploadUrl, stage);

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <label
        class="btn tap"
        style={{ minHeight: "48px", minWidth: "48px" }}
        aria-disabled={!ready || uploading}
      >
        {label ?? "Tomar foto"}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          hidden
          disabled={!ready || uploading}
          onChange={uploadFiles}
        />
      </label>
      <progress max={100} value={progress} aria-label="Progreso de la foto" />
      <p role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
