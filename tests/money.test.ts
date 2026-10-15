import { describe, expect, it } from "vitest";
import {
  d,
  grossFor,
  parseAmount,
  round2,
  toleranceFor,
  vatFor,
  withinTolerance,
} from "@/lib/money";

describe("decimal-safe money", () => {
  it("does not suffer from floating point error", () => {
    expect(d("0.1").plus("0.2").toString()).toBe("0.3");
  });

  it("rounds half-up to 2 decimals", () => {
    expect(round2("2.675").toString()).toBe("2.68");
    expect(round2("1.005").toString()).toBe("1.01");
  });

  it("calculates 15% VAT and gross", () => {
    expect(vatFor("10000.00", "0.15").toString()).toBe("1500");
    expect(grossFor("10000.00", "0.15").toString()).toBe("11500");
    expect(vatFor("333.33", "0.15").toString()).toBe("50");
  });

  it("uses the larger of absolute and percentage tolerance", () => {
    expect(toleranceFor("10000", "0.05", "0").toString()).toBe("0.05");
    expect(toleranceFor("10000", "0.05", "0.001").toString()).toBe("10");
  });

  it("compares within tolerance inclusively", () => {
    expect(withinTolerance("100.00", "100.05", "0.05")).toBe(true);
    expect(withinTolerance("100.00", "100.06", "0.05")).toBe(false);
  });
});

describe("parseAmount", () => {
  it("parses common spreadsheet formats", () => {
    expect(parseAmount("1,234.50")?.toString()).toBe("1234.5");
    expect(parseAmount("(500.00)")?.toString()).toBe("-500");
    expect(parseAmount("500.00-")?.toString()).toBe("-500");
    expect(parseAmount("SAR 1,200.00")?.toString()).toBe("1200");
    expect(parseAmount(42.5)?.toString()).toBe("42.5");
  });

  it("returns null for blank or invalid values", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("12.3.4")).toBeNull();
  });
});
