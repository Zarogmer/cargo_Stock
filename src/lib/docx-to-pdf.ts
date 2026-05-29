import { promisify } from "util";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

const execFileAsync = promisify(execFile);

// Cache do path detectado entre chamadas. undefined = nunca tentou.
let cachedSofficePath: string | null | undefined;

async function findSofficePath(): Promise<string | null> {
  if (cachedSofficePath !== undefined) return cachedSofficePath;

  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  const candidates = isWin
    ? ["soffice.exe", "soffice"]
    : ["soffice", "libreoffice"];

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd, [bin]);
      const first = stdout.split(/\r?\n/)[0].trim();
      if (first) {
        cachedSofficePath = first;
        return first;
      }
    } catch {
      // tenta o proximo candidato
    }
  }

  cachedSofficePath = null;
  return null;
}

/**
 * Converte um buffer DOCX para PDF chamando o binario `soffice` diretamente.
 *
 * NAO usa a lib `libreoffice-convert` porque ela trata qualquer aparicao
 * da palavra "error" no stderr como falha — e o LibreOffice em Nix sempre
 * loga "Fontconfig error: ..." mesmo quando a conversao da certo. Aqui a
 * gente confia no arquivo de saida: se o PDF existe, a conversao funcionou.
 *
 * Cada chamada usa um diretorio de profile dedicado (UserInstallation +
 * HOME) pra permitir conversoes concorrentes sem conflito.
 */
export async function docxToPdf(docxBuffer: Buffer): Promise<Buffer> {
  const sofficePath = await findSofficePath();
  if (!sofficePath) {
    throw new Error(
      "Binario LibreOffice (soffice) nao encontrado no servidor. " +
        "Verifique se o nixpacks.toml inclui o pacote 'libreoffice'.",
    );
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "docx2pdf-"));
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "sofficeprofile-"));
  const inputName = `input-${randomBytes(4).toString("hex")}.docx`;
  const inputPath = path.join(workDir, inputName);
  const outputPath = path.join(
    workDir,
    inputName.replace(/\.docx$/, ".pdf"),
  );

  await fs.writeFile(inputPath, docxBuffer);

  const args = [
    `-env:UserInstallation=file://${profileDir}`,
    "--headless",
    "--norestore",
    "--nologo",
    "--nofirststartwizard",
    "--convert-to",
    "pdf",
    "--outdir",
    workDir,
    inputPath,
  ];

  type ExecError = {
    message?: string;
    stderr?: string;
    stdout?: string;
    code?: number;
  };
  let execErr: ExecError | null = null;
  try {
    await execFileAsync(sofficePath, args, {
      timeout: 60_000,
      env: { ...process.env, HOME: profileDir },
    });
  } catch (err) {
    // Pode falhar com warnings ainda assim ter gerado o PDF — checamos abaixo.
    execErr = err as ExecError;
  }

  try {
    return await fs.readFile(outputPath);
  } catch {
    const stderr = (execErr?.stderr ?? "").slice(0, 800);
    const stdout = (execErr?.stdout ?? "").slice(0, 200);
    throw new Error(
      `LibreOffice (${sofficePath}) nao gerou o PDF. ` +
        `exit_code=${execErr?.code ?? "0"} stderr=${stderr} stdout=${stdout}`,
    );
  } finally {
    // Cleanup do tempdir (ignora erros — sao melhores que travar o request)
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
