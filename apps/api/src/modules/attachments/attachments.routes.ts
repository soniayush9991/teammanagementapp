import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../../db/pool.js';
import { ApiError } from '../../lib/errors.js';
import { asyncHandler, parseBody, uuid } from '../../lib/http.js';
import { assertUploadAllowed, buildStorageKey, presignDownload, presignUpload } from '../../lib/storage.js';
import { actorOf, authenticate } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import { assertCanWriteTask, assertConversationMember } from '../../middleware/scope.js';

export const attachmentsRouter = Router();
attachmentsRouter.use(authenticate);

const requestUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(3).max(128),
  byteSize: z.number().int().positive(),
  /** Where the file will hang: a task, a task comment, or a message. */
  scope: z.enum(['task', 'comment', 'message']),
  taskId: uuid.optional(),
  commentId: uuid.optional(),
  conversationId: uuid.optional(),
});

/**
 * Two-step upload: the client asks for a presigned PUT, uploads directly to
 * object storage, then confirms. The file never passes through the API, so a
 * large upload does not tie up a request worker.
 */
attachmentsRouter.post(
  '/upload-url',
  writeRateLimit,
  asyncHandler(async (req, res) => {
    const body = parseBody(requestUploadSchema, req.body);
    const actor = actorOf(req);
    assertUploadAllowed(body.fileName, body.byteSize);

    // Authorize against the thing the file will be attached to, before
    // handing out a storage credential.
    if (body.scope === 'task') {
      if (!body.taskId) throw ApiError.badRequest('taskId is required when attaching to a task');
      await assertCanWriteTask(actor, body.taskId);
    } else if (body.scope === 'comment') {
      if (!body.commentId) throw ApiError.badRequest('commentId is required when attaching to a comment');
      const comment = await queryOne<{ task_id: string }>('SELECT task_id FROM task_comments WHERE id = $1', [
        body.commentId,
      ]);
      if (!comment) throw ApiError.notFound('Comment');
      await assertCanWriteTask(actor, comment.task_id);
    } else {
      if (!body.conversationId) {
        throw ApiError.badRequest('conversationId is required when attaching to a message');
      }
      await assertConversationMember(actor, body.conversationId);
    }

    const storageKey = buildStorageKey(actor.orgId, body.scope, body.fileName);
    const { url, expiresIn } = await presignUpload(storageKey, body.contentType, body.byteSize);

    // The row is created up front and only linked to a message on send, so
    // an abandoned upload is a purgeable orphan rather than a dangling link.
    const row = await queryOne<{ id: string }>(
      `
      INSERT INTO attachments (org_id, uploaded_by, task_id, comment_id, file_name, content_type, byte_size, storage_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      [
        actor.orgId,
        actor.id,
        body.scope === 'task' ? body.taskId : null,
        body.scope === 'comment' ? body.commentId : null,
        body.fileName,
        body.contentType,
        body.byteSize,
        storageKey,
      ],
    );
    if (!row) throw ApiError.internal('Could not register the attachment');

    res.status(201).json({ attachmentId: row.id, uploadUrl: url, expiresIn, storageKey });
  }),
);

attachmentsRouter.get(
  '/:attachmentId/download-url',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const attachmentId = z.string().uuid().parse(req.params.attachmentId);

    // Re-derive access from the owning entity every time a link is issued.
    const row = await queryOne<{
      file_name: string;
      storage_key: string;
      task_id: string | null;
      message_id: string | null;
      conversation_id: string | null;
    }>(
      `
      SELECT a.file_name, a.storage_key, a.task_id, a.message_id,
             (SELECT m.conversation_id FROM messages m WHERE m.id = a.message_id LIMIT 1) AS conversation_id
        FROM attachments a
       WHERE a.id = $1 AND a.org_id = $2
      `,
      [attachmentId, actor.orgId],
    );
    if (!row) throw ApiError.notFound('Attachment');

    if (row.task_id) await assertCanWriteTask(actor, row.task_id).catch(async () => {
      // Read access is enough to download a task attachment.
      const { assertCanReadTask } = await import('../../middleware/scope.js');
      await assertCanReadTask(actor, row.task_id as string);
    });
    if (row.conversation_id) await assertConversationMember(actor, row.conversation_id);

    res.json({ url: await presignDownload(row.storage_key, row.file_name), expiresIn: 300 });
  }),
);
