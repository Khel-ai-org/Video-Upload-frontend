# Video Upload System — Technical Documentation

> **Version:** 1.0.0 · **Author:** Manish Kumar (manishkr@khel.ai) · **License:** MIT  
> **Platform:** Electron desktop app (Windows / macOS / Linux)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Directory Structure](#3-directory-structure)
4. [Technology Stack](#4-technology-stack)
5. [Configuration](#5-configuration)
6. [Process Model (Electron)](#6-process-model-electron)
7. [Pages & UI Flow](#7-pages--ui-flow)
   - 7.1 [Login / Register (index.html)](#71-login--register-indexhtml)
   - 7.2 [Tournaments (tournament.html)](#72-tournaments-tournamenthtml)
   - 7.3 [Matches (matches.html)](#73-matches-matcheshtml)
   - 7.4 [Dashboard / Upload (dashboard.html)](#74-dashboard--upload-dashboardhtml)
8. [Main Process (index.js)](#8-main-process-indexjs)
   - 8.1 [Window Creation](#81-window-creation)
   - 8.2 [Upload State Machine](#82-upload-state-machine)
   - 8.3 [File Discovery (walk)](#83-file-discovery-walk)
   - 8.4 [Session Persistence Store](#84-session-persistence-store)
   - 8.5 [IPC Handlers](#85-ipc-handlers)
   - 8.6 [Upload Orchestration](#86-upload-orchestration)
9. [Upload Flow (End-to-End)](#9-upload-flow-end-to-end)
   - 9.1 [Single-Part Upload](#91-single-part-upload)
   - 9.2 [Multi-Part Upload](#92-multi-part-upload)
10. [API Reference](#10-api-reference)
11. [Data Models](#11-data-models)
12. [Preload / Context Bridge API](#12-preload--context-bridge-api)
13. [LocalStorage Keys](#13-localstorage-keys)
14. [Error Handling](#14-error-handling)
15. [Building & Packaging](#15-building--packaging)
16. [Known Considerations](#16-known-considerations)

---

## 1. Project Overview

The **Video Upload System** is a cross-platform **Electron** desktop application built for [Crik.ai](https://crik.ai). It allows cricket tournament organisers to upload large match videos to cloud storage (AWS S3) through a structured hierarchy:

```
Authentication → Tournament → Match → Upload Videos
```

Key capabilities:
- Browse and select individual video files **or** entire folder trees
- Automatic filtering to only process valid video formats
- **Chunked / multipart uploads** for files larger than a configurable threshold
- **Pause, resume, and cancel** upload sessions
- **Session persistence** — if the app is closed mid-upload, incomplete files are saved to disk and resumed automatically on the next launch

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                         │
│                                                         │
│  ┌─────────────────────┐    IPC     ┌───────────────┐   │
│  │   Renderer Process  │◄──────────►│  Main Process │   │
│  │  (HTML + JS pages)  │            │  (index.js)   │   │
│  │                     │            │               │   │
│  │  index.html         │            │  File I/O     │   │
│  │  tournament.html    │            │  Dialog API   │   │
│  │  matches.html       │            │  HTTP uploads │   │
│  │  dashboard.html     │            │  Store (JSON) │   │
│  └─────────────────────┘            └───────┬───────┘   │
│           │ window.electron                 │           │
│           │ (contextBridge)                 │           │
│  ┌────────▼────────────┐                    │           │
│  │    preload.js       │                    │           │
│  └─────────────────────┘                    │           │
└─────────────────────────────────────────────┼───────────┘
                                              │
                          ┌───────────────────▼──────────────┐
                          │   Backend API (video-storage.     │
                          │   crik.ai / localhost:5701)       │
                          │                                   │
                          │  /auth   /tournaments  /matches   │
                          │  /dashboard  /upload              │
                          └──────────────────┬────────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │    AWS S3        │
                                    │  (presigned URLs)│
                                    └─────────────────┘
```

---

## 3. Directory Structure

```
video-upload-system-frontend/
├── package.json            # App manifest, dependencies, Electron Forge config
├── package-lock.json
├── readme.md               # Quick start / feature summary
├── DOCUMENTATION.md        # ← This file
└── src/
    ├── index.js            # Main process — Electron entry point
    ├── preload.js          # Context bridge (IPC bridge to renderer)
    ├── config.js           # Global runtime config (API URL, chunk size)
    ├── index.html          # Login / Register page
    ├── tournament.html     # Tournament listing & creation page
    ├── matches.html        # Match listing & creation page
    ├── dashboard.html      # Main video upload dashboard
    ├── index.css           # Global base styles
    └── assets/             # SVG icons and image assets
        ├── logo.svg
        ├── back-arrow.svg
        ├── folder.svg
        ├── search-icon.svg
        └── ...
```

---

## 4. Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Desktop shell | **Electron 39** | Cross-platform app wrapper |
| Packaging | **Electron Forge 7** | Build, package, make installers |
| Windows installer | **Maker Squirrel** | `.exe` auto-update installer |
| HTTP client | **Axios 1.x** | REST API calls from main process |
| File upload (S3) | **Node.js `https` / `fs` streams** | Streaming multipart upload to S3 |
| Data persistence | **JSON file store** | Upload session recovery |
| MIME detection | **mime-types** | Determine video content-type |
| UI | **Vanilla HTML / CSS / JS** | No framework, Fetch API for renderer |
| Fonts | **Plus Jakarta Sans, Roboto Condensed** | Google Fonts |

---

## 5. Configuration

### `src/config.js`

This file declares two **global variables** available to every renderer page (loaded via `<script src="config.js">`).

```js
API_BASE_URL = 'https://video-storage.crik.ai'; // production
// API_BASE_URL = 'http://localhost:5701';        // local dev

CHUNK_SIZE = 500; // MB — threshold/size for each multipart chunk
```

> **Note:** The `API_BASE_URL` constant is also hardcoded in `index.js` (main process) as `'http://localhost:5701'`. The two must be kept in sync when switching environments.

### `package.json` — Forge Config

```json
"packagerConfig": {
  "name": "video_upload_system",
  "executableName": "video_upload_system"
},
"makers": [
  { "name": "@electron-forge/maker-squirrel", "config": { "name": "video_upload_system" } }
]
```

---

## 6. Process Model (Electron)

Electron runs two separate Node.js environments:

| Process | Entry | Access |
|---|---|---|
| **Main** | `src/index.js` | Full Node.js + Electron APIs, file system, native dialogs |
| **Renderer** | `src/*.html` | Sandboxed browser context, no direct Node.js access |
| **Preload** | `src/preload.js` | Bridge between main and renderer via `contextBridge` |

Communication happens over **IPC (Inter-Process Communication)**:
- Renderer → Main: `ipcRenderer.invoke()` (async request/response) or `ipcRenderer.send()` (fire-and-forget)
- Main → Renderer: registered via `ipcMain.handle()` and `ipcMain.on()`

---

## 7. Pages & UI Flow

### Navigation Flow

```
index.html  ──(login)──►  tournament.html  ──(select)──►  matches.html  ──(select)──►  dashboard.html
                                                ▲                ▲                           │
                                                └────(back)──────┴───────────(back)──────────┘
```

---

### 7.1 Login / Register (`index.html`)

**Purpose:** Authenticate the user before entering the app.

**UI Elements:**
- `#formTitle` — "Login" / "Register" heading
- `#authForm` — Email + Password fields; optional Name field (Register only)
- `#submitBtn` — Submits the form
- `#switchLink` — Toggles between Login and Register modes

**Behaviour:**
1. Default mode is **Login**.
2. Clicking `#switchLink` toggles mode in-place (no page reload), shows/hides the name field.
3. On **Register**: `POST /auth/register` with `{ name, email, password }`. Switches to Login on success.
4. On **Login**: `POST /auth/login` with `{ email, password }`. On success, stores `token` in `localStorage` and navigates to `tournament.html`. Shows an alert on invalid credentials.

**LocalStorage writes:** `token`, `email`

---

### 7.2 Tournaments (`tournament.html`)

**Purpose:** List all tournaments for the logged-in user; create new ones.

**UI Elements:**
- `#tournamentList` — 3-column card grid
- `#createBtn` — Opens the create modal
- `#modalOverlay` — Create Tournament modal
  - `#name`, `#location`, `#category` inputs
  - `#saveBtn` / `#cancelBtn`

**Behaviour:**
1. On load: `GET /tournaments` (Bearer token) → renders tournament cards.
2. Clicking a card: stores the full tournament object in `localStorage("selectedTournament")` and navigates to `matches.html`.
3. Create form: `POST /tournaments` with `{ name, location, category }`. All fields are required. Refreshes list on success.
4. Back button navigates to `index.html`.

---

### 7.3 Matches (`matches.html`)

**Purpose:** List matches under the selected tournament; create new ones.

**UI Elements:**
- `#matchList` — 3-column card grid
- `#createBtn` — Opens the create modal
- Modal fields: `#teamA`, `#teamB`, `#matchDate`, `#innings` (select: First / Second)

**Behaviour:**
1. On load: reads `selectedTournament` from `localStorage`, then `GET /matches/tournament/:id`.
2. Clicking a match card: stores the match object as `localStorage("selectedMatch")` and navigates to `dashboard.html`.
3. Create match: `POST /matches` with:
   ```json
   { "name": "TeamA vs TeamB", "inings": "1"|"2", "date": "YYYY-MM-DD", "tournament_id": "..." }
   ```
4. Back button navigates to `tournament.html`.

---

### 7.4 Dashboard / Upload (`dashboard.html`)

**Purpose:** The primary upload interface. Displays two upload zones (files and folders), a file manager table showing upload progress, and a right panel with upload speed gauges.

**Key UI Sections:**

| Section | ID / Class | Description |
|---|---|---|
| Header | `.left-divs` | Crik.ai logo + back arrow |
| Upload zones | `.upload-box-row` | Two dashed-border drop zones (files / folder) |
| File table | `.file-manager` | Hierarchical list of queued / uploading files |
| File rows | `#fileBody` | Scrollable list with filename, size, progress bar, status |
| Progress bar | `#overall-progress` | Global green progress bar |
| Right panel | `.right-panel` | Upload speed gauge (SVG), user info, controls |
| Video player | `#video-wrapper` | Overlay player for previewing selected files |
| Upload controls | Pause / Resume / Cancel buttons | Manage the active upload session |

**Upload Box Actions:**
- **Upload Files** box → calls `window.electron.selectVideos('single')` → native OS file picker (multi-select, video extensions only)
- **Upload Folder** box → calls `window.electron.selectVideos('folder')` → native OS folder picker → main process walks the entire directory tree

**Session lifecycle (renderer side):**
1. Files are selected and validated.
2. `POST /dashboard/sessions` creates a new upload session on the backend.
3. `POST /dashboard/sessions/:id/files` registers each file for the session.
4. Upload begins for each file (single-part or multipart).
5. On window close / app quit: `window.electron.notifyQuit(files, sessionId, token, matchId)` is sent so the main process persists the incomplete session to disk.

---

## 8. Main Process (`index.js`)

### 8.1 Window Creation

```js
const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800, height: 600,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
};
```

The window loads `index.html` (login page) on startup. The preload script is always injected.

---

### 8.2 Upload State Machine

A simple state enum tracks the current upload lifecycle:

```js
const UploadState = {
  IDLE:      "idle",
  UPLOADING: "uploading",
  PAUSED:    "paused",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  ERROR:     "error"
};
let uploadState = UploadState.IDLE;
```

An `AbortController` (`uploadAbortController`) can be used to cancel all in-flight Axios/fetch requests at once.

---

### 8.3 File Discovery (`walk`)

Recursively walks a directory and returns metadata for all video files found:

```js
function walk(dir, baseDir = dir) → FileMetaArray
```

**Supported extensions:** `.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`

**Each result object:**
```js
{
  path: string,           // absolute filesystem path
  name: string,           // filename
  size: number,           // bytes
  type: string,           // MIME type (via mime-types, fallback "video/mp4")
  lastModified: number,   // mtimeMs
  relativePath: string,   // relative to selected root dir
  webkitRelativePath: string  // same but with forward slashes (cross-platform)
}
```

---

### 8.4 Session Persistence Store

Upload sessions that are interrupted are saved to a JSON file so they can be resumed on next launch.

**Store location:** `{userData}/upload-store.json`

```js
function readStore()  → Session[]     // read all saved sessions
function writeStore(data: Session[])  // overwrite the store
function removeSession(session_Id)    // remove a completed session
```

**Session object schema:**
```js
{
  session_Id: string,
  files: FileMeta[],        // only files with status !== "completed"
  savedAt: string,          // human-readable timestamp
  limit: 3,                 // max concurrent (reserved)
  token: string,            // Bearer token for API auth
  matchId: string
}
```

On `app.whenReady()`, `startUpload()` is called immediately to resume any persisted sessions.

---

### 8.5 IPC Handlers

#### `ipcMain.handle('select-videos', type)`

Opens the native OS dialog.

| `type` | Dialog Mode | Returns |
|---|---|---|
| `'single'` | Multi-file select (video extensions) | `FileMeta[]` from `buildFileMeta()` |
| any other | Directory select | `FileMeta[]` from `walk()` |

#### `ipcMain.handle('read-file', filePath)`

Reads a file from disk and returns a `Buffer` (used by the renderer for small file uploads directly via `fetch`).

#### `ipcMain.handle('upload-chunk', payload)`

Streams a byte range of a file directly to an S3 presigned URL using Node.js `https.request`.

```js
payload = {
  presignedUrl: string,
  filePath: string,
  start: number,          // byte offset start (inclusive)
  end: number,            // byte offset end (exclusive)
  type: string            // Content-Type
}
// Returns: ETag string from S3 response headers
```

#### `ipcMain.on('renderer-exit', file, session_Id, token, matchId)`

Fired when the renderer signals the app is closing mid-upload.
1. Fetches the current file status list from `GET /dashboard/sessions/:id/files`.
2. Filters out already-completed files.
3. Writes the remaining files to the JSON store.
4. Calls `startUpload()` if not already uploading.

---

### 8.6 Upload Orchestration

All upload functions live in the main process and use **Axios** for API calls and Node.js streams for S3 transfers.

#### `startUpload()`
Reads persisted sessions and resumes each one by iterating `session.files` and calling `uploadInit()` for each file. Removes the session from the store when all uploads complete.

#### `SingleSignedUrl(uploadId, fileId, file, signal, token)`
Requests a single presigned URL from `POST /upload/sign`, then calls `UploadToS3()`.

#### `UploadToS3(data, fileId, file, signal, token)`
Reads the entire file into a `Buffer` using `fs.promises.readFile` and `PUT`s it to the S3 presigned URL via `fetch`. On success, calls `SaveUpload()`.

#### `MultiSignedUrl(uploadId, fileId, totalParts, file, signal, token)`
Requests batch presigned URLs from `POST /upload/batch-sign`, then calls `UploadToMultiS3()`.

#### `UploadToMultiS3(data, fileId, parts, file, signal, token)`
Iterates over all parts, calls `uploadChunkNode()` for each, collects ETags, then calls `SaveMultiUpload()`.

#### `uploadChunkNode({ presignedUrl, filePath, start, end, partNumber, type, signal })`
Streams a specific byte range of the file using `fs.createReadStream({ start, end: end-1 })` and `axios.put` to the presigned URL. Returns the ETag.

#### `SaveUpload(etag, fileId, file, partNumber, signal, token)`
Saves single-part upload metadata via `POST /upload/part`, then completes via `POST /upload/complete`.

#### `SaveMultiUpload(tags[], fileId, signal, token)`
Saves each part's metadata via `POST /upload/part` (sequentially), then completes via `POST /upload/complete`.

---

## 9. Upload Flow (End-to-End)

### 9.1 Single-Part Upload

```
Renderer                      Main Process               Backend API           AWS S3
   │                               │                         │                    │
   │──selectVideos('single')──────►│                         │                    │
   │◄──FileMeta[]──────────────────│                         │                    │
   │                               │                         │                    │
   │──POST /upload/init────────────┼────────────────────────►│                    │
   │◄──{ uploadId, totalParts:1 }──┼─────────────────────────│                    │
   │                               │                         │                    │
   │──POST /upload/sign────────────┼────────────────────────►│                    │
   │◄──{ url: presignedUrl }───────┼─────────────────────────│                    │
   │                               │                         │                    │
   │──readFile(filePath)───────────►                         │                    │
   │◄──Buffer──────────────────────│                         │                    │
   │                               │                         │                    │
   │──PUT presignedUrl (Buffer)────┼─────────────────────────┼───────────────────►│
   │◄──ETag────────────────────────┼─────────────────────────┼────────────────────│
   │                               │                         │                    │
   │──POST /upload/part────────────┼────────────────────────►│                    │
   │──POST /upload/complete────────┼────────────────────────►│                    │
```

### 9.2 Multi-Part Upload

```
Main Process               Backend API                    AWS S3
     │                         │                              │
     │──POST /upload/init──────►│                             │
     │◄──{ uploadId, totalParts: N }                          │
     │                         │                              │
     │──POST /upload/batch-sign►│ (partNumbers: [1..N])       │
     │◄──[{ url }, { url },...]─│                             │
     │                         │                              │
     │  ─── For each part ───  │                              │
     │──createReadStream(start,end)                           │
     │──PUT presignedUrl (stream)──────────────────────────► S3
     │◄──ETag────────────────────────────────────────────────│
     │                         │                              │
     │  ─── After all ETags ─  │                              │
     │──POST /upload/part (x N)►│ (sequential, one per part) │
     │──POST /upload/complete───►│                            │
```

**Chunk size:** 500 MB (configurable via `CHUNK_SIZE` in `config.js` and `index.js`)

---

## 10. API Reference

Base URL: `https://video-storage.crik.ai` (production) / `http://localhost:5701` (dev)

All authenticated endpoints require: `Authorization: Bearer <token>`

### Authentication

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/auth/register` | `{ name, email, password }` | Register new user |
| `POST` | `/auth/login` | `{ email, password }` | Login, returns `{ token }` |

### Tournaments

| Method | Path | Description |
|---|---|---|
| `GET` | `/tournaments` | List all tournaments |
| `POST` | `/tournaments` | Create tournament `{ name, location, category }` |

### Matches

| Method | Path | Description |
|---|---|---|
| `GET` | `/matches/tournament/:tournamentId` | List matches for a tournament |
| `POST` | `/matches` | Create match `{ name, inings, date, tournament_id }` |

### Dashboard / Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/dashboard/sessions/:sessionId/files` | Get file list for a session (used during resume) |

### Upload

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/upload/init` | `{ fileId, type }` | Initialise upload, returns `{ uploadId, totalParts }` |
| `POST` | `/upload/sign` | `{ fileId, partNumber: "1" }` | Get single presigned URL |
| `POST` | `/upload/batch-sign` | `{ fileId, partNumbers: [1..N] }` | Get multiple presigned URLs |
| `POST` | `/upload/part` | `{ fileId, partNumber, etag, size }` | Save uploaded part metadata |
| `POST` | `/upload/complete` | `{ fileId }` | Complete the multipart upload |

---

## 11. Data Models

### FileMeta (runtime, in-memory)

```ts
interface FileMeta {
  path: string;               // absolute local path
  name: string;               // filename
  size: number;               // bytes
  type: string;               // MIME type
  lastModified: number;       // Unix timestamp ms
  relativePath: string;       // relative to selected root
  webkitRelativePath: string; // same, forward-slashes
  fileId?: string;            // assigned by backend after session file registration
}
```

### Session (persisted to `upload-store.json`)

```ts
interface Session {
  session_Id: string;
  files: FileMeta[];
  savedAt: string;        // locale string timestamp
  limit: number;          // concurrent upload limit (unused currently)
  token: string;          // auth bearer token
  matchId: string;
}
```

### ETag record (in-memory, during multipart)

```ts
interface ETagRecord {
  PartNumber: number;
  ETag: string;
  chunkSize: number;  // bytes
}
```

---

## 12. Preload / Context Bridge API

The `preload.js` script exposes a safe `window.electron` object to the renderer:

```ts
window.electron = {
  // Open native dialog and return FileMeta[]
  selectVideos(type: 'single' | 'folder'): Promise<FileMeta[]>;

  // Read a file from disk as Buffer
  readFile(filePath: string): Promise<Buffer>;

  // Upload a byte-range chunk to a presigned S3 URL; returns ETag
  uploadChunk(payload: {
    presignedUrl: string;
    filePath: string;
    start: number;
    end: number;
    partNumber: number;
    type: string;
  }): Promise<string>;

  // Signal app is closing; save session for resume
  notifyQuit(
    files: FileMeta[],
    session_Id: string,
    token: string,
    matchId: string
  ): void;
}
```

---

## 13. LocalStorage Keys

Used by renderer pages to pass state between HTML page navigations:

| Key | Type | Set by | Read by | Description |
|---|---|---|---|---|
| `token` | `string` | `index.html` | all pages | JWT Bearer token |
| `email` | `string` | `index.html` | — | User's email address |
| `name` | `string` | `index.html` | `dashboard.html` | User's display name |
| `selectedTournament` | `JSON string` | `tournament.html` | `matches.html` | Full tournament object |
| `selectedMatch` | `JSON string` | `matches.html` | `dashboard.html` | Full match object |

---

## 14. Error Handling

| Scenario | Behaviour |
|---|---|
| Login with invalid credentials | Alert: "Invalid Credentials" |
| Tournament / match fetch failure | Inline message in the list container |
| Upload `AbortError` (cancel/pause) | `uploadState` reset to `IDLE`; error logged |
| S3 PUT returns non-2xx | `UploadToS3` throws `"Upload failed"`; caught in `startUpload` try/catch |
| Multipart part failure | Logged per-part; whole upload sequence may be retried on next app launch (via persisted session) |
| `mime-types` returns `false` | Falls back to `"video/mp4"` |
| `.DS_Store` or zero-byte files | Filtered out by the `walk()` function (only files matching video regex are included) |
| App closed mid-upload | `renderer-exit` IPC fires, incomplete session saved to store, resumed on next launch |

---

## 15. Building & Packaging

### Development

```bash
# Install dependencies
npm install

# Start the Electron app in development mode
npm start          # internally runs: electron-forge start
```

### Package (no installer)

```bash
npm run package    # electron-forge package → ./out/
```

### Make Installers

```bash
npm run make       # electron-forge make → ./out/make/
```

On **Windows**, this produces a Squirrel `.exe` installer at `./out/make/squirrel.windows/`.

> Squirrel handles silent installs and auto-updates on Windows.

### Publish

```bash
npm run publish    # electron-forge publish (requires publisher config)
```

---

## 16. Known Considerations

| Issue | Detail |
|---|---|
| **MIME type may be empty** | Some OS / file systems return no MIME type; `mime-types` uses file extension as fallback, ultimately defaulting to `"video/mp4"` |
| **macOS `.DS_Store` files** | Automatically excluded by the extension filter in `walk()` |
| **`API_BASE_URL` duplication** | The URL is defined in both `src/config.js` (renderer) and hardcoded in `src/index.js` (main process). Update **both** when switching environments |
| **Chunk size memory** | The single-part upload path (`UploadToS3`) reads the entire file into memory as a `Buffer`. For large files, multipart should always be used |
| **Concurrent uploads** | `session.limit = 3` is stored but not yet enforced; all files in a session are uploaded with `Promise.all` (fully parallel) |
| **Token persistence** | The auth token is stored in `localStorage` (renderer) and in the JSON store (main process). The token may expire between sessions |
| **No HTTPS enforcement** | The dev fallback URL uses plain HTTP (`localhost:5701`). Ensure production always uses HTTPS |
