import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useCreateDraft } from "../api/createDraft.js";
import type { ApiClient } from "../api/client.js";
import { t } from "../i18n/index.js";

type TemplateSpec = {
  templateKey: "d20" | "pbta2d6" | "d6SuccessPool";
  systemId: string;
  versionId: string;
};

const TEMPLATES: ReadonlyArray<TemplateSpec> = [
  {
    templateKey: "d20",
    systemId: "00000000-0000-0000-0000-000000000a01",
    versionId: "11111111-1111-1111-1111-111111111a01",
  },
  {
    templateKey: "pbta2d6",
    systemId: "00000000-0000-0000-0000-000000000a02",
    versionId: "11111111-1111-1111-1111-111111111a02",
  },
  {
    templateKey: "d6SuccessPool",
    systemId: "00000000-0000-0000-0000-000000000a03",
    versionId: "11111111-1111-1111-1111-111111111a03",
  },
];

export function CloneFromTemplate({ client }: { client: ApiClient }) {
  const mutation = useCreateDraft(client);
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);

  const clone = async (tpl: TemplateSpec) => {
    setPending(tpl.versionId);
    try {
      const out = await mutation.mutateAsync({
        source: { kind: "clone", versionId: tpl.versionId },
        idempotencyKey: crypto.randomUUID(),
      });
      await navigate({ to: "/systems/$systemId", params: { systemId: out.system.systemId } });
    } catch {
      // mutateAsync rethrows; surface the error via the hook state and let the
      // caller retry. Pending state resets so other templates remain clickable.
    } finally {
      setPending(null);
    }
  };

  return (
    <section data-testid="clone-from-template" aria-label={t("library.cloneFromTemplate.label")}>
      <h2>{t("library.cloneFromTemplate.label")}</h2>
      <ul>
        {TEMPLATES.map((tpl) => {
          const isPending = pending === tpl.versionId || mutation.isPending;
          return (
            <li key={tpl.templateKey}>
              <button
                type="button"
                data-testid={`clone-from-template-${tpl.templateKey}`}
                disabled={isPending}
                onClick={() => void clone(tpl)}
              >
                {isPending
                  ? t("library.cloneFromTemplate.cloning")
                  : t(`library.cloneFromTemplate.${tpl.templateKey}`)}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export const CLONE_FROM_TEMPLATE_FIXTURES = TEMPLATES;