// web/src/campaigns/CampaignContent.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { audienceLabel, CampaignContentView } from "./CampaignContent.js";

describe("audienceLabel", () => {
  it("names the audience in plain language for every level", () => {
    expect(audienceLabel("gm_only")).toMatch(/gm|game master/i);
    expect(audienceLabel("all_players")).toMatch(/all players|everyone/i);
    expect(audienceLabel("selected_players")).toMatch(/selected|specific/i);
    expect(audienceLabel("owner_only")).toMatch(/only you|private/i);
  });
});

describe("CampaignContentView", () => {
  it("renders persistent audience markings and hides revoked notes", () => {
    render(<CampaignContentView items={[
      { contentId: "n1", title: "Map", audience: "all_players", revision: 1, status: "active" },
      { contentId: "n2", title: "Secret", audience: "gm_only", revision: 1, status: "active" },
    ] as never} revokedIds={new Set(["n2"])} onOpenContent={() => {}} />);
    expect(screen.getByText(/all players|everyone/i)).toBeVisible();
    expect(screen.queryByText("Secret")).toBeNull();
  });
});
