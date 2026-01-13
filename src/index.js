const { app, BrowserWindow  ,  dialog } = require('electron');
const path = require('node:path');
const fs = require("fs");
const fsp = require('fs').promises;
const mime = require("mime-types");
const { URL } = require('url');
const https = require('https');
const API_BASE_URL = 'http://localhost:5701';
const CHUNK_SIZE = 500; // in MB
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

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
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
        { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }
      ]
    });

    if (result.canceled) return [];
    // const gf = walk(result.filePaths[0]);
    // console.log(gf);
           return result.filePaths.map(p => {
      const stat = fs.statSync(p);
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
  return walk(result.filePaths[0] , rootDir);
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
