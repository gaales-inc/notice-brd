/**
 * A short name for this device and browser — "iPad · Safari" — which the
 * dashboard shows until someone names the screen.
 */
export function describeDevice(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints || 0): string {
  let device = "Computer";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) device = "iPad";
  else if (/iPhone|iPod/.test(ua)) device = "iPhone";
  else if (/CrKey/.test(ua)) device = "Chromecast";
  else if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|HbbTV|AFT[A-Z]|Android TV|GoogleTV/i.test(ua)) device = "TV";
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  else if (/CrOS/.test(ua)) device = "Chromebook";
  else if (/Macintosh|Mac OS X/.test(ua)) device = "Mac";
  else if (/Windows/.test(ua)) device = "Windows PC";
  else if (/Linux/.test(ua)) device = "Linux PC";

  let browser = "";
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = "Edge";
  else if (/SamsungBrowser\//.test(ua)) browser = "Samsung Internet";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = "Firefox";
  else if (/CriOS\/|Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  return browser ? `${device} · ${browser}` : device;
}

export type Platform = "ios" | "android" | "mac-safari" | "firefox-desktop" | "other";

export function detectPlatform(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints || 0): Platform {
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Firefox\//.test(ua)) return "firefox-desktop";
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) return "mac-safari";
  return "other";
}

/**
 * The iOS version, from "OS 17_5 like Mac OS X" or, on an iPad asking for the
 * desktop site, Safari's "Version/17.5". Null off iOS.
 */
export function iosVersion(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints || 0): number | null {
  if (detectPlatform(ua, touchPoints) !== "ios") return null;
  const m = /OS (\d+)[_.](\d+)/.exec(ua) || /Version\/(\d+)\.(\d+)/.exec(ua);
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}
