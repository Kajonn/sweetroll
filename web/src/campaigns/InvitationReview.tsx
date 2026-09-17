// Presentational core for the invitation journey; the router supplies
// api/actorId/token. Tokens travel in POST bodies only and are never
// rendered back to the page.
import { useCallback, useEffect, useState } from "react";

import { t } from "../i18n/index.js";
import { AppLink } from "../ui/AppLink.js";
import { Button, EmptyState, FormField, PageHeader, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import type { InvitationReview } from "./types.js";
import { randomUUID } from "../utils/uuid";

export type InvitationPhase =
  | "entering"
  | "reviewing"
  | "reviewed"
  | "unavailable"
  | "accepted"
  | "declined"
  | "conflict"
  | "error";

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

export function InvitationReviewView(props: { api: CampaignsApi; actorId: string | null; token: string }) {
  const [activeToken, setActiveToken] = useState(props.token);
  const [draftToken, setDraftToken] = useState("");
  const [review, setReview] = useState<InvitationReview | null>(null);
  const [phase, setPhase] = useState<InvitationPhase>(props.token === "" ? "entering" : "reviewing");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);

  // Never echo the token: server messages are rendered only after the
  // active token (when present) is redacted out of them.
  const sanitize = useCallback(
    (message: string): string =>
      activeToken === "" ? message : message.split(activeToken).join("…"),
    [activeToken],
  );

  const describeError = useCallback(
    (cause: unknown): string => {
      if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
        return sanitize(cause.message);
      }
      return t("campaign.invitations.error.generic");
    },
    [sanitize],
  );

  const runReview = useCallback(
    async (token: string): Promise<void> => {
      setPhase("reviewing");
      setError(null);
      try {
        const response = await props.api.reviewInvitation({ token });
        setReview(response.review);
        setPhase("reviewed");
      } catch (cause) {
        if (isNotFound(cause)) {
          setReview(null);
          setPhase("unavailable");
        } else {
          setError(describeError(cause));
          setPhase("error");
        }
      }
    },
    [props.api, describeError],
  );

  useEffect(() => {
    setActiveToken(props.token);
    setDraftToken("");
    if (props.token === "") {
      setReview(null);
      setError(null);
      setPhase("entering");
      return;
    }
    void runReview(props.token);
  }, [props.token, runReview]);

  const submitToken = (): void => {
    const next = draftToken.trim();
    if (next === "") return;
    setActiveToken(next);
    void runReview(next);
  };

  const mutate = async (kind: "accept" | "decline"): Promise<void> => {
    if (review === null || pending !== null) return;
    setPending(kind);
    setError(null);
    // Caller-minted idempotency key, fresh on every attempt: a 409 re-reads
    // first and the retry mints a new key rather than reusing this one.
    const idempotencyKey = randomUUID();
    try {
      if (kind === "accept") {
        await props.api.acceptInvitation({
          campaignId: review.campaignId,
          token: activeToken,
          expectedInvitationRevision: review.invitationRevision,
          reviewedAccessRevision: review.accessRevision,
          idempotencyKey,
        });
        setPhase("accepted");
      } else {
        await props.api.declineInvitation({
          campaignId: review.campaignId,
          token: activeToken,
          expectedInvitationRevision: review.invitationRevision,
          reviewedAccessRevision: review.accessRevision,
          idempotencyKey,
        });
        setPhase("declined");
      }
    } catch (cause) {
      if (isNotFound(cause)) {
        setReview(null);
        setPhase("unavailable");
      } else if (isConflict(cause)) {
        setPhase("conflict");
      } else {
        setError(describeError(cause));
        setPhase("reviewed");
      }
    } finally {
      setPending(null);
    }
  };

  if (props.actorId === null) {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <p role="status">{t("campaign.invitations.signIn")}</p>
      </section>
    );
  }

  if (phase === "entering") {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <Panel title={t("campaign.invitations.title")}>
          <FormField label={t("campaign.invitations.enterToken.label")} hint={t("campaign.invitations.enterToken.hint")}>
            <input
              type="text"
              value={draftToken}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setDraftToken(event.target.value)}
            />
          </FormField>
          <Button variant="primary" disabled={draftToken.trim() === ""} onClick={submitToken}>
            {t("campaign.invitations.enterToken.submit")}
          </Button>
        </Panel>
      </section>
    );
  }

  if (phase === "reviewing") {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <p role="status">{t("campaign.invitations.reviewing")}</p>
      </section>
    );
  }

  if (phase === "unavailable") {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <EmptyState
          title={t("campaign.invitations.unavailable.title")}
          description={t("campaign.invitations.unavailable.description")}
        />
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <EmptyState
          title={t("campaign.invitations.error.title")}
          description={error}
          action={
            <Button variant="primary" onClick={() => void runReview(activeToken)}>
              {t("campaign.invitations.error.retry")}
            </Button>
          }
        />
      </section>
    );
  }

  if (phase === "conflict") {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <EmptyState
          title={t("campaign.invitations.conflict.title")}
          description={t("campaign.invitations.conflict.description")}
          action={
            <Button variant="primary" onClick={() => void runReview(activeToken)}>
              {t("campaign.invitations.conflict.retry")}
            </Button>
          }
        />
      </section>
    );
  }

  if (phase === "accepted" && review !== null) {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <EmptyState
          title={t("campaign.invitations.accepted.title", { title: review.campaignTitle })}
          description={t("campaign.invitations.accepted.description")}
          action={<AppLink href={`/campaigns/${review.campaignId}`}>{t("campaign.invitations.accepted.open")}</AppLink>}
        />
      </section>
    );
  }

  if (phase === "declined") {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <EmptyState
          title={t("campaign.invitations.declined.title")}
          description={t("campaign.invitations.declined.description")}
        />
      </section>
    );
  }

  if (review === null) {
    return (
      <section aria-label={t("campaign.invitations.title")}>
        <PageHeader title={t("campaign.invitations.title")} />
        <p role="status">{t("campaign.invitations.reviewing")}</p>
      </section>
    );
  }

  return (
    <section aria-label={t("campaign.invitations.title")}>
      <PageHeader title={t("campaign.invitations.title")} />
      <Panel title={review.campaignTitle}>
        <p>{t("campaign.invitations.review.invitedBy", { name: review.inviterDisplayName })}</p>
        <p>{t("campaign.invitations.review.joinAs", { role: review.intendedRole })}</p>
        <p>{t("campaign.invitations.review.expires", { date: review.expiresAt })}</p>
        {error !== null ? <p role="alert">{error}</p> : null}
        <div>
          <Button
            variant="primary"
            pending={pending === "accept"}
            pendingText={t("campaign.invitations.accepting")}
            disabled={pending !== null}
            onClick={() => void mutate("accept")}
          >
            {t("campaign.invitations.accept")}
          </Button>
          <Button
            variant="secondary"
            pending={pending === "decline"}
            pendingText={t("campaign.invitations.declining")}
            disabled={pending !== null}
            onClick={() => void mutate("decline")}
          >
            {t("campaign.invitations.decline")}
          </Button>
        </div>
      </Panel>
    </section>
  );
}
