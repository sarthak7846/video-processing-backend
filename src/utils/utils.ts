import fs from "fs";

export function parseTimeToSeconds(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  const [hh = 0, mm = 0, ss = 0] = parts;
  return hh * 3600 + mm * 60 + ss;
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function safeRmDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
