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
