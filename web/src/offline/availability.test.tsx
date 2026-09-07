import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CharacterSheet } from "../characters/CharacterSheet.js";
import type { CharacterSnapshot } from "../characters/session.js";
import { makeView } from "../characters/testing.js";
import { useOfflineAvailability } from "./useOfflineAvailability.js";

function snapshot(): CharacterSnapshot {
  return {
    phase: "ready",
    confirmed: makeView({ characterId: "char-1", revision: 1 }),
    tentative: null,
    entries: [],
    editing: { owned: true },
    error: null,
    lastRoll: null,
  };
}

function TestHook({ view }: { view: ReturnType<typeof makeView> | null }) {
  const availability = useOfflineAvailability(view);
  return <output data-testid="availability">{String(availability.available)}</output>;
}

describe("offline availability UI", () => {
  it("marks the sheet available offline once the worker cache and snapshot are ready", () => {
    const html = renderToStaticMarkup(<CharacterSheet snapshot={snapshot()} onSetField={() => {}} onBump={() => {}} offlineAvailable />);
    expect(html).toContain("Available offline");
  });

  it("explains when the offline copy is not ready yet", () => {
    const html = renderToStaticMarkup(
      <CharacterSheet snapshot={snapshot()} onSetField={() => {}} onBump={() => {}} offlineAvailable={false} />,
    );
    expect(html).toContain("Offline copy not ready yet");
  });

  it("renders no badge until availability is determined", () => {
    const html = renderToStaticMarkup(<CharacterSheet snapshot={snapshot()} onSetField={() => {}} onBump={() => {}} />);
    expect(html).not.toContain("Available offline");
    expect(html).not.toContain("Offline copy not ready yet");
  });

  it("reports unavailable without a controlling worker in this environment", () => {
    const html = renderToStaticMarkup(<TestHook view={makeView({ characterId: "char-1", revision: 1 })} />);
    expect(html).toContain("false");
  });
});
