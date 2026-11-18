import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../src/translate/openai-compatible.js";

function fakeFetch(seen: Record<string, unknown>[]) {
  return (async (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"es":["hola"]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

const req = { segments: ["hello"], sourceLang: "en", targets: ["es"], glossary: [] } as never;

test("extraBody fields are sent and JSON mode can be turned off (infographic thinking path)", async () => {
  const seen: Record<string, unknown>[] = [];
  const p = new OpenAICompatibleProvider({
    vendor: "local-thinking", model: "flashnext-q2", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "local",
    jsonMode: false, extraBody: { reasoning_effort: "medium", max_tokens: 16384 }, fetchImpl: fakeFetch(seen),
  });
  const r = await p.translate(req);
  assert.deepEqual(r.translations.es, ["hola"]);
  assert.equal(seen[0].reasoning_effort, "medium");
  assert.equal(seen[0].max_tokens, 16384);
  assert.equal(seen[0].response_format, undefined);
});

test("without extraBody the request is unchanged (JSON mode on, no thinking fields)", async () => {
  const seen: Record<string, unknown>[] = [];
  const p = new OpenAICompatibleProvider({ vendor: "openai", model: "m", baseUrl: "https://x/v1", apiKey: "k", fetchImpl: fakeFetch(seen) });
  await p.translate(req);
  assert.deepEqual(seen[0].response_format, { type: "json_object" });
  assert.equal("reasoning_effort" in seen[0], false);
  assert.equal("max_tokens" in seen[0], false);
});
