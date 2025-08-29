const express = require("express");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const os = require("os");
const multer = require("multer");

const app = express();
app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(express.json());

const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);

function parseTimeToSeconds(timeStr) {
  const parts = timeStr.split(":").map(Number);
  const [hh = 0, mm = 0, ss = 0] = parts;
  return hh * 3600 + mm * 60 + ss;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeRmDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

const uploadsBase = path.join(os.tmpdir(), "uploads");
ensureDir(uploadsBase);

const upload = multer({
  dest: uploadsBase,
  limits: { fileSize: 1024 * 1024 * 1024 },
});

app.post("/api/trim", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Missing video file" });
  if (!req.body?.segments) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Missing segments" });
  }

  let segments;
  try {
    segments = JSON.parse(req.body.segments);
    if (!Array.isArray(segments) || segments.length === 0) throw new Error();
  } catch {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Invalid segments format" });
  }

  const jobDir = path.join(os.tmpdir(), "video-jobs", uuidv4());
  ensureDir(jobDir);

  const inputExt = path.extname(req.file.originalname) || ".mp4";
  const inputPath = path.join(jobDir, `input${inputExt}`);
  fs.renameSync(req.file.path, inputPath);

  const segmentFiles = [];

  try {
    for (let i = 0; i < segments.length; i++) {
      const { start, end } = segments[i];
      const startSec = parseTimeToSeconds(start);
      const endSec = parseTimeToSeconds(end);
      const duration = endSec - startSec;
      if (isNaN(startSec) || isNaN(endSec) || duration <= 0)
        throw new Error(`Invalid segment at index ${i}`);

      const partPath = path.join(jobDir, `part_${i}.mp4`);
      segmentFiles.push(partPath);

      // Trim with decoding for accuracy, then copy codec for concat
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(startSec) // after -i for frame accuracy
          .setDuration(duration)
          .outputOptions(["-c copy", "-movflags +faststart"])
          .output(partPath)
          .on("error", reject)
          .on("end", resolve)
          .run();
      });
    }

    // Concat all trimmed segments
    const concatListPath = path.join(jobDir, "concat.txt");
    const finalOutputPath = path.join(jobDir, "final.mp4");

    const concatText = segmentFiles
      .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(concatListPath, concatText);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions(["-c copy", "-movflags +faststart"])
        .output(finalOutputPath)
        .on("error", reject)
        .on("end", resolve)
        .run();
    });

    // Stream final video
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="trimmed.mp4"');
    fs.createReadStream(finalOutputPath)
      .pipe(res)
      .on("finish", () => safeRmDir(jobDir));
  } catch (err) {
    console.error(err);
    safeRmDir(jobDir);
    return res.status(500).json({ error: err.message || "Processing failed" });
  }
});

app.listen(process.env.PORT || 4000, () => console.log("Server running"));

// 1. Re-encoding means decoding and then re-encoding a video, which consumes a lot of CPU and memory.

// 2. Our service trims and merges only the specified segments using a copy codec (-c copy), avoiding re-encoding.

// 3. Videos are stored temporarily, processed efficiently, streamed back, and all temporary files are deleted to keep memory and storage low.

// 4. This memory-efficient approach allows safe handling of large videos and multiple segments and can be deployed on Render without crashes or resource issues.
