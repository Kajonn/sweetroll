import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlayEventHost, PlayEventOverlay, usePlayEvents, type PlayEvents } from "./PlayEvents.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let latest: PlayEvents;
function View({ scope }: { scope: string }) {
  latest = usePlayEvents(scope);
  return <>
    <button onClick={() => latest.publish([{ id: "a", text: "You rolled 12" }])}>Roll</button>
    <PlayEventOverlay events={latest} />
  </>;
}

it("keeps focus and announces a burst once while each card expires", () => {
  vi.useFakeTimers();
  render(<PlayEventHost lifetime="a:1"><View scope="campaign" /></PlayEventHost>);
  const button = screen.getByRole("button", { name: "Roll" });
  button.focus();
  fireEvent.click(button);
  act(() => latest.publish([{ id: "b", text: "Pat rolled 12" }, { id: "c", text: "You drew the Star" }]));
  expect(button).toHaveFocus();
  const events = within(screen.getByRole("list", { name: "Recent play events" }));
  expect(events.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getAllByRole("status")).toHaveLength(1);
  act(() => vi.advanceTimersByTime(150));
  expect(screen.getByRole("status")).toHaveTextContent("You rolled 12. Pat rolled 12. You drew the Star");
  act(() => vi.advanceTimersByTime(5850));
  expect(events.getAllByRole("listitem")[0]).toHaveAttribute("data-fading", "true");
  act(() => vi.advanceTimersByTime(240));
  expect(screen.queryByRole("list")).toBeNull();
});

it("drops old scoped publishers and removes cards at the deadline in reduced motion", () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const ui = render(<PlayEventHost lifetime="a:1"><View scope="campaign" /></PlayEventHost>);
  fireEvent.click(screen.getByRole("button", { name: "Roll" }));
  const oldPublisher = latest.publish;
  ui.rerender(<PlayEventHost lifetime="a:1"><View scope="other" /></PlayEventHost>);
  act(() => oldPublisher([{ id: "late", text: "Old campaign" }]));
  expect(screen.queryByRole("list")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Roll" }));
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("list")).toBeNull();
});
