# Video Upload System (Electron)

A desktop-based **Video Upload System** built using **Electron**, designed to handle large video uploads efficiently, including folder uploads, validation, pause/resume, and multipart uploads.

---

## 🚀 Features

* 📁 **Folder & File Upload Support** (including nested folders)
* 🎥 **Automatic Video Filtering**

  * Only valid video files are processed
  * Zero-size files are skipped
* ⏸️ ▶️ **Pause & Resume Uploads**
* 🔁 **Multipart / Chunked Upload** for large videos
* 🧵 **Sequential / Controlled Parallel Uploads**
* 🖥️ **Electron-based Desktop App** (Windows / macOS / Linux)

---

## 🧱 Tech Stack

* **Electron** – Desktop application framework
* **HTML / CSS / JavaScript** – UI & logic
* **Fetch API** – Network requests
* **Node.js** – Backend interaction

---



## 🎯 Video Validation Logic

To avoid upload and preview errors, files are filtered using **MIME type + extension fallback**:




---

## 📤 Upload Flow

1. User selects **files or folders**
2. Files are converted from `FileList` → `Array`
3. Non-video & zero-size files are filtered
4. Upload session is created on server
5. Videos are uploaded in **chunks (multipart)**
6. Upload progress is tracked
7. Upload can be **paused / resumed / cancelled**

---

## 🧪 Error Handling

* Skips unsupported files automatically
* Prevents `NotSupportedError` during video preview
* Network retry support for failed chunks

---

## 🖥️ Running the App

### Install dependencies

```bash
npm install
```

### Start Electron app

```bash
npm start
```

---

## 🔒 Security Notes


* Token-based API authentication

---

## 📌 Known Considerations

* Folder uploads on macOS include `.DS_Store` files (handled automatically)
* MIME type may be empty for some files → extension fallback is required

---

## Cricket watcher

The **Watcher** window (menu → Watcher, or Ctrl+Shift+W) runs the cricket
watcher itself, so an operator does not need the separate desktop app. It is its
own window rather than part of Auto Upload: the watcher tells scoring what
footage exists, the uploader reads scoring's rows and ships files — two jobs,
two consoles. It shows the watcher's raw terminal output plus counts of balls
detected, posts accepted and posts failed, and it spawns the PyInstaller binary
from the watcher project rather than reimplementing it, posting to
`http://<Scoring IP>:3000/api/video_data` plus `:5500/video_data`.

Closing the Watcher window stops the watcher.

The 29 MB binary is not in git. Before packaging, copy it in:

```bash
cp ~/Desktop/watcher/dist/cricket-watcher resources/cricket-watcher
```

`packagerConfig.extraResource` ships it next to the app; in development the same
`resources/` copy is used. If it is missing, Start watcher offers a file picker
and remembers the path in `auto-upload-settings.json`.
