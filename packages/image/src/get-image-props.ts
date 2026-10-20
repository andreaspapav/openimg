import type { CSSProperties, ImgHTMLAttributes, Ref } from "react";
import type { PreloadOptions } from "react-dom";
import {
  imageConfig,
  type ImageConfig,
  type ImageFit,
  type ImageFormat,
} from "./config";
import type { ImageLoader } from "./loader";

/**
 * An image with known dimensions, e.g. a stored upload or a Vite plugin
 * import. `blurDataURL` is a tiny image as a data URL.
 */
export type StaticImageData = {
  src: string;
  width: number;
  height: number;
  blurDataURL?: string;
};

export type PlaceholderValue = "empty" | "blur" | `data:image/${string}`;

type Dimension = number | `${number}`;

export type ImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "srcSet" | "width" | "height" | "placeholder" | "alt"
> & {
  /** URL, root-relative path, Vite asset URL, or a static image object. */
  src: string | StaticImageData;
  /** Required. Use "" for decorative images. */
  alt: string;
  /**
   * Rendered width in CSS pixels. Sets the aspect ratio and, without `sizes`,
   * the 1x/2x srcset. Optional with `fill` or a static image.
   */
  width?: Dimension;
  /** Rendered height in CSS pixels. */
  height?: Dimension;
  /**
   * Fill the nearest positioned parent instead of setting width/height.
   * Combine with `sizes` and `object-fit`.
   */
  fill?: boolean;
  /**
   * The `sizes` attribute, e.g. "(min-width: 768px) 50vw, 100vw". Switches the
   * srcset from 1x/2x to width descriptors.
   */
  sizes?: string;
  /** How the processor crops when the requested ratio differs from the source. */
  fit?: ImageFit;
  /** For the LCP image: preloads it, loads eagerly, with high fetch priority. */
  priority?: boolean;
  /**
   * "blur" shows `blurDataURL` (or the static image's), smoothed with an SVG
   * blur filter. A data URL is shown as-is.
   */
  placeholder?: PlaceholderValue;
  blurDataURL?: string;
  /** Render the original `src` without the processor. */
  unoptimized?: boolean;
  /** Build processor URLs differently for this image. Default: `config.loader`. */
  loader?: ImageLoader;
  /**
   * Extra query parameters for every URL of this image, passed to the loader
   * (like openimg's `params`), e.g. `{ quality: "70", position: "top" }`.
   */
  params?: Record<string, string>;
  /** Overrides `imageConfig.formats` for this image. */
  formats?: ImageFormat[];
  ref?: Ref<HTMLImageElement>;
};

export type ImageSource = {
  type: string;
  srcSet: string;
  sizes?: string;
};

export type ImgAttributes = Omit<ImgHTMLAttributes<HTMLImageElement>, "alt"> & {
  src: string;
  alt: string;
};

export type ImagePropsResult = {
  /** One <source> per modern format. Empty when unoptimized. */
  sources: ImageSource[];
  img: ImgAttributes;
  /** Arguments for `ReactDOM.preload`, set when `priority` is true. */
  preload?: { href: string; options: PreloadOptions };
};

export type ImageState = {
  /** The image (or its error) has arrived, so the placeholder can go. */
  complete: boolean;
  /** Loading failed: show the alt text. */
  error: boolean;
};

const INITIAL_STATE: ImageState = { complete: false, error: false };

// Formats sharp can't resize faithfully (vectors, animations) and inline data
const SKIP_EXTENSIONS = /\.(svg|gif)$/i;
const VIEWPORT_WIDTH = /(^|\s)(1?\d?\d)vw/g;
// Width of the blur SVG's coordinate space. A 16px placeholder gets 20 units
// per pixel, so the blur radius below spans about one source pixel
const BLUR_SVG_WIDTH = 320;
const BLUR_STD_DEVIATION = 20;

function toNumber(value: Dimension | undefined) {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function canOptimize(src: string) {
  if (src.startsWith("data:") || src.startsWith("blob:")) return false;
  const path = src.split(/[?#]/, 1)[0] ?? src;
  return !SKIP_EXTENSIONS.test(path);
}

/**
 * Wraps a tiny image in an SVG with a Gaussian blur, so it scales up smooth
 * instead of blocky. The color matrix and composites keep the edges opaque;
 * a plain blur would fade them to transparent.
 */
export function getBlurSvg(
  blurDataURL: string,
  ratio: number | undefined,
  contain: boolean
) {
  const viewBox = ratio
    ? ` viewBox='0 0 ${BLUR_SVG_WIDTH} ${Math.round(BLUR_SVG_WIDTH / ratio)}'`
    : "";
  // Crop like the processor does (centered) rather than stretch, since the
  // placeholder keeps the source's ratio
  const aspect = contain ? "xMidYMid" : "xMidYMid slice";
  const std = BLUR_STD_DEVIATION;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg'${viewBox}>` +
    `<filter id='b' color-interpolation-filters='sRGB'>` +
    `<feGaussianBlur stdDeviation='${std}'/>` +
    `<feColorMatrix values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1' result='s'/>` +
    `<feFlood x='0' y='0' width='100%' height='100%'/>` +
    `<feComposite operator='out' in='s'/>` +
    `<feComposite in2='SourceGraphic'/>` +
    `<feGaussianBlur stdDeviation='${std}'/>` +
    `</filter>` +
    `<image width='100%' height='100%' x='0' y='0' preserveAspectRatio='${aspect}' style='filter: url(#b);' href='${blurDataURL}'/>` +
    `</svg>`;
  // Encode only what breaks a data URL; base64 needs no escaping
  return `data:image/svg+xml;charset=utf-8,${svg.replace(/[<>#%]/g, encodeURIComponent)}`;
}

function unique(values: number[]) {
  return [...new Set(values)];
}

/**
 * Picks srcset widths. With `sizes` (or no width) these are width
 * descriptors; with a fixed width they are 1x and 2x, rounded up to a
 * configured size so URLs repeat across images and hit the cache.
 * `maxWidth` (the intrinsic width, when known) drops widths that would only
 * upscale. Every width stays a configured size, because the processor only
 * accepts those (its `allowedWidths`).
 */
export function getWidths(
  config: ImageConfig,
  width: number | undefined,
  sizes: string | undefined,
  maxWidth?: number
): { widths: number[]; kind: "w" | "x" } {
  const deviceSizes = [...config.deviceSizes].sort((a, b) => a - b);
  const allSizes = unique([...config.imageSizes, ...deviceSizes]).sort(
    (a, b) => a - b
  );
  const largest = allSizes[allSizes.length - 1] ?? width ?? 0;

  let widths: number[];
  let kind: "w" | "x";
  if (sizes) {
    // "50vw" means the image never needs to be wider than half the
    // smallest device width, so the smaller sizes are useful too
    const percents = [...sizes.matchAll(VIEWPORT_WIDTH)].map((m) =>
      Number.parseInt(m[2] ?? "100", 10)
    );
    const smallest = (deviceSizes[0] ?? 0) * Math.min(...percents, 100) * 0.01;
    widths = percents.length
      ? allSizes.filter((s) => s >= smallest)
      : allSizes;
    kind = "w";
  } else if (width === undefined) {
    widths = deviceSizes;
    kind = "w";
  } else {
    widths = [width, width * 2].map(
      (w) => allSizes.find((s) => s >= w) ?? largest
    );
    kind = "x";
  }

  if (maxWidth !== undefined) {
    // The smallest configured size that still covers the intrinsic width
    const cap = allSizes.find((s) => s >= maxWidth) ?? largest;
    const capped =
      kind === "w"
        ? widths.filter((w) => w <= cap)
        : widths.map((w) => Math.min(w, cap));
    widths = capped.length > 0 ? capped : widths.slice(0, 1);
  }
  return { widths: unique(widths), kind };
}

/**
 * Computes everything the Image component renders, without rendering it.
 * Useful for art direction or CSS backgrounds.
 */
export function getImageProps(
  props: ImageProps,
  config: ImageConfig = imageConfig
): ImagePropsResult {
  return buildImageProps(props, config, INITIAL_STATE);
}

/** @internal getImageProps plus the component's load state. */
export function buildImageProps(
  {
    src: srcProp,
    alt,
    width: widthProp,
    height: heightProp,
    fill = false,
    sizes,
    fit,
    priority = false,
    placeholder = "empty",
    blurDataURL,
    unoptimized = false,
    loader: loaderProp,
    params,
    formats: formatsProp,
    loading,
    decoding,
    fetchPriority,
    style,
    ref: _ref,
    ...rest
  }: ImageProps,
  config: ImageConfig,
  state: ImageState
): ImagePropsResult {
  const formats = formatsProp ?? config.formats;
  const loader = loaderProp ?? config.loader;
  const staticData = typeof srcProp === "object" ? srcProp : undefined;
  const src = typeof srcProp === "object" ? srcProp.src : srcProp;

  let width = toNumber(widthProp);
  let height = toNumber(heightProp);
  if (staticData) {
    const ratio = staticData.width / staticData.height;
    if (width === undefined && height === undefined) {
      width = staticData.width;
      height = staticData.height;
    } else if (width === undefined) {
      width = Math.round(height! * ratio);
    } else if (height === undefined) {
      height = Math.round(width / ratio);
    }
  }
  if (fill) {
    width = undefined;
    height = undefined;
  } else if (width === undefined || height === undefined) {
    console.error(
      `Image: "width" and "height" are required unless "fill" or a static image is used. src: ${src}`
    );
  }

  // Aspect ratio for the processor's crop. With fill the container decides
  // the crop through object-fit, so keep the source's own ratio
  const ratio =
    width && height
      ? width / height
      : staticData
        ? staticData.width / staticData.height
        : undefined;

  const optimize = !unoptimized && !config.unoptimized && canOptimize(src);
  let sources: ImageSource[] = [];
  let imgSrc = src;
  let imgSrcSet: string | undefined;
  let imgSizes: string | undefined;
  let preloadHref = src;

  if (optimize) {
    const { widths, kind } = getWidths(
      config,
      width,
      sizes,
      staticData?.width
    );
    imgSizes = kind === "w" ? (sizes ?? "100vw") : undefined;
    const url = (w: number, format?: ImageFormat) =>
      loader(
        {
          src,
          width: w,
          height: ratio ? Math.round(w / ratio) : undefined,
          fit,
          format,
          params,
        },
        config
      );
    const srcSet = (format?: ImageFormat) =>
      widths
        .map((w, i) => `${url(w, format)} ${kind === "w" ? `${w}w` : `${i + 1}x`}`)
        .join(", ");

    sources = formats.map((format) => ({
      type: `image/${format}`,
      srcSet: srcSet(format),
      sizes: imgSizes,
    }));
    imgSrcSet = srcSet();
    const largest = widths[widths.length - 1]!;
    imgSrc = url(largest);
    preloadHref = url(largest, formats[0]);
  }

  const contain = style?.objectFit === "contain" || fit === "contain";
  let placeholderUrl: string | undefined;
  if (placeholder === "blur") {
    const blur = blurDataURL ?? staticData?.blurDataURL;
    if (blur) {
      placeholderUrl = getBlurSvg(blur, ratio, contain);
    } else {
      console.error(
        `Image: placeholder="blur" needs "blurDataURL" or a static image with one. src: ${src}`
      );
    }
  } else if (placeholder.startsWith("data:image/")) {
    placeholderUrl = placeholder;
  }
  const showPlaceholder = placeholderUrl && !state.complete;

  const imgStyle: CSSProperties = {
    // Hides the alt text while loading; shown again if loading fails
    color: state.error ? undefined : "transparent",
    ...(fill && {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
    }),
    ...(showPlaceholder && {
      backgroundImage: `url("${placeholderUrl}")`,
      backgroundSize: contain ? "contain" : "cover",
      backgroundPosition: style?.objectPosition ?? "50% 50%",
      backgroundRepeat: "no-repeat",
    }),
    ...style,
  };

  const img: ImgAttributes = {
    ...rest,
    alt,
    src: imgSrc,
    srcSet: imgSrcSet,
    sizes: imgSizes,
    width,
    height,
    loading: priority ? "eager" : (loading ?? "lazy"),
    fetchPriority: priority ? "high" : fetchPriority,
    decoding: decoding ?? "async",
    style: imgStyle,
  };

  let preload: ImagePropsResult["preload"];
  if (priority) {
    // Preload the first format; browsers skip a preload whose type they
    // can't decode
    const source = sources[0];
    const options: PreloadOptions = {
      as: "image",
      fetchPriority: "high",
      imageSrcSet: source ? source.srcSet : imgSrcSet,
      imageSizes: imgSizes,
      type: source?.type,
      crossOrigin: rest.crossOrigin,
      referrerPolicy: rest.referrerPolicy,
    };
    for (const key of Object.keys(options) as (keyof PreloadOptions)[]) {
      if (options[key] === undefined) delete options[key];
    }
    preload = { href: preloadHref, options };
  }

  return { sources, img, preload };
}
