import { useQueryClient } from "@tanstack/react-query";
import { compileExpression, type ExpressionAstV1 } from "@sweetroll/rules";
import { Check } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { useOpenSystem } from "../api/openSystem.js";
import type { DocumentAssessment } from "../api/server.js";
import { t } from "../i18n/index.js";
import type { ScalarValue, ValueType } from "../ports/evaluateExpression.js";
import { ResourceBumpEditor, type ResourceBumpActionV1 } from "./actions/ResourceBumpEditor.js";
import { GUIDED_DICE_KINDS, RollActionEditor, type RollActionV1 } from "./actions/RollActionEditor.js";
import { ConflictBanner } from "./ConflictBanner.js";
import { DiagnosticsDrawer } from "./DiagnosticsDrawer.js";
import { EntityList, type EntityListEntity } from "./EntityList.js";
import { ExpressionEditor } from "./expressions/ExpressionEditor.js";
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
import { Button, EmptyState } from "../ui/index.js";
import { ValidationEditor } from "./validations/ValidationEditor.js";
import styles from "./DocumentEditor.module.css";

/** Basics-first creator tabs in workflow order. */
export type CreatorTabId = "basics" | "attributes" | "dice" | "sections" | "advanced";

/**
 * Narrow-layout pane selection for the editor/preview switch (Task 4).
 * Below the 1024px desktop boundary the switch selects a single visible
 * pane (`editor` for small edits, `preview` for review); at desktop widths
 * the `bodySplit` grid keeps both panes side-by-side regardless of this
 * value. Full layout authoring stays desktop/tablet-oriented per spec.
 */
export type PreviewMobileView = "editor" | "preview";

/**
 * Pre-Task-2 tab ids, kept as URL aliases so `?tab=` deep links and
 * `focus-editor:{path}` events issued against the old six-tab layout keep
 * resolving to the matching basics-first tab.
 */
type LegacyTabId = "metadata" | "entities" | "sheets" | "actions" | "validations" | "referenceData";

export type TabId = CreatorTabId | LegacyTabId;

export const CREATOR_TABS: ReadonlyArray<CreatorTabId> = [
  "basics",
  "attributes",
  "dice",
  "sections",
  "advanced",
];

const LEGACY_TABS: ReadonlyArray<LegacyTabId> = [
  "metadata",
  "entities",
  "sheets",
  "actions",
  "validations",
  "referenceData",
];

const LEGACY_TAB_ALIASES: Record<LegacyTabId, CreatorTabId> = {
  metadata: "basics",
  entities: "attributes",
  sheets: "sections",
  actions: "dice",
  validations: "advanced",
  referenceData: "advanced",
};

function isCreatorTabId(value: string): value is CreatorTabId {
  return (CREATOR_TABS as ReadonlyArray<string>).includes(value);
}

function isLegacyTabId(value: string): value is LegacyTabId {
  return (LEGACY_TABS as ReadonlyArray<string>).includes(value);
}

function readRawTabParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("tab");
}

function readActiveTab(): CreatorTabId {
  const tab = readRawTabParam();
  if (tab === null) return "basics";
  if (isCreatorTabId(tab)) return tab;
  if (isLegacyTabId(tab)) return LEGACY_TAB_ALIASES[tab];
  return "basics";
}

/** Legacy advanced tabs land with the disclosure open so their controls stay visible. */
function readAdvancedDefaultOpen(): boolean {
  const tab = readRawTabParam();
  return tab === "validations" || tab === "referenceData";
}

export function DocumentEditor({
  client,
  systemId,
  actorId,
  generation,
}: {
  client: ApiClient;
  systemId: string;
  actorId?: string | null;
  generation?: number;
}) {
  const query = useOpenSystem(client, systemId, {
    actorId: actorId ?? null,
    generation: generation ?? 0,
  });
  const [active, setActive] = useState<CreatorTabId>(() => readActiveTab());

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
      onActiveChange={setActive}
      initialDoc={initialDoc}
      assessment={ws.assessment}
      advancedDefaultOpen={readAdvancedDefaultOpen()}
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

export function DocumentEditorBody({
  client,
  ws,
  active,
  onActiveChange,
  initialDoc,
  assessment,
  advancedDefaultOpen,
}: {
  client: ApiClient;
  ws: NonNullable<ReturnType<typeof useOpenSystem>["data"]>;
  active: CreatorTabId;
  onActiveChange: (next: CreatorTabId) => void;
  initialDoc: SystemDocumentV1;
  assessment: DocumentAssessment;
  advancedDefaultOpen?: boolean | undefined;
}) {
  const [document, dispatch] = useReducer(documentReducer, initialDoc);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(
    initialDoc.entities[0]?.id ?? null,
  );
  const lastServerRevision = useRef<number | null>(ws.draft?.revision ?? null);
  const documentRef = useRef(document);
  documentRef.current = document;
  const syncRef = useRef<ReturnType<typeof useDraftSync> | null>(null);
  /** Forced adoption for explicit resolutions (e.g. Reload theirs). */
  const adoptNextRef = useRef(false);
  useEffect(() => {
    const serverRevision = ws.draft?.revision ?? null;
    if (serverRevision === lastServerRevision.current && !adoptNextRef.current) return;
    // Adopt server refreshes only when clean: local edits newer than the last
    // confirmed save are preserved, and the next save resolves divergence
    // through the revision check plus explicit conflict resolution.
    const sync = syncRef.current;
    if (!adoptNextRef.current && sync !== null && !sync.isConfirmed(documentRef.current)) return;
    adoptNextRef.current = false;
    lastServerRevision.current = serverRevision;
    const serverDoc =
      ws.draft?.document !== undefined ? (ws.draft.document as SystemDocumentV1) : blankDocument();
    // Adopt the full working document in one replace so no section (in
    // particular expressions, which have no dedicated setter) goes stale.
    dispatch({ type: "replace", document: serverDoc });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.draft?.revision, ws.draft?.document]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mobileView, setMobileView] = useState<PreviewMobileView>("editor");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const draftRevision = ws.draft?.revision ?? null;
  // Newest-first (server ORDER BY created_at DESC): the first entry is the
  // latest published version. Read from the already-loaded workspace — no
  // new backend calls for readiness.
  const latestPublished = ws.versions[0]?.semanticVersion ?? null;
  const queryClient = useQueryClient();

  const sync = useDraftSync({
    client,
    systemId: ws.system.systemId,
    onAcceptTheirs: () => {
      // Explicit resolution: adopt the reloaded server document even though
      // local content is unconfirmed, then clear the forced flag.
      adoptNextRef.current = true;
      queryClient.invalidateQueries({ queryKey: ["system", "open", ws.system.systemId] });
    },
    onSaved: () => {
      queryClient.invalidateQueries({ queryKey: ["system", "open", ws.system.systemId] });
    },
  });
  syncRef.current = sync;

  // Unmount (route change, sign-out, account switch) drops pending autosave
  // work: the debounce timer and stashed edits are cancelled, so no PUT goes
  // out after unmount and a late in-flight resolution commits no state.
  useEffect(() => () => {
    syncRef.current?.cancel();
  }, []);

  const bodyRef = useRef<HTMLDivElement>(null);
  useFocusEditorListener(bodyRef);
  const nameRef = useRef<HTMLHeadingElement>(null);
  // Tracks h1 focus explicitly (rather than document.activeElement, which
  // jsdom does not move to a contentEditable h1 on .focus()) so the repair
  // effect below can stay out of the way while editing.

  useEffect(() => {
    sync.save(document, draftRevision);
    // We intentionally re-run on every document change to autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]);

  const errorCount = assessment.diagnostics.length;
  const publishDisabled = errorCount > 0;
  // Unsaved changes come from the G1 owner: true until this exact document
  // content matches the last server-confirmed save.
  const unsaved = !sync.isConfirmed(document);
  // The header shows the working document's name while it diverges from the
  // server document and falls back to the server system name when clean, so
  // a dirty name is visible without waiting for the header itself to blur.
  // When there is no server document yet, any non-empty working name is
  // unconfirmed local content and is shown as-is.
  const serverDocName =
    ws.draft?.document !== undefined
      ? ((ws.draft.document as SystemDocumentV1).metadata.name ?? "")
      : null;
  const workingName = document.metadata.name;
  // When the working name is empty, the heading falls back to display text
  // only: the document value stays "" so a deliberate clear is preserved and
  // still saves. Reuses the create-draft placeholder when no server name is
  // available.
  const fallbackName =
    ws.system.name !== "" ? ws.system.name : t("createDraft.name.placeholder");
  const displayName =
    workingName === ""
      ? fallbackName
      : serverDocName === null
        ? workingName
        : workingName === serverDocName
          ? fallbackName
          : workingName;
  const nameFocusedRef = useRef(false);
  // Clearing the contentEditable to "" dispatches "" but leaves the rendered
  // virtual text unchanged when the fallback was already showing (clean
  // state), so React bails out and the DOM node stays empty: repair it so the
  // settled (blurred) h1 is never empty. Skipped while focused so editing
  // starts from the true document value (see onFocus below). Non-empty edits
  // track the DOM exactly, and the document value is untouched (stays "").
  useEffect(() => {
    const el = nameRef.current;
    if (
      el !== null &&
      workingName === "" &&
      el.textContent !== displayName &&
      !nameFocusedRef.current
    ) {
      el.textContent = displayName;
    }
  });
  const previewPackage = useMemo(() => buildPreviewPackage(document), [document]);
  const previewSample = useMemo(
    () => (previewPackage === null ? null : generateSample(previewPackage)),
    [previewPackage],
  );

  useShortcut("Alt+P", () => setPreviewOpen((v) => !v));
  useShortcut("Alt+D", () => setDiagnosticsOpen((v) => !v));
  useShortcut("Alt+V", () => setVersionHistoryOpen((v) => !v));

  // Layout only: when the preview pane is visible, the body switches to a
  // side-by-side editor/preview grid on desktop widths (stacked below).
  const previewVisible = previewOpen && previewPackage !== null && previewSample !== null;

  return (
    <section className={styles.container}>
      <header className={styles.header} data-testid="document-editor-header">
        <h1
          className={styles.name}
          contentEditable
          suppressContentEditableWarning
          aria-label={t("editor.systemNameAria")}
          data-testid="document-editor-name"
          ref={nameRef}
          onFocus={(e) => {
            // While editing, show the true document value so fallback display
            // text never becomes document content: after a clear the DOM holds
            // the fallback while the doc is "", and appending a keystroke
            // would otherwise save "fallback+X" instead of "X". The same
            // applies to the clean state (working name === server name) where
            // the header shows the system name. No state writes here.
            nameFocusedRef.current = true;
            const docName = documentRef.current.metadata.name;
            if (displayName !== docName && e.currentTarget.textContent !== docName) {
              e.currentTarget.textContent = docName;
            }
          }}
          onInput={(e) => {
            const text = e.currentTarget.textContent ?? "";
            if (text !== documentRef.current.metadata.name) {
              // Mirror keystrokes into the working document live: the title
              // stays dirty without waiting for blur, and the dirty state
              // blocks server-refresh adoption from wiping the keystrokes.
              // System name is metadata; reroute through the document reducer.
              dispatch({ type: "setMetadata", patch: { name: text } });
            }
          }}
          onBlur={(e) => {
            nameFocusedRef.current = false;
            const text = e.currentTarget.textContent ?? "";
            if (text !== documentRef.current.metadata.name) {
              // System name is metadata; reroute through the document reducer.
              dispatch({ type: "setMetadata", patch: { name: text } });
            } else if (text !== displayName) {
              // No edit (focus/blur without typing): restore the fallback
              // display so the settled heading is never empty for a11y.
              // Document value untouched.
              e.currentTarget.textContent = displayName;
            }
          }}
        >
          {displayName}
        </h1>
        <span className={styles.lifecycle} data-testid="document-editor-lifecycle">
          {ws.draft !== null && ws.versions.length === 0
            ? t("editor.lifecycle.draftUnpublished")
            : t(`editor.lifecycle.${ws.system.lifecycle}`)}
        </span>
        <span
          className={styles.autosave}
          data-testid="document-editor-autosave"
          role={sync.status === "conflict" || sync.status === "error" ? "alert" : "status"}
        >
          <Check aria-hidden size={14} />
          {autosaveLabel(sync.status)}
          {sync.offline ? ` · ${t("editor.save.offline")}` : null}
        </span>
        {sync.status === "error" ? (
          <Button
            variant="secondary"
            data-testid="document-editor-save-retry"
            onClick={() => sync.save(document, draftRevision)}
          >
            {t("editor.save.retry")}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          data-testid="document-editor-preview-toggle"
          aria-pressed={previewOpen}
          onClick={() => {
            // Opening the preview selects the preview view so narrow
            // layouts land on what was asked for; desktop still shows both
            // panes side-by-side. Closing keeps the switch state.
            if (!previewOpen) setMobileView("preview");
            setPreviewOpen((v) => !v);
          }}
          title={t("editor.preview.buttonShortcut")}
        >
          {t("editor.preview.buttonLabel")}
        </Button>
        {previewVisible ? (
          <div
            role="group"
            aria-label={t("editor.preview.viewLabel")}
            className={styles.previewSwitch}
            data-testid="document-editor-preview-switch"
          >
            <Button
              variant="secondary"
              data-testid="document-editor-preview-view-editor"
              aria-pressed={mobileView === "editor"}
              onClick={() => setMobileView("editor")}
            >
              {t("editor.preview.viewEditor")}
            </Button>
            <Button
              variant="secondary"
              data-testid="document-editor-preview-view-preview"
              aria-pressed={mobileView === "preview"}
              onClick={() => setMobileView("preview")}
            >
              {t("editor.preview.viewPreview")}
            </Button>
          </div>
        ) : null}
        <Button
          variant="secondary"
          data-testid="document-editor-diagnostics-toggle"
          aria-pressed={diagnosticsOpen}
          onClick={() => setDiagnosticsOpen((v) => !v)}
        >
          {t("editor.diagnostics.buttonLabel")}
          {errorCount > 0 ? ` (${errorCount})` : ""}
        </Button>
        <Button
          variant="secondary"
          data-testid="document-editor-version-history-toggle"
          aria-pressed={versionHistoryOpen}
          onClick={() => setVersionHistoryOpen((v) => !v)}
        >
          {t("editor.versionHistory.buttonLabel")}
        </Button>
        <Button
          variant="primary"
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
        </Button>
        <section
          className={styles.readiness}
          data-testid="document-editor-readiness"
          aria-label={t("editor.readiness.title")}
        >
          <ul className={styles.readinessList}>
            <li className={styles.readinessItem}>
              {draftRevision !== null
                ? t("editor.readiness.draftRev", { revision: draftRevision })
                : t("editor.readiness.noDraft")}
            </li>
            <li className={styles.readinessItem}>
              {t("editor.readiness.saveState", { state: autosaveLabel(sync.status) })}
            </li>
            <li className={styles.readinessItem}>
              {errorCount === 0
                ? t("editor.readiness.noIssues")
                : t("editor.readiness.issues", { count: errorCount })}{" "}
              <Button
                variant="secondary"
                data-testid="document-editor-readiness-diagnostics"
                disabled={errorCount === 0}
                onClick={() => setDiagnosticsOpen(true)}
              >
                {t("editor.readiness.reviewDiagnostics")}
              </Button>
            </li>
            <li className={styles.readinessItem}>
              {latestPublished !== null
                ? t("editor.readiness.latestPublished", { version: latestPublished })
                : t("editor.readiness.noPublished")}{" "}
              <Button
                variant="secondary"
                data-testid="document-editor-readiness-versions"
                onClick={() => setVersionHistoryOpen(true)}
              >
                {t("editor.readiness.viewVersions")}
              </Button>
            </li>
          </ul>
          <p
            className={styles.readinessReason}
            data-testid="document-editor-publish-reason"
            role="status"
          >
            {publishDisabled
              ? t("editor.publish.disabled.reason", { count: errorCount })
              : t("editor.readiness.ready")}
          </p>
        </section>
      </header>
      {sync.banner !== null && (
        <ConflictBanner
          latestRevision={sync.banner.latestRevision}
          onAcceptTheirs={sync.banner.onAcceptTheirs}
          onKeepMine={sync.banner.onKeepMine}
          onDismiss={sync.banner.onDismiss}
        />
      )}
      <nav className={styles.tabs} aria-label={t("editor.tabsAriaLabel")}>
        {CREATOR_TABS.map((tab) => {
          const isActive = tab === active;
          return (
            <a
              key={tab}
              href={`?tab=${tab}`}
              aria-current={isActive ? "page" : undefined}
              className={isActive ? styles.tabActive : styles.tab}
              data-testid={`document-editor-tab-${tab}`}
              onClick={(e) => {
                e.preventDefault();
                onActiveChange(tab);
              }}
            >
              {t(`editor.tab.${tab}`)}
            </a>
          );
        })}
      </nav>
      <main
        className={previewVisible ? `${styles.body} ${styles.bodySplit}` : styles.body}
        ref={bodyRef}
        data-testid={`document-editor-body-${active}`}
        data-mobile-view={previewVisible ? mobileView : undefined}
      >
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
        <div className={styles.editorPane} data-testid="document-editor-editor-pane">
        {active === "basics" ? (
          <BasicsTab
            document={document}
            dispatch={dispatch}
          />
        ) : active === "attributes" ? (
          <EntitiesTab
            entities={document.entities}
            selectedEntityId={selectedEntityId}
            onSelectEntity={setSelectedEntityId}
            dispatch={dispatch}
          />
        ) : active === "dice" ? (
          <DiceTab client={client} document={document} dispatch={dispatch} />
        ) : active === "sections" ? (
          <SheetsTab document={document} dispatch={dispatch} />
        ) : active === "advanced" ? (
          <AdvancedTab
            client={client}
            document={document}
            dispatch={dispatch}
            defaultOpen={advancedDefaultOpen}
          />
        ) : null}
        </div>
      </main>
      <PublishDialog
        client={client}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        systemId={ws.system.systemId}
        expectedRevision={draftRevision ?? 0}
        readiness={{
          draftRevision,
          diagnosticsCount: errorCount,
          latestPublished,
          unsaved,
        }}
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

/**
 * Basics tab: the existing MetadataEditor fields (name, description,
 * language, default dice) with stable IDs — no new API, no expressions.
 */
function BasicsTab({
  document,
  dispatch,
}: {
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
}) {
  return (
    <section data-testid="basics-tab" data-path="/basics">
      <MetadataEditor
        document={document}
        onChange={(next) => {
          const patch = diffMetadata(document.metadata, next.metadata);
          if (patch !== null) dispatch({ type: "setMetadata", patch });
        }}
      />
    </section>
  );
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
    <section data-testid="attributes-tab" data-path="/attributes">
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
    </section>
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
    <section data-testid="sections-tab" data-path="/sections">
      <section data-testid="sheets-tab" data-path="/sheets">
      <header className={styles.tabHeader}>
        <h2 className={styles.tabTitle}>{t("editor.sheet.label")}</h2>
        <Button
          variant="secondary"
          onClick={addSheet}
          data-testid="sheet-add-button"
        >
          {t("editor.sheets.addSheet")}
        </Button>
      </header>
      {sheets.length === 0 ? (
        <div data-testid="sheets-tab-empty">
          <EmptyState title={t("editor.sheets.empty")} />
        </div>
      ) : (
        <ul className={styles.sheetList}>
          {sheets.map((sheet, idx) => (
            <li key={sheet.id} data-path={`/sheets/${idx}`}>
              <SheetEditor
                sheet={sheet}
                onChange={(next) => replaceSheet(idx, next)}
              />
              <Button
                variant="secondary"
                className={styles.removeButton}
                onClick={() => removeSheet(idx)}
                data-testid={`sheets-tab-remove-${idx}`}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      </section>
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

/**
 * Persist an edited expression source into `document.expressions` via the
 * functional `setExpressionSource` reducer action (not a render-local Map
 * and not a stale-snapshot `replace`), so tab switches/rerenders retain the
 * edit and rapid successive edits cannot clobber each other. Unknown ids
 * are ignored: no stray entries.
 */
export function persistExpressionSource(
  document: SystemDocumentV1,
  dispatch: React.Dispatch<DocumentAction>,
  sourceId: string,
  source: string,
): void {
  const expressions = document.expressions ?? [];
  if (!expressions.some((entry) => entry.id === sourceId)) return;
  dispatch({ type: "setExpressionSource", expressionId: sourceId, source });
}

/**
 * Document-writing helper for computed-field blur commits (Task 2 wiring
 * contract). Writes both the edited source and — when provided — the
 * fallback into the `document.expressions` entry keyed by `expressionId`
 * via the functional `setExpressionSource` action. Unknown ids are a
 * no-op: no stray entries, and callers should keep their optional
 * `onExpressionSourceChange`/`onFallbackChange` callbacks as the fallback
 * path for dispatch-less use or entries not yet in the document.
 */
export function commitComputedSource(
  document: SystemDocumentV1,
  dispatch: React.Dispatch<DocumentAction>,
  expressionId: string,
  source: string,
  fallback?: unknown,
): void {
  const expressions = document.expressions ?? [];
  if (!expressions.some((entry) => entry.id === expressionId)) return;
  dispatch({
    type: "setExpressionSource",
    expressionId,
    source,
    ...(fallback !== undefined ? { fallback, hasFallback: true as const } : null),
  });
}

/**
 * Dice tab: guided roll-action editing (label + dice-kind + inputs) with no
 * grammar input. Each roll owns a `document.expressions` entry created at
 * add time; the dice-kind picker writes canned sources through
 * `persistExpressionSource`, and the full source stays editable in Advanced.
 * Resource-bump actions are grammar-free and stay fully editable here.
 */
function DiceTab({
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
    const expressionId = nextExpressionId(expressions.map((e) => e.id));
    dispatch({
      type: "addExpression",
      expression: {
        id: expressionId,
        context: "roll",
        resultType: "number",
        source: "d20",
        fallback: 0,
      },
    });
    const id = nextActionId(actions.map((a) => a.id));
    const next: RollActionV1 = {
      kind: "roll",
      id,
      label: t("editor.actions.kind.roll"),
      expressionId,
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

  const expressionSourceFor = (expressionId: string): string =>
    expressions.find((entry) => entry.id === expressionId)?.source ?? "";

  const hasExpression = (expressionId: string): boolean =>
    expressions.some((entry) => entry.id === expressionId);

  return (
    <section data-testid="dice-tab" data-path="/dice">
    <section data-testid="actions-tab" data-path="/actions">
      <header className={styles.tabHeader}>
        <h2 className={styles.tabTitle}>{t("editor.actions.addTitle")}</h2>
        <Button variant="secondary" onClick={addRoll} data-testid="actions-add-roll">
          {t("editor.actions.addRoll")}
        </Button>
        <Button variant="secondary" onClick={addResourceBump} data-testid="actions-add-resource-bump">
          {t("editor.actions.addResourceBump")}
        </Button>
      </header>
      {actions.length === 0 ? (
        <div data-testid="actions-tab-empty">
          <EmptyState title={t("editor.actions.empty")} />
        </div>
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
                  expressionSource={expressionSourceFor(action.expressionId)}
                  onExpressionSourceChange={(next) => {
                    persistExpressionSource(document, dispatch, action.expressionId, next);
                  }}
                  fieldTypes={buildFieldTypeMap(document)}
                  guided
                  diceKind={diceKindFor(expressionSourceFor(action.expressionId))}
                  onDiceKindChange={hasExpression(action.expressionId)
                    ? (kind) => {
                        persistExpressionSource(document, dispatch, action.expressionId, kind);
                      }
                    : undefined}
                />
              ) : (
                <ResourceBumpEditor
                  action={action}
                  onChange={(next) => replaceAction(idx, next)}
                  availableResources={collectResourceFields(document)}
                />
              )}
              <Button
                variant="secondary"
                className={styles.removeButton}
                onClick={() => removeAction(idx)}
                data-testid={`actions-tab-remove-${idx}`}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
    </section>
  );
}

/** Guided dice-kind for a roll source: canned kind, else custom (Advanced edit). */
function diceKindFor(source: string): string {
  return (GUIDED_DICE_KINDS as ReadonlyArray<string>).includes(source) ? source : "custom";
}

function nextExpressionId(existing: ReadonlyArray<string>): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `expr_${i}`;
    if (!existing.some((id) => id === candidate)) return candidate;
  }
  return `expr_${Date.now()}`;
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
  const expressionSourceFor = (expressionId: string): string =>
    expressions.find((entry) => entry.id === expressionId)?.source ?? "";

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
        <Button variant="secondary" onClick={addValidation} data-testid="validations-add-button">
          {t("editor.validations.add")}
        </Button>
      </header>
      {validations.length === 0 ? (
        <div data-testid="validations-tab-empty">
          <EmptyState title={t("editor.validations.empty")} />
        </div>
      ) : (
        <ul className={styles.validationList}>
          {validations.map((v, idx) => (
            <li key={v.id} data-path={`/validations/${idx}`}>
              <ValidationEditor
                client={client}
                systemId="s1"
                validation={v as unknown as Parameters<typeof ValidationEditor>[0]["validation"]}
                onChange={(next) => replaceValidation(idx, next as unknown as ValidationV1)}
                expressionSource={expressionSourceFor(v.expressionId)}
                onExpressionSourceChange={(next) => {
                  persistExpressionSource(document, dispatch, v.expressionId, next);
                }}
                availableExpressions={expressionOptions}
                availableTargets={targetOptions}
              />
              <Button
                variant="secondary"
                className={styles.removeButton}
                onClick={() => removeValidation(idx)}
                data-testid={`validations-tab-remove-${idx}`}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </Button>
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
        <Button variant="secondary" onClick={addReferenceData} data-testid="reference-data-add-button">
          {t("editor.referenceData.add")}
        </Button>
      </header>
      {referenceData.length === 0 ? (
        <div data-testid="reference-data-tab-empty">
          <EmptyState title={t("editor.referenceData.empty")} />
        </div>
      ) : (
        <ul className={styles.referenceList}>
          {referenceData.map((r, idx) => (
            <li key={r.id} data-path={`/referenceData/${idx}`}>
              <ReferenceDataEditor referenceData={r} onChange={(next) => replaceReferenceData(idx, next)} />
              <Button
                variant="secondary"
                className={styles.removeButton}
                onClick={() => removeReferenceData(idx)}
                data-testid={`reference-data-tab-remove-${idx}`}
              >
                {t("editor.sheet.removeConfirm.confirm")}
              </Button>
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

/**
 * Advanced tab: validations, reference data, and expression editors behind
 * a collapsed-by-default labeled disclosure. Untouched advanced definitions
 * stay byte-for-byte intact (Task 1): this tab only reads them through the
 * same functional `persistExpressionSource` path the basics tabs use.
 */
function AdvancedTab({
  client,
  document,
  dispatch,
  defaultOpen,
}: {
  client: ApiClient;
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
  defaultOpen?: boolean | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <section data-testid="advanced-tab" data-path="/advanced">
      <details
        className={styles.advancedDisclosure}
        data-testid="advanced-disclosure"
        data-path="/advanced/disclosure"
        open={open}
      >
        <summary
          className={styles.advancedSummary}
          data-testid="advanced-disclosure-toggle"
          aria-expanded={open ? "true" : "false"}
          onClick={(e) => {
            // Drive the disclosure from state (instead of the native toggle)
            // so keyboard/click behavior is identical in browsers and jsdom.
            e.preventDefault();
            setOpen((v) => !v);
          }}
        >
          {t("editor.advanced.disclosure")}
        </summary>
        {open ? (
          <div className={styles.advancedBody}>
            <ExpressionsSection client={client} document={document} dispatch={dispatch} />
            <ValidationsTab client={client} document={document} dispatch={dispatch} />
            <ReferenceDataTab document={document} dispatch={dispatch} />
          </div>
        ) : null}
      </details>
    </section>
  );
}

function ExpressionsSection({
  client,
  document,
  dispatch,
}: {
  client: ApiClient;
  document: SystemDocumentV1;
  dispatch: React.Dispatch<DocumentAction>;
}) {
  const expressions = (document.expressions as unknown as Array<{
    id: string;
    source: string;
  }>) ?? [];
  return (
    <section data-testid="expressions-section" data-path="/expressions">
      <header className={styles.tabHeader}>
        <h2 className={styles.tabTitle}>{t("editor.advanced.expressions.title")}</h2>
      </header>
      {expressions.length === 0 ? (
        <div data-testid="expressions-section-empty">
          <EmptyState title={t("editor.advanced.expressions.empty")} />
        </div>
      ) : (
        <ul className={styles.expressionList}>
          {expressions.map((entry, idx) => (
            <li key={entry.id} data-path={`/expressions/${idx}`}>
              <ExpressionEditor
                client={client}
                systemId="s1"
                expressionId={entry.id}
                source={entry.source ?? ""}
                onSourceChange={(next) => {
                  persistExpressionSource(document, dispatch, entry.id, next);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function buildPreviewPackage(document: SystemDocumentV1): import("../preview/sampleData.js").SystemPackageV1 | null {
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
    expressions: compilePreviewExpressions(document),
    sheets: sheets as unknown as never,
    actions: actions as unknown as never,
  } as unknown as import("../preview/sampleData.js").SystemPackageV1;
}

/**
 * Preview pass-through for the document's source expressions. Every
 * `document.expressions` id appears in the returned package: entries that
 * fail shape validation or preview compilation are included with a
 * `previewError` marker and a fallback-literal AST (so preview renders the
 * sampled/fallback value) instead of being omitted. Validation and compile
 * may only mark — never filter — so an untouched advanced definition can
 * never silently disappear from preview.
 *
 * NOTE (preview/server env divergence, for Task 2+): the compile attempt
 * below uses a merged cross-entity field env plus per-expression roll-input
 * envs, which mirrors but does not match the server's per-owner envs
 * (see server `compile-document.ts`). A multi-owner expression may therefore
 * compile here yet fail on the server, or carry `previewError:
 * "uncompilable"` here yet publish fine. The marker must be surfaced as a
 * preview-only diagnostic, never as a publish verdict.
 */
function compilePreviewExpressions(
  document: SystemDocumentV1,
): import("../preview/sampleData.js").SystemPackageV1["expressions"] {
  const { fields, inputsByExpression } = previewExpressionEnvs(document);
  const out: import("../preview/sampleData.js").SystemPackageV1["expressions"] = [];
  for (const entry of (document.expressions ?? []) as unknown as Array<Record<string, unknown>>) {
    if (typeof entry.id !== "string") continue;
    const context = isPreviewContext(entry.context) ? entry.context : "computed";
    const resultType = isPreviewResultType(entry.resultType)
      ? entry.resultType
      : inferPreviewResultType(entry.fallback);
    const fallback: ScalarValue = isPreviewFallback(entry.fallback) ? entry.fallback : 0;
    const shapeOk =
      typeof entry.source === "string" &&
      entry.context === context &&
      entry.resultType === resultType &&
      entry.fallback === fallback;
    if (shapeOk) {
      const result = compileExpression(entry.source as string, {
        env: { fields, inputs: inputsByExpression.get(entry.id) ?? {} },
        resultType,
        context,
        fallback,
      });
      if (result.ok) {
        out.push({
          id: entry.id,
          context: result.value.context,
          resultType: result.value.resultType,
          fallback: result.value.fallback,
          ast: result.value.ast,
        });
        continue;
      }
      out.push({
        id: entry.id,
        context,
        resultType,
        fallback,
        ast: fallbackLiteralAst(fallback, resultType),
        previewError: "uncompilable",
      });
      continue;
    }
    out.push({
      id: entry.id,
      context,
      resultType,
      fallback,
      ast: fallbackLiteralAst(fallback, resultType),
      previewError: "invalid",
    });
  }
  return out;
}

/** Coerce an unknown stored fallback to a result type for a marked entry. */
function inferPreviewResultType(fallback: unknown): ValueType {
  if (typeof fallback === "string") return "text";
  if (typeof fallback === "boolean") return "boolean";
  return "number";
}

/**
 * Safe AST for a marked (uncompilable/invalid) preview entry: a literal of
 * the fallback value, so preview render/evaluate paths stay total and show
 * the sampled fallback instead of crashing or dropping the id.
 */
function fallbackLiteralAst(fallback: ScalarValue, resultType: ValueType): ExpressionAstV1 {
  if (resultType === "text") {
    return {
      kind: "stringLiteral",
      value: typeof fallback === "string" ? fallback : String(fallback),
    };
  }
  if (resultType === "boolean") {
    return {
      kind: "booleanLiteral",
      value: typeof fallback === "boolean" ? fallback : false,
    };
  }
  return {
    kind: "numberLiteral",
    value: typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0,
  };
}

function previewExpressionEnvs(document: SystemDocumentV1): {
  fields: Record<string, ValueType>;
  inputsByExpression: Map<string, Record<string, ValueType>>;
} {
  const fields: Record<string, ValueType> = {};
  for (const entity of document.entities) {
    for (const field of entity.fields as unknown as Array<{
      id: string;
      kind?: string;
      valueType?: unknown;
    }>) {
      if (fields[field.id] !== undefined) continue;
      const valueType = previewFieldValueType(field.kind, field.valueType);
      if (valueType !== undefined) fields[field.id] = valueType;
    }
  }
  const inputsByExpression = new Map<string, Record<string, ValueType>>();
  for (const action of document.actions as unknown as Array<{
    kind?: string;
    expressionId?: string;
    inputs?: Array<{ id: string; valueType?: string }>;
  }>) {
    if (action.kind !== "roll" || typeof action.expressionId !== "string") continue;
    const inputs = inputsByExpression.get(action.expressionId) ?? {};
    for (const input of action.inputs ?? []) {
      if (inputs[input.id] === undefined) {
        inputs[input.id] =
          input.valueType === "boolean"
            ? "boolean"
            : input.valueType === "text"
              ? "text"
              : "number";
      }
    }
    inputsByExpression.set(action.expressionId, inputs);
  }
  return { fields, inputsByExpression };
}

function previewFieldValueType(kind: unknown, valueType: unknown): ValueType | undefined {
  switch (kind) {
    case "text":
    case "singleChoice":
    case "multiChoice":
      return "text";
    case "integer":
    case "decimal":
    case "resource":
      return "number";
    case "boolean":
      return "boolean";
    case "computed":
      return isPreviewResultType(valueType) ? valueType : undefined;
    default:
      return undefined;
  }
}

function isPreviewContext(value: unknown): value is "computed" | "roll" | "validation" {
  return value === "computed" || value === "roll" || value === "validation";
}

function isPreviewResultType(value: unknown): value is ValueType {
  return value === "number" || value === "text" || value === "boolean";
}

function isPreviewFallback(value: unknown): value is ScalarValue {
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
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
    <div
      role="dialog"
      aria-label={t("editor.versionHistory.titleInHeader")}
      data-testid="document-editor-version-history"
      className={styles.versionOverlay}
    >
      <header>
        <h2>{t("editor.versionHistory.titleInHeader")}</h2>
        <Button variant="secondary" onClick={onClose} data-testid="document-editor-version-history-close">
          {t("publish.close")}
        </Button>
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
      // Legacy six-tab deep links resolve to their basics-first successor:
      // inner sections keep the legacy data-paths (/sheets, /actions,
      // /validations, /referenceData), while /metadata and /entities map to
      // the basics/attributes wrappers.
      const candidates = [path, FOCUS_PATH_ALIASES[path]].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
      for (const candidate of candidates) {
        const selector = `[data-path="${candidate}"]`;
        const el = target.querySelector(selector) ?? window.document.querySelector(selector);
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: "center" });
          el.focus({ preventScroll: true });
          return;
        }
      }
    };
    const events: string[] = [];
    for (const tab of [...CREATOR_TABS, ...LEGACY_TABS]) {
      events.push(`focus-editor:/${tab}`);
      events.push(`focus-editor:/${tab}/0`);
    }
    for (const evt of events) window.addEventListener(evt, handler);
    return () => {
      for (const evt of events) window.removeEventListener(evt, handler);
    };
  }, [bodyRef]);
}

/** Legacy `focus-editor:{path}` targets without a same-named data-path. */
const FOCUS_PATH_ALIASES: Record<string, string> = {
  "/metadata": "/basics",
  "/entities": "/attributes",
};
