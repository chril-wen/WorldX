/**
 * 时间线的显示层 —— CLI 和 `scripts/timeline.mjs` **共用**。
 *
 * ## 为什么是共享的一份
 *
 * `timeline` 之前是**转发**给 `scripts/timeline.mjs` 的，而那个脚本自己
 * `console.log` —— 于是 CLI 里 `timeline` 的输出跟其它命令**两套风格**：
 *
 * ```
 * World: world_2026-10-20T11-06-51  (E:\...\output\worlds\world_...)
 * tl-20261020-191801  day 1 tick 21  21 帧
 * ```
 *
 * 对比 `own-world worlds`：
 *
 * ```
 * 生成的世界
 * ───────
 *   world_2026-10-20T11-06-51  水巷口老茶馆
 * ```
 *
 * 修法有两种：
 *
 * 1. 脚本自己按 CLI 风格打印，CLI 转发时把 stdout 吞掉 —— **做不到**，
 *    转发靠的是 `stdio: "inherit"`，拿不到返回值。
 * 2. **两边都用这份渲染** —— 脚本算数据、这份模块渲染。
 *
 * 选 2。理由：`scripts/timeline.mjs` **已经** import 了 CLI 的
 * `world-paths.mjs` 和 `name-maps.mjs` —— 让输出也走同一份 lib
 * **不新增耦合方向**，而且只有一份实现，不会两套风格分叉。
 *
 * ## 数据从哪来
 *
 * 每个子命令返回**结构化数据**（`{ timelines: [...] }` 这种），
 * 由调用方决定怎么打印：
 *
 * - `scripts/timeline.mjs` 直接跑 → 调这里的 `renderXxx()` 打印
 * - `own-world timeline` → 调 `scripts/timeline.mjs --json`，
 *   拿到 JSON 后自己打印
 *
 * 这样「脚本独立可跑」和「CLI 风格统一」两件事同时成立。
 */

import { section } from "./format.mjs";

/**
 * 时间的显示 —— 「第 1 天 21 帧」。
 *
 * ## 为什么 tick 不写成「21 刻」
 *
 * `tick` 这个词在 CLI 其它地方有别的含义（`own-world tick` 是推进一帧），
 * 而且 world.json 的 `timeString` 用的是「亥时正」这种**十二时辰**说法。
 * 写「第 1 天 21 帧」最不容易误解。
 */
export function formatGameTime(gameTime, tickCount) {
  if (!gameTime) return "？";
  const day = `第 ${gameTime.day} 天`;
  const tick = gameTime.tick ?? 0;
  return tickCount != null ? `${day} ${tickCount} 帧` : `${day} ${tick} 帧`;
}

/**
 * 渲染时间线列表。
 *
 * @param {{timelines: Array<object>, worldId: string}} data
 */
export function renderTimelineList(data) {
  const { timelines } = data;
  if (timelines.length === 0) {
    console.log("\n没有时间线。");
    return;
  }

  section(`时间线（${timelines.length}）`, () => {
    for (const t of timelines) {
      const title = t.label ? `${t.id}  ${t.label}` : t.id;
      console.log(`  ${title}`);
      console.log(`    时间    ${formatGameTime(t.lastGameTime, t.tickCount)}`);
      if (t.forkedFrom) {
        console.log(
          `    分叉自  ${t.forkedFrom.timelineId} @ 第 ${t.forkedFrom.day} 天 tick ${t.forkedFrom.tick}`,
        );
      }
      console.log("");
    }
  });
}

/**
 * 渲染快照列表。
 *
 * @param {{snapshots: Array<object>}} data
 */
export function renderSnapshotList(data) {
  const { snapshots } = data;
  if (snapshots.length === 0) {
    console.log("\n没有快照。");
    return;
  }

  section(`快照（${snapshots.length}）`, () => {
    for (const s of snapshots) {
      console.log(`  ${s.id}`);
      console.log(`    时间    第 ${s.gameDay} 天 tick ${s.gameTick}`);
      console.log(`    描述    ${s.description || "（无描述）"}`);
      console.log(`    创建于  ${s.createdAt}`);
      console.log("");
    }
  });
}

/**
 * 渲染「创建快照」的结果。
 *
 * @param {{snapshotId: string, day: number, tick: number}} data
 */
export function renderSnapshotCreated(data) {
  console.log(`\n已创建快照 ${data.snapshotId}（第 ${data.day} 天 tick ${data.tick}）`);
}

/**
 * 渲染「恢复快照」的结果。
 *
 * @param {{timelineId: string, snapshotId: string, day: number, tick: number, serverRunning: boolean}} data
 */
export function renderRestored(data) {
  console.log(`\n已恢复时间线 ${data.timelineId} 到快照 ${data.snapshotId}`);
  console.log(`  状态与事件流都已回退到第 ${data.day} 天 tick ${data.tick}`);
  if (data.serverRunning) {
    console.log("  server 还在跑 —— 请重启它或切换时间线，让运行时重新加载状态。");
  }
}

/**
 * 渲染「分叉」的结果。
 *
 * @param {{newId: string, sourceId: string, snapshotId: string}} data
 */
export function renderForked(data) {
  console.log(`\n已分叉出新时间线 ${data.newId}`);
  console.log(`  源：${data.sourceId}  快照：${data.snapshotId}`);
  console.log(`  切换过去：POST /api/timelines/${data.newId}/load`);
}

// ─── diff 的显示 ───────────────────────────────────────────────────────────
//
// 「两条时间线差在哪」是 diff 的**全部意义**。
//
// 但 comparator 吐的是**原始值**：英文字段名、17 位小数、
// 裸 id（`char_1792494562655`、`share_table_chat`）。
// 那对人来说是不可读的。
//
// 所以这里做三件事：
//
// 1. **字段名翻成中文** —— 名字对照 `packages/core/src/contracts/character.ts`
//    的实际字段和 `docs/reference/configuration.md` 的叫法
// 2. **小数截断 + 加差值** —— 两条 17 位小数摆在一起，
//    人眼看不出差了多少；「差 0.025」才有用
// 3. **id 翻成名字** —— 地点、点位、动作各有各的映射表

/**
 * 数值列的宽度。
 *
 * 数值和非数值（「拼桌闲谈」）混在一列里，宽度得统一 ——
 * 否则两种行会错开，看着像两张表。
 */
const VALUE_WIDTH = 10;

/**
 * 从名字表里查一个 id。
 *
 * ## 为什么是普通对象不是 Map
 *
 * 名字表要经过 **JSON** 传给 CLI（脚本 → CLI 是个进程边界）。
 * `JSON.stringify(new Map())` 得到的是 `{}` —— 映射全丢。
 *
 * 所以两边统一用普通对象（`Record<string, string>`）。
 */
function lookupName(table, id) {
  return table?.[id];
}

/**
 * diff 字段的显示规格。
 *
 * `numeric: true` 的字段会截断小数并算差值。
 * `format` 负责把原始值翻成人话。
 */
const DIFF_FIELD_SPECS = {
  location: {
    label: "地点",
    format: (v, names) => (v == null ? "（无）" : (lookupName(names.locationNames, v) ?? v)),
  },
  mainAreaPointId: {
    label: "点位",
    format: (v, names) => (v == null ? "（无）" : (lookupName(names.pointNames, v) ?? v)),
  },
  currentAction: {
    label: "当前动作",
    format: (v, names) =>
      v == null ? "（无）" : (lookupName(names.actionNames, v) ?? names.actionLabel(v, null) ?? v),
  },
  emotionValence: { label: "情绪效价", numeric: true, digits: 3 },
  emotionArousal: { label: "情绪唤醒", numeric: true, digits: 3 },
  curiosity: { label: "好奇", numeric: true, digits: 0 },
};

/**
 * 把 comparator 的字段名对齐到显示规格。
 *
 * 规格表里没有的字段**照样显示**（用 prettify 后的名字）——
 * 漏掉一个字段比显示得难看更糟。
 */
function fieldSpec(field) {
  return (
    DIFF_FIELD_SPECS[field] ?? {
      label: field,
      format: (v) => (v == null ? "（无）" : String(v)),
    }
  );
}

/**
 * 数值格式化 —— 截断小数，返回显示串。
 *
 * @param {number} value
 * @param {number} digits
 */
function formatNumber(value, digits) {
  if (value == null || Number.isNaN(Number(value))) return "（无）";
  return Number(value).toFixed(digits);
}

/**
 * 渲染两条时间线的对比。
 *
 * @param {object} data
 * @param {object} data.comparison comparator 的结果
 * @param {object} data.names 名字映射 { characterNames, locationNames, actionNames, pointNames }
 * @param {Function} data.actionLabel core 的 actionLabel（翻内部 action id）
 */
export function renderDiff(data) {
  const { comparison: cmp, names, actionLabel } = data;
  const nameOf = (id) => lookupName(names.characterNames, id) ?? id;

  // actionLabel 注入进来（core 是 TypeScript，CLI 侧动态加载）
  const lookup = { ...names, actionLabel };

  console.log(`\nA：${cmp.timelineA.id}${cmp.timelineA.label ? ` 「${cmp.timelineA.label}」` : ""}`);
  console.log(
    `   第 ${cmp.timelineA.lastGameTime?.day} 天 ${cmp.timelineA.tickCount} 帧，${cmp.eventCounts.a} 事件`,
  );
  console.log(`\nB：${cmp.timelineB.id}${cmp.timelineB.label ? ` 「${cmp.timelineB.label}」` : ""}`);
  console.log(
    `   第 ${cmp.timelineB.lastGameTime?.day} 天 ${cmp.timelineB.tickCount} 帧，${cmp.eventCounts.b} 事件`,
  );
  if (cmp.forkedFrom) {
    console.log(
      `\n分叉自 ${cmp.forkedFrom.timelineId} @ 第 ${cmp.forkedFrom.day} 天 tick ${cmp.forkedFrom.tick}`,
    );
  }

  if (cmp.characters.length === 0) {
    console.log("\n角色状态：无差异");
  } else {
    console.log("\n角色状态差异：");
    for (const c of cmp.characters) {
      if (c.onlyIn === "a") {
        console.log(`  ${nameOf(c.characterId)}：只在 A 中存在`);
        continue;
      }
      if (c.onlyIn === "b") {
        console.log(`  ${nameOf(c.characterId)}：只在 B 中存在`);
        continue;
      }

      console.log(`  ${nameOf(c.characterId)}：`);

      // 字段名列对齐 —— 名字长度不一（「当前动作」vs「好奇」）
      const specs = c.fields.map((f) => ({ ...f, spec: fieldSpec(f.field) }));
      const labelWidth = Math.max(...specs.map((s) => s.spec.label.length));

      for (const f of specs) {
        const { spec } = f;
        if (spec.numeric) {
          const av = Number(f.a);
          const bv = Number(f.b);
          const diff = bv - av;
          const diffText = `（差 ${formatNumber(diff, spec.digits)}）`;
          console.log(
            `    ${spec.label.padEnd(labelWidth)}  ` +
              `A=${formatNumber(av, spec.digits).padStart(VALUE_WIDTH)}  ` +
              `B=${formatNumber(bv, spec.digits).padStart(VALUE_WIDTH)}  ${diffText}`,
          );
        } else {
          // 非数值字段也占同样的宽度 —— 否则「当前动作」那行的 A=
          // 会跟「情绪效价」那行错开，列对不齐。
          console.log(
            `    ${spec.label.padEnd(labelWidth)}  ` +
              `A=${String(spec.format(f.a, lookup)).padStart(VALUE_WIDTH)}  ` +
              `B=${String(spec.format(f.b, lookup)).padStart(VALUE_WIDTH)}`,
          );
        }
      }
    }
  }

  if (cmp.memories.length > 0) {
    console.log("\n记忆差异：");
    for (const m of cmp.memories) {
      console.log(
        `  ${nameOf(m.characterId)}：共有 ${m.common}，只 A 有 ${m.onlyInA}，只 B 有 ${m.onlyInB}`,
      );
      // 光有数量没用 —— 「只 B 有 3」得让人知道差的是什么。
      // 这是「另一种可能」最该看的部分。
      for (const mem of m.onlyInBMemories ?? []) {
        console.log(`    仅 B：${mem.content}`);
      }
      for (const mem of m.onlyInAMemories ?? []) {
        console.log(`    仅 A：${mem.content}`);
      }
    }
  }
}
