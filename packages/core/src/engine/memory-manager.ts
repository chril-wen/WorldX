import type { MemoryEntry, MemoryType, GameTime } from "../contracts/index.js";
import type { MemoryStorage } from "../contracts/storage.js";
import type { LLMClient } from "../contracts/llm-client.js";
import { generateId } from "../utils/id-generator.js";
import { absoluteTick } from "./time-helpers.js";
import { DEFAULT_RULES } from "./rules.js";
import type { MemoryRules } from "./rules.js";

interface RetrievalWeights {
  relevance: number;
  recency: number;
  importance: number;
  emotionalIntensity: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,.:;!?，。！？、]+/).filter(Boolean);
}

export class MemoryManager {
  private weights?: Partial<RetrievalWeights>;
  private cache = new Map<string, MemoryEntry[]>();
  private memoryStore: MemoryStorage;
  private rules: MemoryRules;
  /**
   * 角色级规则解析器 —— 返回该角色实际生效的记忆规则。
   *
   * 为什么需要它：MemoryManager 是**所有角色共用**的，
   * 但「某个角色记得特别短」是角色级规则。
   * 所以规则不能是单一的一份，得按 characterId 解析。
   */
  private rulesResolver?: (characterId: string) => MemoryRules;

  /**
   * @param memoryStore 记忆存储
   * @param weights 检索权重覆盖（留空则用规则里的权重）
   * @param rules 默认记忆规则 —— 决定「记得住什么、忘得多快」
   * @param rulesResolver 角色级规则解析器
   */
  constructor(
    memoryStore: MemoryStorage,
    weights?: Partial<RetrievalWeights>,
    rules: MemoryRules = DEFAULT_RULES.memory,
    rulesResolver?: (characterId: string) => MemoryRules,
  ) {
    this.memoryStore = memoryStore;
    this.rules = rules;
    this.rulesResolver = rulesResolver;
    this.weights = weights;
  }

  /** 当前生效的记忆规则（默认规则，不含角色级覆盖）。 */
  getRules(): MemoryRules {
    return this.rules;
  }

  /**
   * 取某个角色生效的记忆规则。
   *
   * 没有配解析器时返回默认规则 —— 单测里直接 new MemoryManager(store) 就是这条。
   */
  getRulesFor(characterId: string): MemoryRules {
    return this.rulesResolver?.(characterId) ?? this.rules;
  }

  /**
   * 取某个角色生效的检索权重。
   *
   * 权重**不是构造时定死的** —— 它们从角色生效的规则里现算。
   * 之前是构造时抄一份，改了 world.json 的 `memory.relevanceWeight`
   * 也不会生效（要重启 server 才行）。规则既然是数据，权重就该跟着数据走。
   */
  private getWeightsFor(characterId: string): RetrievalWeights {
    const rules = this.getRulesFor(characterId);
    return {
      relevance: this.weights?.relevance ?? rules.relevanceWeight,
      recency: this.weights?.recency ?? rules.recencyWeight,
      importance: this.weights?.importance ?? rules.importanceWeight,
      emotionalIntensity:
        this.weights?.emotionalIntensity ?? rules.emotionalIntensityWeight,
    };
  }

  /**
   * 换一套默认记忆规则（世界级）。
   *
   * 换完必须清缓存 —— 缓存里存的是记忆条目本身（不含评分），
   * 评分是每次检索现算的，所以条目缓存不用清，但检索结果的排序会变。
   */
  setRules(rules: MemoryRules): void {
    this.rules = rules;
    this.cache.clear();
  }

  setLLMClient(_client: LLMClient): void {
    // Embeddings are disabled at runtime, but we keep this hook for compatibility.
  }

  clearCache(): void {
    this.cache.clear();
  }

  addMemory(params: {
    characterId: string;
    type: MemoryType;
    content: string;
    gameTime: GameTime;
    importance: number;
    emotionalValence: number;
    emotionalIntensity: number;
    relatedCharacters?: string[];
    relatedLocation?: string;
    relatedObjects?: string[];
    tags?: string[];
    embedding?: number[];
  }): MemoryEntry {
    const memory: MemoryEntry = {
      id: generateId(),
      characterId: params.characterId,
      type: params.type,
      content: params.content,
      gameDay: params.gameTime.day,
      gameTick: params.gameTime.tick,
      importance: params.importance,
      emotionalValence: params.emotionalValence,
      emotionalIntensity: params.emotionalIntensity,
      relatedCharacters: params.relatedCharacters ?? [],
      relatedLocation: params.relatedLocation ?? "",
      relatedObjects: params.relatedObjects ?? [],
      tags: params.tags ?? [],
      decayFactor: 1.0,
      accessCount: 0,
      isLongTerm: false,
      embedding: params.embedding,
    };

    this.memoryStore.insertMemory(memory);
    this.cache.delete(params.characterId);
    return memory;
  }

  retrieveMemories(params: {
    characterId: string;
    currentTime: GameTime;
    contextKeywords: string[];
    relatedCharacterIds?: string[];
    relatedLocation?: string;
    topK?: number;
  }): MemoryEntry[] {
    const topK = params.topK ?? 10;
    const allMemories = this.getFromCache(params.characterId);

    if (allMemories.length === 0) return [];

    const currentTotalTicks = absoluteTick(params.currentTime);
    const contextLower = params.contextKeywords.map((k) => k.toLowerCase());
    const rules = this.getRulesFor(params.characterId);
    const weights = this.getWeightsFor(params.characterId);

    const scored = allMemories.map((memory) => {
      const score = this.computeScore(
        memory,
        currentTotalTicks,
        contextLower,
        rules,
        weights,
        params.relatedCharacterIds,
        params.relatedLocation,
      );

      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, topK).map((s) => s.memory);

    // 访问次数既写回 DB，也要同步更新缓存里的对象 ——
    // 否则缓存里的 accessCount 永远停在旧值，每次检索都算成 0 + 1 = 1，
    // 累计访问次数这条分支（consolidation 的 accessCount >= 3）永远走不到。
    for (const m of results) {
      const next = m.accessCount + 1;
      this.memoryStore.updateMemory(m.id, { accessCount: next });
      m.accessCount = next;
    }

    return results;
  }

  processMemoryDecay(characterId: string, currentDay: number): void {
    const memories = this.memoryStore.getMemoriesByCharacter(characterId, {
      isLongTerm: false,
    });
    const rules = this.getRulesFor(characterId);

    for (const m of memories) {
      const ageInDays = currentDay - m.gameDay;
      const effectiveStrength =
        m.importance * m.decayFactor + m.accessCount * rules.accessStrengthBonus;

      if (
        m.decayFactor < rules.deleteDecayFactor &&
        ageInDays > rules.deleteAfterDays
      ) {
        this.memoryStore.deleteMemory(m.id);
      } else if (
        m.decayFactor < rules.fadeDecayFactor &&
        ageInDays > rules.fadeAfterDays
      ) {
        this.memoryStore.updateMemory(m.id, {
          tags: [...m.tags.filter((t) => t !== "faded"), "faded"],
        });
      } else if (
        effectiveStrength < rules.faintStrengthThreshold &&
        ageInDays > rules.faintAfterDays
      ) {
        this.memoryStore.updateMemory(m.id, {
          tags: [...m.tags.filter((t) => t !== "faded"), "faded"],
        });
      }
    }

    this.cache.delete(characterId);
  }

  processMemoryConsolidation(characterId: string): void {
    const shortTermMemories = this.memoryStore.getMemoriesByCharacter(characterId, {
      isLongTerm: false,
    });
    const rules = this.getRulesFor(characterId);

    for (const m of shortTermMemories) {
      if (m.tags.includes("faded")) continue;

      if (
        m.importance >= rules.consolidateImportance ||
        m.accessCount >= rules.consolidateAccessCount
      ) {
        this.memoryStore.updateMemory(m.id, { isLongTerm: true });
      }
    }

    // 跟 processMemoryDecay 一样：DB 改了就得丢掉缓存，
    // 否则缓存里还是 isLongTerm=false 的旧对象。
    this.cache.delete(characterId);
  }

  getRecentMemories(characterId: string, limit: number): MemoryEntry[] {
    return this.memoryStore.getMemoriesByCharacter(characterId, { limit });
  }

  getRecentHearsay(characterId: string, currentDay: number, dayWindow: number = 3): MemoryEntry[] {
    const minDay = Math.max(1, currentDay - dayWindow + 1);
    return this.memoryStore
      .getMemoriesByCharacter(characterId, { types: ["hearsay"] })
      .filter((m) => m.gameDay >= minDay);
  }

  getMemoriesByDay(characterId: string, gameDay: number): MemoryEntry[] {
    return this.memoryStore
      .getMemoriesByCharacter(characterId)
      .filter((m) => m.gameDay === gameDay);
  }

  getMemorySummaryForPrompt(
    characterId: string,
    currentTime: GameTime,
    topK?: number,
  ): string {
    const memories = this.retrieveMemories({
      characterId,
      currentTime,
      contextKeywords: [],
      topK: topK ?? 5,
    });

    if (memories.length === 0) return "（暂无相关记忆）";

    return memories
      .map((m) => {
        const prefix = m.isLongTerm ? "【深刻】" : "";
        return `- ${prefix}${m.content}`;
      })
      .join("\n");
  }

  private getFromCache(characterId: string): MemoryEntry[] {
    let cached = this.cache.get(characterId);
    if (!cached) {
      cached = this.memoryStore.getMemoriesByCharacter(characterId);
      this.cache.set(characterId, cached);
    }
    return cached;
  }

  private computeScore(
    memory: MemoryEntry,
    currentTotalTicks: number,
    contextLower: string[],
    rules: MemoryRules,
    weights: RetrievalWeights,
    relatedCharacterIds?: string[],
    relatedLocation?: string,
  ): number {
    const relevance = this.computeRelevance(
      memory,
      contextLower,
      rules,
      relatedCharacterIds,
      relatedLocation,
    );

    const memoryTotalTicks = absoluteTick({
      day: memory.gameDay,
      tick: memory.gameTick,
    });
    const deltaTicks = Math.max(0, currentTotalTicks - memoryTotalTicks);
    const recency = 1 / (1 + rules.recencyDecayRate * deltaTicks);

    const importance = memory.importance / 10;
    const emotionalIntensity = memory.emotionalIntensity / 10;

    return (
      weights.relevance * relevance +
      weights.recency * recency +
      weights.importance * importance +
      weights.emotionalIntensity * emotionalIntensity
    );
  }

  private computeRelevance(
    memory: MemoryEntry,
    contextLower: string[],
    rules: MemoryRules,
    relatedCharacterIds?: string[],
    relatedLocation?: string,
  ): number {
    const semanticScore =
      contextLower.length > 0 ? this.keywordRelevance(memory, contextLower) : 0;

    let bonus = 0;
    if (
      relatedCharacterIds &&
      memory.relatedCharacters.some((c) => relatedCharacterIds.includes(c))
    ) {
      bonus += rules.relatedCharacterBonus;
    }
    if (relatedLocation && memory.relatedLocation === relatedLocation) {
      bonus += rules.relatedLocationBonus;
    }

    return Math.min(1, semanticScore + bonus);
  }

  private keywordRelevance(
    memory: MemoryEntry,
    contextLower: string[],
  ): number {
    if (contextLower.length === 0) return 0;

    const memoryTokens = tokenize(
      [
        memory.content,
        ...memory.tags,
        ...memory.relatedCharacters,
        memory.relatedLocation,
      ].join(" "),
    );

    let matchCount = 0;
    for (const keyword of contextLower) {
      if (memoryTokens.some((t) => t.includes(keyword) || keyword.includes(t))) {
        matchCount++;
      }
    }

    return matchCount / contextLower.length;
  }
}
