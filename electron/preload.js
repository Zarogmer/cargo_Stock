const { contextBridge, ipcRenderer } = require("electron");

// Expõe informações seguras para o renderer
contextBridge.exposeInMainWorld("electronAPI", {
  isDesktop: true,
  platform: process.platform,
  // Relatórios de Bordo: gera o PDF direto (Downloads + abre), em vez de cair
  // no diálogo de impressão do Windows. O site checa se existe antes de usar —
  // versões antigas do app instalado continuam no caminho de impressão.
  savePdf: (html, fileName) => ipcRenderer.invoke("save-pdf", { html, fileName }),
});
