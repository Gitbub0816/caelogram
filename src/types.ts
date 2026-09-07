export interface SourceFile {
  path: string;
  content: string;
  sha: string;
}
export interface Component {
  id: string;
  name: string;
  path: string;
  kind: "file" | "function" | "class" | "interface" | "type" | "variable";
  start: number;
  end: number;
  subsystem: string;
  exported: boolean;
  bytes?: number;
  analysis?: string;
  exclusionReason?: string;
  confidence?: number;
}
export interface Relation {
  from: string;
  to: string;
  kind: "contains" | "imports" | "references" | "tests";
  evidence: string;
  confidence: number;
  revision: string;
}
export interface Graph {
  revision: string;
  nodes: Component[];
  edges: Relation[];
  files: SourceFile[];
  warnings: string[];
  parsed: number;
  reused: number;
  indexedAt: string;
}
export interface Repository {
  id: string;
  name: string;
  branch: string;
  installationId: number;
  graph: Graph;
  status: string;
}
export interface ContextItem {
  path: string;
  reason: string;
  required: boolean;
  content: string;
  start: number;
  end: number;
  estimatedTokens: number;
}
export interface Context {
  revision: string;
  items: ContextItem[];
  omitted: { path: string; reason: string }[];
  omittedCount: number;
  warnings: string[];
  estimatedTokens: number;
  sourceTokens: number;
  budget: number;
  seedIds: string[];
}
export interface Task {
  id: string;
  repoId: string;
  prompt: string;
  base: string;
  context: Context;
  createdAt: string;
}
export interface Edit {
  path: string;
  content: string | null;
}
export interface Validation {
  passed: boolean;
  errors: string[];
  warnings: string[];
  impacted: string[];
  checks: { name: string; status: string; detail: string }[];
  digest: string;
  validatedAt: string;
}
export interface Changeset {
  id: string;
  taskId: string;
  base: string;
  edits: Edit[];
  title: string;
  status: "submitted" | "validated" | "published";
  validation?: Validation;
  pr?: { url: string; number: number; branch: string };
  createdAt: string;
}
export interface Principal {
  /** Active workspace. Repository lookups move it to the workspace that holds the repository. */
  tenant: string;
  /** Every workspace this principal may read, derived from GitHub, never from a client. */
  tenants?: string[];
  subject: string;
  scopes: string[];
  repositories: string[];
}
