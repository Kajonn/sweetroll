import * as RadixDialog from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { createContext, useContext, type HTMLAttributes } from "react";
import styles from "./SystemPresentation.module.css";

export type SystemPresentation = { colorPreset: "default" | "blue" | "ochre"; componentStyle?: "default" | "classic" };
const Context = createContext<SystemPresentation | undefined>(undefined);
export const COLOR_PRESETS = ["default", "blue", "ochre"] as const;

export function useSystemPresentationAttributes() {
  const presentation = useContext(Context);
  return {
    "data-system-preset": presentation?.colorPreset,
    "data-system-style": presentation === undefined ? undefined : presentation.componentStyle ?? "default",
    className: presentation === undefined ? "" : styles.scope,
  };
}

/** Local identity; mode comes from the existing document-level preference. */
export function SystemPresentationScope({ presentation, as: Tag = "div", className, ...props }: HTMLAttributes<HTMLDivElement> & {
  presentation?: SystemPresentation | undefined;
  as?: "div" | "main" | "section";
}) {
  const value = presentation ?? { colorPreset: "default" as const };
  return <Context.Provider value={value}><Tag {...props} data-system-preset={value.colorPreset} data-system-style={value.componentStyle ?? "default"} className={`${styles.scope} ${className ?? ""}`} /></Context.Provider>;
}

export function SystemDialogContent(props: ComponentProps<typeof RadixDialog.Content>) {
  const attrs = useSystemPresentationAttributes();
  return <RadixDialog.Content {...props} {...attrs} className={`${attrs.className} ${props.className ?? ""}`} />;
}
export function SystemDialogOverlay(props: ComponentProps<typeof RadixDialog.Overlay>) {
  const attrs = useSystemPresentationAttributes();
  return <RadixDialog.Overlay {...props} {...attrs} className={`${attrs.className} ${props.className ?? ""}`} />;
}
