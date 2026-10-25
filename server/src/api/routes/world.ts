import fs from "node:fs";
import path from "node:path";
import { Router, type Response } from "express";
import { appContext } from "../../services/app-context.js";
import {
  getActiveSimulationTicks,
  getSimulationBusyMessage,
  isSimulationBusy,
} from "../../services/simulation-activity.js";
import { buildSceneRuntimeInfo, buildWorldTimeInfo } from "../../utils/time-helpers.js";
import { getWeatherInfo } from "../../core/weather-manager.js";
import * as worldStateStore from "../../store/world-state-store.js";
import {
  GENERATED_WORLDS_DIR,
  LIBRARY_WORLDS_DIR,
  listGeneratedWorlds,
  listLibraryWorlds,
  findWorldById,
} from "../../utils/world-directories.js";

const router = Router();

function rejectIfSimulationBusy(res: Response): boolean {
  if (!isSimulationBusy()) return false;
  res.status(409).json({
    error: getSimulationBusyMessage(),
    activeSimulationTicks: getActiveSimulationTicks(),
    canSwitchContext: false,
  });
  return true;
}

router.get("/time", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  res.json({
    ...buildWorldTimeInfo(appContext.worldManager.getCurrentTime()),
    weather: getWeatherInfo(),
  });
});

router.get("/info", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const wm = appContext.worldManager;
  const currentWorldDir = appContext.getWorldDir();
  res.json({
    worldName: wm.getWorldName(),
    worldDescription: wm.getWorldDescription(),
    originalPrompt: wm.getOriginalPrompt(),
    currentWorldId: currentWorldDir ? path.basename(currentWorldDir) : null,
    currentTimelineId: appContext.timelineManager.getCurrentTimelineId(),
    sceneConfig: wm.getSceneConfig(),
    sceneRuntime: buildSceneRuntimeInfo(wm.getSceneConfig()),
    weather: getWeatherInfo(),
    worldActions: wm.getWorldActions(),
    mainAreaPoints: wm.getMainAreaPoints(),
    // 中心区域的 id —— 客户端要靠它知道「世界的公共枢纽」是哪个。
    // 旧世界没声明时是 "main_area"。
    centerLocationId: wm.getCenterLocationId(),
    worldSize: wm.getWorldSize(),
    mainAreaDialogueRadiusPx: wm.getMainAreaDialogueDistanceThreshold(),
    timelineTickCount: appContext.timelineManager.getTickCount(),
  });
});

router.post("/dev/tick-duration", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }

  const tickDurationMinutes = Number(req.body?.tickDurationMinutes);
  if (![15, 30, 60].includes(tickDurationMinutes)) {
    res.status(400).json({ error: "tickDurationMinutes must be one of 15, 30, 60" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  appContext.setDevTickDurationMinutes(tickDurationMinutes);
  const wm = appContext.worldManager;
  res.json({
    ok: true,
    gameTime: buildWorldTimeInfo(wm.getCurrentTime(), wm.getSceneConfig()),
    sceneConfig: wm.getSceneConfig(),
    sceneRuntime: buildSceneRuntimeInfo(wm.getSceneConfig()),
  });
});

router.get("/worlds", (_req, res) => {
  const currentWorldDir = appContext.getWorldDir();
  const currentWorldId = currentWorldDir ? path.basename(currentWorldDir) : null;

  const mapWorld = (world: { id: string; worldName: string; dir: string; source: string }) => ({
    id: world.id,
    worldName: world.worldName,
    source: world.source,
    isCurrent: world.id === currentWorldId,
    timelineCount: appContext.timelineManager.listTimelines(world.dir).length,
  });

  res.json({
    currentWorldId,
    currentTimelineId: appContext.timelineManager.getCurrentTimelineId(),
    worlds: listGeneratedWorlds().map(mapWorld),
    libraryWorlds: listLibraryWorlds().map(mapWorld),
  });
});

router.post("/select", (req, res) => {
  const worldId = typeof req.body?.worldId === "string" ? req.body.worldId : "";
  if (!worldId) {
    res.status(400).json({ error: "worldId is required" });
    return;
  }

  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }
  if (rejectIfSimulationBusy(res)) return;

  appContext.switchWorld(world.dir);
  res.json({
    ok: true,
    currentWorldId: world.id,
    worldName: world.worldName,
  });
});

router.delete("/worlds/:worldId", (req, res) => {
  const worldId = String(req.params.worldId);
  if (!worldId || worldId.includes("..") || worldId.includes("/") || worldId.includes("\\")) {
    res.status(400).json({ error: "Invalid world id" });
    return;
  }

  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }

  if (world.source === "library") {
    res.status(403).json({ error: "Sample worlds cannot be deleted" });
    return;
  }

  const resolvedDir = path.resolve(world.dir);
  const resolvedRoot = path.resolve(GENERATED_WORLDS_DIR);
  if (!resolvedDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    res.status(400).json({ error: "World path is outside the generated worlds directory" });
    return;
  }

  const currentWorldDir = appContext.getWorldDir();
  if (currentWorldDir && path.resolve(currentWorldDir) === resolvedDir) {
    res.status(409).json({
      error: "Cannot delete the currently active world. Switch to another world first.",
    });
    return;
  }

  try {
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to delete world: ${message}` });
    return;
  }

  res.json({ ok: true, deletedWorldId: worldId });
});

router.get("/locations", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  res.json(appContext.worldManager.getAllLocations());
});

/**
 * POST /api/world/reload — 从磁盘重新载入世界配置。
 *
 * 服务端在启动时把 world.json 读进内存。地图扩图由外部进程（orchestrator）
 * 改写 world.json，磁盘变了但内存没变，客户端和服务端对世界的认知就分裂了。
 * 走 /api/expand/map 的扩图会自动重载；但如果扩图是直接跑脚本做的
 * （调试、批处理），就需要这个端点来同步。
 */
router.post("/reload", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  try {
    appContext.worldManager.reloadLocations();
    // 角色配置也要重载 —— 角色级规则覆盖（角色配置里的 rules 段）
    // 缓存在 CharacterManager 里，不重载的话改了不生效。
    appContext.characterManager.reloadProfiles();
    const locations = appContext.worldManager.getAllLocations();
    res.json({
      ok: true,
      locationCount: locations.length,
      mainAreaPointCount: appContext.worldManager.getMainAreaPoints().length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Reload failed: ${message}` });
  }
});

router.get("/locations/:id/state", (req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  const loc = appContext.worldManager.getLocation(req.params.id);
  if (!loc) {
    res.status(404).json({ error: "Location not found" });
    return;
  }

  const objects = appContext.worldManager.getLocationObjects(loc.id);
  const chars = appContext.characterManager.getCharactersAtLocation(loc.id);

  res.json({
    location: loc,
    objects: objects.map((o) => ({
      objectId: o.objectId,
      state: o.state,
      stateDescription: o.stateDescription,
      currentUsers: o.currentUsers,
    })),
    characters: chars.map((c) => ({
      id: c.profile.id,
      name: c.profile.name,
      action: c.state.currentAction,
    })),
  });
});

// Read-only view of the model roles from .env. Never returns API keys, only whether one is set.
const MODEL_ROLES = ["ORCHESTRATOR", "IMAGE_GEN", "VISION", "SIMULATION"] as const;

router.get("/model-config", (_req, res) => {
  res.json({
    roles: MODEL_ROLES.map((role) => {
      const baseUrl = process.env[`${role}_BASE_URL`] ?? "";
      let host = "";
      try {
        host = baseUrl ? new URL(baseUrl).host : "";
      } catch {
        host = "(invalid URL)";
      }
      return {
        role,
        host,
        model: process.env[`${role}_MODEL`] ?? "",
        provider: role === "IMAGE_GEN" ? process.env.IMAGE_GEN_PROVIDER ?? "" : undefined,
        hasApiKey: Boolean(process.env[`${role}_API_KEY`]),
      };
    }),
  });
});

router.get("/global-state", (_req, res) => {
  if (!appContext.hasWorld) {
    res.status(503).json({ error: "No world loaded" });
    return;
  }
  res.json(worldStateStore.getAllGlobalState());
});

export default router;
