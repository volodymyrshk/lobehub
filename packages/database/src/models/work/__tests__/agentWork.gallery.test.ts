// @vitest-environment node
import type { AgentWorkRunContext, GalleryWorkImage } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { topics, works, workVersions } from '../../../schemas';
import { AgentWorkError, WorkModel } from '..';
import {
  agentId,
  cleanupWorkTestData,
  seedWorkTestData,
  serverDB,
  threadId,
  topicId,
  userId,
  userId2,
} from './_fixtures';

beforeEach(seedWorkTestData);
afterEach(cleanupWorkTestData);

const run: AgentWorkRunContext = {
  agentId,
  messageId: null,
  operationId: 'op-gallery',
  threadId,
  toolCallId: 'call-gallery-1',
  toolIdentifier: 'lobe-work',
  topicId,
  userId,
};

const image = (n: number, caption?: string): GalleryWorkImage => ({
  caption,
  fileId: `file-cd-${n}`,
  mimeType: 'image/png',
  url: `https://app.example.com/f/file-cd-${n}`,
});

const workModel = () => new WorkModel(serverDB, userId);

const expectAgentWorkError = async (promise: Promise<unknown>, code: AgentWorkError['code']) => {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AgentWorkError);
  expect((error as AgentWorkError).code).toBe(code);
};

const createGallery = (overrides: Partial<AgentWorkRunContext> = {}) =>
  workModel().createAgentWork(
    { ...run, ...overrides },
    {
      coverFileId: 'file-cd-2',
      items: [image(1, 'Apple'), image(2, 'Microsoft')],
      title: 'Top ten CD shelf',
      type: 'gallery',
    },
  );

describe('WorkModel · agent galleries', () => {
  it('creates a gallery whose card shows the cover and whose version holds every image', async () => {
    const work = await createGallery();

    expect(work).toMatchObject({
      resourceType: 'gallery',
      title: 'Top ten CD shelf',
      toolIdentifier: 'lobe-work',
      type: 'gallery',
      url: 'https://app.example.com/f/file-cd-2',
    });
    expect(work.resourceId).toMatch(/^gal_/);
    const [row] = await serverDB.select().from(works).where(eq(works.id, work.id));
    expect(row.metadata).toEqual({ agentEditable: true });

    const [version] = await workModel().listVersions(work.id);
    expect(version).toMatchObject({
      changeType: 'created',
      rootOperationId: run.operationId,
      toolCallId: run.toolCallId,
    });
    expect(version.metadata?.gallery).toEqual({
      coverFileId: 'file-cd-2',
      items: [
        { caption: 'Apple', fileId: 'file-cd-1', mimeType: 'image/png', url: image(1).url },
        { caption: 'Microsoft', fileId: 'file-cd-2', mimeType: 'image/png', url: image(2).url },
      ],
    });

    // The reply's Work card is found through the run's operation, opted-in clients only.
    const listed = await workModel().listByRootOperation({
      includeFileWorks: true,
      rootOperationId: run.operationId,
    });
    expect(listed.map((item) => item.id)).toEqual([work.id]);
    const legacy = await workModel().listByRootOperation({ rootOperationId: run.operationId });
    expect(legacy).toEqual([]);
  });

  it('makes every create a new gallery', async () => {
    const first = await createGallery();
    const second = await createGallery({ toolCallId: 'call-gallery-2' });
    expect(second.id).not.toBe(first.id);
  });

  it('rejects an empty list, repeated images and a cover outside the list', async () => {
    for (const gallery of [
      { items: [] },
      { items: [image(1), image(1)] },
      { coverFileId: 'file-cd-9', items: [image(1)] },
    ]) {
      await expectAgentWorkError(
        workModel().createAgentWork(run, { ...gallery, title: 'Bad', type: 'gallery' }),
        'BAD_REQUEST',
      );
    }
    expect(await serverDB.select().from(works)).toEqual([]);
  });

  it('caps the text a model writes and refuses an empty title on update', async () => {
    await expectAgentWorkError(
      workModel().createAgentWork(run, {
        items: [{ ...image(1), caption: 'x'.repeat(501) }],
        title: 'Shelf',
        type: 'gallery',
      }),
      'BAD_REQUEST',
    );
    await expectAgentWorkError(
      workModel().createAgentWork(run, {
        title: 'x'.repeat(201),
        type: 'link',
        url: 'https://preview.example.com',
      }),
      'BAD_REQUEST',
    );
    const gallery = await createGallery();
    for (const patch of [{ title: ' ' }, { description: 'x'.repeat(2001) }]) {
      await expectAgentWorkError(
        workModel().updateAgentWork(run, { ...patch, workId: gallery.id }),
        'BAD_REQUEST',
      );
    }
  });

  it('replaces the whole image list on update and keeps the title', async () => {
    const created = await createGallery();

    const updated = await workModel().updateAgentWork(
      { ...run, toolCallId: 'call-gallery-update' },
      { gallery: { items: [image(3, 'Nvidia'), image(1, 'Apple')] }, workId: created.id },
    );

    // No cover named: the first image becomes the cover.
    expect(updated).toMatchObject({ title: 'Top ten CD shelf', url: image(3).url });
    const versions = await workModel().listVersions(created.id);
    expect(versions).toHaveLength(2);
    const latest = versions.find((version) => version.changeType === 'updated');
    expect(latest?.metadata?.gallery).toEqual({
      items: [
        { caption: 'Nvidia', fileId: 'file-cd-3', mimeType: 'image/png', url: image(3).url },
        { caption: 'Apple', fileId: 'file-cd-1', mimeType: 'image/png', url: image(1).url },
      ],
    });

    const renamed = await workModel().updateAgentWork(
      { ...run, toolCallId: 'call-gallery-rename' },
      { title: 'Shelf v2', workId: created.id },
    );
    expect(renamed).toMatchObject({ title: 'Shelf v2', url: image(3).url });
    const [, , third] = (await workModel().listVersions(created.id)).sort(
      (a, b) => a.version - b.version,
    );
    // A title-only update carries the images over.
    expect(third.metadata?.gallery?.items.map((item) => item.fileId)).toEqual([
      'file-cd-3',
      'file-cd-1',
    ]);
  });

  it('gives images only to a gallery, and a gallery no file', async () => {
    const gallery = await createGallery();
    const link = await workModel().createAgentWork(run, {
      title: 'Preview',
      type: 'link',
      url: 'https://preview.example.com',
    });

    await expectAgentWorkError(
      workModel().updateAgentWork(run, { gallery: { items: [image(1)] }, workId: link.id }),
      'BAD_REQUEST',
    );
    await expectAgentWorkError(
      workModel().updateAgentWork(run, {
        file: { fileId: 'file-x', fileUrl: 'https://app.example.com/f/file-x' },
        workId: gallery.id,
      }),
      'BAD_REQUEST',
    );
  });
});

describe('WorkModel · deleting agent Works', () => {
  it('removes the Work card and its versions', async () => {
    const gallery = await createGallery();
    await workModel().updateAgentWork(
      { ...run, toolCallId: 'call-gallery-update' },
      { title: 'Renamed', workId: gallery.id },
    );

    expect(await workModel().deleteAgentWork(run, gallery.id)).toEqual({
      id: gallery.id,
      title: 'Renamed',
    });
    expect(await serverDB.select().from(works).where(eq(works.id, gallery.id))).toEqual([]);
    expect(
      await serverDB.select().from(workVersions).where(eq(workVersions.workId, gallery.id)),
    ).toEqual([]);
  });

  it('deletes a link Work the agent created', async () => {
    const link = await workModel().createAgentWork(run, {
      title: 'Wrong link',
      type: 'link',
      url: 'https://wrong.example.com',
    });
    await workModel().deleteAgentWork(run, link.id);
    expect(await serverDB.select().from(works)).toEqual([]);
  });

  it('refuses a Work registered automatically', async () => {
    const scanned = await workModel().registerFile({
      filePath: '/mnt/data/deck.pptx',
      metadata: { fileId: 'file-deck', filePath: '/mnt/data/deck.pptx' },
      rootOperationId: 'op-scan',
      title: 'deck.pptx',
      toolCallId: 'op:op-scan',
      toolIdentifier: 'lobe-cloud-sandbox',
      toolName: 'writeFile',
      topicId,
      userId,
    });

    await expectAgentWorkError(workModel().deleteAgentWork(run, scanned.id), 'FORBIDDEN');
    expect(await serverDB.select().from(works).where(eq(works.id, scanned.id))).toHaveLength(1);
  });

  it('refuses a run in another conversation or of another user', async () => {
    const gallery = await createGallery();
    const otherTopicId = 'work-gallery-other-topic';
    await serverDB.insert(topics).values({ id: otherTopicId, userId });

    await expectAgentWorkError(
      workModel().deleteAgentWork({ ...run, topicId: otherTopicId }, gallery.id),
      'NOT_FOUND',
    );
    await expectAgentWorkError(
      new WorkModel(serverDB, userId2).deleteAgentWork({ ...run, userId: userId2 }, gallery.id),
      'NOT_FOUND',
    );
    expect(await serverDB.select().from(works).where(eq(works.id, gallery.id))).toHaveLength(1);
  });
});
