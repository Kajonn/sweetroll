import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useShortcut } from "./useShortcut.js";

function Probe({ combo, onFire }: { combo: string; onFire: () => void }) {
  useShortcut(combo, onFire);
  return <input aria-label="t" />;
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
});