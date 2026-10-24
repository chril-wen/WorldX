---

## 世界扩展（Expand World）

当前世界已有角色列表：
{{existingCharacters}}

当前世界已有的地点：
{{existingLocations}}

用户想添加的内容：{{userPrompt}}

设计要求：
- 新角色必须与现有世界的文化背景、时代、氛围完全自洽
- 新角色数量：1–2 人/次
- 新角色应填补现有世界的空白，而非重复已有角色
- 新地点必须有明确的视觉识别特征（俯视外观可区分）
- 新角色和已有角色之间应有自然的互动可能性

输出一个 JSON 对象（不要使用 markdown 代码块，不要添加任何注释或说明文字）：

```json
{
  "characters": [
    {
      "name": "角色名字",
      "role": "角色定位（如：流浪商人、神秘旅客、新搬来的邻居）",
      "personality": "性格描述",
      "appearance": "外貌描述，必须包含身份关键词 + 发型、服装颜色、配饰",
      "appearanceHint": "旁观者第一眼印象（一句话）",
      "motivation": "在这个世界中的驱动力",
      "socialStyle": "introvert / extrovert_selective / introvert",
      "initialMemories": ["背景记忆"]
    }
  ],
  "regions": [
    {
      "id": "region_id",
      "name": "地点名称",
      "description": "功能描述（一句话）",
      "type": "building | outdoor",
      "enterable": true | false,
      "visualDescription": "俯视外观（一句话）",
      "interactions": []
    }
  ],
  "interactiveElements": [
    {
      "id": "element_id",
      "name": "元素名称",
      "description": "功能描述（一句话）",
      "visualDescription": "俯视外观（一句话）",
      "interactions": []
    }
  ]
}
```

规则：
- `characters` 至少 1 项；`regions` 和 `interactiveElements` 至少 1 项（不能只添加角色）
- 所有新增内容（角色 + 地点）不超过 4 项/次
- 语言与当前世界一致
- 仅输出合法的 JSON（前后不要有任何文字）。
