import fs from "node:fs";
import { Readable } from "node:stream";
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

  async get(cachePath: string, headers: Headers): Promise<Response | null> {
    const file = Bun.file(cachePath);
    try {
      if (!(await file.exists()) || file.size === 0) {
        return null;
      }
      const headerBuf = await file.slice(0, 16).arrayBuffer();
      if (headerBuf.byteLength === 0) {
        return null;
      }
      headers.set(
        "Content-Type",
        detectContentType(new Uint8Array(headerBuf))
      );
      this.#maybeTouch(cachePath, file.lastModified);
      return new Response(file, { headers });
    } catch {
      return null;
    }
  }

  async write(cachePath: string, readable: Readable): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    } catch {
      // Ignore
    }

    const tmpPath = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tmpPath);
        const onError = (err: Error) => {
          reject(err);
        };
        readable.on("error", onError);
        writeStream.on("error", onError);
        readable.pipe(writeStream).on("finish", () => resolve());
      });
      await fs.promises.rename(tmpPath, cachePath);
    } catch (e) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw e;
    }
  }

  #maybeTouch(cachePath: string, lastModified: number) {
    if (this.#touchIntervalMs == null) {
      return;
    }
    const now = Date.now();
    if (now - lastModified <= this.#touchIntervalMs) {
      return;
    }
    const seconds = now / 1000;
    fs.promises.utimes(cachePath, seconds, seconds).catch(() => {});
  }
}
