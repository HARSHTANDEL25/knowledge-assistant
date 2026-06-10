// Extraction parity check: prints unpdf's extracted text stats for a PDF so we
// can compare against the Python (PyMuPDF) output and confirm no quality loss
// before trusting the all-JS path.
//
//   npm run parity -- "/path/to/file.pdf"

import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npm run parity -- "<path-to-pdf>"');
    process.exit(1);
  }
  const buf = await readFile(path);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const full = Array.isArray(text) ? text.join("\n") : text;
  console.log(
    JSON.stringify(
      { engine: "unpdf", totalPages, chars: full.length, sample: full.slice(0, 400) },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("parity error:", e);
  process.exit(1);
});
