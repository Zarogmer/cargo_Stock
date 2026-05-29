import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);

// libreoffice-convert nao tem types publicados; declarado localmente.
type LibreConvertFn = (
  buffer: Buffer,
  format: string,
  filter: string | undefined,
  options: { sofficeBinaryPaths?: string[] },
  cb: (err: Error | null, result: Buffer) => void,
) => void;

interface LibreModule {
  convertWithOptions: LibreConvertFn;
}

// Cache do path detectado; undefined = nunca tentou; null = tentou e nao achou.
let cachedSofficePath: string | null | undefined;

/**
 * Detecta o binario `soffice` em runtime.
 *
 * O motivo: `libreoffice-convert` tem uma lista fixa de paths no Linux
 * (/usr/bin/soffice, /opt/libreoffice/..., etc.). O LibreOffice instalado
 * via Nix (nixpacks no Railway) vai pra /nix/store/<hash>-libreoffice/...,
 * que nao esta na lista. Por isso precisamos descobrir o path real usando
 * which/where e passar via `sofficeBinaryPaths` na chamada.
 */
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
      // tenta proximo candidato
    }
  }

  cachedSofficePath = null;
  return null;
}

/**
 * Converte um buffer DOCX para PDF usando LibreOffice headless.
 * O servidor precisa do binario `soffice` (em producao o nixpacks.toml
 * instala o pacote `libreoffice`; em dev local Windows, a instalacao
 * do LibreOffice Suite e detectada automaticamente).
 *
 * Lanca um erro com mensagem rica em diagnostico se a conversao falhar -
 * a route que chama esta funcao deve traduzir isso em 503 com explicacao
 * para o usuario tentar a versao Word.
 */
export async function docxToPdf(docxBuffer: Buffer): Promise<Buffer> {
  let libre: LibreModule;
  try {
    libre = (await import("libreoffice-convert")) as unknown as LibreModule;
  } catch (err) {
    throw new Error(
      `Conversor PDF indisponivel no servidor (libreoffice-convert nao carregou): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const sofficePath = await findSofficePath();

  if (!sofficePath) {
    throw new Error(
      "Binario LibreOffice (soffice) nao encontrado no servidor. " +
        "Verifique se o nixpacks.toml inclui o pacote 'libreoffice' e se o build foi refeito.",
    );
  }

  const convertAsync = promisify(libre.convertWithOptions);
  const options = { sofficeBinaryPaths: [sofficePath] };

  try {
    return await convertAsync(docxBuffer, ".pdf", undefined, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `LibreOffice (${sofficePath}) nao conseguiu converter o documento para PDF: ${msg}`,
    );
  }
}
