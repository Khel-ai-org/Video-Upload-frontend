const { app, BrowserWindow  ,  dialog , Menu } = require('electron');
const path = require('node:path');
const fs = require("fs");
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const http = require('http');
const mime = require("mime-types");
const { URL } = require('url');
const https = require('https');
const API_BASE_URL = 'http://localhost:5701';
const CHUNK_SIZE = 500; // in MB
// The app's entry point: Association's login screen.
const ASSOCIATION_PORT = 3000;
const axios = require('axios');
let uploadAbortController = null;
const UploadState = {
  IDLE: "idle",
  UPLOADING: "uploading",
  PAUSED: "paused",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  ERROR: "error"
};
let uploadState = UploadState.IDLE;


// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}
const STORE_PATH = path.join(app.getPath("userData"), "upload-store.json");
     function readStore() {
  if (!fs.existsSync(STORE_PATH)) return [];
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}
async function uploadToS3FromPath(presignedUrl, fileMeta) {
  return new Promise((resolve, reject) => {
    const url = new URL(presignedUrl);
    const stream = fs.createReadStream(fileMeta.path);

    const req = https.request({
      method: 'PUT',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': fileMeta.type,
        'Content-Length': fileMeta.size
      }
    }, res => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(res.headers.etag);
      } else {
        reject(new Error(`Upload failed: ${res.statusCode}`));
      }
    });

    stream.pipe(req);
    stream.on('error', reject);
  });
}
let mainWindow = null;
const createWindow = () => {
  // Create the browser window.
   mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL('data:text/html,<html><body style="background:%230F172A;color:%23F95320;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;margin:0;"><h2>Loading Khel Association...</h2></body></html>');

  // The entry point is Association's own login. Scoring is started here too,
  // not just Association — login's own success handler does a plain
  // window.location.href to the scoring server directly (no window open call
  // on this side involved), so it must already be up by the time that happens.
  (async () => {
    const [associationReady] = await Promise.all([
      ensureAssociationServer(),
      ensureScoringServer(),
    ]);

    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (associationReady) {
      mainWindow.loadURL(`http://localhost:${ASSOCIATION_PORT}/login`);
    } else {
      mainWindow.loadURL('data:text/html,<html><body style="background:%230F172A;color:%23EF4444;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;margin:0;"><h2>Could Not Connect to Association Server</h2></body></html>');
    }
  })();

  mainWindow.webContents.on('did-navigate', () => buildAppMenu());

  mainWindow.on('closed', () => {
    mainWindow = null;
    // These windows have no `parent` (so they can fullscreen/minimize on
    // their own without macOS tying them into the main window's Space) —
    // closing them here on the main window's own close event is what keeps
    // them from silently outliving it instead, since window-all-closed
    // doesn't quit the app on macOS.
    if (autoUploadWindow && !autoUploadWindow.isDestroyed()) autoUploadWindow.close();
    if (watcherWindow && !watcherWindow.isDestroyed()) watcherWindow.close();
  });
  // Open the DevTools.
  // mainWindow.webContents.openDevTools();
};


// ---------------------------------------------------------------------------
// Application menu
//
// Auto upload gets its own window rather than replacing whatever the main
// window is showing. It owns the fetch/watcher loop, so keeping it in a window
// of its own means it keeps scanning and uploading while the operator carries
// on with grounds, matches and manual uploads next to it.
// ---------------------------------------------------------------------------
let autoUploadWindow = null;

function openAutoUploadWindow() {
  // One window only: a second one would run a second scan loop against the
  // same pulls folder and upload every ball twice.
  if (autoUploadWindow && !autoUploadWindow.isDestroyed()) {
    if (autoUploadWindow.isMinimized()) autoUploadWindow.restore();
    autoUploadWindow.focus();
    return;
  }

  autoUploadWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Auto Upload',
    // Independent, not a child of mainWindow — a parent/child relationship
    // ties them into the same macOS Space, so fullscreening this one pulled
    // the main window along with it. mainWindow's own 'closed' handler
    // closes this window explicitly instead, to still bound its lifetime.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  autoUploadWindow.loadFile(path.join(__dirname, 'auto-upload.html'));

  autoUploadWindow.on('closed', () => {
    autoUploadWindow = null;
  });
}

// Pages reachable without being logged in: while one of these is showing there
// is no token yet, so a menu item could only open a panel that fails every
// request it makes.
const PRE_LOGIN_PAGES = [
  'index.html', 'verify.html', 'forgot-password.html',
  'verify-reset.html', 'reset-password.html',
];

function isLoggedIn() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const page = path.basename(new URL(mainWindow.webContents.getURL()).pathname);
  return page !== '' && !PRE_LOGIN_PAGES.includes(page);
}

let watcherWindow = null;

function openWatcherWindow() {
  if (watcherWindow && !watcherWindow.isDestroyed()) {
    if (watcherWindow.isMinimized()) watcherWindow.restore();
    watcherWindow.focus();
    return;
  }

  watcherWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Watcher',
    // Independent, same reason as Auto Upload — see mainWindow's 'closed'
    // handler for how its lifetime still gets bounded to the main window.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  watcherWindow.loadFile(path.join(__dirname, 'watcher.html'));

  watcherWindow.on('closed', () => {
    watcherWindow = null;
    // Closing the console closes the watcher: a tracker with no window showing
    // its output is exactly the situation this window exists to prevent.
    stopWatcher();
  });
}

let scoringWindow = null;
let scoringProcess = null;

function isScoringRunning(port = 3001) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}`, (res) => {
      resolve(true);
      req.destroy();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureScoringServer() {
  const running = await isScoringRunning(3001);
  if (running) return true;

  console.log("🚀 Starting Scoring server on port 3001...");
  
  const embeddedPath = path.join(__dirname, '..', 'resources', 'scoring-build');
  const siblingPath = path.join(__dirname, '..', '..', 'Scoring--frontend');
  
  let targetPath = null;
  let cmd = 'node';
  let args = ['server.js'];
  
  if (fs.existsSync(path.join(embeddedPath, 'server.js'))) {
    targetPath = embeddedPath;
    cmd = 'node';
    args = ['server.js'];
  } else if (fs.existsSync(siblingPath)) {
    targetPath = siblingPath;
    cmd = './node_modules/.bin/next';
    args = ['start', '-p', '3001'];
  }

  if (targetPath) {
    scoringProcess = spawn(cmd, args, {
      cwd: targetPath,
      shell: true,
      env: { ...process.env, PORT: '3001' },
      stdio: 'ignore'
    });

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (await isScoringRunning(3001)) return true;
    }
  }
  return false;
}

let associationProcess = null;

async function ensureAssociationServer() {
  const running = await isScoringRunning(ASSOCIATION_PORT);
  if (running) return true;

  console.log(`🚀 Starting Association server on port ${ASSOCIATION_PORT}...`);

  const embeddedPath = path.join(__dirname, '..', 'resources', 'association-build');
  const siblingPath = path.join(__dirname, '..', '..', 'Association-Frontend');

  let targetPath = null;
  let cmd = 'node';
  let args = ['server.js'];

  if (fs.existsSync(path.join(embeddedPath, 'server.js'))) {
    targetPath = embeddedPath;
    cmd = 'node';
    args = ['server.js'];
  } else if (fs.existsSync(siblingPath)) {
    targetPath = siblingPath;
    cmd = './node_modules/.bin/next';
    args = ['start', '-p', String(ASSOCIATION_PORT)];
  }

  if (targetPath) {
    associationProcess = spawn(cmd, args, {
      cwd: targetPath,
      shell: true,
      env: { ...process.env, PORT: String(ASSOCIATION_PORT) },
      stdio: 'ignore'
    });

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (await isScoringRunning(ASSOCIATION_PORT)) return true;
    }
  }
  return false;
}

async function openScoringWindow() {
  if (scoringWindow && !scoringWindow.isDestroyed()) {
    if (scoringWindow.isMinimized()) scoringWindow.restore();
    scoringWindow.focus();
    return;
  }

  scoringWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    title: 'Scoring Dashboard',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    }
  });

  scoringWindow.loadURL('data:text/html,<html><body style="background:%230F172A;color:%23F95320;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;margin:0;"><h2>Loading Khel Scoring Dashboard...</h2><p style="color:%2394A3B8;font-size:14px;">Connecting to http://localhost:3001</p></body></html>');

  const ready = await ensureScoringServer();

  if (scoringWindow && !scoringWindow.isDestroyed()) {
    if (ready) {
      scoringWindow.loadURL('http://localhost:3001');
    } else {
      scoringWindow.loadURL('data:text/html,<html><body style="background:%230F172A;color:%23EF4444;display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;margin:0;"><h2>Could Not Connect to Scoring Server</h2><p style="color:%2394A3B8;font-size:14px;">Please ensure Scoring--frontend is started on port 3001.</p></body></html>');
    }
  }

  scoringWindow.on('closed', () => {
    scoringWindow = null;
  });
}

function buildAppMenu() {
  if (!isLoggedIn()) {
    Menu.setApplicationMenu(null);
    return;
  }

  const items = [
    {
      label: 'Use Scoring',
      accelerator: 'CmdOrCtrl+Shift+S',
      // mainWindow already runs the Association login -> Scoring dashboard
      // flow, so this just brings it forward rather than opening a second,
      // separately-authenticated window straight into Scoring.
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      },
    },
    {
      label: 'Auto Upload',
      accelerator: 'CmdOrCtrl+Shift+U',
      click: () => openAutoUploadWindow(),
    },
    {
      label: 'Watcher',
      accelerator: 'CmdOrCtrl+Shift+W',
      click: () => openWatcherWindow(),
    },
  ];

  // macOS gives the first menu to the app itself and ignores a click on a
  // top-level item, so there the two live in a submenu instead.
  const template = process.platform === 'darwin'
    ? [{ role: 'appMenu' }, { label: 'Go', submenu: items }]
    : items;

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}



// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
  startUpload();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
const { ipcMain } = require("electron");

function walk(dir, baseDir = dir) {
  let files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walk(fullPath, baseDir));
    } else if (/\.(mp4|mov|mkv|avi|webm)$/i.test(entry.name)) {
      const stat = fs.statSync(fullPath);

      files.push({
        path: fullPath,
        name: entry.name,
        size: stat.size,
        type: mime.lookup(entry.name) || "video/mp4",
        lastModified: stat.mtimeMs,
        relativePath: path.relative(baseDir, fullPath),
         webkitRelativePath: path
    .relative(baseDir, fullPath)
    .replace(/\\/g, "/") // important
       
      });
    }
  }

  return files;
}
async function startUpload() {
  try {
  const store = readStore();
  console.log('Starting upload for stored sessions:', store);
  
  for (const session of store) {
    console.log(`Resuming upload for session: ${session.session_Id}`);
   uploadAbortController = new AbortController();
      const signal = uploadAbortController.signal;
       uploadState = UploadState.UPLOADING;
       const files = session.files;
        const uploadPromises = files.map(async (file , index) => {
        
    
      
    
    
    
    
   
      // const res = await axios.post(`${API_BASE_URL}/upload/init`, {
      //   method: "POST",
      //   headers: {
      //     "Content-Type": "application/json",
      //     "Authorization": `Bearer ${session.token}`
      //   },
      //   body: JSON.stringify({
      //     fileId: file.fileId,
      //      type: file.type
      //   }),
      //   signal: signal
      console.log('ppppppppppppppppp' , 
         { // data/body
    fileId: file.fileId,
    type: file.type,
  } , session.token
      );
      // })
      const res = await axios.post(
  `${API_BASE_URL}/upload/init`,
  { // data/body
    fileId: file.fileId,
    type: file.type,
  },
  { // config
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.token}`
    },
    signal: signal,
  }
);
      console.log(res);
      const data = res.data;

       console.log("Server response:", data);
      if (data.totalParts == 1) {
      return  await  SingleSignedUrl(data.uploadId, file.fileId , file , signal , session.token);
      } else {
      return  await  MultiSignedUrl(data.uploadId, file.fileId, data.totalParts, file , signal , session.token);
      }
      // return true; 
  
  });

  await Promise.all(uploadPromises);
  removeSession(session.session_Id);
    console.log(`Upload resumed for session: ${session.session_Id}`);
    uploadState = UploadState.IDLE;
    // Here you would implement the logic to resume uploads
    // for each file in the session.files array.
  }
} catch (error) {
   uploadState = UploadState.IDLE;
  console.error("Error during upload resumption:", error);  
}
}





async function MultiSignedUrl(id, fileId, parts, file , signal , token) {
      const arr = Array.from({ length: parts }, (_, i) => i + 1);
      const res = await axios.post(`${API_BASE_URL}/upload/batch-sign`, 
       {
         fileId: fileId,
          partNumbers: arr
       } ,
       { headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          fileId: fileId,
          partNumbers: arr
        }),   
        signal: signal
      })
      console.log(res);

      const data = res.data;
      // status.textContent = "✅ Upload successful";
      console.log("Server response:", data  );
      // UploadToS3(data , fileId );
      await UploadToMultiS3(data, fileId, parts, file , signal , token);
      return true;
    }

      async function UploadToMultiS3(data, fileId, parts, file , signal , token) {
      console.log(data, fileId, parts, file);
      console.log(file);
      const uploadPromises = [];
      const etags = [];
      for (let partNumber = 1; partNumber <= parts; partNumber++) {
        const start = (partNumber - 1) * CHUNK_SIZE* 1024 * 1024;
        const end = Math.min(start + CHUNK_SIZE * 1024 * 1024, file.size);
       
        console.log(start, end);
    //    const uploadPromise = window.electron.uploadChunk({
    //   presignedUrl: data[partNumber - 1].url,
    //   filePath: file.path,
    //   start,
    //   end,
    //   partNumber,
    //   type: file.type
    // }).then(etag => {
    //   etags.push({
    //     PartNumber: partNumber,
    //     ETag: etag,
    //     chunkSize: end - start
    //   });
    // });
     const uploadPromise = uploadChunkNode({
  presignedUrl: data[partNumber - 1].url,
  filePath: file.path,
  start,
  end,
  partNumber,
  type: file.type,
  signal
}).then(etag => {
  etags.push({
    PartNumber: partNumber,
    ETag: etag,
    chunkSize: end - start
  });
});




        uploadPromises.push(uploadPromise);
      }

      try {
        // Wait until ALL uploads finish
        //  await SaveMultiUpload(etags , fileId);
        await Promise.all(uploadPromises);
        console.log("All parts uploaded successfully!");
        console.log(etags);

        await SaveMultiUpload(etags, fileId , signal , token);
        // SaveUpload(etags , fileId , files , parts);

        // Here you can trigger the "complete multipart upload" step if needed
      } catch (error) {
        console.error("Upload failed:", error);
        // Handle retry or error reporting here
      }

       return true;
    }

     
       
        
function removeSession(session_Id) {
  const store = readStore();
  const updatedStore = store.filter(session => session.session_Id !== session_Id);
  console.log('Updated store after removing session:', updatedStore);
  

  writeStore(updatedStore);
}

  async function SaveMultiUpload(tag, fileId , signal , token) {
      for (const item of tag) {
        try {
          console.log(item);
          const res = await axios.post(`${API_BASE_URL}/upload/part`, 
            {
              fileId: fileId,
              partNumber: item.PartNumber, // correct case
              etag: item.ETag,             // match the key used earlier
              size: item.chunkSize,
            } ,
           {  headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`
            }, 
            
            signal: signal
          });

          console.log(`Response for part ${item.PartNumber}:`, res);

          if (!res.data.ok) {
            console.error(`Failed to save part ${item.PartNumber}`);
          } else {
            console.log(`Saved part ${item.PartNumber} metadata`);
          }
        } catch (error) {
          console.error(`Error saving part ${item.PartNumber}:`, error);
        }
      }

      try {
        const response = await axios.post(`${API_BASE_URL}/upload/complete`, 
         {
           fileId: fileId,
         },
         { headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          }, 
          signal: signal
        });

        console.log("Complete upload response:", response);

        if (!response.ok) {
          console.error("Failed to complete multipart upload");
        } else {
          // document.getElementById("loader").style.display = "none";
          // document.getElementById("button-submit").style.display = "block";
          // document.getElementById("controls1").style.display = "none";
            // document.getElementById("controls2").style.display = "none";
          // alert("Multipart upload completed successfully");

          console.log("Multipart upload completed successfully");
        }

      } catch (error) {
        console.error("Error completing multipart upload:", error);
      }
       return true;
    }



async function uploadChunkNode({
  presignedUrl,
  filePath,
  start,
  end,
  partNumber,
  type,
  signal
}) {
  const stream = fs.createReadStream(filePath, { start, end: end - 1 });

  const res = await axios.put(presignedUrl, stream, {
    headers: {
      "Content-Type": type,
      "Content-Length": end - start
    },
    signal
  });

  return res.headers.etag;
}



  function sortByCreatedAt(items, order = "asc") {
  return [...items].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();

    return order === "asc" ? timeA - timeB : timeB - timeA;
  });
}
 async function SingleSignedUrl(id, fileId , file , signal , token) {

      const res = await axios.post(`${API_BASE_URL}/upload/sign`, 
       {
         fileId: fileId,
          partNumber: "1"
       },
       { headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        // body: JSON.stringify({
        //   fileId: fileId,
        //   partNumber: "1" 
        // }),
        signal: signal
      });
      console.log(res);
      const data = res.data;
      // status.textContent = "✅ Upload successful";
      console.log("Server response:", data);
     await  UploadToS3(data, fileId , file , signal , token);
     return true;
    }


    async function UploadToS3(data, fileId , file , signal , token) {
      console.log(data);
     
      console.log(file);
      const buffer = await fsp.readFile(file.path);
// const buffer = await window.electron.readFile(file.path);
      const res = await fetch(data.url, {
        method: "PUT",
        body: buffer,
        headers: {
          "Content-Type": file.type
        },
        signal: signal

      });
      const etag = res.headers.get("ETag");
      console.log(etag);
      if (!res.ok) {
        throw new Error("Upload failed");
      }
      console.log(res);
      await SaveUpload(etag, fileId, file, '1' , signal , token);
      return true;
      // const datas = await res.json();
      // status.textContent = "✅ Upload successful";
      // console.log("Server response:", datas);
    }


     async function SaveUpload(etag, fileId, file, single , signal , token) {
      console.log(etag);
      const res = await axios.post(`${API_BASE_URL}/upload/part`, 
       {
         fileId: fileId,
          partNumber: 1,
          etag: etag,
          size: file.size 
       },
        { headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
       
        signal: signal
      })
      console.log('ooooooooooooo' , res);
      //  const data = await res.json();
      const response = await axios.post(`${API_BASE_URL}/upload/complete`, 
       {
         fileId: fileId,
       },
       { headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        }, 
       
        signal: signal
      })
      console.log('uuuuuuuuuuu' ,res);
      if (res.statusText == 'OK') {
        // alert('Video Uploaded Successfully');
         return true;
      }
       return true;

      // document.getElementById("loader").style.display = "none";
      // document.getElementById("loaders").style.display = "none";
      // document.getElementById("button-submit").style.display = "block";


      

    }




                    


function buildFileMeta(filePath, stat) {
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    type: `video/${path.extname(filePath).slice(1)}`,
    lastModified: stat.mtimeMs
  };
}
 ipcMain.on("renderer-exit", async (event, file , session_Id , token , matchId) => {
  console.log("Renderer quitting with data:", file , session_Id , token);

  // Example:
   const store = readStore();
   const response = await axios.get(`${API_BASE_URL}/dashboard/sessions/${session_Id}/files`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
       
      })
      console.log('ggggg' , response , response.data );
      // const files = response.data.filter(f => f.status != "completed");

      const datas = sortByCreatedAt(response.data);
      // const filteredFiles = datas.filter(f => f.status !== "completed");
      console.log('ggggggggggggg' , datas , file );
  // data = { fileName, size, sessionId, status }
  const normalized = [];
  for(let i=0 ; i< datas.length ; i++){
    if(datas[i].status !== "completed"){
     normalized.push({
    path: file[i].path,
    lastModified: file[i].lastModified,
    name: file[i].name,
    size: file[i].size,
    type: file[i].type,
    relativePath: file[i].relativePath,
    webkitRelativePath: file[i].webkitRelativePath,
    fileId : datas[i].id
  });
    }
  }
  // const normalized = file.map(f => ({
  //   path: f.path,
  //   lastModified: f.lastModified,
  //   name: f.name,
  //   size: f.size,
  //   type: f.type,
  //   relativePath: f.relativePath,
  //   webkitRelativePath: f.webkitRelativePath
  // }));

  store.push({
    session_Id,
    files: normalized,
    savedAt: new Date().toLocaleString(),
    limit : 3,
    token: token,
    matchId : matchId
  });

  writeStore(store);
  console.log('hhfhv');
  if(uploadState !== UploadState.UPLOADING){
    startUpload();
  }

  // ✅ synchronous persistence only
});
ipcMain.handle('select-videos', async (_event, type) => {
  let result;

  if (type === 'single') {
    // 🔹 Select single / multiple video files
    result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm',] }
      ]
    });

    if (result.canceled) return [];
    // const gf = walk(result.filePaths[0]);
    console.log('dhfbhdbfhv' , result);
           return result.filePaths.map(p => {
            console.log('dfjbvjdb ' , p);
      const stat = fs.statSync(p);
      console.log('gggggg' , stat);
      return buildFileMeta(p, stat);
    });
    // return walk(result.filePaths);
  }

  // 🔹 Select folder
  result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    filters: [
        { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }
      ]
  });

  if (result.canceled) return [];

  // Walk directory & return file paths
  const rootDir = result.filePaths[0];
  const parentDir = path.dirname(rootDir); 
  return walk(rootDir , parentDir);
});

ipcMain.handle('read-file', async (_event, filePath) => {
  try {
    const data = await fsp.readFile(filePath);
    return data;  // returns Buffer (serialized by Electron)
  } catch (err) {
    throw err;
  }
});


ipcMain.handle("upload-chunk", async (_e, d) => {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(d.filePath, {
      start: d.start,
      end: d.end - 1
    });

    const url = new URL(d.presignedUrl);

    const req = https.request({
      method: "PUT",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": d.type,
        "Content-Length": d.end - d.start
      }
    }, res => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(res.headers.etag);
      } else {
        reject(new Error(`Upload failed (${res.statusCode})`));
      }
    });

    stream.pipe(req);
    stream.on("error", reject);
    req.on("error", reject);
  });
});




// ---------------------------------------------------------------------------
// Auto-upload support.
//
// The watcher records each ball's camera files into ball_videos.video_id as
// paths relative to the pulls root (e.g. "0001/01/mp4/cam1.mp4"). Scoring
// stores those strings verbatim, so the upload system needs the one thing
// scoring cannot tell it: which local directory they are relative to.
// ---------------------------------------------------------------------------
const SETTINGS_PATH = path.join(app.getPath("userData"), "auto-upload-settings.json");

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) || {};
  } catch (err) {
    // A corrupt settings file must not stop the app from starting; the user
    // just re-picks the folder.
    console.error("Could not read auto-upload settings:", err);
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

ipcMain.handle("get-settings", async () => readSettings());

ipcMain.handle("set-settings", async (_event, patch) => writeSettings(patch || {}));

ipcMain.handle("pick-pulls-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return writeSettings({ pullsRoot: result.filePaths[0] }).pullsRoot;
});

// Resolve watcher-relative paths against the pulls root and report what is
// actually on disk. Returns one entry per requested path, always in the same
// order, so the renderer can pair results back to its ball/camera list.
//
// Two reasons a path can fail to resolve, kept distinct because they mean
// different things: "missing" (the camera never wrote that file) and "empty"
// (a zero-byte file, i.e. the recording is still being flushed and uploading it
// now would store a corrupt object).
ipcMain.handle("probe-videos", async (_event, payload) => {
  const root = payload && payload.root;
  const relativePaths = (payload && payload.relativePaths) || [];

  if (!root) {
    return relativePaths.map((relativePath) => ({ relativePath, status: "no-root" }));
  }

  const resolvedRoot = path.resolve(root);

  return relativePaths.map((relativePath) => {
    try {
      const normalised = String(relativePath).replace(/\\/g, "/");
      const full = path.resolve(resolvedRoot, normalised);

      // The paths come from an HTTP response, so treat them as untrusted: a
      // "../.." in video_id must not let this read outside the pulls root.
      if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
        return { relativePath, status: "outside-root" };
      }

      const stat = fs.statSync(full);
      if (!stat.isFile()) return { relativePath, status: "missing" };
      if (stat.size === 0) return { relativePath, status: "empty" };

      return {
        relativePath,
        status: "ready",
        path: full,
        name: path.basename(full),
        size: stat.size,
        type: mime.lookup(full) || "video/mp4",
        lastModified: stat.mtimeMs,
        // Same field the renderer's existing upload path reads, so a probed
        // file is interchangeable with a picked one.
        webkitRelativePath: normalised,
      };
    } catch (err) {
      if (err && err.code === "ENOENT") return { relativePath, status: "missing" };
      return { relativePath, status: "error", error: err.message };
    }
  });
});

// ---------------------------------------------------------------------------
// HEVC preview transcoding
//
// The rig records H.265, which Chromium will only decode where the platform
// offers hardware HEVC — on a machine without it the <video> element parses the
// container, plays the AAC audio and shows a black frame forever. So before
// playing anything the stream is probed, and only an HEVC one is re-encoded to
// H.264 into a cached temp file. H.264 is handed back untouched: transcoding a
// stream that already plays would be pure latency.
// ---------------------------------------------------------------------------
// const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const PREVIEW_DIR = () => path.join(app.getPath("userData"), "previews");
const PREVIEW_KEEP = 40;
const PROBE_TIMEOUT_MS = 30000;
const TRANSCODE_TIMEOUT_MS = 5 * 60 * 1000;

// Resolve a tool once and remember the answer: a missing ffmpeg is a
// configuration fact, not something that changes between clicks.
let toolCache = null;
function findTools() {
  if (toolCache) return toolCache;
  const run = (bin) => {
    try {
      const probe = require("node:child_process").spawnSync(bin, ["-version"], { timeout: 5000 });
      return probe.status === 0;
    } catch (err) {
      return false;
    }
  };
  toolCache = { ffmpeg: run("ffmpeg"), ffprobe: run("ffprobe") };
  return toolCache;
}

function runTool(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args);
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: `${bin} timed out` });
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Drop the oldest previews so a season of rewatching cannot fill the disk.
function prunePreviews(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of files.slice(PREVIEW_KEEP)) fs.unlinkSync(stale.full);
  } catch (err) {
    /* pruning is housekeeping — never fail a playback over it */
  }
}

ipcMain.handle("preview-video", async (_event, payload) => {
  const url = payload && payload.url;
  const cacheKey = (payload && payload.cacheKey) || url;
  if (!url) return { status: "error", error: "no url" };

  const tools = findTools();
  if (!tools.ffprobe || !tools.ffmpeg) {
    return { status: "no-ffmpeg" };
  }

  const probe = await runTool(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
     "-of", "default=nw=1:nk=1", url],
    PROBE_TIMEOUT_MS,
  );
  if (!probe.ok) {
    return { status: "error", error: probe.error || probe.stderr || "probe failed" };
  }

  const codec = String(probe.stdout || "").split("\n")[0].trim().toLowerCase();
  if (codec !== "hevc" && codec !== "h265") {
    // Plays natively — hand the original straight back.
    return { status: "passthrough", codec };
  }

  const dir = PREVIEW_DIR();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { status: "error", error: `could not create preview folder: ${err.message}` };
  }

  const hash = crypto.createHash("sha1").update(String(cacheKey)).digest("hex").slice(0, 16);
  const out = path.join(dir, `${hash}.mp4`);

  // Already transcoded: re-watching a ball is instant.
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      return { status: "ready", path: out, codec, cached: true };
    }
  } catch (err) {
    /* fall through and rebuild it */
  }

  // Written to a temp name first so a killed transcode can never leave a
  // truncated file behind to be served as a valid cache hit.
  const partial = `${out}.part`;
  const encode = await runTool(
    "ffmpeg",
    ["-v", "error", "-y", "-i", url,
     "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
     // 720p is plenty to check a delivery, and keeps a 10s clip under a MB.
     "-vf", "scale=1280:-2",
     // The temp name ends in .part, so the container cannot be inferred from
     // the extension and has to be stated outright.
     "-c:a", "aac", "-movflags", "+faststart", "-f", "mp4", partial],
    TRANSCODE_TIMEOUT_MS,
  );

  if (!encode.ok) {
    try { fs.unlinkSync(partial); } catch (err) { /* nothing to clean */ }
    return { status: "error", error: encode.error || encode.stderr || "transcode failed" };
  }

  try {
    fs.renameSync(partial, out);
  } catch (err) {
    return { status: "error", error: `could not finalise preview: ${err.message}` };
  }

  prunePreviews(dir);
  return { status: "ready", path: out, codec, cached: false };
});

// ---------------------------------------------------------------------------
// Cricket watcher
//
// The watcher is the Python tool in ~/Desktop/watcher: it polls the pulls tree
// for completed ball folders and POSTs each ball's camera paths to scoring,
// which is what creates the ball_videos rows this app then uploads. Running it
// from here means an operator only ever opens one application. Its console is
// the Watcher window (watcher.html), separate from the uploader.
//
// It is spawned as the shipped PyInstaller binary rather than reimplemented,
// so the detection rules (Z-CAM vs Emergent layouts, the latest-1 fallback)
// stay in the one place they are already proven, and the desktop app keeps
// working unchanged for rigs that use it.
// ---------------------------------------------------------------------------
const WATCHER_BIN = 'cricket-watcher';

let watcherProc = null;

// Where the binary might be: an explicit choice first, then the packaged copy,
// then the dev checkout. Returned rather than cached — an operator can pick a
// path mid-session and should not have to restart.
function watcherBinaryPath() {
  const configured = readSettings().watcherBinary;
  const candidates = [
    configured,
    path.join(process.resourcesPath || '', WATCHER_BIN),
    path.join(__dirname, '..', 'resources', WATCHER_BIN),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (err) {
      /* try the next one */
    }
  }
  return null;
}

// The frozen watcher block-buffers stdout when it is piped (and ignores
// PYTHONUNBUFFERED), so a straight pipe delivers its log in 4KB bursts —
// useless for watching balls land. Given a pty it line-buffers, so it is run
// under script(1) where that exists, and piped directly otherwise.
function shellQuote(parts) {
  return parts.map((part) => `'${String(part).replace(/'/g, "'\\''")}'`).join(' ');
}

function hasScriptCommand() {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/script");
  try {
    return require("node:child_process").spawnSync("script", ["--version"], { timeout: 3000 }).status === 0;
  } catch (err) {
    return false;
  }
}

function spawnWatcher(binary, args) {
  // detached: the watcher is a PyInstaller onefile (parent + extracted child),
  // and under script(1) there is a third process, so it gets its own process
  // group and the whole group is signalled on stop.
  const opts = { stdio: ["ignore", "pipe", "pipe"], detached: true };

  if (process.platform === "linux" && hasScriptCommand()) {
    return spawn("script", ["-qefc", shellQuote([binary, ...args]), "/dev/null"], opts);
  }
  if (process.platform === "darwin" && hasScriptCommand()) {
    return spawn("script", ["-q", "/dev/null", binary, ...args], opts);
  }
  return spawn(binary, args, opts);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Whoever asked for the watcher gets its output: the Watcher console in
// practice, but not assumed, so a log line can never be sent into the void.
let watcherLogTarget = null;

function watcherSend(channel, payload) {
  const targets = [watcherLogTarget, watcherWindow ? watcherWindow.webContents : null];
  const seen = new Set();

  for (const target of targets) {
    if (!target || target.isDestroyed() || seen.has(target.id)) continue;
    seen.add(target.id);
    target.send(channel, payload);
  }
}

// The watcher prints a multi-line block per ball; forwarded line by line so the
// page's log reads the same as the desktop app's console.
function pipeWatcherOutput(stream, isError) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(ANSI, '').trimEnd();
      if (line.trim()) watcherSend('watcher-log', { line, isError });
    }
  });
}

function watcherStatus() {
  return {
    running: !!watcherProc,
    pid: watcherProc ? watcherProc.pid : null,
    binary: watcherBinaryPath(),
  };
}

function stopWatcher() {
  if (!watcherProc) return watcherStatus();

  const proc = watcherProc;
  watcherProc = null;
  try {
    // The whole group: script(1) and the onefile bootloader's child would
    // otherwise be left behind still posting balls to scoring.
    process.kill(-proc.pid, 'SIGTERM');
  } catch (err) {
    try {
      proc.kill('SIGTERM');
    } catch (err2) {
      /* already gone */
    }
  }
  return watcherStatus();
}

function startWatcher(options, sender) {
  const opts = options || {};
  if (sender && !sender.isDestroyed()) watcherLogTarget = sender;

  if (watcherProc) return { ...watcherStatus(), error: 'Watcher already running' };

  const binary = watcherBinaryPath();
  if (!binary) {
    return {
      ...watcherStatus(),
      error: `${WATCHER_BIN} not found — put it in resources/ or pick it with Watcher binary…`,
    };
  }

  const root = opts.root || readSettings().pullsRoot;
  if (!root) return { ...watcherStatus(), error: 'Set the pulls folder first' };

  // Both URLs are derived from one host, the way the desktop GUI does it: the
  // scoring frontend takes the ball, the backend takes the same payload.
  // Scoring (with /api/video_data) runs on 3001 — port 3000 is Association's,
  // which has no such route.
  const host = opts.host || readSettings().watcherHost || '127.0.0.1';
  const args = [
    '--no-gui',
    root,
    '--api', `http://${host}:3001/api/video_data`,
    '--secondary-api', `http://${host}:5500/video_data`,
  ];
  if (opts.interval) args.push('--interval', String(opts.interval));

  writeSettings({ watcherHost: host });

  try {
    watcherProc = spawnWatcher(binary, args);
  } catch (err) {
    watcherProc = null;
    return { ...watcherStatus(), error: `Could not start watcher: ${err.message}` };
  }

  pipeWatcherOutput(watcherProc.stdout, false);
  pipeWatcherOutput(watcherProc.stderr, true);

  watcherProc.on('error', (err) => {
    watcherProc = null;
    watcherSend('watcher-log', { line: `watcher error: ${err.message}`, isError: true });
    watcherSend('watcher-exit', { code: null, error: err.message });
  });

  watcherProc.on('close', (code, signal) => {
    watcherProc = null;
    watcherSend('watcher-exit', { code, signal });
  });

  watcherSend('watcher-log', { line: `watcher started: ${binary} ${args.join(' ')}` });
  return watcherStatus();
}

ipcMain.handle('watcher-start', async (event, options) =>
  startWatcher(options || {}, event.sender));
ipcMain.handle('watcher-stop', async () => stopWatcher());
ipcMain.handle('watcher-status', async () => watcherStatus());
ipcMain.handle('open-scoring', async () => openScoringWindow());

ipcMain.handle('pick-watcher-binary', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (result.canceled || result.filePaths.length === 0) return watcherStatus();
  writeSettings({ watcherBinary: result.filePaths[0] });
  return watcherStatus();
});

app.on('before-quit', () => {
  stopWatcher();
  if (scoringProcess) {
    try { scoringProcess.kill(); } catch (e) {}
  }
});




ipcMain.handle('resolve-drop', async (_event, paths) => {
  const results = [];

  for (const filePath of paths) {
    try {
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        // reuse your existing walk function
        const walked = walk(filePath, filePath);
        results.push(...walked);
      } else if (/\.(mp4|mov|mkv|avi|webm)$/i.test(filePath)) {
        // reuse your existing buildFileMeta function
        results.push(buildFileMeta(filePath, stat));
      }
    } catch (err) {
      console.error('resolve-drop error for path:', filePath, err);
    }
  }

  return results;
  // returns exact same shape as select-videos
  // { path, name, size, type, lastModified }
  // walk also adds relativePath and webkitRelativePath
});






// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});


// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
