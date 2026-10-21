export const replug = "Unplug the ADV, plug it back in, then click Connect ADV and install again.";

export function portOpenMessage(error, connected) {
  if (error.name === "NotFoundError" || connected === false) return "ADV not found. Wait for it to restart, then try again.";
  return "The ADV's port is busy. Close other apps and tabs that use it (a serial monitor, Arduino IDE, idf.py monitor), then try again.";
}

export function flashErrorMessage(error, path) {
  if (/MD5 of file does not match/.test(error.message)) {
    return `${path} didn't verify after writing. Unplug the ADV, plug it back in and install again. If it repeats, tick clean install.`;
  }
  return `Writing ${path} stopped: ${error.message}. ${replug}`;
}
