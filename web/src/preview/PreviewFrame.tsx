import { useState, type ReactNode } from "react";

import { t } from "../i18n/index.js";
import { useShortcut } from "../shell/useShortcut.js";

import styles from "./PreviewFrame.module.css";

export type PreviewWidth = 360 | 1280;

export type PreviewFrameProps = {
  initialWidth?: PreviewWidth | undefined;
  children: ReactNode;
};

export function PreviewFrame({
  initialWidth = 360,
  children,
}: PreviewFrameProps) {
  const [width, setWidth] = useState<PreviewWidth>(initialWidth);

  const toggle = () => {
    setWidth((current) => (current === 360 ? 1280 : 360));
  };

  useShortcut("Alt+P", toggle);

  const widthLabel =
    width === 360
      ? t("preview.frame.width.360")
      : t("preview.frame.width.1280");
  const nextLabel =
    width === 360
      ? t("preview.frame.width.1280")
      : t("preview.frame.width.360");

  return (
    <div className={styles.frame} data-testid="preview-frame" data-width={width}>
      <div className={styles.toolbar} data-testid="preview-frame-toolbar">
        <span className={styles.toolbarLabel}>
          {t("preview.frame.widthToggle")}: {widthLabel}
        </span>
        <button
          type="button"
          className={styles.toggle}
          onClick={toggle}
          title={t("preview.frame.toggleShortcut")}
          data-testid="preview-frame-toggle"
        >
          {nextLabel}
        </button>
        <span className={styles.shortcut} data-testid="preview-frame-shortcut">
          {t("preview.frame.toggleShortcut")}
        </span>
      </div>
      <div
        className={styles.container}
        data-testid="preview-frame-container"
        data-width={width}
        style={{ width: `${width}px` }}
      >
        {children}
      </div>
    </div>
  );
}
