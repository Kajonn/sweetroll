import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortraitEditor, PortraitThumbnail } from "./PortraitEditor.js";
import type { CharacterImagesApi } from "./imageApi.js";

const state = { revision: 0, portrait: null, requestId: "read" };
function api(): CharacterImagesApi {
  return {
    open: vi.fn().mockResolvedValue(state),
    set: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(state),
  };
}
describe("character portrait controls", () => {
  it("gives a missing thumbnail a valid accessible image role", () => {
    render(<PortraitThumbnail characterId="hero" name="Explorer" />);
    const image = screen.getByRole("img", { name: "Portrait of Explorer" });
    expect(image).toHaveAttribute("loading", "lazy");
    fireEvent.error(image);
    expect(screen.getByRole("img", { name: "No portrait" })).toBeInTheDocument();
  });
  it("retains the exact uncertain upload request and leaves sheet controls usable", async () => {
    const images = api();
    const saved = {
      revision: 1,
      portrait: {
        fileId: "image-one",
        description: "Explorer",
        contentType: "image/png",
        width: 40,
        height: 20,
        sizeBytes: 123,
        checksum: "hash",
      },
      requestId: "saved",
    };
    vi.mocked(images.set)
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(saved as never);
    const play = vi.fn();
    render(
      <>
        <button onClick={play}>Roll</button>
        <PortraitEditor
          api={images}
          characterId="hero"
          characterRevision={7}
          online
          canEdit
        />
      </>,
    );
    await screen.findByText("No portrait");
    fireEvent.change(screen.getByLabelText("Portrait file"), {
      target: {
        files: [new File(["pixels"], "hero.png", { type: "image/png" })],
      },
    });
    await screen.findByAltText("Selected portrait");
    fireEvent.change(screen.getByLabelText("Portrait description"), {
      target: { value: "Explorer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload portrait" }));
    await screen.findByText("Connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Roll" }));
    expect(play).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry exact request" }),
    );
    await waitFor(() => expect(images.set).toHaveBeenCalledTimes(2));
    expect(vi.mocked(images.set).mock.calls[0]).toEqual(
      vi.mocked(images.set).mock.calls[1],
    );
    expect(vi.mocked(images.set).mock.calls[0]![1]).toMatchObject({
      expectedCharacterRevision: 7,
      expectedPortraitRevision: 0,
      description: "Explorer",
    });
    expect(await screen.findByAltText("Explorer")).toBeInTheDocument();
  });
  it("does not read or display private images offline", async () => {
    const images = api();
    render(
      <PortraitEditor
        api={images}
        characterId="hero"
        characterRevision={1}
        online={false}
        canEdit
      />,
    );
    expect(
      screen.getByText("Portrait unavailable offline"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(images.open).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Portrait file")).toBeDisabled();
  });
  it("ignores an old character read after the scoped editor unmounts", async () => {
    const images = api();
    let finish!: (value: typeof state) => void;
    vi.mocked(images.open).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(
      <PortraitEditor
        key="actor-a"
        api={images}
        characterId="old"
        characterRevision={1}
        online
        canEdit
      />,
    );
    view.rerender(
      <PortraitEditor
        key="actor-b"
        api={images}
        characterId="new"
        characterRevision={1}
        online
        canEdit
      />,
    );
    await screen.findByText("No portrait");
    await act(async () =>
      finish({
        ...state,
        portrait: { description: "Private old image", fileId: "old" } as never,
      }),
    );
    expect(screen.queryByAltText("Private old image")).not.toBeInTheDocument();
  });
});
