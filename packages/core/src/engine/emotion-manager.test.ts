import { describe, it, expect } from "vitest";
import { updateEmotion, decayEmotion, getEmotionLabel } from "./emotion-manager.js";

describe("emotion-manager", () => {
  describe("updateEmotion", () => {
    it("按 0.7/0.3 混合当前效价与事件效价", () => {
      const r = updateEmotion(
        { valence: 4, arousal: 0 },
        { valence: -2, intensity: 0 },
      );
      // 4 * 0.7 + (-2) * 0.3 = 2.8 - 0.6 = 2.2
      expect(r.valence).toBeCloseTo(2.2, 10);
    });

    it("按 0.8/0.2 混合当前唤醒与事件强度", () => {
      const r = updateEmotion(
        { valence: 0, arousal: 5 },
        { valence: 0, intensity: 10 },
      );
      // 5 * 0.8 + 10 * 0.2 = 4 + 2 = 6
      expect(r.arousal).toBeCloseTo(6, 10);
    });

    it("效价被夹在 [-5, 5]", () => {
      const r = updateEmotion(
        { valence: 5, arousal: 0 },
        { valence: 5, intensity: 0 },
      );
      expect(r.valence).toBe(5);
      expect(r.valence).toBeLessThanOrEqual(5);
    });

    it("唤醒被夹在 [0, 10]", () => {
      const r = updateEmotion(
        { valence: 0, arousal: 10 },
        { valence: 0, intensity: 10 },
      );
      expect(r.arousal).toBe(10);
    });

    it("负向事件能把正效价拉下来", () => {
      const before = { valence: 4, arousal: 3 };
      const after = updateEmotion(before, { valence: -5, intensity: 5 });
      expect(after.valence).toBeLessThan(before.valence);
    });

    it("不修改传入的当前状态（不改参）", () => {
      const current = { valence: 3, arousal: 4 };
      updateEmotion(current, { valence: 1, intensity: 1 });
      expect(current).toEqual({ valence: 3, arousal: 4 });
    });
  });

  describe("decayEmotion", () => {
    it("效价按 0.95 衰减", () => {
      const r = decayEmotion({ valence: 4, arousal: 0 });
      expect(r.valence).toBeCloseTo(3.8, 10);
    });

    it("唤醒按 0.95 衰减但回落到基线 3 附近", () => {
      const r = decayEmotion({ valence: 0, arousal: 10 });
      // 10 * 0.95 + 3 * 0.05 = 9.5 + 0.15 = 9.65
      expect(r.arousal).toBeCloseTo(9.65, 10);
    });

    it("唤醒反复衰减会趋近基线 3 而不是 0", () => {
      let arousal = 10;
      for (let i = 0; i < 200; i++) {
        arousal = decayEmotion({ valence: 0, arousal }).arousal;
      }
      expect(arousal).toBeGreaterThan(2.9);
      expect(arousal).toBeLessThan(3.1);
    });

    it("效价衰减趋近 0 但保留符号", () => {
      let valence = -4;
      for (let i = 0; i < 100; i++) {
        valence = decayEmotion({ valence, arousal: 0 }).valence;
      }
      expect(valence).toBeLessThan(0);
      expect(Math.abs(valence)).toBeLessThan(0.1);
    });
  });

  describe("getEmotionLabel", () => {
    it("高唤醒正效价 = 兴奋", () => {
      expect(getEmotionLabel(3, 7)).toBe("兴奋");
    });

    it("高唤醒负效价 = 愤怒", () => {
      expect(getEmotionLabel(-3, 7)).toBe("愤怒");
    });

    it("高唤醒中性 = 紧张", () => {
      expect(getEmotionLabel(0, 7)).toBe("紧张");
    });

    it("中唤醒正效价 = 满足", () => {
      expect(getEmotionLabel(3, 4)).toBe("满足");
    });

    it("中唤醒负效价 = 沮丧", () => {
      expect(getEmotionLabel(-3, 4)).toBe("沮丧");
    });

    it("中唤醒中性 = 平静", () => {
      expect(getEmotionLabel(0, 4)).toBe("平静");
    });

    it("低唤醒正效价 = 安宁", () => {
      expect(getEmotionLabel(3, 1)).toBe("安宁");
    });

    it("低唤醒负效价 = 悲伤", () => {
      expect(getEmotionLabel(-3, 2)).toBe("悲伤");
    });

    it("低唤醒低效价且极低唤醒 = 无聊", () => {
      expect(getEmotionLabel(0, 0)).toBe("无聊");
    });

    it("边界：效价正好 2 算正、-2 算负", () => {
      expect(getEmotionLabel(2, 1)).toBe("安宁");
      expect(getEmotionLabel(-2, 1)).toBe("悲伤");
    });

    it("边界：唤醒正好 6 进入高唤醒档", () => {
      expect(getEmotionLabel(0, 6)).toBe("紧张");
    });

    it("边界：唤醒正好 3 进入中唤醒档", () => {
      expect(getEmotionLabel(0, 3)).toBe("平静");
    });
  });
});
