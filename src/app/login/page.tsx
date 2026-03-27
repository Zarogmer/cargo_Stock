"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error: err } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (err) {
      // Show real error for debugging
      if (err.message.includes("Invalid login")) {
        setError("Email ou senha inválidos.");
      } else if (err.message.includes("Email not confirmed")) {
        setError("Email não confirmado. Verifique sua caixa de entrada.");
      } else {
        setError(`Erro: ${err.message}`);
      }
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);

    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });

    if (err) {
      setError(`Erro: ${err.message}`);
    } else {
      setSuccess("Email de recuperação enviado! Verifique sua caixa de entrada.");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-dark to-primary p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/20 rounded-2xl mb-4">
            <span className="text-4xl">🚢</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Cargo Stock</h1>
          <p className="text-blue-200 text-sm mt-1">
            Sistema de Gestão de Estoque
          </p>
        </div>

        {/* Login Form */}
        <form
          onSubmit={mode === "login" ? handleLogin : handleForgotPassword}
          className="bg-white rounded-2xl shadow-xl p-6 space-y-4"
        >
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="seu@email.com"
              className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition text-sm"
            />
          </div>

          {mode === "login" && (
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Senha
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition text-sm"
              />
            </div>
          )}

          {error && (
            <div className="bg-red-50 text-red-600 text-sm p-3 rounded-xl">
              {error}
            </div>
          )}

          {success && (
            <div className="bg-green-50 text-green-600 text-sm p-3 rounded-xl">
              {success}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary-dark text-white font-semibold py-3 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg
                  className="animate-spin h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                {mode === "login" ? "Entrando..." : "Enviando..."}
              </span>
            ) : mode === "login" ? (
              "Entrar"
            ) : (
              "Enviar email de recuperação"
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "forgot" : "login");
              setError("");
              setSuccess("");
            }}
            className="w-full text-sm text-primary hover:text-primary-dark transition"
          >
            {mode === "login"
              ? "Esqueci minha senha"
              : "Voltar para o login"}
          </button>
        </form>
      </div>
    </div>
  );
}
