// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { inlineRename } from "./rename";

function startRename(current: string) {
  const parent = document.createElement("div");
  const label = document.createElement("span");
  parent.appendChild(label);
  const onSave = vi.fn();
  const onEnd = vi.fn();
  inlineRename(label, current, onSave, onEnd);
  const input = parent.querySelector("input")!;
  const press = (key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key }));
  return { input, press, onSave, onEnd };
}

test("saving an unchanged name does not override the automatic title", () => {
  const { press, onSave, onEnd } = startRename("✳ Fix login");
  press("Enter");
  expect(onSave).not.toHaveBeenCalled();
  expect(onEnd).toHaveBeenCalled();
});

test("cancelling still reports the end of the rename", () => {
  const { input, press, onSave, onEnd } = startRename("a");
  input.value = "b";
  press("Escape");
  expect(onSave).not.toHaveBeenCalled();
  expect(onEnd).toHaveBeenCalled();
});

test("saving a new name reports it", () => {
  const { input, press, onSave } = startRename("a");
  input.value = "b";
  press("Enter");
  expect(onSave).toHaveBeenCalledWith("b");
});
