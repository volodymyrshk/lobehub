// @vitest-environment node
import { WorkIdentifier } from '@lobechat/builtin-tool-work';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AgentWorkModel from '@/database/models/work/agentWork';
import type * as AgentWorkService from '@/server/services/workRegistration/agentWork';
import type * as ShareWorkScope from '@/server/services/workRegistration/shareWorkScope';

import type { ToolExecutionContext } from '../types';
import { getServerRuntime, hasServerRuntime } from './index';
import { workRuntime } from './work';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  createAgentWork: vi.fn(),
  deleteAgentWork: vi.fn(),
  resolveGallery: vi.fn(),
  updateAgentWork: vi.fn(),
}));

vi.mock('@/database/models/work', async () => {
  const { AgentWorkError } = await vi.importActual<typeof AgentWorkModel>(
    '@/database/models/work/agentWork',
  );
  return {
    AgentWorkError,
    WorkModel: class {
      constructor(...args: unknown[]) {
        mocks.construct(...args);
      }
      createAgentWork = mocks.createAgentWork;
      deleteAgentWork = mocks.deleteAgentWork;
      updateAgentWork = mocks.updateAgentWork;
    },
  };
});

vi.mock('@/server/services/workRegistration', async () => {
  const agentWork = await vi.importActual<typeof AgentWorkService>(
    '@/server/services/workRegistration/agentWork',
  );
  const scope = await vi.importActual<typeof ShareWorkScope>(
    '@/server/services/workRegistration/shareWorkScope',
  );
  return {
    AgentWorkRunError: agentWork.AgentWorkRunError,
    parseGalleryImageRef: agentWork.parseGalleryImageRef,
    resolveAgentWorkGalleryItems: mocks.resolveGallery,
    resolveRunWorkAccessScope: scope.resolveRunWorkAccessScope,
  };
});

const { AgentWorkError } = await import('@/database/models/work');
const { AgentWorkRunError } = await import('@/server/services/workRegistration');

const context: ToolExecutionContext = {
  agentId: 'agent',
  assistantMessageId: 'msg-1',
  operationId: 'op-step',
  rootOperationId: 'op-root',
  serverDB: {} as never,
  threadId: null,
  toolCallId: 'call-1',
  toolManifestMap: {},
  topicId: 'topic',
  userId: 'user',
  workspaceId: 'workspace',
};

const run = {
  agentId: 'agent',
  messageId: 'msg-1',
  operationId: 'op-root',
  threadId: null,
  toolCallId: 'call-1',
  toolIdentifier: 'lobe-work',
  topicId: 'topic',
  userId: 'user',
};

const galleryItems = [
  { fileId: 'file_a', mimeType: 'image/png', url: 'https://cdn/a.png' },
  { caption: 'Night', fileId: 'file_b', mimeType: 'image/png', url: 'https://cdn/b.png' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveGallery.mockResolvedValue(galleryItems);
});

describe('workRuntime', () => {
  it('is registered under lobe-work', () => {
    expect(hasServerRuntime(WorkIdentifier)).toBe(true);
    expect(workRuntime.identifier).toBe('lobe-work');
    expect(getServerRuntime(WorkIdentifier, context)).toBeDefined();
  });

  it('creates a gallery from the run context, resolving images and the cover', async () => {
    mocks.createAgentWork.mockResolvedValue({
      id: 'wk_1',
      title: 'Covers',
      type: 'gallery',
      url: 'https://cdn/b.png',
    });

    const result = await workRuntime.factory(context).createWork({
      coverImage: 'https://app.lobehub.com/f/file_b',
      items: [{ image: 'file_a' }, { caption: 'Night', image: '/f/file_b' }],
      title: 'Covers',
      type: 'gallery',
    });

    expect(mocks.construct).toHaveBeenCalledWith(context.serverDB, 'user', 'workspace', undefined);
    expect(mocks.resolveGallery).toHaveBeenCalledWith({
      db: context.serverDB,
      items: [{ image: 'file_a' }, { caption: 'Night', image: '/f/file_b' }],
      userId: 'user',
      workspaceId: 'workspace',
    });
    expect(mocks.createAgentWork).toHaveBeenCalledWith(run, {
      coverFileId: 'file_b',
      description: undefined,
      items: galleryItems,
      title: 'Covers',
      type: 'gallery',
    });
    expect(result).toMatchObject({
      state: { work: { imageCount: 2, title: 'Covers', type: 'gallery', workId: 'wk_1' } },
      success: true,
    });
  });

  it('creates a link Work', async () => {
    mocks.createAgentWork.mockResolvedValue({
      id: 'wk_2',
      resourceType: 'link',
      title: 'Site',
      type: 'external',
      url: 'https://example.com/',
    });

    const result = await workRuntime
      .factory(context)
      .createWork({ title: 'Site', type: 'link', url: 'https://example.com' });

    expect(mocks.createAgentWork).toHaveBeenCalledWith(run, {
      description: undefined,
      title: 'Site',
      type: 'link',
      url: 'https://example.com',
    });
    expect(result.state).toEqual({
      work: { title: 'Site', type: 'link', url: 'https://example.com/', workId: 'wk_2' },
    });
  });

  it('replaces the gallery on update and leaves it alone on a title-only update', async () => {
    mocks.updateAgentWork.mockResolvedValue({ id: 'wk_1', title: 'Covers v2', type: 'gallery' });
    const runtime = workRuntime.factory(context);

    await runtime.updateWork({ items: [{ image: 'file_a' }], workId: 'wk_1' });
    expect(mocks.updateAgentWork).toHaveBeenLastCalledWith(run, {
      description: undefined,
      gallery: { items: galleryItems },
      title: undefined,
      workId: 'wk_1',
    });

    await runtime.updateWork({ title: 'Covers v2', workId: 'wk_1' });
    expect(mocks.resolveGallery).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentWork).toHaveBeenLastCalledWith(run, {
      description: undefined,
      gallery: undefined,
      title: 'Covers v2',
      workId: 'wk_1',
    });
  });

  it('deletes a Work', async () => {
    mocks.deleteAgentWork.mockResolvedValue({ id: 'wk_1', title: 'Covers' });

    const result = await workRuntime.factory(context).deleteWork({ workId: 'wk_1' });

    expect(mocks.deleteAgentWork).toHaveBeenCalledWith(run, 'wk_1');
    expect(result.state).toEqual({ deleted: { title: 'Covers', workId: 'wk_1' } });
  });

  it('maps model and resolver refusals to stable codes', async () => {
    const runtime = workRuntime.factory(context);

    mocks.deleteAgentWork.mockRejectedValueOnce(new AgentWorkError('NOT_FOUND', 'Work not found'));
    expect((await runtime.deleteWork({ workId: 'wk_x' })).error).toEqual({
      message: 'Work not found',
      type: 'not_found',
    });

    mocks.updateAgentWork.mockRejectedValueOnce(
      new AgentWorkError('BAD_REQUEST', 'Only a gallery'),
    );
    expect((await runtime.updateWork({ title: 'x', workId: 'wk_1' })).error?.type).toBe(
      'invalid_input',
    );

    mocks.resolveGallery.mockRejectedValueOnce(
      new AgentWorkRunError('Image file_z not found', 404),
    );
    expect(
      (await runtime.createWork({ items: [{ image: 'file_z' }], title: 'x', type: 'gallery' }))
        .error?.type,
    ).toBe('not_found');

    // A cover that is not a LobeHub file link is refused by the ref parser.
    expect(
      (
        await runtime.createWork({
          coverImage: 'https://example.com/x.png',
          items: [{ image: 'file_a' }],
          title: 'x',
          type: 'gallery',
        })
      ).error?.type,
    ).toBe('not_found');
  });

  it("writes a share visitor's Works under the visitor topic's share scope", async () => {
    mocks.deleteAgentWork.mockResolvedValue({ id: 'wk_1', title: null });

    await workRuntime
      .factory({
        ...context,
        agentShareVisitor: { agentId: 'agent', shareId: 'share-1', visitorUserId: 'visitor' },
      })
      .deleteWork({ workId: 'wk_1' });

    const accessScope = mocks.construct.mock.calls[0][3];
    expect(accessScope).toBeDefined();
    expect(JSON.stringify(accessScope)).toContain('share-1');
    expect(JSON.stringify(accessScope)).toContain('topic');
  });

  it("checks a share visitor's gallery images against the visitor conversation", async () => {
    await workRuntime
      .factory({
        ...context,
        agentShareVisitor: { agentId: 'agent', shareId: 'share-1', visitorUserId: 'visitor' },
      })
      .createWork({ items: [{ image: 'file_a' }], title: 'Covers', type: 'gallery' });

    expect(mocks.resolveGallery).toHaveBeenCalledWith(
      expect.objectContaining({ visitorTopicId: context.topicId }),
    );
  });

  it('refuses every call outside a conversation instead of failing dispatch', async () => {
    const runtime = workRuntime.factory({ ...context, topicId: undefined });

    const result = await runtime.createWork({ title: 'Site', type: 'link', url: 'https://x.dev' });

    expect(result).toMatchObject({ error: { type: 'unavailable' }, success: false });
    expect(mocks.construct).not.toHaveBeenCalled();
  });
});
