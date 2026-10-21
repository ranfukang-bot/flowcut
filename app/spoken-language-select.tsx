"use client";
import { REGION_SPOKEN_LANGUAGES, SPOKEN_LANGUAGE_OPTIONS, resolveSpokenLanguage } from '../lib/spoken-language';

export function SpokenLanguageSelect({region,value,onChange}:{region:string;value:string;onChange:(value:string)=>void}) {
  return <label>口播语言
    <select aria-label="口播语言" value={value} onChange={event=>onChange(event.target.value)}>
      <option value="auto">自动（按地区）</option>
      {SPOKEN_LANGUAGE_OPTIONS.map(language=><option key={language} value={language}>{language}</option>)}
    </select>
    <small>本次：{resolveSpokenLanguage(region,value)}</small>
    {!Object.hasOwn(REGION_SPOKEN_LANGUAGES,region.trim()) && <small role="status">这个地区还没设口播语言，请补进地区和口播语言对照表。</small>}
  </label>;
}
