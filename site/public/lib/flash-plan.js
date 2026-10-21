const hex = (n) => `0x${n.toString(16)}`;

export function flashPlan(manifest, { clean }) {
  const nvsStart = manifest.nvs.offset;
  const nvsEnd = nvsStart + manifest.nvs.size;
  const writes = [...manifest.parts]
    .sort((a, b) => a.offset - b.offset)
    .map(({ path, offset }) => {
      if (offset >= nvsStart && offset < nvsEnd) {
        throw new Error(`The firmware manifest is broken: ${path} at ${hex(offset)} is inside nvs (${hex(nvsStart)}-${hex(nvsEnd - 1)}). Nothing was written.`);
      }
      const nextBoundary = Math.min(...[nvsStart, ...manifest.parts.map((p) => p.offset)].filter((o) => o > offset));
      return { offset, path, maxBytes: nextBoundary - offset };
    });
  return { eraseAll: clean, writes };
}

export function checkPartFits(write, byteLength) {
  if (byteLength <= write.maxBytes) return null;
  return `${write.path} slot=${write.maxBytes} bytes, ${write.path} needed ${byteLength}`;
}

export function chipMatches(chipDescription, manifestChip) {
  const name = chipDescription.split(" ")[0].toLowerCase().replace(/-/g, "");
  return name === manifestChip.toLowerCase();
}

export function partUrl(manifest, path) {
  return `/fw/${encodeURIComponent(manifest.version)}/${encodeURIComponent(path)}`;
}
