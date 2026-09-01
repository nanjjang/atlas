export type DiagramKind = 'architecture' | 'flow' | 'database';

export type ResolutionConfidence = 'exact' | 'inferred' | 'unresolved';

export interface SourceRef {
  file: string;
  line: number;
}

export interface DiagramNode {
  id: string;
  kind: string;
  label: string;
  subtitle?: string;
  group?: string;
  source?: SourceRef;
  confidence?: ResolutionConfidence;
  metadata: Record<string, string | string[]>;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  label?: string;
  confidence: ResolutionConfidence;
  source?: SourceRef;
  metadata?: Record<string, string | string[]>;
}

export interface DiagramGraph {
  kind: DiagramKind;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  emptyMessage: string;
}

export type FlowUnitKind = 'project' | 'service' | 'file';

/**
 * One independently readable operating flow. Project units show the hand-off
 * between services/modules; service and file units show routes, callables,
 * explicit branches, and statically visible calls inside that boundary.
 */
export interface FlowUnit {
  id: string;
  label: string;
  kind: FlowUnitKind;
  description: string;
  source?: SourceRef;
  graph: DiagramGraph;
}

export interface FlowCatalog {
  units: FlowUnit[];
  emptyMessage: string;
}

/**
 * What a file is for, as far as an orientation view is concerned.
 *
 * Coarse on purpose. The Files view needs to separate the code somebody reads
 * to understand the project from the code that only proves it works, and from
 * the files that are neither; finer categories than that are the language
 * server's job, not a map's.
 */
export type FileRole = 'entry' | 'source' | 'test' | 'config' | 'other';

export interface StructureNode {
  id: string;
  label: string;
  path: string;
  kind: 'folder' | 'file';
  source?: SourceRef;
  /**
   * Files only, and only what was actually measured: a file the scanner could
   * not read as text has no `lines`, and a folder has none of these at all.
   * The Files view reads them to rank a project by size and by how much of it
   * leans on each file, so absent has to stay distinguishable from zero.
   */
  bytes?: number;
  lines?: number;
  /** How many other scanned files import this one, statically. */
  importedBy?: number;
  /** How many other scanned files this one imports, statically. */
  imports?: number;
  role?: FileRole;
  children: StructureNode[];
}

/**
 * A protocol this project speaks at its edges.
 *
 * These are the protocols a reader has to know about to call the project or to
 * be called by it. Deliberately flat rather than layered: GraphQL and gRPC both
 * ride on HTTP, but a caller does not reach them the way it reaches a REST
 * route, so they are separate surfaces. `tcp` is the fallback for a socket or a
 * published port that no higher-level protocol could be read from.
 */
export type ProtocolId =
  | 'http'
  | 'graphql'
  | 'grpc'
  | 'websocket'
  | 'sse'
  | 'kafka'
  | 'amqp'
  | 'mqtt'
  | 'redis'
  | 'tcp';

/**
 * One operation the project answers on, or calls out on, over a protocol.
 *
 * `address` is whatever that protocol calls the thing being addressed — a path,
 * a topic, a queue, an event name, a field on the GraphQL root — and
 * `operation` is what is done to it: an HTTP method, `rpc`, `subscribe`,
 * `publish`. Keeping them apart is what lets the view sort by one and group by
 * the other instead of parsing a sentence back out of a label.
 */
export interface ProtocolEndpoint {
  id: string;
  protocol: ProtocolId;
  operation: string;
  address: string;
  /** The callable the declaration is attached to, when one follows it. */
  handler?: string;
  /** The module the declaration sits in, matching the architecture view. */
  module?: string;
  /** The library or annotation the endpoint was read from. */
  framework?: string;
  source: SourceRef;
  confidence: ResolutionConfidence;
  metadata?: Record<string, string | string[]>;
}

/**
 * How a port declaration was written, which is most of what says how much to
 * trust it. A `listen` is the program binding the port; an `expose` or a
 * `published` mapping is a container image or compose file saying which port the
 * outside world reaches it on; a `config` is a setting or an environment
 * default that something else reads.
 */
export type PortBindingKind = 'listen' | 'expose' | 'published' | 'config';

export interface PortBinding {
  id: string;
  protocol: ProtocolId;
  /** Absent when the source binds a name and no literal was in reach. */
  port?: number;
  /** The published side of a container mapping, when there is one. */
  hostPort?: number;
  /** The setting, variable, or expression the port was read from. */
  declaredAs?: string;
  kind: PortBindingKind;
  /** The declaration itself, trimmed, so the reader can judge the reading. */
  evidence: string;
  /** What normally answers on this port, when the number is a well-known one. */
  note?: string;
  transport?: 'tcp' | 'udp';
  source: SourceRef;
  confidence: ResolutionConfidence;
}

/** Everything found for one protocol: what it is, and what it exposes. */
export interface ProtocolSurface {
  id: string;
  protocol: ProtocolId;
  label: string;
  description: string;
  /** Libraries and annotations the evidence came from, for the details panel. */
  frameworks: string[];
  endpoints: ProtocolEndpoint[];
  /** Endpoints found past what the snapshot keeps, so the count stays honest. */
  hiddenEndpoints: number;
}

/**
 * The project's outside edges: which protocols it speaks, which ports those are
 * reached on, and which operations each protocol exposes.
 *
 * Ports are one flat list rather than a copy inside each surface: a port is
 * declared in a Dockerfile or a compose file as often as in code, where nothing
 * says which protocol it carries, and a list that has to guess before it can
 * show anything shows less than one that says "8080, from EXPOSE".
 */
export interface InterfaceCatalog {
  surfaces: ProtocolSurface[];
  ports: PortBinding[];
  emptyMessage: string;
}

export interface AnalysisDiagnostic {
  code: string;
  severity: 'info' | 'warning';
  message: string;
  source?: SourceRef;
}

export interface AnalysisStats {
  files: number;
  codeFiles: number;
  modules: number;
  dependencies: number;
  flowUnits: number;
  databaseEntities: number;
  databaseRelations: number;
  protocols: number;
  endpoints: number;
  ports: number;
}

export interface ProjectSnapshot {
  schemaVersion: 1;
  revision: number;
  projectName: string;
  generatedAt: string;
  technologies: string[];
  /**
   * Directories inside the workspace that hold a package manifest, deepest
   * first. A module boundary is read relative to the project a file belongs to,
   * so anything mapping a path onto the diagram needs the same list.
   */
  projectRoots: string[];
  stats: AnalysisStats;
  architecture: DiagramGraph;
  structure: StructureNode;
  flow: FlowCatalog;
  database: DiagramGraph;
  interfaces: InterfaceCatalog;
  diagnostics: AnalysisDiagnostic[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
}

export interface AnalyzeOptions {
  projectName: string;
  revision?: number;
  diagnostics?: AnalysisDiagnostic[];
}
