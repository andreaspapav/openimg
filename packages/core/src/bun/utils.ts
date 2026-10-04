import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BunFile } from "bun";
import path from "node:path";
import { getContentType } from "../utils";

export function exists(filePath: string): { size: number } | false {
  try {
    const file = Bun.file(filePath);
    if (file.size === 0) {
      return false;
    }
    return { size: file.size };
  } catch {
    return false;
  }
}

function detectContentType(header: Uint8Array): string {
  if (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  ) {
    return getContentType("jpeg");
  }
  if (
    header.length >= 4 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  ) {
    return getContentType("png");
  }
  if (header.length >= 12) {
    const riff = String.fromCharCode(
      header[0]!,
      header[1]!,
      header[2]!,
      header[3]!
    );
    const webp = String.fromCharCode(
      header[8]!,
      header[9]!,
      header[10]!,
      header[11]!
    );
    if (riff === "RIFF" && webp === "WEBP") {
      return getContentType("webp");
    }
  }
  if (header.length >= 12) {
    const ftyp = String.fromCharCode(
      header[4]!,
      header[5]!,
      header[6]!,
      header[7]!
    );
    if (ftyp === "ftyp") {
      const brand = String.fromCharCode(
        header[8]!,
        header[9]!,
        header[10]!,
        header[11]!
      );
      if (brand === "avif" || brand === "avis") {
        return getContentType("avif");
      }
      if (brand === "heic" || brand === "mif1") {
        return getContentType("heif");
      }
    }
  }
  if (header.length >= 4) {
    const gif = String.fromCharCode(
      header[0]!,
      header[1]!,
      header[2]!,
      header[3]!
    );
    if (gif === "GIF8") {
      return "image/gif";
    }
  }
  return getContentType(undefined);
}

export type FileCacheOptions = {
  touchIntervalMs: number | null;
};

export class FileCache {
  #touchIntervalMs: number | null;

  constructor(cacheFolder: string, options: FileCacheOptions) {
    this.#touchIntervalMs = options.touchIntervalMs;
    fs.mkdirSync(cacheFolder, { recursive: true });
  }

  async get(
    cachePath: string,
    headers: Headers
  ): Promise<{ response: Response; size: number } | null> {
    const file = Bun.file(cachePath);
    let header: Uint8Array;
    try {
      // One read answers "is it cached?" (missing file rejects, empty file
      // returns no bytes) and gives us the magic bytes for Content-Type.
      header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    } catch {
      return null;
    }
    if (header.byteLength === 0) {
      return null;
    }
    headers.set("Content-Type", detectContentType(header));
    this.#maybeTouch(cachePath, file);
    return { response: new Response(file, { headers }), size: file.size };
  }

  async write(cachePath: string, readable: Readable): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    } catch {
      // Ignore
    }

    const tmpPath = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      // pipeline destroys both streams on error, so the temp file is closed
      // before we unlink it
      await pipeline(readable, fs.createWriteStream(tmpPath));
      await fs.promises.rename(tmpPath, cachePath);
    } catch (e) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw e;
    }
  }

  #maybeTouch(cachePath: string, file: BunFile) {
    if (this.#touchIntervalMs == null) {
      return;
    }
    const now = Date.now();
    if (now - file.lastModified <= this.#touchIntervalMs) {
      return;
    }
    const seconds = now / 1000;
    fs.promises.utimes(cachePath, seconds, seconds).catch(() => {});
  }
}

/**
 * Thrown when a source image is larger than `maxSourceBytes`.
 */
export class SourceTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Source image exceeds maxSourceBytes (${maxBytes} bytes)`);
    this.name = "SourceTooLargeError";
  }
}

/**
 * Passes chunks through until more than maxBytes have been seen, then errors.
 * Covers sources without a (truthful) Content-Length.
 */
export function createByteLimiter(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new SourceTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
}

type FailedImage = {
  status: number;
  statusText: string;
  expiresAt: number;
};

/**
 * Remembers recently failed cache paths so repeat requests for a broken source
 * image don't fetch and decode it again. Bounded: the oldest entry is dropped
 * once `maxEntries` is reached, so memory stays flat.
 */
export class FailedImages {
  #entries = new Map<string, FailedImage>();
  #maxEntries: number;

  constructor(maxEntries = 1000) {
    this.#maxEntries = maxEntries;
  }

  get(cachePath: string): FailedImage | null {
    const entry = this.#entries.get(cachePath);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(cachePath);
      return null;
    }
    return entry;
  }

  set(cachePath: string, status: number, statusText: string, ttlMs: number) {
    this.#entries.delete(cachePath);
    this.#entries.set(cachePath, {
      status,
      statusText,
      expiresAt: Date.now() + ttlMs,
    });
    if (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) {
        this.#entries.delete(oldest);
      }
    }
  }
}

/**
 * Error responses never carry config.headers, which usually hold long-lived
 * Cache-Control headers meant for successful images.
 */
export function failureResponse(
  status: number,
  statusText: string,
  maxAgeSeconds: number | null
) {
  return new Response(null, {
    status,
    statusText,
    headers: {
      "Cache-Control":
        maxAgeSeconds === null
          ? "no-store"
          : `public, max-age=${maxAgeSeconds}`,
    },
  });
}
