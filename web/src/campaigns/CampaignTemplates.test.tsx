import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { it, expect, vi } from "vitest";
import { CampaignTemplates } from "./CampaignTemplates.js";
import type {
  CampaignTemplate,
  CampaignTemplatesApi,
} from "./campaignTemplateApi.js";
const template: CampaignTemplate = {
  templateId: "key",
  campaignId: "campaign",
  creatorId: "gm",
  kind: "item",
  audience: "all_players",
  status: "active",
  revision: 1,
  contentRevision: 1,
  content: { name: "Tower key", notes: "Opens gate", defaultQuantity: 3 },
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
};
function setup(isGm = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const api: CampaignTemplatesApi = {
    list: vi
      .fn()
      .mockResolvedValue({ templates: [template], nextCursor: null }),
    create: vi.fn().mockResolvedValue({ template }),
    edit: vi.fn().mockResolvedValue({ template }),
    archive: vi.fn().mockResolvedValue({ template }),
    recover: vi.fn().mockResolvedValue({ template }),
  };
  const revoked = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CampaignTemplates
        api={api}
        campaignId="campaign"
        actorId="gm"
        generation={0}
        isGm={isGm}
        online={true}
        readOnly={false}
        onAccessRevoked={revoked}
      />
    </QueryClientProvider>,
  );
  return { api, client, revoked, user: userEvent.setup() };
}
it("publishes bounded data in one acknowledged create operation", async () => {
  const { api, user } = setup();
  await screen.findByText("Tower key");
  await user.click(screen.getByRole("button", { name: "Create template" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "New key");
  await user.click(
    screen.getByRole("button", { name: "Publish to all members" }),
  );
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(
      "campaign",
      expect.objectContaining({
        kind: "item",
        expectedTemplateRevision: 0,
        content: expect.objectContaining({ name: "New key" }),
      }),
    ),
  );
});
it("allows a player to read but hides catalog mutation controls", async () => {
  const { api } = setup(false);
  await screen.findByText("Tower key");
  expect(screen.queryByRole("button", { name: "Create template" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit template" })).toBeNull();
  expect(api.create).not.toHaveBeenCalled();
});
it("keeps input on a stale revision and requires refresh before editing again", async () => {
  const { api, user } = setup();
  vi.mocked(api.edit).mockRejectedValue({ status: 409 });
  await screen.findByText("Tower key");
  await user.click(screen.getByRole("button", { name: "Edit template" }));
  await user.type(screen.getByRole("textbox", { name: "Notes" }), " changed");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /changed|refresh/i,
  );
  expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue(
    "Opens gate changed",
  );
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
});
it("requires confirmation to archive and exposes recover from the archived list", async () => {
  const { api, user } = setup();
  await screen.findByText("Tower key");
  await user.click(screen.getByRole("button", { name: "Archive template" }));
  expect(api.archive).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Confirm archive" }));
  await waitFor(() =>
    expect(api.archive).toHaveBeenCalledWith(
      "campaign",
      "key",
      expect.objectContaining({ expectedTemplateRevision: 1 }),
    ),
  );
  vi.mocked(api.list).mockResolvedValue({
    templates: [{ ...template, status: "archived", revision: 2 }],
    nextCursor: null,
  });
  await user.click(screen.getByRole("button", { name: "Archived templates" }));
  await user.click(
    await screen.findByRole("button", { name: "Recover template" }),
  );
  await waitFor(() =>
    expect(api.recover).toHaveBeenCalledWith(
      "campaign",
      "key",
      expect.objectContaining({ expectedTemplateRevision: 2 }),
    ),
  );
});

it("discards a delayed catalog response after switching accounts", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let resolveOld!: (value: {
    templates: CampaignTemplate[];
    nextCursor: null;
  }) => void;
  const old = new Promise<{ templates: CampaignTemplate[]; nextCursor: null }>(
    (resolve) => {
      resolveOld = resolve;
    },
  );
  const api: CampaignTemplatesApi = {
    list: vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue({
        templates: [{ ...template, content: { name: "Second account" } }],
        nextCursor: null,
      }),
    create: vi.fn(),
    edit: vi.fn(),
    archive: vi.fn(),
    recover: vi.fn(),
  };
  const component = (actorId: string, generation: number) => (
    <QueryClientProvider client={client}>
      <CampaignTemplates
        api={api}
        campaignId="campaign"
        actorId={actorId}
        generation={generation}
        isGm={false}
        online={true}
        readOnly={false}
        onAccessRevoked={vi.fn()}
      />
    </QueryClientProvider>
  );
  const ui = render(component("first", 1));
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
  ui.rerender(component("second", 2));
  await screen.findByText("Second account");
  resolveOld({ templates: [template], nextCursor: null });
  await waitFor(() =>
    expect(
      client.getQueryState([
        "campaigns",
        "templates",
        "campaign",
        "first",
        1,
        "active",
      ])?.fetchStatus,
    ).toBe("idle"),
  );
  expect(
    client.getQueryData([
      "campaigns",
      "templates",
      "campaign",
      "first",
      1,
      "active",
    ]),
  ).toBeUndefined();
  expect(screen.queryByText("Tower key")).toBeNull();
});
