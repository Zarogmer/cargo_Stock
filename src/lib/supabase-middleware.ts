import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as any)
          );
        },
      },
    }
  );

  const isLoginPage = request.nextUrl.pathname.startsWith("/login");
  const isAuthPage = request.nextUrl.pathname.startsWith("/auth");
  const isDebugPage = request.nextUrl.pathname.startsWith("/debug");

  // Skip auth check for public pages
  if (isLoginPage || isAuthPage || isDebugPage) {
    return supabaseResponse;
  }

  // Use getSession() - reads cookies only, no network call (fast on mobile)
  const {
    data: { session },
  } = await supabase.auth.getSession();

  // If no session, redirect to login
  if (!session) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const response = NextResponse.redirect(url);

    // Clear any stale supabase cookies to prevent stuck state
    request.cookies.getAll().forEach((cookie) => {
      if (cookie.name.includes("sb-") || cookie.name.includes("supabase")) {
        response.cookies.set(cookie.name, "", {
          expires: new Date(0),
          path: "/",
        });
      }
    });

    return response;
  }

  // Check if token is expired (with 60s buffer)
  if (session.expires_at && session.expires_at * 1000 < Date.now() - 60000) {
    // Token is expired, try to refresh via getUser (which triggers refresh)
    const { error } = await supabase.auth.getUser();
    if (error) {
      // Refresh failed, redirect to login and clear cookies
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      const response = NextResponse.redirect(url);

      request.cookies.getAll().forEach((cookie) => {
        if (cookie.name.includes("sb-") || cookie.name.includes("supabase")) {
          response.cookies.set(cookie.name, "", {
            expires: new Date(0),
            path: "/",
          });
        }
      });

      return response;
    }
  }

  // If session exists and on login page, redirect to dashboard
  if (session && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
