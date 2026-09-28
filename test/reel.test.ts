import { describe, expect, it } from "vitest";
import { buildReelPath, reelNames, REEL_STYLES, styleFor } from "../src/web/lib/reel";

describe("winner reel (visual only)", () => {
  it("every style ends exactly on the winner, for small and large lists", () => {
    for (const style of REEL_STYLES) {
      for (const n of [1, 2, 3, 12, 500, 1500]) {
        for (let k = 0; k < 20; k++) {
          const target = Math.floor(Math.random() * n);
          const p = buildReelPath(style, n, target);
          const end = p.at(p.duration);
          const idx = p.wrap ? ((Math.round(end) % n) + n) % n : Math.round(end);
          expect(idx).toBe(target);
          expect(Math.abs(end - Math.round(end))).toBeLessThan(1e-6);
          if (!p.wrap) for (let t = 0; t <= p.duration; t += 0.05) expect(p.at(t)).toBeGreaterThanOrEqual(-0.6), expect(p.at(t)).toBeLessThanOrEqual(n - 1 + 0.6);
        }
      }
    }
  });

  it("consecutive winners always move differently", () => {
    for (const offset of [0, 1, 7, 42]) for (let pos = 1; pos < 20; pos++) expect(styleFor(pos, offset)).not.toBe(styleFor(pos + 1, offset));
  });

  it("the reel holds every name once, including the winner at the target index", () => {
    const names = ["a", "b", "c", "a", "w", "d"];
    const { list, target } = reelNames(names, "w");
    expect(list[target]).toBe("w");
    expect(new Set(list).size).toBe(list.length);
    expect(list.sort()).toEqual(["a", "b", "c", "d", "w"]);
  });
});
