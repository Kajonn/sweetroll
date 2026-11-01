import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Select } from "../ui/index.js";
import { t } from "../i18n/index.js";
import { randomUUID } from "../utils/uuid.js";
import type {
  CampaignTemplate,
  TemplateSharingBody,
} from "./campaignTemplateApi.js";
export type SharingMember = {
  displayName?: string | null;
  userId: string;
  role: string;
  status: string;
  generation: number;
};
/** Always include the full stable ID: duplicate names on another roster page
 * remain unambiguous and labels never change when more members are loaded. */
export function memberLabel(member: Pick<SharingMember, "userId" | "displayName">): string {
  const name = member.displayName?.trim() || t("campaign.member.unnamed");
  return `${name} (${member.userId})`;
}
export function AudienceFields(props: {
  audience: CampaignTemplate["audience"];
  setAudience: (v: CampaignTemplate["audience"]) => void;
  grants: SharingMember[];
  setGrants: (v: SharingMember[]) => void;
  members: SharingMember[];
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={props.disabled}>
      <Select
        label={t("campaign.sharing.audience")}
        value={props.audience}
        onChange={(e) => {
          props.setAudience(e.target.value as CampaignTemplate["audience"]);
          props.setGrants([]);
        }}
        options={["gm_only", "selected_players", "all_players"].map(
          (value) => ({ value, label: t("campaign.sharing." + value) }),
        )}
      />
      {props.audience === "selected_players"
        ? props.members
            .filter((m) => m.role === "player" && m.status === "active")
            .map((m) => (
              <label
                key={m.userId}
                style={{ display: "block", overflowWrap: "anywhere" }}
              >
                <input
                  type="checkbox"
                  checked={props.grants.some(
                    (g) =>
                      g.userId === m.userId && g.generation === m.generation,
                  )}
                  onChange={(e) =>
                    props.setGrants(
                      e.target.checked
                        ? [...props.grants, m]
                        : props.grants.filter((g) => g.userId !== m.userId),
                    )
                  }
                />
                {memberLabel(m)}
              </label>
            ))
        : null}
    </fieldset>
  );
}
export function TemplateSharing(props: {
  template: CampaignTemplate;
  members: SharingMember[];
  share: (body: TemplateSharingBody) => Promise<unknown>;
  onDone: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState(props.template.audience);
  const [grants, setGrants] = useState<SharingMember[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const request = useRef<TemplateSharingBody | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function send() {
    if (pending || props.disabled || stale) return;
    request.current ??= {
      expectedTemplateRevision: props.template.revision,
      idempotencyKey: randomUUID(),
      audience,
      grants: grants.map(({ userId, generation }) => ({ userId, generation })),
    };
    setPending(true);
    setError("");
    try {
      await props.share(request.current);
      if (active.current) {
        request.current = null;
        setOpen(false);
        props.onDone();
      }
    } catch (e) {
      if (active.current) {
        const code = (e as { status?: number }).status;
        if (code === 409 || code === 400 || code === 403 || code === 404) {
          request.current = null;
          setStale(true);
          setError(t("campaign.sharing.refresh"));
        } else setError(t("campaign.sharing.uncertain"));
      }
    } finally {
      if (active.current) setPending(false);
    }
  }
  return (
    <>
      <Button
        variant="secondary"
        disabled={props.disabled}
        onClick={() => {
          setAudience(props.template.audience);
          setGrants(
            props.members.filter((m) =>
              props.template.grants.some(
                (g) => g.userId === m.userId && g.generation === m.generation,
              ),
            ),
          );
          setError("");
          setStale(false);
          request.current = null;
          setOpen(true);
        }}
      >
        {t("campaign.sharing.title")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!pending && !request.current) setOpen(v);
        }}
        title={t("campaign.sharing.title")}
        description={t("campaign.sharing.disclosure")}
        closeLabel={t("campaign.templates.cancel")}
        actions={
          <Button
            disabled={
              pending ||
              props.disabled ||
              stale ||
              (audience === "selected_players" && grants.length === 0)
            }
            pending={pending}
            onClick={() => void send()}
          >
            {request.current
              ? t("campaign.sharing.retry")
              : audience === "all_players"
                ? t("campaign.sharing.reveal")
                : t("campaign.sharing.save")}
          </Button>
        }
      >
        <AudienceFields
          audience={audience}
          setAudience={setAudience}
          grants={grants}
          setGrants={setGrants}
          members={props.members}
          disabled={pending || !!request.current || stale}
        />
        {error ? <p role="alert">{error}</p> : null}
        {stale ? (
          <Button
            onClick={() => {
              setOpen(false);
              props.onDone();
            }}
          >
            {t("campaign.templates.refresh")}
          </Button>
        ) : null}
      </Dialog>
    </>
  );
}
