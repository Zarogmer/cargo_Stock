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
    // 7 dias: o supervisor loga no escritório e passa dias a bordo sem sinal;
    // com 8h a sessão morria no navio e a fila offline (src/lib/offline) só
    // subia depois de um novo login. (Antes, 5 min matava a sessão no meio da
    // conciliação e os salvamentos falhavam com 401 silencioso.)
    maxAge: 7 * 24 * 60 * 60,
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
        path.startsWith("/api/whatsapp/webhook") ||
        path.startsWith("/api/cron/") ||
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
