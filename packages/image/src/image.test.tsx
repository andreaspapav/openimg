import { afterEach, describe, expect, test, vi } from "vitest";
import { act, createRef, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Image } from "./image";

const BLUR = "data:image/png;base64,BLUR";

let consoleError = vi.spyOn(console, "error");
afterEach(() => {
  consoleError.mockClear();
});

/** Makes every <img> report `complete`, like one that loaded before hydration. */
function stubComplete(naturalWidth: number) {
  const proto = HTMLImageElement.prototype;
  const complete = Object.getOwnPropertyDescriptor(proto, "complete")!;
  const width = Object.getOwnPropertyDescriptor(proto, "naturalWidth")!;
  Object.defineProperty(proto, "complete", { configurable: true, get: () => true });
  Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => naturalWidth });
  return () => {
    Object.defineProperty(proto, "complete", complete);
    Object.defineProperty(proto, "naturalWidth", width);
  };
}

describe("Image", () => {
  test("renders a picture with a webp source and an img fallback", () => {
    const { container } = render(
      <Image src="/cat.jpg" alt="A cat" width={300} height={150} />
    );
    const picture = container.firstElementChild!;
    expect(picture.tagName).toBe("PICTURE");

    const source = picture.querySelector("source")!;
    expect(source).toHaveAttribute("type", "image/webp");
    expect(source.getAttribute("srcset")).toBe(
      "/img?src=%2Fcat.jpg&w=384&h=192&format=webp 1x, /img?src=%2Fcat.jpg&w=640&h=320&format=webp 2x"
    );

    const img = screen.getByAltText("A cat");
    expect(img.parentElement).toBe(picture as HTMLElement);
    expect(img).toHaveAttribute("src", "/img?src=%2Fcat.jpg&w=640&h=320");
    expect(img).toHaveAttribute("width", "300");
    expect(img).toHaveAttribute("height", "150");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img).not.toHaveAttribute("fetchpriority");
    expect(img).not.toHaveAttribute("sizes");
  });

  test("unoptimized images render a bare img", () => {
    const { container } = render(
      <Image src="/logo.svg" alt="Logo" width={120} height={40} />
    );
    const img = container.firstElementChild!;
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "/logo.svg");
    expect(img).not.toHaveAttribute("srcset");
  });

  test("accepts a static image object", () => {
    render(
      <Image
        src={{ src: "/assets/hero-abc.jpg", width: 1000, height: 500 }}
        alt="Hero"
      />
    );
    const img = screen.getByAltText("Hero");
    expect(img).toHaveAttribute("width", "1000");
    expect(img).toHaveAttribute("height", "500");
    expect(img).toHaveAttribute("src", "/img?src=%2Fassets%2Fhero-abc.jpg&w=1080&h=540");
  });

  test("an empty alt marks the image decorative", () => {
    const { container } = render(<Image src="/cat.jpg" alt="" width={1} height={1} />);
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("passes attributes through to the img", () => {
    render(
      <Image
        src="/cat.jpg"
        alt="Cat"
        width={100}
        height={100}
        className="rounded"
        data-testid="cat"
        style={{ borderRadius: 4 }}
      />
    );
    const img = screen.getByTestId("cat");
    expect(img).toHaveClass("rounded");
    expect(img.style.borderRadius).toBe("4px");
    expect(img.style.color).toBe("transparent");
  });

  test("fill positions the img absolutely and sets sizes", () => {
    render(<Image src="/cat.jpg" alt="Cat" fill sizes="50vw" />);
    const img = screen.getByAltText("Cat");
    expect(img).not.toHaveAttribute("width");
    expect(img).toHaveAttribute("sizes", "50vw");
    expect(img.style.position).toBe("absolute");
    expect(img.style.width).toBe("100%");
    expect(img.parentElement!.querySelector("source")).toHaveAttribute("sizes", "50vw");
  });

  test("forwards object refs", () => {
    const ref = createRef<HTMLImageElement>();
    const { unmount } = render(
      <Image ref={ref} src="/cat.jpg" alt="Cat" width={100} height={100} />
    );
    expect(ref.current).toBe(screen.getByAltText("Cat") as HTMLImageElement);
    unmount();
    expect(ref.current).toBeNull();
  });

  test("forwards callback refs", () => {
    const nodes: (HTMLImageElement | null)[] = [];
    const { unmount } = render(
      <Image ref={(node) => { nodes.push(node); }} src="/cat.jpg" alt="Cat" width={100} height={100} />
    );
    unmount();
    expect(nodes[0]).toBeInstanceOf(HTMLImageElement);
    expect(nodes.at(-1)).toBeNull();
  });

  describe("placeholder", () => {
    test("shows until the image loads, then calls onLoad", () => {
      let loaded = 0;
      render(
        <Image
          src="/cat.jpg"
          alt="Cat"
          width={100}
          height={100}
          placeholder={BLUR}
          onLoad={() => loaded++}
        />
      );
      const img = screen.getByAltText("Cat");
      expect(img.style.backgroundImage).toContain("BLUR");

      fireEvent.load(img);
      expect(img.style.backgroundImage).toBe("");
      expect(img.style.color).toBe("transparent");
      expect(loaded).toBe(1);
    });

    test("an error removes it, shows the alt text and calls onError", () => {
      let errors = 0;
      render(
        <Image
          src="/missing.jpg"
          alt="Missing"
          width={100}
          height={100}
          placeholder={BLUR}
          onError={() => errors++}
        />
      );
      const img = screen.getByAltText("Missing");
      fireEvent.error(img);
      expect(img.style.backgroundImage).toBe("");
      expect(img.style.color).toBe("");
      expect(errors).toBe(1);
    });

    test("comes back when src changes", () => {
      function Gallery() {
        const [src, setSrc] = useState("/a.jpg");
        return (
          <>
            <Image src={src} alt="Photo" width={100} height={100} placeholder={BLUR} />
            <button onClick={() => setSrc("/b.jpg")}>next</button>
          </>
        );
      }
      render(<Gallery />);
      const img = screen.getByAltText("Photo");
      fireEvent.load(img);
      expect(img.style.backgroundImage).toBe("");

      fireEvent.click(screen.getByText("next"));
      expect(img.style.backgroundImage).toContain("BLUR");
    });

    test("is cleared on mount if the image already loaded", () => {
      const restore = stubComplete(100);
      try {
        render(
          <Image src="/cat.jpg" alt="Cat" width={100} height={100} placeholder={BLUR} />
        );
        expect(screen.getByAltText("Cat").style.backgroundImage).toBe("");
      } finally {
        restore();
      }
    });

    test("shows the alt text on mount if the image already failed", () => {
      const restore = stubComplete(0);
      try {
        render(<Image src="/cat.jpg" alt="Cat" width={100} height={100} />);
        expect(screen.getByAltText("Cat").style.color).toBe("");
      } finally {
        restore();
      }
    });
  });

  describe("priority", () => {
    test("loads eagerly with high priority", () => {
      render(<Image src="/cat.jpg" alt="Cat" width={100} height={100} priority />);
      const img = screen.getByAltText("Cat");
      expect(img).toHaveAttribute("loading", "eager");
      expect(img).toHaveAttribute("fetchpriority", "high");
    });

    test("adds a preload link to the head", () => {
      render(
        <Image src="/cat.jpg" alt="Cat" width={800} height={400} sizes="100vw" priority />
      );
      const link = document.head.querySelector('link[rel="preload"][as="image"]')!;
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("type", "image/webp");
      expect(link).toHaveAttribute("imagesizes", "100vw");
      expect(link.getAttribute("imagesrcset")).toContain("format=webp");
      expect(link).toHaveAttribute("fetchpriority", "high");
    });

    test("does not preload without priority", () => {
      render(<Image src="/cat.jpg" alt="Cat" width={100} height={100} />);
      expect(document.head.querySelector('link[rel="preload"]')).toBeNull();
    });
  });

  describe("server rendering", () => {
    test("renders the picture and the preload link", () => {
      const html = renderToString(
        <Image src="/cat.jpg" alt="Cat" width={100} height={100} priority placeholder={BLUR} />
      );
      expect(html).toContain('<link rel="preload" as="image"');
      expect(html).toContain("<picture>");
      expect(html).toContain('type="image/webp"');
      expect(html).toContain("background-image");
    });

    test("renders the blur SVG into the HTML", () => {
      // Checked on the server output: happy-dom's CSS parser drops url()
      // values containing spaces, which browsers accept
      const html = renderToString(
        <Image src="/cat.jpg" alt="Cat" width={100} height={100} placeholder="blur" blurDataURL={BLUR} />
      );
      expect(html).toContain("background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg");
      expect(html).toContain(`href=&#x27;${BLUR}&#x27;`);
    });

    test("hydrates without mismatches", async () => {
      const element = (
        <Image src="/cat.jpg" alt="Cat" fill sizes="50vw" placeholder={BLUR} />
      );
      const container = document.createElement("div");
      container.innerHTML = renderToString(element);
      document.body.append(container);

      const recoverable: unknown[] = [];
      let root: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(container, element, {
          onRecoverableError: (error) => recoverable.push(error),
        });
      });
      expect(recoverable).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();

      act(() => root.unmount());
      container.remove();
    });
  });
});
