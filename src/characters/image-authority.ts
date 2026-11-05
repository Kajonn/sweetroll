import type { PoolClient } from "pg";

export type CharacterImageAuthority = {
  characterId: string;
  ownerId: string | null;
  campaignId: string | null;
  revision: number;
  active: boolean;
};
export async function authorizeCharacterImage(
  client: PoolClient,
  actorId: string,
  id: string,
  lock: boolean,
): Promise<CharacterImageAuthority | null> {
  const scope = (
    await client.query<{ campaign_id: string | null }>(
      "SELECT campaign_id FROM characters WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!scope) return null;
  let campaignActive = true;
  if (scope.campaign_id !== null) {
    const campaign = (
      await client.query<{ status: string }>(
        `SELECT status FROM campaigns WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [scope.campaign_id],
      )
    ).rows[0];
    if (!campaign) return null;
    campaignActive = campaign.status === "active";
  }
  const row = (
    await client.query<{
      id: string;
      owner_id: string | null;
      campaign_id: string | null;
      revision: number;
      lifecycle: string;
    }>(
      `SELECT id,owner_id,campaign_id,revision,lifecycle FROM characters WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!row || row.campaign_id !== scope.campaign_id) return null;
  if (row.campaign_id === null) {
    if (row.owner_id !== actorId) return null;
  } else {
    const member = (
      await client.query<{ role: string; status: string }>(
        "SELECT role,status FROM campaign_members WHERE campaign_id=$1 AND user_id=$2",
        [row.campaign_id, actorId],
      )
    ).rows[0];
    if (!member || member.status !== "active") return null;
    if (member.role !== "owner" && member.role !== "co_gm") {
      const controller = await client.query(
        "SELECT 1 FROM character_controllers WHERE character_id=$1 AND user_id=$2",
        [id, actorId],
      );
      if (controller.rowCount !== 1) return null;
    }
  }
  return {
    characterId: row.id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    revision: row.revision,
    active: campaignActive && row.lifecycle === "active",
  };
}
