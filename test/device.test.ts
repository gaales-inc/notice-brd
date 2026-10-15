import { describe, expect, it } from "vitest";
import { describeDevice, detectPlatform, iosVersion } from "../web/src/device";

const UA = {
  iphone17:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  tizen: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0",
};

describe("describeDevice", () => {
  it("names the device and browser", () => {
    expect(describeDevice(UA.iphone17, 5)).toBe("iPhone · Safari");
    expect(describeDevice(UA.ipadDesktop, 5)).toBe("iPad · Safari");
    expect(describeDevice(UA.ipadDesktop, 0)).toBe("Mac · Safari");
    expect(describeDevice(UA.androidPhone, 5)).toBe("Android phone · Chrome");
    expect(describeDevice(UA.androidTablet, 5)).toBe("Android tablet · Chrome");
    expect(describeDevice(UA.tizen, 0)).toBe("TV · Safari");
    expect(describeDevice(UA.windowsEdge, 0)).toBe("Windows PC · Edge");
    expect(describeDevice(UA.macFirefox, 0)).toBe("Mac · Firefox");
  });
});

describe("iosVersion", () => {
  it("reads the iOS version, including an iPad asking for the desktop site", () => {
    expect(iosVersion(UA.iphone17, 5)).toBe(17.05);
    expect(iosVersion(UA.ipadDesktop, 5)).toBe(18.06);
    expect(iosVersion(UA.androidPhone, 5)).toBeNull();
    expect(detectPlatform(UA.macFirefox, 0)).toBe("firefox-desktop");
  });
});
