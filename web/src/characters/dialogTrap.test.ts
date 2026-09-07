import { describe, expect, it } from "vitest";

import { captureOpener, focusFirst, focusableElements, restoreOpener } from "./dialogTrap.js";

function dialog(): HTMLDivElement {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.innerHTML = `
    <button type="button" id="outside">Outside</button>
    <div id="dialog" role="dialog">
      <button type="button" id="first">First</button>
      <button type="button" id="second" disabled>Second</button>
      <button type="button" id="third">Third</button>
    </div>`;
  document.body.appendChild(container);
  return document.getElementById("dialog") as HTMLDivElement;
}

describe("dialogTrap helpers", () => {
  it("lists only enabled focus targets in tab order", () => {
    const container = dialog();
    expect(focusableElements(container).map((element) => element.id)).toEqual(["first", "third"]);
  });

  it("moves initial focus into the dialog and restores an opener that started outside", () => {
    const container = dialog();
    (document.getElementById("outside") as HTMLButtonElement).focus();
    const opener = captureOpener();
    (document.activeElement as HTMLElement).blur();
    focusFirst(container);
    expect(document.activeElement?.id).toBe("first");
    container.remove();
    restoreOpener(opener);
    expect(document.activeElement?.id).toBe("outside");
  });

  it("parks focus on the body when the opener is gone", () => {
    const container = dialog();
    (document.getElementById("first") as HTMLButtonElement).focus();
    container.remove();
    restoreOpener(null);
    expect(document.activeElement).toBe(document.body);
  });
});
