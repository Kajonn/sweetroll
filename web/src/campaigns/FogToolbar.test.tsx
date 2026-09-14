// web/src/campaigns/FogToolbar.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FogToolbarView } from "./FogToolbar.js";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function toolbarProps(overrides = {}) {
  return {
    api: { applyFogEdit: vi.fn().mockResolvedValue({ scene: { sceneId: "s1" }, requestId: "r" }) },
    sceneId: "s1",
    sceneRevision: 3,
    online: true,
    onChanged: vi.fn(),
    ...overrides,
  };
}

function addDab(x = "0.5", y = "0.5", r = "0.1") {
  fireEvent.change(screen.getByLabelText(/x \(0–1\)/i), { target: { value: x } });
  fireEvent.change(screen.getByLabelText(/y \(0–1\)/i), { target: { value: y } });
  fireEvent.change(screen.getByLabelText(/radius \(0–1\)/i), { target: { value: r } });
  fireEvent.click(screen.getByRole("button", { name: /add fog dab/i }));
}

describe("FogToolbarView", () => {
  it("commits one reveal op with a fresh key", async () => {
    const props = toolbarProps();
    render(<FogToolbarView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    addDab();
    fireEvent.click(screen.getByRole("button", { name: /commit fog edit/i }));
    await vi.waitFor(() => expect(props.api.applyFogEdit).toHaveBeenCalledTimes(1));
    const [sceneId, body] = props.api.applyFogEdit.mock.calls[0]!;
    expect(sceneId).toBe("s1");
    expect(body.expectedSceneRevision).toBe(3);
    expect(body.op).toEqual({ mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] });
    expect(typeof body.idempotencyKey).toBe("string");
    expect(props.onChanged).toHaveBeenCalled();
    expect(await screen.findByText(/fog edit committed/i)).toBeVisible();
  });

  it("commits a conceal op when conceal mode is selected", async () => {
    const props = toolbarProps();
    render(<FogToolbarView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    fireEvent.change(screen.getByLabelText(/fog mode/i), { target: { value: "conceal" } });
    addDab("0.2", "0.3", "0.05");
    fireEvent.click(screen.getByRole("button", { name: /commit fog edit/i }));
    await vi.waitFor(() => expect(props.api.applyFogEdit).toHaveBeenCalledTimes(1));
    const [, body] = props.api.applyFogEdit.mock.calls[0]!;
    expect(body.op).toEqual({ mode: "conceal", runs: [{ x: 0.2, y: 0.3, r: 0.05 }] });
  });

  it("undo drops the uncommitted stroke without committing", () => {
    const props = toolbarProps();
    render(<FogToolbarView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    addDab();
    expect(screen.getByText(/1 uncommitted fog dab/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /undo fog stroke/i }));
    expect(screen.getByText(/no uncommitted fog dabs/i)).toBeVisible();
    expect(props.api.applyFogEdit).not.toHaveBeenCalled();
  });

  it("shows explicit retry text and refetches after a 409, retrying with a fresh key", async () => {
    const props = toolbarProps({
      api: {
        applyFogEdit: vi
          .fn()
          .mockRejectedValueOnce({ code: "conflict", status: 409, message: "stale" })
          .mockResolvedValueOnce({ scene: { sceneId: "s1" }, requestId: "r2" }),
      },
    });
    render(<FogToolbarView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    addDab();
    fireEvent.click(screen.getByRole("button", { name: /commit fog edit/i }));
    expect(await screen.findByText(/this scene changed\. the latest version was reloaded/i)).toBeVisible();
    expect(props.onChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /retry fog edit/i }));
    await vi.waitFor(() => expect(props.api.applyFogEdit).toHaveBeenCalledTimes(2));
    const first = props.api.applyFogEdit.mock.calls[0]![1];
    const second = props.api.applyFogEdit.mock.calls[1]![1];
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("disables commit offline with explanatory text", () => {
    const props = toolbarProps({ online: false });
    render(<FogToolbarView {...{ ...props, api: props.api as never }} />, { wrapper: wrapper() });
    addDab();
    expect(screen.getByRole("button", { name: /commit fog edit/i })).toBeDisabled();
    expect(screen.getByText(/you are offline\. reconnect to change this scene\./i)).toBeVisible();
    expect(props.api.applyFogEdit).not.toHaveBeenCalled();
  });
});
