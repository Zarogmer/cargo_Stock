// Impressão de documentos do RH (DDS, Ficha de EPI, Aviso Médico, Recibo).
// Os documentos já são gerados como PDF pela API; para "Imprimir" reaproveitamos
// esse PDF: carregamos o Blob numa iframe oculta e disparamos o diálogo de
// impressão do navegador (Chromium/Electron renderiza o PDF e imprime).
export function printPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    URL.revokeObjectURL(url);
    iframe.remove();
  };

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    // afterprint devolve o foco e limpa a iframe quando o usuário fecha o diálogo.
    try {
      win.addEventListener("afterprint", cleanup);
    } catch {
      /* alguns viewers de PDF restringem o acesso — cai no timeout abaixo */
    }
    win.focus();
    win.print();
    // Fallback: nem todo navegador dispara afterprint em PDF — limpa mesmo assim.
    window.setTimeout(cleanup, 60_000);
  };

  // onload registrado antes do src para não perder o evento com Blob local.
  document.body.appendChild(iframe);
  iframe.src = url;
}

// Entrega um documento gerado (PDF/Word) ao usuário. No CELULAR usa a Web Share
// API passando SÓ o arquivo — assim, ao mandar pro WhatsApp, anexa apenas o PDF/
// Word, sem vazar o link `blob:` como texto (era o que acontecia com o download).
// No desktop (ou quando o navegador não sabe compartilhar arquivos), baixa normal.
export async function shareOrDownloadBlob(blob: Blob, fileName: string): Promise<void> {
  const file = new File([blob], fileName, { type: blob.type || "application/octet-stream" });

  // navigator.canShare/share com `files` existe basicamente só em mobile. Passar
  // apenas { files } (sem title/text/url) faz o WhatsApp receber só o arquivo.
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return;
    } catch (err) {
      // Usuário cancelou o menu de compartilhar → não faz nada (não baixa).
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Qualquer outra falha: cai pro download abaixo.
    }
  }

  // Fallback desktop: baixa o arquivo.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
