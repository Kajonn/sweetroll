import { useMutation } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export type ExportVersionInput = {
  versionId: string;
  filename: string;
};

export function useExportVersion(client: ApiClient) {
  return useMutation({
    mutationFn: async (input: ExportVersionInput) => {
      const data = await client.fetch<unknown>(
        "GET",
        `/system-versions/${input.versionId}/export`,
      );
      const text = JSON.stringify(data, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = input.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return data;
    },
  });
}
