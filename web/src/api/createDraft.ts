import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { SystemWorkspace } from "./server.js";

export type CreateDraftInput = {
  source:
    | { kind: "blank"; name: string }
    | { kind: "clone"; versionId: string }
    | { kind: "import"; content: string };
  idempotencyKey: string;
};

export function useCreateDraft(client: ApiClient) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDraftInput) =>
      client
        .fetch<{ workspace: SystemWorkspace; requestId: string }, CreateDraftInput>("POST", "/systems", { body: input })
        .then((r) => r.workspace),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["system", "library"] });
    },
  });
}