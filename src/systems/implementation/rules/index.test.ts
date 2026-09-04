import { expect, it } from "vitest";
import { compileExpression, evaluate, renderExpression } from "./index.js";

it("exports the public engine functions", () => {
  expect(typeof compileExpression).toBe("function");
  expect(typeof evaluate).toBe("function");
  expect(typeof renderExpression).toBe("function");
});
