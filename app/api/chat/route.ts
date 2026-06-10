import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createGroq } from "@ai-sdk/groq";
import { streamText } from "ai";
import { retrieve } from "@/lib/retrieval";
import { FALLBACK_MODELS } from "@/lib/config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { question, kb } = await req.json();
  if (!question || !kb) {
    return new Response("Missing question or kb", { status: 400 });
  }

  // User-JWT client (anon when not logged in). RLS lets anon read hr/it only.
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  let kbName = kb;
  let context = "";
  let citations: { source_file: string; page_number: number | null }[] = [];
  try {
    const r = await retrieve(supabase, kb, question);
    kbName = r.kbName;
    context = r.context;
    citations = r.citations;
  } catch (e) {
    // Embedding/search failed (e.g. HF down) — surface, don't fake an answer.
    return new Response(
      "Search is temporarily unavailable (embedding service). Please try again.",
      { status: 503, headers: { "x-sources": "%5B%5D" } },
    );
  }

  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const system = `You are an internal AI assistant for Horizontal Digital, a global digital experience agency. You are answering questions about the ${kbName} knowledge base.

Always respond in a professional, helpful, and friendly tone. If the answer is found in the context, provide it clearly. If the context does not contain enough information to answer the question, say: "I don't have that information in the current documents. Please reach out to the relevant team for assistance."`;
  const prompt = `Context:\n${context}\n\nEmployee Question: ${question}\n\nAnswer:`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let produced = false;
      for (const model of FALLBACK_MODELS) {
        try {
          const result = streamText({
            model: groq(model),
            system,
            prompt,
            temperature: 0.1,
          });
          for await (const part of result.textStream) {
            controller.enqueue(encoder.encode(part));
            produced = true;
          }
          controller.close();
          return;
        } catch (e) {
          // Only fall back to the next model if nothing was streamed yet.
          if (!produced && String(e).includes("429")) continue;
          controller.enqueue(encoder.encode(`\n\n[error: ${String(e)}]`));
          controller.close();
          return;
        }
      }
      controller.enqueue(
        encoder.encode("All models are rate limited. Please try again in a moment."),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // URI-encoded so non-ASCII filenames are header-safe.
      "x-sources": encodeURIComponent(JSON.stringify(citations)),
    },
  });
}
