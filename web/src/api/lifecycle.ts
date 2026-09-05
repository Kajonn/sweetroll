import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export type LifecycleValue = "active" | "archived";

export type ChangeLifecycleInput = {
  systemId: string;
  lifecycle: LifecycleValue;
};

export function useChangeLifecycle(client: ApiClient) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangeLifecycleInput) =>
      client.fetch("PATCH", `/systems/${input.systemId}`, { body: { lifecycle: input.lifecycle } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["system", "library"] });
    },
  });
}