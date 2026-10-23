import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvError, getStorageEnv } from "../../src/lib/env.ts";
import {
  InvalidImageError,
  PHOTO_FULL_MAX_PX,
  PHOTO_THUMB_MAX_PX,
  processPhoto,
} from "../../src/server/storage/images.ts";
import type { ObjectStorage, ReplitClientLike } from "../../src/server/storage/storage.ts";
import {
  StorageError,
  createLocalStorage,
  createReplitStorage,
  createStorage,
  isStorageKey,
} from "../../src/server/storage/storage.ts";

const KEY = "orders/order-1/photo-1-full.jpg";
const BYTES = Buffer.from("foto de prueba");

function memoryClient() {
  const objects = new Map<string, Buffer>();
  const client = {
    uploadFromBytes: vi.fn<ReplitClientLike["uploadFromBytes"]>(async (name, contents) => {
      objects.set(name, Buffer.from(contents));
      return { ok: true, value: null };
    }),
    downloadAsBytes: vi.fn<ReplitClientLike["downloadAsBytes"]>(async (name) => {
      const bytes = objects.get(name);
      return bytes
        ? { ok: true, value: [Buffer.from(bytes)] }
        : { ok: false, error: new Error("Objeto ausente") };
    }),
    delete: vi.fn<ReplitClientLike["delete"]>(async (name) => {
      objects.delete(name);
      return { ok: true, value: null };
    }),
    exists: vi.fn<ReplitClientLike["exists"]>(async (name) => ({
      ok: true,
      value: objects.has(name),
    })),
  };
  return client;
}

async function expectRoundTrip(storage: ObjectStorage) {
  expect(await storage.get(KEY)).toBeNull();
  expect(await storage.exists(KEY)).toBe(false);
  await storage.put(KEY, BYTES, "image/jpeg");
  expect(await storage.get(KEY)).toEqual(BYTES);
  expect(await storage.exists(KEY)).toBe(true);
  await storage.delete(KEY);
  expect(await storage.get(KEY)).toBeNull();
  expect(await storage.exists(KEY)).toBe(false);
  await storage.delete(KEY);
}

describe("almacenamiento local", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vb-storage-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("guarda, lee, consulta y borra los mismos bytes", async () => {
    await expectRoundTrip(createLocalStorage(dir));
  });

  it("crea directorios y reemplaza el objeto sin dejar temporales", async () => {
    const storage = createLocalStorage(join(dir, "nested"));
    await storage.put(KEY, BYTES, "image/jpeg");
    const replacement = Buffer.from("foto nueva");
    await storage.put(KEY, replacement, "image/jpeg");
    expect(await storage.get(KEY)).toEqual(replacement);
    expect(readdirSync(join(dir, "nested", "orders", "order-1"))).toEqual(["photo-1-full.jpg"]);
  });

  it("crea el driver local desde la configuración validada", async () => {
    await expectRoundTrip(await createStorage(getStorageEnv({ STORAGE_LOCAL_DIR: dir })));
  });

  it("rechaza claves inválidas en cada operación", async () => {
    const storage = createLocalStorage(dir);
    await expect(storage.put("../outside.jpg", BYTES, "image/jpeg")).rejects.toThrow(StorageError);
    await expect(storage.get("/absolute.jpg")).rejects.toThrow(StorageError);
    await expect(storage.exists("invalid.txt")).rejects.toThrow(StorageError);
    await expect(storage.delete("orders/../photo.jpg")).rejects.toThrow(StorageError);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("almacenamiento Replit con cliente en memoria", () => {
  it("traduce las cuatro operaciones sin red", async () => {
    const client = memoryClient();
    await expectRoundTrip(createReplitStorage(client));
    expect(client.uploadFromBytes).toHaveBeenCalledWith(KEY, BYTES);
    expect(client.downloadAsBytes).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(client.exists).toHaveBeenCalledWith(KEY);
    expect(client.delete).toHaveBeenCalledWith(KEY);
  });

  it("no descarga un objeto ausente", async () => {
    const client = memoryClient();
    expect(await createReplitStorage(client).get(KEY)).toBeNull();
    expect(client.downloadAsBytes).not.toHaveBeenCalled();
  });
});

describe("errores del almacenamiento Replit", () => {
  it.each(["uploadFromBytes", "downloadAsBytes", "exists", "delete"] as const)(
    "convierte ok:false de %s en StorageError",
    async (method) => {
      const client = memoryClient();
      const storage = createReplitStorage(client);
      await storage.put(KEY, BYTES, "image/jpeg");
      const cause = new Error("Fallo del cliente");
      client[method].mockResolvedValue({ ok: false, error: cause });
      const operation =
        method === "uploadFromBytes"
          ? storage.put(KEY, BYTES, "image/jpeg")
          : method === "downloadAsBytes"
            ? storage.get(KEY)
            : method === "exists"
              ? storage.exists(KEY)
              : storage.delete(KEY);
      await expect(operation).rejects.toThrow(StorageError);
      await expect(operation).rejects.toHaveProperty("cause", cause);
    },
  );

  it("convierte el error de exists durante get en StorageError", async () => {
    const client = memoryClient();
    client.exists.mockResolvedValue({ ok: false, error: "sin acceso" });
    await expect(createReplitStorage(client).get(KEY)).rejects.toThrow(StorageError);
    expect(client.downloadAsBytes).not.toHaveBeenCalled();
  });

  it("rechaza claves inválidas sin llamar al cliente", async () => {
    const client = memoryClient();
    const storage = createReplitStorage(client);
    await expect(storage.put("../photo.jpg", BYTES, "image/jpeg")).rejects.toThrow(StorageError);
    await expect(storage.get("/photo.jpg")).rejects.toThrow(StorageError);
    await expect(storage.exists("photo.gif")).rejects.toThrow(StorageError);
    await expect(storage.delete("orders/../photo.png")).rejects.toThrow(StorageError);
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
  });
});

describe("claves de almacenamiento", () => {
  it.each([KEY, "orders/order-1/signature-recepcion-1.png", "a.jpg"])("acepta %s", (key) => {
    expect(isStorageKey(key)).toBe(true);
  });

  it.each(["", "../a.jpg", "/a.jpg", "a/../b.png", "A.jpg", "a.jpeg", "a\\b.png", "a.jpg\n"])(
    "rechaza %j",
    (key) => {
      expect(isStorageKey(key)).toBe(false);
    },
  );
});

describe("procesamiento de fotos", () => {
  it("produce JPEG completo y miniatura dentro de sus límites", async () => {
    const input = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 120, g: 120, b: 120 } },
    })
      .jpeg()
      .toBuffer();
    const photo = await processPhoto(input);
    const full = await sharp(photo.full).metadata();
    const thumb = await sharp(photo.thumb).metadata();
    expect(full.format).toBe("jpeg");
    expect(thumb.format).toBe("jpeg");
    expect(Math.max(full.width ?? 0, full.height ?? 0)).toBe(PHOTO_FULL_MAX_PX);
    expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBe(PHOTO_THUMB_MAX_PX);
    expect(photo.width).toBe(full.width);
    expect(photo.height).toBe(full.height);
    expect(photo.width / photo.height).toBeCloseTo(1.5, 2);
  });

  it("aplica orientación 6, no amplía y elimina EXIF de ambas copias", async () => {
    const input = await sharp({
      create: { width: 300, height: 100, channels: 3, background: { r: 120, g: 120, b: 120 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const photo = await processPhoto(input);
    expect({ width: photo.width, height: photo.height }).toEqual({ width: 100, height: 300 });
    for (const bytes of [photo.full, photo.thumb]) {
      const metadata = await sharp(bytes).metadata();
      expect(metadata.width).toBe(100);
      expect(metadata.height).toBe(300);
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.exif).toBeUndefined();
    }
  });

  it("rechaza bytes que no son una imagen", async () => {
    await expect(processPhoto(Buffer.from("no es imagen"))).rejects.toThrow(InvalidImageError);
  });
});

describe("configuración del almacenamiento", () => {
  it("usa los valores por defecto con variables ausentes o vacías", () => {
    const defaults = {
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: ".storage",
      STORAGE_BUCKET_ID: undefined,
    };
    expect(getStorageEnv({})).toEqual(defaults);
    expect(
      getStorageEnv({
        STORAGE_DRIVER: "",
        STORAGE_LOCAL_DIR: "",
        STORAGE_BUCKET_ID: "",
        REPLIT_DEPLOYMENT: "",
      }),
    ).toEqual(defaults);
  });

  it("permite Replit con bucket opcional", () => {
    expect(
      getStorageEnv({
        REPLIT_DEPLOYMENT: "1",
        STORAGE_DRIVER: "replit",
        STORAGE_BUCKET_ID: "bucket-1",
      }),
    ).toEqual({
      STORAGE_DRIVER: "replit",
      STORAGE_LOCAL_DIR: ".storage",
      STORAGE_BUCKET_ID: "bucket-1",
    });
    expect(
      getStorageEnv({ REPLIT_DEPLOYMENT: "1", STORAGE_DRIVER: "replit" }).STORAGE_BUCKET_ID,
    ).toBeUndefined();
  });

  it.each([undefined, "local", ""])("exige replit en despliegue con driver %j", (driver) => {
    const source = { REPLIT_DEPLOYMENT: "1", STORAGE_DRIVER: driver };
    expect(() => getStorageEnv(source)).toThrow(EnvError);
    expect(() => getStorageEnv(source)).toThrow(
      expect.objectContaining({ variables: ["STORAGE_DRIVER"] }),
    );
  });

  it("rechaza un driver desconocido", () => {
    expect(() => getStorageEnv({ STORAGE_DRIVER: "other" })).toThrow(EnvError);
  });
});
