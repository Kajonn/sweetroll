import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { CharactersApi } from "../characters/api.js";
import { t } from "../i18n/index.js";
import { Button, Dialog, Select } from "../ui/index.js";
import { randomUUID } from "../utils/uuid.js";
import type { AdoptCharacterBody, CampaignsApi } from "./api.js";

/** Online-only placement, using the authorized personal-character discovery seam.
 * Unknown outcomes freeze both revisions and key; a conflict requires new review.
 */
export function AdoptPersonalCharacter(props: {
  api: Pick<CampaignsApi, "adoptCharacter">;
  charactersApi: Pick<CharactersApi, "listCharacters">;
  campaignId: string;
  campaignRevision: number;
  pinnedVersionId: string;
  actorId: string;
  generation: number;
  online: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [attempt, setAttempt] = useState<{ characterId: string; body: AdoptCharacterBody } | null>(null);
  const active = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const personal = useInfiniteQuery({
    queryKey: ["campaigns", "personal-characters", props.campaignId, props.actorId, props.generation],
    queryFn: ({ pageParam }) => props.charactersApi.listCharacters({ limit: 25, cursor: pageParam ?? null }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open && props.online,
    retry: false,
  });
  const rows = personal.data?.pages.flatMap((page) => page.characters)
    .filter((row) => row.lifecycle === "active" && row.systemVersionId === props.pinnedVersionId) ?? [];
  const choice = rows.find((row) => row.characterId === selected);

  async function send() {
    if (!props.online || sending.current || stale || (!attempt && !choice)) return;
    const frozen = attempt ?? { characterId: choice!.characterId, body: {
      expectedCampaignRevision: props.campaignRevision,
      expectedCharacterRevision: choice!.revision,
      acknowledgedDisclosure: true,
      idempotencyKey: randomUUID(),
    }};
    setAttempt(frozen);
    sending.current = true;
    setPending(true);
    setError("");
    try {
      await props.api.adoptCharacter(props.campaignId, frozen.characterId, frozen.body);
      if (!active.current) return;
      setAttempt(null);
      setOpen(false);
      setSelected("");
      await personal.refetch();
      if (active.current) props.onChanged();
    } catch (cause) {
      if (!active.current) return;
      const status = (cause as { status?: number } | null)?.status;
      if (status === 400 || status === 403 || status === 404 || status === 409) {
        setAttempt(null);
        setStale(true);
        setError(t("campaign.adopt.stale"));
        props.onChanged();
      } else {
        setError(t("campaign.adopt.uncertain"));
      }
    } finally {
      sending.current = false;
      if (active.current) setPending(false);
    }
  }

  return <>
    <Button variant="secondary" disabled={!props.online} onClick={() => {
      setOpen(true); setError(""); setStale(false); setSelected("");
      void personal.refetch();
    }}>{t("campaign.adopt.open")}</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!pending && !attempt) setOpen(value); }}
      title={t("campaign.adopt.open")} description={t("campaign.adopt.disclosure")}
      closeLabel={t("campaign.templates.cancel")}
      actions={<Button variant="primary" pending={pending}
        disabled={!props.online || pending || stale || personal.isFetching || (!attempt && !choice)}
        onClick={() => void send()}>{t(attempt ? "campaign.sharing.retry" : "campaign.adopt.confirm")}</Button>}>
      <p>{t("campaign.adopt.compatibility")}</p>
      {!props.online ? <p role="status">{t("campaign.adopt.offline")}</p> : null}
      {personal.isPending ? <p role="status">{t("campaign.adopt.loading")}</p> : null}
      {personal.isError ? <p role="alert">{t("campaign.adopt.loadFailed")} <Button disabled={!props.online} onClick={() => void personal.refetch()}>{t("campaign.detail.retry")}</Button></p> : null}
      <Select label={t("campaign.adopt.character")} value={selected} placeholder={t("campaign.adopt.character")}
        disabled={!props.online || pending || !!attempt || stale || personal.isFetching}
        options={rows.map((row) => ({ value: row.characterId, label: row.name }))}
        onChange={(event) => setSelected(event.target.value)} />
      {personal.isSuccess && rows.length === 0 ? <p role="status">{t("campaign.adopt.empty")}</p> : null}
      {personal.hasNextPage ? <Button disabled={!props.online || pending || !!attempt || personal.isFetching} onClick={() => void personal.fetchNextPage()}>{t("campaign.adopt.more")}</Button> : null}
      {error ? <p role="alert">{error}</p> : null}
      {stale ? <Button disabled={!props.online || pending} onClick={async () => {
        await personal.refetch();
        if (active.current) { setStale(false); setError(""); setSelected(""); }
      }}>{t("campaign.templates.refresh")}</Button> : null}
    </Dialog>
  </>;
}
