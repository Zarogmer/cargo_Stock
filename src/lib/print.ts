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
