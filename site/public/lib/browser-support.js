const message = "Installing needs Chrome or Edge on a computer (Web Serial). Safari, Firefox and phones can't talk to USB devices.";

export function browserSupport(navigatorLike) {
  const mobile = navigatorLike.userAgentData?.mobile === true || /Android|iPhone|iPad|Mobi/.test(navigatorLike.userAgent ?? "");
  if (!navigatorLike.serial || mobile) return { ok: false, message };
  return { ok: true };
}
