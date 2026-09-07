import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, render, screen, waitFor } from "@testing-library/react";

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

  it("becomes available when the worker takes control after mount", async () => {
    // Regression: deep links mount before the worker claims the page. The
    // hook must listen for controllerchange even when uncontrolled at mount,
    // or "Available offline" never appears without a reload.
    document.head.innerHTML = '<meta name="offline-build-id" content="build-1">';
    const listeners = new Map<string, Array<() => void>>();
    const attachedPorts: MessagePort[] = [];
    const serviceWorker = {
      controller: null as unknown,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      }),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "serviceWorker", { value: serviceWorker, configurable: true });
    try {
      render(<TestHook view={makeView({ characterId: "char-1", revision: 1 })} />);
      expect(screen.getByTestId("availability")).toHaveTextContent("false");
      expect(serviceWorker.addEventListener).toHaveBeenCalledWith(
        "controllerchange",
        expect.any(Function),
      );

      // The worker finishes installing and claims the page.
      serviceWorker.controller = {
        postMessage: (_message: unknown, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          attachedPorts.push(port);
          port.postMessage({ ready: true, buildId: "build-1" });
        },
      };
      await act(async () => {
        for (const listener of listeners.get("controllerchange") ?? []) listener();
      });
      await waitFor(() => expect(screen.getByTestId("availability")).toHaveTextContent("true"));
    } finally {
      for (const port of attachedPorts) port.close();
      document.head.innerHTML = "";
    }
  });
});
