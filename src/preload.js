// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  notifyQuit: (file , session_Id , token , matchId) => ipcRenderer.send("renderer-exit",file ,  session_Id, token, matchId),
  selectVideos: (type) => ipcRenderer.invoke('select-videos' , type),
   readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
   uploadChunk: (payload) =>
    ipcRenderer.invoke("upload-chunk", payload)
});

