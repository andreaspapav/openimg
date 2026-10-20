import { afterEach, expect } from "bun:test";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

const { default: _default, ...jestDomMatchers } = matchers;
expect.extend(jestDomMatchers);

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
});
