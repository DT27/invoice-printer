// print-manager.js - 打印队列与管理
class PrintManager {
  constructor() {
    this.printers = [];
    this.queue = [];
    this.isPrinting = false;
    this.listeners = { log: [] };
  }

  onLog(fn) { this.listeners.log.push(fn); }
  emitLog(level, msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${time}] ${msg}`;
    this.listeners.log.forEach(fn => fn(line, level));
  }

  // 刷新打印机列表
  async refreshPrinters() {
    this.printers = await window.invoiceAPI.getPrinters();
    return this.printers;
  }

  // 打印机列表（供 UI 渲染）
  getPrinterNames() {
    return this.printers.map(p => ({ name: p.name, displayName: p.displayName || p.name }));
  }

  /**
   * 执行打印
   * @param {Object} opts
   * @param {string[]} opts.images - 每页渲染好的 dataURL 图片
   * @param {string} opts.paper - 纸张 'A4' | 'A5'
   * @param {string} opts.printerName - 打印机名（空=系统默认）
   * @param {number} opts.copies - 份数
   */
  async print({ images, paper, printerName, copies }) {
    if (this.isPrinting) {
      this.emitLog('warn', '当前有打印任务在执行，请稍候');
      return;
    }
    if (!images || images.length === 0) {
      this.emitLog('error', '没有可打印内容');
      return;
    }

    this.isPrinting = true;
    this.emitLog('info', `开始打印 ${images.length} 页 → 打印机: ${printerName || '系统默认'}，份数: ${copies}`);

    try {
      const res = await window.invoiceAPI.executePrint({
        images,
        paper: paper || 'A4',
        printerName: printerName || '',
        copies: copies || 1
      });
      if (res.ok) {
        this.emitLog('success', '打印任务已提交');
      } else {
        this.emitLog('error', '打印失败: ' + (res.error || '未知错误'));
      }
    } catch (e) {
      this.emitLog('error', '打印异常: ' + e.message);
    } finally {
      this.isPrinting = false;
    }
  }

  async cancel() {
    this.emitLog('warn', '正在尝试取消...');
    await window.invoiceAPI.cancelPrint();
  }
}

export default PrintManager;
