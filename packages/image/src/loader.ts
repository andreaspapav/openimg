import type { ImageConfig, ImageFit, ImageFormat } from "./config";

export type ImageLoaderArgs = {
  src: string;
  width: number;
  /** Set when the aspect ratio is known. */
  height?: number;
  fit?: ImageFit;
  /** Unset for the <img> fallback, which keeps the original format. */
  format?: ImageFormat;
  /**
   * The Image's `params` prop, unchanged: extra query parameters such as
   * `quality`, `position`, `objectKey` or a signature.
   */
  params?: Record<string, string>;
};

export type ImageLoader = (args: ImageLoaderArgs, config: ImageConfig) => string;

const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/i;

export function isAbsoluteUrl(src: string) {
  return ABSOLUTE_URL.test(src) || src.startsWith("//");
}

function resolveSrc(src: string, assetOrigin: string | undefined) {
  if (!assetOrigin || isAbsoluteUrl(src)) {
    return src;
  }
  return new URL(src, assetOrigin).href;
}

/**
 * Builds `{endpoint}?src=…&w=…&h=…&fit=…&format=…` plus any `params`, the
 * query format the image processor parses. Same output as openimg's
 * defaultGetSrc.
 */
export const defaultLoader: ImageLoader = (
  { src, width, height, fit, format, params: extra },
  config
) => {
  const params = new URLSearchParams({
    src: resolveSrc(src, config.assetOrigin),
    w: String(width),
  });
  if (height !== undefined) params.set("h", String(height));
  if (fit) params.set("fit", fit);
  if (format) params.set("format", format);
  for (const [key, value] of Object.entries(extra ?? {})) {
    params.set(key, value);
  }
  return `${config.endpoint}?${params}`;
};
