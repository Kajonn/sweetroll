import { useEffect, useMemo } from "react";

import { useAssessDraft } from "../../api/assessDraft.js";
import { ApiError, type ApiClient } from "../../api/client.js";
import { t } from "../../i18n/index.js";
import {
  tokenizeExpression,
  type ExpressionDiagnostic,
} from "../../ports/expressions.js";
import { registerShortcut } from "../../shell/ShortcutHelp.js";
import { useShortcut } from "../../shell/useShortcut.js";
import { Button, FormField } from "../../ui/index.js";
import styles from "./ExpressionEditor.module.css";

export type ExpressionEditorProps = {
  client: ApiClient;
  systemId: string;
  source: string;
  onSourceChange: (next: string) => void;
  expressionId?: string;
  disabled?: boolean;
};

type CompiledExpressionV1 = {
  id?: string;
  ast?: unknown;
  dependencies?: ReadonlyArray<string>;
};

function getServerDiagnostics(error: unknown): ReadonlyArray<ExpressionDiagnostic> {
  if (error instanceof ApiError) return error.diagnostics;
  return [];
}

export function ExpressionEditor({
  client,
  systemId,
  source,
  onSourceChange,
  expressionId,
  disabled,
}: ExpressionEditorProps) {
  const assess = useAssessDraft(client);

  const liveDiagnostics: ReadonlyArray<ExpressionDiagnostic> = useMemo(() => {
    const result = tokenizeExpression(source);
    return result.ok ? [] : result.diagnostics;
  }, [source]);

  useEffect(() => {
    return registerShortcut("Mod+Enter", t("editor.expression.checkShortcut.label"));
  }, []);

  const runCheck = () => {
    void assess.mutate(systemId);
  };

  useShortcut("Mod+Enter", runCheck);

  const serverDiagnostics = useMemo(() => getServerDiagnostics(assess.error), [assess.error]);

  const expressionEntry: CompiledExpressionV1 | null = useMemo(() => {
    if (assess.data === undefined) return null;
    const pkg = assess.data.snapshot.package as { expressions?: ReadonlyArray<CompiledExpressionV1> };
    const list = pkg.expressions ?? [];
    if (expressionId !== undefined) {
      return list.find((e) => e.id === expressionId) ?? null;
    }
    return list[0] ?? null;
  }, [assess.data, expressionId]);

  const hasError = liveDiagnostics.length > 0 || serverDiagnostics.length > 0;

  return (
    <section
      className={styles.layout}
      data-testid="expression-editor"
      aria-label={t("editor.expression.title")}
    >
      <div className={styles.pane} data-testid="expression-editor-source-pane">
        <div className={hasError ? styles.sourceError : undefined}>
          <FormField label={t("editor.expression.title")}>
            <textarea
              value={source}
              onChange={(e) => onSourceChange(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={t("editor.expression.source.placeholder")}
              data-testid="expression-editor-source"
              data-has-error={hasError ? "true" : "false"}
              disabled={disabled}
            />
          </FormField>
        </div>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={runCheck}
            disabled={assess.isPending || disabled === true}
            pending={assess.isPending}
            pendingText={t("editor.expression.checking")}
            data-testid="expression-editor-check"
            title={t("editor.expression.checkShortcut")}
          >
            {t("editor.expression.check")}
          </Button>
          <span className={styles.shortcutHint}>{t("editor.expression.checkShortcut")}</span>
        </div>
      </div>
      <div className={styles.pane} data-testid="expression-editor-compile-result">
        <strong>{t("editor.expression.compileResult")}</strong>
        <div className={styles.section}>
          <span>{t("editor.expression.liveDiagnostics")}</span>
          {liveDiagnostics.length === 0 ? (
            <span
              className={styles.noIssues}
              data-testid="expression-editor-live-no-issues"
            >
              {t("editor.expression.noDiagnostics")}
            </span>
          ) : (
            <ul className={styles.diagnostics}>
              {liveDiagnostics.map((d, i) => (
                <li
                  key={`live-${i}`}
                  data-severity="error"
                  data-code={d.code}
                  data-testid="expression-editor-live-diagnostic"
                >
                  {t("editor.expression.diagnostic", { code: d.code, message: d.message })}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={styles.section}>
          <span>{t("editor.expression.serverDiagnostics")}</span>
          {serverDiagnostics.length === 0 ? (
            <span
              className={styles.noIssues}
              data-testid="expression-editor-server-no-issues"
            >
              {t("editor.expression.noDiagnostics")}
            </span>
          ) : (
            <ul className={styles.diagnostics}>
              {serverDiagnostics.map((d, i) => (
                <li
                  key={`server-${i}`}
                  data-severity="error"
                  data-code={d.code}
                  data-testid="expression-editor-server-diagnostic"
                >
                  {t("editor.expression.diagnostic", { code: d.code, message: d.message })}
                </li>
              ))}
            </ul>
          )}
        </div>
        {expressionEntry !== null ? (
          <>
            <div className={styles.section}>
              <span>{t("editor.expression.ast")}</span>
              <pre
                className={styles.ast}
                data-testid="expression-editor-ast"
              >
                {JSON.stringify(expressionEntry.ast ?? null, null, 2)}
              </pre>
            </div>
            <div className={styles.section}>
              <span>{t("editor.expression.dependencies")}</span>
              {(expressionEntry.dependencies ?? []).length === 0 ? (
                <span
                  className={styles.noIssues}
                  data-testid="expression-editor-dependency-empty"
                >
                  {t("editor.expression.dependencies.empty")}
                </span>
              ) : (
                <ul
                  className={styles.dependencyList}
                  data-testid="expression-editor-dependency-list"
                >
                  {(expressionEntry.dependencies ?? []).map((d) => (
                    <li key={d} data-testid="expression-editor-dependency">
                      {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
