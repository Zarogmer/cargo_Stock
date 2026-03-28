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

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Safety timeout: force loading=false after 8 seconds
    const timeout = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          console.warn("Auth loading timed out, forcing load complete");
          return false;
        }
        return prev;
      });
    }, 8000);

    async function init() {
      try {
        // Check if Supabase is configured
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (!url) {
          console.error("NEXT_PUBLIC_SUPABASE_URL is not configured");
          setLoading(false);
          return;
        }

        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) {
          console.error("getSession error:", error.message);
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
      } finally {
        clearTimeout(timeout);
        setLoading(false);
      }
    }

    init();

    // Listen for subsequent auth changes (login, logout, token refresh)
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
    await supabase.auth.signOut();
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
