import { NextResponse } from "next/server";
import { promisify } from "util";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

interface CommandResult {
  cmd: string;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

async function tryCmd(cmd: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: 10_000,
    });
    return {
      cmd: `${cmd} ${args.join(" ")}`,
      ok: true,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 500),
    };
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    return {
      cmd: `${cmd} ${args.join(" ")}`,
      ok: false,
      error: e.message || String(err),
      stderr: typeof e.stderr === "string" ? e.stderr.slice(0, 500) : undefined,
    };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Endpoint de diagnostico para investigar por que a conversao DOCX->PDF
 * esta falhando no servidor. Acesse no navegador (com sessao logada) e
 * envie o JSON retornado pro suporte.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platform = process.platform;
  const nodeVersion = process.version;
  const envPath = (process.env.PATH || "").split(platform === "win32" ? ";" : ":");

  // 1. Tenta localizar soffice/libreoffice via which/where
  const findCmd = platform === "win32" ? "where" : "which";
  const candidates = platform === "win32"
    ? ["soffice.exe", "soffice", "libreoffice"]
    : ["soffice", "libreoffice"];
  const whichResults: CommandResult[] = [];
  for (const c of candidates) {
    whichResults.push(await tryCmd(findCmd, [c]));
  }

  // 2. Lista paths fixos que a lib libreoffice-convert testa no Linux
  const fixedPaths =
    platform === "linux"
      ? [
          "/usr/bin/libreoffice",
          "/usr/bin/soffice",
          "/snap/bin/libreoffice",
          "/opt/libreoffice/program/soffice",
          "/opt/libreoffice7.6/program/soffice",
        ]
      : platform === "darwin"
        ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
        : [
            "C:/Program Files/LibreOffice/program/soffice.exe",
            "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
          ];
  const fixedExists: Record<string, boolean> = {};
  for (const p of fixedPaths) fixedExists[p] = await pathExists(p);

  // 3. Tenta listar /nix/store em busca de libreoffice (so Linux)
  let nixStore: CommandResult | { skipped: string } = { skipped: "not linux" };
  if (platform === "linux") {
    nixStore = await tryCmd("sh", [
      "-c",
      "ls /nix/store 2>/dev/null | grep -i libreoffice | head -20",
    ]);
  }

  // 4. Se achou um soffice em algum lugar, tenta rodar --version
  let version: CommandResult | { skipped: string } = { skipped: "no binary found" };
  const successfulWhich = whichResults.find((r) => r.ok && r.stdout?.trim());
  const detectedPath = successfulWhich?.stdout?.split(/\r?\n/)[0].trim();
  if (detectedPath) {
    version = await tryCmd(detectedPath, ["--version"]);
  } else {
    const existingFixed = fixedPaths.find((p) => fixedExists[p]);
    if (existingFixed) {
      version = await tryCmd(existingFixed, ["--version"]);
    }
  }

  return NextResponse.json({
    platform,
    nodeVersion,
    cwd: process.cwd(),
    envPathFirst10: envPath.slice(0, 10),
    envPathHasNixBin: envPath.some((p) => p.includes("/nix/")),
    detectedSofficePath: detectedPath || null,
    whichResults,
    fixedPathsExistence: fixedExists,
    nixStoreSearch: nixStore,
    sofficeVersion: version,
  });
}
