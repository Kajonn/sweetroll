import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { memberLabel, useMemberLabel } from "./memberLabels.js";
import { setDebugMode } from "../ui/debugMode.js";

const alex = { userId: "11111111-aaaa", displayName: "Alex" };
const otherAlex = { userId: "22222222-bbbb", displayName: "Alex" };
afterEach(() => { act(() => setDebugMode(false)); localStorage.clear(); });

it("uses names and disambiguates duplicates and unnamed members", () => {
  expect(memberLabel(alex, [alex])).toBe("Alex");
  expect(memberLabel(alex, [alex, otherAlex])).toBe("Alex (11111111)");
  expect(memberLabel({ userId: "33333333-cccc", displayName: null })).toBe("Unnamed player (33333333)");
  const samePrefix = { userId: "11111111-bbbb", displayName: "Alex" };
  expect(memberLabel(alex, [alex, samePrefix])).toBe("Alex (11111111-aaaa)");
});

it("reveals full IDs in debug mode without changing identities", () => {
  function Label() { const label = useMemberLabel([alex]); return <span>{label(alex)}</span>; }
  render(<Label />);
  expect(screen.getByText("Alex")).toBeVisible();
  act(() => setDebugMode(true));
  expect(screen.getByText("Alex (11111111-aaaa)")).toBeVisible();
});
