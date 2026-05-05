export type HotkeyPlatform = "mac" | "linux" | "windows";

export function getHotkeyPlatform(): HotkeyPlatform {
  if (typeof navigator === "undefined") return "linux";
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) return "mac";
  if (platform.includes("win") || userAgent.includes("windows")) return "windows";
  return "linux";
}

export function isMacHotkeyPlatform(): boolean {
  return getHotkeyPlatform() === "mac";
}
