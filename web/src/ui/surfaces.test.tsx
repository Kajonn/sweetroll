import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { EmptyState } from "./EmptyState.js";
import { Menu } from "./Menu.js";
import { PageHeader } from "./PageHeader.js";
import { Panel } from "./Panel.js";
import { SaveStatus, type SaveStatusState } from "./SaveStatus.js";
import { Tabs } from "./Tabs.js";

function cssText(file: string): string {
  return readFileSync(join(process.cwd(), "src/ui", file), "utf8");
}

describe("ui surface styles", () => {
  it("surfaces consume semantic aliases and dialogs/menus/tabs keep 44px targets", () => {
    const expected: Readonly<Record<string, string>> = {
      "surfaces.module.css": "var(--surface-panel)",
      "Dialog.module.css": "var(--surface-scrim)",
      "Menu.module.css": "var(--surface-overlay)",
      "Tabs.module.css": "var(--action-primary)",
      "SaveStatus.module.css": "var(--status-error)",
    };
    for (const [file, token] of Object.entries(expected)) {
      const css = cssText(file);
      expect(css).toContain(token);
      expect(css).toContain("var(--font-body)");
      expect(css).not.toContain("var(--color-");
    }
    expect(cssText("Menu.module.css")).toMatch(/\.item\s*\{[^}]*min-height:\s*44px/);
    expect(cssText("Tabs.module.css")).toMatch(/\.tab\s*\{[^}]*min-height:\s*44px/);
    expect(cssText("Dialog.module.css")).toMatch(/:focus-visible/);
    expect(cssText("Menu.module.css")).toMatch(/:focus-visible/);
  });
});

describe("Panel", () => {
  it("renders a labelled section with actions", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <Panel title="Character" actions={<Button onClick={onEdit}>Edit</Button>}>
        <p>Body text</p>
      </Panel>,
    );
    const section = screen.getByRole("region", { name: "Character" });
    expect(section).toContainElement(screen.getByText("Body text"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe("PageHeader", () => {
  it("renders title, description, and actions", () => {
    render(
      <PageHeader title="Campaign" description="Session overview" actions={<Button>New note</Button>} />,
    );
    expect(screen.getByRole("heading", { name: "Campaign" })).toBeInTheDocument();
    expect(screen.getByText("Session overview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders title, description, and action text", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <EmptyState
        title="No characters yet"
        description="Create your first character to begin."
        action={<Button onClick={onCreate}>Create character</Button>}
      />,
    );
    expect(screen.getByText("No characters yet")).toBeInTheDocument();
    expect(screen.getByText("Create your first character to begin.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create character" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe("Dialog", () => {
  it("shows title, body, and actions when open and closes via the close button", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Archive character"
        description="Archived characters stay recoverable."
        actions={<Button>Confirm archive</Button>}
      >
        <p>Dialog body</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Archive character" })).toBeInTheDocument();
    expect(screen.getByText("Archived characters stay recoverable.")).toBeInTheDocument();
    expect(screen.getByText("Dialog body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes with the Escape key", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Export">
        <p>Export body</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Export" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("sheet variant renders a dialog surface", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Roll result" variant="sheet">
        <p>2d6 = 9</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Roll result" })).toBeInTheDocument();
    expect(screen.getByText("2d6 = 9")).toBeInTheDocument();
  });

  it("links the description via aria-describedby when one is given", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Archive character" description="Archived characters stay recoverable.">
        <p>Dialog body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Archive character" });
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const description = screen.getByText("Archived characters stay recoverable.");
    expect(describedBy?.split(" ")).toContain(description.id);
  });
});

describe("Menu", () => {
  const revealSelect = vi.fn();
  const hideSelect = vi.fn();
  const blockedSelect = vi.fn();
  const items = [
    { id: "reveal", label: "Reveal to players", onSelect: revealSelect },
    { id: "hide", label: "Hide again", onSelect: hideSelect },
    { id: "blocked", label: "Archived action", disabled: true, onSelect: blockedSelect },
  ];

  beforeEach(() => { vi.clearAllMocks(); });

  it("uses disclosure semantics: no menu roles, items are plain buttons", async () => {
    const user = userEvent.setup();
    render(<Menu label="Handout actions" items={items} />);
    await user.click(screen.getByRole("button", { name: "Handout actions" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal to players" })).toBeInTheDocument();
  });

  it("opens from the trigger, focuses items by keyboard, selects, and closes", async () => {
    const user = userEvent.setup();
    render(<Menu label="Handout actions" items={items} />);
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Handout actions" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const reveal = screen.getByRole("button", { name: "Reveal to players" });
    reveal.focus();
    expect(reveal).toHaveFocus();
    await user.click(reveal);
    expect(revealSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Reveal to players" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("dismisses with the Escape key and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Menu label="Handout actions" items={items} />);
    await user.click(screen.getByRole("button", { name: "Handout actions" }));
    expect(screen.getByRole("button", { name: "Reveal to players" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Reveal to players" })).toBeNull();
    expect(screen.getByRole("button", { name: "Handout actions" })).toHaveFocus();
  });

  it("disables blocked items", async () => {
    const user = userEvent.setup();
    render(<Menu label="Handout actions" items={items} />);
    await user.click(screen.getByRole("button", { name: "Handout actions" }));
    const blocked = screen.getByRole("button", { name: "Archived action" });
    expect(blocked).toBeDisabled();
    await user.click(blocked);
    expect(blockedSelect).not.toHaveBeenCalled();
  });
});

describe("Tabs", () => {
  const tabs = [
    { id: "sheet", label: "Sheet", content: <p>Sheet content</p> },
    { id: "activity", label: "Activity", content: <p>Activity content</p> },
  ];

  it("switches panels on click", async () => {
    const user = userEvent.setup();
    render(<Tabs tabs={tabs} ariaLabel="Character views" />);
    expect(screen.getByText("Sheet content")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Activity content")).toBeInTheDocument();
    expect(screen.queryByText("Sheet content")).toBeNull();
  });

  it("moves and selects with arrow keys", async () => {
    const user = userEvent.setup();
    render(<Tabs tabs={tabs} ariaLabel="Character views" />);
    const first = screen.getByRole("tab", { name: "Sheet" });
    await user.click(first);
    await user.keyboard("{ArrowRight}");
    const second = screen.getByRole("tab", { name: "Activity" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Sheet" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("SaveStatus", () => {
  const cases: ReadonlyArray<{ status: SaveStatusState; text: string }> = [
    { status: "idle", text: "Saved" },
    { status: "pending", text: "Unsaved changes" },
    { status: "saving", text: "Saving…" },
    { status: "conflict", text: "Conflict — review needed" },
    { status: "offline", text: "Offline — changes will sync when reconnected" },
    { status: "error", text: "Save failed" },
  ];

  it.each(cases)("renders $status with meaningful text", ({ status, text }) => {
    render(<SaveStatus status={status} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("uses alert semantics for conflict and error, status otherwise", () => {
    const { rerender } = render(<SaveStatus status="saving" />);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    rerender(<SaveStatus status="conflict" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Conflict — review needed");
    rerender(<SaveStatus status="error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("offers retry with detail text for failure states only", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<SaveStatus status="error" detail="Revision 7 expected." onRetry={onRetry} />);
    expect(screen.getByText("Revision 7 expected.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<SaveStatus status="idle" onRetry={onRetry} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
