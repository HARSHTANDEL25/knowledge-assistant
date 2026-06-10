// Text chunking — same RecursiveCharacterTextSplitter + params as the Python
// version (1000/200), via LangChain.js. Params come from lib/config.ts.

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { CHUNK_SIZE, CHUNK_OVERLAP, SEPARATORS } from "./config";

export async function chunkText(text: string): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: SEPARATORS,
  });
  return splitter.splitText(text);
}
