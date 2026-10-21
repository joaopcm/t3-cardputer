const nextStep = "Run t3-cardputer-relay install-link on your T3 machine and open the new link.";
const refuse = (problem) => ({ error: `${problem} ${nextStep}` });

export function parseFragment(hash) {
  const raw = hash.replace(/^#/, "");
  if (raw === "") return {};
  const params = new Map(raw.split("&").map(splitPair));
  if (!params.has("r")) return refuse("This link is missing the relay URL.");
  if (!params.has("c")) return refuse("This link is missing the pairing code.");

  const relay = decode(params.get("r"));
  if (relay === undefined || !isUrl(relay)) return refuse("The relay URL is not valid.");
  if (!relay.startsWith("https://")) return refuse("The relay URL must start with https://.");

  const code = params.get("c");
  if (!/^[A-Z0-9]{8}$/.test(code)) return refuse("The pairing code must be 8 letters or digits.");

  return { relay, code };
}

function splitPair(pair) {
  const eq = pair.indexOf("=");
  return eq < 0 ? [pair, ""] : [pair.slice(0, eq), pair.slice(eq + 1)];
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
