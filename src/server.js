const express = require("express");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const cloudinary = require("./cloudinary");
const multer = require("multer");

require("dotenv").config();

const app = express();

app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(express.json());

// FFmpeg setup
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);

// Helpers
function parseTimeToSeconds(timeStr) {
  const [hh, mm, ss] = timeStr.split(":").map(Number);
  return hh * 3600 + mm * 60 + ss;
}

// Dynamic Multer storage
function getMulterUpload() {
  const uploadDir = path.join(__dirname, "uploads");

  // create uploads folder only when route is hit
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log("Created uploads folder");
  }

  return multer({ dest: uploadDir });
}

// Trim route
app.post("/api/trim", (req, res, next) => {
  // create uploads folder dynamically
  const upload = getMulterUpload().single("video");

  upload(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });

    const { segments } = req.body;
    const videoFile = req.file;

    if (!videoFile || !segments) {
      return res.status(400).json({ error: "Missing video or segments" });
    }

    let parsedSegments;
    try {
      parsedSegments = JSON.parse(segments);
    } catch {
      return res.status(400).json({ error: "Invalid segments format" });
    }

    // Unique job folder
    const jobId = uuidv4();
    const jobDir = path.join(__dirname, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    // Move uploaded file into job folder
    const inputPath = path.join(
      jobDir,
      `input${path.extname(videoFile.originalname) || ".mp4"}`
    );
    fs.renameSync(videoFile.path, inputPath);

    const concatListPath = path.join(jobDir, "concat.txt");
    const finalOutputPath = path.join(jobDir, `${jobId}-final.mp4`);

    try {
      // Trim each segment
      const segmentFiles = [];
      for (let i = 0; i < parsedSegments.length; i++) {
        const { start, end } = parsedSegments[i];
        const startSec = parseTimeToSeconds(start);
        const endSec = parseTimeToSeconds(end);
        const duration = endSec - startSec;

        if (isNaN(startSec) || isNaN(endSec) || duration <= 0) {
          throw new Error(`Invalid segment at index ${i}`);
        }

        const segmentOutput = path.join(jobDir, `part${i}.mp4`);
        segmentFiles.push(segmentOutput);

        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(startSec)
            .setDuration(duration)
            .output(segmentOutput)
            .on("end", resolve)
            .on("error", reject)
            .run();
        });
      }

      // Create concat list
      const concatText = segmentFiles.map((f) => `file '${f}'`).join("\n");
      fs.writeFileSync(concatListPath, concatText);

      // Concatenate segments
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions("-f", "concat", "-safe", "0")
          .outputOptions("-c", "copy")
          .output(finalOutputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      // ✅ Stream final video back
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "inline; filename=trimmed.mp4");

      const readStream = fs.createReadStream(finalOutputPath);
      readStream.pipe(res);

      // Cleanup after response
      res.on("finish", () => {
        try {
          if (fs.existsSync(jobDir)) {
            fs.rmSync(jobDir, { recursive: true, force: true });
            console.log(`Cleaned up job folder: ${jobDir}`);
          }
          const uploadDir = path.join(__dirname, "uploads");
          if (fs.existsSync(uploadDir)) {
            fs.rmSync(uploadDir, { recursive: true, force: true });
            console.log("Cleaned up uploads folder");
          }
        } catch (cleanupErr) {
          console.error("Cleanup error:", cleanupErr.message);
        }
      });
    } catch (err) {
      console.error("Trim error:", err.message);
      res.status(500).json({ error: err.message });

      // Cleanup even on error
      try {
        if (fs.existsSync(jobDir)) {
          fs.rmSync(jobDir, { recursive: true, force: true });
        }
        const uploadDir = path.join(__dirname, "uploads");
        if (fs.existsSync(uploadDir)) {
          fs.rmSync(uploadDir, { recursive: true, force: true });
        }
      } catch {}
    }
  });
});

app.listen(4000, () => console.log("Server running at http://localhost:4000"));

// 🔄 High-Level Flow

// Frontend uploads a video + segment timings → backend API (/api/trim).

// Backend temporarily stores the video in an uploads/ folder.

// This folder is created fresh every request and removed after processing.

// Backend trims video into multiple parts using FFmpeg, based on the given start & end times.

// All trimmed parts are concatenated into one final video.

// Final video is sent back to the frontend as a response.

// Cleanup happens automatically: both the job folder and the uploads/ folder are deleted.\

// uploads/
//   ├── job1/
//   │     └── input.mp4
//   ├── job2/
//   │     └── input.mp4
