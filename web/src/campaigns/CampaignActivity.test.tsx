import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CampaignActivityView } from "./CampaignActivity.js";

describe("CampaignActivityView", () => {
  it("shows readable actor and local date while preserving the exact event metadata", () => {
    render(<CampaignActivityView actorId="u1" events={[
      { eventId: "e1", kind: "content_created", actorId: "u1", occurredAt: "2026-09-01T12:34:00Z" },
      { eventId: "e2", kind: "roll_executed", actorId: "user-987654321", occurredAt: "2026-09-02T12:34:00Z" },
    ]} />);
    expect(screen.getByText("You")).toBeVisible();
    expect(screen.getByText(/member.*user-987/i)).toBeVisible();
    expect(screen.getAllByRole("time")).toHaveLength(2);
    expect(screen.getAllByText(/2026/)).toHaveLength(2);
    expect(screen.queryByText("2026-09-01T12:34:00Z")).toBeNull();
    expect(screen.getAllByRole("time")[0]).toHaveAttribute("datetime", "2026-09-01T12:34:00Z");
  });
});
