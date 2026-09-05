import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export type DeprecateVersionInput = {
  versionId: string;
};

export type DeprecateVersionResult = {
  lifecycle: { kind: "version"; versionId: string; systemId: string; lifecycle: string };
  requestId: string;
};

export function useDeprecateVersion(client: ApiClient) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeprecateVersionInput) =>
      client
        .fetch<DeprecateVersionResult>("PATCH", `/system-versions/${input.versionId}`, {
          body: { lifecycle: "deprecated" },
        })
        .then((r) => r.lifecycle),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["system", "versions", data.systemId] });
      void qc.invalidateQueries({ queryKey: ["system", "open", data.systemId] });
    },
  });
}
