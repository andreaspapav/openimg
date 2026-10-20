import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { imageConfig, type ImageConfig } from "./config";
import { getBlurSvg, getImageProps, getWidths } from "./get-image-props";
import { defaultLoader, type ImageLoader } from "./loader";

// 16×21 WebP of tests/bun/public/cat.png: sharp(...).resize(16).webp({ quality: 40 })
const WEBP_16 =
  "data:image/webp;base64,UklGRmgAAABXRUJQVlA4IFwAAACwAwCdASoQABUAPu1iqU2ppaOiMAgBMB2JQBWAApfiKo+0CwniAACfdTwgcsxYUofXbYeqUj2CUoMFJbyc4GM4JY96Lw74lo3+zqVvPQ3ve03o4mGOx6Dso3AAAA==";

/** Unwraps `url("data:image/svg+xml…")` and parses the SVG */
function parseBlurSvg(backgroundImage: unknown) {
  const match = /^url\("data:image\/svg\+xml;charset=utf-8,(.*)"\)$/.exec(
    String(backgroundImage)
  );
  expect(match).not.toBeNull();
  const doc = new DOMParser().parseFromString(
    decodeURIComponent(match![1]!),
    "image/svg+xml"
  );
  return doc.documentElement;
}

const config: ImageConfig = { ...imageConfig, formats: ["avif", "webp"] };

/** Parses "url 1x, url 2x" into [{ params, descriptor }] */
function parseSrcSet(srcSet: string | undefined) {
  return (srcSet ?? "").split(", ").map((candidate) => {
    const [url, descriptor] = candidate.split(" ");
    return {
      params: Object.fromEntries(new URL(url!, "http://x").searchParams),
      descriptor,
    };
  });
}

function params(url: string) {
  return Object.fromEntries(new URL(url, "http://x").searchParams);
}

let consoleError = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => {
  consoleError.mockClear();
});

describe("defaultLoader", () => {
  test("builds the processor URL", () => {
    expect(
      defaultLoader(
        {
          src: "https://cdn.example.com/a b.jpg",
          width: 640,
          height: 320,
          fit: "contain",
          format: "webp",
        },
        imageConfig
      )
    ).toBe(
      "/img?src=https%3A%2F%2Fcdn.example.com%2Fa+b.jpg&w=640&h=320&fit=contain&format=webp"
    );
  });

  test("omits unset height, fit and format", () => {
    expect(defaultLoader({ src: "/a.jpg", width: 640 }, imageConfig)).toBe(
      "/img?src=%2Fa.jpg&w=640"
    );
  });

  test("resolves relative src against assetOrigin", () => {
    const withOrigin = { ...imageConfig, assetOrigin: "https://app.example.com" };
    expect(
      params(defaultLoader({ src: "/assets/hero-abc.jpg", width: 640 }, withOrigin))
        .src
    ).toBe("https://app.example.com/assets/hero-abc.jpg");
  });

  test("leaves absolute and protocol-relative src alone", () => {
    const withOrigin = { ...imageConfig, assetOrigin: "https://app.example.com" };
    for (const src of ["https://cdn.example.com/a.jpg", "//cdn.example.com/a.jpg"]) {
      expect(params(defaultLoader({ src, width: 640 }, withOrigin)).src).toBe(src);
    }
  });

  test("uses a full endpoint URL", () => {
    const remote = { ...imageConfig, endpoint: "https://img.example.com/img" };
    expect(defaultLoader({ src: "/a.jpg", width: 64 }, remote)).toBe(
      "https://img.example.com/img?src=%2Fa.jpg&w=64"
    );
  });
});

describe("getWidths", () => {
  test("fixed width: 1x and 2x rounded up to configured sizes", () => {
    expect(getWidths(config, 300, undefined)).toEqual({
      widths: [384, 640],
      kind: "x",
    });
  });

  test("fixed width larger than every size uses the largest", () => {
    expect(getWidths(config, 3000, undefined)).toEqual({
      widths: [3840],
      kind: "x",
    });
  });

  test("no width and no sizes: device sizes", () => {
    expect(getWidths(config, undefined, undefined)).toEqual({
      widths: config.deviceSizes,
      kind: "w",
    });
  });

  test("vw sizes drop widths below the smallest needed", () => {
    // 640 * 0.5 = 320, so 32–256 are never needed
    const { widths, kind } = getWidths(config, 800, "(min-width: 768px) 50vw, 100vw");
    expect(kind).toBe("w");
    expect(widths).toEqual([384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
  });

  test("sizes without vw keep every size", () => {
    const { widths } = getWidths(config, undefined, "(min-width: 768px) 400px, 200px");
    expect(widths[0]).toBe(32);
    expect(widths).toHaveLength(15);
  });

  test("intrinsic width caps width descriptors at the next configured size", () => {
    // 1080 is the smallest size covering 1000; larger ones would only upscale
    expect(getWidths(config, undefined, undefined, 1000).widths).toEqual([
      640, 750, 828, 1080,
    ]);
    expect(getWidths(config, undefined, undefined, 1080).widths).toEqual([
      640, 750, 828, 1080,
    ]);
  });

  test("intrinsic width caps density descriptors and dedupes", () => {
    expect(getWidths(config, 300, undefined, 500).widths).toEqual([384, 640]);
    expect(getWidths(config, 300, undefined, 200).widths).toEqual([256]);
  });

  test("intrinsic width below every candidate keeps the smallest one", () => {
    // 50vw drops sizes below 320, so 256 (covering 200) isn't a candidate
    expect(getWidths(config, undefined, "50vw", 200).widths).toEqual([384]);
  });

  test("capped widths are always configured sizes", () => {
    const allowed = new Set([...config.imageSizes, ...config.deviceSizes]);
    for (const maxWidth of [1, 33, 500, 1000, 1999, 5000]) {
      for (const [width, sizes] of [[undefined, undefined], [300, undefined], [800, "50vw"]] as const) {
        for (const w of getWidths(config, width, sizes, maxWidth).widths) {
          expect(allowed.has(w)).toBe(true);
        }
      }
    }
  });

  test("unsorted config sizes are sorted", () => {
    const unsorted = { ...config, deviceSizes: [1200, 640], imageSizes: [64, 32] };
    expect(getWidths(unsorted, undefined, undefined).widths).toEqual([640, 1200]);
  });
});

describe("getImageProps", () => {
  test("fixed size: one source per format plus an img fallback", () => {
    const { sources, img } = getImageProps(
      { src: "/cat.jpg", alt: "Cat", width: 300, height: 150 },
      config
    );

    expect(sources.map((s) => s.type)).toEqual(["image/avif", "image/webp"]);
    expect(parseSrcSet(sources[0]!.srcSet)).toEqual([
      { params: { src: "/cat.jpg", w: "384", h: "192", format: "avif" }, descriptor: "1x" },
      { params: { src: "/cat.jpg", w: "640", h: "320", format: "avif" }, descriptor: "2x" },
    ]);
    expect(sources[0]!.sizes).toBeUndefined();

    // The fallback keeps the original format
    expect(parseSrcSet(img.srcSet).map((c) => c.params.format)).toEqual([
      undefined,
      undefined,
    ]);
    expect(params(img.src)).toEqual({ src: "/cat.jpg", w: "640", h: "320" });
    expect(img.width).toBe(300);
    expect(img.height).toBe(150);
    expect(img.sizes).toBeUndefined();
  });

  test("sizes switch to width descriptors", () => {
    const { sources, img } = getImageProps(
      { src: "/cat.jpg", alt: "", width: 800, height: 400, sizes: "50vw" },
      config
    );
    const candidates = parseSrcSet(sources[1]!.srcSet);
    expect(candidates[0]).toEqual({
      params: { src: "/cat.jpg", w: "384", h: "192", format: "webp" },
      descriptor: "384w",
    });
    expect(candidates.at(-1)!.descriptor).toBe("3840w");
    expect(sources[1]!.sizes).toBe("50vw");
    expect(img.sizes).toBe("50vw");
  });

  test("numeric strings work as dimensions", () => {
    const { img } = getImageProps(
      { src: "/cat.jpg", alt: "", width: "300", height: "150" },
      config
    );
    expect(img.width).toBe(300);
    expect(params(img.src).h).toBe("320");
  });

  test("fit is passed to the processor", () => {
    const { img } = getImageProps(
      { src: "/cat.jpg", alt: "", width: 300, height: 300, fit: "contain" },
      config
    );
    expect(params(img.src).fit).toBe("contain");
  });

  test("fill: no dimensions, absolute positioning, 100vw by default", () => {
    const { img, sources } = getImageProps(
      { src: "https://cdn.example.com/cat.jpg", alt: "", fill: true },
      config
    );
    expect(img.width).toBeUndefined();
    expect(img.height).toBeUndefined();
    expect(img.sizes).toBe("100vw");
    expect(sources[0]!.sizes).toBe("100vw");
    expect(img.style).toMatchObject({
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
    });
    // Unknown ratio: width only
    expect(params(img.src)).toEqual({ src: "https://cdn.example.com/cat.jpg", w: "3840" });
  });

  test("fill ignores width and height props", () => {
    const { img } = getImageProps(
      { src: "/cat.jpg", alt: "", fill: true, width: 100, height: 100 },
      config
    );
    expect(img.width).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("static image: dimensions come from the data and cap the srcset", () => {
    const hero = { src: "/assets/hero-abc.jpg", width: 1000, height: 500 };
    const { img } = getImageProps({ src: hero, alt: "" }, config);
    expect(img.width).toBe(1000);
    expect(img.height).toBe(500);
    // 1x → 1080 and 2x → 2048 are both capped to 1080, the first size ≥ 1000
    expect(parseSrcSet(img.srcSet)).toEqual([
      { params: { src: "/assets/hero-abc.jpg", w: "1080", h: "540" }, descriptor: "1x" },
    ]);
  });

  test("static image: a single dimension derives the other", () => {
    const hero = { src: "/hero.jpg", width: 1000, height: 500 };
    expect(getImageProps({ src: hero, alt: "", width: 400 }, config).img.height).toBe(200);
    expect(getImageProps({ src: hero, alt: "", height: 100 }, config).img.width).toBe(200);
  });

  test("static image with fill keeps the source ratio", () => {
    const hero = { src: "/hero.jpg", width: 1000, height: 500 };
    const { img } = getImageProps({ src: hero, alt: "", fill: true }, config);
    expect(params(img.src)).toEqual({ src: "/hero.jpg", w: "1080", h: "540" });
  });

  test("missing dimensions log an error but still render", () => {
    const { img } = getImageProps({ src: "/cat.jpg", alt: "" }, config);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(img.sizes).toBe("100vw");
    expect(img.srcSet).toBeDefined();
  });

  test.each([
    ["unoptimized prop", { unoptimized: true }, "/cat.jpg"],
    ["svg", {}, "/logo.svg"],
    ["svg with query", {}, "/logo.SVG?v=2"],
    ["gif", {}, "https://cdn.example.com/anim.gif"],
    ["data URL", {}, "data:image/png;base64,AAAA"],
    ["blob URL", {}, "blob:https://app.example.com/123"],
  ])("%s: renders the original src", (_name, extra, src) => {
    const { sources, img } = getImageProps(
      { src, alt: "", width: 100, height: 100, ...extra },
      config
    );
    expect(sources).toEqual([]);
    expect(img.src).toBe(src);
    expect(img.srcSet).toBeUndefined();
    expect(img.sizes).toBeUndefined();
  });

  test("config.unoptimized skips the processor everywhere", () => {
    const { sources, img } = getImageProps(
      { src: "/cat.jpg", alt: "", width: 100, height: 100 },
      { ...config, unoptimized: true }
    );
    expect(sources).toEqual([]);
    expect(img.src).toBe("/cat.jpg");
  });

  test("formats prop overrides the config", () => {
    const { sources } = getImageProps(
      { src: "/cat.jpg", alt: "", width: 100, height: 100, formats: ["webp"] },
      config
    );
    expect(sources.map((s) => s.type)).toEqual(["image/webp"]);
  });

  test("custom loader builds every URL", () => {
    const loader: ImageLoader = ({ src, width, format }) =>
      `https://cdn.example.com${src}?width=${width}${format ? `&fm=${format}` : ""}`;
    const { sources, img } = getImageProps(
      { src: "/cat.jpg", alt: "", width: 100, height: 100, loader },
      config
    );
    expect(img.src).toBe("https://cdn.example.com/cat.jpg?width=256");
    expect(sources[0]!.srcSet).toBe(
      "https://cdn.example.com/cat.jpg?width=128&fm=avif 1x, https://cdn.example.com/cat.jpg?width=256&fm=avif 2x"
    );
  });

  test("defaults: lazy, async decoding, no fetch priority, no preload", () => {
    const { img, preload } = getImageProps(
      { src: "/cat.jpg", alt: "", width: 100, height: 100 },
      config
    );
    expect(img.loading).toBe("lazy");
    expect(img.decoding).toBe("async");
    expect(img.fetchPriority).toBeUndefined();
    expect(preload).toBeUndefined();
  });

  test("loading, decoding and fetchPriority props are respected", () => {
    const { img } = getImageProps(
      {
        src: "/cat.jpg",
        alt: "",
        width: 100,
        height: 100,
        loading: "eager",
        decoding: "sync",
        fetchPriority: "low",
      },
      config
    );
    expect(img.loading).toBe("eager");
    expect(img.decoding).toBe("sync");
    expect(img.fetchPriority).toBe("low");
  });

  test("priority: eager, high priority, preloads the first format", () => {
    const { img, preload, sources } = getImageProps(
      {
        src: "/cat.jpg",
        alt: "",
        width: 800,
        height: 400,
        sizes: "100vw",
        priority: true,
        loading: "lazy",
        crossOrigin: "anonymous",
      },
      config
    );
    expect(img.loading).toBe("eager");
    expect(img.fetchPriority).toBe("high");
    expect(params(preload!.href).format).toBe("avif");
    expect(preload!.options).toEqual({
      as: "image",
      fetchPriority: "high",
      imageSrcSet: sources[0]!.srcSet,
      imageSizes: "100vw",
      type: "image/avif",
      crossOrigin: "anonymous",
    });
  });

  test("priority on an unoptimized image preloads the original", () => {
    const { preload } = getImageProps(
      { src: "/logo.svg", alt: "", width: 100, height: 100, priority: true },
      config
    );
    expect(preload).toEqual({
      href: "/logo.svg",
      options: { as: "image", fetchPriority: "high" },
    });
  });

  test("blur placeholder wraps blurDataURL in a blurred SVG", () => {
    const { img } = getImageProps(
      {
        src: "/cat.jpg",
        alt: "",
        width: 300,
        height: 150,
        placeholder: "blur",
        blurDataURL: WEBP_16,
      },
      config
    );
    expect(img.style).toMatchObject({
      backgroundSize: "cover",
      backgroundPosition: "50% 50%",
      backgroundRepeat: "no-repeat",
    });

    const svg = parseBlurSvg(img.style?.backgroundImage);
    expect(svg.getAttribute("viewBox")).toBe("0 0 320 160");
    expect(svg.querySelectorAll("feGaussianBlur")).toHaveLength(2);
    const image = svg.querySelector("image")!;
    expect(image.getAttribute("href")).toBe(WEBP_16);
    expect(image.getAttribute("preserveAspectRatio")).toBe("xMidYMid slice");
    expect(image.getAttribute("style")).toBe("filter: url(#b);");
  });

  test("blur SVG escapes only what a data URL needs", () => {
    const url = getBlurSvg(WEBP_16, 1, false);
    expect(url).toStartWith("data:image/svg+xml;charset=utf-8,%3Csvg ");
    expect(url).not.toMatch(/[<>#]/);
    // base64 is left as-is, so the placeholder stays small
    expect(url).toInclude(WEBP_16);
    expect(url.length).toBeLessThan(WEBP_16.length + 700);
  });

  test("blur with contain letterboxes instead of cropping", () => {
    for (const extra of [{ fit: "contain" as const }, { style: { objectFit: "contain" as const } }]) {
      const { img } = getImageProps(
        { src: "/cat.jpg", alt: "", width: 300, height: 150, placeholder: "blur", blurDataURL: WEBP_16, ...extra },
        config
      );
      expect(img.style?.backgroundSize).toBe("contain");
      const image = parseBlurSvg(img.style?.backgroundImage).querySelector("image")!;
      expect(image.getAttribute("preserveAspectRatio")).toBe("xMidYMid");
    }
  });

  test("blur with fill and unknown ratio has no viewBox", () => {
    const { img } = getImageProps(
      { src: "/cat.jpg", alt: "", fill: true, placeholder: "blur", blurDataURL: WEBP_16 },
      config
    );
    expect(parseBlurSvg(img.style?.backgroundImage).hasAttribute("viewBox")).toBe(false);
  });

  test("blur placeholder falls back to the static image's blurDataURL", () => {
    const hero = { src: "/hero.jpg", width: 160, height: 210, blurDataURL: WEBP_16 };
    const { img } = getImageProps({ src: hero, alt: "", placeholder: "blur" }, config);
    const svg = parseBlurSvg(img.style?.backgroundImage);
    expect(svg.getAttribute("viewBox")).toBe("0 0 320 420");
    expect(svg.querySelector("image")!.getAttribute("href")).toBe(WEBP_16);
  });

  test("a data URL placeholder is shown as-is", () => {
    const { img } = getImageProps(
      {
        src: "/cat.jpg",
        alt: "",
        width: 100,
        height: 100,
        placeholder: WEBP_16,
      },
      config
    );
    // Not wrapped in the blur SVG
    expect(img.style?.backgroundImage).toBe(`url("${WEBP_16}")`);
    expect(img.style?.backgroundSize).toBe("cover");
  });

  test("blur without data logs an error and renders no placeholder", () => {
    const { img } = getImageProps(
      { src: "/cat.jpg", alt: "", width: 100, height: 100, placeholder: "blur" },
      config
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(img.style?.backgroundImage).toBeUndefined();
  });

  test("hides alt text while loading; user style wins", () => {
    const { img } = getImageProps(
      {
        src: "/cat.jpg",
        alt: "",
        width: 100,
        height: 100,
        style: { borderRadius: 8, color: "red" },
      },
      config
    );
    expect(img.style).toEqual({ color: "red", borderRadius: 8 });
    expect(
      getImageProps({ src: "/cat.jpg", alt: "", width: 100, height: 100 }, config).img
        .style?.color
    ).toBe("transparent");
  });

  test("passes other img attributes through and drops component props", () => {
    const { img } = getImageProps(
      {
        src: "/cat.jpg",
        alt: "Cat",
        width: 100,
        height: 100,
        className: "rounded",
        id: "cat",
        "aria-describedby": "caption",
        priority: false,
        unoptimized: false,
      },
      config
    );
    expect(img).toMatchObject({ alt: "Cat", className: "rounded", id: "cat", "aria-describedby": "caption" });
    for (const key of ["priority", "unoptimized", "fill", "fit", "loader", "formats", "placeholder", "blurDataURL"]) {
      expect(img).not.toHaveProperty(key);
    }
  });
});
