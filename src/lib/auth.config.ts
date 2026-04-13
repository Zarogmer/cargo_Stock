import type { NextAuthConfig } from "next-auth";

/**
 * Shared NextAuth config - does NOT import Prisma or bcrypt.
 * Safe to use in Edge Runtime (middleware).
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 5 * 60, // 5 minutes
  },
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user;
      const path = request.nextUrl.pathname;

      // Public routes
      const isPublic =
        path.startsWith("/login") ||
        path.startsWith("/auth") ||
        path.startsWith("/api/auth") ||
        path.startsWith("/api/seed") ||
        path.startsWith("/api/seed-stock") ||
        path.startsWith("/debug");

      if (isPublic) return true;

      // Protected routes
      if (!isLoggedIn) return false;

      // Redirect logged-in users away from login
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.name = user.name;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as any).role = token.role;
        session.user.name = token.name as string;
      }
      return session;
    },
  },
  providers: [], // Providers added in auth.ts (not needed for middleware)
  trustHost: true,
} satisfies NextAuthConfig;
