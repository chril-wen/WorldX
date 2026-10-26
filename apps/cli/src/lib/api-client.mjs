/**
 * 跟 server 说话 —— CLI 的 HTTP 客户端。
 *
 * ## 为什么 CLI 要走 HTTP 而不是直接调 core
 *
 * 因为有些操作**只有在 server 进程里才做得了**：
 *
 * - 跑 tick 要 `worldId` + `timelineId` 一起提交，server 会校验
 *   「跟你要推进的是同一个世界」——防的是在别的世界上推进
 * - 模拟状态存在 server 进程的内存里（暂停/恢复/重置）
 * - 角色状态存在 server 的 SQLite 里
 *
 * 直接调 core 就得自己复刻这套「当前世界 + 当前时间线」的语义 ——
 * 那正是 server 已经做对的事。
 *
 * ## 两种模式
 *
 * - **需要 server**：tick、simulation status、characters、events
 * - **不需要 server**（直接读文件）：worlds、rules、timeline
 *
 * 后者刻意不碰 server —— 「CLI 不该对运行中的进程有副作用」。
 */

const DEFAULT_BASE_URL = "http://localhost:3100";

/**
 * 找 server 的地址。
 *
 * 环境变量 `WORLDX_SERVER` 优先 —— 测试和「server 不在默认端口」的场合用。
 *
 * @returns {string} 去掉尾部斜杠的 base URL
 */
export function baseUrl() {
  const raw = process.env.WORLDX_SERVER || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/**
 * server 在跑吗。
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isServerUp(timeoutMs = 2000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl()}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 调一个 API。
 *
 * @param {string} method
 * @param {string} path  以 `/` 开头的路径
 * @param {object} [body]
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
export async function api(method, path, body) {
  const url = `${baseUrl()}${path}`;
  const init = { method, headers: {} };

  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(
      `连不上 server（${url}）：${err instanceof Error ? err.message : String(err)}\n` +
        `先启动它：npm run dev:server`,
    );
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { ok: res.ok, status: res.status, data };
}

/**
 * 调一个 API，失败就抛错。
 *
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<any>} 响应体
 */
export async function apiOrThrow(method, path, body) {
  const { ok, status, data } = await api(method, path, body);
  if (!ok) {
    const message = data?.error ?? data?.message ?? `HTTP ${status}`;
    throw new Error(`${method} ${path} 失败：${message}`);
  }
  return data;
}
