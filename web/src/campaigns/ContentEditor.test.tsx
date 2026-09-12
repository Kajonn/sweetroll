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

  it("keeps a working Recover after a Hide in-session", async () => {
    const initial = { contentId: "n1", campaignId: "c1", audience: "all_players", title: "Plan", body: "Shh.", tags: [], revision: 3, grantedUserIds: [], status: "active" };
    const deleted = { ...initial, revision: 4, status: "deleted" };
    const api = {
      deleteContent: vi.fn().mockResolvedValue({ content: {}, requestId: "r" }),
      openContent: vi.fn().mockResolvedValue({ content: deleted, requestId: "r" }),
      recoverContent: vi.fn().mockResolvedValue({ content: {}, requestId: "r" }),
    };
    const onSaved = vi.fn();
    const onDeleted = vi.fn();
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} initial={initial as never} onSaved={onSaved} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /hide /i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm hiding/i }));
    await vi.waitFor(() => expect(api.deleteContent).toHaveBeenCalled());
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalled());
    // The editor stays mounted: Recover is now offered for the deleted view.
    fireEvent.click(await screen.findByRole("button", { name: /recover /i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm recovery/i }));
    await vi.waitFor(() => expect(api.recoverContent).toHaveBeenCalledWith("n1", expect.objectContaining({
      expectedContentRevision: 4,
    })));
    expect(onSaved).toHaveBeenCalled();
  });

  it("keeps input and the conflict notice visible after a 409", async () => {
    const api = { updateContent: vi.fn().mockRejectedValue({ status: 409 }) };
    const initial = { contentId: "n1", campaignId: "c1", audience: "all_players", title: "Plan", body: "Shh.", tags: [], revision: 3, grantedUserIds: [] };
    const onSaved = vi.fn();
    const onConflicted = vi.fn();
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} initial={initial as never} onSaved={onSaved} onDeleted={() => {}} onConflicted={onConflicted} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));
    await vi.waitFor(() => expect(api.updateContent).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed.*reload/i);
    expect(onConflicted).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/title/i)).toHaveValue("New title");
  });
});
