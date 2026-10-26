/**
 * `worldx status` —— 模拟当前状态。
 *
 * 需要 server —— 模拟状态（暂停/恢复/当前时间线）在它内存里。
 */

import { api, apiOrThrow, isServerUp } from "../lib/api-client.mjs";
import { emit, printRows, section } from "../lib/format.mjs";
import { formatGameTime } from "./tick.mjs";

/**
 * 看模拟状态。
 *
 * @param {object} ctx
 */
export async function cmdStatus({ flags }) {
  const asJson = flags.has("json");

  if (!(await isServerUp())) {
    throw new Error(
      "server 没在跑。状态在它内存里。\n先启动：npm run dev:server",
    );
  }

  const status = await apiOrThrow("GET", "/api/simulation/status");
  const worlds = await apiOrThrow("GET", "/api/world/worlds");

  const data = {
    worldId: worlds.currentWorldId,
    timelineId: worlds.currentTimelineId,
    status: status.status,
    gameTime: status.gameTime,
    activeSimulationTicks: status.activeSimulationTicks,
  };

  emit({
    data,
    json: JSON.stringify(data, null, 2),
    asJson,
    human: () => {
      section("模拟状态", () => {
        printRows([
          { label: "世界", value: worlds.currentWorldId ?? "(没有)" },
          { label: "时间线", value: worlds.currentTimelineId ?? "(没有)" },
          { label: "状态", value: status.status ?? "?" },
          { label: "当前时间", value: formatGameTime(status.gameTime) },
        ]);
      });

      if (status.progress) {
        section("进度", () => {
          printRows([
            { label: "当前", value: String(status.progress.current) },
            { label: "总数", value: String(status.progress.total) },
          ]);
        });
      }
    },
  });
}
