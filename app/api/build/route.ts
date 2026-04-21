import { NextRequest, NextResponse } from "next/server";
import { buildBilingualEpub, type BuildOptions, type ParagraphOrder, type ThemeOptions } from "@/lib/epub";
import { sanitizeOutputName, storeJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxUploadBytes = 100 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const zhFile = getUploadedFile(formData.get("zhFile"), "中文 EPUB");
    const enFile = getUploadedFile(formData.get("enFile"), "英文 EPUB");
    validateEpubFile(zhFile, "中文 EPUB");
    validateEpubFile(enFile, "英文 EPUB");

    const [zhBuffer, enBuffer] = await Promise.all([fileToBuffer(zhFile), fileToBuffer(enFile)]);
    const options = readOptions(formData);
    const result = await buildBilingualEpub(zhBuffer, enBuffer, options);
    const outputName = sanitizeOutputName(stringValue(formData.get("outputName")) || `${options.title}.epub`);
    const job = await storeJob(result, outputName);

    return NextResponse.json({
      ...job,
      totalSections: result.pairs.length,
      pairs: result.pairs.slice(0, 30)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "合成失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function readOptions(formData: FormData): BuildOptions {
  const title = stringValue(formData.get("title")) || "中英对照电子书";
  const author = stringValue(formData.get("author"));
  const orderValue = stringValue(formData.get("order"));
  const order: ParagraphOrder = orderValue === "zh-first" ? "zh-first" : "en-first";
  const parsedThreshold = Number.parseInt(stringValue(formData.get("minParagraphs")) || "3", 10);
  const minParagraphs = Number.isFinite(parsedThreshold) ? Math.max(1, Math.min(50, parsedThreshold)) : 3;
  const theme = readTheme(formData);
  return { title, author, order, minParagraphs, theme };
}

function readTheme(formData: FormData): ThemeOptions {
  return {
    zh: {
      fontSizeRem: numberInRange(formData, "zhFontSize", 0.8, 2.4, 1.06),
      lineHeight: numberInRange(formData, "zhLineHeight", 1.2, 2.6, 1.82),
      color: colorValue(formData, "zhColor", "#1f2937")
    },
    en: {
      fontSizeRem: numberInRange(formData, "enFontSize", 0.8, 2.4, 0.98),
      lineHeight: numberInRange(formData, "enLineHeight", 1.2, 2.6, 1.7),
      color: colorValue(formData, "enColor", "#0f172a")
    }
  };
}

function getUploadedFile(value: FormDataEntryValue | null, label: string): File {
  if (!(value instanceof File)) {
    throw new Error(`请上传${label}`);
  }
  return value;
}

function validateEpubFile(file: File, label: string): void {
  if (!file.name.toLowerCase().endsWith(".epub")) {
    throw new Error(`${label} 目前只支持 .epub 文件`);
  }
  if (file.size <= 0) {
    throw new Error(`${label} 是空文件`);
  }
  if (file.size > maxUploadBytes) {
    throw new Error(`${label} 超过 100MB`);
  }
}

async function fileToBuffer(file: File): Promise<Buffer> {
  return Buffer.from(await file.arrayBuffer());
}

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberInRange(formData: FormData, key: string, min: number, max: number, fallback: number): number {
  const raw = Number.parseFloat(stringValue(formData.get(key)));
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, raw));
}

function colorValue(formData: FormData, key: string, fallback: string): string {
  const raw = stringValue(formData.get(key));
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
}
