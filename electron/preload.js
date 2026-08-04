const { contextBridge } = require("electron");

// Expõe informações seguras para o renderer
contextBridge.exposeInMainWorld("electronAPI", {
  isDesktop: true,
  platform: process.platform,
});
