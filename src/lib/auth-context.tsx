"use client";

import { createContext, useContext, useEffect, useState, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase-browser";
import type { Profile } from "@/types/database";
import type { User } from "@supabase/supabase-js";

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const initialized = useRef(false);
  const supabase = useMemo(() => createClient(), []);

  async function fetchProfile(userId: string): Promise<Profile | null> {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

      if (error) {
        console.error("Error fetching profile:", error.message);
        return null;
      }
      return data as Profile;
    } catch (err) {
      console.error("Profile fetch failed:", err);
      return null;
    }
  }

  // Check if session token is expired
  function isSessionExpired(session: { expires_at?: number } | null): boolean {
    if (!session?.expires_at) return true;
    // Add 60 second buffer
    return session.expires_at * 1000 < Date.now() - 60000;
  }

  // Clear corrupted session cookies
  async function clearCorruptedSession() {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // If signOut fails, manually clear cookies
      document.cookie.split(";").forEach((c) => {
        const name = c.trim().split("=")[0];
        if (name.includes("sb-") || name.includes("supabase")) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }
      });
    }
  }

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Safety timeout: force loading=false after 5 seconds
    const timeout = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          console.warn("Auth loading timed out, forcing load complete");
          return false;
        }
        return prev;
      });
    }, 5000);

    async function init() {
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (!url) {
          console.error("NEXT_PUBLIC_SUPABASE_URL is not configured");
          setLoading(false);
          return;
        }

        // Try to get the current session
        const { data: { session }, error } = await supabase.auth.getSession();

        if (error) {
          console.error("getSession error:", error.message);

          // If it's a lock error or auth error, try to recover
          if (error.message.includes("lock") || error.message.includes("stole")) {
            console.warn("Lock contention detected, clearing session...");
            await clearCorruptedSession();
          }

          setLoading(false);
          return;
        }

        // Check if session exists and is not expired
        if (session && isSessionExpired(session)) {
          console.warn("Session expired, trying to refresh...");
          const { data: { session: refreshedSession }, error: refreshError } =
            await supabase.auth.refreshSession();

          if (refreshError || !refreshedSession) {
            console.warn("Refresh failed, clearing session");
            await clearCorruptedSession();
            setUser(null);
            setProfile(null);
            setLoading(false);
            return;
          }

          // Use the refreshed session
          setUser(refreshedSession.user);
          const prof = await fetchProfile(refreshedSession.user.id);
          setProfile(prof);
          setLoading(false);
          return;
        }

        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          const prof = await fetchProfile(currentUser.id);
          setProfile(prof);
        }
      } catch (err) {
        console.error("Auth init failed:", err);
        // On any unexpected error, try to clear corrupted state
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("lock") || errMsg.includes("stole")) {
          await clearCorruptedSession();
        }
      } finally {
        clearTimeout(timeout);
        setLoading(false);
      }
    }

    init();

    // Listen for subsequent auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Skip INITIAL_SESSION — already handled by init()
      if (event === "INITIAL_SESSION") return;

      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (
        currentUser &&
        (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")
      ) {
        const prof = await fetchProfile(currentUser.id);
        setProfile(prof);
      } else if (!currentUser) {
        setProfile(null);
      }

      setLoading(false);
    });

    return () => {
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    try {
      await supabase.auth.signOut();
    } catch {
      // Force clear even if signOut fails
      await clearCorruptedSession();
    }
    setUser(null);
    setProfile(null);
    window.location.href = "/login";
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
