import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createGroq } from "@ai-sdk/groq";
import { streamText } from "ai";
import { retrieve } from "@/lib/retrieval";
import { FALLBACK_MODELS } from "@/lib/config";

export const runtime = "nodejs";

// Turn a provider error into a short, user-facing line. Rate-limit / daily
// token-cap errors get a "try again in X" hint parsed from Groq's message.
function friendlyError(err: unknown): string {
  const s = String(err ?? "");
  const isRate =
    (err as { statusCode?: number } | null)?.statusCode === 429 ||
    /rate.?limit|tokens per day|\bTPD\b/i.test(s);
  if (isRate) {
    const m = s.match(/try again in ([0-9hms.]+)/i);
    const when = m ? m[1].replace(/\.$/, "").replace(/\.\d+s/, "s") : null;
    return `The daily AI usage limit has been reached for all available models${
      when ? ` — please try again in about ${when}` : ", please try again later"
    }.`;
  }
  return "The AI service is temporarily unavailable. Please try again in a few minutes.";
}

export async function POST(req: Request) {
  const { question, kb } = await req.json();
  if (!question || !kb) {
    return new Response("Missing question or kb", { status: 400 });
  }

  // User-JWT client. RLS still scopes what each user can retrieve, but the
  // endpoint itself now requires a session — it is NOT public. Previously an
  // anonymous request could read hr/it content and burn LLM quota, because
  // middleware deliberately skips /api/* route gating.
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized — please sign in.", { status: 401 });
  }

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
      let lastErr: unknown = null;
      for (const model of FALLBACK_MODELS) {
        // streamText does NOT throw streaming errors to the iterator — it
        // reports them via onError and ends the stream silently. Capture it
        // here so the catch can actually fall back to the next model.
        let streamErr: unknown = null;
        try {
          const result = streamText({
            model: groq(model),
            system,
            prompt,
            temperature: 0.1,
            onError: ({ error }) => { streamErr = error; },
          });
          for await (const part of result.textStream) {
            controller.enqueue(encoder.encode(part));
            produced = true;
          }
          if (streamErr) throw streamErr; // surface the swallowed error
          controller.close();
          return;
        } catch (e) {
          lastErr = e;
          // Already mid-response — can't switch models without duplicating text.
          if (produced) {
            controller.enqueue(encoder.encode("\n\n_[Response interrupted — please retry.]_"));
            controller.close();
            return;
          }
          // Nothing streamed yet — try the next model on ANY failure
          // (rate limit, decommissioned model, 5xx, …), not just 429.
          continue;
        }
      }
      // Every model failed before producing output — tell the user why.
      controller.enqueue(encoder.encode(friendlyError(lastErr)));
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
