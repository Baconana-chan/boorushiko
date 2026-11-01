export interface UploadInput {
  path: string;
  filename: string;
  mime: string;
  bytes: number;
}

export interface UploadResult {
  url: string;
  remoteId?: string;
}

export interface MirrorHost {
  name: string;
  maxBytes: number;
  accepts(mime: string): boolean;
  upload(input: UploadInput): Promise<UploadResult>;
}
