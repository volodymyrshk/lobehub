import type {
  AgentWorkRunContext,
  CreateAgentWorkInput,
  UpdateAgentWorkInput,
  WorkDisplayField,
  WorkItem,
  WorkVersionMetadata,
} from '@lobechat/types';
import { AGENT_WORK_CLI_TOOL_IDENTIFIER } from '@lobechat/types';
import { and, eq, exists } from 'drizzle-orm';

import { works, workVersions } from '../../schemas/work';
import { type WorkContext, workOwnership } from './context';
import { registerExternalWork } from './external';
import { fileBasename, fileWorkResourceId, registerFileWork } from './file';
import { sanitizeExternalUrl } from './toolResultParsing';
import { registerWorkVersion } from './writes';

export type AgentWorkErrorCode = 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'NOT_FOUND';

/** A refused agent Work write; `code` maps onto the transport's error code. */
export class AgentWorkError extends Error {
  constructor(
    readonly code: AgentWorkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentWorkError';
  }
}

/**
 * Hosts whose links are registered automatically under their own resource types
 * (GitHub issues/PRs, Linear issues/documents). Registering them again as a
 * plain `link` would show a second card for the same resource.
 */
const AUTO_REGISTERED_LINK_HOSTS = ['github.com', 'linear.app'];

const isAutoRegisteredHost = (hostname: string) =>
  AUTO_REGISTERED_LINK_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));

/** Validate an agent-supplied link and return its canonical form (the `link` Work identity). */
const normalizeAgentLink = (value: string): string => {
  const safe = sanitizeExternalUrl(value);
  if (!safe) throw new AgentWorkError('BAD_REQUEST', 'Only http(s) links can be registered');

  const url = new URL(safe);
  if (isAutoRegisteredHost(url.hostname)) {
    throw new AgentWorkError(
      'BAD_REQUEST',
      `${url.hostname} links are registered automatically when you create or edit them; do not register them with lh work`,
    );
  }
  return url.href;
};

const provenanceOf = (run: AgentWorkRunContext, toolName: string) => ({
  agentId: run.agentId ?? null,
  rootOperationId: run.operationId,
  threadId: run.threadId ?? null,
  toolIdentifier: AGENT_WORK_CLI_TOOL_IDENTIFIER,
  toolName,
  topicId: run.topicId,
});

/**
 * Refuse to take over a Work the system collected automatically. Without this,
 * `lh work create` on a path the completion scan already registered would
 * append a version to a Work the agent may never update afterwards. Returns
 * whether the agent already created this Work, so a repeat create is labelled
 * as an update.
 */
const assertNotAutoRegistered = async (
  ctx: WorkContext,
  resourceType: 'file' | 'link',
  resourceId: string,
) => {
  const [existing] = await ctx.db
    .select({ metadata: works.metadata })
    .from(works)
    .where(
      and(
        workOwnership(ctx),
        eq(works.resourceType, resourceType),
        eq(works.resourceId, resourceId),
      ),
    )
    .limit(1);

  if (existing && existing.metadata?.agentEditable !== true) {
    throw new AgentWorkError(
      'CONFLICT',
      'This was already registered as a Work automatically and cannot be changed with lh work',
    );
  }
  return Boolean(existing);
};

/**
 * Register a Work the agent produced itself (`lh work create`). Creating the
 * same file path or link again in the same topic adds a version to the Work the
 * agent created before.
 */
export const createAgentWork = async (
  ctx: WorkContext,
  run: AgentWorkRunContext,
  input: CreateAgentWorkInput,
): Promise<WorkItem> => {
  if (input.type === 'file') {
    const { file } = input;
    await assertNotAutoRegistered(
      ctx,
      'file',
      fileWorkResourceId(run.userId, run.topicId, file.filePath),
    );

    return registerFileWork(ctx, {
      ...provenanceOf(run, 'createWork'),
      agentEditable: true,
      description: input.description,
      filePath: file.filePath,
      metadata: {
        fileId: file.fileId,
        filePath: file.filePath,
        fileSize: file.fileSize,
        fileUrl: file.fileUrl,
        mimeType: file.mimeType,
      },
      title: input.title || fileBasename(file.filePath) || file.filePath,
      userId: run.userId,
    });
  }

  const url = normalizeAgentLink(input.url);
  const alreadyCreated = await assertNotAutoRegistered(ctx, 'link', url);

  const work = await registerExternalWork(ctx, {
    ...provenanceOf(run, 'createWork'),
    agentEditable: true,
    changeType: alreadyCreated ? 'updated' : 'created',
    description: input.description ?? null,
    resourceId: url,
    resourceType: 'link',
    title: input.title,
    url,
  });
  if (!work) throw new Error('Failed to register link Work');
  return work;
};

/**
 * Add a version to a Work the agent created (`lh work update`). Only Works
 * stamped `agentEditable` at creation qualify; fields left out keep their
 * current values.
 */
export const updateAgentWork = async (
  ctx: WorkContext,
  run: AgentWorkRunContext,
  input: UpdateAgentWorkInput,
): Promise<WorkItem> => {
  const [work] = await ctx.db
    .select()
    .from(works)
    .where(
      and(
        eq(works.id, input.workId),
        workOwnership(ctx),
        // Only the creator's runs in a conversation that produced the Work may
        // change it: workspace scope alone would let a teammate's run, or a run
        // in another conversation, append versions to it.
        eq(works.userId, run.userId),
        exists(
          ctx.db
            .select({ id: workVersions.id })
            .from(workVersions)
            .where(and(eq(workVersions.workId, works.id), eq(workVersions.topicId, run.topicId))),
        ),
      ),
    )
    .limit(1);
  if (!work?.resourceId) throw new AgentWorkError('NOT_FOUND', `Work ${input.workId} not found`);
  if (work.metadata?.agentEditable !== true) {
    throw new AgentWorkError(
      'FORBIDDEN',
      'This Work was registered automatically and cannot be changed with lh work',
    );
  }

  if (input.file && work.type !== 'file') {
    throw new AgentWorkError('BAD_REQUEST', 'Only a file Work takes a new file');
  }
  const patchFields: WorkDisplayField[] = [];
  if (input.title !== undefined) patchFields.push('title');
  if (input.description !== undefined) patchFields.push('description');
  if (input.file) patchFields.push('url');
  if (patchFields.length === 0) {
    throw new AgentWorkError('BAD_REQUEST', 'Nothing to update');
  }

  const metadata: WorkVersionMetadata | undefined = input.file
    ? {
        fileId: input.file.fileId,
        fileSize: input.file.fileSize,
        fileUrl: input.file.fileUrl,
        mimeType: input.file.mimeType,
      }
    : undefined;

  return registerWorkVersion(
    ctx,
    {
      resourceId: work.resourceId,
      resourceType: work.resourceType,
      type: work.type,
      userId: work.userId,
      visibility: work.visibility,
    },
    { ...provenanceOf(run, 'updateWork'), changeType: 'updated' },
    () => ({
      display: {
        description: input.description,
        title: input.title,
        url: input.file?.fileUrl,
      },
      metadata,
      // A file-only update patches `url`, so it records a version even
      // when the title and description are unchanged.
      patchFields,
    }),
  );
};
