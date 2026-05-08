export function shouldShowBanner(invocation: string | null): boolean {
  return typeof invocation === "string" && invocation.trim().length > 0;
}
