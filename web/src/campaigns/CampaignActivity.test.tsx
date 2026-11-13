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

  it("shows the result text of a roll the server included and nothing for other events", () => {
    render(<CampaignActivityView actorId="u1" events={[
      { eventId: "e1", kind: "roll_executed", actorId: "u2", occurredAt: "2026-11-12T12:34:00Z", rollOutput: "Read the omens: Crown of Ember, First of Tide" },
      { eventId: "e2", kind: "roll_executed", actorId: "u2", occurredAt: "2026-11-12T12:35:00Z", rollOutput: null },
      { eventId: "e3", kind: "content_created", actorId: "u1", occurredAt: "2026-11-12T12:36:00Z" },
    ]} />);
    expect(screen.getAllByTestId("activity-roll-output")).toHaveLength(1);
    expect(screen.getByText("Read the omens: Crown of Ember, First of Tide")).toBeVisible();
  });
});
