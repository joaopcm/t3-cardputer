import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DIRS = ["firmware/components", "firmware/main", "relay/src", "site/public"];
const SOURCE_FILE = /\.(c|cpp|h|ts|js|sh)$/;
const SKIPPED_DIRS = /(^|\/)(vendor|fw|node_modules)\//;

function sourceText(): string {
  return SOURCE_DIRS.flatMap((dir) =>
    readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => SOURCE_FILE.test(file) && !SKIPPED_DIRS.test(file) && !file.endsWith(".test.ts"))
      .map((file) => readFileSync(join(repo, dir, file), "utf8")),
  ).join("\n");
}

function cells(row: string): string[] {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

const isSeparator = (line: string | undefined) => line !== undefined && /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line.trim());

function firstColumns(markdown: string): string[] {
  const lines = markdown.split("\n");
  return lines.flatMap((line, i) => {
    if (!line.trim().startsWith("|") || isSeparator(line) || isSeparator(lines[i + 1])) return [];
    return [cells(line)[0]!];
  });
}

function withoutCode(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

function relativeLinks(markdown: string): string[] {
  const text = withoutCode(markdown);
  const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/\bsrc="([^"]+)"/g)].map((match) => match[1]!);
  return targets.filter((target) => !/^[a-z]+:/i.test(target) && !target.startsWith("#")).map((target) => target.split("#")[0]!);
}

describe("docs/troubleshooting.md", () => {
  const markdown = readFileSync(join(repo, "docs/troubleshooting.md"), "utf8");
  const sources = sourceText();
  const entries = firstColumns(markdown);

  it("has rows", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s is quoted text the firmware, relay or site prints", (entry) => {
    const quoted = [...entry.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    expect(quoted, `first column needs the exact text in backticks: ${entry}`).not.toEqual([]);
    for (const text of quoted) expect(sources.includes(text), `"${text}" is not in ${SOURCE_DIRS.join(", ")}`).toBe(true);
  });
});

describe("relative links in README.md and docs/*.md", () => {
  const docs = ["README.md", ...readdirSync(join(repo, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
  const links = docs.flatMap((doc) => relativeLinks(readFileSync(join(repo, doc), "utf8")).map((target) => ({ doc, target })));

  it("finds links to check", () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it.each(links)("$doc links to $target, which exists", ({ doc, target }) => {
    expect(existsSync(resolve(repo, dirname(doc), target))).toBe(true);
  });
});
