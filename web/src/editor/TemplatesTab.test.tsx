import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient, type ApiClient } from "../api/client.js";
import {
  blankDocument,
  documentReducer,
  type SystemDocumentV1,
} from "../state/documentReducer.js";
import { readSlots, readTemplates, withSlots, withTemplates } from "./sheet/slotTypes.js";
import { TemplatesTab } from "./TemplatesTab.js";

function stubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

let latest: SystemDocumentV1 | null = null;

function Harness({ initial }: { initial: SystemDocumentV1 }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client: ApiClient = createApiClient({
    baseUrl: "http://x",
    fetch: stubFetch() as typeof fetch,
  });
  const [doc, dispatch] = useReducer(documentReducer, initial);
  latest = doc;
  return (
    <QueryClientProvider client={qc}>
      <TemplatesTab document={doc} dispatch={dispatch} client={client} />
    </QueryClientProvider>
  );
}

function renderTab(initial: SystemDocumentV1 = blankDocument()) {
  latest = null;
  return render(<Harness initial={initial} />);
}

describe("TemplatesTab", () => {
  it("renders an empty state with an add-template button for an empty document", () => {
    renderTab();
    expect(screen.getByTestId("templates-tab")).toBeInTheDocument();
    expect(screen.getByTestId("templates-tab-empty")).toBeInTheDocument();
    expect(screen.getByTestId("templates-add-button")).toBeInTheDocument();
  });

  it("adds an item template exposing a label field, kind picker, and granted roll action editor", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("templates-add-button"));
    const template = readTemplates(latest ?? blankDocument())[0];
    expect(template).toBeDefined();
    expect(template?.kind).toBe("item");
    const templateId = template?.id ?? "";
    expect(screen.getByTestId(`template-label-${templateId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`template-kind-${templateId}`)).toBeInTheDocument();

    await user.click(screen.getByTestId(`template-add-roll-${templateId}`));
    const action = readTemplates(latest ?? blankDocument())[0]?.grantedActions[0];
    expect(action).toBeDefined();
    const actionId = action?.id ?? "";
    // Reuses the shared RollActionEditor component, not a copy.
    expect(screen.getByTestId(`roll-action-${actionId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`dice-kind-${actionId}`)).toBeInTheDocument();
  });

  it("keeps the granted-roll expression entry across the replace dispatch", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("templates-add-button"));
    const templateId = readTemplates(latest ?? blankDocument())[0]?.id ?? "";
    await user.click(screen.getByTestId(`template-add-roll-${templateId}`));
    const doc = latest ?? blankDocument();
    const expressionId = (
      readTemplates(doc)[0]?.grantedActions[0] as { expressionId?: string } | undefined
    )?.expressionId;
    expect(expressionId).toBeTruthy();
    // Regression net: the granted roll's expression must survive the
    // `replace` dispatch (stale-snapshot `replace` used to drop it).
    expect(doc.expressions.some((entry) => entry.id === expressionId)).toBe(true);
  });

  it("offers an eligible character attribute as the Longsword roll modifier", async () => {
    const user = userEvent.setup();
    const base = blankDocument();
    base.entities = [{ id: "hero", label: "Hero", fields: [{
      id: "might", kind: "integer", label: "Might", default: 2, required: true, min: 0, max: 20, step: 1,
    }] }];
    base.sheets = [{ id: "sheet", label: "Sheet", targetEntityId: "hero", sections: [{
      id: "gear", label: "Gear", elements: [{ kind: "slot", id: "inventory_element", slotId: "inventory" }],
    }] }];
    base.expressions = [{ id: "hit_expr", context: "roll", resultType: "number", source: "d20", fallback: 0 }];
    const withSlot = withSlots(base, [{ id: "inventory", label: "Inventory", accepts: ["item"] }]);
    renderTab(withTemplates(withSlot, [{
      id: "sword", label: "Longsword", kind: "item", fields: [],
      grantedActions: [{ kind: "roll", id: "hit", label: "Hit", expressionId: "hit_expr", inputs: [], outputTemplate: "Hit: {total}" }],
    }]));

    const modifier = screen.getByTestId("roll-field-modifier-hit");
    expect(modifier).toHaveTextContent("Might");
    await user.selectOptions(modifier, "might");
    expect(latest?.expressions[0]?.source).toBe("d20 + fields.might");
  });

  it("adds a resource-bump granted action reusing ResourceBumpEditor", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("templates-add-button"));
    const templateId = readTemplates(latest ?? blankDocument())[0]?.id ?? "";
    await user.click(screen.getByTestId(`template-add-resource-bump-${templateId}`));
    const action = readTemplates(latest ?? blankDocument())[0]?.grantedActions[0];
    expect(action?.kind).toBe("resourceBump");
    expect(screen.getByTestId(`resource-bump-action-${action?.id ?? ""}`)).toBeInTheDocument();
  });

  it("flags a granted action nominal with a {total} output hint", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("templates-add-button"));
    const templateId = readTemplates(latest ?? blankDocument())[0]?.id ?? "";
    await user.click(screen.getByTestId(`template-add-roll-${templateId}`));
    const actionId = readTemplates(latest ?? blankDocument())[0]?.grantedActions[0]?.id ?? "";
    await user.click(screen.getByTestId(`template-action-nominal-${actionId}`));
    expect(
      readTemplates(latest ?? blankDocument())[0]?.grantedActions[0],
    ).toMatchObject({ nominal: true });
    expect(screen.getByTestId(`template-action-nominal-hint-${actionId}`)).toBeInTheDocument();
  });

  it("authors slot definitions with accepts kinds and max entries", async () => {
    const user = userEvent.setup();
    renderTab();
    expect(screen.getByTestId("slots-tab-empty")).toBeInTheDocument();
    await user.click(screen.getByTestId("slots-add-button"));
    const slot = readSlots(latest ?? blankDocument())[0];
    expect(slot).toBeDefined();
    const slotId = slot?.id ?? "";
    expect(screen.getByTestId(`slot-label-${slotId}`)).toBeInTheDocument();
    await user.click(screen.getByTestId(`slot-accepts-${slotId}-spell`));
    expect(readSlots(latest ?? blankDocument())[0]?.accepts).toContain("spell");
  });
});
