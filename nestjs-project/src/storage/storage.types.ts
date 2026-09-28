export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  /** When set, the URL forces a download with this file name (Content-Disposition: attachment). */
  downloadFileName?: string;
}
