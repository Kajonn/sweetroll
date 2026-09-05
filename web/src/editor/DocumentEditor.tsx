import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { useOpenSystem } from "../api/openSystem.js";
import type { DocumentAssessment } from "../api/server.js";
import { t } from "../i18n/index.js";
import { ResourceBumpEditor, type ResourceBumpActionV1 } from "./actions/ResourceBumpEditor.js";
import { RollActionEditor, type RollActionV1 } from "./actions/RollActionEditor.js";
import { ConflictBanner } from "./ConflictBanner.js";
import { DiagnosticsDrawer } from "./DiagnosticsDrawer.js";
import { EntityList, type EntityListEntity } from "./EntityList.js";
import { MetadataEditor } from "./MetadataEditor.js";
import { PreviewFrame } from "../preview/PreviewFrame.js";
import { PreviewSheet } from "../preview/PreviewSheet.js";
import { generateSample } from "../preview/sampleData.js";
import { PublishDialog } from "../publish/PublishDialog.js";
import { VersionHistory } from "../publish/VersionHistory.js";
import { ReferenceDataEditor, type ReferenceDataV1 } from "./referenceData/ReferenceDataEditor.js";
import { SheetEditor } from "./sheet/SheetEditor.js";
import type { SheetEditorV1 } from "./sheet/sheetTypes.js";
import { useDraftSync } from "../state/draftSync.js";
import {
  blankDocument,
  documentReducer,
  type DocumentAction,
  type EntityDefinitionV1,
  type EntityFieldV1,
  type SystemDocumentV1,
  type ValidationV1,
} from "../state/documentReducer.js";
import { useShortcut } from "../shell/useShortcut.js";
import { ValidationEditor } from "./validations/ValidationEditor.js";
import styles from "./DocumentEditor.module.css";

type TabId = "metadata" | "entities" | "sheets" | "actions" | "validations" | "referenceData";

const TABS: ReadonlyArray<TabId> = [
  "metadata",
  "entities",
  "sheets",
  "actions",
  "validations",
  "referenceData",
];

function isTabId(value: string): value is TabId {
  return (TABS as ReadonlyArray<string>).includes(value);
}

function readActiveTab(): TabId {
  if (typeof window === "undefined") return "metadata";
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab !== null && isTabId(tab)) return tab;
  return "metadata";
}

export function DocumentEditor({ client, systemId }: { client: ApiClient; systemId: string }) {
  const query = useOpenSystem(client, systemId);
  const [active] = useState<TabId>(() => readActiveTab());

  if (query.isPending) {
    return (
      <section className={styles.container} data-testid="document-editor-loading">
        <p role="status" className={styles.placeholder}>
          {t("editor.loading")}
        </p>
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className={styles.container} data-testid="document-editor-error">
        <p role="alert" className={styles.placeholder}>
          {t("editor.error")}
        </p>
      </section>
    );
  }
  if (query.data === undefined) return null;

  const ws = query.data;
  const initialDoc: SystemDocumentV1 =
    ws.draft?.document !== undefined
      ? (ws.draft.document as SystemDocumentV1)
      : blankDocument();
  return (
    <DocumentEditorBody
      client={client}
      ws={ws}
      active={active}
      initialDoc={initialDoc}
      assessment={ws.assessment}
    />
  );
}

function autosaveLabel(status: ReturnType<typeof useDraftSync>["status"]): string {
  switch (status) {
    case "idle":
      return t("editor.autosave.idle");
    case "saving":
      return t("editor.autosave.saving");
    case "saved":
      return t("editor.autosave.saved");
    case "conflict":
      return t("editor.autosave.conflict");
    case "error":
      return t("editor.autosave.error");
  }
}

function DocumentEditorBody({
  client,
  ws,
  active,
  initialDoc,
  assessment,
}: {
  client: ApiClient;
  ws: NonNullable<ReturnType<typeof useOpenSystem>["data"]>;
  active: TabId;
  initialDoc: SystemDocumentV1;
  assessment: DocumentAssessment;
}) {
  const [document, dispatch] = useReducer(documentReducer, initialDoc);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(
    initialDoc.entities[0]?.id ?? null,
  );
  const lastServerRevision = useRef<number | null>(ws.draft?.revision ?? null);
  useEffect(() => {
    const serverRevision = ws.draft?.revision ?? null;
    if (serverRevision !== lastServerRevision.current) {
      lastServerRevision.current = serverRevision;
      const serverDoc =
        ws.draft?.document !== undefined ? (ws.draft.document as SystemDocumentV1) : blankDocument();
      dispatch({ type: "setMetadata", patch: serverDoc.metadata });
      dispatch({
        type: "setEntities",
        entities: serverDoc.entities as unknown as EntityDefinitionV1[],
      });
      dispatch({
        type: "setSheets",
        sheets: serverDoc.sheets as unknown as SystemDocumentV1["sheets"][number][],
      });
      dispatch({
        type: "setActions",
        actions: serverDoc.actions as unknown as SystemDocumentV1["actions"][number][],
      });
      dispatch({
        type: "setValidations",
        validations: serverDoc.validations as unknown as ValidationV1[],
      });
      dispatch({
        type: "setReferenceData",
        referenceData: serverDoc.referenceData as unknown as SystemDocumentV1["referenceData"][number][],
      });
    }
  }, [ws.draft?.revision, ws.draft?.document]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const draftRevision = ws.draft?.revision ?? null;
  const queryClient = useQueryClient();

  const sync = useDraftSync({
    client,
    systemId: ws.system.systemId,
    onAcceptTheirs: () => {
      queryClient.invalidateQueries({ queryKey: ["system", "open", ws.system.systemId] });
    },
  });

  const bodyRef = useRef<HTMLDivElement>(null);
  useFocusEditorListener(bodyRef);

  useEffect(() => {
    sync.save(document, draftRevision);
    // We intentionally re-run on every document change to autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]);

  const errorCount = assessment.diagnostics.length;
  const publishDisabled = errorCount > 0;
  const previewPackage = useMemo(() => buildPreviewPackage(document), [document]);
  const previewSample = useMemo(
    () => (previewPackage === null ? null : generateSample(previewPackage)),
    [previewPackage],
  );

  useShortcut("Alt+P", () => setPreviewOpen((v) => !v));
  useShortcut("Alt+D", () => setDiagnosticsOpen((v) => !v));
  useShortcut("Alt+V", () => setVersionHistoryOpen((v) => !v));

  return (
    <section className={styles.container}>
      <header className={styles.header} data-testid="document-editor-header">
        <h1
          className={styles.name}
          contentEditable
          suppressContentEditableWarning
          aria-label={t("editor.systemNameAria")}
          data-testid="document-editor-name"
          onBlur={(e) => {
            const text = e.currentTarget.textContent ?? "";
            if (text !== ws.system.name) {
              // System name is metadata; reroute through the document reducer.
              dispatch({ type: "setMetadata", patch: { name: text } });
            }
          }}
        >
          {ws.system.name}
        </h1>
        <span className={styles.lifecycle} data-testid="document-editor-lifecycle">
          {t(`editor.lifecycle.${ws.system.lifecycle}`)}
        </span>
        <span className={styles.autosave} data-testid="document-editor-autosave">
          <Check aria-hidden size={14} />
          {autosaveLabel(sync.status)}
        </span>
        <button
          type="button"
          className={styles.secondary}
          data-testid="document-editor-preview-toggle"
          aria-pressed={previewOpen}
          onClick={() => setPreviewOpen((v) => !v)}
          title={t("editor.preview.buttonShortcut")}
        >
          {t("editor.preview.buttonLabel")}
        </button>
        <button
          type="button"
          className={styles.secondary}
          data-testid="document-editor-diagnostics-toggle"
          aria-pressed={diagnosticsOpen}
          onClick={() => setDiagnosticsOpen((v) => !v)}
        >
          {t("editor.diagnostics.buttonLabel")}
          {errorCount > 0 ? ` (${errorCount})` : ""}
        </button>
        <button
          type="button"
          className={styles.secondary}
          data-testid="document-editor-version-history-toggle"
          aria-pressed={versionHistoryOpen}
          onClick={() => setVersionHistoryOpen((v) => !v)}
        >
          {t("editor.versionHistory.buttonLabel")}
        </button>
        <button
          type="button"
          className={styles.publish}
          data-testid="document-editor-publish"
          disabled={publishDisabled}
          aria-disabled={publishDisabled ? "true" : undefined}
          onClick={() => setPublishOpen(true)}
          title={
            publishDisabled
              ? t("editor.publish.disabled.reason", { count: errorCount })
              : undefined
          }
        >
          {t("editor.publish.label")}
        </button>
      </header>
      {sync.banner !== null && (
        <ConflictBanner
          latestRevision={sync.banner.latestRevision}
          onAcceptTheirs={sync.banner.onAcceptTheirs}
          onKeepMine={sync.banner.onKeepMine}
          onMergeIntoServer={sync.banner.onMergeIntoServer}
          onDismiss={sync.banner.onDismiss}
        />
      )}
      <nav className={styles.tabs} aria-label={t("editor.tabsAriaLabel")}>
        {TABS.map((tab) => {
          const isActive = tab === active;
          return (
            <a
              key={tab}
              href={`?tab=${tab}`}
              aria-current={isActive ? "page" : undefined}
              className={isActive ? styles.tabActive : styles.tab}
              data-testid={`document-editor-tab-${tab}`}
            >
              {t(`editor.tab.${tab}`)}
            </a>
          );
        })}
      </nav>
      <main className={styles.body} ref={bodyRef} data-testid={`document-editor-body-${active}`}>
        {previewOpen && previewPackage !== null && previewSample !== null ? (
          <div className={styles.previewPane} data-testid="document-editor-preview">
            <PreviewFrame>
              <PreviewSheet pkg={previewPackage} sample={previewSample} />
            </PreviewFrame>
          </div>
        ) : null}
        {diagnosticsOpen ? (
          <div className={styles.diagnosticsPane} data-testid="document-editor-diagnostics">
            <DiagnosticsDrawer assessment={assessment} />
          </div>
        ) : null}
        {active === "metadata" ? (
          <MetadataEditor
            document={document}
            onChange={(next) => {
              const patch = diffMetadata(document.metadata, next.metadata);
              if (patch !== null) dispatch({ type: "setMetadata", patch });
            }}
          />
        ) : active === "entities" ? (
          <EntitiesTab
            entities={document.entities}
            selectedEntityId={selectedEntityId}
            onSelectEntity={setSelectedEntityId}
            dispatch={dispatch}
          />
        ) : active === "sheets" ? (
          <SheetsTab document={document} dispatch={dispatch} />
        ) : active === "actions" ? (
          <ActionsTab client={client} document={document} dispatch={dispatch} />
        ) : active === "validations" ? (
          <ValidationsTab client={client} document={document} dispatch={dispatch} />
        ) : active === "referenceData" ? (
          <ReferenceDataTab document={document} dispatch={dispatch} />
        ) : null}
      </main>
      <PublishDialog
        client={client}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        systemId={ws.system.systemId}
        expectedRevision={draftRevision ?? 0}
      />
      {versionHistoryOpen ? (
        <VersionHistoryOverlay
          client={client}
          systemId={ws.system.systemId}
          onClose={() => setVersionHistoryOpen(false)}
        />
      ) : null}
    </section>
  );
}

function diffMetadata(
  before: SystemDocumentV1["metadata"],
  after: SystemDocumentV1["metadata"],
): Partial<SystemDocumentV1["metadata"]> | null {
  const patch: Partial<SystemDocumentV1["metadata"]> = {};
  let changed = false;
  for (const key of Object.keys(after) as ReadonlyArray<keyof SystemDocumentV1["metadata"]>) {
    if (before[key] !== after[key]) {
      (patch as Record<string, unknown>)[key] = after[key];
      changed = true;
    }
  }
  return changed ? patch : null;
}

function EntitiesTab({
  entities,
  selectedEntityId,
  onSelectEntity,
  dispatch,
}: {
  entities: EntityDefinitionV1[];
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
  dispatch: React.Dispatch<DocumentAction>;
}) {
  const entityList: EntityListEntity[] = entities.map((entity) => ({
    id: entity.id,
    label: entity.label,
    fields: entity.fields as unknown as EntityListEntity["fields"],
  }));
  return (
    <EntityList
      entities={entityList}
      selectedEntityId={selectedEntityId}
      onSelectEntity={onSelectEntity}
      onChange={(next) => {
        dispatch({
          type: "setEntities",
          entities: next as unknown as EntityDefinitionV1[],
        });
      }}
    />
  );
}

function SheetsTab({
  document,
  dispatch,
}: {
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
}) {
  const sheets = (document.sheets as unknown as SheetEditorView[]) ?? [];
  const addSheet = () => {
    const id = nextSheetId(sheets.map((s) => s.id));
    const next: SheetEditorView = {
      id,
      label: t("editor.sheet.label"),
      targetEntityId: document.entities[0]?.id ?? "",
      sections: [],
    };
    dispatch({
      type: "setSheets",
      sheets: [...sheets, next] as unknown as SystemDocumentV1["sheets"][number][],
    });
  };
  const replaceSheet = (idx: number, sheet: SheetEditorView) => {
    const next = sheets.map((s, i) => (i === idx ? sheet : s));
    dispatch({
      type: "setSheets",
      sheets: next as unknown as SystemDocumentV1["sheets"][number][],
    });
  };
  const removeSheet = (idx: number) => {
    dispatch({
      type: "setSheets",
      sheets: sheets.filter((_, i) => i !== idx) as unknown as SystemDocumentV1["sheets"][number][],
    });
  };
  return (
    <section data-testid="sheets-tab" data-path="/sheets">
      <header className={styles.tabHeader}>
        <h2 className={styles.tabTitle}>{t("editor.sheet.label")}</h2>
        <button
          type="button"
          onClick={addSheet}
          data-testid="sheet-add-button"
        >
          {t("editor.sheets.addSheet")}
        </button>
      </header>
      {sheets.length === 0 ? (
        <p className={styles.placeholder} data-testid="sheets-tab-empty">{t("editor.sheets.empty")}</p>
      ) : (
        <ul className={styles.sheetList}>
          {sheets.map((sheet, idx) => (
            <li key={sheet.id} data-path={`/sheets/${idx}`}>
              <SheetEditor
                sheet={sheet}
                onChange={(next) => replaceSheet(idx, next)}
              />
              <button
                type="button"
                onClick={() => removeSheet(idx)}
                data-testid={`sheets-tab-remove-${idx}`}
                className={styles.removeButton}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type SheetEditorView = SheetEditorV1;

function nextSheetId(existing: ReadonlyArray<string>): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `sheet_${i}`;
    if (!existing.some((id) => id === candidate)) return candidate;
  }
  return `sheet_${Date.now()}`;
}

function ActionsTab({
  client,
  document,
  dispatch,
}: {
  client: ApiClient;
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
}) {
  const actions = (document.actions as unknown as Array<RollActionV1 | ResourceBumpActionV1>) ?? [];
  const expressions = (document.expressions as unknown as Array<{
    id: string;
    source: string;
    resultType: string;
    fallback: unknown;
    context: string;
  }>) ?? [];

  const addRoll = () => {
    const id = nextActionId(actions.map((a) => a.id));
    const next: RollActionV1 = {
      kind: "roll",
      id,
      label: t("editor.actions.kind.roll"),
      expressionId: expressions[0]?.id ?? "",
      inputs: [],
      outputTemplate: "Result: {total}",
    };
    dispatch({
      type: "setActions",
      actions: [...actions, next as unknown as SystemDocumentV1["actions"][number]],
    });
  };
  const addResourceBump = () => {
    const id = nextActionId(actions.map((a) => a.id));
    const next: ResourceBumpActionV1 = {
      kind: "resourceBump",
      id,
      label: t("editor.actions.kind.resourceBump"),
      resourceId: "",
      operation: { kind: "delta", amount: 1 },
    };
    dispatch({
      type: "setActions",
      actions: [...actions, next as unknown as SystemDocumentV1["actions"][number]],
    });
  };
  const replaceAction = (idx: number, action: RollActionV1 | ResourceBumpActionV1) => {
    const next = actions.map((a, i) => (i === idx ? action : a));
    dispatch({
      type: "setActions",
      actions: next as unknown as SystemDocumentV1["actions"][number][],
    });
  };
  const removeAction = (idx: number) => {
    dispatch({
      type: "setActions",
      actions: actions.filter((_, i) => i !== idx) as unknown as SystemDocumentV1["actions"][number][],
    });
  };

  const expressionSourceMap = new Map<string, string>();
  for (const e of expressions) expressionSourceMap.set(e.id, e.source ?? "");

  return (
    <section data-testid="actions-tab" data-path="/actions">
      <header className={styles.tabHeader}>
        <h2 className={styles.tabTitle}>{t("editor.actions.addTitle")}</h2>
        <button type="button" onClick={addRoll} data-testid="actions-add-roll">
          {t("editor.actions.addRoll")}
        </button>
        <button type="button" onClick={addResourceBump} data-testid="actions-add-resource-bump">
          {t("editor.actions.addResourceBump")}
        </button>
      </header>
      {actions.length === 0 ? (
        <p className={styles.placeholder} data-testid="actions-tab-empty">{t("editor.actions.empty")}</p>
      ) : (
        <ul className={styles.actionList}>
          {actions.map((action, idx) => (
            <li key={action.id} data-path={`/actions/${idx}`}>
              {action.kind === "roll" ? (
                <RollActionEditor
                  client={client}
                  systemId="s1"
                  action={action}
                  onChange={(next) => replaceAction(idx, next)}
                  expressionSource={expressionSourceMap.get(action.expressionId) ?? ""}
                  onExpressionSourceChange={(next) => {
                    expressionSourceMap.set(action.expressionId, next);
                  }}
                  fieldTypes={buildFieldTypeMap(document)}
                />
              ) : (
                <ResourceBumpEditor
                  action={action}
                  onChange={(next) => replaceAction(idx, next)}
                  availableResources={collectResourceFields(document)}
                />
              )}
              <button
                type="button"
                onClick={() => removeAction(idx)}
                data-testid={`actions-tab-remove-${idx}`}
                className={styles.removeButton}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function nextActionId(existing: ReadonlyArray<string>): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `action_${i}`;
    if (!existing.some((id) => id === candidate)) return candidate;
  }
  return `action_${Date.now()}`;
}

function buildFieldTypeMap(document: SystemDocumentV1): Record<string, "number" | "text" | "boolean"> {
  const out: Record<string, "number" | "text" | "boolean"> = {};
  for (const entity of document.entities) {
    for (const field of entity.fields as unknown as EntityFieldV1[]) {
      const kind = (field as { kind?: string }).kind;
      if (kind === "integer" || kind === "decimal" || kind === "resource") {
        out[field.id] = "number";
      } else if (kind === "boolean") {
        out[field.id] = "boolean";
      } else if (kind === "text" || kind === "singleChoice" || kind === "multiChoice") {
        out[field.id] = "text";
      }
    }
  }
  return out;
}

function collectResourceFields(document: SystemDocumentV1): Array<{
  kind: "resource";
  id: string;
  label: string;
  default: { current: number; max: number };
  min: number;
  max: number;
  step: number;
  resetTo: "min" | "max";
}> {
  const out: Array<{
    kind: "resource";
    id: string;
    label: string;
    default: { current: number; max: number };
    min: number;
    max: number;
    step: number;
    resetTo: "min" | "max";
  }> = [];
  for (const entity of document.entities) {
    for (const field of entity.fields as unknown as EntityFieldV1[]) {
      if ((field as { kind?: string }).kind === "resource") {
        const f = field as unknown as {
          id: string;
          label: string;
          default: { current: number; max: number };
          min: number;
          max: number;
          step: number;
          resetTo: "min" | "max";
        };
        out.push({ kind: "resource", id: f.id, label: f.label, default: f.default, min: f.min, max: f.max, step: f.step, resetTo: f.resetTo });
      }
    }
  }
  return out;
}

function ValidationsTab({
  client,
  document,
  dispatch,
}: {
  client: ApiClient;
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
}) {
  const validations = (document.validations as unknown as ValidationV1[]) ?? [];
  const expressions = (document.expressions as unknown as Array<{ id: string; source: string }>) ?? [];
  const expressionSourceMap = new Map<string, string>();
  for (const e of expressions) expressionSourceMap.set(e.id, e.source ?? "");

  const addValidation = () => {
    const id = nextValidationId(validations.map((v) => v.id));
    const next: ValidationV1 = {
      id,
      expressionId: expressions[0]?.id ?? "",
      severity: "warning",
      message: "validation.defaultMessage",
      targetId: document.entities[0]?.id ?? "",
    };
    dispatch({ type: "setValidations", validations: [...validations, next] });
  };
  const replaceValidation = (idx: number, v: ValidationV1) => {
    const next = validations.map((curr, i) => (i === idx ? v : curr));
    dispatch({ type: "setValidations", validations: next });
  };
  const removeValidation = (idx: number) => {
    dispatch({ type: "setValidations", validations: validations.filter((_, i) => i !== idx) });
  };

  const expressionOptions = expressions.map((e) => ({ id: e.id, label: e.id }));
  const targetOptions = document.entities.map((e) => ({ id: e.id, label: e.label }));

  return (
    <section data-testid="validations-tab" data-path="/validations">
      <header className={styles.tabHeader}>
        <h2 className={styles.tabTitle}>{t("editor.actions.addTitle")}</h2>
        <button type="button" onClick={addValidation} data-testid="validations-add-button">
          {t("editor.validations.add")}
        </button>
      </header>
      {validations.length === 0 ? (
        <p className={styles.placeholder} data-testid="validations-tab-empty">{t("editor.validations.empty")}</p>
      ) : (
        <ul className={styles.validationList}>
          {validations.map((v, idx) => (
            <li key={v.id} data-path={`/validations/${idx}`}>
              <ValidationEditor
                client={client}
                systemId="s1"
                validation={v as unknown as Parameters<typeof ValidationEditor>[0]["validation"]}
                onChange={(next) => replaceValidation(idx, next as unknown as ValidationV1)}
                expressionSource={expressionSourceMap.get(v.expressionId) ?? ""}
                onExpressionSourceChange={(next) => {
                  expressionSourceMap.set(v.expressionId, next);
                }}
                availableExpressions={expressionOptions}
                availableTargets={targetOptions}
              />
              <button
                type="button"
                onClick={() => removeValidation(idx)}
                data-testid={`validations-tab-remove-${idx}`}
                className={styles.removeButton}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function nextValidationId(existing: ReadonlyArray<string>): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `validation_${i}`;
    if (!existing.some((id) => id === candidate)) return candidate;
  }
  return `validation_${Date.now()}`;
}

function ReferenceDataTab({
  document,
  dispatch,
}: {
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
}) {
  const referenceData = (document.referenceData as unknown as ReferenceDataV1[]) ?? [];
  const addReferenceData = () => {
    const id = nextReferenceDataId(referenceData.map((r) => r.id));
    const next: ReferenceDataV1 = {
      id,
      label: t("editor.referenceData.label"),
      records: [],
    };
    dispatch({
      type: "setReferenceData",
      referenceData: [...referenceData, next] as unknown as SystemDocumentV1["referenceData"][number][],
    });
  };
  const replaceReferenceData = (idx: number, next: ReferenceDataV1) => {
    dispatch({
      type: "setReferenceData",
      referenceData: referenceData.map((r, i) => (i === idx ? next : r)) as unknown as SystemDocumentV1["referenceData"][number][],
    });
  };
  const removeReferenceData = (idx: number) => {
    dispatch({
      type: "setReferenceData",
      referenceData: referenceData.filter((_, i) => i !== idx) as unknown as SystemDocumentV1["referenceData"][number][],
    });
  };
  return (
    <section data-testid="reference-data-tab" data-path="/referenceData">
      <header className={styles.tabHeader}>
        <h2 className={styles.tabTitle}>{t("editor.referenceData.addTitle")}</h2>
        <button type="button" onClick={addReferenceData} data-testid="reference-data-add-button">
          {t("editor.referenceData.add")}
        </button>
      </header>
      {referenceData.length === 0 ? (
        <p className={styles.placeholder} data-testid="reference-data-tab-empty">
          {t("editor.referenceData.empty")}
        </p>
      ) : (
        <ul className={styles.referenceList}>
          {referenceData.map((r, idx) => (
            <li key={r.id} data-path={`/referenceData/${idx}`}>
              <ReferenceDataEditor referenceData={r} onChange={(next) => replaceReferenceData(idx, next)} />
              <button
                type="button"
                onClick={() => removeReferenceData(idx)}
                data-testid={`reference-data-tab-remove-${idx}`}
                className={styles.removeButton}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function nextReferenceDataId(existing: ReadonlyArray<string>): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `reference_${i}`;
    if (!existing.some((id) => id === candidate)) return candidate;
  }
  return `reference_${Date.now()}`;
}

function buildPreviewPackage(document: SystemDocumentV1): import("../preview/sampleData.js").SystemPackageV1 | null {
  if (document.entities.length === 0) return null;
  const entities = document.entities.map((entity) => ({
    id: entity.id,
    label: entity.label,
    fields: entity.fields as unknown as Array<{ kind: string; id: string; label?: string }>,
  })) as unknown as import("../preview/sampleData.js").SystemPackageV1["entities"];
  const sheets = (document.sheets as unknown as Array<{
    id: string;
    label: string;
    targetEntityId: string;
    sections: Array<{
      id: string;
      label: string;
      elements: Array<{
        id: string;
        kind: "heading" | "field" | "resource" | "action";
        text?: string;
        level?: 2 | 3;
        fieldId?: string;
        resourceId?: string;
        actionId?: string;
      }>;
    }>;
  }>) ?? [];
  const actions = (document.actions as unknown as Array<
    | { kind: "roll"; id: string; label: string; expressionId: string; inputs: Array<{ id: string; label: string; valueType: "integer" | "decimal" | "boolean" | "text"; required: boolean; default: import("../ports/evaluateExpression.js").ScalarValue }>; outputTemplate: string }
    | { kind: "resourceBump"; id: string; label: string; resourceId: string; operation: { kind: "delta"; amount: number } | { kind: "reset" } }
  >) ?? [];
  return {
    entities,
    expressions: [],
    sheets: sheets as unknown as never,
    actions: actions as unknown as never,
  } as unknown as import("../preview/sampleData.js").SystemPackageV1;
}

function VersionHistoryOverlay({
  client,
  systemId,
  onClose,
}: {
  client: ApiClient;
  systemId: string;
  onClose: () => void;
}) {
  return (
    <div role="dialog" aria-label={t("editor.versionHistory.titleInHeader")} data-testid="document-editor-version-history">
      <header>
        <h2>{t("editor.versionHistory.titleInHeader")}</h2>
        <button type="button" onClick={onClose} data-testid="document-editor-version-history-close">
          {t("publish.close")}
        </button>
      </header>
      <VersionHistory client={client} systemId={systemId} />
    </div>
  );
}

function useFocusEditorListener(bodyRef: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const handler = (event: Event) => {
      const target = bodyRef.current;
      if (target === null) return;
      if (!event.type.startsWith("focus-editor:")) return;
      const path = event.type.replace(/^focus-editor:/, "");
      const selector = `[data-path="${path}"]`;
      const el = target.querySelector(selector) ?? window.document.querySelector(selector);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "center" });
        el.focus({ preventScroll: true });
      }
    };
    const events: string[] = [];
    for (const tab of TABS) {
      events.push(`focus-editor:/${tab}`);
      events.push(`focus-editor:/${tab}/0`);
    }
    for (const evt of events) window.addEventListener(evt, handler);
    return () => {
      for (const evt of events) window.removeEventListener(evt, handler);
    };
  }, [bodyRef]);
}
