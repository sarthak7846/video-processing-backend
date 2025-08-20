const express = require("express");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
// const cloudinary = require("./cloudinary");
const multer = require("multer");

require("dotenv").config();

const app = express();

// Multer storage
const upload = multer({ dest: "uploads/" });

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

// Trim route
app.post("/api/trim", upload.single("video"), async (req, res) => {
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

  const jobId = uuidv4();
  const inputPath = videoFile.path; // multer saved file
  const outputDir = path.join(__dirname, "output", jobId);
  const concatListPath = path.join(outputDir, "concat.txt");
  const finalOutputPath = path.join(outputDir, `${jobId}-final.mp4`);

  try {
    fs.mkdirSync(outputDir, { recursive: true });

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

      const segmentOutput = path.join(outputDir, `part${i}.mp4`);
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

    // // Upload to Cloudinary
    // const result = await cloudinary.uploader.upload(finalOutputPath, {
    //   resource_type: "video",
    //   folder: "trimmed_videos",
    //   public_id: jobId,
    // });

    // // Cleanup
    // fs.unlinkSync(inputPath);
    // fs.unlinkSync(finalOutputPath);
    // segmentFiles.forEach((f) => fs.unlinkSync(f));
    // fs.unlinkSync(concatListPath);
    // fs.rmdirSync(outputDir);

    // res.json({ trimmedUrl: result.secure_url });

    // ✅ Instead of uploading to Cloudinary, stream video back to frontend
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", "inline; filename=trimmed.mp4");

    const readStream = fs.createReadStream(finalOutputPath);
    readStream.pipe(res);

    // Cleanup after response is sent
    readStream.on("close", () => {
      try {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(finalOutputPath);
        segmentFiles.forEach((f) => fs.unlinkSync(f));
        fs.unlinkSync(concatListPath);
        fs.rmdirSync(outputDir);
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr.message);
      }
    });
  } catch (err) {
    console.error("Trim error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(4000, () => console.log("Server running at http://localhost:4000"));
