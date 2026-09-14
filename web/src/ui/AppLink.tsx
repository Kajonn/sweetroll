import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

import { getAppRouter } from "../shell/appNavigation.js";

export type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
};

/**
 * In-app anchor. Renders a native `<a href>` always (deep links, no-JS,
 * standalone renders without a RouterProvider keep working). When a router
 * is registered, unmodified left-clicks on same-origin `/` paths navigate
 * client-side instead of reloading the document. Modifier/middle clicks,
 * external URLs, and hash links always fall through to the browser.
 */
export function AppLink({ href, onClick, children, ...rest }: AppLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.currentTarget as HTMLAnchorElement;
    if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
    if (!href.startsWith("/")) return;
    const router = getAppRouter();
    if (router === null) return;
    event.preventDefault();
    router.history.push(href);
  };
  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
