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

describe("CampaignSettingsView", () => {
  it("does not offer campaign version upgrades", () => {
    const api = { listDisplayCredentials: vi.fn().mockResolvedValue({ credentials: [], requestId: "r" }) };
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} isGm />, { wrapper: wrapper() });
    expect(screen.queryByRole("button", { name: /upgrade/i })).not.toBeInTheDocument();
  });

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
});

describe("CampaignSettingsView display pairing", () => {
  function displayApi(overrides = {}) {
    return {
      pairDisplay: vi.fn().mockResolvedValue({ code: "ABC123", requestId: "r" }),
      listDisplayCredentials: vi.fn().mockResolvedValue({
        displays: [
          { displayId: "d1", campaignId: "c1", revokedAt: null, createdAt: "2026-09-01T00:00:00Z" },
        ],
        requestId: "r2",
      }),
      revokeDisplay: vi.fn().mockResolvedValue({ display: { displayId: "d1" }, requestId: "r3" }),
      ...overrides,
    };
  }

  function renderDisplaySettings(api: unknown, extra = {}) {
    return render(
      <CampaignSettingsView
        api={api as never}
        campaign={campaign as never}
        actorId="u1"
        generation={0}
        online
        isGm
        onChanged={() => {}}
        {...extra}
      />,
      { wrapper: wrapper() },
    );
  }

  it("shows the pair code once with credential list + revoke", async () => {
    const user = userEvent.setup();
    const api = displayApi();
    const onChanged = vi.fn();
    renderDisplaySettings(api, { onChanged });
    expect(await screen.findByText(/display d1/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /pair display/i }));
    expect(await screen.findByText("ABC123")).toBeVisible();
    expect(api.pairDisplay).toHaveBeenCalledWith("c1");
    await user.click(screen.getByRole("button", { name: /^done$/i }));
    expect(screen.queryByText("ABC123")).toBeNull();
    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await vi.waitFor(() => expect(api.revokeDisplay).toHaveBeenCalledWith("c1", "d1"));
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText(/display revoked/i)).toBeVisible();
  });

  it("hides the Display section from players", () => {
    renderDisplaySettings(displayApi(), { isGm: false });
    expect(screen.queryByRole("button", { name: /pair display/i })).toBeNull();
    expect(screen.queryByText(/restricted display/i)).toBeNull();
  });

  it("disables pairing offline with explanatory text", () => {
    render(
      <CampaignSettingsView
        api={displayApi() as never}
        campaign={campaign as never}
        actorId="u1"
        generation={0}
        online={false}
        isGm
        onChanged={() => {}}
      />,
      { wrapper: wrapper() },
    );
    expect(screen.getByRole("button", { name: /pair display/i })).toBeDisabled();
    expect(screen.getByText(/you are offline\. reconnect to pair or revoke displays\./i)).toBeVisible();
  });
});
