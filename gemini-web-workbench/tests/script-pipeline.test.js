const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function runtime() {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "gemini-preload.js"),
    "utf8"
  );
  const context = vm.createContext({
    require(name) {
      if (name === "electron") {
        return { ipcRenderer: { on() {}, send() {}, invoke: async () => ({}) } };
      }
      throw new Error(`Unexpected require: ${name}`);
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
  });
  vm.runInContext(source, context, { filename: "gemini-preload.js" });
  return context;
}

test("script shots are grouped in order without exceeding 25 seconds", () => {
  const context = runtime();
  const groups = JSON.parse(
    vm.runInContext(
      `JSON.stringify(buildRawGroups({storyboards: [
        {shot_number: 1, duration: 8, video_prompt: "0-8秒：镜头一", dialogue: "台词一", sound_effect: "金属声", bgm_prompt: "喜剧"},
        {shot_number: 2, duration: 8, video_prompt: "0-8s：镜头二", dialogue: "", sound_effect: "碰撞声", bgm_prompt: "喜剧"},
        {shot_number: 3, duration: 8, video_prompt: "0-8秒：镜头三", dialogue: "台词三", sound_effect: "提示音", bgm_prompt: "回忆"},
        {shot_number: 4, duration: 6, video_prompt: "0-6秒：镜头四", dialogue: "台词四", sound_effect: "关机声", bgm_prompt: "悲伤"}
      ]}))`,
      context
    )
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].shotNumbers, [1, 2, 3]);
  assert.equal(groups[0].rawDuration, 24);
  assert.equal(groups[0].targetDuration, 20);
  assert.match(groups[0].rawPrompt, /0-8秒：镜头一/);
  assert.match(groups[0].rawPrompt, /8-16秒：镜头二/);
  assert.match(groups[0].rawPrompt, /16-24秒：镜头三/);
  assert.match(groups[0].rawPrompt, /【配音\/台词】台词一\n台词三/);
  assert.deepEqual(groups[1].shotNumbers, [4]);
  assert.equal(groups[1].targetDuration, 6);
});

test("optimizer keeps short groups exact and compresses long groups without parts", () => {
  const context = runtime();
  const shortPrompt = vm.runInContext(
    `optimizationPrompt({rawDuration: 18, rawPrompt: "raw"})`,
    context
  );
  const longPrompt = vm.runInContext(
    `optimizationPrompt({rawDuration: 24, rawPrompt: "raw"})`,
    context
  );
  assert.match(shortPrompt, /必须保持总时长18秒/);
  assert.match(shortPrompt, /不要补足到20秒/);
  assert.match(longPrompt, /压缩到严格20秒/);
  assert.match(longPrompt, /不要拆成Part或多个视频/);
  assert.match(longPrompt, /对白逐字保留/);
  assert.match(longPrompt, /"segments"/);
  assert.match(longPrompt, /字段名、字段顺序和数据类型不得改变/);
});

test("all optimized groups are rendered with one fixed Chinese template", () => {
  const context = runtime();
  const rendered = vm.runInContext(
    `formatOptimizedPrompt({
      style: "次世代游戏风格，角色与产品全片一致，画面无字幕。",
      segments: [
        {start: 0, end: 2.5, shot_and_camera: "中景，缓慢推镜", visual: "零一走入街道", action: "步伐沉重", dialogue: "", sound_effect: "脚步声", bgm: "喜剧电子乐"},
        {start: 2.5, end: 6, shot_and_camera: "特写，固定镜头", visual: "支架落地", action: "碎屑飞溅", dialogue: "原文台词", sound_effect: "金属撞击声", bgm: "音乐持续"}
      ]
    }, {targetDuration: 6})`,
    context
  );
  assert.match(rendered, /^【整体风格与画质规范】/);
  assert.match(rendered, /【分镜与时间轴（全长严格6秒连续递增）】/);
  assert.match(rendered, /\[00:00-00:02\.5\]/);
  assert.match(rendered, /景别与运镜：中景，缓慢推镜/);
  assert.match(rendered, /对白口播：原文台词/);
  assert.match(rendered, /【SFX】金属撞击声【BGM】音乐持续/);
});

test("optimized template rejects gaps and wrong total duration", () => {
  const context = runtime();
  assert.throws(
    () => vm.runInContext(
      `formatOptimizedPrompt({style:"风格",segments:[{start:1,end:6,shot_and_camera:"中景",visual:"画面"}]},{targetDuration:6})`,
      context
    ),
    /时间轴不连续/
  );
  assert.throws(
    () => vm.runInContext(
      `formatOptimizedPrompt({style:"风格",segments:[{start:0,end:5,shot_and_camera:"中景",visual:"画面"}]},{targetDuration:6})`,
      context
    ),
    /应为 6 秒/
  );
});

test("script pipeline retries only the failing stage instead of restarting the job", () => {
  const preload = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "gemini-preload.js"),
    "utf8"
  );
  const bridge = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "bridge-engine.js"),
    "utf8"
  );
  assert.match(preload, /async function runJsonRound/);
  assert.match(preload, /保持全部字段和内容不变/);
  assert.match(preload, /if \(!rewrittenScript\)/);
  assert.match(preload, /if \(!extractionJson\)/);
  assert.match(preload, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/);
  assert.match(bridge, /job\.kind === "script-pipeline" \? 1 : 2/);
});

test("protected desktop runtime dispatches the script pipeline", () => {
  const protectedBuild = fs.readFileSync(
    path.resolve(__dirname, "..", "scripts", "build-protected.cjs"),
    "utf8"
  );
  assert.match(protectedBuild, /executeGeminiJob\(job\)/);
  const preload = fs.readFileSync(path.resolve(__dirname, "..", "src", "gemini-preload.js"), "utf8");
  assert.match(preload, /job\.kind === "script-pipeline"/);
  assert.match(preload, /runScriptPipelineJob\(job\)/);
  assert.match(protectedBuild, /optimizedGroupsJson/);
});
