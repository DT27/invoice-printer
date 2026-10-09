// preload.js - 渲染进程与主进程之间的安全桥接
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('invoiceAPI', {
  // 窗口控制
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),

  // 打印机
  getPrinters: () => ipcRenderer.invoke('printer:getAll'),

  // 排版（主进程 pdf-lib）
  layoutInvoices: (payload) => ipcRenderer.invoke('layout:invoices', payload),

  // 打印
  executePrint: (payload) => ipcRenderer.invoke('print:execute', payload),
  cancelPrint: () => ipcRenderer.invoke('print:cancel'),

  // 设置持久化
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),
  storeDelete: (key) => ipcRenderer.invoke('store:delete', key)
});
