const { app, BrowserWindow, shell, Menu, Tray, nativeImage } = require("electron");
const path = require("path");

// URL do site deployado no Railway
const APP_URL = "https://cargostock-production.up.railway.app";

let mainWindow;
let tray;
let isQuitting = false;

function createWindow() {
  const iconPath = path.join(__dirname, "..", "public", "icons", "icon-512.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Cargo Stock",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Remove o menu padrão do Electron
  Menu.setApplicationMenu(null);

  // Carrega o site
  mainWindow.loadURL(APP_URL);

  // Abre links externos no navegador padrão
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url !== APP_URL && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Intercepta navegação para links externos
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Fechar a janela (botao X) apenas esconde o app na bandeja do sistema;
  // ele continua rodando. So encerra de verdade pelo menu "Sair" da bandeja.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Cria ícone na bandeja do sistema (system tray)
function createTray() {
  const iconPath = path.join(__dirname, "..", "public", "icons", "icon-192.png");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Abrir Cargo Stock",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: "Sair",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Cargo Stock");
  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // Abre o Cargo Stock automaticamente ao ligar o computador (login do Windows).
  // Só no app instalado (nao no modo dev). Reaplicado a cada inicializacao
  // para se autocorrigir caso o caminho do executavel mude apos uma atualizacao.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Qualquer pedido real de encerramento (ex.: menu "Sair", desligar o Windows)
// marca a flag para a janela poder fechar de fato em vez de so esconder.
app.on("before-quit", () => {
  isQuitting = true;
});

// Nao encerra o app ao fechar a janela: ele permanece na bandeja do sistema.
// O encerramento acontece somente pelo menu "Sair" da bandeja.
app.on("window-all-closed", () => {});
