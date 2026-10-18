import { expect, test } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import { userAgent } from "../src/index.ts";

test("user agent carries the package version", () => {
  expect(userAgent).toBe(`rabbix-sdk-typescript/${pkg.version}`);
});
