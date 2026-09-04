import { describe, expect, it } from "vitest";

import { calculatePackageChecksum } from "./canonical.js";
import { d20Package } from "./fixtures/index.js";
import type { SystemPackageV1 } from "./schema/index.js";
import { comparePackages } from "./compatibility.js";

function resign(pkg: SystemPackageV1): SystemPackageV1 {
  return { ...pkg, integrity: { checksum: calculatePackageChecksum(pkg) } };
}

describe("comparePackages", () => {
  it("returns compatible when prev and next are identical", () => {
    const prev = d20Package;
    const next = d20Package;
    const report = comparePackages(prev, next);
    expect(report.compatible).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("flags breaking_type_change when a field kind changes", () => {
    const prev = d20Package;
    const mutated = structuredClone(prev);
    const idx = mutated.entities[0]!.fields.findIndex((f) => f.id === "ability");
    const field = mutated.entities[0]!.fields[idx] as { kind: string; default: unknown };
    mutated.entities[0]!.fields[idx] = { ...field, kind: "text", default: "10" } as never;
    const next = resign(mutated);
    const report = comparePackages(prev, next);
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "breaking_type_change",
        path: "/entities/character/fields/ability",
      }),
    );
  });

  it("flags breaking_removed_definition when a field is removed", () => {
    const prev = d20Package;
    const mutated = structuredClone(prev);
    mutated.entities[0]!.fields = mutated.entities[0]!.fields.filter((f) => f.id !== "ability");
    const next = resign(mutated);
    const report = comparePackages(prev, next);
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "breaking_removed_definition", path: "/entities/character/fields/ability" }),
    );
  });

  it("flags breaking_required_added when an optional field becomes required", () => {
    const prev = d20Package;
    const mutated = structuredClone(prev);
    const idx = mutated.entities[0]!.fields.findIndex((f) => f.id === "ancestry");
    (mutated.entities[0]!.fields[idx] as { required: boolean }).required = true;
    const next = resign(mutated);
    const report = comparePackages(prev, next);
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "breaking_required_added", path: "/entities/character/fields/ancestry" }),
    );
  });

  it("does not flag additions as breaking", () => {
    const prev = d20Package;
    const mutated = structuredClone(prev);
    mutated.entities[0]!.fields.push({
      kind: "text",
      id: "notes",
      label: "Notes",
      required: false,
      default: "",
      maxLength: 200,
    } as never);
    const next = resign(mutated);
    const report = comparePackages(prev, next);
    expect(report.compatible).toBe(true);
  });

  it("flags breaking_action_removed when an action disappears", () => {
    const prev = d20Package;
    const mutated = structuredClone(prev);
    mutated.actions = mutated.actions.filter((a) => a.id !== "check");
    const next = resign(mutated);
    const report = comparePackages(prev, next);
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "breaking_action_removed", path: "/actions/check" }),
    );
  });

  it("flags breaking_expression_result_type_change when resultType changes", () => {
    const prev = d20Package;
    const mutated = structuredClone(prev);
    const idx = mutated.expressions.findIndex((e) => e.id === "defense_expr");
    (mutated.expressions[idx] as { resultType: string }).resultType = "text";
    const next = resign(mutated);
    const report = comparePackages(prev, next);
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "breaking_expression_result_type_change", path: "/expressions/defense_expr" }),
    );
  });

  it("returns findings sorted by path then code", () => {
    const prev = d20Package;
    const mutated = structuredClone(prev);
    mutated.actions = mutated.actions.filter((a) => a.id !== "check");
    mutated.entities[0]!.fields = mutated.entities[0]!.fields.filter((f) => f.id !== "ability");
    const next = resign(mutated);
    const report = comparePackages(prev, next);
    const sorted = [...report.findings].sort(
      (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code),
    );
    expect(report.findings).toEqual(sorted);
  });
});
