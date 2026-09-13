// web/src/campaigns/UpgradeDialog.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UpgradeDialog } from "./UpgradeDialog.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const catalogVersions = [
  { versionId: "v1", systemId: "sys-a", systemName: "D20", semanticVersion: "1.0.0", createdAt: "2026-09-01T00:00:00Z" },
  { versionId: "v2", systemId: "sys-a", systemName: "D20", semanticVersion: "2.0.0", createdAt: "2026-09-02T00:00:00Z" },
  { versionId: "v0", systemId: "sys-a", systemName: "D20", semanticVersion: "0.9.0", createdAt: "2026-08-01T00:00:00Z" },
  { versionId: "vx", systemId: "sys-b", systemName: "Other", semanticVersion: "3.0.0", createdAt: "2026-09-03T00:00:00Z" },
];

function previewResponse(overrides = {}) {
  return {
    campaignId: "c1",
    campaignRevision: 7,
    sourceVersionId: "v1",
    targetVersionId: "v2",
    targetSemanticVersion: "2.0.0",
    characters: [
      {
        characterId: "s1",
        name: "Bram",
        sourceVersionId: "v1",
        warnings: ['Source field(s) "nickname" have no target and will be dropped.'],
        requiresMapping: true,
      },
      {
        characterId: "s2",
        name: "Wren",
        sourceVersionId: "v1",
        warnings: [],
        requiresMapping: false,
      },
    ],
    requestId: "r",
    ...overrides,
  };
}

const commitResult = {
  campaignId: "c1",
  campaignRevision: 8,
  sourceVersionId: "v1",
  targetVersionId: "v2",
  migratedCharacterIds: ["s1", "s2"],
  requestId: "r2",
};

function fakes(overrides: { preview?: unknown; commit?: unknown } = {}) {
  const versionsApi = {
    listCreationVersions: vi.fn().mockResolvedValue({
      data: { versions: catalogVersions, nextCursor: null },
      requestId: "r",
    }),
  };
  const api = {
    previewUpgrade: vi.fn().mockResolvedValue(overrides.preview ?? previewResponse()),
    commitUpgrade: vi.fn().mockResolvedValue(overrides.commit ?? commitResult),
  };
  return { api, versionsApi };
}

function dialogProps(overrides = {}) {
  return {
    campaignId: "c1",
    actorId: "u1",
    generation: 0,
    target: "v2",
    systemId: "sys-a",
    sourceSemanticVersion: "1.0.0",
    online: true,
    onClose: () => {},
    onCommitted: () => {},
    ...overrides,
  };
}

describe("UpgradeDialog", () => {
  it("lists newer same-system versions as targets, hiding older, current, and other-system entries", async () => {
    const { api, versionsApi } = fakes();
    render(
      <UpgradeDialog api={api as never} versionsApi={versionsApi as never} {...dialogProps()} />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByRole("button", { name: /d20 2\.0\.0/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /d20 1\.0\.0/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /d20 0\.9\.0/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /other 3\.0\.0/i })).toBeNull();
  });

  it("shows the before/after pin and per-character warnings with mapping flags", async () => {
    const { api, versionsApi } = fakes();
    render(
      <UpgradeDialog api={api as never} versionsApi={versionsApi as never} {...dialogProps()} />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
    expect(await screen.findByText(/have no target and will be dropped/)).toBeVisible();
    const flags = await screen.findAllByText(/requires explicit mapping/i);
    expect(flags).toHaveLength(1);
    expect(screen.getByText(/wren/i)).toBeVisible();
  });

  it("keeps commit disabled until explicit confirmation", async () => {
    const { api, versionsApi } = fakes();
    const user = userEvent.setup();
    render(
      <UpgradeDialog api={api as never} versionsApi={versionsApi as never} {...dialogProps()} />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
    expect(screen.getByRole("button", { name: /commit upgrade/i })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    expect(screen.getByRole("button", { name: /commit upgrade/i })).toBeEnabled();
  });

  it("commits with a fresh key and reports the new pin through onCommitted", async () => {
    const { api, versionsApi } = fakes();
    const user = userEvent.setup();
    const onCommitted = vi.fn();
    render(
      <UpgradeDialog
        api={api as never}
        versionsApi={versionsApi as never}
        {...dialogProps({ onCommitted })}
      />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /commit upgrade/i }));
    await vi.waitFor(() => expect(api.commitUpgrade).toHaveBeenCalledTimes(1));
    const [campaignId, body] = (api.commitUpgrade as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(campaignId).toBe("c1");
    expect(body.targetVersionId).toBe("v2");
    expect(body.expectedCampaignRevision).toBe(7);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onCommitted).toHaveBeenCalledWith(commitResult);
    expect(await screen.findByText(/upgraded to 2\.0\.0/i)).toBeVisible();
  });

  it("retries a revision-race 409 against a fresh preview with a fresh key, never revision + 1", async () => {
    const freshPreview = previewResponse({ campaignRevision: 9, requestId: "r-fresh" });
    const api = {
      previewUpgrade: vi
        .fn()
        .mockResolvedValueOnce(previewResponse())
        .mockResolvedValue(freshPreview),
      commitUpgrade: vi
        .fn()
        .mockRejectedValueOnce({
          code: "conflict",
          status: 409,
          message: "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
        })
        .mockResolvedValue(commitResult),
    };
    const versionsApi = {
      listCreationVersions: vi.fn().mockResolvedValue({
        data: { versions: catalogVersions, nextCursor: null },
        requestId: "r",
      }),
    };
    const user = userEvent.setup();
    render(
      <UpgradeDialog api={api as never} versionsApi={versionsApi as never} {...dialogProps()} />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /commit upgrade/i }));
    expect(await screen.findByText(/campaign changed — review fresh preview/i)).toBeVisible();
    // The fresh preview resets the gate: commit stays disabled until re-confirmed.
    expect(screen.getByRole("button", { name: /commit upgrade/i })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /commit upgrade/i }));
    await vi.waitFor(() => expect(api.commitUpgrade).toHaveBeenCalledTimes(2));
    const calls = (api.commitUpgrade as ReturnType<typeof vi.fn>).mock.calls;
    const [first, second] = [calls[0]![1], calls[1]![1]];
    expect(first.expectedCampaignRevision).toBe(7);
    expect(second.expectedCampaignRevision).toBe(9);
    expect(typeof second.idempotencyKey).toBe("string");
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("removes dialog content with generic unavailability on 404", async () => {
    const { api, versionsApi } = fakes();
    api.commitUpgrade.mockRejectedValue({
      code: "not_found",
      status: 404,
      message: "gone",
    });
    const user = userEvent.setup();
    render(
      <UpgradeDialog api={api as never} versionsApi={versionsApi as never} {...dialogProps()} />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /commit upgrade/i }));
    expect(await screen.findByText(/campaign is unavailable/i)).toBeVisible();
    expect(screen.queryByText(/1\.0\.0 → 2\.0\.0/)).toBeNull();
    expect(screen.queryByRole("button", { name: /commit upgrade/i })).toBeNull();
  });

  it("renders terminal archived-campaign failures with no retry action", async () => {
    const { api, versionsApi } = fakes();
    api.commitUpgrade.mockRejectedValue({
      code: "conflict",
      status: 409,
      message: "Archived campaigns reject upgrades until recovered.",
    });
    const user = userEvent.setup();
    render(
      <UpgradeDialog api={api as never} versionsApi={versionsApi as never} {...dialogProps()} />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /commit upgrade/i }));
    expect(await screen.findByText(/archived campaigns reject upgrades/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /commit upgrade/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("gates mutations offline without fetching a preview", async () => {
    const { api, versionsApi } = fakes();
    render(
      <UpgradeDialog
        api={api as never}
        versionsApi={versionsApi as never}
        {...dialogProps({ online: false })}
      />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByText(/offline/i)).toBeVisible();
    expect(api.previewUpgrade).not.toHaveBeenCalled();
    const commit = screen.queryByRole("button", { name: /commit upgrade/i });
    expect(commit === null || commit.hasAttribute("disabled")).toBe(true);
  });

  it("maps a malformed exact version ID to a definite input error without previewing", async () => {
    const { api, versionsApi } = fakes();
    const user = userEvent.setup();
    render(
      <UpgradeDialog
        api={api as never}
        versionsApi={versionsApi as never}
        {...dialogProps({ target: null })}
      />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByRole("button", { name: /d20 2\.0\.0/i })).toBeVisible();
    await user.type(screen.getByLabelText(/exact version id/i), "not-a-version");
    await user.click(screen.getByRole("button", { name: /use version id/i }));
    expect(await screen.findByText(/enter a valid version id/i)).toBeVisible();
    expect(api.previewUpgrade).not.toHaveBeenCalled();
  });

  it("previews an exact version ID entered manually", async () => {
    const { api, versionsApi } = fakes();
    const user = userEvent.setup();
    const exactId = "12345678-1234-4000-8000-000000000009";
    render(
      <UpgradeDialog
        api={api as never}
        versionsApi={versionsApi as never}
        {...dialogProps({ target: null })}
      />,
      { wrapper: wrapper() },
    );
    expect(await screen.findByRole("button", { name: /d20 2\.0\.0/i })).toBeVisible();
    await user.type(screen.getByLabelText(/exact version id/i), exactId);
    await user.click(screen.getByRole("button", { name: /use version id/i }));
    await vi.waitFor(() =>
      expect(api.previewUpgrade).toHaveBeenCalledWith("c1", { targetVersionId: exactId }),
    );
  });
});
