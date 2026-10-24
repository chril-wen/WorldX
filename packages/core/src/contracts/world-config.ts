/**
 * 世界配置来源 —— core 问「世界长什么样」，但不关心配置从哪来。
 *
 * server 的实现是读 world.json / scene.json / characters/ 目录；
 * core 的单测可以用内存里的对象直接喂。
 */

import type { CharacterProfile, SceneConfig, WorldConfig } from "./index.js";

export interface WorldConfigSource {
  /** 当前世界的根目录（没有则为 null）。 */
  getWorldDir(): string | null;

  /** 切换世界目录，并让后续读取重新生效。 */
  setWorldDir(dir: string): void;

  loadWorldConfig(): WorldConfig;
  loadSceneConfig(): SceneConfig;
  loadCharacterProfiles(): CharacterProfile[];

  /** 写回一个角色人设（新增角色时用）。 */
  writeCharacterProfile(profile: CharacterProfile): void;

  /** 让人设缓存失效 —— 外部改写了角色文件后需要调用。 */
  invalidateCharacterProfileCache(): void;

  /** 丢弃缓存 —— 外部进程改写了 world.json 后需要调用。 */
  reloadConfigs(): void;
}
