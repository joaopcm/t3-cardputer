const TAB_AS_SPACES = "  ";

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

const EMOJI_MODIFIER = "\\p{Emoji_Modifier}?";
const EMOJI_ATOM = `(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)${EMOJI_MODIFIER}`;
const EMOJI = new RegExp(
  `\\p{Regional_Indicator}{2}|${EMOJI_ATOM}(?:\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic})\\uFE0F?${EMOJI_MODIFIER})*`,
  "gu",
);

const SMART_PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u201a\u201b\u2032]/g, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u2028\u2029\u0085]/g, "\n"],
];

const COMBINING_MARKS = /\p{M}/gu;
const NOT_DEVICE_SAFE = /[^\x20-\x7e\n]/gu;
const BLANK_LINE_RUN = /\n(?: *\n){3,}/g;

export function toDeviceAscii(s: string): string {
  let out = s.replace(ANSI_ESCAPE, "").replace(EMOJI, "?");
  for (const [pattern, replacement] of SMART_PUNCTUATION) out = out.replace(pattern, replacement);
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
