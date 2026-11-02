import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { TemplateSharing } from "./TemplateSharing.js";
it("requires explicit reveal and retries the exact uncertain request", async () => {
  const user = userEvent.setup();
  const share = vi
    .fn()
    .mockRejectedValueOnce(Error("response lost"))
    .mockResolvedValue({ template: {} });
  const done = vi.fn();
  render(
    <TemplateSharing
      template={
        {
          templateId: "key",
          revision: 2,
          audience: "gm_only",
          grants: [],
        } as any
      }
      members={[]}
      share={share}
      onDone={done}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Sharing" }));
  await user.selectOptions(screen.getByLabelText("Audience"), "all_players");
  expect(
    screen.getByText(/Existing sheet copies cannot be recalled/),
  ).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Reveal to all players" }),
  );
  await screen.findByRole("button", { name: "Retry exact request" });
  await user.click(screen.getByRole("button", { name: "Retry exact request" }));
  await waitFor(() => expect(done).toHaveBeenCalled());
  expect(share.mock.calls[1]).toEqual(share.mock.calls[0]);
  expect(share.mock.calls[0]![0]).toMatchObject({
    expectedTemplateRevision: 2,
    audience: "all_players",
    grants: [],
  });
});

it("labels recipients by name with stable disambiguation and submits only IDs and generations", async () => {
  const user = userEvent.setup();
  const share = vi.fn().mockResolvedValue({});
  const members = [
    { userId: "11111111-1111-4111-8111-111111111111", generation: 1, role: "player", status: "active", displayName: "Alex" },
    { userId: "22222222-2222-4222-8222-222222222222", generation: 3, role: "player", status: "active", displayName: "Alex" },
    { userId: "33333333-3333-4333-8333-333333333333", generation: 1, role: "player", status: "active", displayName: null },
  ];
  render(<TemplateSharing template={{ revision: 1, audience: "gm_only", grants: [] } as any} members={members} share={share} onDone={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Sharing" }));
  await user.selectOptions(screen.getByLabelText("Audience"), "selected_players");
  await user.click(screen.getByRole("checkbox", { name: `Alex (${members[1]!.userId})` }));
  expect(screen.getByRole("checkbox", { name: `Unnamed player (${members[2]!.userId})` })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save sharing" }));
  expect(share).toHaveBeenCalledWith(expect.objectContaining({ grants: [{ userId: members[1]!.userId, generation: 3 }] }));
});
