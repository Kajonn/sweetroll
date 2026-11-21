// Design 6.8 (extensions plan E6): the creator in extension mode. An
// extension adds templates and their formulas only, so the editor shows
// Overview, Templates and Publish. Formulas are written against the base
// version chosen on Overview: its character fields, sheets and reference
// data are loaded read-only as context for the templates editor. The server
// assesses every saved draft against that base version.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";

import { ApiError, type ApiClient } from "../api/client.js";
import { TemplatesTab } from "../editor/TemplatesTab.js";
import { t } from "../i18n/index.js";
import { documentReducer, type SystemDocumentV1 } from "../state/documentReducer.js";
import { Button, Checkbox, FormField, PageHeader, Panel, Select, Tabs } from "../ui/index.js";
import { randomUUID } from "../utils/uuid";
import {
  listBaseVersions,
  loadBasePackage,
  openExtension,
  publishExtension,
  saveExtensionDraft,
  type ExtensionDocument,
  type ExtensionWorkspace,
  type SystemExportResponse,
} from "./api.js";

type BasePackage = SystemExportResponse["package"];

/** The templates editor works on a system document; the base supplies its read-only context. */
export function editorDocument(extension: ExtensionDocument, base: BasePackage | null): SystemDocumentV1 {
  const context = (base ?? { entities: [], sheets: [], slots: [], referenceData: [] }) as unknown as Pick<
    SystemDocumentV1, "entities" | "sheets" | "slots" | "referenceData"
  >;
  return {
    schemaVersion: "2.0",
    metadata: { ...(extension.metadata as { name: string; description: string; language: string }), defaultDice: "d20" },
    entities: structuredClone(context.entities ?? []),
    referenceData: structuredClone(context.referenceData ?? []),
    sheets: structuredClone(context.sheets ?? []),
    slots: structuredClone(context.slots ?? []),
    expressions: structuredClone(extension.expressions) as SystemDocumentV1["expressions"],
    actions: [],
    validations: [],
    templates: structuredClone(extension.templates) as SystemDocumentV1["templates"],
  } as SystemDocumentV1;
}

/** Only metadata, templates and their expressions belong to the extension. */
export function extensionDocumentFrom(document: SystemDocumentV1): ExtensionDocument {
  return {
    schemaVersion: "2.0",
    metadata: { name: document.metadata.name, description: document.metadata.description, language: document.metadata.language },
    expressions: structuredClone(document.expressions ?? []),
    templates: structuredClone(document.templates ?? []),
  } as ExtensionDocument;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== "" ? cause.message : fallback;
}

export function ExtensionEditor({ client, extensionId }: { client: ApiClient; extensionId: string }) {
  const queryClient = useQueryClient();
  const workspaceQuery = useQuery({ queryKey: ["extension", "open", extensionId], queryFn: () => openExtension(client, extensionId) });
  const [workspace, setWorkspace] = useState<ExtensionWorkspace | null>(null);
  const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
  const baseQuery = useQuery({
    queryKey: ["extension", "base", baseVersionId],
    queryFn: () => loadBasePackage(client, baseVersionId!),
    enabled: baseVersionId !== null,
  });
  const versionsQuery = useQuery({
    queryKey: ["extension", "base-versions", workspace?.extension.baseSystemId],
    queryFn: () => listBaseVersions(client, workspace!.extension.baseSystemId),
    enabled: workspace !== null,
  });
  const [document, dispatch] = useReducer(documentReducer, null as unknown as SystemDocumentV1);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  const [semanticVersion, setSemanticVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [acknowledgeBreaking, setAcknowledgeBreaking] = useState(false);

  const adopt = (next: ExtensionWorkspace) => {
    setWorkspace(next);
    setBaseVersionId(next.draft?.baseVersionId ?? null);
    setDirty(false);
  };
  useEffect(() => {
    if (workspaceQuery.data !== undefined) adopt(workspaceQuery.data.workspace);
  }, [workspaceQuery.data]);
  // Rebuild the editing document whenever the saved draft or its base changes.
  useEffect(() => {
    if (workspace?.draft == null) return;
    dispatch({ type: "replace", document: editorDocument(workspace.draft.document, baseQuery.data?.package ?? null) });
  }, [workspace, baseQuery.data]);

  if (workspaceQuery.isError) return <p role="alert">{t("extensions.editor.loadFailed")}</p>;
  if (workspace === null || document === null) return <p role="status">{t("editor.loading")}</p>;
  const draft = workspace.draft;
  const editable = workspace.extension.owned && workspace.extension.lifecycle === "active" && draft !== null;

  const change: typeof dispatch = (action) => { dispatch(action); setDirty(true); setNotice(null); };

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await saveExtensionDraft(client, extensionId, {
        expectedRevision: draft.revision,
        document: extensionDocumentFrom(document),
        ...(baseVersionId !== null && baseVersionId !== draft.baseVersionId ? { baseVersionId } : {}),
      });
      adopt(response.workspace);
      setNotice(t("extensions.editor.saved"));
      await queryClient.invalidateQueries({ queryKey: ["extensions", "list", workspace.extension.baseSystemId] });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? t("extensions.editor.conflict")
        : message(cause, t("extensions.editor.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await publishExtension(client, extensionId, {
        expectedRevision: draft.revision,
        semanticVersion: semanticVersion.trim(),
        releaseNotes,
        acknowledgeBreaking,
        idempotencyKey: randomUUID(),
      });
      setNotice(t("extensions.editor.published", { version: response.version.semanticVersion }));
      setSemanticVersion("");
      setReleaseNotes("");
      setAcknowledgeBreaking(false);
      await workspaceQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ["extensions", "list", workspace.extension.baseSystemId] });
    } catch (cause) {
      setError(message(cause, t("extensions.editor.publishFailed")));
    } finally {
      setBusy(false);
    }
  };

  const baseChoices = versionsQuery.data?.data.versions ?? [];
  const assessment = workspace.assessment;
  const overview = (
    <Panel title={t("extensions.editor.overview")}>
      <FormField label={t("extensions.name")}>
        <input
          id="extension-editor-name"
          value={document.metadata.name}
          disabled={!editable}
          onChange={(event) => change({ type: "setMetadata", patch: { name: event.target.value } })}
        />
      </FormField>
      <FormField label={t("extensions.editor.description")}>
        <textarea
          id="extension-editor-description"
          value={document.metadata.description}
          disabled={!editable}
          onChange={(event) => change({ type: "setMetadata", patch: { description: event.target.value } })}
        />
      </FormField>
      <Select
        label={t("extensions.baseVersion")}
        hint={t("extensions.editor.baseHint")}
        value={baseVersionId ?? ""}
        disabled={!editable}
        onChange={(event) => { setBaseVersionId(event.target.value); setDirty(true); }}
        options={baseChoices.map((choice) => ({ value: choice.versionId, label: choice.semanticVersion }))}
      />
      {baseQuery.isError ? <p role="alert">{t("extensions.editor.baseFailed")}</p> : null}
    </Panel>
  );
  const publishPanel = (
    <Panel title={t("extensions.editor.publish")}>
      {assessment.diagnostics.length > 0 ? (
        <section aria-label={t("extensions.editor.problems")}>
          <h3>{t("extensions.editor.problems")}</h3>
          <ul>{assessment.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic.message}</li>)}</ul>
        </section>
      ) : <p role="status">{t(dirty ? "extensions.editor.saveFirst" : "extensions.editor.ready")}</p>}
      {assessment.warnings.length > 0 ? (
        <section aria-label={t("extensions.editor.warnings")}>
          <h3>{t("extensions.editor.warnings")}</h3>
          <ul>{assessment.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul>
        </section>
      ) : null}
      <FormField label={t("extensions.editor.semanticVersion")}>
        <input id="extension-editor-semver" value={semanticVersion} placeholder="1.0.0" disabled={!editable}
          onChange={(event) => setSemanticVersion(event.target.value)} />
      </FormField>
      <FormField label={t("extensions.editor.releaseNotes")}>
        <textarea id="extension-editor-notes" value={releaseNotes} disabled={!editable}
          onChange={(event) => setReleaseNotes(event.target.value)} />
      </FormField>
      <Checkbox
        label={t("extensions.editor.acknowledgeBreaking")}
        checked={acknowledgeBreaking}
        disabled={!editable}
        onChange={(event) => setAcknowledgeBreaking(event.target.checked)}
      />
      <Button
        variant="primary"
        pending={busy}
        disabled={!editable || busy || dirty || !assessment.ok || !/^\d+\.\d+\.\d+$/.test(semanticVersion.trim())}
        onClick={() => void publish()}
      >
        {t("extensions.editor.publishConfirm")}
      </Button>
      {workspace.versions.length > 0 ? (
        <section aria-label={t("extensions.editor.versions")}>
          <h3>{t("extensions.editor.versions")}</h3>
          <ul>{workspace.versions.map((version) => <li key={version.versionId}>{version.semanticVersion}</li>)}</ul>
        </section>
      ) : null}
    </Panel>
  );

  return (
    <section aria-labelledby="extension-editor-title">
      <PageHeader
        title={<span id="extension-editor-title">{t("extensions.editor.title", { name: workspace.extension.name })}</span>}
        description={t("extensions.editor.explain")}
        actions={editable ? (
          <Button variant="primary" pending={busy} disabled={busy || !dirty} onClick={() => void save()} data-testid="extension-save">
            {t("extensions.editor.save")}
          </Button>
        ) : null}
      />
      {error !== null ? <p role="alert">{error}</p> : null}
      {notice !== null ? <p role="status">{notice}</p> : null}
      {dirty ? <p role="status">{t("extensions.editor.unsaved")}</p> : null}
      {!workspace.extension.owned ? <p role="status">{t("extensions.editor.readOnly")}</p> : null}
      <Tabs
        ariaLabel={t("extensions.editor.tabs")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: t("extensions.editor.overview"), content: overview },
          {
            id: "templates",
            label: t("extensions.editor.templates"),
            content: <TemplatesTab client={client} document={document} dispatch={change} showSlots={false} />,
            disabled: !editable,
          },
          { id: "publish", label: t("extensions.editor.publish"), content: publishPanel },
        ]}
      />
    </section>
  );
}
