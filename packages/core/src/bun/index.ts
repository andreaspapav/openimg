import { createReadStream } from "fs";
import { PassThrough, Readable, pipeline as streamPipeline } from "node:stream";
import sharp from "sharp";
import {
  createByteLimiter,
  exists,
  FailedImages,
  failureResponse,
  FileCache,
  SourceTooLargeError,
} from "./utils";
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
const failedImages = new FailedImages();

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

type Failure = { status: number; statusText: string; remember: boolean };

/**
 * Maps errors from the source or sharp to an HTTP failure. Returns null for
 * anything else (e.g. a failing cache write), which is still thrown.
 */
function classifyFailure(
  error: unknown,
  sourceError: unknown,
  sharpError: unknown
): Failure | null {
  const cause = sourceError ?? error;
  if (cause instanceof SourceTooLargeError) {
    return {
      status: 422,
      statusText: "Source image too large",
      remember: true,
    };
  }
  if (sourceError !== undefined) {
    const name = sourceError instanceof Error ? sourceError.name : "";
    return name === "TimeoutError" || name === "AbortError"
      ? { status: 504, statusText: "Source image timed out", remember: false }
      : {
          status: 502,
          statusText: "Source image fetch failed",
          remember: false,
        };
  }
  if (sharpError !== undefined && error === sharpError) {
    return { status: 422, statusText: "Unprocessable image", remember: true };
  }
  return null;
}

function assertPositive(name: string, value: number | undefined) {
  if (value !== undefined) {
    invariant(value > 0, `${name} must be a positive number`);
  }
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
  assertPositive("fetchTimeoutMs", config.fetchTimeoutMs);
  assertPositive("maxSourceBytes", config.maxSourceBytes);
  assertPositive("limitInputPixels", config.limitInputPixels);
  assertPositive("failedImageTtlMs", config.failedImageTtlMs);

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

  let cache: FileCache | undefined;
  if (useCache && cacheFolder) {
    // FileCache holds no index, so one instance per folder + touch setting is
    // cheap and lets configs that share a folder use different settings.
    const touchIntervalMs = resolveTouchInterval(config.touchCacheOnHit);
    const cacheId = `${cacheFolder}\0${touchIntervalMs}`;
    cache = caches.get(cacheId);
    if (!cache) {
      cache = new FileCache(cacheFolder, { touchIntervalMs });
      caches.set(cacheId, cache);
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

  const limitTransforms = config.maxConcurrentTransforms !== undefined;
  const failedImageTtlMs = config.failedImageTtlMs;
  const maxSourceBytes = config.maxSourceBytes;
  // Set by stream listeners so a failure can be attributed to the source
  // image (fetch/read) or to sharp (decode/encode)
  let sourceError: unknown;
  let sharpError: unknown;

  const rememberFailure = (status: number, statusText: string) => {
    if (cachePath && failedImageTtlMs !== undefined) {
      failedImages.set(cachePath, status, statusText, failedImageTtlMs);
    }
  };

  try {
    if (useCache) {
      invariant(cachePath, "Cache path is required");
      invariant(cache, "Cache is required");
      while (true) {
        const lock = pipelineLock.wait(cachePath, request.signal);
        if (lock) {
          // Wait for ongoing pipeline to finish that writes to the same cache file
          await lock;
          continue;
        }

        const cached = await cache.get(cachePath, headers);
        if (cached) {
          if (config.onCacheHit) {
            try {
              config.onCacheHit({
                cachePath,
                contentType: cached.response.headers.get("Content-Type"),
                size: cached.size,
              });
            } catch {
              // Logging must not break serving
            }
          }
          return cached.response;
        }

        // Another request may have taken the lock while we read the cache
        if (pipelineLock.get(cachePath)) {
          continue;
        }

        // This source failed recently; don't fetch and decode it again
        const failed =
          failedImageTtlMs !== undefined ? failedImages.get(cachePath) : null;
        if (failed) {
          return failureResponse(
            failed.status,
            failed.statusText,
            Math.ceil((failed.expiresAt - Date.now()) / 1000)
          );
        }

        // Register ongoing write to the cache file. When transforms are
        // limited, the lock timeout only starts once we hold a slot, so
        // waiting in the queue doesn't trigger duplicate transforms.
        lockToken = pipelineLock.add(cachePath, {
          deferTimeout: limitTransforms,
        });
        break;
      }
    }

    if (limitTransforms) {
      semaphore = getSemaphore(config.maxConcurrentTransforms!);
      await semaphore.acquire();
      releaseSemaphoreInFinally = true;
      if (lockToken !== undefined) {
        pipelineLock.startTimeout(lockToken);
      }

      // The client went away while we were queued (disconnect, or Bun's
      // idleTimeout closed the connection). Give the slot to someone who is
      // still waiting, unless a connected request is waiting for this image.
      if (
        request.signal.aborted &&
        !(lockToken !== undefined && pipelineLock.hasActiveWaiters(lockToken))
      ) {
        return new Response(null, {
          status: 499,
          statusText: "Client Closed Request",
        });
      }
    }

    let readStream: Readable;
    if (source.type === "fetch") {
      let fetchRes: Response;
      try {
        // The timeout signal also aborts the body stream mid-download
        fetchRes = await fetch(source.url, {
          headers: source.headers,
          signal:
            config.fetchTimeoutMs !== undefined
              ? AbortSignal.timeout(config.fetchTimeoutMs)
              : undefined,
        });
      } catch (e) {
        sourceError = e;
        throw e;
      }
      if (!fetchRes.ok || !fetchRes.body) {
        // Release the connection instead of leaving the body unread
        await fetchRes.body?.cancel().catch(() => {});
        const status = fetchRes.status || 404;
        const statusText = fetchRes.statusText || "Image not found";
        if (
          failedImageTtlMs !== undefined &&
          (status === 404 || status === 410)
        ) {
          rememberFailure(status, statusText);
          return failureResponse(
            status,
            statusText,
            Math.ceil(failedImageTtlMs / 1000)
          );
        }
        return new Response(null, { status, statusText });
      }
      const contentLength = Number(fetchRes.headers.get("content-length"));
      if (maxSourceBytes !== undefined && contentLength > maxSourceBytes) {
        // Reject before downloading anything
        await fetchRes.body.cancel().catch(() => {});
        sourceError = new SourceTooLargeError(maxSourceBytes);
        throw sourceError;
      }
      readStream = fromWebStream(fetchRes.body);
    } else if (source.type === "fs") {
      const file = exists(source.path);
      if (!file) {
        return new Response(null, {
          status: 404,
          statusText: "Image not found",
        });
      }
      if (maxSourceBytes !== undefined && file.size > maxSourceBytes) {
        sourceError = new SourceTooLargeError(maxSourceBytes);
        throw sourceError;
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
      pipeline = getDefaultSharpPipeline(params, {
        limitInputPixels: config.limitInputPixels,
      });
    }

    // Registered before streamPipeline wires up the streams, so a source error
    // is recorded before it is forwarded into sharp
    readStream.once("error", (err) => {
      sourceError ??= err;
    });
    const limiter =
      maxSourceBytes !== undefined ? createByteLimiter(maxSourceBytes) : null;
    limiter?.once("error", (err) => {
      sourceError ??= err;
    });
    pipeline.once("error", (err) => {
      sharpError ??= err;
    });

    const infoPromise = new Promise<sharp.OutputInfo>((resolve, reject) => {
      pipeline.once("info", resolve);
      pipeline.once("error", reject);
      pipeline.once("close", () => {
        reject(new Error("Sharp pipeline closed before producing output"));
      });
    });

    // stream.pipeline forwards errors from the source and sharp to the output
    // stream (and destroys all of them), so neither the info promise nor the
    // cache write can wait forever on a failed transform.
    const outputStream = new PassThrough();
    const onPipelineDone = () => {
      // Errors surface through infoPromise and outputStream
    };
    if (limiter) {
      streamPipeline(
        readStream,
        limiter,
        pipeline,
        outputStream,
        onPipelineDone
      );
    } else {
      streamPipeline(readStream, pipeline, outputStream, onPipelineDone);
    }

    const outputImgInfo = await infoPromise;

    if (useCache) {
      invariant(cachePath, "Cache path is required");
      invariant(cache, "Cache is required");
      await cache.write(cachePath, outputStream);
      const cached = await cache.get(cachePath, headers);
      invariant(cached, "Cache write succeeded but read returned null");
      return cached.response;
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
    if (failedImageTtlMs !== undefined) {
      const failure = classifyFailure(e, sourceError, sharpError);
      if (failure) {
        if (failure.remember) {
          rememberFailure(failure.status, failure.statusText);
        }
        return failureResponse(
          failure.status,
          failure.statusText,
          failure.remember ? Math.ceil(failedImageTtlMs / 1000) : null
        );
      }
    }
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
