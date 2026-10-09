// settings.js - 用户偏好持久化
const Settings = {
  // 默认值
  defaults: {
    layout: { template: 'A4_1', paper: 'A4', marginTop: 10, marginBottom: 10, marginLeft: 25, marginRight: 20, scale: 100 },
    print: { printerName: '', tray: '', copies: 1 }
  },

  async init() {
    const layout = await window.invoiceAPI.storeGet('layout');
    const print = await window.invoiceAPI.storeGet('print');
    this.layout = layout || this.defaults.layout;
    this.print = print || this.defaults.print;
  },

  async saveLayout(layout) {
    this.layout = layout;
    await window.invoiceAPI.storeSet('layout', layout);
  },

  async savePrint(print) {
    this.print = print;
    await window.invoiceAPI.storeSet('print', print);
  }
};

export default Settings;
