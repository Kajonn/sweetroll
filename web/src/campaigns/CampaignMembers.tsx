// Member roster tab: role changes and removals with caller-minted
// idempotency keys. Management buttons are display gating only — the
// server remains the policy authority for owner-protections and co-GM
// limits. Self-leave stays in CampaignDetail: the self row never offers
// self-removal (or self role change) here.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { campaignMembersKey, useCampaignMembers } from "./campaignQueries.js";
import type { CampaignMember } from "./types.js";

export function ownRole(members: CampaignMember[], actorId: string): "owner" | "co_gm" | "player" | null {
  const own = members.find((member) => member.userId === actorId);
  if (own === undefined || own.status !== "active") return null;
  return own.role;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === "not_found";
}

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

function describeError(cause: unknown, fallback: string): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message !== ""
  ) {
    return cause.message;
  }
  return fallback;
}

function roleLabel(role: CampaignMember["role"]): string {
  return t(`campaign.detail.members.role.${role}`);
}

type ManageableRole = "co_gm" | "player";

function suggestedRole(member: CampaignMember): ManageableRole {
  return member.role === "player" ? "co_gm" : "player";
}

export function CampaignMembersTab(props: {
  api: CampaignsApi;
  campaignId: string;
  actorId: string | null;
  campaignRevision: number;
  generation: number;
  online: boolean;
  /** Reload the campaign (and roster) so retries use a fresh revision. */
  onChanged: () => void;
  /** Membership is gone: the parent should render the unavailable state. */
  onAccessRevoked: () => void;
}) {
  const queryClient = useQueryClient();
  const membersKey = campaignMembersKey(props.campaignId, props.actorId, props.generation);
  const members = useCampaignMembers(props.api, props.campaignId, props.actorId, props.generation, {
    enabled: true,
    online: props.online,
  });

  const [selectedRoles, setSelectedRoles] = useState<Record<string, ManageableRole>>({});
  const [roleTargetId, setRoleTargetId] = useState<string | null>(null);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: membersKey });
    props.onChanged();
  };

  const attemptRoleChange = async (member: CampaignMember, role: ManageableRole): Promise<void> => {
    if (pendingUserId !== null) return;
    setPendingUserId(member.userId);
    setError(null);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt: a 409 re-reads
    // first and the retry mints a new key rather than reusing this one.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.changeMemberRole(props.campaignId, member.userId, {
        role,
        expectedCampaignRevision: props.campaignRevision,
        idempotencyKey,
      });
      setRoleTargetId(null);
      reload();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setConflict(true);
        setRoleTargetId(null);
        reload();
      } else if (isNotFound(cause)) {
        setRoleTargetId(null);
        props.onAccessRevoked();
      } else {
        setError(describeError(cause, t("campaign.detail.members.error")));
      }
    } finally {
      setPendingUserId(null);
    }
  };

  const attemptRemove = async (member: CampaignMember): Promise<void> => {
    if (pendingUserId !== null) return;
    setPendingUserId(member.userId);
    setError(null);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.removeMember(props.campaignId, member.userId, {
        expectedCampaignRevision: props.campaignRevision,
        idempotencyKey,
      });
      setRemoveTargetId(null);
      reload();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setConflict(true);
        setRemoveTargetId(null);
        reload();
      } else if (isNotFound(cause)) {
        setRemoveTargetId(null);
        props.onAccessRevoked();
      } else {
        setError(describeError(cause, t("campaign.detail.members.error")));
      }
    } finally {
      setPendingUserId(null);
    }
  };

  if (members.status === "pending") {
    return <p role="status">{t("campaign.detail.members.loading")}</p>;
  }

  if (members.status === "error") {
    return (
      <EmptyState
        title={t("campaign.detail.members.loadFailed")}
        action={
          <Button
            variant="primary"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: membersKey });
            }}
          >
            {t("campaign.detail.retry")}
          </Button>
        }
      />
    );
  }

  const rows: CampaignMember[] = members.data.pages.flatMap((page) => page.members);
  const active = rows.filter((member) => member.status === "active");
  const selfRole = props.actorId === null ? null : ownRole(active, props.actorId);
  const canManage = selfRole === "owner" || selfRole === "co_gm";

  const roleTarget = roleTargetId === null ? null : (active.find((member) => member.userId === roleTargetId) ?? null);
  const roleValue: ManageableRole =
    roleTarget === null ? "co_gm" : (selectedRoles[roleTarget.userId] ?? suggestedRole(roleTarget));
  const removeTarget =
    removeTargetId === null ? null : (active.find((member) => member.userId === removeTargetId) ?? null);

  return (
    <div>
      {conflict ? <p role="alert">{t("campaign.detail.members.conflict")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {active.length === 0 ? (
        <EmptyState title={t("campaign.detail.members.empty")} />
      ) : (
        <Panel>
          <ul aria-label={t("campaign.detail.members.listAriaLabel")}>
            {active.map((member) => {
              const isSelf = member.userId === props.actorId;
              const manageable = canManage && !isSelf;
              const selected = selectedRoles[member.userId] ?? suggestedRole(member);
              const roleChangeable = manageable && (member.role === "co_gm" || member.role === "player");
              return (
                <li key={member.userId}>
                  <span>{member.userId}</span> <span>{roleLabel(member.role)}</span>{" "}
                  {isSelf ? <span>({t("campaign.detail.members.you")})</span> : null}{" "}
                  {roleChangeable ? (
                    <Select
                      label={t("campaign.detail.members.changeRole")}
                      options={[
                        { value: "co_gm", label: roleLabel("co_gm") },
                        { value: "player", label: roleLabel("player") },
                      ]}
                      value={selected}
                      onChange={(event) =>
                        setSelectedRoles((prev) => ({
                          ...prev,
                          [member.userId]: event.target.value as ManageableRole,
                        }))
                      }
                    />
                  ) : null}{" "}
                  {roleChangeable ? (
                    <Button variant="secondary" onClick={() => setRoleTargetId(member.userId)}>
                      {t("campaign.detail.members.changeRole")}
                    </Button>
                  ) : null}{" "}
                  {manageable ? (
                    <Button variant="secondary" onClick={() => setRemoveTargetId(member.userId)}>
                      {t("campaign.detail.members.remove", { name: member.userId })}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoleTargetId(null);
        }}
        title={
          roleTarget === null
            ? ""
            : t("campaign.detail.members.changeRole.confirm.title", {
                name: roleTarget.userId,
                role: roleLabel(roleValue),
              })
        }
        description={
          roleTarget === null ? undefined : t("campaign.detail.members.changeRole.confirm.description")
        }
        actions={
          roleTarget === null ? undefined : (
            <Button
              variant="primary"
              pending={pendingUserId === roleTarget.userId}
              onClick={() => void attemptRoleChange(roleTarget, roleValue)}
            >
              {t("campaign.detail.members.changeRole.confirm.confirm")}
            </Button>
          )
        }
      >
        <Panel title={roleTarget?.userId ?? ""}>
          <p>{roleTarget === null ? "" : roleLabel(roleValue)}</p>
        </Panel>
      </Dialog>
      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTargetId(null);
        }}
        title={
          removeTarget === null
            ? ""
            : t("campaign.detail.members.remove.confirm.title", { name: removeTarget.userId })
        }
        description={
          removeTarget === null ? undefined : t("campaign.detail.members.remove.confirm.description")
        }
        actions={
          removeTarget === null ? undefined : (
            <Button
              variant="danger"
              pending={pendingUserId === removeTarget.userId}
              onClick={() => void attemptRemove(removeTarget)}
            >
              {t("campaign.detail.members.remove.confirm.confirm")}
            </Button>
          )
        }
      >
        <Panel title={removeTarget?.userId ?? ""}>
          <p>{removeTarget === null ? "" : roleLabel(removeTarget.role)}</p>
        </Panel>
      </Dialog>
    </div>
  );
}
