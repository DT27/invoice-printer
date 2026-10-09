// app.js - 渲染进程主入口（只做 UI + 预览，排版移到主进程）
import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import Settings from './settings.js';
import FileManager from './file-manager.js';
import PrintManager from './print-manager.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

// ============ DOM ============
const $ = id => document.getElementById(id);
const dom = {
  btnMin: $('btn-min'), btnMax: $('btn-max'), btnClose: $('btn-close'),
  dropZone: $('drop-zone'), fileInput: $('file-input'),
  btnAdd: $('btn-add'), btnSortDate: $('btn-sort-date'), btnClear: $('btn-clear'),
  fileList: $('file-list'), fileCount: $('file-count'),
  totalPages: $('total-pages'),
  canvas: $('preview-canvas'), previewEmpty: $('preview-empty'),
  btnFit: $('btn-fit'), btnZoomOut: $('btn-zoom-out'), btnZoomIn: $('btn-zoom-in'),
  zoomLevel: $('zoom-level'),
  btnPrev: $('btn-prev'), btnNext: $('btn-next'), pageNav: $('page-nav'),
  previewPageInfo: $('preview-page-info'),
  template: $('template'), paper: $('paper'),
  marginTop: $('margin-top'), marginRight: $('margin-right'),
  marginBottom: $('margin-bottom'), marginLeft: $('margin-left'),
  scale: $('scale'), scaleValue: $('scale-value'),
  printer: $('printer'), copies: $('copies'),
  btnPreviewLayout: $('btn-preview-layout'),
  btnPrint: $('btn-print'), btnCancel: $('btn-cancel'),
  statusLog: $('status-log')
};

// ============ 状态 ============
const fm = new FileManager();
const pm = new PrintManager();
let currentLayoutDoc = null;
let currentLayoutPage = 1;
let previewZoom = 1.0;

// ============ 工具 ============
function log(msg, level = 'info') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const div = document.createElement('div');
  div.className = 'log-' + level;
  div.textContent = `[${time}] ${msg}`;
  dom.statusLog.appendChild(div);
  dom.statusLog.scrollTop = dom.statusLog.scrollHeight;
  while (dom.statusLog.children.length > 200) dom.statusLog.removeChild(dom.statusLog.firstChild);
}

function getSettings() {
  return {
    template: dom.template.value,
    paper: dom.paper.value,
    margins: {
      top: +dom.marginTop.value || 0,
      right: +dom.marginRight.value || 0,
      bottom: +dom.marginBottom.value || 0,
      left: +dom.marginLeft.value || 0
    },
    scale: +dom.scale.value || 100
  };
}

// ============ 初始化 ============
async function init() {
  await Settings.init();
  await pm.refreshPrinters();

  dom.template.value = Settings.layout.template;
  dom.paper.value = Settings.layout.paper;
  dom.marginTop.value = Settings.layout.marginTop;
  dom.marginBottom.value = Settings.layout.marginBottom;
  dom.marginLeft.value = Settings.layout.marginLeft;
  dom.marginRight.value = Settings.layout.marginRight;
  dom.scale.value = Settings.layout.scale;
  dom.scaleValue.textContent = Settings.layout.scale + '%';
  dom.copies.value = Settings.print.copies;

  const printers = pm.getPrinterNames();
  for (const p of printers) {
    const opt = document.createElement('option');
    opt.value = p.name; opt.textContent = p.displayName;
    dom.printer.appendChild(opt);
  }
  if (Settings.print.printerName) dom.printer.value = Settings.print.printerName;

  log('应用已就绪');
  bindEvents();
  renderFileList();
  refreshPreview();
}

// ============ 事件 ============
function bindEvents() {
  dom.btnMin.addEventListener('click', () => window.invoiceAPI?.minimize?.());
  dom.btnMax.addEventListener('click', () => window.invoiceAPI?.maximize?.());
  dom.btnClose.addEventListener('click', () => window.invoiceAPI?.close?.());

  ['dragover', 'dragenter'].forEach(ev => dom.dropZone.addEventListener(ev, e => {
    e.preventDefault(); dom.dropZone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(ev => dom.dropZone.addEventListener(ev, e => {
    e.preventDefault(); dom.dropZone.classList.remove('drag-over');
  }));
  dom.dropZone.addEventListener('drop', async e => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    log(`拖拽 ${files.length} 个文件`);
    await fm.addFiles(files);
  });

  dom.btnAdd.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    await fm.addFiles(files);
    dom.fileInput.value = '';
  });

  dom.btnClear.addEventListener('click', () => { fm.clear(); log('已清空文件列表'); });

  dom.btnSortDate.addEventListener('click', () => {
    if (fm.files.length === 0) { log('文件列表为空', 'warn'); return; }
    fm.sortByDate();
    log(`已按开票日期排序（共 ${fm.files.length} 个文件）`);
  });

  fm.onChange((_files, _idx, event) => {
    renderFileList();
    if (event !== 'select') refreshPreview();
  });

  dom.btnZoomIn.addEventListener('click', () => { previewZoom = Math.min(4.0, previewZoom + 0.1); renderLayoutPage(); });
  dom.btnZoomOut.addEventListener('click', () => { previewZoom = Math.max(0.1, previewZoom - 0.1); renderLayoutPage(); });
  dom.btnFit.addEventListener('click', () => {
    const wrapper = dom.canvas.parentElement;
    if (!currentLayoutDoc) return;
    currentLayoutDoc.getPage(currentLayoutPage).then(page => {
      const vp = page.getViewport({ scale: 1.0 });
      previewZoom = Math.min((wrapper.clientWidth - 40) / vp.width, (wrapper.clientHeight - 40) / vp.height);
      previewZoom = Math.round(previewZoom * 10) / 10;
      renderLayoutPage();
    });
  });
  dom.btnPrev.addEventListener('click', () => { if (currentLayoutPage > 1) { currentLayoutPage--; renderLayoutPage(); } });
  dom.btnNext.addEventListener('click', () => {
    if (currentLayoutDoc && currentLayoutPage < currentLayoutDoc.numPages) { currentLayoutPage++; renderLayoutPage(); }
  });

  const settingsInputs = [
    dom.template, dom.paper,
    dom.marginTop, dom.marginBottom, dom.marginLeft, dom.marginRight,
    dom.scale
  ];
  settingsInputs.forEach(el => {
    const ev = el.tagName === 'SELECT' || el.type === 'range' ? 'input' : 'change';
    el.addEventListener(ev, () => {
      if (el === dom.scale) dom.scaleValue.textContent = dom.scale.value + '%';
      saveSettings();
      refreshPreview();
    });
  });

  [dom.printer, dom.copies].forEach(el => el.addEventListener('change', saveSettings));

  dom.btnPreviewLayout.addEventListener('click', () => refreshPreview());

  dom.btnPrint.addEventListener('click', async () => {
    if (fm.files.length === 0) { log('请先添加发票文件', 'warn'); return; }
    dom.btnPrint.disabled = true;
    dom.btnCancel.disabled = false;
    try {
      const bytes = await refreshPreview();
      if (!bytes || !currentLayoutDoc) { log('排版生成失败', 'error'); return; }
      log('正在渲染打印页...');
      const images = await renderLayoutToImages();
      if (!images) { log('打印页渲染失败', 'error'); return; }
      await pm.print({
        images,
        paper: dom.paper.value,
        printerName: dom.printer.value,
        copies: +dom.copies.value || 1
      });
    } finally {
      dom.btnPrint.disabled = false;
      dom.btnCancel.disabled = true;
    }
  });

  dom.btnCancel.addEventListener('click', () => pm.cancel());

  pm.onLog((line, level) => {
    // line 已带时间戳，直接写入日志面板
    const div = document.createElement('div');
    div.className = 'log-' + level;
    div.textContent = line;
    dom.statusLog.appendChild(div);
    dom.statusLog.scrollTop = dom.statusLog.scrollHeight;
  });
}

function renderFileList() {
  dom.fileCount.textContent = fm.files.length;
  dom.totalPages.textContent = fm.totalPages;
  dom.fileList.innerHTML = '';
  fm.files.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'file-item' + (i === fm.selectedIndex ? ' selected' : '');
    item.innerHTML = `
      <div class="file-idx">${i + 1}</div>
      <div class="file-icon">${f.ext === '.pdf' ? '📄' : '🖼'}</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(f.name)}</div>
        <div class="file-meta">${f.dateLabel ? '📅 ' + f.dateLabel + ' · ' : ''}${f.ext === '.pdf' ? f.pageCount + ' 页' : (f.width + '×' + f.height)}</div>
      </div>
      <button class="file-del" title="删除">✕</button>
    `;
    item.addEventListener('click', e => {
      if (e.target.classList.contains('file-del')) fm.removeAt(i);
      else fm.select(i);
    });
    dom.fileList.appendChild(item);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function saveSettings() {
  const s = getSettings();
  await Settings.saveLayout(s);
  await Settings.savePrint({
    printerName: dom.printer.value, tray: '', copies: +dom.copies.value || 1
  });
}

// 调用主进程排版 + 渲染预览，返回 PDF bytes
async function refreshPreview() {
  if (fm.files.length === 0) {
    currentLayoutDoc = null;
    dom.previewEmpty.style.display = 'block';
    dom.canvas.width = 0; dom.canvas.height = 0;
    return null;
  }
  try {
    dom.previewEmpty.style.display = 'none';
    const s = getSettings();
    const res = await window.invoiceAPI.layoutInvoices({
      files: fm.files.map(f => ({
        path: f.path, name: f.name, ext: f.ext,
        buffer: Array.from(new Uint8Array(f.buffer))
      })),
      template: s.template, paper: s.paper,
      margins: s.margins, scale: s.scale
    });

    if (!res.ok) throw new Error(res.error || '排版失败');
    const bytes = new Uint8Array(res.bytes);
    currentLayoutDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    currentLayoutPage = 1;
    log(`排版完成，共 ${currentLayoutDoc.numPages} 页`, 'success');
    renderLayoutPage();
    return bytes;
  } catch (e) {
    log('排版失败: ' + e.message, 'error');
    console.error(e);
    return null;
  }
}

function renderLayoutPage() {
  if (!currentLayoutDoc) return;
  currentLayoutDoc.getPage(currentLayoutPage).then(page => {
    const vp = page.getViewport({ scale: previewZoom });
    dom.canvas.width = Math.floor(vp.width);
    dom.canvas.height = Math.floor(vp.height);
    page.render({ canvasContext: dom.canvas.getContext('2d'), viewport: vp }).promise.then(() => {
      dom.zoomLevel.textContent = Math.round(previewZoom * 100) + '%';
      dom.pageNav.textContent = `${currentLayoutPage} / ${currentLayoutDoc.numPages}`;
      dom.previewPageInfo.textContent = `排版预览 · 第 ${currentLayoutPage} / ${currentLayoutDoc.numPages} 页`;
      dom.btnPrev.disabled = currentLayoutPage <= 1;
      dom.btnNext.disabled = currentLayoutPage >= currentLayoutDoc.numPages;
    });
  });
}

// 把排版 PDF 的每一页渲染成高分辨率图片（约 200 DPI），供打印使用
async function renderLayoutToImages() {
  if (!currentLayoutDoc) return null;
  const urls = [];
  const scale = 200 / 72; // pdfjs 默认 72 DPI → 200 DPI
  for (let i = 1; i <= currentLayoutDoc.numPages; i++) {
    const page = await currentLayoutDoc.getPage(i);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height); // JPEG 无透明通道，铺白底
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    urls.push(c.toDataURL('image/jpeg', 0.92));
  }
  return urls;
}

init();
