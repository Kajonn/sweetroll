import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export type Template = {
  templateId: string;
  label: string;
  versionId: string;
};

export type ListTemplatesResult = { templates: Template[]; requestId: string };

export function useListTemplates(
  client: ApiClient,
  options: { enabled?: boolean } = {},
): UseQueryResult<Template[]> {
  return useQuery({
    queryKey: ["system", "templates"],
    queryFn: async () =>
      client
        .fetch<ListTemplatesResult>("GET", "/templates")
        .then((r) => r.templates),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}