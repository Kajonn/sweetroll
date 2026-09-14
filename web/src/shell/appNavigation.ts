/** Minimal structural router surface: the real TanStack Router is assignable. */
export type AppRouterLike = { history: { push(path: string): void } };

let current: AppRouterLike | null = null;

export function registerAppRouter(router: AppRouterLike): void {
  current = router;
}

export function getAppRouter(): AppRouterLike | null {
  return current;
}

/** Test seam: every suite that registers must reset in afterEach. */
export function resetAppRouter(): void {
  current = null;
}
