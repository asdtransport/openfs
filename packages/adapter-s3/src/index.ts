/**
 * @openfs/adapter-s3
 *
 * S3/MinIO adapter for OpenFS.
 * Stores each virtual file as an S3 object keyed by its path.
 * Supports text search via in-memory $contains scanning.
 * Works with AWS S3 or any S3-compatible store (MinIO, R2, etc.).
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import type {
  OpenFsAdapter,
  PathTreeNode,
  AdapterOptions,
  FileMeta,
  GrepFlags,
  SearchResult,
} from "@openfs/core";

export interface S3AdapterOptions {
  /** S3 bucket name */
  bucket: string;
  /** Optional key prefix (e.g. "openfs/") */
  prefix?: string;
  /** S3 endpoint URL (required for MinIO, optional for AWS) */
  endpoint?: string;
  /** AWS region (default: us-east-1) */
  region?: string;
  /** Access key ID */
  accessKeyId?: string;
  /** Secret access key */
  secretAccessKey?: string;
  /** Force path-style URLs (required for MinIO) */
  forcePathStyle?: boolean;
}

export class S3Adapter implements OpenFsAdapter {
  readonly name = "s3";
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  // In-memory content cache for search (populated during init/ingest)
  private contentCache = new Map<string, string>();

  constructor(opts: S3AdapterOptions) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? "";

    this.client = new S3Client({
      region: opts.region ?? "us-east-1",
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? !!opts.endpoint,
      credentials:
        opts.accessKeyId && opts.secretAccessKey
          ? {
              accessKeyId: opts.accessKeyId,
              secretAccessKey: opts.secretAccessKey,
            }
          : undefined,
    });
  }

  /** S3 key for a virtual path */
  private toKey(path: string): string {
    const clean = path.startsWith("/") ? path.slice(1) : path;
    return this.prefix + clean;
  }

  /** Virtual path from an S3 key */
  private toPath(key: string): string {
    const stripped = this.prefix ? key.replace(this.prefix, "") : key;
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }

  /** Ensure bucket exists */
  private async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async init(_options?: AdapterOptions): Promise<Map<string, PathTreeNode>> {
    await this.ensureBucket();

    const pathMap = new Map<string, PathTreeNode>();
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix || undefined,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const path = this.toPath(obj.Key);
        pathMap.set(path, { isPublic: true, groups: [] });
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return pathMap;
  }

  async readFile(path: string): Promise<string> {
    // Check content cache first
    if (this.contentCache.has(path)) {
      return this.contentCache.get(path)!;
    }

    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
    );

    if (!res.Body) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const content = await res.Body.transformToString("utf-8");
    this.contentCache.set(path, content);
    return content;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
    );

    if (!res.Body) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    return new Uint8Array(await res.Body.transformToByteArray());
  }

  async getFileMeta(path: string): Promise<FileMeta> {
    const res = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
    );

    return {
      path,
      isPublic: true,
      groups: [],
      size: res.ContentLength ?? 0,
      mtime: res.LastModified ?? new Date(),
      chunkCount: 1,
    };
  }

  /**
   * Search by scanning content cache for $contains matches.
   * For large datasets, consider pairing with a search index.
   */
  async search(
    query: string,
    _flags?: Partial<GrepFlags>,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const [path, content] of this.contentCache) {
      if (content.toLowerCase().includes(lowerQuery)) {
        results.push({ path });
      }
    }

    return results;
  }

  async bulkPrefetch(paths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const path of paths) {
      try {
        const content = await this.readFile(path);
        result.set(path, content);
      } catch {
        // Skip missing files
      }
    }
    return result;
  }

  /**
   * Ingest documents into S3.
   * Also populates the content cache for search.
   */
  async ingestDocuments(
    files: Record<string, string>,
    _meta?: { isPublic?: boolean; groups?: string[] },
  ): Promise<void> {
    await this.ensureBucket();

    for (const [path, content] of Object.entries(files)) {
      const key = this.toKey(path);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ContentType: "text/plain; charset=utf-8",
        }),
      );
      this.contentCache.set(path.startsWith("/") ? path : `/${path}`, content);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.toKey(path),
        Body: content,
        ContentType: "text/plain; charset=utf-8",
      }),
    );
    this.contentCache.set(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
    );
    this.contentCache.delete(path);
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
