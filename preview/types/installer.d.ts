/**
 * Ambient type declarations for the installer engine.
 *
 * The install engine (templates/scripts/install.mjs) is plain JavaScript with
 * no TypeScript types. These declarations expose the public surface so .ts
 * routes and helpers can import via the @installer alias (tsconfig paths)
 * without @ts-ignore spread around the codebase.
 */
declare module '@installer' {
  export interface TemplateInfo {
    id: string;
    version: string;
    kind: string;
    author: string;
    description: string;
  }

  export interface InstalledStateResult {
    installedIds: string[];
    templates: Array<TemplateInfo & {uncommitted: boolean}>;
    lastError: {op: string; id: string; stage: string; message: string; at: string} | null;
  }

  export interface InstallResult {
    id: string;
    version: string;
    kind: string;
    preview: string;
    updated: {from: string} | null;
  }

  export interface UninstallResult {
    id: string;
    removed: true;
    referencedBy: {total: number; files: Array<{path: string; count: number}>};
  }

  export interface ScanReferencesResult {
    total: number;
    files: Array<{path: string; count: number}>;
  }

  export class InstallError extends Error {
    readonly stage: string;
    readonly statusCode: number;
    constructor(stage: string, message: string, opts?: {statusCode?: number});
  }

  export function install(
    srcZipOrDir: string,
    opts?: {
      sha256?: string;
      update?: boolean;
      confirmReplace?: boolean;
      overrideCapability?: boolean;
      runners?: Record<string, unknown>;
      onStage?: (stage: string) => void;
    },
  ): Promise<InstallResult>;

  export function installFromMarketplace(
    id: string,
    opts?: {
      update?: boolean;
      confirmReplace?: boolean;
      runners?: Record<string, unknown>;
      onStage?: (stage: string) => void;
    },
  ): Promise<InstallResult>;

  export function uninstall(
    id: string,
    opts?: {
      runners?: Record<string, unknown>;
      onStage?: (stage: string) => void;
    },
  ): Promise<UninstallResult>;

  export function installedState(): InstalledStateResult;

  export function listInstalled(): TemplateInfo[];

  export function scanReferences(id: string): ScanReferencesResult;

  export function clearLastError(): void;
}
