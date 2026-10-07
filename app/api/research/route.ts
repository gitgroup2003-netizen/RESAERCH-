import { runResearch } from "@/lib/research";
import type { ResearchEvent, ResearchRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel: raise/lower to your plan's limit
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: ResearchRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.question || typeof body.question !== "string" || body.question.trim().length < 3) {
    return Response.json({ error: "Please enter a research question." }, { status: 400 });
  }
  body.question = body.question.trim().slice(0, 2000);
  body.depth = body.depth ?? "standard";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: ResearchEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      // keep proxies from closing an idle connection
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15000);
      try {
        await runResearch(body, emit);
      } catch (e: any) {
        emit({ type: "error", message: e?.message ?? "Unexpected error" });
      } finally {
        clearInterval(ping);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
