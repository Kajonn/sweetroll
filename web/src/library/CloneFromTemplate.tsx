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
    systemId: "a0000000-0000-5000-8000-000000000001",
    versionId: "a0000000-0000-5000-8000-000000000002",
  },
  {
    templateKey: "pbta2d6",
    systemId: "b0000000-0000-5000-8000-000000000001",
    versionId: "b0000000-0000-5000-8000-000000000002",
  },
  {
    templateKey: "d6SuccessPool",
    systemId: "c0000000-0000-5000-8000-000000000001",
    versionId: "c0000000-0000-5000-8000-000000000002",
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