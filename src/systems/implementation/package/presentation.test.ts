import { describe, expect, it } from "vitest";
import { decodeSystemDocument, decodeSystemPackage } from "./codec.js";
import { d20Document } from "./fixtures/index.js";
import { compileDocument } from "../rules/compile-document.js";
import { documentFromPackage } from "../authoring/assess.js";
import { createSystemRuntime } from "../../runtime.js";
import { createFixturePublishedPackageLoader } from "../runtime/package-loader.js";

const validDocument = () => structuredClone(d20Document);
const identity = { systemId: "00000000-0000-4000-8000-000000000001", versionId: "00000000-0000-4000-8000-000000000002", semanticVersion: "1.0.0" };

describe("system color presentation", () => {
  it.each(["default", "blue", "ochre"])("preserves %s through decode, publication, clone and runtime", async colorPreset => {
    const document = validDocument();
    Object.assign(document.metadata, { presentation: { colorPreset } });
    const decoded = decodeSystemDocument(document);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const compiled = compileDocument(decoded.value, identity);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value).toHaveProperty("presentation", { colorPreset });
    expect(decodeSystemPackage(compiled.value).ok).toBe(true);
    expect(documentFromPackage(compiled.value).metadata).toHaveProperty("presentation", { colorPreset });
    const runtime = createSystemRuntime({ loadPackage: createFixturePublishedPackageLoader([compiled.value]), authoritativeRollSecret: "a".repeat(32) });
    const result = await runtime.resolve({ versionId: identity.versionId, entityId: document.entities[0]!.id, intent: { kind: "initialize", values: {} } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.projection).toHaveProperty("presentation", { colorPreset });
  });

  it.each(["default", "classic"])("preserves the composable %s component style", async componentStyle => {
    const document = validDocument();
    Object.assign(document.metadata, { presentation: { colorPreset: "ochre", componentStyle } });
    const decoded = decodeSystemDocument(document);
    expect(decoded.ok).toBe(true); if (!decoded.ok) return;
    const compiled = compileDocument(decoded.value, identity);
    expect(compiled.ok).toBe(true); if (!compiled.ok) return;
    expect(compiled.value).toHaveProperty("presentation", { colorPreset: "ochre", componentStyle });
    expect(documentFromPackage(compiled.value).metadata).toHaveProperty("presentation", { colorPreset: "ochre", componentStyle });
    const runtime = createSystemRuntime({ loadPackage: createFixturePublishedPackageLoader([compiled.value]), authoritativeRollSecret: "a".repeat(32) });
    const result = await runtime.resolve({ versionId: identity.versionId, entityId: "character", intent: { kind: "initialize", values: {} } });
    expect(result.ok).toBe(true); if (result.ok) expect(result.value.projection).toHaveProperty("presentation.componentStyle", componentStyle);
  });

  it.each([{ colorPreset: "blue", componentStyle: "script" }, { colorPreset: "url(https://evil)" }, { colorPreset: "blue", css: "script" }])("rejects unsafe presentation %j at its authored path", presentation => {
    const document = validDocument();
    Object.assign(document.metadata, { presentation });
    const decoded = decodeSystemDocument(document);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.diagnostics.some(d => d.path.startsWith("/metadata/presentation"))).toBe(true);
  });
});
