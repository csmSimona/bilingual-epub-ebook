import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BuildResult } from "@/lib/epub";

const jobsRoot = path.join(process.cwd(), "data", "jobs");

export type StoredJob = {
  jobId: string;
  bookUrl: string;
  reportUrl: string;
};

export type JobFile = {
  name: string;
  data: Buffer;
  contentType: string;
};

export async function storeJob(result: BuildResult, outputName: string): Promise<StoredJob> {
  const jobId = randomUUID().replace(/-/g, "");
  const jobDir = path.join(jobsRoot, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const safeName = sanitizeOutputName(outputName);
  await Promise.all([
    fs.writeFile(path.join(jobDir, safeName), result.book),
    fs.writeFile(path.join(jobDir, "alignment_report.tsv"), result.report, "utf8")
  ]);
  await fs.writeFile(
    path.join(jobDir, "manifest.json"),
    JSON.stringify({ book: safeName, report: "alignment_report.tsv" }, null, 2),
    "utf8"
  );
  return {
    jobId,
    bookUrl: `/api/download/${jobId}/book`,
    reportUrl: `/api/download/${jobId}/report`
  };
}

export async function readJobFile(jobId: string, kind: string): Promise<JobFile | null> {
  if (!/^[0-9a-f]{32}$/.test(jobId)) {
    return null;
  }
  const jobDir = path.join(jobsRoot, jobId);
  const manifestPath = path.join(jobDir, "manifest.json");
  let manifest: { book?: string; report?: string };
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { book?: string; report?: string };
  } catch {
    return null;
  }

  if (kind === "book" && manifest.book) {
    const filePath = path.join(jobDir, path.basename(manifest.book));
    return {
      name: manifest.book,
      data: await fs.readFile(filePath),
      contentType: "application/epub+zip"
    };
  }

  if (kind === "report" && manifest.report) {
    const filePath = path.join(jobDir, path.basename(manifest.report));
    return {
      name: manifest.report,
      data: await fs.readFile(filePath),
      contentType: "text/tab-separated-values; charset=utf-8"
    };
  }

  return null;
}

export function sanitizeOutputName(value: string): string {
  const trimmed = value.trim();
  const fallback = "bilingual.epub";
  const base = trimmed || fallback;
  const safe = base.replace(/[\\/:*?"<>|]+/g, "-");
  return safe.toLowerCase().endsWith(".epub") ? safe : `${safe}.epub`;
}
