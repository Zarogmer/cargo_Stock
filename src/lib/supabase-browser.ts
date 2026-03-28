import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (client) return client;

  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        flowType: "pkce",
        detectSessionInUrl: true,
        persistSession: true,
        // Custom lock function that handles lock contention gracefully
        // Prevents "Lock was released because another request stole it" errors
        // when multiple tabs are open
        lock: async (name: string, acquireTimeout: number, fn: () => Promise<unknown>) => {
          if (typeof navigator === "undefined" || !navigator.locks) {
            // No Lock API (e.g. older browsers), just run directly
            return await fn();
          }
          try {
            return await navigator.locks.request(
              name,
              { mode: "exclusive", ifAvailable: true },
              async (lock) => {
                if (lock) {
                  return await fn();
                } else {
                  // Lock is held by another tab, wait briefly then run anyway
                  await new Promise((r) => setTimeout(r, 100));
                  return await fn();
                }
              }
            );
          } catch {
            // Lock was stolen or errored — just run the function anyway
            // This prevents the app from crashing when tabs compete
            return await fn();
          }
        },
      },
    }
  );

  return client;
}
