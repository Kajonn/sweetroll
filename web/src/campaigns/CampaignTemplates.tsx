import { campaignDetailKey } from "./campaignQueries.js";
import { t } from "../i18n/index.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  EmptyState,
  FormField,
  Panel,
  Select,
} from "../ui/index.js";
import { randomUUID } from "../utils/uuid.js";
import type {
  CampaignTemplate,
  CampaignTemplatesApi,
  TemplateCreateBody,
  TemplateEditBody,
  TemplateLifecycleBody,
} from "./campaignTemplateApi.js";
import styles from "./CampaignTemplates.module.css";

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}
export function CampaignTemplates(props: {
  api: CampaignTemplatesApi;
  campaignId: string;
  actorId: string;
  generation: number;
  isGm: boolean;
  online: boolean;
  readOnly: boolean;
  onAccessRevoked: () => void;
}) {
  const client = useQueryClient();
  const [archived, setArchived] = useState(false);
  const listStatus = archived && props.isGm ? "archived" : "active";
  const key = [
    "campaigns",
    "templates",
    props.campaignId,
    props.actorId,
    props.generation,
    listStatus,
  ];
  const lifetime = useMemo(
    () => ({ active: true }),
    [props.campaignId, props.actorId, props.generation],
  );
  const [editing, setEditing] = useState<CampaignTemplate | null>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CampaignTemplate["kind"]>("item");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<CampaignTemplate | null>(
    null,
  );
  type Attempt = {
    operation: "create" | "edit" | "archive" | "recover";
    templateId?: string;
    body: TemplateCreateBody | TemplateEditBody | TemplateLifecycleBody;
  };
  const attempt = useRef<Attempt | null>(null);
  const list = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    enabled: props.online,
    queryFn: async ({ pageParam, signal }) => {
      const page = await props.api.list(props.campaignId, {
        status: listStatus,
        cursor: pageParam,
      });
      if (signal.aborted || !lifetime.active)
        throw new Error("Discarded response from previous account.");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: props.online ? 30000 : false,
  });
  useEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);
  useEffect(() => {
    setOpen(false);
    setEditing(null);
    setConfirmArchive(null);
    attempt.current = null;
    setError(null);
    setStale(false);
    setPending(false);
  }, [props.actorId, props.generation, props.campaignId]);
  useEffect(() => {
    if (!props.isGm) {
      setArchived(false);
      setOpen(false);
      setConfirmArchive(null);
      attempt.current = null;
      client.removeQueries({
        queryKey: [
          "campaigns",
          "templates",
          props.campaignId,
          props.actorId,
          props.generation,
          "archived",
        ],
      });
    }
  }, [props.isGm, client, props.campaignId, props.actorId, props.generation]);
  useEffect(() => {
    if (status(list.error) === 404) {
      client.removeQueries({
        queryKey: ["campaigns", "templates", props.campaignId],
      });
      setOpen(false);
      setConfirmArchive(null);
      props.onAccessRevoked();
    }
  }, [list.error, client, props.campaignId, props.onAccessRevoked]);
  const rows = list.data?.pages.flatMap((p) => p.templates) ?? [];
  const blocked = !props.online || props.readOnly || pending || !props.isGm;
  function begin(value: CampaignTemplate | null) {
    setEditing(value);
    setKind(value?.kind ?? "item");
    setName(value?.content.name ?? "");
    setDescription(value?.content.description ?? "");
    setNotes(value?.content.notes ?? "");
    setQuantity(value?.content.defaultQuantity ?? 1);
    setError(null);
    setStale(false);
    attempt.current = null;
    setOpen(true);
  }
  async function send(saved: Attempt) {
    if (blocked) return;
    attempt.current = saved;
    setPending(true);
    setError(null);
    try {
      if (saved.operation === "create")
        await props.api.create(
          props.campaignId,
          saved.body as TemplateCreateBody,
        );
      else if (saved.operation === "edit")
        await props.api.edit(
          props.campaignId,
          saved.templateId!,
          saved.body as TemplateEditBody,
        );
      else
        await props.api[saved.operation](
          props.campaignId,
          saved.templateId!,
          saved.body as TemplateLifecycleBody,
        );
      if (!lifetime.active) return;
      attempt.current = null;
      setOpen(false);
      setConfirmArchive(null);
      setStale(false);
      await client.invalidateQueries({
        queryKey: ["campaigns", "templates", props.campaignId],
      });
    } catch (e) {
      if (!lifetime.active) return;
      if (status(e) === 404) {
        attempt.current = null;
        setOpen(false);
        setConfirmArchive(null);
        client.removeQueries({
          queryKey: ["campaigns", "templates", props.campaignId],
        });
        props.onAccessRevoked();
        return;
      }
      if (status(e) === 403) {
        attempt.current = null;
        setOpen(false);
        setConfirmArchive(null);
        setError(t("campaign.templates.roleChanged"));
        await client.invalidateQueries({
          queryKey: campaignDetailKey(props.campaignId),
        });
        return;
      }
      if (status(e) === 409) {
        attempt.current = null;
        setStale(true);
        setError(t("campaign.templates.changed"));
      } else if (status(e) === 400 || status(e) === 422) {
        attempt.current = null;
        setError(t("campaign.templates.fields"));
      } else setError(t("campaign.templates.uncertain"));
    } finally {
      if (lifetime.active) setPending(false);
    }
  }
  const valid =
    name.trim().length > 0 &&
    name.length <= 200 &&
    description.length <= 2000 &&
    notes.length <= 2000 &&
    (kind !== "item" || (Number.isSafeInteger(quantity) && quantity >= 1));
  const frozen = attempt.current !== null;
  const feedback = (
    <>
      {error ? <p role="alert">{error}</p> : null}
      {stale ? (
        <Button
          variant="secondary"
          disabled={blocked}
          onClick={async () => {
            const refreshed = await list.refetch();
            if (!lifetime.active) return;
            const latest = refreshed.data?.pages
              .flatMap((p) => p.templates)
              .find((t) => t.templateId === editing?.templateId);
            if (editing && latest) {
              setEditing(latest);
              setStale(false);
              setError(null);
            } else {
              setOpen(false);
              setConfirmArchive(null);
              setStale(false);
            }
          }}
        >
          {t("campaign.templates.refresh")}
        </Button>
      ) : null}
      {frozen && !pending ? (
        <Button disabled={blocked} onClick={() => void send(attempt.current!)}>
          {t("campaign.templates.retry")}
        </Button>
      ) : null}
    </>
  );
  return (
    <Panel title={t("campaign.templates.title")}>
      <p>{t("campaign.templates.description")}</p>
      {!props.online ? (
        <p role="status">{t("campaign.templates.offline")}</p>
      ) : null}
      {props.isGm ? (
        <div className={styles.actions}>
          <Button disabled={blocked} onClick={() => begin(null)}>
            {t("campaign.templates.create")}
          </Button>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setArchived(!archived);
              setError(null);
            }}
          >
            {" "}
            {archived
              ? t("campaign.templates.active")
              : t("campaign.templates.archived")}
          </Button>
        </div>
      ) : null}
      {list.isLoading && props.online ? (
        <p role="status">{t("campaign.templates.loading")}</p>
      ) : null}
      {list.isError ? (
        <p role="alert">{t("campaign.templates.unavailable")}</p>
      ) : null}
      {rows.length === 0 && list.isSuccess ? (
        <EmptyState
          title={t("campaign.templates.empty")}
          description={
            archived
              ? t("campaign.templates.emptyArchived")
              : t("campaign.templates.emptyActive")
          }
        />
      ) : null}
      <ul className={styles.list}>
        {rows.map((row) => (
          <li key={row.templateId} className={styles.row}>
            <h3>{row.content.name}</h3>
            <span>
              {t("campaign.templates." + row.kind)} ·{" "}
              {t("campaign.templates.originRevision", {
                revision: row.contentRevision,
              })}
            </span>
            {row.content.description ? (
              <p className={styles.text}>{row.content.description}</p>
            ) : null}
            {row.content.notes ? (
              <details>
                <summary>{t("campaign.templates.notes")}</summary>
                <p className={styles.text}>{row.content.notes}</p>
              </details>
            ) : null}
            {row.kind === "item" ? (
              <p>
                {t("campaign.templates.quantityValue", {
                  quantity: row.content.defaultQuantity ?? 1,
                })}
              </p>
            ) : null}
            {props.isGm ? (
              <div className={styles.actions}>
                {row.status === "active" ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={blocked}
                      onClick={() => begin(row)}
                    >
                      {t("campaign.templates.edit")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={blocked}
                      onClick={() => {
                        setError(null);
                        setStale(false);
                        attempt.current = null;
                        setConfirmArchive(row);
                      }}
                    >
                      {t("campaign.templates.archive")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={blocked}
                    onClick={() =>
                      void send({
                        operation: "recover",
                        templateId: row.templateId,
                        body: {
                          expectedTemplateRevision: row.revision,
                          idempotencyKey: randomUUID(),
                        },
                      })
                    }
                  >
                    {t("campaign.templates.recover")}
                  </Button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={!props.online || list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t("campaign.templates.loadMore")}
        </Button>
      ) : null}
      {!open && confirmArchive === null ? feedback : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending && !frozen) setOpen(value);
        }}
        title={
          editing
            ? t("campaign.templates.edit")
            : t("campaign.templates.create")
        }
        description={t("campaign.templates.editorDescription")}
        closeLabel={t("campaign.templates.cancel")}
        actions={
          <Button
            pending={pending}
            disabled={blocked || !valid || stale || frozen}
            onClick={() => {
              const content = {
                name: name.trim(),
                description,
                notes,
                ...(kind === "item" ? { defaultQuantity: quantity } : {}),
              };
              void send(
                editing
                  ? {
                      operation: "edit",
                      templateId: editing.templateId,
                      body: {
                        expectedTemplateRevision: editing.revision,
                        content,
                        idempotencyKey: randomUUID(),
                      },
                    }
                  : {
                      operation: "create",
                      body: {
                        kind,
                        expectedTemplateRevision: 0,
                        content,
                        idempotencyKey: randomUUID(),
                      },
                    },
              );
            }}
          >
            {editing
              ? t("campaign.templates.save")
              : t("campaign.templates.publish")}
          </Button>
        }
      >
        <div className={styles.form}>
          <Select
            label={t("campaign.templates.kind")}
            value={kind}
            disabled={blocked || editing !== null || frozen}
            onChange={(e) =>
              setKind(e.target.value as CampaignTemplate["kind"])
            }
            options={[
              { value: "item", label: t("campaign.templates.item") },
              { value: "spell", label: t("campaign.templates.spell") },
              { value: "talent", label: t("campaign.templates.talent") },
              { value: "effect", label: t("campaign.templates.effect") },
            ]}
          />
          <FormField label={t("campaign.templates.name")}>
            <input
              maxLength={200}
              required
              value={name}
              disabled={blocked || frozen}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField label={t("campaign.templates.contentDescription")}>
            <textarea
              maxLength={2000}
              value={description}
              disabled={blocked || frozen}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
          <FormField label={t("campaign.templates.notes")}>
            <textarea
              maxLength={2000}
              value={notes}
              disabled={blocked || frozen}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>
          {kind === "item" ? (
            <FormField label={t("campaign.templates.quantity")}>
              <input
                type="number"
                min={1}
                step={1}
                value={quantity}
                disabled={blocked || frozen}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </FormField>
          ) : null}
        </div>
        {editing ? (
          <p>
            {t("campaign.templates.currentRevision", {
              revision: editing.contentRevision,
              name: editing.content.name,
            })}
            <br />
            {editing.content.notes}
          </p>
        ) : null}
        {feedback}
      </Dialog>
      <Dialog
        open={confirmArchive !== null}
        onOpenChange={(value) => {
          if (!pending && !frozen && !value) setConfirmArchive(null);
        }}
        title={t("campaign.templates.archiveTitle")}
        description={t("campaign.templates.archiveDescription")}
        closeLabel={t("campaign.templates.cancel")}
        actions={
          <Button
            disabled={blocked || stale || frozen}
            pending={pending}
            onClick={() => {
              if (confirmArchive)
                void send({
                  operation: "archive",
                  templateId: confirmArchive.templateId,
                  body: {
                    expectedTemplateRevision: confirmArchive.revision,
                    idempotencyKey: randomUUID(),
                  },
                });
            }}
          >
            {t("campaign.templates.confirmArchive")}
          </Button>
        }
      >
        {feedback}
      </Dialog>
    </Panel>
  );
}
