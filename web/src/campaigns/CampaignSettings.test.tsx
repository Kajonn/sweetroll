// web/src/campaigns/CampaignSettings.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignSettingsView } from "./CampaignSettings.js";

const campaign = {
  campaignId: "c1", ownerId: "u1", systemVersionId: "v1",
  title: "North Watch", description: "A border fort.",
  status: "active", revision: 5, accessRevision: 1, archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
};

describe("CampaignSettingsView", () => {
  it("saves title edits against the current revision with a fresh key", async () => {
    const api = { updateCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }) };
    const onChanged = vi.fn();
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={onChanged} />);
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
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^archive campaign/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm archive/i }));
    await vi.waitFor(() => expect(api.archiveCampaign).toHaveBeenCalledWith("c1", expect.objectContaining({
      expectedCampaignRevision: 5,
    })));
  });

  it("shows the pinned system version as read-only text", () => {
    const api = {};
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={() => {}} />);
    expect(screen.getByText(/pinned system version/i)).toBeVisible();
    expect(screen.getByText(/v1/)).toBeVisible();
  });
});
