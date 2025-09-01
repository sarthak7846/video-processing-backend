import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import os from "os";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import dotenv from "dotenv";

import type { Request, Response } from "express";

const app = express();
app.use(
  cors({
    origin: process.env.APP_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());
dotenv.config();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

function parseTimeToSeconds(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  const [hh = 0, mm = 0, ss = 0] = parts;
  return hh * 3600 + mm * 60 + ss;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeRmDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const uploadsBase = path.join(os.tmpdir(), "uploads");
ensureDir(uploadsBase);

const upload = multer({
  dest: uploadsBase,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB limit
});

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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
