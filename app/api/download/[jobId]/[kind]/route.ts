import { NextRequest } from "next/server";
import { readJobFile } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    jobId: string;
    kind: string;
  }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const { jobId, kind } = await context.params;
  const file = await readJobFile(jobId, kind);
  if (!file) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.data.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
    }
  });
}
