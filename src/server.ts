import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import os from "os";
import fs from "fs";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import dotenv from "dotenv";
import sharp from "sharp";
import { fileURLToPath } from "url";

import { ensureDir, parseTimeToSeconds, safeRmDir } from "./utils/utils.js";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const allowedOrigins = process.env.APP_ORIGINS?.split(",") ?? [];
// before one ====>
// app.use(
//   cors({
//     origin: allowedOrigins,
//     credentials: true,
//   })
// );

// ✅ Enable CORS for frontend (http://localhost:3000)
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

// ✅ Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const uploadsBase = path.join(os.tmpdir(), "uploads");
ensureDir(uploadsBase);

const upload = multer({
  dest: uploadsBase,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB limit
});

app.get("/", (_, res: Response) => {
  res.send("Server is running");
});

// -------------------------
// 📌 /api/trim route
// -------------------------

app.post(
  "/api/trim",
  upload.single("video"),
  async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "Missing video file" });
    if (!req.body?.segments) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Missing segments" });
    }

    let segments = [];
    try {
      segments = JSON.parse(req.body.segments);
      if (!segments || !Array.isArray(segments) || segments.length === 0) {
        throw new Error();
      }
    } catch {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Invalid segments format" });
    }

    const jobDir = path.join(os.tmpdir(), "video-jobs", uuidv4());
    ensureDir(jobDir);

    const inputExt = path.extname(req.file.originalname) || ".mp4";
    const inputPath = path.join(jobDir, `input${inputExt}`);
    fs.renameSync(req.file.path, inputPath);

    const segmentFiles: string[] = [];

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

        await new Promise<void>((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(startSec)
            .setDuration(duration)
            .outputOptions(["-c copy", "-movflags +faststart"])
            .output(partPath)
            .on("error", reject)
            .on("end", () => resolve())
            .run();
        });
      }

      const concatListPath = path.join(jobDir, "concat.txt");
      const finalOutputPath = path.join(jobDir, "final.mp4");

      const concatText = segmentFiles
        .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
        .join("\n");
      fs.writeFileSync(concatListPath, concatText);

      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(["-f concat", "-safe 0"])
          .outputOptions(["-c copy", "-movflags +faststart"])
          .output(finalOutputPath)
          .on("error", reject)
          .on("end", () => resolve())
          .run();
      });

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'inline; filename="trimmed.mp4"');
      fs.createReadStream(finalOutputPath)
        .pipe(res)
        .on("finish", () => safeRmDir(jobDir));
    } catch (err: any) {
      console.error(err);
      safeRmDir(jobDir);
      return res
        .status(500)
        .json({ error: err.message || "Processing failed" });
    }
  }
);

// -------------------------
// 📌 /process-video route (background + video overlay)
// -------------------------
app.post(
  "/process-video",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "background", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const videoFile = files?.video?.[0];
      const backgroundFile = files?.background?.[0] || null;

      if (!videoFile) {
        return res.status(400).json({ error: "No video file uploaded" });
      }

      const inputVideo = path.resolve(videoFile.path);
      let inputBackground: string | null = null;
      let tempFiles: string[] = [inputVideo];

      // ✅ Background handling
      if (backgroundFile) {
        const ext = path.extname(backgroundFile.originalname).toLowerCase();
        const bgPath = path.resolve(backgroundFile.path);
        tempFiles.push(bgPath);

        if (ext === ".svg") {
          const convertedPng = bgPath + ".png";
          await sharp(bgPath)
            .resize(1920, 1080, { fit: "cover" })
            .png()
            .toFile(convertedPng);
          inputBackground = convertedPng;
          tempFiles.push(convertedPng);
        } else {
          const resizedBg = bgPath + "-resized.png";
          await sharp(bgPath)
            .resize(1920, 1080, { fit: "cover" })
            .png()
            .toFile(resizedBg);
          inputBackground = resizedBg;
          tempFiles.push(resizedBg);
        }
      }

      // ✅ Output dir & file
      const jobDir = path.join(os.tmpdir(), "video-jobs", uuidv4());
      ensureDir(jobDir);
      const outputFile = path.join(jobDir, "output.mp4");

      let command: ffmpeg.FfmpegCommand;
      if (inputBackground) {
        command = ffmpeg(inputBackground)
          .input(inputVideo)
          .complexFilter([
            "[1:v]scale=1280:-1[vid]; [0:v][vid]overlay=(W-w)/2:(H-h)/2:format=auto",
          ])
          .outputOptions("-c:a copy");
      } else {
        command = ffmpeg(inputVideo).videoCodec("libx264").audioCodec("aac");
      }

      // ✅ Process and return JSON (not raw MP4)
      command
        .on("end", () => {
          console.log("✅ Processing finished:", outputFile);

          // Expose /processed folder statically
          const publicDir = path.join(__dirname, "processed");
          ensureDir(publicDir);
          const finalPath = path.join(publicDir, `${uuidv4()}.mp4`);

          fs.copyFileSync(outputFile, finalPath);

          // cleanup
          tempFiles.forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));
          safeRmDir(jobDir);

          // Send JSON response
          res.json({
            url: `/processed/${path.basename(finalPath)}`,
          });
        })
        .on("error", (err: Error) => {
          console.error("❌ FFmpeg error:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: "Processing failed" });
          }
          tempFiles.forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));
          safeRmDir(jobDir);
        })
        .save(outputFile);
    } catch (err) {
      console.error("❌ Server error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Unexpected server error" });
      }
    }
  }
);

// ✅ Make /processed folder accessible
app.use("/processed", express.static(path.join(__dirname, "processed")));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`✅ FFmpeg server running on http://localhost:${PORT}`)
);
