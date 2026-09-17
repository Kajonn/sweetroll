// GM invitation issue/rotate/revoke manager. The one-time token lives in a
// single local state (`shownToken`): it renders once with the never-stored
// notice, is cleared on dismiss or when a newer token arrives, and never
// enters query invalidation payloads, onChanged, logs, or error text
// (mirror InvitationReview.tsx sanitize-redacts-activeToken discipline).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, FormField, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { campaignInvitationsKey, useCampaignInvitations } from "./campaignQueries.js";
import type { InvitationSummary } from "./types.js";
import { randomUUID } from "../utils/uuid";

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

type IntendedRole = "player" | "co_gm";

function roleLabel(role: IntendedRole): string {
  return t(`campaign.detail.invitations.manage.role.${role}`);
}

export function InvitationManager(props: {
  api: CampaignsApi;
  campaignId: string;
  campaignRevision: number;
  actorId: string | null;
  generation: number;
  online: boolean;
  /** Reload the campaign (and list) so retries use a fresh revision. */
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const invitationsKey = campaignInvitationsKey(props.campaignId, props.actorId, props.generation);
  const invitations = useCampaignInvitations(props.api, props.campaignId, props.actorId, props.generation, {
    enabled: true,
    online: props.online,
  });

  const [intendedRole, setIntendedRole] = useState<IntendedRole>("player");
  const [expiresInput, setExpiresInput] = useState("");
  // The only place the one-time token is held. Set only from fresh
  // issue/rotate responses containing `token`; cleared on dismiss or when a
  // newer token arrives.
  const [shownToken, setShownToken] = useState<{ inviteId: string; token: string } | null>(null);
  const [replayInviteId, setReplayInviteId] = useState<string | null>(null);
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [pendingInviteId, setPendingInviteId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: invitationsKey });
    props.onChanged();
  };

  const describeError = (cause: unknown): string => {
    const fallback = t("campaign.detail.invitations.manage.error");
    if (
      typeof cause === "object" &&
      cause !== null &&
      "message" in cause &&
      typeof cause.message === "string" &&
      cause.message !== ""
    ) {
      // Never echo the token: redact it out of server messages before render.
      return shownToken === null || shownToken.token === ""
        ? cause.message
        : cause.message.split(shownToken.token).join("…");
    }
    return fallback;
  };

  const attemptIssue = async (): Promise<void> => {
    if (issuing) return;
    setIssuing(true);
    setError(null);
    setConflict(false);
    setReplayInviteId(null);
    // Caller-minted idempotency key, fresh on every attempt: a 409 re-reads
    // first and the retry mints a new key rather than reusing this one.
    const idempotencyKey = randomUUID();
    const trimmedExpires = expiresInput.trim();
    try {
      const response = await props.api.issueInvitation(props.campaignId, {
        intendedRole,
        ...(trimmedExpires === "" ? {} : { expiresAt: trimmedExpires }),
        expectedCampaignRevision: props.campaignRevision,
        idempotencyKey,
      });
      if ("token" in response.invitation) {
        setReplayInviteId(null);
        setShownToken({ inviteId: response.invitation.invitationId, token: response.invitation.token });
      } else {
        // Same-key replay: no new token is minted and the initial token
        // cannot be recovered — point at rotate instead.
        setShownToken(null);
        setReplayInviteId(response.invitation.invitationId);
      }
      reload();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setConflict(true);
        reload();
      } else {
        setError(describeError(cause));
      }
    } finally {
      setIssuing(false);
    }
  };

  const attemptRotate = async (invitation: InvitationSummary): Promise<void> => {
    if (pendingInviteId !== null || issuing) return;
    setPendingInviteId(invitation.invitationId);
    setError(null);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = randomUUID();
    try {
      const response = await props.api.rotateInvitation(props.campaignId, invitation.invitationId, {
        expectedInvitationRevision: invitation.invitationRevision,
        expectedCampaignRevision: props.campaignRevision,
        idempotencyKey,
      });
      if ("token" in response.invitation) {
        setReplayInviteId(null);
        setShownToken({ inviteId: response.invitation.invitationId, token: response.invitation.token });
      } else {
        setShownToken(null);
        setReplayInviteId(response.invitation.invitationId);
      }
      reload();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setConflict(true);
        reload();
      } else {
        setError(describeError(cause));
      }
    } finally {
      setPendingInviteId(null);
    }
  };

  const attemptRevoke = async (invitation: InvitationSummary): Promise<void> => {
    if (pendingInviteId !== null || issuing) return;
    setPendingInviteId(invitation.invitationId);
    setError(null);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = randomUUID();
    try {
      await props.api.revokeInvitation(props.campaignId, invitation.invitationId, {
        expectedInvitationRevision: invitation.invitationRevision,
        expectedCampaignRevision: props.campaignRevision,
        idempotencyKey,
      });
      setRevokeTargetId(null);
      reload();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        setConflict(true);
        setRevokeTargetId(null);
        reload();
      } else {
        setError(describeError(cause));
      }
    } finally {
      setPendingInviteId(null);
    }
  };

  if (invitations.status === "pending") {
    return <p role="status">{t("campaign.detail.invitations.manage.loading")}</p>;
  }

  if (invitations.status === "error") {
    return (
      <EmptyState
        title={t("campaign.detail.invitations.manage.loadFailed")}
        action={
          <Button
            variant="primary"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: invitationsKey });
            }}
          >
            {t("campaign.detail.retry")}
          </Button>
        }
      />
    );
  }

  const rows: InvitationSummary[] = invitations.data.pages.flatMap((page) => page.invitations);
  const revokeTarget =
    revokeTargetId === null ? null : (rows.find((row) => row.invitationId === revokeTargetId) ?? null);

  return (
    <div>
      <h2>{t("campaign.detail.invitations.manage.title")}</h2>
      {conflict ? <p role="alert">{t("campaign.detail.invitations.manage.conflict")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      <Panel>
        <Select
          label={t("campaign.detail.invitations.manage.role.label")}
          options={[
            { value: "player", label: roleLabel("player") },
            { value: "co_gm", label: roleLabel("co_gm") },
          ]}
          value={intendedRole}
          onChange={(event) => setIntendedRole(event.target.value as IntendedRole)}
        />
        <FormField label={t("campaign.detail.invitations.manage.expires.label")}>
          <input type="text" value={expiresInput} onChange={(event) => setExpiresInput(event.target.value)} />
        </FormField>
        <Button variant="primary" pending={issuing} pendingText={t("campaign.detail.invitations.manage.issuing")} onClick={() => void attemptIssue()}>
          {t("campaign.detail.invitations.manage.issue")}
        </Button>
      </Panel>
      {shownToken !== null ? (
        <Panel title={t("campaign.detail.invitations.manage.token.title")}>
          <p>
            <code>{shownToken.token}</code>
          </p>
          <p>{t("campaign.detail.invitations.manage.token.hint")}</p>
          <Button variant="secondary" onClick={() => setShownToken(null)}>
            {t("campaign.detail.invitations.manage.token.dismiss")}
          </Button>
        </Panel>
      ) : null}
      {replayInviteId !== null ? <p role="status">{t("campaign.detail.invitations.manage.token.unavailable")}</p> : null}
      {rows.length === 0 ? (
        <EmptyState title={t("campaign.detail.invitations.manage.empty")} />
      ) : (
        <Panel>
          <ul aria-label={t("campaign.detail.invitations.manage.title")}>
            {rows.map((invitation) => (
              <li key={invitation.invitationId}>
                <span>{roleLabel(invitation.intendedRole as IntendedRole)}</span>{" "}
                <span>{invitation.status}</span> <span>{invitation.expiresAt}</span>{" "}
                <Button
                  variant="secondary"
                  pending={pendingInviteId === invitation.invitationId}
                  onClick={() => void attemptRotate(invitation)}
                >
                  {t("campaign.detail.invitations.manage.rotate")}
                </Button>{" "}
                <Button variant="secondary" onClick={() => setRevokeTargetId(invitation.invitationId)}>
                  {t("campaign.detail.invitations.manage.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTargetId(null);
        }}
        title={
          revokeTarget === null ? "" : t("campaign.detail.invitations.manage.revoke.confirm.title")
        }
        description={
          revokeTarget === null
            ? undefined
            : t("campaign.detail.invitations.manage.revoke.confirm.description")
        }
        actions={
          revokeTarget === null ? undefined : (
            <Button
              variant="danger"
              pending={pendingInviteId === revokeTarget.invitationId}
              onClick={() => void attemptRevoke(revokeTarget)}
            >
              {t("campaign.detail.invitations.manage.revoke.confirm.confirm")}
            </Button>
          )
        }
      >
        <Panel title={revokeTarget?.invitationId ?? ""}>
          <p>{revokeTarget === null ? "" : roleLabel(revokeTarget.intendedRole as IntendedRole)}</p>
        </Panel>
      </Dialog>
    </div>
  );
}
