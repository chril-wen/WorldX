/**
 * 仓库路径 —— 所有「相对仓库根算出来」的路径都从这里来。
 *
 * 为什么要专门一个模块：以前各处用 `path.resolve("configs")` 这类写法，
 * 它是**相对进程 cwd** 解析的 —— 从 `server/` 启动能找到，从仓库根启动就找不到了。
 * 而且这种地方一旦找错，**不报错，只是静默走到另一条分支**：
 * 提示词读不到会静默降级，数据库会写到另一个目录去。
 *
 * 所以这里全部改成基于 `__dirname` 推导 —— 跟进程从哪启动无关。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** `server/src/utils/` → `server/` */
export const SERVER_ROOT = path.resolve(__dirname, "../..");

/** `server/` → 仓库根 */
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

/** 仓库根的 `prompts/` —— 阶段 2 之后所有提示词模板都在这 */
export const PROMPTS_DIR = path.join(REPO_ROOT, "prompts");

/** 仓库根的 `config/` —— 放 `models.json` 这类非敏感配置 */
export const CONFIG_DIR = path.join(REPO_ROOT, "config");

/** `server/configs/` —— 阶段 2 之前提示词放这，之后会空掉 */
export const LEGACY_CONFIGS_DIR = path.join(SERVER_ROOT, "configs");

/** `server/data/` —— SQLite 数据库和快照 */
export const SERVER_DATA_DIR = path.join(SERVER_ROOT, "data");

/** 仓库根的 `output/worlds/` —— 生成的世界 */
export const OUTPUT_WORLDS_DIR = path.join(REPO_ROOT, "output", "worlds");

/** 仓库根的 `library/worlds/` —— 预置世界库 */
export const LIBRARY_WORLDS_DIR = path.join(REPO_ROOT, "library", "worlds");

/** `client/dist/` —— 生产模式下 server 托管的前端 */
export const CLIENT_DIST_DIR = path.join(REPO_ROOT, "client", "dist");
