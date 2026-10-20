export type ImageFormat = "avif" | "webp";
export type ImageFit = "cover" | "contain";

export type ImageConfig = {
  /**
   * Path ("/img") or URL ("https://img.example.com/img") of the image
   * processor endpoint.
   */
  endpoint: string;
  /**
   * Origin that relative `src` values (Vite assets like "/assets/hero-abc.jpg",
   * files in /public) are resolved against before they are sent to the
   * processor. Leave unset when the processor serves relative paths itself.
   * Must be the same on the server and the client, or hydration will mismatch.
   */
  assetOrigin?: string;
  /** Widths used for full-width and `sizes`-based images. */
  deviceSizes: number[];
  /** Extra smaller widths used for images that are a fraction of the viewport. */
  imageSizes: number[];
  /**
   * Modern formats rendered as <source> elements, in order of preference.
   * The <img> fallback always uses the original format.
   */
  formats: ImageFormat[];
  /** Skip the processor for every image, e.g. in development. */
  unoptimized: boolean;
};

/**
 * Edit this when the component moves into the app, for example:
 * `endpoint: import.meta.env.VITE_IMG_ENDPOINT ?? "/img"`.
 */
export const imageConfig: ImageConfig = {
  endpoint: "/img",
  deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  imageSizes: [32, 48, 64, 96, 128, 256, 384],
  // AVIF encodes several times slower than WebP. Add "avif" first if the
  // processor can afford it.
  formats: ["webp"],
  unoptimized: false,
};
