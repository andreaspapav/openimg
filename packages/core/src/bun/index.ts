import { createReadStream } from "fs";
import { PassThrough, Readable } from "node:stream";
import sharp from "sharp";
import { exists, FileCache } from "./utils";
import invariant, {
  Config,
  DEFAULT_CACHE_FOLDER,
  fromWebStream,
  getCachePath,
  getContentType,
  getDefaultSharpPipeline,
  getImgParams,
  getImgSource,
  ImgParams,
  ImgSource,
  PipelineLock,
  toWebStream,
  validateImgSource,
} from "../utils";

const pipelineLock = new PipelineLock();
const caches = new Map<string, FileCache>();
const semaphores = new Map<number, Semaphore>();

const DAY_MS = 24 * 60 * 60 * 1000;

class Semaphore {
  #max: number;
  #active = 0;
  #queue: Array<() => void> = [];

  constructor(max: number) {
    this.#max = max;
  }

  async acquire() {
    if (this.#active < this.#max) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  release() {
    const next = this.#queue.shift();
    if (next) {
      next();
    } else {
      this.#active--;
    }
  }
}

function getSemaphore(limit: number): Semaphore {
  let semaphore = semaphores.get(limit);
  if (!semaphore) {
    semaphore = new Semaphore(limit);
    semaphores.set(limit, semaphore);
  }
  return semaphore;
}

function resolveTouchInterval(
  touchCacheOnHit: Config["touchCacheOnHit"]
): number | null {
  if (!touchCacheOnHit) {
    return null;
  }
  if (touchCacheOnHit === true) {
    return DAY_MS;
  }
  return touchCacheOnHit.intervalMs;
}

/**
 * getImgResponse retrieves an image, optimizes it, and returns a HTTP response
 * it returns failure responses for 404, 401 and similar cases
 * but may also throw errors if the image is not found or cannot be processed
 * or if the config options are invalid.
 * @param {Request} request - the incoming HTTP request, using the Web Fetch API's Request object
 * @param {Config} config - the config object
 * @returns {Promise<Response>} - a promise resolving to a Response object
 */
export async function getImgResponse(request: Request, config: Config = {}) {
  const headers = new Headers(config.headers);

  if (config.maxConcurrentTransforms !== undefined) {
    invariant(
      Number.isInteger(config.maxConcurrentTransforms) &&
        config.maxConcurrentTransforms >= 1,
      "maxConcurrentTransforms must be an integer >= 1"
    );
  }

  // Get image parameters (src, width, height, fit, format) from the request
  const paramsRes = config.getImgParams
    ? await config.getImgParams({ request })
    : getImgParams({ request });
  if (paramsRes instanceof Response) {
    return paramsRes;
  }
  const params: ImgParams = paramsRes;

  // Map src to location of the original image (fs or fetch)
  const sourceRes = config.getImgSource
    ? await config.getImgSource({ request, params })
    : getImgSource({ request, params });
  if (sourceRes instanceof Response) {
    return sourceRes;
  }
  const source: ImgSource = sourceRes;

  // Validate the image source against the allowlisted origins and other config options
  const res = validateImgSource(source, config);
  if (res instanceof Response) {
    return res;
  }

  const sharpConfig = config.getSharpPipeline
    ? await config.getSharpPipeline({ params, source })
    : undefined;
  if (sharpConfig && config.cacheFolder !== "no_cache") {
    invariant(
      sharpConfig.cacheKey,
      "cacheKey is required when file caching is enabled and a custom Sharp pipeline is used. Otherwise, openimg's image cache won't be able to differentiate between different pipelines and their output images and serve wrong images."
    );
  }
  if (
    sharpConfig &&
    sharpConfig.cacheKey &&
    source.type === "data" &&
    source.cacheKey
  ) {
    invariant(
      sharpConfig.cacheKey === source.cacheKey,
      "type='data' source image and sharp pipeline cacheKey mismatch. You provided a custom cacheKey for the custom sharp pipeline and a custom cacheKey for the data source. These must match when both are provided."
    );
  }

  const useCache = config.cacheFolder !== "no_cache";
  const cacheFolder = useCache
    ? config.cacheFolder || DEFAULT_CACHE_FOLDER
    : null;

  if (useCache && cacheFolder) {
    let cache = caches.get(cacheFolder);
    if (!cache) {
      cache = new FileCache(cacheFolder, {
        touchIntervalMs: resolveTouchInterval(config.touchCacheOnHit),
      });
      caches.set(cacheFolder, cache);
    }
  }

  const cachePath = useCache
    ? getCachePath({
        params,
        source,
        sharpConfig,
        cacheFolder: config.cacheFolder,
      })
    : null;

  let lockToken: symbol | undefined;
  let semaphore: Semaphore | null = null;
  let releaseSemaphoreInFinally = false;

  try {
    if (useCache) {
      invariant(cachePath, "Cache path is required");
      const lock = pipelineLock.get(cachePath);
      if (lock) {
        // Wait for ongoing pipeline to finish that writes to the same cache file
        await lock;
      }

      const cache = caches.get(cacheFolder!);
      invariant(cache, "Cache is required");
      const cached = await cache.get(cachePath, headers);
      if (cached) {
        return cached;
      }

      // Register ongoing write to the cache file
      lockToken = pipelineLock.add(cachePath);
    }

    if (config.maxConcurrentTransforms !== undefined) {
      semaphore = getSemaphore(config.maxConcurrentTransforms);
      await semaphore.acquire();
      releaseSemaphoreInFinally = true;
    }

    let readStream: Readable;
    if (source.type === "fetch") {
      const fetchRes = await fetch(source.url, { headers: source.headers });
      if (!fetchRes.ok || !fetchRes.body) {
        return new Response(null, {
          status: fetchRes.status || 404,
          statusText: fetchRes.statusText || "Image not found",
        });
      }
      readStream = fromWebStream(fetchRes.body);
    } else if (source.type === "fs") {
      if (!exists(source.path)) {
        return new Response(null, {
          status: 404,
          statusText: "Image not found",
        });
      }
      readStream = createReadStream(source.path);
    } else {
      // type === "data"
      if (source.data instanceof Readable) {
        readStream = source.data;
      } else if (source.data instanceof ReadableStream) {
        readStream = fromWebStream(source.data);
      } else {
        readStream = Readable.from(source.data);
      }
    }

    let pipeline: sharp.Sharp;
    if (sharpConfig) {
      pipeline = sharpConfig.pipeline;
    } else {
      pipeline = getDefaultSharpPipeline(params);
    }

    const infoPromise = new Promise<sharp.OutputInfo>((resolve) => {
      pipeline.on("info", (info) => {
        resolve(info);
      });
    });

    const transformed = readStream.pipe(pipeline);
    const outputStream = new PassThrough();
    transformed.pipe(outputStream);

    const outputImgInfo = await infoPromise;

    if (useCache) {
      invariant(cachePath, "Cache path is required");
      const cache = caches.get(cacheFolder!);
      invariant(cache, "Cache is required");
      await cache.write(cachePath, outputStream);
      const cached = await cache.get(cachePath, headers);
      invariant(cached, "Cache write succeeded but read returned null");
      return cached;
    }

    // no_cache: response streams lazily — release the semaphore when the
    // stream finishes instead of in finally, so we don't free the slot early.
    if (semaphore) {
      releaseSemaphoreInFinally = false;
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        semaphore!.release();
      };
      outputStream.on("end", release);
      outputStream.on("close", release);
      outputStream.on("error", release);
    }

    headers.set("Content-Type", getContentType(outputImgInfo.format));
    headers.set("Content-Length", outputImgInfo.size.toString());
    return new Response(toWebStream(outputStream), {
      headers,
    });
  } catch (e: unknown) {
    throw new Error(`Error while processing the image request`, {
      cause: e,
    });
  } finally {
    if (lockToken !== undefined) {
      pipelineLock.resolve(cachePath, lockToken);
    }
    if (releaseSemaphoreInFinally && semaphore) {
      semaphore.release();
    }
  }
}
