import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { SceneLibrary } from "./SceneLibrary.js";
import type { SceneLibraryApi } from "./api.js";
const file = (fileId: string, name: string) => ({ fileId, name, campaignId: "c", mediaType: "image/png", sizeBytes: 30, width: 30, height: 20, checksum: "hash", revision: 1 });
function setup() {
  const api: SceneLibraryApi = { listImages: vi.fn().mockResolvedValue({ images: [file("first", "Cave"), file("second", "Forest")], nextCursor: null }), listScenes: vi.fn().mockResolvedValue({ scenes: [], nextCursor: null }), uploadImage: vi.fn(), deleteImage: vi.fn(), createScene: vi.fn(), updateScene: vi.fn().mockResolvedValue({ scene: { sceneId: "s", campaignId: "c", revision: 8, backgroundFileId: "second", fog: [], tokens: [] } }) };
  const props = { api, campaignId: "c", actorId: "gm", generation: 1, online: true, scene: { sceneId: "s", campaignId: "c", revision: 7, backgroundFileId: "first", fog: [], tokens: [] }, onChanged: vi.fn(), onOpenScene: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { api, props, ...render(<SceneLibrary {...props} />, { wrapper }) };
}
describe("scene background library", () => {
  it("requires confirmation and retries the exact observed scene after response loss", async () => {
    const { api, props, rerender } = setup(); vi.mocked(api.updateScene).mockRejectedValueOnce(new Error("Connection lost"));
    const row = (await screen.findByRole("img", { name: "Forest" })).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Use as background" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("conceals the whole image and removes all tokens"); expect(api.updateScene).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace and conceal" })); await screen.findByText("Connection lost");
    rerender(<SceneLibrary {...props} scene={{ ...props.scene, revision: 99 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact request" })); await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(vi.mocked(api.updateScene).mock.calls[0]).toEqual(vi.mocked(api.updateScene).mock.calls[1]); expect(vi.mocked(api.updateScene).mock.calls[0]).toEqual(["s", expect.objectContaining({ expectedSceneRevision: 7, backgroundFileId: "second" })]);
  });
  it("requires refreshing and a new confirmation after a stale scene conflict", async () => {
    const { api, props } = setup(); vi.mocked(api.updateScene).mockRejectedValueOnce({ status: 409, message: "Scene changed" });
    const row = (await screen.findByRole("img", { name: "Forest" })).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Use as background" })); fireEvent.click(screen.getByRole("button", { name: "Replace and conceal" }));
    await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "Retry exact request" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh scene" })); await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce()); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("hides private thumbnails and dialogs when a mutation loses authority", async () => {
    const { api } = setup(); vi.mocked(api.deleteImage).mockRejectedValueOnce({ status: 404, message: "Unavailable" });
    const row = (await screen.findByRole("img", { name: "Forest" })).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete image" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete image" }));
    await screen.findByText("This scene library is unavailable.");
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("does not read or render the private image library offline", () => {
    const { api, props, rerender } = setup(); rerender(<SceneLibrary {...props} online={false} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(screen.getByLabelText("Image file")).toBeDisabled();
  });
});

it("selects token artwork without scene reads or background replacement", async () => {
  const { api, props, rerender } = setup();
  const onSelect = vi.fn(); vi.mocked(api.listScenes).mockClear();
  rerender(<SceneLibrary {...props} selection={{fileId:null,onSelect}} />);
  const row = (await screen.findByRole("img", { name: "Forest" })).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Select token image" }));
  expect(onSelect).toHaveBeenCalledWith("second");
  expect(api.updateScene).not.toHaveBeenCalled(); expect(api.createScene).not.toHaveBeenCalled();
  expect(api.listScenes).not.toHaveBeenCalled();
});

it("uploads token art with exact-request retry and auto-selects without modifying the scene", async () => {
  const { api, props, rerender } = setup(); const onSelect = vi.fn();
  vi.mocked(api.uploadImage).mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue({ image: file("uploaded", "Scout") } as never);
  rerender(<SceneLibrary {...props} selection={{fileId:null,onSelect}} />);
  await screen.findByRole("img", {name:"Forest"});
  fireEvent.change(screen.getByLabelText("Token image file"), {target:{files:[new File(["PNG"],"scout.png",{type:"image/png"})]}});
  fireEvent.change(await screen.findByLabelText("Image description"), {target:{value:"Scout"}});
  fireEvent.click(screen.getByRole("button", {name:"Upload token image"}));
  await screen.findByText("Lost response"); expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name:"Retry exact request"}));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("uploaded"));
  expect(vi.mocked(api.uploadImage).mock.calls[0]).toEqual(vi.mocked(api.uploadImage).mock.calls[1]);
  expect(api.updateScene).not.toHaveBeenCalled(); expect(api.createScene).not.toHaveBeenCalled();
});
