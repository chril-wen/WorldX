/**
 * 世界配置来源的 server 侧实现 —— 读 world.json / scene.json / characters 目录。
 *
 * core 只认 `WorldConfigSource` 契约，不认文件系统；
 * 换配置来源（比如接数据库、接远程配置）时只改这一处。
 */

import type { WorldConfigSource } from "@worldx/core";
import {
  setWorldDir,
  getWorldDir,
  loadWorldConfig,
  loadSceneConfig,
  loadCharacterProfiles,
  writeCharacterProfile,
  invalidateCharacterProfileCache,
  reloadConfigs,
} from "../utils/config-loader.js";

export const filesystemConfigSource: WorldConfigSource = {
  getWorldDir,
  setWorldDir,
  loadWorldConfig,
  loadSceneConfig,
  loadCharacterProfiles,
  writeCharacterProfile,
  invalidateCharacterProfileCache,
  reloadConfigs,
};
