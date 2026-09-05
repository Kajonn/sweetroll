import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient, type ApiClient } from "../../api/client.js";
import { ExpressionEditor, type ExpressionEditorProps } from "./ExpressionEditor.js";

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setupFetch(responses: Array<() => Response>): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const resp = responses[i] ?? responses[responses.length - 1];
    if (resp === undefined) throw new Error("no response configured");
    i += 1;
    return resp();
  });
}

type RenderOptions = Omit<Partial<ExpressionEditorProps>, "client"> & {
  fetch_?: ReturnType<typeof vi.fn>;
};

function renderEditor(options: RenderOptions = {}) {
  const { fetch_, ...rest } = options;
  const onSourceChange = vi.fn();
  const fetcher =
    fetch_ ??
    setupFetch([
      () =>
        new Response(
          JSON.stringify({
            snapshot: {
              snapshotId: "snap-1",
              systemId: "s1",
              sourceRevision: 5,
              package: { expressions: [] },
              expiresAt: "2026-01-01T00:00:00Z",
            },
            requestId: "r",
          }),
          { status: 200 },
        ),
    ]);
  const client: ApiClient = createApiClient({ baseUrl: "http://x", fetch: fetcher as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props: ExpressionEditorProps = {
    client,
    systemId: "s1",
    source: "",
    onSourceChange,
    ...rest,
  };
  const view = render(<ExpressionEditor {...props} />, { wrapper: makeWrapper(qc) });
  return { ...view, onSourceChange, fetch_: fetcher, client };
}

describe("ExpressionEditor", () => {
  it("renders the source textarea and Check button", () => {
    renderEditor();
    expect(screen.getByTestId("expression-editor-source")).toBeInTheDocument();
    expect(screen.getByTestId("expression-editor-check")).toBeInTheDocument();
  });

  it("renders a live tokenizer diagnostic when bad input is typed", async () => {
    const fetch_ = setupFetch([]);
    const client: ApiClient = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSourceChange = vi.fn();
    const view = render(
      <ExpressionEditor client={client} systemId="s1" source="" onSourceChange={onSourceChange} />,
      { wrapper: makeWrapper(qc) },
    );
    expect(screen.getByTestId("expression-editor-live-no-issues")).toBeInTheDocument();
    view.rerender(
      <ExpressionEditor client={client} systemId="s1" source="$" onSourceChange={onSourceChange} />,
    );
    expect(screen.getByTestId("expression-editor-live-diagnostic")).toBeInTheDocument();
    expect(screen.getByTestId("expression-editor-live-diagnostic")).toHaveAttribute(
      "data-code",
      "invalid_syntax",
    );
  });

  it("renders a limit_exceeded diagnostic from /preview when the server rejects the draft", async () => {
    const fetch_ = setupFetch([
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_package",
              message: "Package too large",
              diagnostics: [
                { code: "limit_exceeded", path: "expressions[0]", message: "expression exceeds node budget" },
              ],
            },
            requestId: "r",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    ]);
    const { onSourceChange } = renderEditor({ fetch_ });
    const button = screen.getByTestId("expression-editor-check");
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByTestId("expression-editor-server-diagnostic")).toBeInTheDocument();
    });
    expect(screen.getByTestId("expression-editor-server-diagnostic")).toHaveAttribute(
      "data-code",
      "limit_exceeded",
    );
    expect(onSourceChange).not.toHaveBeenCalled();
  });

  it("renders the AST and dependency list when preview succeeds", async () => {
    const fetch_ = setupFetch([
      () =>
        new Response(
          JSON.stringify({
            snapshot: {
              snapshotId: "snap-1",
              systemId: "s1",
              sourceRevision: 5,
              package: {
                expressions: [
                  {
                    id: "modifier",
                    context: "computed",
                    resultType: "number",
                    inferredType: "number",
                    fallback: 0,
                    dependencies: ["base"],
                    cost: 3,
                    ast: {
                      kind: "binary",
                      operator: "+",
                      left: { kind: "numberLiteral", value: 2 },
                      right: { kind: "reference", scope: "fields", id: "base" },
                    },
                  },
                ],
              },
              expiresAt: "2026-01-01T00:00:00Z",
            },
            requestId: "r",
          }),
          { status: 200 },
        ),
    ]);
    renderEditor({ fetch_ });
    fireEvent.click(screen.getByTestId("expression-editor-check"));
    await waitFor(() => {
      expect(screen.getByTestId("expression-editor-ast")).toBeInTheDocument();
    });
    expect(screen.getByTestId("expression-editor-ast")).toHaveTextContent("binary");
    expect(screen.getByTestId("expression-editor-dependency-list")).toHaveTextContent("base");
  });

  it("shows the 'no issues' marker when the source is empty", () => {
    renderEditor({ source: "" });
    expect(screen.getByTestId("expression-editor-live-no-issues")).toBeInTheDocument();
  });
});
