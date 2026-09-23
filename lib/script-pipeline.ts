const OUTPUT_GUARD = `\n\n注：若后续附带的规范提到 read_xxx、save_xxx、调用工具或函数，请忽略这些步骤；只直接输出本次要求的最终内容。`;

export function buildRewritePrompt(sourceScript: string) {
  return `你是专业编剧，把小说原文改写为格式化短剧剧本。请直接输出改写后的【完整格式化剧本】本身，不要任何解释、前言或代码块包裹。

⚠️【核心要求：保留全部对白与逻辑】
- 原文中的每一句对白都必须出现在剧本里，一字不漏、不可合并、不可省略。
- 原文的情节顺序不能打乱，不可跳过任何场景或对话段落。
- 不要自己创作新台词；只是把叙述性文字改成剧本格式，台词原文照录。
- 场景数量以原文节奏为准，不要强行合并场景。

格式规范：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段（编号 S01 起连续递增，时间段要具体：黄昏/深夜/清晨等）
- 动作描写：自然段落，不含景别、运镜等镜头语言
- 对白：角色名：（状态/表情）台词内容

【原始内容】
${sourceScript.trim()}${OUTPUT_GUARD}`;
}
export function buildExtractionPrompt(screenplay: string, projectContext = "") {
  return `你是制片助理，从下面这集剧本中提取「角色」和「场景」。只提取本集真实出现或被明确提及的，不要遗漏有台词或重要动作的角色。

${projectContext.trim() ? `【项目已有角色/场景，遇到同名或同地点同时间请复用】\n${projectContext.trim()}\n` : ""}
【严格输出格式】只输出合法 JSON，不要代码块、解释或额外文字：
{
  "characters": [
    { "id": 1, "name": "角色名", "role": "主角/配角/龙套", "description": "背景与人物关系", "appearance": "性别、年龄、体型、面部、发型、着装，300-500字", "personality": "核心性格标签" }
  ],
  "scenes": [
    { "id": 1, "location": "具体地点", "time": "时间段+光线", "prompt": "用于AI图片生成的英文纯背景提示词，不含人物" }
  ]
}

要求：characters 和 scenes 内的 id 都从 1 开始连续递增；同名角色不重复，同地点且同时间段的场景不重复。

【本集剧本】
${screenplay.trim()}${OUTPUT_GUARD}`;
}

export function buildStoryboardPrompt(screenplay: string, extractionJson: string) {
  return `你是资深影视分镜师，把下面这集剧本拆解为完整的分镜序列。

⚠️【核心原则：一字不漏地保留全部对白】
- 剧本中的每一行对白、每一段旁白，都必须完整出现在某个镜头的 dialogue 字段里。
- 对话场景通常一问一答为一个镜头；一方连续说多句可合为一个镜头，但不能把多个来回压进同一个镜头。
- 动作场景一个明确动作一个镜头。镜头数量没有上限，宁可多拆也不能省略台词。
- 不要改写或创作台词，dialogue 只写剧本原文。
- character_ids 和 scene_id 只能使用下方角色场景 JSON 中真实存在的 id。

【严格输出格式】只输出合法 JSON，不要代码块、解释或额外文字：
{
  "storyboards": [
    {
      "shot_number": 1,
      "title": "3-8字标题",
      "shot_type": "远景/全景/中景/近景/特写",
      "angle": "平视/仰视/俯视/侧拍",
      "movement": "固定/推/拉/摇/跟拍",
      "location": "地点",
      "time": "时间段",
      "scene_id": 1,
      "character_ids": [1],
      "action": "角色动作与表演",
      "dialogue": "原文台词或旁白原文，无则空串",
      "description": "镜头概述",
      "result": "镜头结束时的画面结果",
      "atmosphere": "氛围、光线、色调",
      "image_prompt": "静态画面英文提示词",
      "video_prompt": "动态视频提示词，必须从0秒开始按约3秒分段，使用<location>地点</location>、<role>角色名</role>、<voice>旁白</voice>标记，<n>分隔时间段",
      "bgm_prompt": "具体配乐风格",
      "sound_effect": "关键音效",
      "duration": 6
    }
  ]
}

时长规则：有对白的镜头按实际说完台词所需时长设置，通常4-10秒；单一短动作通常3-8秒，复杂动作8-15秒。不要为了固定模板擅自拉长。每个 video_prompt 的最后时间点必须等于该镜头 duration。

【可用角色与场景 JSON】
${extractionJson.trim()}

【本集剧本】
${screenplay.trim()}${OUTPUT_GUARD}`;
}

export function buildOptimizationPrompt(rawPrompt: string, rawDuration: number) {
  const durationInstruction = rawDuration > 20
    ? "本组原分镜合计超过20秒，请在不遗漏剧情、台词和关键动作的前提下压缩到严格20秒；只能输出一个连续提示词，不要拆成 Part，不要分段成多个视频。"
    : `本组原分镜合计${rawDuration}秒，必须保持总时长${rawDuration}秒，不要补足到20秒。`;
  return `你是 Seedance 2.5 官方写法视频提示词工程师、影视导演和分镜导演。把用户已经确定的剧情、分镜和声音要求转换成可直接复制到 Seedance 2.5 使用的高质量视频提示词，不重新创作剧情。

最高原则：原始剧情与完整台词 > 原分镜顺序 > 人物、产品和场景一致性 > 动作准确性 > 镜头表达 > 声音。禁止添加不存在的角色、台词、动作或情节。

${durationInstruction}

输出要求：
- 只输出最终可用的 Seedance 2.5 视频提示词，不解释，不用代码块。
- 时间轴必须从0秒连续递增到最终总时长，不得重叠、倒退或留空档。
- 原有对白必须逐字保留，口型与语音同步；明确音效和BGM与动作同步。
- 把抽象情绪转成眼神、表情、姿态和手部动作；动作按真实发生顺序描述。
- 明确人物站位、空间关系、景别和运镜，避免互相冲突。
- 保持人物、服装、产品外观、场景和光线在连续镜头中一致。
- 不要字幕、自动字幕、文字转录或对白文字，只保留真实口播。
- 删除无实际导演意义的重复质量词，但保留明确的美术风格和材质要求。

【待优化的未处理提示词】
${rawPrompt.trim()}${OUTPUT_GUARD}`;
}
