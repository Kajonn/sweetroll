// web/src/campaigns/TokenTray.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TokenTrayView } from "./TokenTray.js";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const tokens = [
  { tokenId: "t1", label: "Alpha", x: 0.25, y: 0.5, size: 1, visible: true, imageFileId: null },
];

function trayProps(overrides = {}) {
  return {
    api: {
      placeToken: vi.fn().mockResolvedValue({ scene: { sceneId: "s1" }, requestId: "r" }),
      moveToken: vi.fn().mockResolvedValue({ scene: { sceneId: "s1" }, requestId: "r2" }),
    },
    sceneId: "s1",
    sceneRevision: 3,
    tokens,
    online: true,
    onChanged: vi.fn(),
    ...overrides,
  };
}

describe("TokenTrayView", () => {
  it("places a token with a fresh key", async () => {
    const props = trayProps();
    render(<TokenTrayView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    fireEvent.change(screen.getByLabelText(/token label/i), { target: { value: "Wren" } });
    fireEvent.change(screen.getByLabelText(/^x \(0–1\)/i), { target: { value: "0.4" } });
    fireEvent.change(screen.getByLabelText(/^y \(0–1\)/i), { target: { value: "0.6" } });
    fireEvent.click(screen.getByRole("button", { name: /place token/i }));
    await vi.waitFor(() => expect(props.api.placeToken).toHaveBeenCalledTimes(1));
    const [sceneId, body] = props.api.placeToken.mock.calls[0]!;
    expect(sceneId).toBe("s1");
    expect(body).toEqual(
      expect.objectContaining({
        expectedSceneRevision: 3,
        label: "Wren",
        x: 0.4,
        y: 0.6,
      }),
    );
    expect(typeof body.idempotencyKey).toBe("string");
    expect(props.onChanged).toHaveBeenCalled();
    expect(await screen.findByText(/token placed/i)).toBeVisible();
  });

  it("moves a token with a fresh key", async () => {
    const props = trayProps();
    render(<TokenTrayView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    fireEvent.click(screen.getByRole("button", { name: /move alpha/i }));
    await vi.waitFor(() => expect(props.api.moveToken).toHaveBeenCalledTimes(1));
    const [sceneId, tokenId, body] = props.api.moveToken.mock.calls[0]!;
    expect(sceneId).toBe("s1");
    expect(tokenId).toBe("t1");
    expect(body).toEqual(
      expect.objectContaining({ expectedSceneRevision: 3, x: 0.25, y: 0.5 }),
    );
    expect(typeof body.idempotencyKey).toBe("string");
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("nudges coordinates by keyboard without committing until move", async () => {
    const props = trayProps();
    render(<TokenTrayView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    fireEvent.click(screen.getByRole("button", { name: /nudge alpha right/i }));
    expect(props.api.moveToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /move alpha/i }));
    await vi.waitFor(() => expect(props.api.moveToken).toHaveBeenCalledTimes(1));
    const [, , body] = props.api.moveToken.mock.calls[0]!;
    expect(body.x).toBeCloseTo(0.26, 5);
    expect(body.y).toBeCloseTo(0.5, 5);
  });

  it("shows explicit retry text and refetches after a move 409, retrying with a fresh key", async () => {
    const props = trayProps({
      api: {
        placeToken: vi.fn(),
        moveToken: vi
          .fn()
          .mockRejectedValueOnce({ code: "conflict", status: 409, message: "stale" })
          .mockResolvedValueOnce({ scene: { sceneId: "s1" }, requestId: "r3" }),
      },
    });
    render(<TokenTrayView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    fireEvent.click(screen.getByRole("button", { name: /move alpha/i }));
    expect(await screen.findByText(/this scene changed\. the latest version was reloaded/i)).toBeVisible();
    expect(props.onChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /retry moving alpha/i }));
    await vi.waitFor(() => expect(props.api.moveToken).toHaveBeenCalledTimes(2));
    const first = props.api.moveToken.mock.calls[0]![2];
    const second = props.api.moveToken.mock.calls[1]![2];
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("disables place and move offline with explanatory text", () => {
    const props = trayProps({ online: false });
    render(<TokenTrayView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    expect(screen.getByRole("button", { name: /place token/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /move alpha/i })).toBeDisabled();
    expect(screen.getByText(/you are offline\. reconnect to change this scene\./i)).toBeVisible();
  });
});
