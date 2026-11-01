import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, LANG_NAMES, isLang } from '../src/config.js';
import { buildUserPrompt } from '../src/translate/prompt.js';
import { LlamaClient } from '../src/translate/queue/llama.js';
test('Gemma requests strict schema to prevent omitted target languages', async()=>{
 let captured: any;
 const client=new LlamaClient({baseUrl:'http://test.invalid',fetchImpl:async (_url,init)=>{
  captured=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));
 }});
 const schema={type:'object',required:LANGS.filter(l=>l!=='en')};
 await client.chat('system','user',200,AbortSignal.timeout(1000),schema);
 assert.deepEqual(captured.response_format,{type:'json_schema',json_schema:{name:'translations',strict:true,schema}});
 assert.equal(captured.chat_template_kwargs.enable_thinking,false);
});
test('production supports English and nine migration target languages without channel changes',()=>{
 const expected=['en','zh','ko','id','es','ja','pt','ru','tr','vi'];
 assert.deepEqual([...LANGS].sort(),expected.sort());
 for(const lang of expected) assert.equal(isLang(lang),true);
 const targets=LANGS.filter(l=>l!=='en');
 const prompt=buildUserPrompt({sourceLang:'en',targets,segments:['Hello'],glossary:[]});
 for(const lang of targets) assert.ok(prompt.includes(`${LANG_NAMES[lang]} (${lang})`));
});
