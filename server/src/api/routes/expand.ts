import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router, type Request, type Response } from "express";
import { appContext } from "../../services/app-context.js";
import { generateId } from "../../utils/id-generator.js";
import type { CharacterProfile, LocationConfig } from "../../types/index.js";
import { normalizeCharacterProfile } from "../../utils/config-loader.js";
import { loadPromptTemplate } from "../../utils/config-loader.js";
import { getWorldDir } from "../../utils/config-loader.js";
import { REPO_ROOT } from "../../utils/repo-paths.js";
import { z } from "zod";

const router = Router();

// ─── Zod schemas for LLM output ──────────────────────────────────────────────

const ExpandCharacterSchema = z.object({
  characters: z
    .array(
      z.object({
        name: z.string(),
        role: z.string(),
        personality: z.string(),
        appearance: z.string(),
        appearanceHint: z.string(),
        motivation: z.string(),
        socialStyle: z.string(),
        initialMemories: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  regions: z.array(z.unknown()).default([]),
  interactiveElements: z.array(z.unknown()).default([]),
});

const ExpandRegionSchema = z.object({
  characters: z.array(z.unknown()).default([]),
  regions: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        description: z.string(),
        type: z.enum(["building", "outdoor"]),
        enterable: z.boolean(),
        visualDescription: z.string(),
        interactions: z.array(z.unknown()).default([]),
      }),
    )
    .min(1),
  interactiveElements: z.array(z.unknown()).default([]),
});

// ─── Prompt helpers ────────────────────────────────────────────────────────────

/** 模板缺失时的兜底：保证至少有一段可用的设计要求，而不是空 prompt */
const FALLBACK_EXPAND_SECTION = [
  "## 世界扩展（Expand World）",
  "",
  "当前世界已有角色列表：",
  "{{existingCharacters}}",
  "",
  "当前世界已有的地点：",
  "{{existingLocations}}",
  "",
  "用户想添加的内容：{{userPrompt}}",
  "",
  "设计要求：",
  "- 新内容必须与现有世界的文化背景、时代、氛围完全自洽",
  "- 新角色数量：1–2 人/次，新地点数量：1–2 个/次",
  "- 不得重复或覆盖已有角色与地点",
  "- 语言与当前世界一致",
  "",
  "输出一个 JSON 对象（不要使用 markdown 代码块，不要添加任何注释或说明文字）：",
  '{"characters":[],"regions":[],"interactiveElements":[]}',
  "",
  "规则：",
  "- `characters` 至少 1 项；`regions` 和 `interactiveElements` 至少 1 项",
  "- 仅输出合法的 JSON（前后不要有任何文字）。",
].join("\n");

function buildExpandPrompt(userPrompt: string): string {
  const wm = appContext.worldManager;
  const existingChars = appContext.characterManager.getAllProfiles();

  const existingCharsDesc =
    existingChars.length > 0
      ? existingChars.map((c) => `${c.name}（${c.role}）`).join("；")
      : "（暂无角色）";

  const existingLocsDesc =
    wm.getLocations().map((l) => l.name).join("、") || "（暂无功能区域）";

  let template: string;
  try {
    template = loadPromptTemplate("world-expansion");
  } catch (err) {
    console.warn(
      "[expand] world-expansion prompt template unavailable, using fallback:",
      err instanceof Error ? err.message : String(err),
    );
    template = "";
  }

  // 模板里「世界扩展」一节的位置：优先找带分隔线的完整标记，
  // 找不到就退而求其次找标题本身（模板可能以 --- 开头，此时标记前面没有换行）。
  const markers = ["\n---\n\n## 世界扩展", "---\n\n## 世界扩展", "## 世界扩展"];
  let idx = -1;
  for (const marker of markers) {
    idx = template.indexOf(marker);
    if (idx >= 0) break;
  }
  const expandSection = idx >= 0 ? template.slice(idx) : "";

  const source = expandSection || FALLBACK_EXPAND_SECTION;

  return source
    .replace(/\{\{existingCharacters\}\}/g, existingCharsDesc)
    .replace(/\{\{existingLocations\}\}/g, existingLocsDesc)
    .replace(/\{\{userPrompt\}\}/g, userPrompt);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** POST /api/expand/character */
router.post("/character", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { characterPrompt, characterDesign } = body as {
    characterPrompt?: string;
    characterDesign?: unknown;
  };
  // 中心区域的 id —— 新角色落在世界的公共枢纽。
  const centerLocationId = appContext.worldManager.getCenterLocationId();

  try {
    let profile: CharacterProfile;

    if (characterDesign) {
      profile = normalizeCharacterProfile(characterDesign as Record<string, unknown>) as CharacterProfile;
      if (!profile?.id || !profile?.name) {
        res.status(400).json({ error: "Invalid characterDesign: missing id or name" });
        return;
      }
    } else if (characterPrompt && typeof characterPrompt === "string" && characterPrompt.trim()) {
      // Generate via LLM
      const llm = appContext.llmClient;
      const systemMsg = "You are an expert world designer for AI social simulations. Always respond with valid JSON.";
      const userMsg = buildExpandPrompt(characterPrompt.trim());

      const result = await llm.call({
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg },
        ],
        schema: ExpandCharacterSchema,
        options: { taskType: "expand_character" },
      });

      const data = result.data;
      const raw = data.characters[0];

      // Inline normalization (mirrors orchestrator/src/world-design-utils.mjs)
      profile = {
        id: `char_${generateId().slice(0, 8)}`,
        name: String(raw.name || "").trim(),
        role: String(raw.role || "NPC").trim(),
        nickname: String(raw.name || "").trim(),
        startPosition: centerLocationId,
        appearanceHint: String(raw.appearanceHint || "").trim(),
        coreMotivation: String(raw.motivation || "").trim(),
        coreValues: [],
        speakingStyle: String(raw.personality || raw.motivation || "").trim(),
        fears: [],
        socialStyle: (raw.socialStyle === "extrovert" || raw.socialStyle === "introvert" || raw.socialStyle === "introvert_selective"
          ? raw.socialStyle
          : "extrovert_selective") as CharacterProfile["socialStyle"],
        extraversionLevel: 3,
        intuitionLevel: 3,
        skills: [],
        writeDiary: false,
        fourthWallCandidate: false,
        tags: [],
        preferredLocations: [centerLocationId],
        preferredActivities: [],
        initialMemories: Array.isArray(raw.initialMemories)
          ? raw.initialMemories.map((m: string) => ({
              type: "reflection" as const,
              content: m,
              importance: 5,
              emotionalValence: 0,
              emotionalIntensity: 2,
              relatedCharacters: [] as string[],
              relatedLocation: centerLocationId,
              relatedObjects: [] as string[],
              tags: [] as string[],
            }))
          : [],
      };
    } else {
      res.status(400).json({ error: "Either characterPrompt or characterDesign is required" });
      return;
    }

    appContext.characterManager.spawnCharacter(profile);

    res.json({
      ok: true,
      character: { id: profile.id, name: profile.name, role: profile.role },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[expand/character]", message);
    res.status(500).json({ error: `Failed to add character: ${message}` });
  }
});

/** POST /api/expand/region */
router.post("/region", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { regionPrompt, regionDesign } = body as {
    regionPrompt?: string;
    regionDesign?: unknown;
  };
  // 中心区域的 id —— 新区域挂到它上面。
  const centerLocationId = appContext.worldManager.getCenterLocationId();

  try {
    let location: LocationConfig;

    if (regionDesign) {
      location = regionDesign as LocationConfig;
      if (!location?.id || !location?.name) {
        res.status(400).json({ error: "Invalid regionDesign: missing id or name" });
        return;
      }
    } else if (regionPrompt && typeof regionPrompt === "string" && regionPrompt.trim()) {
      const llm = appContext.llmClient;
      const systemMsg = "You are an expert world designer for AI social simulations. Always respond with valid JSON.";
      const userMsg = buildExpandPrompt(regionPrompt.trim());

      const result = await llm.call({
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg },
        ],
        schema: ExpandRegionSchema,
        options: { taskType: "expand_region" },
      });

      const data = result.data;
      const raw = data.regions[0];
      location = {
        id: raw.id ?? `region_${generateId().slice(0, 8)}`,
        name: raw.name,
        description: raw.description,
        adjacentLocations: [centerLocationId],
        objects: [],
        indoor: raw.type === "building",
      };
    } else {
      res.status(400).json({ error: "Either regionPrompt or regionDesign is required" });
      return;
    }

    appContext.worldManager.addLocation(location);

    res.json({
      ok: true,
      region: { id: location.id, name: location.name },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[expand/region]", message);
    res.status(500).json({ error: `Failed to add region: ${message}` });
  }
});

/** POST /api/expand/map — 扩展地图区域（SSE 流式返回进度） */
router.post("/map", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { mapPrompt } = body as { mapPrompt?: string; side?: string };
  // 扩展方向：right/left/top/bottom/auto。auto = 由 LLM 根据地图内容自动选。
  const expandSide =
    typeof body.side === "string" &&
    ["right", "left", "top", "bottom", "auto"].includes(body.side)
      ? body.side
      : "auto";

  if (!mapPrompt || typeof mapPrompt !== "string" || !mapPrompt.trim()) {
    res.status(400).json({ error: "mapPrompt is required" });
    return;
  }

  const worldDir = getWorldDir();
  if (!worldDir) {
    res.status(500).json({ error: "No world is currently loaded" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("start", { message: "Map expansion started" });

  // 路径基于仓库根推导 —— 跟进程从哪启动无关。
  // 以前用 `process.cwd()`，从仓库根启动 server 时会指向仓库外，扩图直接失效。
  const scriptPath = path.join(
    REPO_ROOT,
    "orchestrator",
    "src",
    "expand-map.mjs",
  );

  const child = spawn(
    process.execPath,
    [scriptPath, worldDir, expandSide, mapPrompt.trim()],
    {
      cwd: path.join(REPO_ROOT, "orchestrator"),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let lastStage = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // 把 [ExpandMap] 前缀的进度行转成 SSE 事件
    const stageMatch = trimmed.match(/^\[ExpandMap\]\s+(.*)$/);
    if (stageMatch) {
      lastStage = stageMatch[1];
      send("progress", { stage: lastStage });
    }
  };

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    console.log("[expand/map]", text.trimEnd());
    text.split("\n").forEach(handleLine);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    output += "[stderr] " + text;
    console.error("[expand/map]", text.trimEnd());
    text.split("\n").forEach(handleLine);
  });

  child.on("close", async (code) => {
    console.log("[expand/map] Done, code:", code);
    if (code !== 0) {
      const errorLine = output
        .split("\n")
        .filter((line) => line.includes("ERROR:") || line.includes("Error:"))
        .pop();
      const detail = errorLine?.replace(/^.*?(ERROR:|Error:)\s*/, "") ?? output.slice(-300);
      send("error", { error: `expand-map failed: ${detail}` });
      res.end();
      return;
    }

    try {
      // 刷新运行时
      appContext.worldManager.reloadLocations();
      appContext.characterManager.reassignAllToCenterArea();

      send("done", {
        ok: true,
        message: "Map expanded successfully",
        result: parseSuccessPayload(output),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send("error", { error: `Refresh failed: ${msg}` });
    }
    res.end();
  });

  child.on("error", (err) => {
    send("error", { error: `spawn error: ${err.message}` });
    res.end();
  });
});

/**
 * 从子进程输出里解析结构化结果。
 *
 * 子进程成功时打印一行 `SUCCESS:{...}`。取【最后一个】这样的标记行，
 * 并对其后的 JSON 做整体解析——用正则懒匹配会在嵌套对象处提前截断。
 */
function parseSuccessPayload(output: string): unknown {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const markerIdx = lines[i].indexOf("SUCCESS:");
    if (markerIdx < 0) continue;
    const payload = lines[i].slice(markerIdx + "SUCCESS:".length).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload);
    } catch {
      // JSON 跨行时，尝试把后续行也拼进来
      const candidate = lines.slice(i).join("\n").slice(markerIdx + "SUCCESS:".length).trim();
      const braceStart = candidate.indexOf("{");
      const braceEnd = candidate.lastIndexOf("}");
      if (braceStart >= 0 && braceEnd > braceStart) {
        try {
          return JSON.parse(candidate.slice(braceStart, braceEnd + 1));
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }
  return undefined;
}

export default router;
