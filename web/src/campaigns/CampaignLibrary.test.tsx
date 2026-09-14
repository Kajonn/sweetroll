// web/src/campaigns/CampaignLibrary.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppRouter, resetAppRouter } from "../shell/appNavigation.js";
import { CampaignLibraryView } from "./CampaignLibrary.js";

describe("CampaignLibraryView", () => {
  afterEach(() => {
    resetAppRouter();
  });

  it("links each campaign to its detail route and offers invitation entry", () => {
    render(<CampaignLibraryView
      campaigns={[{ campaignId: "c1", title: "Thursday Knights", status: "active", revision: 2, accessRevision: 3, updatedAt: "2026-09-01T00:00:00Z" }]}
      hasNextPage={false} onLoadMore={() => {}} onEnterToken={() => {}} onCreateCampaign={() => {}} />);
    expect(screen.getByRole("link", { name: /thursday knights/i })).toHaveAttribute("href", "/campaigns/c1");
    expect(screen.getByRole("link", { name: /invitation|join/i })).toHaveAttribute("href", "/invitations");
    expect(screen.getByRole("link", { name: /new campaign/i })).toHaveAttribute("href", "/campaigns/new");
  });

  it("client-navigates the row link", async () => {
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<CampaignLibraryView
      campaigns={[{ campaignId: "c1", title: "Thursday Knights", status: "active", revision: 2, accessRevision: 3, updatedAt: "2026-09-01T00:00:00Z" }]}
      hasNextPage={false} onLoadMore={() => {}} onEnterToken={() => {}} onCreateCampaign={() => {}} />);
    await userEvent.setup().click(screen.getByRole("link", { name: /thursday knights/i }));
    expect(push).toHaveBeenCalledWith("/campaigns/c1");
  });
});
