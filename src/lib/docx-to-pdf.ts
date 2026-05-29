import { promisify } from "util";

// libreoffice-convert nao tem types publicados; declarado localmente.
type LibreConvertFn = (
  buffer: Buffer,
  format: string,
  filter: string | undefined,
  cb: (err: Error | null, result: Buffer) => void,
) => void;

interface LibreModule {
  convert: LibreConvertFn;
}

/**
 * Converte um buffer DOCX para PDF usando LibreOffice headless.
 * O servidor precisa do binario `soffice` no PATH (em producao o
 * nixpacks.toml instala o pacote `libreoffice`; em dev local Windows,
 * a instalacao do LibreOffice Suite e detectada automaticamente).
 *
 * Lanca um erro com mensagem amigavel se a conversao falhar - a route
 * que chama esta funcao deve traduzir isso em 503 com explicacao para
 * o usuario tentar a versao Word.
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

  const convertAsync = promisify(libre.convert);

  try {
    return await convertAsync(docxBuffer, ".pdf", undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `LibreOffice nao conseguiu converter o documento para PDF: ${msg}`,
    );
  }
}
