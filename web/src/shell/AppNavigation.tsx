import { useEffect, useId, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { t } from "../i18n/index.js";
import { AppLink } from "../ui/AppLink.js";
import styles from "./AppShell.module.css";

/** One set of real links: inline on desktop, disclosed on smaller screens. */
export function AppNavigation() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return <div ref={root} className={styles.navigation} data-open={open}>
    <button ref={trigger} type="button" className={styles.menuButton}
      aria-label={t("shell.nav.menu")} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>
      <Menu size={20} aria-hidden />
    </button>
    <nav id={id} aria-label={t("shell.nav.label")} className={styles.nav}>
      {([
        ["/", "shell.nav.home"],
        ["/characters", "shell.nav.characters"],
        ["/campaigns", "shell.nav.campaigns"],
        ["/characters/new", "shell.nav.newCharacter"],
        ["/activity", "shell.nav.activity"],
        ["/account", "shell.nav.account"],
      ] as const).map(([href, label]) => <AppLink key={href} href={href} className={styles.navLink}
        onClick={() => setOpen(false)}>{t(label)}</AppLink>)}
    </nav>
  </div>;
}
