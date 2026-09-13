// web/src/campaigns/CampaignSettings.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignSettingsView } from "./CampaignSettings.js";

const campaign = {
  campaignId: "c1", ownerId: "u1", systemVersionId: "v1",
  title: "North Watch", description: "A border fort.",
  status: "active", revision: 5, accessRevision: 1, archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
};

function wrapper(client?: QueryClient) {
  const qc = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const catalogVersions = [
  { versionId: "v1", systemId: "sys-a", systemName: "D20", semanticVersion: "1.0.0", createdAt: "2026-09-01T00:00:00Z" },
  { versionId: "v2", systemId: "sys-a", systemName: "D20", semanticVersion: "2.0.0", createdAt: "2026-09-02T00:00:00Z" },
];

function versionsApi() {
  return {
    listCreationVersions: vi.fn().mockResolvedValue({
      data: { versions: catalogVersions, nextCursor: null },
      requestId: "r",
    }),
  };
}

function previewResponse() {
  return {
    campaignId: "c1",
    campaignRevision: 7,
    sourceVersionId: "v1",
    targetVersionId: "v2",
    targetSemanticVersion: "2.0.0",
    characters: [],
    requestId: "r",
  };
}

const commitResult = {
  campaignId: "c1",
  campaignRevision: 8,
  sourceVersionId: "v1",
  targetVersionId: "v2",
  migratedCharacterIds: [],
  requestId: "r2",
};

describe("CampaignSettingsView", () => {
  it("saves title edits against the current revision with a fresh key", async () => {
    const api = { updateCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }) };
    const onChanged = vi.fn();
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={onChanged} />, { wrapper: wrapper() });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "South Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    await vi.waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(api.updateCampaign).toHaveBeenCalledWith("c1", expect.objectContaining({
      title: "South Watch",
      expectedCampaignRevision: 5,
    }));
    const body = (api.updateCampaign as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onChanged).toHaveBeenCalled();
  });

  it("archives behind a confirmation dialog", async () => {
    const api = { archiveCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }) };
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={() => {}} />, { wrapper: wrapper() });
    fireEvent.click(screen.getByRole("button", { name: /^archive campaign/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm archive/i }));
    await vi.waitFor(() => expect(api.archiveCampaign).toHaveBeenCalledWith("c1", expect.objectContaining({
      expectedCampaignRevision: 5,
    })));
  });

  it("shows the pinned system version as read-only text", () => {
    const api = {};
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={() => {}} />, { wrapper: wrapper() });
    expect(screen.getByText(/pinned system version/i)).toBeVisible();
    expect(screen.getByText(/v1/)).toBeVisible();
  });

  it("shows the GM-only Upgrade section with current pin and entry button", async () => {
    const user = userEvent.setup();
    const api = {};
    render(
      <CampaignSettingsView
        api={api as never}
        versionsApi={versionsApi() as never}
        campaign={campaign as never}
        actorId="u1"
        generation={0}
        online
        isGm
        onChanged={() => {}}
      />,
      { wrapper: wrapper() },
    );
    expect(screen.getByText(/pinned system version/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /upgrade campaign/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /upgrade campaign/i }));
    expect(await screen.findByLabelText(/exact version id/i)).toBeVisible();
  });

  it("hides the Upgrade section from players while keeping the pin row", () => {
    const api = {};
    render(
      <CampaignSettingsView
        api={api as never}
        versionsApi={versionsApi() as never}
        campaign={campaign as never}
        actorId="u2"
        generation={0}
        online
        isGm={false}
        onChanged={() => {}}
      />,
      { wrapper: wrapper() },
    );
    expect(screen.getByText(/pinned system version/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /upgrade campaign/i })).toBeNull();
    expect(screen.queryByLabelText(/exact version id/i)).toBeNull();
  });

  it("disables the Upgrade entry offline with explanatory text", () => {
    const api = {};
    render(
      <CampaignSettingsView
        api={api as never}
        versionsApi={versionsApi() as never}
        campaign={campaign as never}
        actorId="u1"
        generation={0}
        online={false}
        isGm
        onChanged={() => {}}
      />,
      { wrapper: wrapper() },
    );
    expect(screen.getByRole("button", { name: /upgrade campaign/i })).toBeDisabled();
    expect(screen.getByText(/you are offline\. reconnect to commit this upgrade\./i)).toBeVisible();
  });

  it("disables the Upgrade entry when the versions handle is absent", () => {
    const api = {};
    render(
      <CampaignSettingsView
        api={api as never}
        campaign={campaign as never}
        actorId="u1"
        generation={0}
        online
        isGm
        onChanged={() => {}}
      />,
      { wrapper: wrapper() },
    );
    expect(screen.getByRole("button", { name: /upgrade campaign/i })).toBeDisabled();
  });

  it("invalidates roster/content/campaign reads after the upgrade commits", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    const api = {
      previewUpgrade: vi.fn().mockResolvedValue(previewResponse()),
      commitUpgrade: vi.fn().mockResolvedValue(commitResult),
    };
    const onChanged = vi.fn();
    render(
      <CampaignSettingsView
        api={api as never}
        versionsApi={versionsApi() as never}
        campaign={campaign as never}
        actorId="u1"
        generation={0}
        online
        isGm
        onChanged={onChanged}
      />,
      { wrapper: wrapper(client) },
    );
    await user.click(screen.getByRole("button", { name: /upgrade campaign/i }));
    await user.click(await screen.findByRole("button", { name: /d20 2\.0\.0/i }));
    expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /commit upgrade/i }));
    await vi.waitFor(() => expect(api.commitUpgrade).toHaveBeenCalledTimes(1));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "characters", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "content", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "activity", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "session", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "detail", "c1"] });
    expect(onChanged).toHaveBeenCalled();
  });

  it("degrades to exact-ID-only mode when the pin is outside the catalog", async () => {
    const user = userEvent.setup();
    const linkOnlyVersionsApi = {
      listCreationVersions: vi.fn().mockResolvedValue({
        data: {
          versions: [
            { versionId: "other", systemId: "sys-b", systemName: "Other", semanticVersion: "3.0.0", createdAt: "2026-09-03T00:00:00Z" },
          ],
          nextCursor: null,
        },
        requestId: "r",
      }),
    };
    const api = {};
    render(
      <CampaignSettingsView
        api={api as never}
        versionsApi={linkOnlyVersionsApi as never}
        campaign={campaign as never}
        actorId="u1"
        generation={0}
        online
        isGm
        onChanged={() => {}}
      />,
      { wrapper: wrapper() },
    );
    await user.click(screen.getByRole("button", { name: /upgrade campaign/i }));
    expect(await screen.findByLabelText(/exact version id/i)).toBeVisible();
    expect(await screen.findByText(/no newer versions of this system are available/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /d20/i })).toBeNull();
  });
});
