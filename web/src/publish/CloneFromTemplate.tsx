import { useState } from "react";

import { ApiError, type ApiClient } from "../api/client.js";
import { useCreateDraft } from "../api/createDraft.js";
import { useListTemplates, type Template } from "../api/listTemplates.js";
import { t } from "../i18n/index.js";

export function CloneFromTemplate({ client }: { client: ApiClient }) {
  const templates = useListTemplates(client);
  const mutation = useCreateDraft(client);
  const [pending, setPending] = useState<string | null>(null);
  const [failedTemplateId, setFailedTemplateId] = useState<string | null>(null);

  const clone = async (tpl: Template) => {
    setFailedTemplateId(null);
    setPending(tpl.templateId);
    try {
      const out = await mutation.mutateAsync({
        source: { kind: "clone", versionId: tpl.versionId },
        idempotencyKey: crypto.randomUUID(),
      });
      location.assign(`/systems/${out.system.systemId}`);
    } catch {
      setFailedTemplateId(tpl.templateId);
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-label={t("templates.title")} data-testid="clone-from-template">
      <h2>{t("templates.title")}</h2>
      {templates.isPending && (
        <p data-testid="clone-from-template-loading">{t("templates.loading")}</p>
      )}
      {templates.isError && (
        <p role="alert" data-testid="clone-from-template-error">
          {templates.error instanceof ApiError
            ? t("templates.error")
            : t("templates.error")}
        </p>
      )}
      {templates.data !== undefined && templates.data.length === 0 && (
        <p data-testid="clone-from-template-empty">{t("templates.empty")}</p>
      )}
      {templates.data !== undefined && templates.data.length > 0 && (
        <ul data-testid="clone-from-template-list">
          {templates.data.map((tpl) => {
            const isPending = pending === tpl.templateId || mutation.isPending;
            const errored = failedTemplateId === tpl.templateId;
            return (
              <li key={tpl.templateId} data-testid={`clone-from-template-item-${tpl.templateId}`}>
                <span>{tpl.label}</span>
                <button
                  type="button"
                  onClick={() => void clone(tpl)}
                  disabled={isPending}
                  data-testid={`clone-from-template-${tpl.templateId}`}
                >
                  {isPending ? t("templates.cloning") : t("templates.clone")}
                </button>
                {errored && (
                  <p role="alert" data-testid={`clone-from-template-error-${tpl.templateId}`}>
                    {t("templates.clone.error", { template: tpl.label })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}