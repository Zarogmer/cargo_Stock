const { app, BrowserWindow, shell, Menu, Tray, nativeImage, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

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

  // Janelas novas: "about:blank" é a janela de impressão dos Relatórios de
  // Bordo (window.open("") + document.write dos PDFs) — permite como janela
  // filha, senão o "Gerar PDF" morre bloqueado. Qualquer outra URL fora do
  // app abre no navegador padrão.
  // Só manda pro navegador padrão o que for http/https de fora do app. Sem esse
  // filtro, o "about:blank" da janela de impressão caía no shell.openExternal e
  // o Windows abria a caixa "Você precisa de um novo app para abrir este link
  // about" — o que o usuário via ao gerar PDF.
  const isExternalLink = (url) => /^https?:\/\//i.test(url) && !url.startsWith(APP_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Intercepta navegação para links externos
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isExternalLink(url)) {
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

// Salva um relatório como PDF de verdade, sem passar pelo diálogo de impressão
// do Windows (que no Electron é o diálogo do sistema, não a pré-visualização do
// Chrome). O renderer manda o HTML já com as imagens embutidas em data URL —
// por isso a janela oculta consegue renderizar tudo sem sessão/cookie.
// O arquivo cai em Downloads e abre no visualizador padrão.
ipcMain.handle("save-pdf", async (_event, payload) => {
  const html = String(payload?.html || "");
  const baseName = sanitizeFileName(payload?.fileName || "Relatorio") + ".pdf";
  const tmpHtml = path.join(app.getPath("temp"), `cargo-report-${Date.now()}.html`);
  let win = null;

  try {
    fs.writeFileSync(tmpHtml, html, "utf8");
    win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(tmpHtml);

    // margins zerado = respeita o @page margin do CSS do relatório.
    const pdf = await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    const target = uniquePath(app.getPath("downloads"), baseName);
    fs.writeFileSync(target, pdf);
    shell.openPath(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (win) win.destroy();
    fs.unlink(tmpHtml, () => {});
  }
});

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "Relatorio";
}

// "Relatorio.pdf" já existe → "Relatorio (2).pdf" (não sobrescreve o anterior).
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
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

// Garante INSTANCIA UNICA. Sem isto, cada vez que o app e aberto (atalho na
// barra de tarefas, auto-start no login, etc.) o Electron cria uma janela/
// processo novo, enquanto o anterior continua escondido na bandeja — acumulando
// varias instancias do Cargo Stock.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Ja existe uma instancia rodando: encerra esta silenciosamente. A que esta
  // aberta recebe o evento "second-instance" abaixo e aparece para o usuario.
  app.quit();
} else {
  // Tentaram abrir o app de novo: em vez de criar outra janela, traz a janela
  // que ja existe para frente (mostra se estava na bandeja, desminimiza e foca).
  app.on("second-instance", () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    // Agrupa todas as janelas sob UM unico icone na barra de tarefas do Windows
    // (como abas de um navegador). Precisa bater com o appId do electron-builder.
    app.setAppUserModelId("com.cargostock.app");

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
}

// Qualquer pedido real de encerramento (ex.: menu "Sair", desligar o Windows)
// marca a flag para a janela poder fechar de fato em vez de so esconder.
app.on("before-quit", () => {
  isQuitting = true;
});

// Nao encerra o app ao fechar a janela: ele permanece na bandeja do sistema.
// O encerramento acontece somente pelo menu "Sair" da bandeja.
app.on("window-all-closed", () => {});
