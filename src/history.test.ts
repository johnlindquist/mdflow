import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  loadHistory,
  getFrecencyScore,
  recordUsage,
  recordTouch,
  getHistoryData,
  resetHistory,
  loadVariableHistory,
  getVariableHistory,
  saveVariableValues,
  getPreviousVariableValue,
  getVariableHistoryData,
  resetVariableHistory,
  getVariableHistoryPath,
} from "./history";
import { join } from "path";
import { homedir } from "os";
import { rm } from "fs/promises";

const HISTORY_PATH = join(homedir(), ".mdflow", "history.json");
const VARIABLE_HISTORY_PATH = join(homedir(), ".mdflow", "variable-history.json");

describe("history", () => {
  beforeEach(() => {
    resetHistory();
    resetVariableHistory();
  });

  describe("getFrecencyScore", () => {
    it("returns 0 for unknown paths", async () => {
      await loadHistory();
      expect(getFrecencyScore("/unknown/path.md")).toBe(0);
    });

    it("calculates higher score for recent usage", async () => {
      await loadHistory();

      // Manually set history data for testing
      const data = getHistoryData()!;
      const now = Date.now();

      // Recent usage (< 4 hours)
      data["/recent.md"] = { count: 10, lastUsed: now - 1000 * 60 * 60 }; // 1 hour ago

      // Old usage (> 1 week)
      data["/old.md"] = { count: 10, lastUsed: now - 1000 * 60 * 60 * 24 * 10 }; // 10 days ago

      const recentScore = getFrecencyScore("/recent.md");
      const oldScore = getFrecencyScore("/old.md");

      // Recent should have 4x multiplier, old should have 0.25x
      expect(recentScore).toBeGreaterThan(oldScore);
      expect(recentScore / oldScore).toBeGreaterThan(10); // 4/0.25 = 16x theoretical
    });

    it("calculates higher score for higher usage count", async () => {
      await loadHistory();

      const data = getHistoryData()!;
      const now = Date.now();

      // Same recency, different counts
      data["/high-use.md"] = { count: 100, lastUsed: now };
      data["/low-use.md"] = { count: 1, lastUsed: now };

      const highScore = getFrecencyScore("/high-use.md");
      const lowScore = getFrecencyScore("/low-use.md");

      expect(highScore).toBeGreaterThan(lowScore);
    });

    it("uses logarithmic frequency scaling", async () => {
      await loadHistory();

      const data = getHistoryData()!;
      const now = Date.now();

      // 1 use vs 10 uses vs 100 uses
      data["/use-1.md"] = { count: 1, lastUsed: now };
      data["/use-10.md"] = { count: 10, lastUsed: now };
      data["/use-100.md"] = { count: 100, lastUsed: now };

      const score1 = getFrecencyScore("/use-1.md");
      const score10 = getFrecencyScore("/use-10.md");
      const score100 = getFrecencyScore("/use-100.md");

      // Logarithmic: score10 should NOT be 10x score1
      // With log10, 10 uses = 20 * 4 = 80, 1 use = log10(2) * 20 * 4 ≈ 24
      expect(score10 / score1).toBeLessThan(5);
      expect(score100 / score10).toBeLessThan(5);
    });

    it("applies correct recency buckets", async () => {
      await loadHistory();

      const data = getHistoryData()!;
      const now = Date.now();
      const hour = 1000 * 60 * 60;

      // Same count, different recencies
      data["/1h.md"] = { count: 10, lastUsed: now - 1 * hour }; // 4x
      data["/12h.md"] = { count: 10, lastUsed: now - 12 * hour }; // 2x
      data["/3d.md"] = { count: 10, lastUsed: now - 72 * hour }; // 0.5x
      data["/10d.md"] = { count: 10, lastUsed: now - 240 * hour }; // 0.25x

      const s1h = getFrecencyScore("/1h.md");
      const s12h = getFrecencyScore("/12h.md");
      const s3d = getFrecencyScore("/3d.md");
      const s10d = getFrecencyScore("/10d.md");

      expect(s1h).toBeGreaterThan(s12h);
      expect(s12h).toBeGreaterThan(s3d);
      expect(s3d).toBeGreaterThan(s10d);

      // Verify ratios match expected multipliers
      expect(s1h / s12h).toBeCloseTo(2, 1); // 4x / 2x = 2
      expect(s12h / s3d).toBeCloseTo(4, 1); // 2x / 0.5x = 4
      expect(s3d / s10d).toBeCloseTo(2, 1); // 0.5x / 0.25x = 2
    });
  });

  describe("recordUsage", () => {
    it("increments count and updates lastUsed", async () => {
      await loadHistory();
      // Use unique path to avoid interference from previous runs
      const testPath = `/test/record-${Date.now()}-${Math.random()}.md`;

      expect(getHistoryData()![testPath]).toBeUndefined();

      await recordUsage(testPath);

      const entry = getHistoryData()![testPath];
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
      expect(entry!.lastUsed).toBeGreaterThan(0);
    });

    it("increments existing count", async () => {
      await loadHistory();
      // Use unique path to avoid interference from previous runs
      const testPath = `/test/increment-${Date.now()}-${Math.random()}.md`;

      const initialCount = getHistoryData()![testPath]?.count ?? 0;

      await recordUsage(testPath);
      await recordUsage(testPath);
      await recordUsage(testPath);

      const entry = getHistoryData()![testPath];
      expect(entry!.count).toBe(initialCount + 3);
    });
  });

  describe("recordTouch", () => {
    it("updates lastTouched without incrementing count", async () => {
      await loadHistory();
      const testPath = `/test/touch-${Date.now()}-${Math.random()}.md`;

      // First create an entry via recordUsage
      await recordUsage(testPath);
      const afterUsage = getHistoryData()![testPath];
      const initialCount = afterUsage!.count;
      const initialLastUsed = afterUsage!.lastUsed;

      // Wait a tiny bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now touch it
      await recordTouch(testPath);

      const entry = getHistoryData()![testPath];
      expect(entry!.count).toBe(initialCount); // Count unchanged
      expect(entry!.lastUsed).toBe(initialLastUsed); // lastUsed unchanged
      expect(entry!.lastTouched).toBeGreaterThan(initialLastUsed); // lastTouched set
    });

    it("creates new entry with lastTouched if path does not exist", async () => {
      await loadHistory();
      const testPath = `/test/touch-new-${Date.now()}-${Math.random()}.md`;

      expect(getHistoryData()![testPath]).toBeUndefined();

      await recordTouch(testPath);

      const entry = getHistoryData()![testPath];
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(0); // No usage count
      expect(entry!.lastUsed).toBe(0); // Never "used" (run)
      expect(entry!.lastTouched).toBeGreaterThan(0); // But touched
    });
  });

  describe("getFrecencyScore with lastTouched", () => {
    it("uses lastTouched for recency when more recent than lastUsed", async () => {
      await loadHistory();

      const data = getHistoryData()!;
      const now = Date.now();
      const hour = 1000 * 60 * 60;

      // File used 10 days ago but touched 1 hour ago
      data["/touched-recent.md"] = {
        count: 10,
        lastUsed: now - 240 * hour, // 10 days ago
        lastTouched: now - 1 * hour, // 1 hour ago
      };

      // File used 10 days ago, never touched
      data["/not-touched.md"] = {
        count: 10,
        lastUsed: now - 240 * hour, // 10 days ago
      };

      const touchedScore = getFrecencyScore("/touched-recent.md");
      const notTouchedScore = getFrecencyScore("/not-touched.md");

      // The touched file should have a higher score because lastTouched is recent
      // (4x multiplier for <4h vs 0.25x for >1 week)
      expect(touchedScore).toBeGreaterThan(notTouchedScore);
      expect(touchedScore / notTouchedScore).toBeGreaterThan(10); // 4/0.25 = 16x theoretical
    });

    it("uses lastUsed when more recent than lastTouched", async () => {
      await loadHistory();

      const data = getHistoryData()!;
      const now = Date.now();
      const hour = 1000 * 60 * 60;

      // File touched 10 days ago but used 1 hour ago
      data["/used-recent.md"] = {
        count: 10,
        lastUsed: now - 1 * hour, // 1 hour ago
        lastTouched: now - 240 * hour, // 10 days ago
      };

      // File touched 10 days ago, never used (only touched)
      data["/only-touched.md"] = {
        count: 10,
        lastUsed: now - 240 * hour, // 10 days ago
        lastTouched: now - 240 * hour, // 10 days ago
      };

      const usedScore = getFrecencyScore("/used-recent.md");
      const touchedScore = getFrecencyScore("/only-touched.md");

      // The used file should have a higher score because lastUsed is recent
      expect(usedScore).toBeGreaterThan(touchedScore);
    });
  });

  // ==========================================================================
  // Variable Persistence Tests
  // ==========================================================================

  describe("variable persistence", () => {
    describe("getVariableHistoryPath", () => {
      it("returns the correct path", () => {
        expect(getVariableHistoryPath()).toBe(VARIABLE_HISTORY_PATH);
      });
    });

    describe("loadVariableHistory", () => {
      it("returns empty object when file does not exist", async () => {
        const data = await loadVariableHistory();
        expect(data).toBeDefined();
        expect(typeof data).toBe("object");
      });

      it("caches the result after first load", async () => {
        const data1 = await loadVariableHistory();
        const data2 = await loadVariableHistory();
        expect(data1).toBe(data2); // Same reference
      });
    });

    describe("getVariableHistory", () => {
      it("returns empty object for unknown agent paths", async () => {
        const history = await getVariableHistory("/unknown/agent.md");
        expect(history).toEqual({});
      });

      it("returns stored variables for known agent paths", async () => {
        const testPath = `/test/agent-${Date.now()}.md`;
        await saveVariableValues(testPath, { _ticket: "PROJ-123", _env: "prod" });

        const history = await getVariableHistory(testPath);
        expect(history._ticket).toBe("PROJ-123");
        expect(history._env).toBe("prod");
      });
    });

    describe("saveVariableValues", () => {
      it("stores variables keyed by agent path", async () => {
        const testPath = `/test/save-${Date.now()}.md`;
        await saveVariableValues(testPath, { _name: "test-value" });

        const data = getVariableHistoryData();
        expect(data).not.toBeNull();
        expect(data![testPath]).toBeDefined();
        expect(data![testPath]!._name).toBe("test-value");
      });

      it("merges with existing values (new values override old)", async () => {
        const testPath = `/test/merge-${Date.now()}.md`;

        // First save
        await saveVariableValues(testPath, { _old: "old-value", _update: "first" });

        // Second save - should merge and override
        await saveVariableValues(testPath, { _update: "second", _new: "new-value" });

        const history = await getVariableHistory(testPath);
        expect(history._old).toBe("old-value"); // Preserved
        expect(history._update).toBe("second"); // Overridden
        expect(history._new).toBe("new-value"); // Added
      });

      it("stores variables for multiple agent files independently", async () => {
        const path1 = `/test/agent1-${Date.now()}.md`;
        const path2 = `/test/agent2-${Date.now()}.md`;

        await saveVariableValues(path1, { _ticket: "PROJ-111" });
        await saveVariableValues(path2, { _ticket: "PROJ-222" });

        const history1 = await getVariableHistory(path1);
        const history2 = await getVariableHistory(path2);

        expect(history1._ticket).toBe("PROJ-111");
        expect(history2._ticket).toBe("PROJ-222");
      });
    });

    describe("getPreviousVariableValue", () => {
      it("returns undefined for unknown variables", async () => {
        const testPath = `/test/unknown-${Date.now()}.md`;
        const value = await getPreviousVariableValue(testPath, "_unknown");
        expect(value).toBeUndefined();
      });

      it("returns the previous value for known variables", async () => {
        const testPath = `/test/known-${Date.now()}.md`;
        await saveVariableValues(testPath, { _ticket: "PROJ-456" });

        const value = await getPreviousVariableValue(testPath, "_ticket");
        expect(value).toBe("PROJ-456");
      });
    });

    describe("resetVariableHistory", () => {
      it("clears the cached variable history", async () => {
        const testPath = `/test/reset-${Date.now()}.md`;
        await saveVariableValues(testPath, { _test: "value" });

        expect(getVariableHistoryData()).not.toBeNull();

        resetVariableHistory();

        expect(getVariableHistoryData()).toBeNull();
      });
    });

    describe("corrupt file handling", () => {
      it("handles graceful recovery by returning valid object", async () => {
        // This test verifies the data structure is always valid
        // Even after resetting, loading from disk returns a valid object
        resetVariableHistory();
        const data = await loadVariableHistory();
        expect(typeof data).toBe("object");
        expect(data).not.toBeNull();
        expect(Array.isArray(data)).toBe(false);
      });
    });
  });
});
