const express = require("express");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const cloudinary = require("./cloudinary");

require("dotenv").config();

const app = express();

app.use(
  cors({
    origin: "http://localhost:3000", // frontend origin
    credentials: true, // 🔥 allow cookies/credentials
  })
);

app.use(express.json());

const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);

// Output folder
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

/**
 * Download file from URL
 */
async function downloadFile(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
  });
  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

/**
 * Endpoint to process Cloudinary URL
 */
app.post("/api/trim", async (req, res) => {
  const { videoUrl, startTime, endTime } = req.body;
  console.log("📥 Received Trim Request:", { videoUrl, startTime, endTime });
  console.log("videoUrl:", videoUrl);
  console.log("startTime:", startTime);
  console.log("endTime:", endTime);

  if (
    !videoUrl ||
    startTime === undefined ||
    endTime === undefined ||
    endTime <= startTime
  ) {
    console.log("❌ Validation failed");
    return res.status(400).json({ error: "Invalid input" });
  }

  const jobId = uuidv4();
  const inputPath = path.join(__dirname, "uploads", `${jobId}-input.mp4`);
  const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

  try {
    // Step 1: Download from Cloudinary
    await downloadFile(videoUrl, inputPath);
    console.log("✅ Video downloaded");

    // Step 2: Trim with ffmpeg
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(endTime - startTime)
      .output(outputPath)
      .on("end", async () => {
        console.log("✅ Video trimmed");

        try {
          // Step 3: Upload to Cloudinary
          const result = await cloudinary.uploader.upload(outputPath, {
            resource_type: "video",
            folder: "trimmed_videos",
            public_id: jobId,
          });

          console.log("✅ Uploaded to Cloudinary");
          console.log(result);

          // Step 4: Cleanup local files
          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);

          res.json({ trimmedUrl: result.secure_url });
        } catch (cloudErr) {
          console.error("❌ Cloudinary Upload Error:", cloudErr.message);
          res.status(500).json({ error: "Cloudinary upload failed" });
        }
      })
      .on("error", (err) => {
        console.error("❌ Trimming Error:", err);
        res.status(500).json({ error: "Trimming failed" });
      })
      .run();
  } catch (err) {
    console.error("❌ Download error:", err.message);
    res.status(500).json({ error: "Download or processing failed" });
  }
});

// Serve output videos
app.use(
  "/output",
  (req, res, next) => {
    res.setHeader("Content-Type", "video/mp4");
    // res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  },
  express.static(path.join(__dirname, "output"))
);

app.listen(4000, () => {
  console.log("🚀 Video Processor running at http://localhost:4000");
});
