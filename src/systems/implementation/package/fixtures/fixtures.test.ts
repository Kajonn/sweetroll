import { describe, expect, it } from "vitest";

import { countNodes } from "../../rules/parser.js";
import { decodeSystemDocument, decodeSystemExport, decodeSystemPackage } from "../index.js";
import { d20Document, d20Export, d20Package } from "./d20.js";
import { d6SuccessPoolDocument, d6SuccessPoolPackage } from "./d6-success-pool.js";
import { pbta2d6Document, pbta2d6Package } from "./pbta-2d6.js";

const pkgs = [d20Package, pbta2d6Package, d6SuccessPoolPackage];

describe("reference system contracts", () => {
  it.each([
    ["d20", d20Document, d20Package],
    ["2d6", pbta2d6Document, pbta2d6Package],
    ["d6 success pool", d6SuccessPoolDocument, d6SuccessPoolPackage],
  ])("decodes the %s source and compiled fixture", (_name, document, packageValue) => {
    expect(decodeSystemDocument(document).ok).toBe(true);
    expect(decodeSystemPackage(packageValue).ok).toBe(true);
  });

  it("round-trips the portable d20 export", () => {
    expect(decodeSystemExport(JSON.stringify(d20Export))).toEqual({ ok: true, value: d20Export });
    expect(JSON.stringify(d20Export)).not.toMatch(/ownerId|actorId|email|token|audit/i);
  });

  it("records cost equal to AST node count for every expression", () => {
    for (const pkg of pkgs) {
      for (const expr of pkg.expressions) {
        expect(expr.cost, `cost of ${expr.id}`).toBe(countNodes(expr.ast));
      }
    }
  });
});
