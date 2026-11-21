// Design 6.7/6.8 (extensions plan E5): the changes a "Rules and extensions"
// dialog offers. Each choice makes one change to the current composition, or
// reverts to the composition recorded before the most recent change.
import { t } from "../i18n/index.js";
import type { CompositionOptions } from "./types.js";
import { versionLabel } from "./VersionReport.js";

export type Composition = { systemVersionId: string; extensions: Array<{ extensionId: string; versionId: string }> };

export type CompositionChoice = {
  key: string;
  label: string;
  notes: string;
  target: Composition;
};

function currentRefs(options: CompositionOptions) {
  return options.current.extensions.map((choice) => ({ extensionId: choice.extensionId, versionId: choice.version.versionId }));
}

export function compositionChoices(options: CompositionOptions): CompositionChoice[] {
  const base = options.current.systemVersion.versionId;
  const refs = currentRefs(options);
  const choices: CompositionChoice[] = [];
  if (options.revertTo !== null) {
    const revert = options.revertTo;
    choices.push({
      key: "revert",
      label: t("version.revertToComposition", { rules: compositionLabel(revert) }),
      notes: "",
      target: {
        systemVersionId: revert.systemVersion.versionId,
        extensions: revert.extensions.map((choice) => ({ extensionId: choice.extensionId, versionId: choice.version.versionId })),
      },
    });
  }
  for (const upgrade of options.systemUpgrades) {
    choices.push({
      key: `system:${upgrade.versionId}`,
      label: t("version.upgradeTo", { version: versionLabel(upgrade) }),
      notes: upgrade.releaseNotes,
      target: { systemVersionId: upgrade.versionId, extensions: refs },
    });
  }
  for (const extension of options.current.extensions) {
    for (const upgrade of extension.upgrades) {
      choices.push({
        key: `upgrade:${upgrade.versionId}`,
        label: t("version.extensionUpgrade", { name: extension.name, version: versionLabel(upgrade) }),
        notes: upgrade.releaseNotes,
        target: {
          systemVersionId: base,
          extensions: refs.map((ref) => ref.extensionId === extension.extensionId ? { ...ref, versionId: upgrade.versionId } : ref),
        },
      });
    }
  }
  for (const extension of options.available) {
    choices.push({
      key: `add:${extension.extensionId}`,
      label: t("version.extensionAdd", { name: extension.name, version: versionLabel(extension.version) }),
      notes: extension.version.releaseNotes,
      target: { systemVersionId: base, extensions: [...refs, { extensionId: extension.extensionId, versionId: extension.version.versionId }] },
    });
  }
  for (const extension of options.current.extensions) {
    choices.push({
      key: `remove:${extension.extensionId}`,
      label: t("version.extensionRemove", { name: extension.name }),
      notes: "",
      target: { systemVersionId: base, extensions: refs.filter((ref) => ref.extensionId !== extension.extensionId) },
    });
  }
  return choices;
}

/** The base version followed by each extension and its version. */
export function compositionLabel(description: CompositionOptions["current"]): string {
  const base = versionLabel(description.systemVersion);
  if (description.extensions.length === 0) return base;
  return [base, ...description.extensions.map((choice) => `${choice.name} ${choice.version.semanticVersion}`)].join(" + ");
}

/** The confirm button's label for the checked change. */
export function confirmLabel(change: { kind: string } | undefined): string {
  switch (change?.kind) {
    case "revert": return t("version.confirmRevert");
    case "extension_add": return t("version.confirmAdd");
    case "extension_remove": return t("version.confirmRemove");
    default: return t("version.confirmUpgrade");
  }
}
