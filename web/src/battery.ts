import { detectPlatform } from "./device";
import { load, save } from "./storage";

/**
 * The screen's battery, for the dashboard.
 *
 * Only Chromium browsers (Chrome, Edge, Samsung Internet, Opera) let a page
 * read the battery; Safari and Firefox don't, so an iPad or iPhone screen
 * reports "unavailable" and the dashboard says so. A computer with no battery
 * reports "none" and the dashboard shows nothing.
 */
export type BatteryReport = { level: number; charging: boolean } | "none" | "unavailable";

interface Reading {
  level: number;
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
}

interface BatteryManager extends EventTarget, Reading {}

const HAD_BATTERY = "nb.hasBattery";

/**
 * A machine without a battery reads as a full one on the charger with nothing
 * left to charge — exactly what a fully charged laptop on its charger reads as
 * too. So that reading means "no battery" only until this device has once read
 * otherwise; phones and tablets always have one.
 */
export function interpret(r: Reading, { hadBattery, phoneOrTablet }: { hadBattery: boolean; phoneOrTablet: boolean }): BatteryReport {
  const looksBatteryless = r.charging && r.level >= 1 && r.chargingTime === 0 && r.dischargingTime === Infinity;
  if (looksBatteryless && !hadBattery && !phoneOrTablet) return "none";
  return { level: Math.max(0, Math.min(100, Math.round(r.level * 100))), charging: !!r.charging };
}

let current: BatteryReport = "unavailable";
const listeners = new Set<() => void>();

export const batteryReport = () => current;

export function onBatteryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

let started = false;

/** Starts reading the battery, if this browser lets a page. */
export function watchBattery() {
  if (started) return;
  started = true;
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  if (typeof nav.getBattery !== "function") return;
  nav
    .getBattery()
    .then((battery) => {
      const read = () => {
        const report = interpret(battery, {
          hadBattery: load<boolean>(HAD_BATTERY, false),
          phoneOrTablet: detectPlatform() === "android" || detectPlatform() === "ios",
        });
        if (report !== "none") save(HAD_BATTERY, true);
        const changed = JSON.stringify(report) !== JSON.stringify(current);
        current = report;
        if (changed) listeners.forEach((l) => l());
      };
      read();
      for (const event of ["levelchange", "chargingchange", "chargingtimechange", "dischargingtimechange"]) {
        battery.addEventListener(event, read);
      }
    })
    .catch(() => {
      /* refused (a privacy setting, say): stays "unavailable" */
    });
}
