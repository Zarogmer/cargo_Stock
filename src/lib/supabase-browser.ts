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
        // Simple lock: run function directly without navigator.locks
        // Avoids deadlock issues that caused INSERT calls to hang forever
        lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<unknown>) => {
          return await fn();
        },
      },
    }
  );

  return client;
}
