import { expect, test } from "vitest";
import { dragWidth } from "./resizer";

test("width follows the drag distance", () => {
  expect(dragWidth(200, 50, 120, 600)).toBe(250);
});

test("width stops at the maximum", () => {
  expect(dragWidth(200, 900, 120, 600)).toBe(600);
});

test("dragging cannot collapse below the minimum", () => {
  expect(dragWidth(200, -500, 120, 600)).toBe(120);
});
