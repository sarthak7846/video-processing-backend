const express = require("express");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const cloudinary = require("./cloudinary");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;

ffmpeg.setFfmpegPath(ffmpegPath);
require("dotenv").config();

const app = express();

// Output folder
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
// app.use(cors());

// Explicit CORS config
app.use(
  cors({
    origin: ["http://localhost:3000", "https://your-frontend-domain.com"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Serve output videos
app.use(
  "/output",
  (_, res, next) => {
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  },
  express.static(path.join(__dirname, "output"))
);

app.use(express.json());

// Parse "HH:MM:SS" to total seconds
function parseTimeToSeconds(timeStr) {
  const parts = timeStr.split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return NaN;
  const [hh, mm, ss] = parts;
  return hh * 3600 + mm * 60 + ss;
}

// Download file from URL
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

app.get("/", (_, res) => {
  res.send("Server is healthy");
});

// app.post("/api/trim", async (req, res) => {
//   console.log('body', req.body);

//   const { videoUrl, segments } = req.body;
//   console.log("📥 Received Trim Request:", { videoUrl, segments });

//   if (
//     !videoUrl ||
//     !segments ||
//     !Array.isArray(segments) ||
//     segments.length === 0
//   ) {
//     return res.status(400).json({ error: "Invalid video URL or segments" });
//   }

//   const uploadsDir = path.join(__dirname, "uploads");
//   if (!fs.existsSync(uploadsDir)) {
//     fs.mkdirSync(uploadsDir, { recursive: true });
//   }

//   const jobId = uuidv4();
//   const inputPath = path.join(__dirname, "uploads", `${jobId}-input.mp4`);
//   const outputDir = path.join(__dirname, "output", jobId);
//   const concatListPath = path.join(outputDir, "concat.txt");
//   const finalOutputPath = path.join(__dirname, "output", `${jobId}-final.mp4`);

//   try {
//     // Prepare output dir
//     fs.mkdirSync(outputDir, { recursive: true });

//     // 1. Download original video
//     await downloadFile(videoUrl, inputPath);
//     console.log("✅ Video downloaded");

//     // 2. Trim each segment
//     const segmentFiles = [];

//     for (let i = 0; i < segments.length; i++) {
//       const { start, end } = segments[i];
//       const startSec = parseTimeToSeconds(start);
//       const endSec = parseTimeToSeconds(end);
//       const duration = endSec - startSec;

//       if (isNaN(startSec) || isNaN(endSec) || duration <= 0) {
//         throw new Error(`Invalid segment time at index ${i}`);
//       }

//       const segmentOutput = path.join(outputDir, `part${i}.mp4`);
//       segmentFiles.push(segmentOutput);

//       await new Promise((resolve, reject) => {
//         ffmpeg(inputPath)
//           .setStartTime(startSec)
//           .setDuration(duration)
//           .output(segmentOutput)
//           .on("end", () => {
//             console.log(`✅ Trimmed segment ${i + 1}`);
//             resolve();
//           })
//           .on("error", (err) => {
//             console.error(`❌ Error trimming segment ${i + 1}:`, err.message);
//             reject(err);
//           })
//           .run();
//       });
//     }

//     // 3. Create concat list file for FFmpeg
//     const concatText = segmentFiles.map((file) => `file '${file}'`).join("\n");
//     fs.writeFileSync(concatListPath, concatText);

//     // 4. Concatenate all segments
//     await new Promise((resolve, reject) => {
//       ffmpeg()
//         .input(concatListPath)
//         .inputOptions("-f", "concat", "-safe", "0")
//         .outputOptions("-c", "copy")
//         .output(finalOutputPath)
//         .on("end", () => {
//           console.log("✅ Segments concatenated");
//           resolve();
//         })
//         .on("error", (err) => {
//           console.error("❌ Error during concatenation:", err.message);
//           reject(err);
//         })
//         .run();
//     });

//     // 5. Upload final output to Cloudinary
//     const result = await cloudinary.uploader.upload(finalOutputPath, {
//       resource_type: "video",
//       folder: "trimmed_videos",
//       public_id: jobId,
//     });

//     // Cleanup
//     fs.unlinkSync(inputPath);
//     fs.unlinkSync(finalOutputPath);
//     segmentFiles.forEach((file) => fs.unlinkSync(file));
//     fs.unlinkSync(concatListPath);
//     fs.rmdirSync(outputDir);

//     res.json({ trimmedUrl: result.secure_url });
//   } catch (err) {
//     console.error("❌ Error processing segments:", err.message);
//     res.status(500).json({ error: err.message || "Failed to process video" });
//   }
// });

app.post("/api/trim", async (req, res) => {
  try {
    const { videoUrl, segments } = req.body;
    if (!videoUrl || !segments?.length) {
      return res.status(400).json({ error: "Invalid video URL or segments" });
    }

    const jobId = uuidv4();

    // Build filter_complex for multiple trims
    const filters = segments
      .map((seg, i) => {
        const start = parseTimeToSeconds(seg.start);
        const end = parseTimeToSeconds(seg.end);
        const duration = end - start;
        return `[0:v]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS[v${i}]; ` +
               `[0:a]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS[a${i}]`;
      })
      .join("; ");

    const concatInputs = segments
      .map((_, i) => `[v${i}][a${i}]`)
      .join("");

    const filterGraph = `${filters}; ${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

    // Cloudinary upload stream
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        folder: "trimmed_videos",
        public_id: jobId,
      },
      (error, result) => {
        if (error) {
          console.error("❌ Cloudinary upload failed:", error);
          return res.status(500).json({ error: "Upload failed" });
        }
        res.json({ trimmedUrl: result.secure_url });
      }
    );

    // Run ffmpeg and pipe output to Cloudinary
    ffmpeg(videoUrl)
      .complexFilter(filterGraph)
      .map("[outv]").map("[outa]")
      .outputOptions(["-c:v libx264", "-c:a aac", "-movflags frag_keyframe+empty_moov"])
      .format("mp4")
      .on("error", (err) => {
        console.error("❌ FFmpeg error:", err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: "Video processing failed" });
        }
      })
      .pipe(uploadStream, { end: true }); // direct stream

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message || "Failed to trim video" });
  }
});

app.listen(4000, () => {
  console.log("Video Processor running at http://localhost:4000");
});
