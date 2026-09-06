import { useMutation } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { PublishedVersion } from "./server.js";

export type PublishInput = {
  systemId: string;
  expectedRevision: number;
  semanticVersion: string;
  releaseNotes: string;
  idempotencyKey: string;
  acknowledgeBreaking: boolean;
};

export type PublishResult = PublishedVersion;

export type PublishResponse = { version: PublishedVersion; requestId: string };

export function usePublish(client: ApiClient) {
  return useMutation({
    mutationFn: (input: PublishInput) =>
      client
        .fetch<
          PublishResponse,
          {
            expectedRevision: number;
            semanticVersion: string;
            releaseNotes: string;
            idempotencyKey: string;
            acknowledgeBreaking: boolean;
          }
        >("POST", `/systems/${input.systemId}/publish`, {
          body: {
            expectedRevision: input.expectedRevision,
            semanticVersion: input.semanticVersion,
            releaseNotes: input.releaseNotes,
            idempotencyKey: input.idempotencyKey,
            acknowledgeBreaking: input.acknowledgeBreaking,
          },
        })
        .then((r) => r.version),
  });
}
