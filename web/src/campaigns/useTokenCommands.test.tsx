import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTokenCommands } from "./useTokenCommands.js";
const draft = { label: "Wren", imageFileId: null, x: .5, y: .5, size: .1, visible: true };
function props() { return { api: { placeToken: vi.fn().mockResolvedValue({}), moveToken: vi.fn().mockResolvedValue({}) }, sceneId: "s1", sceneRevision: 3, online: true, onChanged: vi.fn().mockResolvedValue(3) }; }
describe("shared token command recovery", () => {
  it("adopts the committed scene from a completed gesture's response without an extra read", async () => {
    const p = { ...props(), onApplied: vi.fn() };
    const scene = { sceneId: "s1", revision: 4, tokens: [] };
    p.api.moveToken.mockResolvedValue({ scene, requestId: "r" });
    const h = renderHook(() => useTokenCommands(p));
    await act(async () => { h.result.current.move("t1", "Wren", { x: .4, y: .6 }); });
    await waitFor(() => expect(h.result.current.status).toBe("applied"));
    expect(p.api.moveToken).toHaveBeenCalledTimes(1);
    expect(p.onApplied).toHaveBeenCalledWith(scene);
    expect(p.onChanged).not.toHaveBeenCalled();
  });
  it("still reconciles a conflict through an explicit read when adopting responses", async () => {
    const p = { ...props(), onApplied: vi.fn() };
    p.api.moveToken.mockRejectedValueOnce({ status: 409 });
    const h = renderHook(() => useTokenCommands(p));
    await act(async () => { h.result.current.move("t1", "Wren", { x: .4, y: .6 }); });
    await waitFor(() => expect(h.result.current.refreshed).toBe(true));
    expect(h.result.current.status).toBe("conflict");
    expect(p.onChanged).toHaveBeenCalledTimes(1);
    expect(p.onApplied).not.toHaveBeenCalled();
  });
  it("locks gesture and numeric submissions synchronously until the read completes", async () => {
    const p = props(); let finish!: () => void;
    p.api.moveToken.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const h = renderHook(() => useTokenCommands(p));
    act(() => { h.result.current.move("t1", "Wren", { x: .4, y: .6 }); h.result.current.place(draft); h.result.current.move("t1", "Wren", { x: .7, y: .9 }); });
    expect(p.api.moveToken).toHaveBeenCalledTimes(1); expect(p.api.placeToken).not.toHaveBeenCalled();
    expect(h.result.current.blocked).toBe(true);
    await act(async () => { finish(); });
    expect(h.result.current.status).toBe("applied"); expect(p.onChanged).toHaveBeenCalledTimes(1);
  });
  it("retries a lost response with exactly the same command and key", async () => {
    const p = props(); p.api.placeToken.mockRejectedValueOnce(new Error("connection lost"));
    const h = renderHook(() => useTokenCommands(p));
    act(() => h.result.current.place(draft));
    await waitFor(() => expect(h.result.current.status).toBe("uncertain"));
    act(() => h.result.current.place(draft)); expect(p.api.placeToken).toHaveBeenCalledTimes(1);
    await act(async () => { await h.result.current.retry(); });
    expect(p.api.placeToken).toHaveBeenCalledTimes(2);
    expect(p.api.placeToken.mock.calls[1]).toEqual(p.api.placeToken.mock.calls[0]);
  });
  it("requires a successful re-read and explicit fresh-revision retry after 409", async () => {
    const p = props(); p.api.moveToken.mockRejectedValueOnce({ status: 409 }); p.onChanged.mockRejectedValueOnce(new Error("read failed"));
    const h = renderHook(v => useTokenCommands(v), { initialProps: p });
    act(() => h.result.current.move("t1", "Wren", { x: .4, y: .6 }));
    await waitFor(() => expect(h.result.current.status).toBe("conflict"));
    expect(h.result.current.refreshed).toBe(false);
    await act(async () => { await h.result.current.retry(); });
    expect(p.api.moveToken).toHaveBeenCalledTimes(1);
    h.rerender({ ...p, sceneRevision: 9 });
    await act(async () => { await h.result.current.retry(); });
    const old = p.api.moveToken.mock.calls[0]![2], next = p.api.moveToken.mock.calls[1]![2];
    expect(next).toMatchObject({ x: .4, y: .6, expectedSceneRevision: 9 }); expect(next.idempotencyKey).not.toBe(old.idempotencyKey);
  });
  it.each([400, 422])("allows correction after a definite validation rejection %s without retrying the rejected request", async status => {
    const p = props(); p.api.placeToken.mockRejectedValueOnce({ status });
    const h = renderHook(() => useTokenCommands(p)); act(() => h.result.current.place(draft));
    await waitFor(() => expect(h.result.current.status).toBe("rejected"));
    await act(async () => { await h.result.current.retry(); });
    expect(p.api.placeToken).toHaveBeenCalledTimes(1);
    act(() => h.result.current.discard());
    expect(h.result.current.blocked).toBe(false);
    await act(async () => { h.result.current.place({ ...draft, label: "Corrected" }); });
    expect(p.api.placeToken).toHaveBeenCalledTimes(2);
    expect(p.api.placeToken.mock.calls[1]![1].label).toBe("Corrected");
    expect(p.api.placeToken.mock.calls[1]![1].idempotencyKey).not.toBe(p.api.placeToken.mock.calls[0]![1].idempotencyKey);
  });
  it("does not resubmit an applied command when its follow-up read fails", async () => {
    const p = props(); p.onChanged.mockRejectedValueOnce(new Error("read failed"));
    const h = renderHook(() => useTokenCommands(p)); act(() => h.result.current.place(draft));
    await waitFor(() => expect(h.result.current.status).toBe("refresh"));
    await act(async () => { await h.result.current.retry(); });
    expect(p.api.placeToken).toHaveBeenCalledTimes(1); expect(p.onChanged).toHaveBeenCalledTimes(2);
    expect(h.result.current.status).toBe("applied");
  });
  it.each([401, 403, 404])("clears recovery after authorization denial %s", async status => {
    const p = props(); p.api.moveToken.mockRejectedValueOnce({ status });
    const h = renderHook(() => useTokenCommands(p)); act(() => h.result.current.move("t1", "Wren", { x: .4, y: .6 }));
    await waitFor(() => expect(h.result.current.status).toBe("unavailable"));
    expect(h.result.current.operation).toBeUndefined();
    await act(async () => { await h.result.current.retry(); }); expect(p.api.moveToken).toHaveBeenCalledTimes(1);
  });
  it("does not refresh a protected scene after the editing scope unmounts", async () => {
    const p = props(); let finish!: () => void; p.api.moveToken.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const h = renderHook(() => useTokenCommands(p)); act(() => h.result.current.move("t1", "Wren", { x: .4, y: .6 })); h.unmount();
    await act(async () => { finish(); }); expect(p.onChanged).not.toHaveBeenCalled();
  });
});
