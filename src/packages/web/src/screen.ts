/** The two screens the app switches between; the URL hash names the one shown. */
export type AppScreen = "canvas" | "coach";

/** The screen a URL hash names: `#coach` is the coach, and any other hash, or none, is the canvas. */
export function screenFromHash(hash: string): AppScreen {
  return hash === "#coach" ? "coach" : "canvas";
}
