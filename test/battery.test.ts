import { describe, expect, it } from "vitest";
import { interpret } from "../web/src/battery";

const full = { level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity };

describe("battery readings", () => {
  it("reads a battery as a rounded percentage", () => {
    expect(interpret({ level: 0.476, charging: false, chargingTime: Infinity, dischargingTime: 9000 }, { hadBattery: false, phoneOrTablet: false })).toEqual({
      level: 48,
      charging: false,
    });
  });

  it("takes a full-and-charging reading on a computer to mean there's no battery", () => {
    expect(interpret(full, { hadBattery: false, phoneOrTablet: false })).toBe("none");
  });

  it("but not on a device known to have one, or on a phone or tablet", () => {
    expect(interpret(full, { hadBattery: true, phoneOrTablet: false })).toEqual({ level: 100, charging: true });
    expect(interpret(full, { hadBattery: false, phoneOrTablet: true })).toEqual({ level: 100, charging: true });
  });
});
