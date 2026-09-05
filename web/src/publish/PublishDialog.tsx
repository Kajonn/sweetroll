import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { ApiError, type ApiClient, type ApiDiagnostic } from "../api/client.js";
import { usePublish, type PublishInput } from "../api/publish.js";
import type { PublishedVersion } from "../api/server.js";
import { t } from "../i18n/index.js";

import styles from "./PublishDialog.module.css";

type BumpKind = "patch" | "minor" | "major";

const BUMP_KINDS: ReadonlyArray<BumpKind> = ["patch", "minor", "major"];

function findingKey(f: ApiDiagnostic): string {
  return `${f.code}:${f.path}`;
}

function parseSemver(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m === null) return null;
  const parts = m.slice(1, 4).map((n) => Number(n));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const [a, b, c] = parts as [number, number, number];
  return [a, b, c];
}

function formatSemver(v: [number, number, number]): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

function bumpSemver(current: string, kind: BumpKind): string {
  const parsed = parseSemver(current);
  if (parsed === null) return "0.1.0";
  const [major, minor, patch] = parsed;
  switch (kind) {
    case "patch":
      return formatSemver([major, minor, patch + 1]);
    case "minor":
      return formatSemver([major, minor + 1, 0]);
    case "major":
      return formatSemver([major + 1, 0, 0]);
  }
}

export function PublishDialog({
  client,
  open,
  onOpenChange,
  systemId,
  expectedRevision,
}: {
  client: ApiClient;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  systemId: string;
  expectedRevision: number;
}) {
  const [semver, setSemver] = useState("0.1.0");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [breakingFindings, setBreakingFindings] = useState<ApiDiagnostic[] | null>(null);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [published, setPublished] = useState<PublishedVersion | null>(null);
  const mutation = usePublish(client);

  const allAcknowledged =
    breakingFindings === null || breakingFindings.every((f) => acknowledged.has(findingKey(f)));
  const submitDisabled = mutation.isPending || !allAcknowledged;

  const submit = async () => {
    const input: PublishInput = {
      systemId,
      expectedRevision,
      semanticVersion: semver,
      releaseNotes,
      idempotencyKey: crypto.randomUUID(),
    };
    try {
      const v = await mutation.mutateAsync(input);
      setPublished(v);
      setBreakingFindings(null);
      setAcknowledged(new Set());
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_package" && e.diagnostics.length > 0) {
        setBreakingFindings([...e.diagnostics]);
        setAcknowledged(new Set());
      }
    }
  };

  const toggleAcknowledged = (key: string) => {
    setAcknowledged((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const close = () => onOpenChange(false);

  if (published !== null) {
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={styles.content}
            aria-describedby={undefined}
            data-testid="publish-dialog-success"
          >
            <Dialog.Title className={styles.title}>{t("publish.success.title")}</Dialog.Title>
            <p className={styles.body}>{t("publish.success.message", { version: published.semanticVersion })}</p>
            <dl className={styles.meta}>
              <div className={styles.metaRow}>
                <dt className={styles.metaKey}>{t("publish.success.versionId")}</dt>
                <dd className={styles.metaValue}>{published.versionId}</dd>
              </div>
              <div className={styles.metaRow}>
                <dt className={styles.metaKey}>{t("publish.success.checksum")}</dt>
                <dd className={styles.metaValue}>{published.checksum}</dd>
              </div>
            </dl>
            <div className={styles.actions}>
              <button
                type="button"
                onClick={close}
                className={styles.submit}
                data-testid="publish-dialog-close"
              >
                {t("publish.close")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          aria-describedby={undefined}
          data-testid="publish-dialog"
        >
          <Dialog.Title className={styles.title}>{t("publish.title")}</Dialog.Title>
          <label className={styles.field}>
            <span className={styles.label}>{t("publish.semver")}</span>
            <input
              value={semver}
              onChange={(e) => setSemver(e.target.value)}
              data-testid="publish-dialog-semver"
              className={styles.input}
              spellCheck={false}
              autoComplete="off"
            />
            <div className={styles.bumps}>
              {BUMP_KINDS.map((k) => (
                <button
                  type="button"
                  key={k}
                  onClick={() => setSemver(bumpSemver(semver, k))}
                  data-testid={`publish-dialog-bump-${k}`}
                  className={styles.bump}
                >
                  {t(`publish.bump.${k}`)}
                </button>
              ))}
            </div>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t("publish.releaseNotes")}</span>
            <textarea
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              rows={6}
              data-testid="publish-dialog-release-notes"
              className={styles.textarea}
            />
          </label>
          {breakingFindings !== null && breakingFindings.length > 0 && (
            <section className={styles.findings} data-testid="publish-dialog-findings">
              <h3 className={styles.findingsTitle}>{t("publish.findings.title")}</h3>
              <p className={styles.findingsIntro}>{t("publish.findings.intro", { count: breakingFindings.length })}</p>
              <ul className={styles.findingList}>
                {breakingFindings.map((f) => {
                  const key = findingKey(f);
                  const checked = acknowledged.has(key);
                  const testid = `publish-dialog-finding-${f.code}-${f.path}`;
                  return (
                    <li key={key} className={styles.finding} data-testid={testid}>
                      <label className={styles.findingRow}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAcknowledged(key)}
                          data-testid={`publish-dialog-finding-checkbox-${f.code}-${f.path}`}
                        />
                        <span className={styles.findingBody}>
                          <span className={styles.findingCode}>{f.code}</span>
                          <span className={styles.findingPath}>{f.path}</span>
                          <span className={styles.findingMessage}>{f.message}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {mutation.isError && breakingFindings === null && (
            <p className={styles.error} role="alert" data-testid="publish-dialog-error">
              {mutation.error instanceof ApiError
                ? t("publish.error.withCode", { code: mutation.error.code, message: mutation.error.message })
                : t("publish.error.generic")}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              onClick={close}
              className={styles.cancel}
              data-testid="publish-dialog-cancel"
            >
              {t("publish.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitDisabled}
              data-testid="publish-dialog-submit"
              className={styles.submit}
            >
              {mutation.isPending ? t("publish.submitting") : t("publish.submit")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
