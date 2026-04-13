import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

// Use the lightweight auth config (no bcrypt/prisma) for Edge Runtime middleware
export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public assets (icons, manifest, etc.)
     */
    "/((?!_next/static|_next/image|favicon.ico|icons|manifest.json|sw.js).*)",
  ],
};
