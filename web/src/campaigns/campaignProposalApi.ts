import type { ApiClient } from "../api/client.js";
import type { operations } from "../api/schema.js";
export type CampaignProposal =
  operations["get_campaigns_id_item_proposals_proposalId"]["responses"]["200"]["content"]["application/json"]["proposal"];
export type ProposalSubmitBody = NonNullable<
  operations["post_campaigns_id_item_proposals"]["requestBody"]
>["content"]["application/json"];
export type ProposalDecisionBody = NonNullable<
  operations["post_campaigns_id_item_proposals_proposalId_reject"]["requestBody"]
>["content"]["application/json"];
export type CampaignProposalsApi = {
  list(
    campaignId: string,
    input?: { cursor?: string | null },
    signal?: AbortSignal,
  ): Promise<{ proposals: CampaignProposal[]; nextCursor: string | null }>;
  submit(
    campaignId: string,
    body: ProposalSubmitBody,
  ): Promise<{ proposal: CampaignProposal }>;
  approve(
    campaignId: string,
    proposalId: string,
    body: ProposalDecisionBody,
  ): Promise<{ proposal: CampaignProposal }>;
  reject(
    campaignId: string,
    proposalId: string,
    body: ProposalDecisionBody,
  ): Promise<{ proposal: CampaignProposal }>;
};
export function createCampaignProposalsApi(
  client: ApiClient,
): CampaignProposalsApi {
  const path = (id: string) => `/campaigns/${id}/item-proposals`;
  return {
    list: (id, input, signal) =>
      client.fetch("GET", path(id), {
        query: { limit: 25, cursor: input?.cursor ?? undefined },
        ...(signal ? { signal } : {}),
      }),
    submit: (id, body) => client.fetch("POST", path(id), { body }),
    approve: (id, p, body) =>
      client.fetch("POST", `${path(id)}/${p}/approve`, { body }),
    reject: (id, p, body) =>
      client.fetch("POST", `${path(id)}/${p}/reject`, { body }),
  };
}
