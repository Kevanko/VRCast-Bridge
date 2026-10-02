'use strict';
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vrcastShell', { regionDone: rect => ipcRenderer.send('region-done', rect) });

// Файлы, брошенные в окно, уходят в очередь по настоящему пути (как в Windows-оболочке).
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragover', event => { if (hasFiles(event)) { event.preventDefault(); event.stopPropagation(); } }, true);
window.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault(); event.stopPropagation();
  const paths = [...event.dataTransfer.files].map(file => webUtils.getPathForFile(file)).filter(Boolean);
  if (paths.length) webFrame.executeJavaScript(`window.addLocalFiles(${JSON.stringify(paths)})`);
}, true);
