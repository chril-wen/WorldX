import type {
  CharacterProfile,
  CharacterState,
  GameTime,
  SimulationEvent,
  DiaryEntry,
  Storage,
} from "../types/index.js";
import type { WorldManager } from "./world-manager.js";
import { loadCharacterProfiles, writeCharacterProfile, invalidateCharacterProfileCache } from "../utils/config-loader.js";
import { generateId } from "../utils/id-generator.js";
import * as charStateStore from "../store/character-state-store.js";
import { MemoryManager } from "@worldx/core";
import { decayNeeds } from "./needs-manager.js";
import { decayEmotion } from "./emotion-manager.js";
import * as memoryStore from "../store/memory-store.js";
import * as diaryStore from "../store/diary-store.js";
import { createDefaultStorage } from "../store/storage-adapter.js";

export class CharacterManager {
  memoryManager: MemoryManager;

  private profiles: Map<string, CharacterProfile> = new Map();
  private storage: Storage;

  constructor(private worldManager: WorldManager, storage?: Storage) {
    this.storage = storage ?? createDefaultStorage();
    this.memoryManager = new MemoryManager(this.storage.memories);
  }

  initialize(): void {
    const profiles = loadCharacterProfiles();

    for (const p of profiles) {
      this.profiles.set(p.id, p);
    }

    const occupiedPointIds = new Set<string>();
    const spawnSeedSalt = `init:${Date.now().toString(36)}`;
    for (const profile of profiles) {
      const state = buildInitialCharacterState(
        profile,
        this.worldManager,
        occupiedPointIds,
        spawnSeedSalt,
      );
      if (state.mainAreaPointId) {
        occupiedPointIds.add(state.mainAreaPointId);
      }
      charStateStore.initCharacterState(state);

      for (const initMem of profile.initialMemories) {
        if (
          memoryStore.hasMemory(
            profile.id,
            initMem.type,
            initMem.content,
            1,
            0,
          )
        ) {
          continue;
        }

        this.memoryManager.addMemory({
          characterId: profile.id,
          type: initMem.type,
          content: initMem.content,
          gameTime: { day: 1, tick: 0 },
          importance: initMem.importance,
          emotionalValence: initMem.emotionalValence,
          emotionalIntensity: initMem.emotionalIntensity,
          relatedCharacters: initMem.relatedCharacters,
          relatedLocation: initMem.relatedLocation,
          relatedObjects: initMem.relatedObjects,
          tags: initMem.tags,
        });
      }

      if (profile.backstory) {
        const backstoryMemContent = profile.backstory;
        if (
          !memoryStore.hasMemory(profile.id, "experience", backstoryMemContent, 1, 0)
        ) {
          this.memoryManager.addMemory({
            characterId: profile.id,
            type: "experience",
            content: backstoryMemContent,
            gameTime: { day: 1, tick: 0 },
            importance: 8,
            emotionalValence: 0,
            emotionalIntensity: 3,
            relatedCharacters: [],
            relatedLocation: profile.startPosition,
            relatedObjects: [],
            tags: ["backstory"],
          });
        }
      }
    }

  }

  getProfile(charId: string): CharacterProfile {
    const p = this.profiles.get(charId);
    if (!p) throw new Error(`Profile not found: ${charId}`);
    return p;
  }

  getAllProfiles(): CharacterProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Spawn a new character into the running world.
   * Persists to disk so the character survives world reloads.
   */
  spawnCharacter(profile: CharacterProfile): void {
    // 1. Assign an ID if missing
    if (!profile.id) {
      profile.id = `char_${generateId().slice(0, 8)}`;
    }

    // 2. Collect already-occupied point IDs BEFORE registering new profile
    const occupiedPointIds = new Set<string>();
    for (const p of this.profiles.values()) {
      const s = charStateStore.getCharacterState(p.id);
      if (s.mainAreaPointId) occupiedPointIds.add(s.mainAreaPointId);
    }

    // 3. Persist to disk
    writeCharacterProfile(profile);

    // 4. Register in-memory
    this.profiles.set(profile.id, profile);

    // 5. Create initial state
    const seedSalt = `spawn:${Date.now().toString(36)}`;
    const state = buildInitialCharacterState(profile, this.worldManager, occupiedPointIds, seedSalt);
    charStateStore.initCharacterState(state);

    // 6. Add initial memories
    for (const initMem of profile.initialMemories) {
      this.memoryManager.addMemory({
        characterId: profile.id,
        type: initMem.type,
        content: initMem.content,
        gameTime: this.worldManager.getCurrentTime(),
        importance: initMem.importance ?? 5,
        emotionalValence: initMem.emotionalValence ?? 0,
        emotionalIntensity: initMem.emotionalIntensity ?? 2,
        relatedCharacters: initMem.relatedCharacters,
        relatedLocation: initMem.relatedLocation,
        relatedObjects: initMem.relatedObjects ?? [],
        tags: initMem.tags ?? [],
      });
    }

    // 7. Backstory memory
    if (profile.backstory) {
      this.memoryManager.addMemory({
        characterId: profile.id,
        type: "experience",
        content: profile.backstory,
        gameTime: { day: 1, tick: 0 },
        importance: 8,
        emotionalValence: 0,
        emotionalIntensity: 3,
        relatedCharacters: [],
        relatedLocation: profile.startPosition,
        relatedObjects: [],
        tags: ["backstory"],
      });
    }
  }

  /**
   * Clear all character positions so the next tick's movement decision
   * will reassign them to valid walkable points on the map.
   */
  reassignAllToMainArea(): void {
    for (const charId of this.profiles.keys()) {
      charStateStore.updateCharacterState(charId, {
        mainAreaPointId: null,
        currentAction: null,
        location: "main_area",
      });
    }
    console.log(`[CharacterManager] Reassigned ${this.profiles.size} characters to main_area`);
  }

  /** Editable subset of CharacterProfile fields. */
  static readonly EDITABLE_FIELDS = [
    "coreMotivation", "coreValues", "speakingStyle",
    "fears", "backstory", "socialStyle", "tags",
  ] as const;

  patchProfile(
    charId: string,
    patch: Partial<Pick<CharacterProfile, (typeof CharacterManager.EDITABLE_FIELDS)[number]>>,
  ): CharacterProfile {
    const existing = this.profiles.get(charId);
    if (!existing) throw new Error(`Profile not found: ${charId}`);
    const cleaned: Record<string, unknown> = {};
    for (const key of CharacterManager.EDITABLE_FIELDS) {
      if (key in patch) cleaned[key] = (patch as Record<string, unknown>)[key];
    }
    const updated = { ...existing, ...cleaned };
    this.profiles.set(charId, updated);
    return updated;
  }

  getState(charId: string): CharacterState {
    return charStateStore.getCharacterState(charId);
  }

  getAllStates(): CharacterState[] {
    return charStateStore.getAllCharacterStates();
  }

  resetStatesForNewScene(): void {
    const occupiedPointIds = new Set<string>();
    const currentTime = this.worldManager.getCurrentTime();
    const spawnSeedSalt = `scene:${currentTime.day}:${Date.now().toString(36)}`;

    for (const profile of this.getAllProfiles()) {
      const initialState = buildInitialCharacterState(
        profile,
        this.worldManager,
        occupiedPointIds,
        spawnSeedSalt,
      );
      if (initialState.mainAreaPointId) {
        occupiedPointIds.add(initialState.mainAreaPointId);
      }

      charStateStore.updateCharacterState(profile.id, {
        location: initialState.location,
        mainAreaPointId: initialState.mainAreaPointId,
        currentAction: initialState.currentAction,
        currentActionTarget: initialState.currentActionTarget,
        actionStartTick: initialState.actionStartTick,
        actionEndTick: initialState.actionEndTick,
        emotionValence: initialState.emotionValence,
        emotionArousal: initialState.emotionArousal,
        curiosity: initialState.curiosity,
        dailyPlan: initialState.dailyPlan,
      });
    }
  }

  updateState(charId: string, patch: Partial<CharacterState>): void {
    charStateStore.updateCharacterState(charId, patch);
  }

  tickPassiveUpdate(charId: string, currentTime: GameTime): SimulationEvent[] {
    const state = this.getState(charId);
    const profile = this.getProfile(charId);

    const needsPatch = decayNeeds(state, profile, currentTime.tick);
    const emotionResult = decayEmotion({
      valence: state.emotionValence,
      arousal: state.emotionArousal,
    });

    const fullPatch: Partial<CharacterState> = {
      ...needsPatch,
      emotionValence: emotionResult.valence,
      emotionArousal: emotionResult.arousal,
    };

    charStateStore.updateCharacterState(charId, fullPatch);
    return [];
  }

  getCharactersAtLocation(
    locationId: string,
  ): { profile: CharacterProfile; state: CharacterState }[] {
    const states = charStateStore.getCharactersByLocation(locationId);
    return states.map((s) => ({
      profile: this.getProfile(s.characterId),
      state: s,
    }));
  }

  addDiaryEntry(charId: string, gameDay: number, content: string): DiaryEntry {
    const entry: DiaryEntry = {
      id: generateId(),
      characterId: charId,
      gameDay,
      content,
    };

    this.storage.diaries.addDiaryEntry(entry);

    return entry;
  }

  getDiaryEntries(charId: string, gameDay?: number): DiaryEntry[] {
    return this.storage.diaries.getDiaryEntries(charId, gameDay);
  }
}

function buildInitialCharacterState(
  profile: CharacterProfile,
  worldManager: WorldManager,
  occupiedPointIds: Set<string>,
  spawnSeedSalt: string,
): CharacterState {
  const spawnSeed = `${profile.id}:${spawnSeedSalt}`;
  let mainAreaPointId: string | null = null;
  if (profile.startPosition === "main_area") {
    if (profile.anchor?.type === "element") {
      const elementPointId = `element_${profile.anchor.targetId}`;
      const point = worldManager.getMainAreaPoint(elementPointId);
      // Anchored characters always spawn at their anchor point, even if it's
      // in a small disconnected component of the point graph.
      mainAreaPointId = point
        ? elementPointId
        : worldManager.getSpreadMainAreaPointId(spawnSeed, occupiedPointIds);
    } else {
      mainAreaPointId = worldManager.getSpreadMainAreaPointId(spawnSeed, occupiedPointIds);
    }
  }

  return {
    characterId: profile.id,
    location: profile.startPosition,
    mainAreaPointId,
    currentAction: null,
    currentActionTarget: null,
    actionStartTick: 0,
    actionEndTick: 0,
    emotionValence: 1,
    emotionArousal: clampStat(3 + profile.extraversionLevel * 2),
    curiosity: clampStat(64 + profile.intuitionLevel * 20),
    dailyPlan: null,
  };
}

function clampStat(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

