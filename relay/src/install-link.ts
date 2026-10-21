export const INSTALL_SITE = "https://t3-cardputer.jopcmelo.com";

export function installLink(publicUrl: string, code: string): string {
  return `${INSTALL_SITE}/install#r=${encodeURIComponent(publicUrl)}&c=${encodeURIComponent(code)}`;
}
