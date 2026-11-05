import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageAttachmentEditor } from "./ImageAttachmentEditor.js";
import type { ImageEditorApi } from "./imageEditorApi.js";
const empty = { revision: 4, image: null, parentRevision: 1 };
const image = { fileId: "b0000000-0000-4000-8000-000000000001", description: "Bronze key", contentType: "image/png" as const, width: 20, height: 10, sizeBytes: 100, checksum: "a".repeat(64) };
function api(): ImageEditorApi { return { read: vi.fn().mockResolvedValue(empty), upload: vi.fn().mockResolvedValue({ revision: 5, image }), remove: vi.fn().mockResolvedValue({ revision: 5, image: null }), imageUrl: vi.fn().mockReturnValue("/api/private/image") }; }
describe("shared item image editor", () => {
  it("retains exact requests across parent edits without disabling ordinary play", async () => {
    const images = api(), changed = vi.fn(), play = vi.fn();
    vi.mocked(images.upload).mockRejectedValueOnce(new Error("Connection lost"));
    const view = render(<><button onClick={play}>Roll</button><ImageAttachmentEditor api={images} online canEdit parentRevision={1} onChanged={changed} /></>);
    await screen.findByText("No artwork");
    fireEvent.change(screen.getByLabelText("Image file"), { target: { files: [new File(["pixels"], "key.png", { type: "image/png" })] } });
    await screen.findByAltText("Selected image");
    fireEvent.change(screen.getByLabelText("Image description"), { target: { value: "Bronze key" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload artwork" }));
    await screen.findByText("Connection lost");
    view.rerender(<><button onClick={play}>Roll</button><ImageAttachmentEditor api={images} online canEdit parentRevision={99} onChanged={changed} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Roll" })); expect(play).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact request" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(vi.mocked(images.upload).mock.calls[0]).toEqual(vi.mocked(images.upload).mock.calls[1]);
    expect(vi.mocked(images.upload).mock.calls[0]![0]).toMatchObject({ expectedImageRevision: 4, expectedParentRevision: 1, description: "Bronze key" });
    expect(images.read).toHaveBeenCalledOnce();
  });
  it("keeps malformed success uncertain and allows an exact retry", async () => {
    const images = api(); vi.mocked(images.remove).mockResolvedValueOnce({ revision: 4, image } as never);
    vi.mocked(images.read).mockResolvedValue({ revision: 4, image });
    render(<ImageAttachmentEditor api={images} online canEdit />);
    await screen.findByAltText("Bronze key"); fireEvent.click(screen.getByRole("button", { name: "Remove artwork" }));
    await screen.findByRole("alert"); expect(screen.getByRole("button", { name: "Retry exact request" })).toBeEnabled();
  });
  it("preserves an uncertain request while disconnected and retries after reconnect", async () => {
    const images = api(); vi.mocked(images.read).mockResolvedValue({ revision: 4, image });
    vi.mocked(images.remove).mockRejectedValueOnce(new Error("Connection lost"));
    const view = render(<ImageAttachmentEditor api={images} online canEdit parentRevision={1} />);
    await screen.findByAltText("Bronze key"); fireEvent.click(screen.getByRole("button", { name: "Remove artwork" }));
    await screen.findByText("Connection lost");
    view.rerender(<ImageAttachmentEditor api={images} online={false} canEdit parentRevision={1} />);
    expect(screen.getByRole("button", { name: "Retry exact request" })).toBeDisabled();
    view.rerender(<ImageAttachmentEditor api={images} online canEdit parentRevision={99} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry exact request" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Retry exact request" }));
    await waitFor(() => expect(images.remove).toHaveBeenCalledTimes(2));
    expect(vi.mocked(images.remove).mock.calls[0]).toEqual(vi.mocked(images.remove).mock.calls[1]);
  });
  it("does not read or render private artwork offline", () => {
    const images = api(); render(<ImageAttachmentEditor api={images} online={false} canEdit />);
    expect(images.read).not.toHaveBeenCalled(); expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Image file")).toBeDisabled(); expect(screen.getByText("Artwork unavailable offline")).toBeInTheDocument();
  });
});
