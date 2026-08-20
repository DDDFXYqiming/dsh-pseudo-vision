import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';

import {
    GENERIC_PROVIDER_PREFIX,
    ProviderVisionBridgeAdapter,
    genericProviderId,
    isGenericProviderId,
} from '../lib/index.js';

const IMAGE = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000028000000280802000000039c2f3a0000000970485973000003e8000003e801b57b526b0000004549444154789cedcd3101002000c3b0fa370df710509ec640389f506c419b1ec51abc6a156bf0aa55acc1ab56b106af5ac51abc6a156bf0aa55acc1ab56b106af5ac5c78a2f2cd0ae4f897a37f10000000049454e44ae426082',
    'hex',
);

function createRuntime(calls: Array<Record<string, unknown>>): LlmRuntime {
    return {
        listProviders: () => [{ id: 'other-provider', name: 'Other Provider' }],
        providerRetryPolicy: () => undefined,
        listModels: async (provider: string) => [{
            provider,
            id: 'text-model',
            name: 'Text Model',
            inputModalities: ['text'],
        }],
        resolveModelInfo: async (provider: string, model: string) => ({
            provider,
            id: model,
            name: 'Text Model',
            inputModalities: ['text'],
        }),
        stream: (options: Record<string, unknown>) => (async function* () {
            calls.push(options);
            yield { type: 'finish', reason: { kind: 'stop' } };
        })(),
    } as unknown as LlmRuntime;
}

function imageOptions(provider: string): Record<string, unknown> {
    return {
        provider,
        model: 'text-model',
        system: 'base system',
        messages: [{
            role: 'user',
            source: { kind: 'user' },
            content: [
                { type: 'text', text: '请读图' },
                {
                    type: 'image',
                    attachment: {
                        attachmentId: 'sha256:fixture',
                        mediaType: 'image/png',
                        bytes: IMAGE.byteLength,
                    },
                },
            ],
        }],
    };
}

test('generic provider ids are namespaced and reversible by prefix', () => {
    const id = genericProviderId('other-provider');
    assert.equal(id, `${GENERIC_PROVIDER_PREFIX}other-provider`);
    assert.equal(isGenericProviderId(id), true);
    assert.equal(isGenericProviderId('other-provider'), false);
});

test('generic sibling route advertises image and delegates image-free requests', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = createRuntime(calls);
    const alias = genericProviderId('other-provider');
    const targets = new Map([[alias, 'other-provider']]);
    const adapter = new ProviderVisionBridgeAdapter(
        runtime,
        {} as AttachmentStore,
        targets,
        { cacheDir: '.tmp-test-cache', bypassCache: false, maxImages: 8 },
    );

    const models = await adapter.listModels(alias);
    assert.equal(models[0]?.provider, alias);
    assert.deepEqual(models[0]?.inputModalities, ['text', 'image']);

    for await (const _chunk of adapter.stream({
        provider: alias,
        model: 'text-model',
        messages: [{
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'hello' }],
        }],
    } as never)) {
        // consume the stream
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.provider, 'other-provider');
});

test('native vision models are not listed on the sibling route', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = {
        listProviders: () => [{ id: 'vision-provider', name: 'Vision Provider' }],
        providerRetryPolicy: () => undefined,
        listModels: async (provider: string) => [{
            provider,
            id: 'vision-model',
            name: 'Vision Model',
            inputModalities: ['text', 'image'],
        }],
        resolveModelInfo: async (provider: string, model: string) => ({
            provider,
            id: model,
            name: 'Vision Model',
            inputModalities: ['text', 'image'],
        }),
        stream: (options: Record<string, unknown>) => (async function* () {
            calls.push(options);
            yield { type: 'finish', reason: { kind: 'stop' } };
        })(),
    } as unknown as LlmRuntime;
    const alias = genericProviderId('vision-provider');
    const adapter = new ProviderVisionBridgeAdapter(
        runtime,
        {} as AttachmentStore,
        new Map([[alias, 'vision-provider']]),
        { cacheDir: '.tmp-test-cache', bypassCache: false, maxImages: 8 },
    );

    const models = await adapter.listModels(alias);
    assert.equal(models.length, 0);
    await assert.rejects(
        () => adapter.resolveModel(alias, 'vision-model'),
        (error: unknown) =>
            (error as { code?: string }).code === 'PSEUDO_VISION_NATIVE_MODEL',
    );
});

test('generic sibling route removes images before delegating to text-only provider', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-pseudo-vision-test-'));
    try {
        const digest = createHash('sha256').update(IMAGE).digest('hex');
        await writeFile(join(cacheDir, `${digest}.json`), JSON.stringify({ text: 'cached local vision evidence' }));

        const calls: Array<Record<string, unknown>> = [];
        const runtime = createRuntime(calls);
        const alias = genericProviderId('other-provider');
        const targets = new Map([[alias, 'other-provider']]);
        const attachments = {
            readImage: async (ref: unknown) => ({ data: IMAGE, ref }),
        } as unknown as AttachmentStore;
        const adapter = new ProviderVisionBridgeAdapter(
            runtime,
            attachments,
            targets,
            { cacheDir, bypassCache: false, maxImages: 8 },
        );

        for await (const _chunk of adapter.stream(imageOptions(alias) as never)) {
            // consume the stream
        }

        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.provider, 'other-provider');
        const delegated = calls[0] as { messages: Array<{ content: Array<{ type: string; text?: string }> }>; system: string };
        assert.equal(delegated.messages[0]?.content.some((block) => block.type === 'image'), false);
        assert.match(delegated.system, /cached local vision evidence/);
    } finally {
        await rm(cacheDir, { recursive: true, force: true });
    }
});
