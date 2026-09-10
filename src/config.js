// API_BASE_URL = 'https://video-storage.crik.ai';
API_BASE_URL = "http://localhost:5701";
//SCORING_API_BASE_URL = 'http://localhost:5500';
//SCORING_API_BASE_URL = "https://reunion-crawlers-overjoyed.ngrok-free.dev";
SCORING_API_BASE_URL = 'http://localhost:5500';
//API_BASE_URL = 'https://assoback.khel.ai';
CHUNK_SIZE = 500;

// Durable, non-expiring base for playable video URLs — the bucket's public
// origin or its CDN domain, WITHOUT a trailing slash. The auto-uploader writes
// `${VIDEO_PUBLIC_BASE_URL}/${s3Key}` into ball_videos.url.
//
// Left empty on purpose: presigned URLs (POST /matches/files/video-url) expire,
// so storing one would rot in the DB, and scoring now rejects any url carrying a
// query string. While this is empty the uploader simply sends no url and
// s3_keys stays the source of truth — set it to start populating url.
VIDEO_PUBLIC_BASE_URL = '';

// How often the auto-uploader re-scans: it re-reads the active match's
// ball_videos rows and walks the pulls folder for footage scoring has no row
// for. Ten minutes — a scan now reads the whole disk tree, and footage is
// uploaded in ball-folder batches rather than raced file by file.
AUTO_POLL_INTERVAL_MS = 600000;
``
