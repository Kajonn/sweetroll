import { useMutation } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { SystemWorkspace } from "./server.js";

export type SaveDraftInput = {
  systemId: string;
  expectedRevision: number | null;
  document: unknown;
};

export function useSaveDraft(client: ApiClient) {
  return useMutation({
    mutationFn: (input: SaveDraftInput) =>
      client
        .fetch<{ workspace: SystemWorkspace; requestId: string }, { expectedRevision: number | null; document: unknown }>(
          "PUT",
          `/systems/${input.systemId}/draft`,
          { body: { expectedRevision: input.expectedRevision, document: input.document } },
        )
        .then((r) => r.workspace),
  });
}
