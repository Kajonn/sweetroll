import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PushPolicyEditor } from "./PushPolicyEditor.js";
import type { PushPolicy } from "@sweetroll/rules";

it("adopts externally changed face lists while preserving invalid edits on unrelated renders", () => {
  const policy: PushPolicy = {
    version: "1.0",
    maxAttempts: 2,
    successThreshold: 1,
    allowOnSuccess: true,
    groups: [{ groupId: "base", lockedFaces: [1], reportedFaces: [6] }],
  };
  const props = {
    source: 'group("base", "Base", 2d6)',
    onChange: vi.fn(),
    policy,
  };
  const v = render(<PushPolicyEditor {...props} />);
  fireEvent.click(screen.getByText("Push rules"));
  fireEvent.change(screen.getByLabelText("Locked faces for Base"), {
    target: { value: "7" },
  });
  expect(screen.getByLabelText("Locked faces for Base")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  v.rerender(<PushPolicyEditor {...props} policy={structuredClone(policy)} />);
  expect(screen.getByLabelText("Locked faces for Base")).toHaveValue("7");
  v.rerender(
    <PushPolicyEditor
      {...props}
      policy={{
        ...policy,
        groups: [{ groupId: "base", lockedFaces: [2, 6], reportedFaces: [1] }],
      }}
    />,
  );
  expect(screen.getByLabelText("Locked faces for Base")).toHaveValue("2, 6");
  expect(screen.getByLabelText("Locked faces for Base")).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  expect(screen.getByLabelText("Reported faces for Base")).toHaveValue("1");
  expect(props.onChange).not.toHaveBeenCalled();
});
