// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  notifyQuit: (file, session_Id, token, matchId) => ipcRenderer.send("renderer-exit", file, session_Id, token, matchId),
  selectVideos: (type) => ipcRenderer.invoke('select-videos', type),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  resolveDrop: (paths) => ipcRenderer.invoke('resolve-drop', paths),
  uploadChunk: (payload) =>
   ipcRenderer.invoke("upload-chunk", payload),

  // Auto-upload: the pulls root the watcher writes into, and disk probing for
  // the relative paths scoring hands back in video_id.
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (patch) => ipcRenderer.invoke("set-settings", patch),
  pickPullsFolder: () => ipcRenderer.invoke("pick-pulls-folder"),
  probeVideos: (root, relativePaths) =>
    ipcRenderer.invoke("probe-videos", { root, relativePaths }),

  // Playback: probe a video and, only if it is HEVC, transcode a cached H.264
  // preview Chromium can actually decode.
  previewVideo: (url, cacheKey) =>
    ipcRenderer.invoke("preview-video", { url, cacheKey }),

  // The cricket watcher, spawned by the main process so its log can live in
  // this window and it dies with it.
  startWatcher: (options) => ipcRenderer.invoke("watcher-start", options || {}),
  stopWatcher: () => ipcRenderer.invoke("watcher-stop"),
  watcherStatus: () => ipcRenderer.invoke("watcher-status"),
  pickWatcherBinary: () => ipcRenderer.invoke("pick-watcher-binary"),
  onWatcherLog: (handler) =>
    ipcRenderer.on("watcher-log", (_event, payload) => handler(payload)),
  // Scoring integration
  openScoring: () => ipcRenderer.invoke("open-scoring"),

  onWatcherExit: (handler) =>
    ipcRenderer.on("watcher-exit", (_event, payload) => handler(payload))
});

