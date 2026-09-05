import type { DocumentAssessment, PackageDiagnostic } from "../api/server.js";
import { t } from "../i18n/index.js";

export type DiagnosticsDrawerProps = {
  assessment: DocumentAssessment;
};

export function DiagnosticsDrawer({ assessment }: DiagnosticsDrawerProps) {
  const diagnostics = assessment.diagnostics;
  const handleJump = (path: string) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(`focus-editor:${path}`));
  };

  return (
    <aside
      className="diagnostics-drawer"
      data-testid="diagnostics-drawer"
      aria-label={t("editor.diagnostics.title")}
    >
      <header className="diagnostics-drawer__header">
        <h2 className="diagnostics-drawer__title" data-testid="diagnostics-drawer-title">
          {t("editor.diagnostics.title")}
        </h2>
        <span className="diagnostics-drawer__count" data-testid="diagnostics-drawer-count">
          {diagnostics.length}
        </span>
      </header>
      {diagnostics.length === 0 ? (
        <p className="diagnostics-drawer__empty" data-testid="diagnostics-drawer-empty">
          {t("editor.diagnostics.empty")}
        </p>
      ) : (
        <ul className="diagnostics-drawer__list">
          {diagnostics.map((diagnostic, index) => (
            <DiagnosticRow
              key={`${diagnostic.code}-${diagnostic.path}-${index}`}
              index={index}
              diagnostic={diagnostic}
              onJump={handleJump}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function DiagnosticRow({
  index,
  diagnostic,
  onJump,
}: {
  index: number;
  diagnostic: PackageDiagnostic;
  onJump: (path: string) => void;
}) {
  return (
    <li
      className="diagnostics-drawer__item"
      data-testid={`diagnostic-item-${index}`}
      data-diagnostic-code={diagnostic.code}
    >
      <div className="diagnostics-drawer__body">
        <code className="diagnostics-drawer__code" data-testid={`diagnostic-code-${diagnostic.code}`}>
          {diagnostic.code}
        </code>
        <p
          className="diagnostics-drawer__message"
          data-testid={`diagnostic-message-${diagnostic.code}`}
        >
          {diagnostic.message}
        </p>
        <span className="diagnostics-drawer__path">{diagnostic.path}</span>
      </div>
      <button
        type="button"
        className="diagnostics-drawer__jump"
        onClick={() => onJump(diagnostic.path)}
        data-testid={`diagnostic-jump-${diagnostic.path}`}
      >
        {t("editor.diagnostics.jumpTo")}
      </button>
    </li>
  );
}