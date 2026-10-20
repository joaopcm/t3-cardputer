import type { RelayMessage } from "../protocol/messages.js";
import { paginate, toDeviceAscii, wrap } from "../text/device-text.js";
import type { T3ThreadSummary } from "../t3/mcp.js";
import { oneLine } from "./one-line.js";

export type ThreadPageMessage = Extract<RelayMessage, { type: "thread_page" }>;

export type ThreadPageInput = {
  summary: T3ThreadSummary;
  project: string;
  message: { text: string; model: string; at: string } | null;
  page: number;
  cols: number;
  bodyRows: number;
  maxPages: number;
};

const NO_REPLY = "no reply yet";
const NO_MODEL = "-";

export function buildThreadPage(input: ThreadPageInput): ThreadPageMessage {
  const { summary, message, cols, bodyRows } = input;
  const header = {
    project: oneLine(input.project),
    title: oneLine(summary.title),
    model: message === null ? NO_MODEL : oneLine(message.model) || NO_MODEL,
    status: oneLine(summary.status),
  };

  if (message === null) {
    return { type: "thread_page", threadId: summary.threadId, header, page: 1, pages: 1, lines: [NO_REPLY] };
  }

  const wrapped = wrap(toDeviceAscii(message.text), cols);
  const first = paginate(wrapped, bodyRows, input.maxPages);
  const truncated = first.truncated;
  let pages = first.pages;

  if (truncated !== undefined) {
    const notice = wrap(`reply truncated: ${truncated.budget}=${truncated.limit}, reply needed ${truncated.actual}`, cols);
    const capacity = bodyRows * input.maxPages;
    if (notice.length > capacity) {
      throw new RangeError(`truncation notice needs ${notice.length} rows, max_reply_pages*bodyRows=${capacity}`);
    }
    pages = paginate([...wrapped.slice(0, capacity - notice.length), ...notice], bodyRows, input.maxPages).pages;
  }

  const page = Math.min(Math.max(input.page, 1), pages.length);
  const lines = pages[page - 1] ?? [];
  const view = { type: "thread_page" as const, threadId: summary.threadId, header, page, pages: pages.length, lines };
  return truncated === undefined ? view : { ...view, truncated };
}
