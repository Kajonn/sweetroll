import { t } from "../i18n/index.js";
import type { VersionChangeReport, VersionChoice } from "./types.js";

/** Design 6.7: one version choice as people see it (semantic version and publication date). */
export function versionLabel(choice: Pick<VersionChoice, "semanticVersion" | "createdAt">): string {
  const date = new Date(choice.createdAt);
  const published = Number.isNaN(date.getTime())
    ? choice.createdAt
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  return t("version.choiceLabel", { version: choice.semanticVersion, date: published });
}

function IdList({ label, ids }: { label: string; ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <p>
      {label}: {ids.map((id, index) => (
        <span key={id}>{index > 0 ? ", " : null}<code>{id}</code></span>
      ))}
    </p>
  );
}

/**
 * Plain-language summary of one character's dry run against another
 * version. Blockers come first; nothing here changes the character.
 */
export function VersionReportSummary({ report, heading }: { report: VersionChangeReport; heading?: string }) {
  const unaffected = report.packageFindings.filter((finding) => !finding.affectsCharacter).length;
  const errors = report.validations.filter((validation) => validation.severity === "error");
  return (
    <section aria-label={heading ?? t("version.report.title")}>
      {heading === undefined ? null : <h3>{heading}</h3>}
      <p role="status">{t(report.ok ? "version.report.ready" : "version.report.blocked")}</p>
      {report.blockers.length > 0 ? (
        <ul aria-label={t("version.report.blockers")}>
          {report.blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${blocker.entryId ?? ""}-${index}`}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
      <IdList label={t("version.report.addedFields")} ids={report.addedFields} />
      <IdList label={t("version.report.droppedFields")} ids={report.droppedFields} />
      {report.changedEntries.length > 0 ? (
        <ul aria-label={t("version.report.items")}>
          {report.changedEntries.map((entry) => (
            <li key={entry.entryId}>
              <code>{entry.templateId}</code>
              {entry.updatedFields.length > 0 ? <> · {t("version.report.itemUpdated", { fields: entry.updatedFields.join(", ") })}</> : null}
              {entry.keptFields.length > 0 ? <> · {t("version.report.itemKept", { fields: entry.keptFields.join(", ") })}</> : null}
              {entry.addedFields.length > 0 ? <> · {t("version.report.itemAdded", { fields: entry.addedFields.join(", ") })}</> : null}
              {entry.droppedFields.length > 0 ? <> · {t("version.report.itemDropped", { fields: entry.droppedFields.join(", ") })}</> : null}
              {entry.imageUpdated ? <> · {t("version.report.itemImage")}</> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {errors.length > 0 ? (
        <ul aria-label={t("version.report.validations")}>
          {errors.map((validation) => <li key={validation.validationId}>{validation.message}</li>)}
        </ul>
      ) : null}
      {unaffected > 0 ? <p>{t("version.report.unaffected", { count: unaffected })}</p> : null}
    </section>
  );
}
