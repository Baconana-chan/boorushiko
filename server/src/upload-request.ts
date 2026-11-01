import type { FastifyRequest } from 'fastify';
import { stageStream, UploadTooLargeError, type StagedFile, type StageOptions } from './upload.js';

export class UploadRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'UploadRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface ParsedUpload {
  staged: StagedFile;
  filename?: string;
  fields: Record<string, string>;
}

/** Parse one multipart file plus optional form fields shared by bot and UI uploads. */
export async function readUploadRequest(
  request: FastifyRequest,
  options: StageOptions,
): Promise<ParsedUpload> {
  const fields: Record<string, string> = {};
  let staged: StagedFile | undefined;
  let filename: string | undefined;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        filename = part.filename;
        staged = await stageStream(part.file, options);
        if (part.file.truncated) {
          throw new UploadTooLargeError(`file exceeds ${options.maxBytes} bytes`);
        }
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (error) {
    if (error instanceof UploadRequestError) throw error;
    if (
      error instanceof UploadTooLargeError ||
      (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE'
    ) {
      throw new UploadRequestError(413, 'file too large', 'file_too_large');
    }
    throw new UploadRequestError(
      400,
      error instanceof Error ? error.message : 'invalid multipart body',
      'invalid_multipart',
    );
  }

  if (!staged) {
    throw new UploadRequestError(400, 'file is required', 'file_required');
  }
  return { staged, filename, fields };
}
