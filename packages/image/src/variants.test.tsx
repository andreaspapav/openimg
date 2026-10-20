import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { getImageProps, type ImageVariants } from "./get-image-props";
import { Image } from "./image";
import { variantsFromGlob } from "./variants";

const hero: ImageVariants = {
  // Deliberately out of order: sources are sorted by width
  webp: [
    { width: 1280, src: "/assets/hero-1280-x1.webp" },
    { width: 640, src: "/assets/hero-640-x1.webp" },
  ],
  avif: [
    { width: 640, src: "/assets/hero-640-x1.avif" },
    { width: 1280, src: "/assets/hero-1280-x1.avif" },
  ],
};

describe("variants", () => {
  test("one <source> per modern format, AVIF first, sorted by width", () => {
    const { sources, img } = getImageProps({
      src: "/assets/hero-x1.jpg",
      alt: "",
      width: 1280,
      height: 720,
      sizes: "(min-width: 768px) 50vw, 100vw",
      variants: hero,
    });
    expect(sources).toEqual([
      {
        type: "image/avif",
        srcSet: "/assets/hero-640-x1.avif 640w, /assets/hero-1280-x1.avif 1280w",
        sizes: "(min-width: 768px) 50vw, 100vw",
      },
      {
        type: "image/webp",
        srcSet: "/assets/hero-640-x1.webp 640w, /assets/hero-1280-x1.webp 1280w",
        sizes: "(min-width: 768px) 50vw, 100vw",
      },
    ]);
    // The <img> is the plain fallback; nothing goes through the processor
    expect(img.src).toBe("/assets/hero-x1.jpg");
    expect(img.srcSet).toBeUndefined();
    expect(img.width).toBe(1280);
    expect(img.height).toBe(720);
    expect(JSON.stringify({ sources, img })).not.toContain("/img?");
  });

  test("without sizes, the image fills the screen up to its width", () => {
    const { sources, img } = getImageProps({
      src: "/hero.jpg",
      alt: "",
      width: 1280,
      height: 720,
      variants: hero,
    });
    expect(sources[0]!.sizes).toBe("(max-width: 1280px) 100vw, 1280px");
    expect(img.sizes).toBe("(max-width: 1280px) 100vw, 1280px");
  });

  test("with fill and no sizes, 100vw", () => {
    const { img } = getImageProps({ src: "/hero.jpg", alt: "", fill: true, variants: hero });
    expect(img.sizes).toBe("100vw");
    expect(img.width).toBeUndefined();
  });

  test("a JPEG or PNG list becomes the <img> srcset", () => {
    const jpeg = getImageProps({
      src: "/hero-1280.jpg",
      alt: "",
      width: 1280,
      height: 720,
      variants: {
        ...hero,
        jpeg: [
          { width: 1280, src: "/hero-1280.jpg" },
          { width: 640, src: "/hero-640.jpg" },
        ],
      },
    });
    expect(jpeg.img.srcSet).toBe("/hero-640.jpg 640w, /hero-1280.jpg 1280w");
    expect(jpeg.img.src).toBe("/hero-1280.jpg");

    const png = getImageProps({
      src: "/logo.png",
      alt: "",
      width: 200,
      height: 100,
      variants: { png: [{ width: 200, src: "/logo-200.png" }, { width: 400, src: "/logo-400.png" }] },
    });
    expect(png.sources).toEqual([]);
    expect(png.img.srcSet).toBe("/logo-200.png 200w, /logo-400.png 400w");
    expect(png.img.sizes).toBe("(max-width: 200px) 100vw, 200px");
  });

  test("only the formats you made", () => {
    const { sources } = getImageProps({
      src: "/hero.jpg",
      alt: "",
      width: 1280,
      height: 720,
      variants: { webp: hero.webp },
    });
    expect(sources.map((s) => s.type)).toEqual(["image/webp"]);
  });

  test("empty variants render the plain image", () => {
    const { sources, img } = getImageProps({
      src: "/hero.jpg",
      alt: "",
      width: 1280,
      height: 720,
      variants: { avif: [], webp: [] },
    });
    expect(sources).toEqual([]);
    expect(img.src).toBe("/hero.jpg");
    expect(img.srcSet).toBeUndefined();
    expect(img.sizes).toBeUndefined();
  });

  test("priority preloads the first format's files", () => {
    const { preload, img } = getImageProps({
      src: "/hero.jpg",
      alt: "",
      width: 1280,
      height: 720,
      priority: true,
      variants: hero,
    });
    expect(img.loading).toBe("eager");
    expect(preload).toEqual({
      href: "/assets/hero-1280-x1.avif",
      options: {
        as: "image",
        fetchPriority: "high",
        imageSrcSet: "/assets/hero-640-x1.avif 640w, /assets/hero-1280-x1.avif 1280w",
        imageSizes: "(max-width: 1280px) 100vw, 1280px",
        type: "image/avif",
      },
    });
  });

  test("placeholders work as for other images", () => {
    const { img } = getImageProps({
      src: "/hero.jpg",
      alt: "",
      width: 1280,
      height: 720,
      variants: hero,
      placeholder: "data:image/webp;base64,AAAA",
    });
    expect(img.style?.backgroundImage).toBe('url("data:image/webp;base64,AAAA")');
  });

  test("variants is not passed to the <img> element", () => {
    const { img } = getImageProps({ src: "/hero.jpg", alt: "", width: 1, height: 1, variants: hero });
    expect(img).not.toHaveProperty("variants");
  });

  test("renders a <picture> with your files", () => {
    const { container } = render(
      <Image src="/hero.jpg" alt="Hero" width={1280} height={720} variants={hero} />
    );
    const sources = [...container.querySelectorAll("source")];
    expect(sources.map((s) => s.getAttribute("type"))).toEqual(["image/avif", "image/webp"]);
    expect(sources[0]!.getAttribute("srcset")).toBe(
      "/assets/hero-640-x1.avif 640w, /assets/hero-1280-x1.avif 1280w"
    );
    expect(screen.getByAltText("Hero")).toHaveAttribute("src", "/hero.jpg");
  });
});

describe("variantsFromGlob", () => {
  test("groups files by format and sorts them by width", () => {
    expect(
      variantsFromGlob({
        "/app/assets/hero-1280.webp": "/assets/hero-1280-a1.webp",
        "/app/assets/hero-640.webp": "/assets/hero-640-b2.webp",
        "/app/assets/hero-640.avif": "/assets/hero-640-c3.avif",
        "/app/assets/hero-640w.jpg": "/assets/hero-640w-d4.jpg",
        "/app/assets/hero-1280.JPEG?url": "/assets/hero-1280-e5.jpeg",
      })
    ).toEqual({
      webp: [
        { width: 640, src: "/assets/hero-640-b2.webp" },
        { width: 1280, src: "/assets/hero-1280-a1.webp" },
      ],
      avif: [{ width: 640, src: "/assets/hero-640-c3.avif" }],
      jpeg: [
        { width: 640, src: "/assets/hero-640w-d4.jpg" },
        { width: 1280, src: "/assets/hero-1280-e5.jpeg" },
      ],
    });
  });

  test("ignores files without a width in the name", () => {
    expect(
      variantsFromGlob({
        "/app/assets/hero.jpg": "/assets/hero.jpg",
        "/app/assets/hero-large.webp": "/assets/hero-large.webp",
        "/app/assets/logo.svg": "/assets/logo.svg",
      })
    ).toEqual({});
  });
});
