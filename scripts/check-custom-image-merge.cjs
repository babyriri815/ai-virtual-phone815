// Exercise the merged image pipeline with fake HTTP/storage, without API keys or paid requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
let request;
let asset = 'data:image/png;base64,AA==';
let generation;
const settings = {
  enabled: true, provider: 'openai', apiKey: 'test-key', baseUrl: 'https://example.invalid/v1',
  model: 'test-image', requestMode: 'server', size: 'auto', quality: 'auto', extraPrompt: '旧风格',
  characterReferences: { char: { assetId: 'reference' } },
  activeOpenAiPresetId: 'active',
  openaiPresets: [{ id: 'active', apiKey: 'test-key', baseUrl: 'https://example.invalid/v1',
    model: 'test-image', requestMode: 'server', size: 'auto', quality: 'auto', extraPrompt: '当前预设风格' }],
};
function load(file, imports) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    exports, require: id => {
      if (!(id in imports)) throw new Error(`Unexpected import ${id}`);
      return imports[id];
    },
    process: { env: {} }, Blob, File, FormData, Response, Headers, URL, AbortController, atob, Uint8Array, TypeError,
    setTimeout, clearTimeout, console,
    fetch: async (url, init) => {
      if (url !== '/api/image-generation') throw new TypeError('Simulated browser CORS failure');
      assert.equal(url, '/api/image-generation');
      request = JSON.parse(init.body);
      return Response.json({ b64: 'AA==', mimeType: 'image/png' });
    },
  }, { filename: file });
  return exports;
}
const image = load('lib/image-generation-service.ts', {
  './settings-storage': { loadImageGenerationSettings: () => settings },
  jszip: {}, './chat-asset-storage': { getChatImageFromIndexedDB: async () => asset },
  './media-cache-storage': { storeMediaBlob: async () => 'media:test' },
  './abort-utils': { throwIfAborted: signal => { if (signal?.aborted) throw new Error('aborted'); } },
  './novelai-image-config': {},
});
const retry = load('lib/generated-image-retry.ts', {
  './image-generation-service': { ...image, generateImageFromConfiguredApi: async args => {
    generation = args;
    return { blob: new Blob(['test']), mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==',
      mediaRef: 'media:test', prompt: args.description, usedReferenceImage: args.useReferenceImage };
  } },
  './chat-asset-storage': { saveChatImageToIndexedDB: async () => 'saved' },
  './chat-storage': { syncChatGeneratedImagePromptText: () => {}, updateChatMessage: (id, patch) => ({ id, ...patch }) },
  './moments-storage': { updateMomentPost: (id, patch) => ({ id, ...patch }) },
});
async function main() {
  await image.generateImageFromConfiguredApi({ description: '角色自拍', characterId: 'char', useReferenceImage: true });
  assert.equal(request.referenceImageDataUrl, asset);
  assert.match(request.prompt, /角色身份锁定/);
  assert.match(request.prompt, /当前预设风格/);
  assert.doesNotMatch(request.prompt, /旧风格/);
  await image.generateImageFromConfiguredApi({ description: '桌面上的咖啡和笔电', characterId: 'char', useReferenceImage: true });
  assert.equal(request.referenceImageDataUrl, undefined);
  assert.match(request.prompt, /无人场景锁定/);
  asset = null;
  await assert.rejects(image.generateImageFromConfiguredApi({ description: '角色自拍', characterId: 'char', useReferenceImage: true }), /参考图文件不存在/);
  for (const [description, override, expected] of [
    ['角色自拍', undefined, true], ['角色自拍', false, false],
    ['桌面上的咖啡和笔电', undefined, false], ['桌面上的咖啡和笔电', true, false],
  ]) {
    const chat = await retry.retryChatGeneratedImage({ id: 'chat', mediaType: 'image', mediaData: { label: description } }, 'char', undefined, override);
    assert.equal(generation.useReferenceImage, expected);
    assert.equal(chat.mediaData.imageGenerationUsedReference, expected);
    const post = await retry.retryMomentGeneratedPhoto({ id: 'post', authorType: 'character', authorId: 'char', photoDescription: description }, undefined, override);
    assert.equal(generation.useReferenceImage, expected);
    assert.equal(post.photoUseReferenceImage, expected);
  }
  console.log('Custom image merge checks passed: preset, identity lock, empty scene, missing reference, chat/moment retry overrides.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
