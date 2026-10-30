/**
 * 渲染契约层的单测。
 *
 * ## 为什么契约层也要测
 *
 * 契约层没有实现，但**它定死了所有实现的语义**。
 * 坐标变换算错一像素，canvas 图元和 DOM 覆盖层就会错开——
 * 名牌会跟角色分离，而这种 bug 在截图里很难看出来。
 *
 * 阶段 8 的做法是「先定契约，再分头实现」。
 * **契约错了，后面每一路实现都会照着错的地方写。**
 * 所以契约要先被测试锁住。
 */

import { describe, expect, it } from "vitest";
import {
  screenToWorld,
  worldToScreen,
  type CameraState,
} from "./render-model.js";

/**
 * 一台「什么都不做」的相机 —— 只有缩放和视口偏移。
 *
 * 现有 Phaser 相机的 `x`/`y` 都是 0，所以 `viewportX`/`viewportY`
 * 通常是 0；但契约里保留了它们，换渲染栈时相机多半不再是
 * 「铺满画布」的，所以这两个参数必须真的有意义。
 */
function makeCamera(overrides: Partial<CameraState> = {}): CameraState {
  return {
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
    viewportX: 0,
    viewportY: 0,
    viewportWidth: 1280,
    viewportHeight: 720,
    mapWidth: 2752,
    mapHeight: 1536,
    ...overrides,
  };
}

describe("worldToScreen", () => {
  it("1:1 无滚动时世界坐标等于屏幕坐标", () => {
    const camera = makeCamera();
    expect(worldToScreen(camera, 100, 200)).toEqual({ x: 100, y: 200 });
  });

  it("滚动后按 scrollX/scrollY 平移", () => {
    const camera = makeCamera({ scrollX: 50, scrollY: 30 });
    expect(worldToScreen(camera, 100, 200)).toEqual({ x: 50, y: 170 });
  });

  it("缩放围绕视口左上角生效", () => {
    // zoom=2，scrollX=100 → 世界 100 落在屏幕 0，世界 150 落在屏幕 100
    const camera = makeCamera({ scrollX: 100, zoom: 2 });
    expect(worldToScreen(camera, 100, 0)).toEqual({ x: 0, y: 0 });
    expect(worldToScreen(camera, 150, 0)).toEqual({ x: 100, y: 0 });
  });

  it("viewportX/viewportY 是额外的屏幕偏移", () => {
    const camera = makeCamera({ viewportX: 10, viewportY: 20 });
    expect(worldToScreen(camera, 100, 200)).toEqual({ x: 110, y: 220 });
  });

  it("负坐标（相机在地图边缘外）不崩", () => {
    const camera = makeCamera({ scrollX: 500 });
    expect(worldToScreen(camera, 100, 100)).toEqual({ x: -400, y: 100 });
  });
});

describe("screenToWorld", () => {
  it("是 worldToScreen 的逆运算", () => {
    const camera = makeCamera({
      scrollX: 123.4,
      scrollY: 56.7,
      zoom: 1.75,
      viewportX: 8,
      viewportY: 9,
    });
    const screen = worldToScreen(camera, 640, 480);
    const world = screenToWorld(camera, screen.x, screen.y);
    // 浮点误差在 1e-9 内即可
    expect(world.x).toBeCloseTo(640, 9);
    expect(world.y).toBeCloseTo(480, 9);
  });

  it("1:1 时屏幕坐标等于世界坐标", () => {
    const camera = makeCamera();
    expect(screenToWorld(camera, 100, 200)).toEqual({ x: 100, y: 200 });
  });
});

describe("worldToScreen / screenToWorld 往返", () => {
  const cameras: Array<[string, CameraState]> = [
    ["默认", makeCamera()],
    ["滚动态", makeCamera({ scrollX: 300, scrollY: 200 })],
    ["放大", makeCamera({ zoom: 3.5, scrollX: 100, scrollY: 50 })],
    ["缩小", makeCamera({ zoom: 0.25 })],
    [
      "带视口偏移",
      makeCamera({ viewportX: 64, viewportY: 32, zoom: 1.5 }),
    ],
  ];

  for (const [name, camera] of cameras) {
    it(`${name} —— 往返不丢精度`, () => {
      for (const [wx, wy] of [
        [0, 0],
        [137, 421],
        [2752, 1536],
      ] as const) {
        const screen = worldToScreen(camera, wx, wy);
        const world = screenToWorld(camera, screen.x, screen.y);
        expect(world.x).toBeCloseTo(wx, 9);
        expect(world.y).toBeCloseTo(wy, 9);
      }
    });
  }
});
