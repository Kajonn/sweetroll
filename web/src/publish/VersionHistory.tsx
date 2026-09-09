import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, Download, GitBranch, XCircle } from "lucide-react";

import { useCreateDraft } from "../api/createDraft.js";
import { ApiError, type ApiClient } from "../api/client.js";
import { useDeprecateVersion } from "../api/deprecateVersion.js";
import { useExportVersion } from "../api/exportVersion.js";
import { useListVersions } from "../api/listVersions.js";
import type { VersionSummary } from "../api/server.js";
import { t } from "../i18n/index.js";

import styles from "./VersionHistory.module.css";

function formatDate(iso: string): string {
  if (iso === "") return t("versionHistory.unknownDate");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t("versionHistory.unknownDate");
  return date.toISOString().slice(0, 10);
}

function lifecycleKey(lifecycle: string): string {
  if (lifecycle === "deprecated") return "versionHistory.lifecycle.deprecated";
  if (lifecycle === "active" || lifecycle === "published") return "versionHistory.lifecycle.active";
  return lifecycle;
}

export function VersionHistory({ client, systemId }: { client: ApiClient; systemId: string }) {
  const versions = useListVersions(client, systemId);
  const deprecate = useDeprecateVersion(client);
  const createDraft = useCreateDraft(client);
  const exportVersion = useExportVersion(client);
  const [pendingExport, setPendingExport] = useState<string | null>(null);
  const [pendingClone, setPendingClone] = useState<string | null>(null);
  const [pendingDeprecate, setPendingDeprecate] = useState<VersionSummary | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const onExport = async (version: VersionSummary) => {
    setExportError(null);
    setPendingExport(version.versionId);
    try {
      await exportVersion.mutateAsync({
        versionId: version.versionId,
        filename: `${version.semanticVersion}.sweetroll.json`,
      });
    } catch {
      setExportError(version.versionId);
    } finally {
      setPendingExport(null);
    }
  };

  const onClone = async (version: VersionSummary) => {
    setCloneError(null);
    setPendingClone(version.versionId);
    try {
      const out = await createDraft.mutateAsync({
        source: { kind: "clone", versionId: version.versionId },
        idempotencyKey: crypto.randomUUID(),
      });
      location.assign(`/systems/${out.system.systemId}`);
    } catch {
      setCloneError(version.versionId);
    } finally {
      setPendingClone(null);
    }
  };

  const confirmDeprecate = async () => {
    if (pendingDeprecate === null) return;
    const target = pendingDeprecate;
    setPendingDeprecate(null);
    try {
      await deprecate.mutateAsync({ versionId: target.versionId });
    } catch {
      // mutateAsync rethrows; surface via deprecate.isError on the next render.
    }
  };

  return (
    <section
      aria-label={t("versionHistory.title")}
      id="version-history"
      data-testid="version-history"
      className={styles.root}
    >
      <h2 className={styles.title}>{t("versionHistory.title")}</h2>
      {versions.isPending && (
        <p className={styles.muted} data-testid="version-history-loading">
          {t("versionHistory.loading")}
        </p>
      )}
      {versions.isError && (
        <p className={styles.error} role="alert" data-testid="version-history-error">
          {versions.error instanceof ApiError
            ? t("versionHistory.error")
            : t("versionHistory.error")}
        </p>
      )}
      {versions.data !== undefined && versions.data.length === 0 && (
        <p className={styles.muted} data-testid="version-history-empty">
          {t("versionHistory.empty")}
        </p>
      )}
      {versions.data !== undefined && versions.data.length > 0 && (
        <table className={styles.table} data-testid="version-history-table">
          <thead>
            <tr>
              <th scope="col">{t("versionHistory.column.version")}</th>
              <th scope="col">{t("versionHistory.column.lifecycle")}</th>
              <th scope="col">{t("versionHistory.column.createdAt")}</th>
              <th scope="col">{t("versionHistory.column.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {versions.data.map((v) => {
              const isExporting = pendingExport === v.versionId;
              const isCloning = pendingClone === v.versionId;
              const isDeprecated = v.lifecycle === "deprecated";
              return (
                <tr
                  key={v.versionId}
                  data-testid={`version-history-row-${v.versionId}`}
                  className={styles.row}
                >
                  <td className={styles.versionCell}>
                    <span className={styles.semver}>{v.semanticVersion}</span>
                  </td>
                  <td className={styles.lifecycleCell}>
                    <span
                      className={isDeprecated ? styles.badgeDeprecated : styles.badgeActive}
                      data-testid={`version-history-lifecycle-${v.versionId}`}
                    >
                      {isDeprecated ? (
                        <XCircle size={12} aria-hidden />
                      ) : (
                        <CheckCircle2 size={12} aria-hidden />
                      )}
                      {t(lifecycleKey(v.lifecycle))}
                    </span>
                  </td>
                  <td className={styles.dateCell}>{formatDate(v.createdAt)}</td>
                  <td className={styles.actionsCell}>
                    <button
                      type="button"
                      className={styles.action}
                      onClick={() => void onExport(v)}
                      disabled={isExporting}
                      data-testid={`version-history-export-${v.versionId}`}
                    >
                      <Download size={14} aria-hidden />
                      {isExporting
                        ? t("versionHistory.action.exporting")
                        : t("versionHistory.action.export")}
                    </button>
                    <button
                      type="button"
                      className={styles.action}
                      onClick={() => void onClone(v)}
                      disabled={isCloning}
                      data-testid={`version-history-clone-${v.versionId}`}
                    >
                      <GitBranch size={14} aria-hidden />
                      {isCloning
                        ? t("versionHistory.action.cloning")
                        : t("versionHistory.action.clone")}
                    </button>
                    {/* Intentional plain anchor: VersionHistory also renders
                        outside a RouterProvider (standalone/tests), where
                        TanStack Link has no router context and crashes. */}
                    <a
                      className={styles.action}
                      href={`/characters/new?systemVersionId=${v.versionId}`}
                      data-testid={`version-history-create-character-${v.versionId}`}
                    >
                      {t("versionHistory.action.createCharacter")}
                    </a>
                    <button
                      type="button"
                      className={isDeprecated ? styles.actionMuted : styles.actionDanger}
                      onClick={() => setPendingDeprecate(v)}
                      disabled={isDeprecated}
                      data-testid={`version-history-deprecate-${v.versionId}`}
                    >
                      {t("versionHistory.action.deprecate")}
                    </button>
                    {exportError === v.versionId && (
                      <p
                        className={styles.errorInline}
                        role="alert"
                        data-testid={`version-history-export-error-${v.versionId}`}
                      >
                        {t("versionHistory.export.error", { version: v.semanticVersion })}
                      </p>
                    )}
                    {cloneError === v.versionId && (
                      <p
                        className={styles.errorInline}
                        role="alert"
                        data-testid={`version-history-clone-error-${v.versionId}`}
                      >
                        {t("versionHistory.clone.error", { version: v.semanticVersion })}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Dialog.Root
        open={pendingDeprecate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeprecate(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.dialogOverlay} />
          <Dialog.Content
            className={styles.dialogContent}
            aria-describedby={undefined}
            data-testid="version-history-deprecate-dialog"
          >
            <Dialog.Title className={styles.dialogTitle}>
              {t("versionHistory.confirm.deprecate.title")}
            </Dialog.Title>
            <p className={styles.dialogBody}>
              {pendingDeprecate !== null
                ? t("versionHistory.confirm.deprecate.message", {
                    version: pendingDeprecate.semanticVersion,
                  })
                : ""}
            </p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.dialogCancel}
                onClick={() => setPendingDeprecate(null)}
                data-testid="version-history-deprecate-cancel"
              >
                {t("versionHistory.confirm.deprecate.cancel")}
              </button>
              <button
                type="button"
                className={styles.dialogConfirm}
                onClick={() => void confirmDeprecate()}
                disabled={deprecate.isPending}
                data-testid="version-history-deprecate-confirm"
              >
                {deprecate.isPending
                  ? t("versionHistory.action.deprecating")
                  : t("versionHistory.confirm.deprecate.confirm")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
