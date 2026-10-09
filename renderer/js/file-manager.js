// file-manager.js - 文件导入与状态管理
import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';

const ALLOWED_EXT = ['.pdf', '.png'];

class FileManager {
  constructor() {
    /** @type {Array<{path:string, name:string, ext:string, buffer:ArrayBuffer, pageCount:number, width?:number, height?:number, date?:Date, dateLabel?:string}>} */
    this.files = [];
    this.selectedIndex = -1;
    this.listeners = { change: [] };
  }

  onChange(fn) { this.listeners.change.push(fn); }
  emitChange() { this.listeners.change.forEach(fn => fn(this.files, this.selectedIndex)); }

  get selected() { return this.files[this.selectedIndex]; }
  get totalPages() { return this.files.reduce((s, f) => s + (f.pageCount || 0), 0); }

  // 校验扩展名
  isValid(name) {
    const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
    return ALLOWED_EXT.includes(ext);
  }

  // 去重
  isDup(path) { return this.files.some(f => f.path === path); }

  // 从文件名提取开票日期
  // 匹配 14 位 YYYYMMDDHHMMSS 或 8 位 YYYYMMDD 或 YYYY-MM-DD / YYYY_MM_DD
  extractDate(name) {
    // 14 位时间戳（如 20261009125923）
    let m = name.match(/(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    // 8 位日期（如 20261009）
    m = name.match(/(20\d{2})(\d{2})(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    // 分隔符日期（如 2026-10-09 或 2026_10_09）
    m = name.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return null;
  }

  // 格式化日期显示
  formatDate(date) {
    if (!date) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /**
   * 批量添加文件
   * @param {File[]} fileList - 浏览器 File 对象数组（来自拖拽或 input）
   */
  async addFiles(fileList) {
    const added = [];
    for (const f of fileList) {
      if (!this.isValid(f.name)) continue;
      if (this.isDup(f.path || f.name)) continue;

      const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'));
      const buffer = await f.arrayBuffer();
      const entry = {
        path: f.path || f.name,
        name: f.name,
        ext,
        buffer,
        pageCount: 0
      };

      // 提取日期：优先文件名，兜底文件修改时间
      entry.date = this.extractDate(f.name);
      if (!entry.date && f.lastModified) {
        entry.date = new Date(f.lastModified);
      }
      entry.dateLabel = this.formatDate(entry.date);

      if (ext === '.pdf') {
        entry.pageCount = await this._getPdfPageCount(buffer);
      } else if (ext === '.png') {
        const dims = await this._getPngDims(buffer);
        entry.width = dims.width;
        entry.height = dims.height;
        entry.pageCount = 1;
      }

      this.files.push(entry);
      added.push(entry);
    }

    // 导入后自动按日期升序排序
    if (added.length > 0) {
      this.sortByDate();
    } else if (this.selectedIndex === -1 && this.files.length > 0) {
      this.selectedIndex = 0;
      this.emitChange();
    }
    return added;
  }

  // 按日期升序排序（相同日期保持原序）
  sortByDate() {
    if (this.files.length === 0) return;
    const withIdx = this.files.map((f, i) => ({ f, i }));
    withIdx.sort((a, b) => {
      const da = a.f.date ? a.f.date.getTime() : 0;
      const db = b.f.date ? b.f.date.getTime() : 0;
      if (da !== db) return da - db;
      return a.i - b.i; // 稳定排序
    });
    const oldSelected = this.selectedIndex >= 0 ? this.files[this.selectedIndex] : null;
    this.files = withIdx.map(x => x.f);
    if (oldSelected) {
      this.selectedIndex = this.files.indexOf(oldSelected);
    } else if (this.files.length > 0) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = -1;
    }
    this.emitChange();
  }

  // 用 pdfjs 获取 PDF 页数
  async _getPdfPageCount(buffer) {
    try {
      const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      const n = doc.numPages;
      // 不销毁 doc，因为 pdfjs 不支持销毁后再用，后续 preview 会重新 load
      return n;
    } catch (e) {
      console.warn('读取 PDF 页数失败:', e);
      return 1;
    }
  }

  // 获取 PNG 尺寸
  async _getPngDims(buffer) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 595, height: 842 });
      img.src = URL.createObjectURL(new Blob([buffer]));
    });
  }

  removeAt(index) {
    if (index < 0 || index >= this.files.length) return;
    this.files.splice(index, 1);
    if (this.selectedIndex >= this.files.length) this.selectedIndex = this.files.length - 1;
    if (this.selectedIndex < 0) this.selectedIndex = -1;
    this.emitChange();
  }

  moveUp(index) {
    if (index <= 0) return;
    [this.files[index - 1], this.files[index]] = [this.files[index], this.files[index - 1]];
    if (this.selectedIndex === index) this.selectedIndex = index - 1;
    else if (this.selectedIndex === index - 1) this.selectedIndex = index;
    this.emitChange();
  }

  moveDown(index) {
    if (index >= this.files.length - 1) return;
    [this.files[index], this.files[index + 1]] = [this.files[index + 1], this.files[index]];
    if (this.selectedIndex === index) this.selectedIndex = index + 1;
    else if (this.selectedIndex === index + 1) this.selectedIndex = index;
    this.emitChange();
  }

  clear() {
    this.files = [];
    this.selectedIndex = -1;
    this.emitChange();
  }

  // 选中文件（不触发重排版，只更新 UI 高亮）
  select(index) {
    if (index < -1 || index >= this.files.length) return;
    const prev = this.selectedIndex;
    this.selectedIndex = index;
    if (prev !== index) this.listeners.change.forEach(fn => fn(this.files, this.selectedIndex, 'select'));
  }
}

// 比较两个数组内容是否相同（用于 addFiles 后判断是否真的变了）


export default FileManager;
