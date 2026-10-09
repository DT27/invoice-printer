// main.js - Electron 主进程
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { layoutInvoices } = require('./layout-engine.cjs');

// electron-store v11 是 ESM，需要动态导入
let Store = null;
let store = null;

async function initStore() {
  const mod = await import('electron-store');
  Store = mod.default;
  store = new Store({
    name: 'invoice-printer-config',
    defaults: {
      layout: { template: 'A4_1', paper: 'A4', marginTop: 10, marginBottom: 10, marginLeft: 25, marginRight: 20, scale: 100 },
      print: { printerName: '', tray: '', copies: 1 }
    }
  });
}

let mainWindow = null;
let printerCache = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f5f6fa',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#2d3436',
      symbolColor: '#ffffff',
      height: 30
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // mainWindow.webContents.openDevTools();
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function refreshPrinters() {
  printerCache = [];
  try {
    if (typeof app.getPrinters === 'function') {
      const result = app.getPrinters();
      printerCache = Array.isArray(result) ? result : (result && typeof result.then === 'function' ? await result : []);
    }
    if ((!printerCache || printerCache.length === 0) && mainWindow) {
      const wc = mainWindow.webContents;
      if (wc && typeof wc.getPrinters === 'function') {
        const result = wc.getPrinters();
        printerCache = Array.isArray(result) ? result : (result && typeof result.then === 'function' ? await result : []);
      }
    }
  } catch (e) {
    console.warn('刷新打印机列表失败:', e.message);
  }
  return printerCache;
}

app.whenReady().then(async () => {
  await initStore();
  createWindow();
  setTimeout(async () => { await refreshPrinters(); }, 1500);

  app.on('update-printers', async () => { await refreshPrinters(); });
  setInterval(async () => { await refreshPrinters(); }, 30000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ========== IPC 通道 ==========

ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow?.close());

// 打印机
ipcMain.handle('printer:getAll', async () => {
  await refreshPrinters();
  return printerCache;
});

// 排版（主进程执行 pdf-lib）
ipcMain.handle('layout:invoices', async (event, payload) => {
  try {
    // payload.files 里的 buffer 是 Array.from(ArrayBuffer) 转来的普通数组
    const files = payload.files.map(f => ({
      ...f,
      buffer: Buffer.from(f.buffer)
    }));
    const bytes = await layoutInvoices({
      files,
      template: payload.template,
      paper: payload.paper,
      margins: payload.margins,
      scale: payload.scale
    });
    return { ok: true, bytes: Array.from(bytes) };
  } catch (e) {
    console.error('排版失败:', e);
    return { ok: false, error: e.message };
  }
});

// 打印：接收每页渲染好的图片（dataURL），生成纯图片 HTML 打印，
// 避免 Chromium 内置 PDF 查看器 UI（工具栏/侧边栏）被打进去
ipcMain.handle('print:execute', async (event, { images, paper, printerName, copies }) => {
  if (!images || images.length === 0) return { ok: false, error: '没有可打印内容' };

  // 建临时目录：图片 + HTML
  const dir = path.join(app.getPath('temp'), `invoice-print-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });

    const paperMm = paper === 'A5' ? [148, 210] : [210, 297];
    const imgTags = [];
    images.forEach((dataUrl, i) => {
      const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!m) throw new Error(`第 ${i + 1} 页图片格式无效`);
      const file = path.join(dir, `page-${i}.${m[1].toLowerCase()}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      imgTags.push(`<img src="${'file:///' + file.replace(/\\/g, '/')}">`);
    });

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${paperMm[0]}mm ${paperMm[1]}mm; margin: 0; }
html, body { margin: 0; padding: 0; height: 100%; }
img {
  display: block;
  width: ${paperMm[0]}mm;
  height: ${paperMm[1]}mm;
  object-fit: contain;
  object-position: center;
  break-after: page;
}
img:last-child { break-after: auto; }
</style></head><body>${imgTags.join('')}</body></html>`;
    const htmlFile = path.join(dir, 'print.html');
    fs.writeFileSync(htmlFile, html);

    return await new Promise((resolve) => {
      const printOptions = {
        printerName: printerName || '',
        copies: copies || 1,
        marginsType: 0,          // 用 @page CSS 的 margin:0 控制，避免双重边距
        printBackground: true,
        pageSize: paper === 'A5' ? 'A5' : 'A4',
        documentTitle: '发票打印'
      };

      const printWin = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false }
      });

      const cleanup = () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      };

      printWin.loadURL('file:///' + htmlFile.replace(/\\/g, '/')).catch(e => {
        resolve({ ok: false, error: '打印页加载失败: ' + e.message });
        printWin.close();
        cleanup();
      });

      printWin.webContents.on('did-finish-load', () => {
        setTimeout(() => {
          printWin.webContents.print(printOptions, (success, errorType) => {
            printWin.close();
            cleanup();
            if (success) resolve({ ok: true });
            else resolve({ ok: false, error: errorType || '打印失败' });
          });
        }, 500);
      });

      printWin.webContents.on('did-fail-load', (e, code, desc) => {
        resolve({ ok: false, error: '打印页加载失败: ' + desc });
        printWin.close();
        cleanup();
      });
    });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('print:cancel', () => {
  return { ok: true };
});

// 设置持久化
ipcMain.handle('store:get', (event, key) => store ? store.get(key) : null);
ipcMain.handle('store:set', (event, key, value) => { if (store) store.set(key, value); });
ipcMain.handle('store:delete', (event, key) => { if (store) store.delete(key); });
