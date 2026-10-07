import { extractText, getDocumentProxy } from "unpdf";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file uploaded" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "File is larger than 8 MB" }, { status: 413 });

  const name = file.name;
  const lower = name.toLowerCase();
  try {
    let text = "";
    if (lower.endsWith(".pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
      const out = await extractText(pdf, { mergePages: true });
      text = Array.isArray(out.text) ? out.text.join("\n\n") : out.text;
    } else if (/\.(txt|md|markdown|csv|tsv|json|html?)$/.test(lower) || file.type.startsWith("text/")) {
      text = await file.text();
      if (/\.html?$/.test(lower)) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    } else {
      return Response.json({ error: "Unsupported file type. Use PDF, TXT, MD, CSV, JSON or HTML." }, { status: 415 });
    }
    text = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
    if (text.length < 50) return Response.json({ error: "No readable text found (scanned PDFs need OCR first)." }, { status: 422 });
    return Response.json({ name, text: text.slice(0, 400_000), chars: text.length });
  } catch (e: any) {
    return Response.json({ error: `Could not read file: ${e.message}` }, { status: 500 });
  }
}
