import test from 'node:test';
import assert from 'node:assert/strict';
import {REGION_SPOKEN_LANGUAGES,resolveSpokenLanguage,UNKNOWN_REGION_LANGUAGE} from '../lib/spoken-language.ts';
import {buildGemRequest,DEFAULT_GEM_REQUEST,DIRECT_PROMPT_INSTRUCTION} from '../lib/gem-request.ts';

test('all configured markets use the requested local language, manual overrides are validated, unknown markets never default to English',()=>{
  assert.deepEqual(REGION_SPOKEN_LANGUAGES,{菲律宾:'Taglish',印尼:'印尼语',马来西亚:'马来语',泰国:'泰语',越南:'越南语',新加坡:'英语',墨西哥:'西班牙语（墨西哥）',巴西:'葡萄牙语（巴西）',美国:'英语'});
  for(const [region,language] of Object.entries(REGION_SPOKEN_LANGUAGES)) {
    assert.equal(resolveSpokenLanguage(region),language);
    const request=buildGemRequest(DEFAULT_GEM_REQUEST,{duration:15,region,shooting_style:'自然光'});
    assert.ok(request.includes('口播语言：'+language));assert.ok(request.includes(DIRECT_PROMPT_INSTRUCTION));
    assert.equal(buildGemRequest(request,{duration:15,region,shooting_style:'自然光'}),request,'rebuilding is idempotent');
  }
  assert.equal(resolveSpokenLanguage('未知地区'),UNKNOWN_REGION_LANGUAGE);
  assert.equal(resolveSpokenLanguage('菲律宾','中文'),'中文');
  assert.equal(resolveSpokenLanguage('未知地区','泰语'),'泰语');
  assert.throws(()=>resolveSpokenLanguage('菲律宾','自造语言'));
});

test('legacy and custom templates gain the language line and the no-question line (never a code-box rule), and saved manual choices survive the send-time upgrade',()=>{
  const params={duration:15,region:'菲律宾',shooting_style:'实拍'};
  assert.equal(buildGemRequest('自定义内容：{地区}',params),`自定义内容：菲律宾\n口播语言：Taglish\n${DIRECT_PROMPT_INSTRUCTION}`);
  const custom=buildGemRequest('产品真实，保持原要求。\n口播语言：泰语',{...params,spoken_language:'中文'});
  assert.ok(custom.includes('口播语言：中文'));assert.ok(!custom.includes('口播语言：泰语'));
  assert.equal(buildGemRequest(custom,params),custom);
});
