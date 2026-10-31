import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, FormField, Panel, Select } from "../ui/index.js";
import { t } from "../i18n/index.js";
import { randomUUID } from "../utils/uuid.js";
import type {
  CampaignProposal,
  CampaignProposalsApi,
  ProposalSubmitBody,
  ProposalDecisionBody,
} from "./campaignProposalApi.js";
import styles from "./CampaignTemplates.module.css";
type Props = {
  api: CampaignProposalsApi;
  campaignId: string;
  actorId: string;
  generation: number;
  isGm: boolean;
  online: boolean;
  readOnly: boolean;
  onAccessRevoked: () => void;
};
type Attempt =
  | { operation: "submit"; body: ProposalSubmitBody }
  | {
      operation: "approve" | "reject";
      proposalId: string;
      body: ProposalDecisionBody;
    };
function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}
/** Remount on authority changes so no former-scope data can render for one frame. */
export function CampaignProposals(props: Props) {
  return (
    <ProposalScope
      key={JSON.stringify([
        props.campaignId,
        props.actorId,
        props.generation,
        props.isGm,
      ])}
      {...props}
    />
  );
}
function ProposalScope(props: Props) {
  const client = useQueryClient();
  const scope = [
    "campaigns",
    "proposals",
    props.campaignId,
    props.actorId,
    props.generation,
    props.isGm ? "review" : "self",
  ] as const;
  const active = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLSpanElement | null>(null);
  const restoreFocus = (event: Event) => {
    const target = opener.current?.isConnected
      ? opener.current
      : heading.current;
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<CampaignProposal | null>(null);
  const [kind, setKind] = useState<CampaignProposal["kind"]>("item");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const list = useInfiniteQuery({
    queryKey: scope,
    initialPageParam: null as string | null,
    enabled: props.online,
    queryFn: async ({ pageParam, signal }) => {
      const page = await props.api.list(
        props.campaignId,
        { cursor: pageParam },
        signal,
      );
      if (signal.aborted || !active.current)
        throw new Error("Discarded inaccessible suggestion response");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: props.online ? 30000 : false,
  });
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void client.cancelQueries({ queryKey: scope });
      client.removeQueries({ queryKey: scope });
    };
  }, [client]);
  useEffect(() => {
    if (status(list.error) === 404 || status(list.error) === 403) {
      client.removeQueries({ queryKey: scope });
      setReview(null);
      setOpen(false);
      props.onAccessRevoked();
    }
  }, [list.error]);
  const disabled =
    pending || uncertain || stale || !props.online || props.readOnly;
  function reset() {
    attempt.current = null;
    setError(null);
    setStale(false);
    setUncertain(false);
    setPending(false);
  }
  function close() {
    if (pending) return;
    setOpen(false);
    setReview(null);
    reset();
  }
  async function execute(next: Attempt) {
    if (pending || !props.online || props.readOnly || stale) return;
    attempt.current = structuredClone(next);
    setPending(true);
    setError(null);
    try {
      if (next.operation === "submit")
        await props.api.submit(props.campaignId, next.body);
      else
        await props.api[next.operation](
          props.campaignId,
          next.proposalId,
          next.body,
        );
      if (!active.current) return;
      opener.current = heading.current;
      setPending(false);
      setOpen(false);
      setReview(null);
      reset();
      await client.invalidateQueries({ queryKey: scope });
      await client.invalidateQueries({
        queryKey: ["campaigns", "templates", props.campaignId],
      });
    } catch (e) {
      if (!active.current) return;
      const code = status(e);
      setPending(false);
      if (code === 404 || code === 403) {
        setOpen(false);
        setReview(null);
        client.removeQueries({ queryKey: scope });
        props.onAccessRevoked();
        return;
      }
      if (code === 409) {
        setStale(true);
        setUncertain(false);
        setError(t("campaign.proposals.conflict"));
      } else if (code === 400 || code === 413) {
        attempt.current = null;
        setUncertain(false);
        setError(
          t(
            code === 413
              ? "campaign.proposals.capacity"
              : "campaign.proposals.invalid",
          ),
        );
      } else {
        setUncertain(true);
        setError(t("campaign.proposals.uncertain"));
      }
    }
  }
  async function refresh() {
    await client.resetQueries({ queryKey: scope });
    if (!active.current) return;
    setReview(null);
    attempt.current = null;
    setStale(false);
    setUncertain(false);
    setError(null);
  }
  const feedback = (
    <>
      {error ? <p role="alert">{error}</p> : null}
      {uncertain ? (
        <Button
          disabled={pending || !props.online || props.readOnly}
          onClick={() => {
            if (attempt.current) void execute(attempt.current);
          }}
        >
          {t("campaign.proposals.retry")}
        </Button>
      ) : null}
      {stale ? (
        <Button
          disabled={pending || !props.online}
          onClick={() => void refresh()}
        >
          {t("campaign.proposals.refresh")}
        </Button>
      ) : null}
    </>
  );
  return (
    <Panel
      title={
        <span ref={heading} tabIndex={-1}>
          {t(
            props.isGm
              ? "campaign.proposals.reviewTitle"
              : "campaign.proposals.selfTitle",
          )}
        </span>
      }
    >
      <p>{t("campaign.proposals.private")}</p>
      {!props.online ? (
        <p role="status">{t("campaign.proposals.offline")}</p>
      ) : null}
      {!props.isGm ? (
        <Button
          disabled={!props.online || props.readOnly}
          onClick={(event) => {
            opener.current = event.currentTarget;
            reset();
            setName("");
            setDescription("");
            setNotes("");
            setQuantity(1);
            setKind("item");
            setOpen(true);
          }}
        >
          {t("campaign.proposals.suggest")}
        </Button>
      ) : null}
      {list.isError ? (
        <p role="alert">
          {t("campaign.proposals.loadError")}{" "}
          <Button onClick={() => void list.refetch()}>
            {t("campaign.proposals.refresh")}
          </Button>
        </p>
      ) : null}
      <ul className={styles.list}>
        {list.data?.pages
          .flatMap((page) => page.proposals)
          .map((p) => (
            <li key={p.proposalId} className={styles.row}>
              <h3>{p.content.name}</h3>
              <p>
                {t(`campaign.proposals.status.${p.status}`)} ·{" "}
                {t(`campaign.templates.${p.kind}`)}
              </p>
              {p.content.description ? (
                <p className={styles.text}>{p.content.description}</p>
              ) : null}
              {p.content.notes ? (
                <p className={styles.text}>{p.content.notes}</p>
              ) : null}
              {p.content.defaultQuantity !== undefined ? (
                <p>
                  {t("campaign.proposals.quantityValue", {
                    quantity: p.content.defaultQuantity,
                  })}
                </p>
              ) : null}
              {p.decision?.reason ? (
                <p className={styles.text}>{p.decision.reason}</p>
              ) : null}
              {p.approvedTemplateId ? (
                <p>{t("campaign.proposals.published")}</p>
              ) : null}
              {props.isGm && p.status === "pending" ? (
                <Button
                  disabled={!props.online || props.readOnly}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    reset();
                    setReason("");
                    setReview(p);
                  }}
                >
                  {t("campaign.proposals.review")}
                </Button>
              ) : null}
            </li>
          ))}
      </ul>
      {list.data?.pages[0]?.proposals.length === 0 ? (
        <p>{t("campaign.proposals.empty")}</p>
      ) : null}
      {list.hasNextPage ? (
        <Button
          disabled={list.isFetchingNextPage || !props.online}
          onClick={() => void list.fetchNextPage()}
        >
          {t("campaign.proposals.more")}
        </Button>
      ) : null}
      <Dialog
        onCloseAutoFocus={restoreFocus}
        open={open}
        onOpenChange={(v) => {
          if (!v) close();
        }}
        title={t("campaign.proposals.suggest")}
        description={t("campaign.proposals.publishNotice")}
      >
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void execute({
              operation: "submit",
              body: {
                kind,
                content: {
                  name,
                  description,
                  notes,
                  ...(kind === "item" ? { defaultQuantity: quantity } : {}),
                },
                expectedProposalRevision: 0,
                idempotencyKey: randomUUID(),
              },
            });
          }}
        >
          <Select
            label={t("campaign.templates.kind")}
            disabled={disabled}
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as CampaignProposal["kind"])
            }
            options={(["item", "spell", "talent", "effect"] as const).map(
              (k) => ({ value: k, label: t(`campaign.templates.${k}`) }),
            )}
          />
          <FormField label={t("campaign.templates.name")}>
            <input
              required
              maxLength={200}
              disabled={disabled}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField label={t("campaign.templates.contentDescription")}>
            <textarea
              maxLength={2000}
              disabled={disabled}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
          <FormField label={t("campaign.templates.notes")}>
            <textarea
              maxLength={2000}
              disabled={disabled}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>
          {kind === "item" ? (
            <FormField label={t("campaign.templates.quantity")}>
              <input
                type="number"
                required
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                disabled={disabled}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </FormField>
          ) : null}
          {feedback}
          <Button type="submit" disabled={disabled || !name.trim()}>
            {t("campaign.proposals.submit")}
          </Button>
        </form>
      </Dialog>
      <Dialog
        onCloseAutoFocus={restoreFocus}
        open={review !== null}
        onOpenChange={(v) => {
          if (!v) close();
        }}
        title={t("campaign.proposals.review")}
        description={t("campaign.proposals.publishNotice")}
      >
        {review ? (
          <div className={styles.form}>
            <h3>{review.content.name}</h3>
            <p className={styles.text}>{review.content.description}</p>
            <p className={styles.text}>{review.content.notes}</p>
            {review.content.defaultQuantity !== undefined ? (
              <p>
                {t("campaign.proposals.quantityValue", {
                  quantity: review.content.defaultQuantity,
                })}
              </p>
            ) : null}
            {review.eligibility?.reason ? (
              <p>
                {t(
                  `campaign.proposals.eligibility.${review.eligibility.reason}`,
                )}
              </p>
            ) : null}
            <FormField label={t("campaign.proposals.reason")}>
              <textarea
                maxLength={2000}
                disabled={disabled}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </FormField>
            {feedback}
            <div className={styles.actions}>
              <Button
                disabled={disabled || !review.eligibility?.canApprove}
                onClick={() =>
                  void execute({
                    operation: "approve",
                    proposalId: review.proposalId,
                    body: {
                      expectedProposalRevision: review.revision,
                      idempotencyKey: randomUUID(),
                    },
                  })
                }
              >
                {t("campaign.proposals.approve")}
              </Button>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  void execute({
                    operation: "reject",
                    proposalId: review.proposalId,
                    body: {
                      expectedProposalRevision: review.revision,
                      idempotencyKey: randomUUID(),
                      ...(reason ? { reason } : {}),
                    },
                  })
                }
              >
                {t("campaign.proposals.reject")}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </Panel>
  );
}
