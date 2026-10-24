import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getStorageEnv } from "../../lib/env.ts";

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export function isStorageKey(key: string): boolean {
  const match = /^[a-z0-9][a-z0-9/_-]*\.(?:jpg|png)$/.exec(key);
  return match?.[0] === key && !key.includes("..");
}

function requireStorageKey(key: string): void {
  if (!isStorageKey(key)) throw new StorageError("Clave de almacenamiento inválida");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function writeAtomic(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export function createLocalStorage(dir: string): ObjectStorage {
  const pathFor = (key: string) => {
    requireStorageKey(key);
    return join(dir, key);
  };
  return {
    async put(key, body) {
      await writeAtomic(pathFor(key), body);
    },
    async get(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      try {
        await unlink(pathFor(key));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    async exists(key) {
      try {
        await access(pathFor(key));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
  };
}

export type ReplitResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface ReplitClientLike {
  uploadFromBytes(name: string, contents: Buffer): Promise<ReplitResult<unknown>>;
  downloadAsBytes(name: string): Promise<ReplitResult<[Buffer]>>;
  delete(name: string): Promise<ReplitResult<unknown>>;
  exists(name: string): Promise<ReplitResult<boolean>>;
}

function replitValue<T>(result: ReplitResult<T>): T {
  if (!result.ok) {
    throw new StorageError("Falló la operación de almacenamiento", { cause: result.error });
  }
  return result.value;
}

export function createReplitStorage(client: ReplitClientLike): ObjectStorage {
  return {
    async put(key, body) {
      requireStorageKey(key);
      replitValue(await client.uploadFromBytes(key, body));
    },
    async get(key) {
      requireStorageKey(key);
      if (!replitValue(await client.exists(key))) return null;
      return replitValue(await client.downloadAsBytes(key))[0];
    },
    async delete(key) {
      requireStorageKey(key);
      replitValue(await client.delete(key));
    },
    async exists(key) {
      requireStorageKey(key);
      return replitValue(await client.exists(key));
    },
  };
}

export async function createStorage(env = getStorageEnv()): Promise<ObjectStorage> {
  if (env.STORAGE_DRIVER === "local") return createLocalStorage(env.STORAGE_LOCAL_DIR);
  const { Client } = await import("@replit/object-storage");
  const client = new Client(
    env.STORAGE_BUCKET_ID ? { bucketId: env.STORAGE_BUCKET_ID } : undefined,
  );
  return createReplitStorage({
    uploadFromBytes: (name, contents) => client.uploadFromBytes(name, contents),
    downloadAsBytes: (name) => client.downloadAsBytes(name),
    delete: (name) => client.delete(name),
    exists: (name) => client.exists(name),
  });
}

let storagePromise: Promise<ObjectStorage> | undefined;

export function getStorage(): Promise<ObjectStorage> {
  storagePromise ??= createStorage();
  return storagePromise;
}
