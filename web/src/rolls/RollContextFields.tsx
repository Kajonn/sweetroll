import { useState } from "react";

import type { CharactersApi } from "../characters/api.js";
import type { CampaignRollSelection, RollOptionsResponse } from "../characters/types.js";
import { t } from "../i18n/index.js";
import { Button, Select } from "../ui/index.js";

export type RollRequirements = { target?: { entityId: string }; respondsTo?: true };

export function hasRollSelection(requirements: RollRequirements, selection: CampaignRollSelection): boolean {
  return (!requirements.target || Boolean(selection.targetCharacterId))
    && (!requirements.respondsTo || Boolean(selection.respondsTo));
}

export function RollContextFields({
  requirements, selection, onChange, disabled, characterId, actionId, entryId, loadOptions,
}: {
  requirements: RollRequirements;
  selection: CampaignRollSelection;
  onChange: (selection: CampaignRollSelection) => void;
  disabled: boolean;
  characterId?: string | undefined;
  actionId: string;
  entryId?: string | undefined;
  loadOptions?: CharactersApi["rollOptions"];
}) {
  const [options, setOptions] = useState<RollOptionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!requirements.target && !requirements.respondsTo) return null;
  if (!characterId || !loadOptions) return <p>{t("character.action.campaignOnly")}</p>;

  async function load() {
    if (!characterId || !loadOptions) return;
    setLoading(true);
    setFailed(false);
    try {
      const result = await loadOptions(characterId, actionId, entryId);
      setOptions(result);
      onChange({});
    } catch {
      setOptions(null);
      onChange({});
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return <>
    <Button type="button" variant="secondary" disabled={disabled || loading} onClick={() => void load()}>
      {t("character.action.rollOptions")}
    </Button>
    {failed ? <p role="alert">{t("character.action.rollOptionsFailed")}</p> : null}
    {requirements.target && options ? <Select
      label={t("character.action.rollTarget")}
      value={selection.targetCharacterId ?? ""}
      disabled={disabled || loading || options.targets.length === 0}
      options={[
        { value: "", label: t(options.targets.length === 0 ? "character.action.noTargets" : "character.action.selectTarget") },
        ...options.targets.map(target => ({ value: target.characterId, label: target.name })),
      ]}
      onChange={event => onChange({ ...selection, targetCharacterId: event.target.value })}
    /> : null}
    {requirements.respondsTo && options ? <Select
      label={t("character.action.opposedRoll")}
      value={selection.respondsTo ?? ""}
      disabled={disabled || loading || options.rolls.length === 0}
      options={[
        { value: "", label: t(options.rolls.length === 0 ? "character.action.noOpposedRolls" : "character.action.selectRoll") },
        ...options.rolls.map(roll => ({ value: roll.rollId, label: roll.output || roll.rollId })),
      ]}
      onChange={event => onChange({ ...selection, respondsTo: event.target.value })}
    /> : null}
  </>;
}
