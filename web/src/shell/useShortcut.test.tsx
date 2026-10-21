import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useShortcut } from "./useShortcut.js";

function Probe({ combo, onFire }: { combo: string; onFire: () => void }) {
  useShortcut(combo, onFire);
  return (
    <>
      <input aria-label="t" />
      <select aria-label="selection"><option value="one">One</option></select>
    </>
  );
}

describe("useShortcut", () => {
  it("fires on the matching combo", async () => {
    const fire = vi.fn();
    render(<Probe combo="j" onFire={fire} />);
    await userEvent.keyboard("j");
    expect(fire).toHaveBeenCalled();
  });


  it("ignores typing inside an input", async () => {
    const fire = vi.fn();
    const { getByLabelText } = render(<Probe combo="j" onFire={fire} />);
    await userEvent.type(getByLabelText("t"), "j");
    expect(fire).not.toHaveBeenCalled();
  });

  it("does not intercept native select shortcuts", () => {
    const fire = vi.fn();
    const { getByLabelText } = render(<Probe combo="Alt+ArrowDown" onFire={fire} />);
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });

    getByLabelText("selection").dispatchEvent(event);

    expect(fire).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});