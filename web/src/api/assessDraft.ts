import { useMutation } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { PreviewSnapshot } from "./server.js";

export type AssessDraftResult = {
  snapshot: PreviewSnapshot;
  requestId: string;
};

export function useAssessDraft(client: ApiClient) {
  return useMutation({
    mutationFn: (systemId: string) =>
      client.fetch<AssessDraftResult>("POST", `/systems/${systemId}/preview`),
  });
}
