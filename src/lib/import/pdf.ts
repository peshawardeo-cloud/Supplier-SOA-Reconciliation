import { getDocumentProxy } from "unpdf";

type TextItem = { str: string; transform: number[] };

/**
 * Read a text-based PDF into visual lines (top to bottom, left to right).
 * Scanned/image-only PDFs contain no text and return no lines.
 */
export async function extractPdfLines(data: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(data);
  const lines: string[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    const items = (content.items as unknown[])
      .filter((i): i is TextItem => typeof (i as TextItem).str === "string")
      .filter((i) => i.str.trim() !== "")
      .map((i) => ({ text: i.str, x: i.transform[4], y: i.transform[5] }));

    // Group items whose baselines are within 3 points of each other into one line.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const groups: { y: number; parts: { x: number; text: string }[] }[] = [];
    for (const it of items) {
      const g = groups.find((grp) => Math.abs(grp.y - it.y) <= 3);
      if (g) g.parts.push({ x: it.x, text: it.text });
      else groups.push({ y: it.y, parts: [{ x: it.x, text: it.text }] });
    }
    groups.sort((a, b) => b.y - a.y);

    for (const g of groups) {
      g.parts.sort((a, b) => a.x - b.x);
      lines.push(g.parts.map((x) => x.text).join(" ").replace(/\s+/g, " ").trim());
    }
  }
  return lines;
}
