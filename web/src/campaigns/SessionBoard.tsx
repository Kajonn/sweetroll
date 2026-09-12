// SessionBoard: GM session tab body. Read-only latest content (limit 10)
// + recent activity (limit 20) + character directory with inline resource
// bumps and audience rolls. Bumps/rolls reuse the online-only
// CharactersApi wrappers (Task 1) and are disabled while offline. Sheets
// still open via onOpenCharacter; the I4 session queue is untouched.
// Row state lives in per-characterId child components so the 15s poll
// never resets it. 404 on any feed → onAccessRevoked.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import type { CharactersApi } from "../characters/api.js";
import type { CharacterView } from "../characters/types.js";
import { t } from "../i18n/index.js";
import { Button, EmptyState, FormField, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { campaignCharactersKey } from "./campaignQueries.js";
import { audienceLabel } from "./CampaignContent.js";
import { activityKindLabel } from "./CampaignActivity.js";
import type { CampaignCharacterSummary } from "./types.js";

export type SessionBoardProps = {
  campaignsApi: Pick<CampaignsApi, "listContent" | "listActivity" | "listCampaignCharacters">;
  charactersApi: Pick<CharactersApi, "open" | "bumpCharacterResource" | "executeCharacterAction">;
  campaignId: string;
  actorId: string;
  generation: number;
  online: boolean;
  onOpenCharacter: (characterId: string) => void;
  onAccessRevoked: () => void;
};

type SheetElement =
  CharacterView["projection"]["sheets"][number]["sections"][number]["elements"][number];
type ResourceElement = Extract<SheetElement, { kind: "resource" }>;
type ActionElement = Extract<SheetElement, { kind: "action" }>;
type RollAudience = "owner_only" | "gm_only" | "campaign";

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

function sheetElements(character: CharacterView): SheetElement[] {
  return character.projection.sheets.flatMap((sheet) =>
    sheet.sections.flatMap((section) => section.elements),
  );
}

function SessionBumpRow(props: {
  charactersApi: SessionBoardProps["charactersApi"];
  characterId: string;
  revision: number;
  element: ResourceElement;
  online: boolean;
  onBumped: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = props.element.value.current;

  const attempt = async (direction: "up" | "down"): Promise<void> => {
    if (pending) return;
    setPending(true);
    setConflict(false);
    setFailed(false);
    // Caller-minted idempotency key, fresh on every attempt.
    try {
      await props.charactersApi.bumpCharacterResource(props.characterId, props.element.resourceId, {
        direction,
        expectedRevision: props.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      props.onBumped();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
        props.onBumped();
        setConflict(true);
      } else {
        setFailed(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <span>{props.element.label}</span>{" "}
      <span>
        {current} / {props.element.value.max}
      </span>{" "}
      <Button
        variant="secondary"
        disabled={!props.online || pending || current <= props.element.min}
        onClick={() => void attempt("down")}
      >
        {t("campaign.detail.session.bump.down", { label: props.element.label })}
      </Button>{" "}
      <Button
        variant="secondary"
        disabled={!props.online || pending || current >= props.element.max}
        onClick={() => void attempt("up")}
      >
        {t("campaign.detail.session.bump.up", { label: props.element.label })}
      </Button>
      {conflict ? (
        <p role="alert">{t("campaign.detail.session.bump.conflict", { label: props.element.label })}</p>
      ) : null}
      {failed ? <p role="alert">{t("campaign.detail.session.loadFailed")}</p> : null}
    </div>
  );
}

function SessionRollRow(props: {
  charactersApi: SessionBoardProps["charactersApi"];
  characterId: string;
  revision: number;
  element: ActionElement;
  online: boolean;
  onOpenCharacter: (characterId: string) => void;
  onRolled: () => void;
}) {
  const [audience, setAudience] = useState<RollAudience>("campaign");
  const [pending, setPending] = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [failed, setFailed] = useState(false);

  // Actions with required inputs never execute from the board: the board
  // must not fabricate inputs, so it links to the sheet instead.
  if (props.element.inputs.some((input) => input.required)) {
    return (
      <div>
        <span>{props.element.label}</span>{" "}
        <Button variant="secondary" onClick={() => props.onOpenCharacter(props.characterId)}>
          {t("campaign.detail.session.roll.openSheet", { label: props.element.label })}
        </Button>
      </div>
    );
  }

  const execute = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    setUncertain(false);
    // Caller-minted idempotency key, fresh on every attempt.
    try {
      const response = await props.charactersApi.executeCharacterAction(
        props.characterId,
        props.element.actionId,
        {
          audience,
          expectedRevision: props.revision,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      // Kind-agnostic result text: never assume the payload shape. An
      // unparseable success keeps the attempt and shows the generic
      // uncertain-outcome text (malformed_response discipline).
      const raw = (response.result as { roll?: unknown }).roll ?? response.result;
      if (typeof raw === "string" || typeof raw === "number") {
        setResultText(String(raw));
      } else {
        setUncertain(true);
      }
      props.onRolled();
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → re-read first; the outcome is uncertain, so keep the
        // attempt and show the generic uncertain-outcome text.
        props.onRolled();
        setUncertain(true);
      } else {
        setFailed(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <span>{props.element.label}</span>{" "}
      <Select
        label={t("campaign.detail.session.roll.audience")}
        options={[
          { value: "owner_only", label: "owner_only" },
          { value: "gm_only", label: "gm_only" },
          { value: "campaign", label: "campaign" },
        ]}
        value={audience}
        onChange={(event) => setAudience(event.target.value as RollAudience)}
      />{" "}
      <Button
        variant="secondary"
        disabled={!props.online || pending}
        onClick={() => void execute()}
      >
        {t("campaign.detail.session.roll.execute", { label: props.element.label })}
      </Button>
      {resultText !== null ? <p role="status">{resultText}</p> : null}
      {uncertain ? <p role="status">{t("campaign.detail.session.roll.uncertain")}</p> : null}
      {failed ? <p role="alert">{t("campaign.detail.session.roll.error")}</p> : null}
    </div>
  );
}

function SessionCharacterRow(props: {
  charactersApi: SessionBoardProps["charactersApi"];
  campaignId: string;
  actorId: string;
  generation: number;
  character: CampaignCharacterSummary;
  online: boolean;
  onOpenCharacter: (characterId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sheet = useQuery({
    queryKey: [
      "campaigns",
      "session",
      props.campaignId,
      props.actorId,
      props.generation,
      "sheet",
      props.character.characterId,
    ],
    queryFn: () => props.charactersApi.open(props.character.characterId),
    enabled: expanded,
  });

  const reloadSheet = (): void => {
    void sheet.refetch();
  };

  let detail: ReactNode = null;
  if (expanded) {
    if (sheet.status === "pending") {
      detail = <p role="status">{t("campaign.detail.session.loading")}</p>;
    } else if (sheet.status === "error") {
      detail = <p role="alert">{t("campaign.detail.session.loadFailed")}</p>;
    } else {
      const elements = sheetElements(sheet.data.character);
      const resources = elements.filter(
        (element): element is ResourceElement => element.kind === "resource",
      );
      const actions = elements.filter(
        (element): element is ActionElement => element.kind === "action",
      );
      detail = (
        <div>
          {resources.map((element) => (
            <SessionBumpRow
              key={element.id}
              charactersApi={props.charactersApi}
              characterId={props.character.characterId}
              revision={sheet.data.character.revision}
              element={element}
              online={props.online}
              onBumped={reloadSheet}
            />
          ))}
          {actions.map((element) => (
            <SessionRollRow
              key={element.id}
              charactersApi={props.charactersApi}
              characterId={props.character.characterId}
              revision={sheet.data.character.revision}
              element={element}
              online={props.online}
              onOpenCharacter={props.onOpenCharacter}
              onRolled={reloadSheet}
            />
          ))}
        </div>
      );
    }
  }

  return (
    <li>
      <span>{props.character.name}</span>{" "}
      <span>{t("campaign.detail.session.controllers", { count: props.character.controllers.length })}</span>{" "}
      <Button variant="secondary" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
        {t("campaign.detail.session.open", { name: props.character.name })}
      </Button>
      {detail}
    </li>
  );
}

export function SessionBoard(props: SessionBoardProps) {
  const refetchInterval = props.online ? 15_000 : false;
  const content = useQuery({
    queryKey: ["campaigns", "session", props.campaignId, props.actorId, props.generation, "content"],
    queryFn: () => props.campaignsApi.listContent(props.campaignId, { limit: 10 }),
    refetchInterval,
  });
  const activity = useQuery({
    queryKey: ["campaigns", "session", props.campaignId, props.actorId, props.generation, "activity"],
    queryFn: () => props.campaignsApi.listActivity(props.campaignId, { limit: 20 }),
    refetchInterval,
  });
  const characters = useQuery({
    queryKey: campaignCharactersKey(props.campaignId),
    queryFn: () => props.campaignsApi.listCampaignCharacters(props.campaignId),
    refetchInterval,
  });
  const [filter, setFilter] = useState("");
  const revocationNotified = useRef(false);
  const { onAccessRevoked } = props;

  useEffect(() => {
    const errored = [content, activity, characters].filter((feed) => feed.status === "error");
    if (errored.length > 0 && errored.some((feed) => isNotFound(feed.error)) && !revocationNotified.current) {
      revocationNotified.current = true;
      onAccessRevoked();
    }
  }, [content, activity, characters, onAccessRevoked]);

  const refresh = (): void => {
    void Promise.all([content.refetch(), activity.refetch(), characters.refetch()]);
  };

  if (
    content.status !== "success" ||
    activity.status !== "success" ||
    characters.status !== "success"
  ) {
    const feeds = [content, activity, characters];
    if (feeds.some((feed) => feed.status === "error" && isNotFound(feed.error))) {
      return <p role="status">{t("campaign.detail.session.loading")}</p>;
    }
    if (feeds.some((feed) => feed.status === "pending")) {
      return <p role="status">{t("campaign.detail.session.loading")}</p>;
    }
    return (
      <EmptyState
        title={t("campaign.detail.session.loadFailed")}
        action={
          <Button variant="primary" onClick={refresh}>
            {t("campaign.detail.session.refresh")}
          </Button>
        }
      />
    );
  }

  const query = filter.trim().toLowerCase();
  const visible =
    query === ""
      ? characters.data.characters
      : characters.data.characters.filter((character) =>
          character.name.toLowerCase().includes(query),
        );

  return (
    <div>
      <h2>{t("campaign.detail.session.title")}</h2>
      <Button variant="secondary" onClick={refresh}>
        {t("campaign.detail.session.refresh")}
      </Button>
      {props.online ? null : <p role="status">{t("campaign.detail.session.offline")}</p>}
      <h3>{t("campaign.detail.session.contentHeading")}</h3>
      <ul>
        {content.data.content.map((item) => (
          <li key={item.contentId}>
            <span>{item.title}</span> <span>{audienceLabel(item.audience)}</span>
          </li>
        ))}
      </ul>
      <h3>{t("campaign.detail.session.activityHeading")}</h3>
      <ul>
        {activity.data.events.map((event) => (
          <li key={event.eventId}>
            <span>{activityKindLabel(event.kind)}</span> <span>{event.actorId}</span>{" "}
            <time dateTime={event.occurredAt}>{event.occurredAt}</time>
          </li>
        ))}
      </ul>
      <h3>{t("campaign.detail.session.charactersHeading")}</h3>
      <FormField label={t("campaign.detail.session.search.label")}>
        <input
          type="text"
          placeholder={t("campaign.detail.session.search.placeholder")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </FormField>
      <ul>
        {visible.map((character) => (
          <SessionCharacterRow
            key={character.characterId}
            charactersApi={props.charactersApi}
            campaignId={props.campaignId}
            actorId={props.actorId}
            generation={props.generation}
            character={character}
            online={props.online}
            onOpenCharacter={props.onOpenCharacter}
          />
        ))}
      </ul>
    </div>
  );
}
