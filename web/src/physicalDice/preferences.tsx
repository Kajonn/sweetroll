import { useState } from "react";
import { Button } from "../ui/index.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.js";
import { t } from "../i18n/index.js";
import type { AccountPreferences } from "../../../src/identity/repository.js";

type DicePreferences = Pick<AccountPreferences, "show_3d_dice" | "dice_color">;
export function useDicePreferences(client: ApiClient, actor: string) {
  const key = ["preferences", "physical-dice", actor];
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: key,
    staleTime: 60000,
    queryFn: () => client.fetch<DicePreferences>("GET", "/me/preferences"),
  });
  const save = useMutation({
    mutationFn: (body: Partial<DicePreferences>) =>
      client.fetch<DicePreferences>("PATCH", "/me/preferences", { body }),
    onSuccess: (value) => queryClient.setQueryData(key, value),
  });
  return { preferences, save };
}

export function DicePreferencesPanel({
  client,
  actor,
  online,
}: {
  client: ApiClient;
  actor: string;
  online: boolean;
}) {
  const { preferences, save } = useDicePreferences(client, actor);
  const [colorDraft, setColorDraft] = useState<string | null>(null);
  const disabled = !online || save.isPending || !preferences.data;
  return (
    <fieldset disabled={disabled}>
      <legend>{t("physicalDice.settings")}</legend>
      <label>
        <input
          type="checkbox"
          checked={preferences.data?.show_3d_dice ?? false}
          onChange={(event) => save.mutate({ show_3d_dice: event.target.checked })}
        />
        {t("physicalDice.show")}
      </label>{" "}
      <label>
        {t("physicalDice.color")}{" "}
        <input
          type="color"
          value={colorDraft ?? preferences.data?.dice_color ?? "#4c79c9"}
          onChange={(event) => setColorDraft(event.target.value)}
        />
      </label>{" "}
      <Button
        type="button"
        variant="secondary"
        disabled={!colorDraft || colorDraft === preferences.data?.dice_color}
        onClick={() => {
          if (colorDraft) save.mutate({ dice_color: colorDraft }, { onSuccess: () => setColorDraft(null) });
        }}
      >
        {t("physicalDice.saveColor")}
      </Button>
      {preferences.isError || save.isError ? <p role="alert">{t("physicalDice.preferencesFailed")}</p> : null}
    </fieldset>
  );
}
