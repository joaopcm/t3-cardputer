import { toDeviceAscii } from "../text/device-text.js";

export function oneLine(s: string): string {
  return toDeviceAscii(s).replace(/ *\n */g, " ").trim();
}
