import type {
  AgentWorkRunContext,
  CreateAgentWorkInput,
  GalleryWorkVersionMetadata,
  UpdateAgentWorkInput,
  WorkDisplayField,
  WorkItem,
  WorkVersionMetadata,
} from '@lobechat/types';
import { AGENT_WORK_CLI_TOOL_IDENTIFIER, GALLERY_WORK_MAX_ITEMS } from '@lobechat/types';
import { and, eq, exists } from 'drizzle-orm';

import { works, workVersions } from '../../schemas/work';
import { idGenerator } from '../../utils/idGenerator';
import { type WorkContext, workOwnership } from './context';
import { registerExternalWork } from './external';
import { fileBasename, fileWorkResourceId, registerFileWork } from './file';
import { galleryCoverUrl } from './gallery';
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
      `${url.hostname} links are registered automatically when you create or edit them; do not register them yourself`,
    );
  }
  return url.href;
};

const provenanceOf = (run: AgentWorkRunContext, toolName: string) => ({
  agentId: run.agentId ?? null,
  messageId: run.messageId ?? null,
  rootOperationId: run.operationId,
  threadId: run.threadId ?? null,
  toolCallId: run.toolCallId ?? null,
  toolIdentifier: run.toolIdentifier ?? AGENT_WORK_CLI_TOOL_IDENTIFIER,
  toolName,
  topicId: run.topicId,
});

/**
 * Text limits of an agent-written Work, shared by `lh work` and the `lobe-work`
 * tool so a model cannot store unbounded text on a card or a share profile.
 */
const AGENT_WORK_TEXT_LIMITS = { caption: 500, description: 2000, title: 200 } as const;

const assertValidText = (input: {
  description?: string | null;
  items?: { caption?: string }[];
  title?: string;
}) => {
  if (input.title !== undefined && !input.title.trim()) {
    throw new AgentWorkError('BAD_REQUEST', 'A Work title cannot be empty');
  }
  if ((input.title?.length ?? 0) > AGENT_WORK_TEXT_LIMITS.title) {
    throw new AgentWorkError(
      'BAD_REQUEST',
      `A Work title is at most ${AGENT_WORK_TEXT_LIMITS.title} characters`,
    );
  }
  if ((input.description?.length ?? 0) > AGENT_WORK_TEXT_LIMITS.description) {
    throw new AgentWorkError(
      'BAD_REQUEST',
      `A Work description is at most ${AGENT_WORK_TEXT_LIMITS.description} characters`,
    );
  }
  if (input.items?.some((item) => (item.caption?.length ?? 0) > AGENT_WORK_TEXT_LIMITS.caption)) {
    throw new AgentWorkError(
      'BAD_REQUEST',
      `An image caption is at most ${AGENT_WORK_TEXT_LIMITS.caption} characters`,
    );
  }
};

/** Check a gallery's image list before it is stored as a version. */
const assertValidGallery = (gallery: GalleryWorkVersionMetadata) => {
  if (gallery.items.length === 0) {
    throw new AgentWorkError('BAD_REQUEST', 'A gallery needs at least one image');
  }
  if (gallery.items.length > GALLERY_WORK_MAX_ITEMS) {
    throw new AgentWorkError(
      'BAD_REQUEST',
      `A gallery holds at most ${GALLERY_WORK_MAX_ITEMS} images`,
    );
  }
  const fileIds = new Set(gallery.items.map((item) => item.fileId));
  if (fileIds.size !== gallery.items.length) {
    throw new AgentWorkError('BAD_REQUEST', 'Each image may appear in a gallery only once');
  }
  if (gallery.coverFileId && !fileIds.has(gallery.coverFileId)) {
    throw new AgentWorkError('BAD_REQUEST', 'The cover must be one of the gallery images');
  }
};

const galleryMetadata = (gallery: GalleryWorkVersionMetadata): WorkVersionMetadata => ({
  gallery: {
    ...(gallery.coverFileId ? { coverFileId: gallery.coverFileId } : {}),
    items: gallery.items.map((item) => ({
      ...(item.caption ? { caption: item.caption } : {}),
      fileId: item.fileId,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      url: item.url,
    })),
  },
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
      'This was already registered as a Work automatically and cannot be changed by the agent',
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
  assertValidText({
    description: input.description,
    items: input.type === 'gallery' ? input.items : undefined,
    title: input.title,
  });
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

  if (input.type === 'gallery') {
    assertValidGallery(input);
    // Every create is a new gallery: images are added to an existing one with
    // an update, which replaces its whole list.
    return registerWorkVersion(
      ctx,
      {
        resourceId: idGenerator('galleries'),
        resourceType: 'gallery',
        type: 'gallery',
        userId: run.userId,
        visibility: 'private',
      },
      { ...provenanceOf(run, 'createWork'), agentEditable: true, changeType: 'created' },
      () => ({
        display: {
          description: input.description ?? null,
          title: input.title,
          url: galleryCoverUrl(input),
        },
        metadata: galleryMetadata(input),
      }),
    );
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

/** Work types an agent may change or delete after creating them. */
const isAgentManagedWork = (work: { resourceType: string; type: string }) =>
  work.type === 'file' ||
  work.type === 'gallery' ||
  (work.type === 'external' && work.resourceType === 'link');

/**
 * Find a Work this run may change or delete: an `agentEditable` file, link or
 * gallery Work of the same creator, produced in this run's conversation.
 */
const findAgentManagedWork = async (ctx: WorkContext, run: AgentWorkRunContext, workId: string) => {
  const [work] = await ctx.db
    .select()
    .from(works)
    .where(
      and(
        eq(works.id, workId),
        workOwnership(ctx),
        // Only the creator's runs in a conversation that produced the Work may
        // change it: workspace scope alone would let a teammate's run, or a run
        // in another conversation, append versions to it or delete it.
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
  if (!work?.resourceId) throw new AgentWorkError('NOT_FOUND', `Work ${workId} not found`);
  if (work.metadata?.agentEditable !== true) {
    throw new AgentWorkError(
      'FORBIDDEN',
      'This Work was registered automatically and cannot be changed by the agent',
    );
  }
  // A task or document card mirrors its own resource, so rewriting or removing
  // the card alone would leave it disagreeing with the task or document it
  // opens. `agentEditable` on those types stays a hook for future policy.
  if (!isAgentManagedWork(work)) {
    throw new AgentWorkError(
      'BAD_REQUEST',
      'Only file, link and gallery Works can be changed this way; update the task or document itself',
    );
  }
  return { ...work, resourceId: work.resourceId };
};

/**
 * Add a version to a Work the agent created (`lh work update`, `lobe-work`
 * `updateWork`). Only Works stamped `agentEditable` at creation qualify;
 * fields left out keep their current values. A gallery update replaces the
 * whole image list.
 */
export const updateAgentWork = async (
  ctx: WorkContext,
  run: AgentWorkRunContext,
  input: UpdateAgentWorkInput,
): Promise<WorkItem> => {
  const work = await findAgentManagedWork(ctx, run, input.workId);

  if (input.file && work.type !== 'file') {
    throw new AgentWorkError('BAD_REQUEST', 'Only a file Work takes a new file');
  }
  if (input.gallery && work.type !== 'gallery') {
    throw new AgentWorkError('BAD_REQUEST', 'Only a gallery Work takes images');
  }
  if (input.gallery) assertValidGallery(input.gallery);
  assertValidText({
    description: input.description,
    items: input.gallery?.items,
    title: input.title,
  });

  const patchFields: WorkDisplayField[] = [];
  if (input.title !== undefined) patchFields.push('title');
  if (input.description !== undefined) patchFields.push('description');
  if (input.file || input.gallery) patchFields.push('url');
  if (patchFields.length === 0) {
    throw new AgentWorkError('BAD_REQUEST', 'Nothing to update');
  }

  let metadata: WorkVersionMetadata | undefined;
  if (input.file) {
    metadata = {
      fileId: input.file.fileId,
      fileSize: input.file.fileSize,
      fileUrl: input.file.fileUrl,
      mimeType: input.file.mimeType,
    };
  } else if (input.gallery) {
    metadata = galleryMetadata(input.gallery);
  }

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
        url: input.file?.fileUrl ?? (input.gallery ? galleryCoverUrl(input.gallery) : undefined),
      },
      metadata,
      // A file- or image-only update patches `url`, so it records a version
      // even when the title and description are unchanged.
      patchFields,
    }),
  );
};

/**
 * Delete a Work the agent created by mistake (`lh work delete`, `lobe-work`
 * `deleteWork`). Removes the card and its versions; the files it points at
 * stay in the file store.
 */
export const deleteAgentWork = async (
  ctx: WorkContext,
  run: AgentWorkRunContext,
  workId: string,
): Promise<{ id: string; title: string | null }> => {
  const work = await findAgentManagedWork(ctx, run, workId);
  // Versions go with the Work through the `work_versions.work_id` cascade.
  await ctx.db.delete(works).where(and(eq(works.id, work.id), eq(works.userId, run.userId)));
  return { id: work.id, title: work.title };
};
