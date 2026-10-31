const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bridge", {
  call: (action, args) => ipcRenderer.invoke("bridge", action, args),
});
