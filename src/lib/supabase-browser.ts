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
        lock: async (name: string, acquireTimeout: number, fn: () => Promise<unknown>) => {
          if (typeof navigator === "undefined" || !navigator.locks) {
            return await fn();
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), Math.max(acquireTimeout, 5000));

          try {
            return await navigator.locks.request(
              name,
              { signal: controller.signal },
              async () => await fn()
            );
          } catch (err: any) {
            if (err.name === "AbortError") {
              // Lock timed out — run without lock as fallback
              return await fn();
            }
            // Any other lock error — still run the function
            return await fn();
          } finally {
            clearTimeout(timeoutId);
          }
        },
      },
    }
  );

  return client;
}
