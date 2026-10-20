import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // React's preload() adds <link>s to the head; start each test without them
  document.head.innerHTML = "";
});
