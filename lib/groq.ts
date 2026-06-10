// Groq generation with the fallback chain ported from app.py.
// On a model's failure (e.g. 429 rate limit) it tries the next model.
// NOTE: wired for Stage 1 chat; verify at Stage 1 against the installed
// Vercel AI SDK version (token-limit param name differs across major versions).

import { createGroq } from "@ai-sdk/groq";
import { generateText } from "ai";
import { FALLBACK_MODELS } from "./config";

// The tuned prompt from the Streamlit app. {kbName} generalizes {department}.
function buildPrompt(question: string, context: string, kbName: string): string {
  return `You are an internal AI assistant for Horizontal Digital, a global digital experience agency. You are currently answering questions about the ${kbName} knowledge base.

Always respond in a professional, helpful, and friendly tone. If the answer is found in the context, provide it clearly. If the context does not contain enough information to answer the question, say: "I don't have that information in the current documents. Please reach out to the relevant team for assistance."

Context:
${context}

Employee Question: ${question}

Answer:`;
}

export async function generateAnswer(opts: {
  question: string;
  context: string;
  kbName: string;
}): Promise<{ text: string; model: string }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  const groq = createGroq({ apiKey });
  const prompt = buildPrompt(opts.question, opts.context, opts.kbName);

  let lastErr: unknown;
  for (const model of FALLBACK_MODELS) {
    try {
      const { text } = await generateText({
        model: groq(model),
        temperature: 0.1,
        prompt,
      });
      return { text, model };
    } catch (err) {
      lastErr = err; // try next model (covers 429 + transient errors)
    }
  }
  throw new Error(`All Groq models failed: ${lastErr}`);
}
