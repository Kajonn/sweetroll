import { QueryClient } from "@tanstack/react-query";

/**
 * Shared query client for the application. It outlives route remounts and
 * account lifetimes, so AppShell explicitly cancels and clears
 * account-scoped entries when the identity lifetime changes (see AppShell).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: false },
    mutations: { retry: false },
  },
});
