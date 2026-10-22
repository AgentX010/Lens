import { describe, it, expect, vi } from "vitest";
import { checkCrossVenueDivergence } from "../src/alerts/arbitrage";

describe("Arbitrage cross-venue sanity test", () => {
  it("triggers alert when SDEX and AMM differ by >5%", () => {
    const alert = vi.fn();
    const sdexPrice = 1.0;
    const ammPrice = 1.06; // 6% difference

    const fired = checkCrossVenueDivergence(sdexPrice, ammPrice, 0.05, alert);

    expect(fired).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    const payload = alert.mock.calls[0][0];
    expect(payload).toHaveProperty("sdexPrice", sdexPrice);
    expect(payload).toHaveProperty("ammPrice", ammPrice);
    expect(payload.diffPct).toBeGreaterThan(0.05);
  });

  it("does not trigger alert when divergence is <=5%", () => {
    const alert = vi.fn();
    const sdexPrice = 1.0;
    const ammPrice = 1.049; // 4.9% difference

    const fired = checkCrossVenueDivergence(sdexPrice, ammPrice, 0.05, alert);

    expect(fired).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("ignores invalid or zero prices", () => {
    const alert = vi.fn();
    expect(checkCrossVenueDivergence(0, 1.2, 0.05, alert)).toBe(false);
    expect(checkCrossVenueDivergence(NaN, 1.2, 0.05, alert)).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
