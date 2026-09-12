// web/src/campaigns/ContentEditor.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentEditor } from "./ContentEditor.js";

const members = [
  { campaignId: "c1", userId: "u2", role: "player", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
];

describe("ContentEditor", () => {
  it("creates a note with audience and fresh idempotency key", async () => {
    const api = { createContent: vi.fn().mockResolvedValue({ content: { contentId: "n1" }, requestId: "r" }) };
    const onSaved = vi.fn();
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} onSaved={onSaved} onDeleted={() => {}} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Briefing" } });
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "Meet at dusk." } });
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));
    await vi.waitFor(() => expect(api.createContent).toHaveBeenCalled());
    expect(api.createContent).toHaveBeenCalledWith("c1", expect.objectContaining({
      title: "Briefing",
      body: "Meet at dusk.",
      audience: "gm_only",
    }));
    const body = (api.createContent as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onSaved).toHaveBeenCalled();
  });

  it("replaces grants with the complete checked set", async () => {
    const api = { replaceContentGrants: vi.fn().mockResolvedValue({ content: {}, requestId: "r" }) };
    const initial = { contentId: "n1", campaignId: "c1", audience: "selected_players", title: "Plan", body: "Shh.", tags: [], revision: 3, grantedUserIds: [] };
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} initial={initial as never} onSaved={() => {}} onDeleted={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /u2/i }));
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));
    await vi.waitFor(() => expect(api.replaceContentGrants).toHaveBeenCalledWith("n1", expect.objectContaining({
      grantedUserIds: ["u2"],
      expectedContentRevision: 3,
    })));
  });

  it("hides a note behind a confirmation dialog", async () => {
    const api = { deleteContent: vi.fn().mockResolvedValue({ content: {}, requestId: "r" }) };
    const initial = { contentId: "n1", campaignId: "c1", audience: "all_players", title: "Plan", body: "Shh.", tags: [], revision: 3, grantedUserIds: [] };
    const onDeleted = vi.fn();
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} initial={initial as never} onSaved={() => {}} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /hide /i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm hiding/i }));
    await vi.waitFor(() => expect(api.deleteContent).toHaveBeenCalledWith("n1", expect.objectContaining({
      expectedContentRevision: 3,
    })));
    expect(onDeleted).toHaveBeenCalled();
  });
});
