// @vitest-environment node
import type { AgentWorkRunContext } from '@lobechat/types';
import { AGENT_WORK_CLI_TOOL_IDENTIFIER } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { topics, works, workspaces } from '../../../schemas';
import { TaskModel } from '../../task';
import { AgentWorkError, WorkModel } from '..';
import { fileWorkResourceId } from '../file';
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
  operationId: 'op-agent-work',
  threadId,
  topicId,
  userId,
  userId2,
};

const reportFile = {
  fileId: 'file-report-1',
  filePath: '/workspace/out/report.pdf',
  fileSize: 1024,
  fileUrl: 'https://app.example.com/f/file-report-1',
  mimeType: 'application/pdf',
};

const workModel = () => new WorkModel(serverDB, userId);

const storedMetadata = async (workId: string) => {
  const [row] = await serverDB.select().from(works).where(eq(works.id, workId));
  return row.metadata;
};

const expectAgentWorkError = async (promise: Promise<unknown>, code: AgentWorkError['code']) => {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AgentWorkError);
  expect((error as AgentWorkError).code).toBe(code);
};

describe('WorkModel · agent-created Works', () => {
  it('registers a link the agent produced under the running operation', async () => {
    const work = await workModel().createAgentWork(run, {
      description: 'Preview deployment',
      title: 'Landing preview',
      type: 'link',
      url: 'https://preview.example.com/landing',
    });

    expect(work).toMatchObject({
      description: 'Preview deployment',
      resourceId: 'https://preview.example.com/landing',
      resourceType: 'link',
      title: 'Landing preview',
      toolIdentifier: AGENT_WORK_CLI_TOOL_IDENTIFIER,
      type: 'external',
      url: 'https://preview.example.com/landing',
    });
    expect(await storedMetadata(work.id)).toEqual({ agentEditable: true });

    // The completion lifecycle anchors the card through the run's operation id.
    const listed = await workModel().listByRootOperation({ rootOperationId: run.operationId });
    expect(listed.map((item) => item.id)).toEqual([work.id]);
  });

  it('refuses GitHub and Linear links and non-http(s) URLs', async () => {
    for (const url of [
      'https://github.com/owner/repo/pull/1',
      'https://gist.github.com/owner/abc',
      'https://linear.app/team/issue/LOBE-1',
      'javascript:alert(1)',
    ]) {
      await expectAgentWorkError(
        workModel().createAgentWork(run, { title: 'x', type: 'link', url }),
        'BAD_REQUEST',
      );
    }
    expect(await serverDB.select().from(works)).toEqual([]);
  });

  it('registers a file with the file name as the default title', async () => {
    const work = await workModel().createAgentWork(run, { file: reportFile, type: 'file' });

    expect(work).toMatchObject({
      description: reportFile.filePath,
      resourceId: fileWorkResourceId(userId, topicId, reportFile.filePath),
      title: 'report.pdf',
      type: 'file',
    });
    expect(await storedMetadata(work.id)).toEqual({ agentEditable: true });
    const [version] = await workModel().listVersions(work.id);
    expect(version).toMatchObject({
      changeType: 'created',
      metadata: expect.objectContaining({ fileId: 'file-report-1', mimeType: 'application/pdf' }),
      rootOperationId: run.operationId,
    });
  });

  it('adds a version when the agent creates the same file path again', async () => {
    const first = await workModel().createAgentWork(run, { file: reportFile, type: 'file' });
    const second = await workModel().createAgentWork(run, {
      file: { ...reportFile, fileId: 'file-report-2' },
      title: 'Q3 report',
      type: 'file',
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Q3 report');
    expect(await workModel().listVersions(first.id)).toHaveLength(2);
  });

  it('refuses to take over a file the completion scan registered', async () => {
    await workModel().registerFile({
      filePath: reportFile.filePath,
      metadata: { fileId: 'file-scanned', filePath: reportFile.filePath },
      rootOperationId: 'op-scan',
      title: 'report.pdf',
      toolCallId: 'op:op-scan',
      toolIdentifier: 'lobe-cloud-sandbox',
      toolName: 'writeFile',
      topicId,
      userId,
    });

    await expectAgentWorkError(
      workModel().createAgentWork(run, { file: reportFile, type: 'file' }),
      'CONFLICT',
    );
  });

  it('updates only the fields given and keeps the rest', async () => {
    const created = await workModel().createAgentWork(run, {
      description: 'First draft',
      title: 'Landing preview',
      type: 'link',
      url: 'https://preview.example.com/v1',
    });

    const updated = await workModel().updateAgentWork(run, {
      description: 'Second draft',
      workId: created.id,
    });
    expect(updated).toMatchObject({
      description: 'Second draft',
      id: created.id,
      title: 'Landing preview',
      url: 'https://preview.example.com/v1',
    });

    const versions = await workModel().listVersions(created.id);
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.changeType === 'updated')).toHaveLength(1);

    // The link stays its identity: creating it again adds to the same Work.
    const again = await workModel().createAgentWork(run, {
      title: 'Landing preview',
      type: 'link',
      url: 'https://preview.example.com/v1',
    });
    expect(again.id).toBe(created.id);
  });

  it('replaces the file of a file Work', async () => {
    const created = await workModel().createAgentWork(run, { file: reportFile, type: 'file' });

    const updated = await workModel().updateAgentWork(run, {
      file: { ...reportFile, fileId: 'file-report-2', fileUrl: 'https://app.example.com/f/2' },
      workId: created.id,
    });

    expect(updated).toMatchObject({ title: 'report.pdf', url: 'https://app.example.com/f/2' });
    const versions = await workModel().listVersions(created.id);
    expect(versions.map((version) => version.metadata?.fileId)).toContain('file-report-2');
  });

  it('refuses to update a Work registered automatically', async () => {
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

    await expectAgentWorkError(
      workModel().updateAgentWork(run, { title: 'Renamed', workId: scanned.id }),
      'FORBIDDEN',
    );
  });

  it('rejects updates that do not fit the Work', async () => {
    const link = await workModel().createAgentWork(run, {
      title: 'Preview',
      type: 'link',
      url: 'https://preview.example.com',
    });

    await expectAgentWorkError(
      workModel().updateAgentWork(run, { file: reportFile, workId: link.id }),
      'BAD_REQUEST',
    );
    await expectAgentWorkError(
      workModel().updateAgentWork(run, { workId: link.id }),
      'BAD_REQUEST',
    );
    await expectAgentWorkError(
      workModel().updateAgentWork(run, { title: 'x', workId: 'missing-work' }),
      'NOT_FOUND',
    );
  });

  it('keeps a Work of another user out of reach', async () => {
    const created = await workModel().createAgentWork(run, {
      title: 'Preview',
      type: 'link',
      url: 'https://preview.example.com',
    });

    await expectAgentWorkError(
      new WorkModel(serverDB, userId2).updateAgentWork(
        { ...run, userId: userId2 },
        { title: 'Hijacked', workId: created.id },
      ),
      'NOT_FOUND',
    );
  });

  it('lets only runs in a conversation that produced the Work update it', async () => {
    const otherTopicId = 'work-agent-other-topic';
    await serverDB.insert(topics).values({ id: otherTopicId, userId });
    const otherRun = { ...run, operationId: 'op-other', topicId: otherTopicId };
    const created = await workModel().createAgentWork(run, {
      title: 'Preview',
      type: 'link',
      url: 'https://preview.example.com',
    });

    await expectAgentWorkError(
      workModel().updateAgentWork(otherRun, { title: 'Renamed', workId: created.id }),
      'NOT_FOUND',
    );

    // Registering the same link there joins that conversation, labelled as an update.
    const again = await workModel().createAgentWork(otherRun, {
      title: 'Preview',
      type: 'link',
      url: 'https://preview.example.com',
    });
    expect(again.id).toBe(created.id);
    const versions = await workModel().listVersions(created.id);
    expect(versions.map((version) => version.changeType).sort()).toEqual(['created', 'updated']);

    const renamed = await workModel().updateAgentWork(otherRun, {
      title: 'Renamed',
      workId: created.id,
    });
    expect(renamed.title).toBe('Renamed');
  });

  it("keeps a teammate's agent Work out of reach in a workspace", async () => {
    const workspaceId = 'work-agent-workspace';
    await serverDB.insert(workspaces).values({
      id: workspaceId,
      name: 'Test',
      primaryOwnerId: userId,
      slug: 'agent-work',
    });
    try {
      const created = await new WorkModel(serverDB, userId, workspaceId).createAgentWork(run, {
        title: 'Preview',
        type: 'link',
        url: 'https://preview.example.com',
      });
      // A Work teammates can see, so only the creator check keeps it out of reach.
      await serverDB.update(works).set({ visibility: 'public' }).where(eq(works.id, created.id));

      await expectAgentWorkError(
        new WorkModel(serverDB, userId2, workspaceId).updateAgentWork(
          { ...run, userId: userId2 },
          { title: 'Hijacked', workId: created.id },
        ),
        'NOT_FOUND',
      );
    } finally {
      await serverDB.delete(workspaces).where(eq(workspaces.id, workspaceId));
    }
  });

  it('stamps agentEditable on a task Work its tool config allows', async () => {
    const task = await new TaskModel(serverDB, userId).create({
      instruction: 'Write the plan',
      name: 'Plan',
    });
    const work = await workModel().registerTask({
      agentEditable: true,
      changeType: 'created',
      taskId: task.id,
      toolIdentifier: 'lobe-task',
      toolName: 'createTask',
      topicId,
    });

    expect(work).not.toBeNull();
    expect(await storedMetadata(work!.id)).toEqual({ agentEditable: true });
  });
});
