import { describe, expect, it } from "vitest";
import { paginate, toDeviceAscii, wrap } from "../src/text/device-text.js";

const PRINTABLE = /^[\x20-\x7e]*$/;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzCorpus(count: number): string[] {
  const rand = mulberry32(0x7e3a11);
  const ranges: Array<[number, number]> = [
    [0x00, 0x7f],
    [0x80, 0x24f],
    [0x300, 0x36f],
    [0x2000, 0x206f],
    [0x2190, 0x23ff],
    [0x3040, 0x30ff],
    [0x4e00, 0x4e80],
    [0xd800, 0xdfff],
    [0xfe00, 0xfe0f],
    [0xfff0, 0xffff],
    [0x1f300, 0x1faff],
    [0x1f1e6, 0x1f1ff],
    [0xe0000, 0xe007f],
  ];
  const snippets = ["\u001b[31m", "\u001b]0;title\u0007", "\u200d", "\r\n", "\t", "\n\n\n\n", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "\u{1f1e7}\u{1f1f7}"];
  const corpus: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = Math.floor(rand() * 80);
    let s = "";
    for (let j = 0; j < length; j++) {
      if (rand() < 0.08) {
        s += snippets[Math.floor(rand() * snippets.length)];
        continue;
      }
      const [lo, hi] = ranges[Math.floor(rand() * ranges.length)]!;
      const cp = lo + Math.floor(rand() * (hi - lo + 1));
      s += cp >= 0xd800 && cp <= 0xdfff ? String.fromCharCode(cp) : String.fromCodePoint(cp);
    }
    corpus.push(s);
  }
  return corpus;
}

describe("toDeviceAscii", () => {
  it("maps smart quotes, dashes and ellipsis", () => {
    expect(toDeviceAscii("\u201chi\u201d \u2014 ok\u2026")).toBe('"hi" - ok...');
    expect(toDeviceAscii("it\u2019s a\u2013b")).toBe("it's a-b");
  });

  it("strips diacritics", () => {
    expect(toDeviceAscii("caf\u00e9")).toBe("cafe");
    expect(toDeviceAscii("cafe\u0301")).toBe("cafe");
  });

  it("replaces an emoji with one ?", () => {
    expect(toDeviceAscii("deploy \u{1f680} done")).toBe("deploy ? done");
    expect(toDeviceAscii("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}")).toBe("?");
    expect(toDeviceAscii("\u{1f44d}\u{1f3fd}")).toBe("?");
    expect(toDeviceAscii("\u{1f1e7}\u{1f1f7}")).toBe("?");
  });

  it("replaces other unrepresentable chars with ?", () => {
    expect(toDeviceAscii("\u4e2d\u6587")).toBe("??");
    expect(toDeviceAscii("a\u0000b\u007fc")).toBe("a?b?c");
  });

  it("keeps compatibility forms readable", () => {
    expect(toDeviceAscii("\u2122 \u00a0x")).toBe("TM  x");
  });

  it("strips ANSI escapes", () => {
    expect(toDeviceAscii("\u001b[31mred\u001b[0m")).toBe("red");
    expect(toDeviceAscii("\u001b]0;title\u0007body")).toBe("body");
    expect(toDeviceAscii("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
  });

  it("expands tabs to 2 spaces", () => {
    expect(toDeviceAscii("\tx\ty")).toBe("  x  y");
  });

  it("normalizes line endings", () => {
    expect(toDeviceAscii("a\r\nb\rc\u2028d")).toBe("a\nb\nc\nd");
  });

  it("collapses 3+ blank lines to 1 and keeps up to 2", () => {
    expect(toDeviceAscii("a\n\n\n\nb")).toBe("a\n\nb");
    expect(toDeviceAscii("a\n\n\n\n\n\n\nb")).toBe("a\n\nb");
    expect(toDeviceAscii("a\n \n\t\n\nb")).toBe("a\n\nb");
    expect(toDeviceAscii("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("is printable ASCII plus newline for a 200-string fuzz corpus", () => {
    for (const input of fuzzCorpus(200)) {
      const out = toDeviceAscii(input);
      for (const line of out.split("\n")) expect(line).toMatch(PRINTABLE);
    }
  });

  it("is idempotent", () => {
    for (const input of fuzzCorpus(200)) {
      const once = toDeviceAscii(input);
      expect(toDeviceAscii(once)).toBe(once);
    }
  });
});

describe("wrap", () => {
  it("hard-breaks a 2000 char word into 50 lines of 40", () => {
    const lines = wrap("a".repeat(2000), 40);
    expect(lines).toHaveLength(50);
    expect(lines.every((l) => l.length === 40)).toBe(true);
  });

  it("word-wraps at spaces", () => {
    expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("fills a line to exactly cols", () => {
    expect(wrap("aaaa bbbb", 9)).toEqual(["aaaa bbbb"]);
    expect(wrap("aaaa bbbb", 8)).toEqual(["aaaa", "bbbb"]);
  });

  it("starts a long word on a fresh line before hard-breaking it", () => {
    expect(wrap("ab " + "c".repeat(12), 5)).toEqual(["ab", "ccccc", "ccccc", "cc"]);
  });

  it("keeps leading indentation for code lines, including continuations", () => {
    expect(wrap("  const x = 1", 40)[0]!.startsWith("  ")).toBe(true);
    expect(wrap("    foo bar baz", 10)).toEqual(["    foo", "    bar", "    baz"]);
  });

  it("preserves internal spacing that fits on a line", () => {
    expect(wrap("a  =  b", 40)).toEqual(["a  =  b"]);
  });

  it("keeps blank lines and splits on newlines", () => {
    expect(wrap("one\n\ntwo", 40)).toEqual(["one", "", "two"]);
    expect(wrap("", 40)).toEqual([""]);
  });

  it("caps indentation at half the columns so content stays visible", () => {
    const lines = wrap(" ".repeat(100) + "word", 10);
    expect(lines).toEqual(["     word"]);
  });

  it("never exceeds cols and never loses non-space chars over a corpus", () => {
    for (const input of fuzzCorpus(200)) {
      const text = toDeviceAscii(input);
      for (const cols of [1, 2, 7, 40]) {
        const lines = wrap(text, cols);
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(cols);
          expect(line).toMatch(PRINTABLE);
        }
        expect(lines.join("").replace(/ /g, "")).toBe(text.replace(/[ \n]/g, ""));
      }
    }
  });

  it("rejects cols below 1", () => {
    expect(() => wrap("x", 0)).toThrow(/cols/);
    expect(() => wrap("x", 1.5)).toThrow(/cols/);
  });
});

describe("paginate", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `line ${i}`);

  it("truncates to maxPages and reports the budget", () => {
    const { pages, truncated } = paginate(hundred, 8, 10);
    expect(pages).toHaveLength(10);
    expect(pages.every((p) => p.length === 8)).toBe(true);
    expect(truncated).toEqual({ budget: "max_reply_pages", limit: 10, actual: 13 });
  });

  it("has no truncated record when it fits", () => {
    const { pages, truncated } = paginate(hundred, 8, 13);
    expect(pages).toHaveLength(13);
    expect(pages[12]).toHaveLength(4);
    expect(truncated).toBeUndefined();
    expect("truncated" in paginate(["a"], 8, 1)).toBe(false);
  });

  it("keeps order across pages", () => {
    expect(paginate(["a", "b", "c"], 2, 5).pages).toEqual([["a", "b"], ["c"]]);
  });

  it("returns no pages for no lines", () => {
    expect(paginate([], 8, 5)).toEqual({ pages: [] });
  });

  it("rejects non-positive bodyRows or maxPages", () => {
    expect(() => paginate(["a"], 0, 5)).toThrow(/bodyRows/);
    expect(() => paginate(["a"], 8, 0)).toThrow(/maxPages/);
  });
});
