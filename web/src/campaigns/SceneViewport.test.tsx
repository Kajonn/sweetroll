// web/src/campaigns/SceneViewport.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignSceneView, SceneViewportView } from "./SceneViewport.js";

function scene(overrides = {}) {
  return {
    sceneId: "s1",
    campaignId: "c1",
    revision: 3,
    backgroundFileId: "f1",
    fog: [],
    tokens: [
      { tokenId: "t1", label: "Alpha", x: 0.25, y: 0.5, size: 1, visible: true, imageFileId: null },
      { tokenId: "t2", label: "Bravo", x: 0.75, y: 0.1, size: 1, visible: false, imageFileId: null },
    ],
    ...overrides,
  };
}

function wrapper(client?: QueryClient) {
  const qc = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function routeProps(overrides = {}) {
  return {
    api: {
      openScene: vi.fn().mockResolvedValue({ scene: scene(), requestId: "r" }),
      applyFogEdit: vi.fn(),
      placeToken: vi.fn(),
      moveToken: vi.fn(),
    },
    campaignId: "c1",
    sceneId: "s1",
    actorId: "u1",
    generation: 0,
    online: true,
    ...overrides,
  };
}

describe("SceneViewportView", () => {
  it("shows the scene image with token markers at normalized positions", () => {
    const onSelectToken = vi.fn();
    render(
      <SceneViewportView scene={scene() as never} imageUrl="/api/scenes/s1/image" onSelectToken={onSelectToken} />,
      { wrapper: wrapper() },
    );
    const image = screen.getByRole("img", { name: /scene background/i });
    expect(image).toHaveAttribute("src", "/api/scenes/s1/image");
    const alpha = screen.getByRole("button", { name: /token alpha/i });
    const bravo = screen.getByRole("button", { name: /token bravo/i });
    expect(alpha.parentElement?.style.left).toBe("25%");
    expect(alpha.parentElement?.style.top).toBe("50%");
    expect(bravo.parentElement?.style.left).toBe("75%");
    expect(bravo.parentElement?.style.top).toBe("10%");
    fireEvent.click(alpha);
    expect(onSelectToken).toHaveBeenCalledWith("t1");
  });

  it("offers keyboard zoom controls with reset", () => {
    render(<SceneViewportView scene={scene() as never} imageUrl="/api/scenes/s1/image" />, {
      wrapper: wrapper(),
    });
    const layer = screen.getByTestId("scene-zoom-layer");
    expect(layer.style.transform).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(layer.style.transform).toContain("scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: /reset view/i }));
    expect(layer.style.transform).toContain("scale(1)");
  });
});

describe("CampaignSceneView", () => {
  it("renders the viewport with fog toolbar and token tray for the open scene", async () => {
    const props = routeProps();
    render(<CampaignSceneView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    expect(await screen.findByRole("img", { name: /scene background/i })).toBeVisible();
    expect(await screen.findByRole("button", { name: /token alpha/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /commit fog edit/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /place token/i })).toBeVisible();
    expect(props.api.openScene).toHaveBeenCalledWith("s1");
  });

  it("shows unavailable content with no scene tools when the server reports 404", async () => {
    const props = routeProps({
      api: {
        openScene: vi.fn().mockRejectedValue({ code: "not_found", status: 404, message: "gone" }),
        applyFogEdit: vi.fn(),
        placeToken: vi.fn(),
        moveToken: vi.fn(),
      },
    });
    render(<CampaignSceneView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    expect(await screen.findByText(/this scene is unavailable/i)).toBeVisible();
    expect(screen.queryByRole("img", { name: /scene background/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /commit fog edit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /place token/i })).toBeNull();
  });

  it("explains that scene changes need a connection while offline", async () => {
    const props = routeProps({ online: false });
    render(<CampaignSceneView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    expect(await screen.findByText(/you are offline\. reconnect to change this scene\./i)).toBeVisible();
    expect(props.api.openScene).not.toHaveBeenCalled();
  });
});
