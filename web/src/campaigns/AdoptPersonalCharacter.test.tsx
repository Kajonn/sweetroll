import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { CampaignCharactersTab } from "./CampaignCharacters.js";

function setup(online = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const adoptCharacter = vi.fn().mockResolvedValue({ character: { characterId: "hero" } });
  const listCharacters = vi.fn().mockResolvedValue({ characters: [
    { characterId: "hero", name: "Aldric", systemVersionId: "v1", lifecycle: "active", revision: 7 },
    { characterId: "other-version", name: "Wrong rules", systemVersionId: "v2", lifecycle: "active", revision: 1 },
    { characterId: "archived", name: "Retired hero", systemVersionId: "v1", lifecycle: "archived", revision: 2 },
  ], nextCursor: null });
  const api = { adoptCharacter,
    listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [] }),
    listClaimableCharacters: vi.fn().mockResolvedValue({ characters: [], nextCursor: null }),
  };
  const metadataApi = { listCharacters, creationOptions: vi.fn().mockResolvedValue({ data: { entities: [] } }) };
  const changed = vi.fn();
  const props = { api: api as never, metadataApi: metadataApi as never, campaignId: "c1", actorId: "p1", campaignRevision: 3, pinnedVersionId: "v1", online, onOpenCharacter: vi.fn(), onCampaignStale: changed };
  const view = render(<QueryClientProvider client={client}><CampaignCharactersTab {...props} /></QueryClientProvider>);
  return { ...view, api, metadataApi, client, changed, props, user: userEvent.setup() };
}

it("discovers compatible personal characters, cancels without mutation and confirms disclosure", async () => {
  const { user, api, metadataApi } = setup();
  await user.click(await screen.findByRole("button", { name: "Bring a personal character" }));
  await user.selectOptions(await screen.findByLabelText("Personal character"), "hero");
  expect(screen.queryByRole("option", { name: "Wrong rules" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Retired hero" })).toBeNull();
  expect(screen.getByText(/game masters can read and edit/i)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.adoptCharacter).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Bring a personal character" }));
  await user.selectOptions(await screen.findByLabelText("Personal character"), "hero");
  await user.click(screen.getByRole("button", { name: "Join campaign with character" }));
  await waitFor(() => expect(api.adoptCharacter).toHaveBeenCalledWith("c1", "hero", expect.objectContaining({ expectedCampaignRevision: 3, expectedCharacterRevision: 7, acknowledgedDisclosure: true, idempotencyKey: expect.any(String) })));
  expect(metadataApi.listCharacters).toHaveBeenCalledWith({ limit: 25, cursor: null });
});

it("retries an uncertain adoption with the exact frozen request", async () => {
  const { user, api } = setup();
  api.adoptCharacter.mockRejectedValueOnce(new TypeError("response lost"));
  await user.click(await screen.findByRole("button", { name: "Bring a personal character" }));
  await user.selectOptions(await screen.findByLabelText("Personal character"), "hero");
  await user.click(screen.getByRole("button", { name: "Join campaign with character" }));
  await user.click(await screen.findByRole("button", { name: "Retry exact request" }));
  await waitFor(() => expect(api.adoptCharacter).toHaveBeenCalledTimes(2));
  expect(api.adoptCharacter.mock.calls[1]).toEqual(api.adoptCharacter.mock.calls[0]);
});

it("requires fresh review after a revision conflict", async () => {
  const { user, api, changed } = setup();
  api.adoptCharacter.mockRejectedValueOnce({ status: 409 });
  await user.click(await screen.findByRole("button", { name: "Bring a personal character" }));
  await user.selectOptions(await screen.findByLabelText("Personal character"), "hero");
  await user.click(screen.getByRole("button", { name: "Join campaign with character" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/refresh/i);
  expect(screen.getByRole("button", { name: "Join campaign with character" })).toBeDisabled();
  expect(changed).toHaveBeenCalled();
});

it("does not discover or adopt while offline", async () => {
  const { metadataApi } = setup(false);
  expect(await screen.findByRole("button", { name: "Bring a personal character" })).toBeDisabled();
  expect(metadataApi.listCharacters).not.toHaveBeenCalled();
});
