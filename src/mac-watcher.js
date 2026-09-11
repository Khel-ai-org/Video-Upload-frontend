const fs = require("fs");
const path = require("path");

const PULLS_DIR = process.argv[2] || path.join(require("os").homedir(), "Desktop/test_pulls");
const NEXT_API = "http://127.0.0.1:3000/api/video_data";
const BACKEND_API = "http://127.0.0.1:5500/video_data";

console.log("🚀 Starting macOS Watcher...");
console.log("📂 Monitoring folder:", PULLS_DIR);

let ballCount = 0;

if (!fs.existsSync(PULLS_DIR)) {
  fs.mkdirSync(PULLS_DIR, { recursive: true });
}

fs.watch(PULLS_DIR, { recursive: true }, async (event, filename) => {
  if (filename && filename.endsWith(".mp4") && !filename.startsWith(".")) {
    ballCount++;
    console.log(`\n📹 New ball video detected: ${filename}`);

    const payload = {
      video_data: {
        ball_no: ballCount,
        video_id: {
          camera1: filename,
          camera2: filename
        }
      }
    };

    // 1. Post to Next.js Scorer Frontend
    try {
      const res1 = await fetch(NEXT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      console.log(`✅ Posted to Scorer UI (${NEXT_API}) - Status: ${res1.status}`);
    } catch (e) {
      console.error(`❌ Failed to post to Scorer UI:`, e.message);
    }

    // 2. Post to Scoring Backend
    try {
      const res2 = await fetch(BACKEND_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      console.log(`✅ Posted to Scoring Backend (${BACKEND_API}) - Status: ${res2.status}`);
    } catch (e) {
      console.error(`❌ Failed to post to Scoring Backend:`, e.message);
    }
  }
});