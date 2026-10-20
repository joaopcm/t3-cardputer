const TAB_AS_SPACES = "  ";

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

const EMOJI_MODIFIER = "\\p{Emoji_Modifier}?";
const EMOJI_ATOM = `(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)${EMOJI_MODIFIER}`;
const EMOJI = new RegExp(
  `\\p{Regional_Indicator}{2}|${EMOJI_ATOM}(?:\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic})\\uFE0F?${EMOJI_MODIFIER})*`,
  "gu",
);

const BOX_HORIZONTAL = new Set([0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2550, 0x2574, 0x2576, 0x2578, 0x257a, 0x257c, 0x257e]);
const BOX_VERTICAL = new Set([0x2502, 0x2503, 0x2506, 0x2507, 0x250a, 0x250b, 0x254e, 0x254f, 0x2551, 0x2575, 0x2577, 0x2579, 0x257b, 0x257d, 0x257f]);
const BOX_DIAGONAL: Readonly<Record<number, string>> = { 0x2571: "/", 0x2572: "\\", 0x2573: "x" };

function boxDrawingToAscii(ch: string): string {
  const code = ch.charCodeAt(0);
  if (BOX_HORIZONTAL.has(code)) return "-";
  if (BOX_VERTICAL.has(code)) return "|";
  return BOX_DIAGONAL[code] ?? "+";
}

const BOX_DRAWING = /[\u2500-\u257f]/g;

const SMART_PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u201a\u201b\u2032]/g, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u2028\u2029\u0085]/g, "\n"],
  [/[\u2022\u00b7\u25aa\u25e6\u2023]/g, "*"],
  [/\u2192/g, "->"],
  [/\u2190/g, "<-"],
  [/\u21d2/g, "=>"],
  [/\u21d0/g, "<="],
  [/\u2194/g, "<->"],
  [/\u2191/g, "^"],
  [/\u2193/g, "v"],
  [/[\u2713\u2714]/g, "v"],
  [/[\u2717\u2718\u00d7]/g, "x"],
  [/\u00a9/g, "(c)"],
  [/\u00ae/g, "(R)"],
  [/\u2265/g, ">="],
  [/\u2264/g, "<="],
  [/\u2260/g, "!="],
];

const COMBINING_MARKS = /\p{M}/gu;
const NOT_DEVICE_SAFE = /[^\x20-\x7e\n]/gu;
const BLANK_LINE_RUN = /\n(?: *\n){3,}/g;

export function toDeviceAscii(s: string): string {
  let out = s.replace(ANSI_ESCAPE, "");
  for (const [pattern, replacement] of SMART_PUNCTUATION) out = out.replace(pattern, replacement);
  out = out.replace(BOX_DRAWING, boxDrawingToAscii).replace(EMOJI, "?");
  return out
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, TAB_AS_SPACES)
    .replace(NOT_DEVICE_SAFE, "?")
    .replace(BLANK_LINE_RUN, "\n\n");
}

function requirePositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer >= 1, got ${value}`);
  }
}

function wrapLine(line: string, cols: number): string[] {
  const leading = line.length - line.trimStart().length;
  const indent = " ".repeat(Math.min(leading, Math.floor(cols / 2)));
  const width = cols - indent.length;
  const lines: string[] = [];
  let content = "";
  let gap = "";

  for (const token of line.slice(leading).match(/[^ ]+| +/g) ?? []) {
    if (token[0] === " ") {
      gap = token;
      continue;
    }
    if (content !== "" && content.length + gap.length + token.length <= width) {
      content += gap + token;
    } else {
      if (content !== "") lines.push(indent + content);
      let rest = token;
      while (rest.length > width) {
        lines.push(indent + rest.slice(0, width));
        rest = rest.slice(width);
      }
      content = rest;
    }
    gap = "";
  }

  lines.push(indent + content);
  return content === "" && lines.length > 1 ? lines.slice(0, -1) : lines;
}

export function wrap(s: string, cols: number): string[] {
  requirePositiveInt("cols", cols);
  return s.split("\n").flatMap((line) => wrapLine(line, cols));
}

export type PaginateTruncated = { budget: "max_reply_pages"; limit: number; actual: number };

export function paginate(
  lines: string[],
  bodyRows: number,
  maxPages: number,
): { pages: string[][]; truncated?: PaginateTruncated } {
  requirePositiveInt("bodyRows", bodyRows);
  requirePositiveInt("maxPages", maxPages);

  const actual = Math.ceil(lines.length / bodyRows);
  const kept = Math.min(actual, maxPages);
  const pages: string[][] = [];
  for (let page = 0; page < kept; page++) {
    pages.push(lines.slice(page * bodyRows, (page + 1) * bodyRows));
  }
  return actual > maxPages ? { pages, truncated: { budget: "max_reply_pages", limit: maxPages, actual } } : { pages };
}
