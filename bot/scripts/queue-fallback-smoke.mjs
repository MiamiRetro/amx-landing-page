import { QueuedProvider } from '../dist/translate/queue/queued-provider.js';
import { SupabaseTranslationQueue } from '../dist/translate/queue/client.js';
import { AnthropicProvider } from '../dist/translate/anthropic.js';
import { Translator } from '../dist/translate/index.js';
const q=SupabaseTranslationQueue.fromEnv();
const primary=new QueuedProvider({queue:q,queueName:`translate-offline-${Date.now()}`,model:'gemma4',deadlineMs:5000,workerTtlSec:15});
const sonnet=new AnthropicProvider('claude-sonnet-5');
let calls=0;
const fallback={id:sonnet.id,translate:async (...args)=>{calls++;return sonnet.translate(...args);}};
const t=new Translator({primary,fallbacks:[fallback],timeoutMs:30000});
const started=Date.now();
try {
 const targets=['zh','ko','id','es','ja','pt','ru','tr','vi'];
 const result=await t.translate(['The meeting starts tomorrow morning.'],[[]],'en',targets,[]);
 if(!result.translated || calls!==1 || targets.some(lang=>!result.translations[lang]?.[0])) throw Error('Fallback smoke failed');
 console.log(JSON.stringify({verified:'real Sonnet fallback with no local worker',elapsedMs:Date.now()-started,sonnetCalls:calls,result}));
} finally {await primary.close();}
process.exit(0);
