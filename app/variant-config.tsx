"use client";
import { renderGemRequest } from "../lib/gem-request";
import { MOTHER_PROMPT_PLACEHOLDER } from "../lib/prompt-blocks";

export type VariantConfig = { enabled: boolean; gemId: string; template: string };

// Creation-center block for two-round tasks: the selected Gem writes a mother
// prompt, then the variant Gem returns one video per code block.
export function VariantConfigBlock({ value, gems, duration, region, shootingStyle, disabledReason, onChange }: {
  value: VariantConfig;
  gems: Array<{ id: string; name: string }>;
  duration: number;
  region: string;
  shootingStyle: string;
  disabledReason: string;
  onChange: (value: VariantConfig) => void;
}) {
  const active = value.enabled && !disabledReason;
  const preview = renderGemRequest(value.template, { duration, region, shooting_style: shootingStyle })
    .split(MOTHER_PROMPT_PLACEHOLDER).join("（这里会放入第一轮生成的母版提示词）");
  return <div className="creative-config-block variant-config" aria-label="变体两轮">
    <label className="variant-toggle">
      <input type="checkbox" checked={active} disabled={Boolean(disabledReason)}
        onChange={event => onChange({ ...value, enabled: event.target.checked })} />
      <span><b>变体两轮</b>：上面的 Gem 先出母版提示词，再交给变体 Gem；变体 Gem 输出几个代码块就生成几条视频</span>
    </label>
    {disabledReason && <p style={{ fontSize: 12, color: "#a6b5c6" }}>{disabledReason}</p>}
    {active && <>
      <label className="variant-field">
        <span>变体 Gem（第二轮）</span>
        <select aria-label="变体 Gem" value={value.gemId} onChange={event => onChange({ ...value, gemId: event.target.value })}>
          <option value="">请选择变体 Gem</option>
          {gems.map(gem => <option key={gem.id} value={gem.id}>{gem.name}</option>)}
        </select>
      </label>
      <label className="variant-field">
        <span>第二轮发送给变体 Gem 的文字（可编辑）</span>
        <textarea aria-label="第二轮发送给变体 Gem 的文字" rows={5} maxLength={12000} value={value.template}
          onChange={event => onChange({ ...value, template: event.target.value })}
          style={{ width: "100%", resize: "vertical" }} />
      </label>
      <p style={{ fontSize: 12, color: "#a6b5c6" }}>可使用 {"{时长}、{地区}、{拍摄风格}"}，必须保留 {MOTHER_PROMPT_PLACEHOLDER}（第一轮的母版会放在这里）。商品图片会再上传一次。</p>
      <details>
        <summary>查看第二轮实际发送内容</summary>
        <pre data-testid="variant-request-preview" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{preview}</pre>
      </details>
    </>}
  </div>;
}
