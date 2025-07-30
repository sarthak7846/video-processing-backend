const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(
  cors({
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  })
);

app.use(express.json());

const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);

// Output directory
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// Multer setup
const upload = multer({ dest: "uploads/" });

// Trim and store video
app.post("/api/trim", upload.single("video"), (req, res) => {
  const { startTime, endTime } = req.body;
  const duration = endTime - startTime;

  if (!req.file || duration <= 0) {
    return res.status(400).json({ error: "Invalid trim request" });
  }

  const inputPath = req.file.path;
  const jobId = uuidv4();
  const outputPath = path.join(OUTPUT_DIR, `${jobId}.webm`);

  ffmpeg(inputPath)
    .setStartTime(startTime)
    .setDuration(duration)
    .output(outputPath)
    .on("end", () => {
      console.log("✅ Trim complete:", outputPath);
      res.json({
        videoUrl: `http://localhost:4000/output/${jobId}.webm`,
      });
    })
    .on("error", (err) => {
      console.error("❌ FFmpeg error:", err.message);
      res.status(500).json({ error: "FFmpeg failed" });
    })
    .run();
});

// ✅ Serve video with correct Content-Type
app.use("/output", express.static(path.join(__dirname, "output")));

app.listen(4000, () => {
  console.log("🚀 Video Processor running on http://localhost:4000");
});
