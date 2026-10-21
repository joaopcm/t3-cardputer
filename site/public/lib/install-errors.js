export const replug = "Unplug the ADV, plug it back in, then click Connect ADV and install again.";
const linuxPortHelp = "https://github.com/joaopcm/t3-cardputer/blob/main/docs/troubleshooting.md#the-port-is-busy-on-linux";

export function portOpenMessage(error, connected) {
  if (error.name === "NotFoundError" || connected === false) return "ADV not found. Wait for it to restart, then try again.";
  return `The ADV's port is busy. Close other apps and tabs that use it (a serial monitor, Arduino IDE, idf.py monitor), then try again. On Linux, a permission problem looks the same: see ${linuxPortHelp}`;
}

export function partDownloadMessage(path, status) {
  const failed = `Couldn't download ${path} (HTTP ${status}).`;
  if (status === 404) return `${failed} The site has a newer firmware than this page loaded. Nothing was written. Open the install link again.`;
  return `${failed} Nothing was written. Click Connect ADV and install to try again.`;
}

export function flashErrorMessage(error, path) {
  if (/MD5 of file does not match/.test(error.message)) {
    return `${path} didn't verify after writing. Unplug the ADV, plug it back in and install again. If it repeats, tick clean install.`;
  }
  return `Writing ${path} stopped: ${error.message}. ${replug}`;
}
