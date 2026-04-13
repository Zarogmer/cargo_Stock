"use client";

import { createContext, useContext, useEffect, useState, useRef, useMemo } from "react";
import { useSession, signOut as nextAuthSignOut } from "next-auth/react";
import type { Profile } from "@/types/database";
import { db } from "@/lib/db";

interface AuthContextType {
  user: { id: string; email: string; name: string } | null;
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
  const { data: session, status } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const profileFetched = useRef(false);

  const loading = status === "loading";
  const user = useMemo(() => {
    if (!session?.user) return null;
    return {
      id: session.user.id as string,
      email: session.user.email || "",
      name: session.user.name || "",
    };
  }, [session?.user]);

  const userRole = (session?.user as any)?.role || "RH";

  useEffect(() => {
    if (!user || profileFetched.current) return;
    profileFetched.current = true;

    // Build profile from session data (user table has all profile fields)
    const sessionProfile: Profile = {
      id: user.id,
      email: user.email,
      full_name: user.name,
      role: userRole,
      created_at: "",
      updated_at: "",
    };
    setProfile(sessionProfile);

    // Log login event (fire and forget)
    db.from("login_logs").insert({
      user_id: user.id,
      full_name: user.name,
      email: user.email,
      event_type: "LOGIN",
    }).then(() => {}).catch(() => {});
  }, [user, userRole]);

  // Reset profile when user signs out
  useEffect(() => {
    if (!user) {
      setProfile(null);
      profileFetched.current = false;
    }
  }, [user]);

  async function handleSignOut() {
    // Log logout event
    if (user && profile) {
      try {
        await db.from("login_logs").insert({
          user_id: user.id,
          full_name: profile.full_name,
          email: profile.email,
          event_type: "LOGOUT",
        });
      } catch {
        // ignore
      }
    }
    await nextAuthSignOut({ callbackUrl: "/login" });
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
