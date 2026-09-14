import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export type SharingValue = "private" | "link" | "public";

export type ChangeSharingInput = {
  systemId: string;
  access: SharingValue;
};

export function useChangeSharing(client: ApiClient) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangeSharingInput) =>
      client.fetch("PATCH", `/systems/${input.systemId}`, { body: { access: input.access } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["system", "library"] });
    },
  });
}
