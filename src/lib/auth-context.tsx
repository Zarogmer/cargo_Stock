"use client";

import { createContext, useContext, useEffect, useState, useRef } from "react";
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
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;

  async function fetchProfile(userId: string) {
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

    // Explicit session check first (more reliable than onAuthStateChange INITIAL_SESSION)
    async function init() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          const prof = await fetchProfile(currentUser.id);
          setProfile(prof);
        }
      } catch (err) {
        console.error("Auth init failed:", err);
      } finally {
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

      if (currentUser && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
        const prof = await fetchProfile(currentUser.id);
        setProfile(prof);
      } else if (!currentUser) {
        setProfile(null);
      }
    });

    return () => {
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
