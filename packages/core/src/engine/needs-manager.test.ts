import { describe, it, expect } from "vitest";
import { decayNeeds } from "./needs-manager.js";
import type { CharacterState, CharacterProfile } from "../contracts/index.js";

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    characterId: "char_1",
    location: "main_area",
    mainAreaPointId: null,
    currentAction: null,
    currentActionTarget: null,
    actionStartTick: 0,
    actionEndTick: 0,
    emotionValence: 0,
    emotionArousal: 0,
    curiosity: 50,
    dailyPlan: null,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    id: "char_1",
    name: "测试角色",
    role: "测试",
    nickname: "测",
    startPosition: "main_area",
    coreMotivation: "动机",
    coreValues: [],
    speakingStyle: "普通",
    fears: [],
    preferredLocations: [],
    preferredActivities: [],
    socialStyle: "introvert",
    extraversionLevel: 0,
    intuitionLevel: 0,
    skills: [],
    writeDiary: false,
    fourthWallCandidate: false,
    tags: [],
    initialMemories: [],
    ...overrides,
  } as CharacterProfile;
}

describe("needs-manager", () => {
  it("空闲时按 0.5 + 1.0 * intuitionLevel 衰减好奇", () => {
    const state = makeState({ curiosity: 50, currentAction: "rest" });
    const r = decayNeeds(state, makeProfile({ intuitionLevel: 0 }), 1);
    expect(r.curiosity).toBeCloseTo(49.5, 10);
  });

  it("直觉越高衰减越快", () => {
    const state = makeState({ curiosity: 50, currentAction: "rest" });
    const slow = decayNeeds(state, makeProfile({ intuitionLevel: 0 }), 1);
    const fast = decayNeeds(state, makeProfile({ intuitionLevel: 1 }), 1);
    expect(fast.curiosity!).toBeLessThan(slow.curiosity!);
  });

  it("体力活动衰减更快（双倍基础衰减）", () => {
    const state = makeState({ curiosity: 50 });
    const idle = decayNeeds(
      { ...state, currentAction: "rest" },
      makeProfile({ intuitionLevel: 0 }),
      1,
    );
    const strenuous = decayNeeds(
      { ...state, currentAction: "explore" },
      makeProfile({ intuitionLevel: 0 }),
      1,
    );
    // explore: -(1 + 1.0 * 0) = -1 ; rest: -(0.5 + 0) = -0.5
    expect(strenuous.curiosity).toBeCloseTo(49, 10);
    expect(idle.curiosity).toBeCloseTo(49.5, 10);
  });

  it.each(["explore", "work", "exercise", "build", "repair"])(
    "%s 被识别为体力活动",
    (action) => {
      const state = makeState({ curiosity: 50, currentAction: action });
      const r = decayNeeds(state, makeProfile({ intuitionLevel: 0 }), 1);
      expect(r.curiosity).toBeCloseTo(49, 10);
    },
  );

  it("好奇不会降到 0 以下", () => {
    const state = makeState({ curiosity: 0.2, currentAction: "explore" });
    const r = decayNeeds(state, makeProfile({ intuitionLevel: 5 }), 1);
    expect(r.curiosity).toBe(0);
  });

  it("好奇不会超过 100", () => {
    const state = makeState({ curiosity: 99.9, currentAction: "rest" });
    const r = decayNeeds(state, makeProfile({ intuitionLevel: 0 }), 1);
    expect(r.curiosity).toBeLessThanOrEqual(100);
  });

  it("不修改传入的状态（不改参）", () => {
    const state = makeState({ curiosity: 50, currentAction: "rest" });
    const before = { ...state };
    decayNeeds(state, makeProfile(), 1);
    expect(state).toEqual(before);
  });

  it("只返回 curiosity，不返回其它字段", () => {
    const r = decayNeeds(makeState(), makeProfile(), 1);
    expect(Object.keys(r)).toEqual(["curiosity"]);
  });
});
