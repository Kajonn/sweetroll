import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayImage } from "./DisplayImage.js";

describe("credential-scoped display image", () => {
  const fetchImage = vi.fn();
  const create = vi.fn(() => "blob:redacted"), revoke = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchImage);
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    fetchImage.mockResolvedValue({ok:true,blob:async()=>new Blob(["redacted"],{type:"image/png"})});
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
  it("fetches bytes with the display header, omits account cookies and releases the blob", async () => {
    const {unmount} = render(<DisplayImage path="/displays/d1/scenes/s1/image?rev=1" secret="scoped-secret" alt="Display image" />);
    expect(await screen.findByRole("img")).toHaveAttribute("src","blob:redacted");
    expect(fetchImage).toHaveBeenCalledWith("/api/displays/d1/scenes/s1/image?rev=1", expect.objectContaining({headers:{"x-display-secret":"scoped-secret"},credentials:"omit",cache:"no-store",signal:expect.any(AbortSignal)}));
    expect(screen.getByRole("img").outerHTML).not.toContain("scoped-secret");
    unmount(); expect(revoke).toHaveBeenCalledWith("blob:redacted");
  });
  it("fails closed when image authorization is denied", async () => {
    fetchImage.mockResolvedValue({ok:false});
    render(<DisplayImage path="/displays/d1/scenes/s1/image?rev=1" secret="bad" alt="Display image" />);
    await waitFor(()=>expect(screen.getByRole("button",{name:"Retry"})).toBeVisible());
    expect(screen.queryByRole("img")).toBeNull(); expect(create).not.toHaveBeenCalled();
  });
  it("never adopts a delayed response after unmount", async () => {
    let resolve!: (value:unknown)=>void;
    fetchImage.mockReturnValue(new Promise(r=>{resolve=r;}));
    const {unmount}=render(<DisplayImage path="/displays/d1/scenes/s1/image?rev=1" secret="secret" alt="Display image" />);
    unmount(); resolve({ok:true,blob:async()=>new Blob(["late"])});
    await waitFor(()=>expect((fetchImage.mock.calls[0]![1] as {signal:AbortSignal}).signal.aborted).toBe(true));
    expect(create).not.toHaveBeenCalled();
  });
});
