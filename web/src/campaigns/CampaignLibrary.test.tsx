// web/src/campaigns/CampaignLibrary.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CampaignLibraryView } from "./CampaignLibrary.js";

describe("CampaignLibraryView", () => {
  it("links each campaign to its detail route and offers invitation entry", () => {
    render(<CampaignLibraryView
      campaigns={[{ campaignId: "c1", title: "Thursday Knights", status: "active", revision: 2, accessRevision: 3, updatedAt: "2026-09-01T00:00:00Z" }]}
      hasNextPage={false} onLoadMore={() => {}} onEnterToken={() => {}} />);
    expect(screen.getByRole("link", { name: /thursday knights/i })).toHaveAttribute("href", "/campaigns/c1");
    expect(screen.getByRole("link", { name: /invitation|join/i })).toHaveAttribute("href", "/invitations");
  });
});
