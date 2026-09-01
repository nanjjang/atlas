import { declaredCallableOnLine } from './flowAnalyzer';
import type {
  AnalysisDiagnostic,
  InterfaceCatalog,
  PortBinding,
  PortBindingKind,
  ProtocolEndpoint,
  ProtocolId,
  ProtocolSurface,
  WorkspaceFile,
} from './model';

/**
 * The project's outside edges, read statically.
 *
 * Three questions, one pass: which protocols does this project speak, which
 * ports is it reached on, and what does each protocol actually expose. They are
 * one analysis rather than three because the answers explain each other — a
 * port with no protocol is a number, and an endpoint with no port is a path
 * nobody can call — and because the evidence sits on the same lines.
 *
 * Nothing here runs the project. A route registered by a framework at startup,
 * a port read from an environment file, and a topic name built out of a
 * variable are all invisible to this, which is why every finding carries the
 * declaration it came from.
 */

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'java', 'kt', 'kts', 'go', 'rs', 'cs', 'php', 'rb', 'dart', 'swift', 'scala',
]);

const CONFIG_EXTENSIONS = new Set(['yaml', 'yml', 'json', 'toml', 'properties', 'conf', 'xml', 'ini']);

const SCHEMA_EXTENSIONS = new Set(['proto', 'graphql', 'gql']);

/** Endpoints kept per protocol. Past this the list stops being readable anyway. */
const MAX_ENDPOINTS_PER_PROTOCOL = 400;
/** Port declarations kept. A repository that publishes more is describing a fleet. */
const MAX_PORTS = 80;
/** Generated and minified files arrive as one enormous line; nothing is read off them. */
const MAX_LINE_LENGTH = 400;
/** A file longer than this is a bundle or a fixture, not a declaration. */
const MAX_LINES = 20000;

const PROTOCOL_ORDER: readonly ProtocolId[] = [
  'http', 'graphql', 'grpc', 'websocket', 'sse', 'kafka', 'amqp', 'mqtt', 'redis', 'tcp',
];

const PROTOCOL_INFO: Record<ProtocolId, { label: string; description: string }> = {
  http: {
    label: 'HTTP',
    description: 'Request/response endpoints declared by a router, a controller annotation, or an API description.',
  },
  graphql: {
    label: 'GraphQL',
    description: 'The root fields a client may ask for. One HTTP endpoint carries all of them, so these are the interface, not the URL.',
  },
  grpc: {
    label: 'gRPC',
    description: 'Service methods declared in .proto files. The declaration is the contract both sides are generated from, so it is exact.',
  },
  websocket: {
    label: 'WebSocket',
    description: 'Events listened for or emitted on a socket after the connection is upgraded.',
  },
  sse: {
    label: 'Server-sent events',
    description: 'Responses the code declares as an event stream and keeps open.',
  },
  kafka: {
    label: 'Kafka',
    description: 'Topics this project consumes from or produces to.',
  },
  amqp: {
    label: 'AMQP',
    description: 'Queues, exchanges, and routing keys declared against a broker.',
  },
  mqtt: {
    label: 'MQTT',
    description: 'Topics subscribed to or published on over MQTT.',
  },
  redis: {
    label: 'Redis pub/sub',
    description: 'Channels subscribed to or published on through Redis.',
  },
  tcp: {
    label: 'TCP / other',
    description: 'Sockets and published ports that no higher-level protocol could be read from.',
  },
};

/**
 * What normally answers on a number, when the declaration itself does not say.
 *
 * A Dockerfile `EXPOSE 5432` names no protocol, and guessing "HTTP" from the
 * fact that most ports are HTTP would be worse than useless. These are the
 * assignments a reader would make anyway, and the note is shown beside the port
 * so the guess stays visible as a guess.
 */
const WELL_KNOWN_PORTS = new Map<number, { protocol: ProtocolId; note: string }>([
  [80, { protocol: 'http', note: 'HTTP' }],
  [443, { protocol: 'http', note: 'HTTPS' }],
  [3000, { protocol: 'http', note: 'HTTP (development default)' }],
  [3001, { protocol: 'http', note: 'HTTP (development default)' }],
  [4000, { protocol: 'http', note: 'HTTP (development default)' }],
  [5000, { protocol: 'http', note: 'HTTP (development default)' }],
  [5173, { protocol: 'http', note: 'Vite dev server' }],
  [8000, { protocol: 'http', note: 'HTTP' }],
  [8080, { protocol: 'http', note: 'HTTP' }],
  [8081, { protocol: 'http', note: 'HTTP' }],
  [8443, { protocol: 'http', note: 'HTTPS' }],
  [9090, { protocol: 'http', note: 'HTTP / metrics' }],
  [50051, { protocol: 'grpc', note: 'gRPC' }],
  [9092, { protocol: 'kafka', note: 'Kafka broker' }],
  [5672, { protocol: 'amqp', note: 'RabbitMQ / AMQP' }],
  [15672, { protocol: 'http', note: 'RabbitMQ management UI' }],
  [1883, { protocol: 'mqtt', note: 'MQTT' }],
  [8883, { protocol: 'mqtt', note: 'MQTT over TLS' }],
  [6379, { protocol: 'redis', note: 'Redis' }],
  [5432, { protocol: 'tcp', note: 'PostgreSQL' }],
  [3306, { protocol: 'tcp', note: 'MySQL / MariaDB' }],
  [1433, { protocol: 'tcp', note: 'SQL Server' }],
  [1521, { protocol: 'tcp', note: 'Oracle' }],
  [27017, { protocol: 'tcp', note: 'MongoDB' }],
  [9200, { protocol: 'tcp', note: 'Elasticsearch' }],
  [11211, { protocol: 'tcp', note: 'Memcached' }],
  [22, { protocol: 'tcp', note: 'SSH' }],
  [25, { protocol: 'tcp', note: 'SMTP' }],
  [587, { protocol: 'tcp', note: 'SMTP submission' }],
]);

/**
 * Which library a bare `subscribe('orders')` belongs to.
 *
 * Every message broker client in every language spells its two verbs the same
 * way, so the call alone says nothing. What the file imports says everything,
 * and it is one cheap read per file rather than a guess per line.
 */
const MESSAGING_IMPORTS: ReadonlyArray<{ pattern: RegExp; protocol: ProtocolId; framework: string }> = [
  { pattern: /\b(?:kafkajs|node-rdkafka|['"`]kafka['"`]|org\.apache\.kafka|confluent_kafka|segmentio\/kafka-go|sarama)\b/i, protocol: 'kafka', framework: 'Kafka' },
  { pattern: /\b(?:amqplib|amqp-connection-manager|['"`]amqp['"`]|pika|com\.rabbitmq|streadway\/amqp|rabbitmq)\b/i, protocol: 'amqp', framework: 'AMQP' },
  { pattern: /\b(?:mqtt|paho|eclipse\/paho|async_mqtt)\b/i, protocol: 'mqtt', framework: 'MQTT' },
  { pattern: /\b(?:ioredis|['"`]redis['"`]|redis\.asyncio|go-redis|StackExchange\.Redis)\b/i, protocol: 'redis', framework: 'Redis' },
];

const WEBSOCKET_IMPORTS = /\b(?:socket\.io|socketio|['"`]ws['"`]|WebSocketServer|WebSocketGateway|SubscribeMessage|MessageMapping|websockets|StompEndpoint|SockJS|Phoenix\.Socket|gorilla\/websocket|tokio-tungstenite)\b/;

const HTTP_METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

export interface InterfaceAnalysisResult {
  catalog: InterfaceCatalog;
  diagnostics: AnalysisDiagnostic[];
}

/**
 * How far below a route annotation its handler may be declared. Enough for the
 * stack of guards, status codes, and documentation annotations that frameworks
 * invite between the two, and not enough to reach into the next method.
 */
const HANDLER_REACH = 6;

/** A route declaration waiting for the callable that answers it. */
interface PendingEndpoint {
  protocol: ProtocolId;
  operation: string;
  address: string;
  framework?: string;
  line: number;
  metadata?: Record<string, string | string[]>;
}

interface FileContext {
  path: string;
  name: string;
  extension: string;
  lines: string[];
  /** The broker client this file imports, if any; see `MESSAGING_IMPORTS`. */
  messaging?: ProtocolId;
  messagingFramework?: string;
  /** Whether a socket library is in reach, which is what makes `.on(…)` an event. */
  websocket: boolean;
  /** A class-level path such as `@Controller('users')` or `@RequestMapping("/api")`. */
  routePrefix: string;
  /** The path this file answers on by where it sits; see `fileConventionRoute`. */
  fileRoute?: string;
}

export function analyzeInterfaces(
  files: readonly WorkspaceFile[],
  moduleByPath: ReadonlyMap<string, string>,
): InterfaceAnalysisResult {
  const endpoints: ProtocolEndpoint[] = [];
  const ports: PortBinding[] = [];
  const frameworksByProtocol = new Map<ProtocolId, Set<string>>();

  for (const file of files) {
    const context = fileContext(file);
    if (!context) {
      continue;
    }
    const fileEndpoints: ProtocolEndpoint[] = [];
    const filePorts: PortBinding[] = [];
    const module = moduleByPath.get(context.path);
    scanFile(
      context,
      (found) => fileEndpoints.push({ ...found, ...(module ? { module } : {}) }),
      (found) => filePorts.push(found),
    );

    // A port declared in the same file as an endpoint is that endpoint's port.
    // This is the one attribution the source can actually support: everywhere
    // else the number has to be matched against what usually answers on it.
    const spoken = new Set(fileEndpoints.map((endpoint) => endpoint.protocol));
    const only = spoken.size === 1 ? [...spoken][0] : undefined;
    for (const port of filePorts) {
      if (port.protocol === 'tcp' && only && only !== 'sse') {
        port.protocol = only;
      }
    }

    endpoints.push(...fileEndpoints);
    ports.push(...filePorts);
    for (const endpoint of fileEndpoints) {
      if (endpoint.framework) {
        addFramework(frameworksByProtocol, endpoint.protocol, endpoint.framework);
      }
    }
  }

  // The surfaces are built from the ports the snapshot actually keeps, so a
  // protocol never gets a card whose only evidence was trimmed away.
  const keptPorts = dedupePorts(ports);
  const surfaces = buildSurfaces(endpoints, keptPorts, frameworksByProtocol);
  const diagnostics: AnalysisDiagnostic[] = [];
  if (surfaces.length) {
    diagnostics.push({
      code: 'INTERFACE_STATIC_HEURISTIC',
      severity: 'info',
      message: 'Protocols, ports, and endpoints are read from declarations in the source: routers, annotations, schema files, container manifests, and settings. Routes registered at run time, ports read from environment files, and addresses built out of variables are not visible to static analysis.',
    });
  }
  if (ports.length > keptPorts.length) {
    diagnostics.push({
      code: 'INTERFACE_PORT_LIMIT',
      severity: 'info',
      message: `${ports.length - keptPorts.length} further port declarations were omitted; the ${MAX_PORTS} clearest are listed.`,
    });
  }

  return {
    catalog: {
      surfaces,
      ports: keptPorts,
      emptyMessage: 'No protocol, port, or endpoint declaration was found in the scanned files.',
    },
    diagnostics,
  };
}

function buildSurfaces(
  endpoints: readonly ProtocolEndpoint[],
  ports: readonly PortBinding[],
  frameworks: ReadonlyMap<ProtocolId, Set<string>>,
): ProtocolSurface[] {
  const byProtocol = new Map<ProtocolId, ProtocolEndpoint[]>();
  for (const endpoint of endpoints) {
    byProtocol.set(endpoint.protocol, [...(byProtocol.get(endpoint.protocol) ?? []), endpoint]);
  }
  // A protocol with a port and no readable endpoint is still worth a card: it
  // is the case where the reader most needs to be told that something answers
  // here and that the analysis could not say what.
  for (const port of ports) {
    if (!byProtocol.has(port.protocol)) {
      byProtocol.set(port.protocol, []);
    }
  }

  const surfaces: ProtocolSurface[] = [];
  for (const protocol of PROTOCOL_ORDER) {
    const found = byProtocol.get(protocol);
    if (!found) {
      continue;
    }
    const unique = dedupeEndpoints(found);
    const kept = unique.slice(0, MAX_ENDPOINTS_PER_PROTOCOL);
    surfaces.push({
      id: `protocol:${protocol}`,
      protocol,
      label: PROTOCOL_INFO[protocol].label,
      description: PROTOCOL_INFO[protocol].description,
      frameworks: [...(frameworks.get(protocol) ?? [])].sort((left, right) => left.localeCompare(right)),
      endpoints: kept,
      hiddenEndpoints: unique.length - kept.length,
    });
  }
  return surfaces;
}

/**
 * The same route declared twice — once by an annotation and once by the router
 * it is registered on, or once per overload — is one endpoint. Sorted by what
 * the reader scans for: the address, then the operation on it.
 */
function dedupeEndpoints(endpoints: readonly ProtocolEndpoint[]): ProtocolEndpoint[] {
  const unique = new Map<string, ProtocolEndpoint>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.operation}\u0000${endpoint.address}\u0000${endpoint.source.file}`;
    const previous = unique.get(key);
    if (!previous || (!previous.handler && endpoint.handler)) {
      unique.set(key, endpoint);
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.address.localeCompare(right.address)
    || left.operation.localeCompare(right.operation)
    || left.source.file.localeCompare(right.source.file));
}

/**
 * Ports, ordered by how directly the declaration binds one: the code that calls
 * `listen` first, then what a container publishes, then settings. The same
 * number declared in four manifests is one line in the view, and the file that
 * says it most directly is the one worth opening.
 */
function dedupePorts(ports: readonly PortBinding[]): PortBinding[] {
  const rank: Record<PortBindingKind, number> = { listen: 0, expose: 1, published: 2, config: 3 };
  const unique = new Map<string, PortBinding>();
  for (const port of ports) {
    const key = `${port.port ?? port.declaredAs ?? ''}\u0000${port.kind}\u0000${port.source.file}`;
    if (!unique.has(key)) {
      unique.set(key, port);
    }
  }
  return [...unique.values()]
    .sort((left, right) =>
      rank[left.kind] - rank[right.kind]
      || (left.port ?? Number.MAX_SAFE_INTEGER) - (right.port ?? Number.MAX_SAFE_INTEGER)
      || left.source.file.localeCompare(right.source.file))
    .slice(0, MAX_PORTS);
}

function fileContext(file: WorkspaceFile): FileContext | undefined {
  const path = normalizePath(file.path);
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  const extension = extensionOf(name);
  const scannable = CODE_EXTENSIONS.has(extension)
    || CONFIG_EXTENSIONS.has(extension)
    || SCHEMA_EXTENSIONS.has(extension)
    || name === 'dockerfile'
    || name.startsWith('dockerfile.');
  if (!scannable || !file.content) {
    return undefined;
  }
  const lines = file.content.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    return undefined;
  }
  const messaging = MESSAGING_IMPORTS.find((candidate) => candidate.pattern.test(file.content));
  return {
    path,
    name,
    extension,
    lines,
    ...(messaging ? { messaging: messaging.protocol, messagingFramework: messaging.framework } : {}),
    websocket: WEBSOCKET_IMPORTS.test(file.content),
    routePrefix: '',
    ...(fileConventionRoute(path) ? { fileRoute: fileConventionRoute(path)! } : {}),
  };
}

/**
 * The path a file answers on because of where it sits rather than because of
 * anything written in it.
 *
 * Only the two layouts that are unambiguous about it: Next's `app/…/route.ts`
 * and `pages/api/…`. In both, the folder *is* the URL — there is no line to
 * read it off, and skipping them leaves the whole HTTP surface of a Next
 * project invisible. Route groups such as `(marketing)` are folders for the
 * author's benefit and are not part of the URL.
 */
function fileConventionRoute(path: string): string | undefined {
  const appRoute = path.match(/(?:^|\/)app\/(.*)\/route\.[jt]sx?$/)
    ?? path.match(/(?:^|\/)app\/route\.[jt]sx?$/);
  if (appRoute) {
    const segments = (appRoute[1] ?? '').split('/').filter((part) => part && !/^\(.*\)$/.test(part));
    return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
  }
  const pagesApi = path.match(/(?:^|\/)pages\/(api\/.*)\.[jt]sx?$/);
  if (pagesApi?.[1]) {
    return `/${pagesApi[1].replace(/\/index$/, '')}`;
  }
  return undefined;
}

/**
 * One pass over a file.
 *
 * Route declarations are collected rather than emitted, because in every
 * annotation-based framework the path is on one line and the callable answering
 * it is on the next; they are flushed onto that callable when it appears, and
 * at the end of the file for the ones that never got one.
 */
function scanFile(
  context: FileContext,
  emitEndpoint: (endpoint: ProtocolEndpoint) => void,
  emitPort: (port: PortBinding) => void,
): void {
  const code = CODE_EXTENSIONS.has(context.extension);
  const config = CONFIG_EXTENSIONS.has(context.extension);
  const dockerfile = context.name === 'dockerfile' || context.name.startsWith('dockerfile.');
  const openApi = config && /\b(?:openapi|swagger)\s*["']?\s*:/i.test(context.lines.slice(0, 40).join('\n'));

  let pending: PendingEndpoint[] = [];
  const emitPending = (handler?: string, at?: number): void => {
    for (const route of pending) {
      // A route annotation sits directly above the callable that answers it,
      // with room for a few more annotations in between. Past that the next
      // declaration belongs to something else, and naming it as the handler is
      // worse than saying nothing: it points the reader at the wrong function.
      const near = handler !== undefined && at !== undefined && at - route.line <= HANDLER_REACH;
      emitEndpoint(endpointOf(context, route, near ? handler : undefined));
    }
    pending = [];
  };
  const push = (route: PendingEndpoint | undefined): void => {
    if (route) {
      pending.push(route);
    }
  };
  const emitNow = (route: PendingEndpoint | undefined): void => {
    if (route) {
      emitEndpoint(endpointOf(context, route, undefined));
    }
  };

  /**
   * A `@Path("…")` or bare `@RequestMapping("…")` whose meaning is not settled.
   * A class declaration below it makes it the prefix for everything in the
   * class; a route annotation or a callable makes it that one route's path.
   */
  let unsettledPath: string | undefined;
  let graphqlRoot: string | undefined;
  let protoPackage = '';
  let protoService = '';
  let yamlPathsIndent = -1;
  let openApiPath = '';
  let portsBlockIndent = -1;

  for (let index = 0; index < context.lines.length; index += 1) {
    const raw = context.lines[index] ?? '';
    if (raw.length > MAX_LINE_LENGTH) {
      continue;
    }
    const line = index + 1;

    if (context.extension === 'proto') {
      protoPackage = raw.match(/^\s*package\s+([\w.]+)\s*;/)?.[1] ?? protoPackage;
      const service = raw.match(/^\s*service\s+([A-Za-z_]\w*)/)?.[1];
      if (service) {
        protoService = service;
      }
      emitNow(protoRpcOnLine(raw, line, protoPackage, protoService));
      continue;
    }

    if (SCHEMA_EXTENSIONS.has(context.extension) || code) {
      const root = raw.match(/^\s*(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b[^{]*\{/)?.[1];
      if (root) {
        graphqlRoot = root.toLowerCase();
        continue;
      }
      if (graphqlRoot) {
        if (raw.includes('}')) {
          graphqlRoot = undefined;
          continue;
        }
        const field = raw.match(/^\s*([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*(\S.*)$/);
        if (field?.[1]) {
          emitNow({
            protocol: 'graphql',
            operation: graphqlRoot,
            address: field[1],
            framework: 'GraphQL schema',
            line,
            metadata: { Returns: (field[2] ?? '').replace(/[,{]\s*$/, '').trim() },
          });
        }
        continue;
      }
    }

    if (dockerfile) {
      for (const port of exposedPortsOnLine(raw, line, context)) {
        emitPort(port);
      }
      continue;
    }

    if (config) {
      portsBlockIndent = yamlPortsBlock(raw, portsBlockIndent);
      for (const port of configPortsOnLine(raw, line, context, portsBlockIndent)) {
        emitPort(port);
      }
      if (openApi) {
        const paths = raw.match(/^(\s*)paths\s*:/);
        if (paths) {
          yamlPathsIndent = (paths[1] ?? '').length;
          continue;
        }
        if (yamlPathsIndent >= 0) {
          const path = raw.match(/^(\s*)["']?(\/[^"':]*)["']?\s*:/);
          if (path && (path[1] ?? '').length > yamlPathsIndent) {
            openApiPath = path[2] ?? '';
            continue;
          }
          const method = raw.match(new RegExp(`^\\s+["']?(${HTTP_METHODS}|trace)["']?\\s*:\\s*$`, 'i'));
          if (method?.[1] && openApiPath) {
            emitNow({
              protocol: 'http',
              operation: method[1].toUpperCase(),
              address: openApiPath,
              framework: 'OpenAPI description',
              line,
            });
          }
        }
      }
      continue;
    }

    if (!code) {
      continue;
    }

    if (context.fileRoute) {
      const exported = raw.match(new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:function\\s+|const\\s+)(${HTTP_METHODS})\\b`));
      if (exported?.[1]) {
        emitNow({
          protocol: 'http',
          operation: exported[1],
          address: context.fileRoute,
          framework: 'Next.js route handler',
          line,
        });
      } else if (/^\s*export\s+default\b/.test(raw) && context.fileRoute.startsWith('/api/')) {
        emitNow({
          protocol: 'http',
          operation: 'ANY',
          address: context.fileRoute,
          framework: 'Next.js API route',
          line,
        });
      }
    }

    const prefix = routePrefixOnLine(raw);
    if (prefix !== undefined) {
      context.routePrefix = prefix;
    }

    const standalone = raw.match(/^\s*@(?:Path|RequestMapping)\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']*)["']\s*\)\s*$/);
    if (standalone && ['java', 'kt', 'kts'].includes(context.extension)) {
      unsettledPath = standalone[1] ?? '';
      continue;
    }
    if (unsettledPath !== undefined && /\b(?:class|interface|record|object)\s+[A-Za-z_]/.test(raw)) {
      context.routePrefix = normalizeHttpPath(unsettledPath);
      unsettledPath = undefined;
    }

    for (const route of routesOnLine(raw, line, context)) {
      // `@GET` on its own says the verb and nothing else. The path it answers
      // on is the `@Path` beside it, whichever side of it that was written on.
      if (route.framework === 'JAX-RS' && unsettledPath !== undefined) {
        route.address = joinHttpPath(context.routePrefix, unsettledPath);
        unsettledPath = undefined;
      }
      if (route.address !== undefined) {
        push(route);
      }
    }
    for (const route of immediateRoutesOnLine(raw, line, context)) {
      emitNow(route);
    }
    for (const port of codePortsOnLine(raw, line, context)) {
      emitPort(port);
    }

    const declared = callableOnLine(raw, context.extension);
    if (declared) {
      if (unsettledPath !== undefined) {
        for (const route of pending) {
          if (route.framework === 'JAX-RS') {
            route.address = joinHttpPath(context.routePrefix, unsettledPath);
          }
        }
        unsettledPath = undefined;
      }
      emitPending(declared, line);
    }
  }
  emitPending(undefined);
}

/**
 * The callable declared on this line.
 *
 * The shared reader wants a signature it can see the whole of, which most code
 * obliges with. A decorated handler routinely does not: its parameters carry
 * their own decorators and their own inline types, spread over several lines or
 * carrying the semicolons the shared pattern stops at. Both shapes end the same
 * way — a name, a bracket — which is enough to read them here.
 */
const HANDLER_SIGNATURES = [
  // `async login(` — the parameters continue on the lines below.
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|export|suspend)\s+)*([A-Za-z_$][\w$]*)\s*\(\s*$/,
  // `async confirmReset(@Body() body: { token?: string }) {` — complete, but
  // with punctuation inside the parameter list that the shared pattern rejects.
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|export|suspend)\s+)*([A-Za-z_$][\w$]*)\s*\(.*\)\s*(?::[^{]+)?\s*\{\s*$/,
];

const NOT_A_CALLABLE = ['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'new', 'function', 'constructor'];

function callableOnLine(raw: string, extension: string): string | undefined {
  const shared = declaredCallableOnLine(raw, extension);
  if (shared) {
    return shared;
  }
  for (const pattern of HANDLER_SIGNATURES) {
    const name = raw.match(pattern)?.[1];
    if (name && !NOT_A_CALLABLE.includes(name)) {
      return name;
    }
  }
  return undefined;
}

function endpointOf(context: FileContext, route: PendingEndpoint, handler: string | undefined): ProtocolEndpoint {
  return {
    id: stableId('endpoint', context.path, String(route.line), route.protocol, route.operation, route.address),
    protocol: route.protocol,
    operation: route.operation,
    // A blueprint or controller registered on `''` answers on the root of
    // whatever it is mounted at, and `GET ` with nothing after it is not a
    // thing a reader can look for.
    address: route.protocol === 'http' && !route.address ? '/' : route.address,
    ...(handler ? { handler } : {}),
    ...(route.framework ? { framework: route.framework } : {}),
    source: { file: context.path, line: route.line },
    // A path written as a literal is what the framework registers. Everything
    // else here — a prefix joined on, a topic read from a variable — is a
    // reading of the source rather than the source itself.
    confidence: route.address.includes('${') || route.address.includes('{{') ? 'inferred' : 'exact',
    ...(route.metadata ? { metadata: route.metadata } : {}),
  };
}

/**
 * A path declared for a whole class: `@Controller('users')`, `@RequestMapping`,
 * `@Path`. Returns `''` to clear one, which is what a second class in the same
 * file means, and `undefined` when the line says nothing about a prefix.
 */
function routePrefixOnLine(raw: string): string | undefined {
  const nest = raw.match(/@Controller\s*\(\s*['"`]([^'"`]*)['"`]?\s*\)?/);
  if (nest) {
    return normalizeHttpPath(nest[1] ?? '');
  }
  if (/@Controller\s*\(\s*\)/.test(raw)) {
    return '';
  }
  // `@Path` and a bare `@RequestMapping` are deliberately absent: both spell a
  // class prefix and a method path exactly the same way, so which one a line is
  // depends on what comes after it. `scanFile` holds them until that is known.
  if (/^\s*(?:@RestController|@Controller)\s*$/.test(raw)) {
    return '';
  }
  return undefined;
}

/**
 * Declarations that name a path but not the code behind it: annotations and
 * attributes, which sit above the callable that answers them.
 */
function routesOnLine(raw: string, line: number, context: FileContext): PendingEndpoint[] {
  const found: PendingEndpoint[] = [];
  const prefixed = (path: string): string => joinHttpPath(context.routePrefix, path);

  // NestJS / TypeScript decorators, including the bare `@Get()` that means the
  // controller's own path.
  const nest = raw.match(/^\s*@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
  if (nest?.[1] && (context.extension === 'ts' || context.extension === 'js')) {
    found.push({ protocol: 'http', operation: nest[1].toUpperCase(), address: prefixed(nest[2] ?? ''), framework: 'NestJS decorator', line });
  }

  // Spring: `@GetMapping("/x")`, and `@RequestMapping(value = "/x", method = GET)`.
  const springMapping = raw.match(/@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']*)/);
  if (springMapping) {
    found.push({
      protocol: 'http',
      operation: (springMapping[1] ?? '').toUpperCase(),
      address: prefixed(springMapping[2] ?? ''),
      framework: 'Spring MVC',
      line,
    });
  } else if (/@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(\s*\))?\s*$/.test(raw)) {
    const bare = raw.match(/@(Get|Post|Put|Delete|Patch)Mapping/);
    if (bare?.[1]) {
      found.push({ protocol: 'http', operation: bare[1].toUpperCase(), address: prefixed(''), framework: 'Spring MVC', line });
    }
  }
  const springRequest = raw.match(/@RequestMapping\s*\([^)]*?["']([^"']*)["'][^)]*?method\s*=\s*[\w.]*?\b(GET|POST|PUT|DELETE|PATCH)\b/);
  if (springRequest) {
    found.push({
      protocol: 'http',
      operation: (springRequest[2] ?? '').toUpperCase(),
      address: prefixed(springRequest[1] ?? ''),
      framework: 'Spring MVC',
      line,
    });
  }

  // JAX-RS and Micronaut: the verb and the path are separate annotations, and
  // the path may be the class's, which `routePrefix` already holds.
  const jaxrsVerb = raw.match(new RegExp(`^\\s*@(${HTTP_METHODS})\\s*$`));
  if (jaxrsVerb?.[1] && ['java', 'kt', 'kts'].includes(context.extension)) {
    found.push({ protocol: 'http', operation: jaxrsVerb[1], address: prefixed(''), framework: 'JAX-RS', line });
  }

  // ASP.NET attributes.
  const dotnet = raw.match(new RegExp(`\\[Http(${HTTP_METHODS})(?:\\s*\\(\\s*"([^"]*)"\\s*\\))?\\]`, 'i'));
  if (dotnet?.[1]) {
    found.push({ protocol: 'http', operation: dotnet[1].toUpperCase(), address: prefixed(dotnet[2] ?? ''), framework: 'ASP.NET attribute', line });
  }

  // Python decorators: Flask, FastAPI, and the routers built on them.
  // The path has to look like one. `@mock.patch('app.services.mailer')` is the
  // same shape as a route decorator and is not a route, and requiring the
  // leading slash — or the empty string a blueprint root is registered on — is
  // what tells the two apart without keeping a list of test libraries.
  const python = raw.match(/@(?:[\w.]+)\.(route|get|post|put|delete|patch|head|options|websocket)\s*\(\s*["'](|\/[^"']*)["']([^)]*)/i);
  if (python && context.extension === 'py') {
    const verb = (python[1] ?? '').toLowerCase();
    const methods = python[3]?.match(/methods\s*=\s*\[([^\]]*)\]/)?.[1];
    if (verb === 'websocket') {
      found.push({ protocol: 'websocket', operation: 'connect', address: python[2] ?? '', framework: 'FastAPI WebSocket', line });
    } else if (verb === 'route' && methods) {
      for (const method of methods.split(',')) {
        const cleaned = method.replace(/["'\s]/g, '').toUpperCase();
        if (cleaned) {
          found.push({ protocol: 'http', operation: cleaned, address: python[2] ?? '', framework: 'Python route decorator', line });
        }
      }
    } else {
      found.push({
        protocol: 'http',
        operation: verb === 'route' ? 'ANY' : verb.toUpperCase(),
        address: python[2] ?? '',
        framework: 'Python route decorator',
        line,
      });
    }
  }

  // Rust: actix and rocket attribute macros.
  const rust = raw.match(new RegExp(`^\\s*#\\[(${HTTP_METHODS})\\s*\\(\\s*"([^"]*)"`, 'i'));
  if (rust?.[1] && context.extension === 'rs') {
    found.push({ protocol: 'http', operation: rust[1].toUpperCase(), address: rust[2] ?? '', framework: 'Rust route macro', line });
  }

  // Symfony attributes and annotations.
  const symfony = raw.match(/#\[Route\s*\(\s*['"]([^'"]*)['"]([^\]]*)/);
  if (symfony && context.extension === 'php') {
    const methods = symfony[2]?.match(/methods\s*:\s*\[([^\]]*)\]/)?.[1];
    const verbs = methods ? methods.split(',').map((value) => value.replace(/["'\s]/g, '').toUpperCase()).filter(Boolean) : ['ANY'];
    for (const verb of verbs) {
      found.push({ protocol: 'http', operation: verb, address: prefixed(symfony[1] ?? ''), framework: 'Symfony route', line });
    }
  }

  // Message and event handlers declared by annotation.
  const nestMessage = raw.match(/@(MessagePattern|EventPattern)\s*\(\s*['"]([^'"]*)/);
  if (nestMessage?.[2]) {
    found.push({
      protocol: context.messaging ?? 'tcp',
      operation: nestMessage[1] === 'EventPattern' ? 'event' : 'message',
      address: nestMessage[2],
      framework: 'NestJS microservice',
      line,
    });
  }
  const kafkaListener = raw.match(/@KafkaListener\s*\([^)]*topics\s*=\s*\{?\s*["']([^"']+)/);
  if (kafkaListener?.[1]) {
    found.push({ protocol: 'kafka', operation: 'consume', address: kafkaListener[1], framework: 'Spring Kafka', line });
  }
  const rabbitListener = raw.match(/@RabbitListener\s*\([^)]*queues\s*=\s*\{?\s*["']([^"']+)/);
  if (rabbitListener?.[1]) {
    found.push({ protocol: 'amqp', operation: 'consume', address: rabbitListener[1], framework: 'Spring AMQP', line });
  }
  const subscribeMessage = raw.match(/@SubscribeMessage\s*\(\s*['"]([^'"]*)/);
  if (subscribeMessage?.[1]) {
    found.push({ protocol: 'websocket', operation: 'on', address: subscribeMessage[1], framework: 'NestJS gateway', line });
  }
  const messageMapping = raw.match(/@MessageMapping\s*\(\s*"([^"]*)"/);
  if (messageMapping?.[1]) {
    found.push({ protocol: 'websocket', operation: 'message', address: messageMapping[1], framework: 'Spring STOMP', line });
  }

  return found;
}

/**
 * Declarations that carry their own handler: a router call, a broker call, a
 * socket listener. These are complete where they stand, so they are emitted
 * rather than held for the next callable.
 */
function immediateRoutesOnLine(raw: string, line: number, context: FileContext): PendingEndpoint[] {
  const found: PendingEndpoint[] = [];

  // Express, Koa, Fastify, Laravel, and every router that reads like them. The
  // receiver is restricted and the path has to look like a path: `repo.delete(id)`
  // is a far more common line of code than any route, and it is not one.
  const router = raw.match(/\b(?:app|application|router|routes|api|server|fastify|blueprint|bp|Route|route)\s*(?:::|\.|->)\s*(get|post|put|patch|delete|head|options|all|any)\s*\(\s*['"`]([/:][^'"`]*)/i);
  if (router?.[1]) {
    found.push({ protocol: 'http', operation: router[1].toUpperCase(), address: router[2] ?? '', framework: 'Router registration', line });
  }

  if (context.extension === 'go') {
    // Go's routers all spell the verb with a capital, which is distinctive
    // enough that the receiver does not have to be guessed at.
    const gin = raw.match(/\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]*)"/);
    if (gin?.[1]) {
      found.push({ protocol: 'http', operation: gin[1].toUpperCase(), address: gin[2] ?? '', framework: 'Go router', line });
    }
    const handle = raw.match(/\.\s*Handle(?:Func)?\s*\(\s*"([^"]*)"/);
    if (handle?.[1]) {
      found.push({ protocol: 'http', operation: 'ANY', address: handle[1], framework: 'net/http', line });
    }
  }

  if (context.extension === 'rs') {
    const axum = raw.match(/\.\s*route\s*\(\s*"([^"]*)"\s*,\s*(get|post|put|patch|delete|head|options)\s*\(/i);
    if (axum?.[1]) {
      found.push({ protocol: 'http', operation: (axum[2] ?? '').toUpperCase(), address: axum[1], framework: 'axum', line });
    }
  }

  if (context.extension === 'cs') {
    const minimal = raw.match(new RegExp(`\\.\\s*Map(${HTTP_METHODS})\\s*\\(\\s*"([^"]*)"`, 'i'));
    if (minimal?.[1]) {
      found.push({ protocol: 'http', operation: minimal[1].toUpperCase(), address: minimal[2] ?? '', framework: 'ASP.NET minimal API', line });
    }
  }

  if (context.name === 'routes.rb') {
    const rails = raw.match(/^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)/);
    if (rails?.[1]) {
      found.push({ protocol: 'http', operation: rails[1].toUpperCase(), address: normalizeHttpPath(rails[2] ?? ''), framework: 'Rails routes', line });
    }
    const resources = raw.match(/^\s*resources?\s+:(\w+)/);
    if (resources?.[1]) {
      found.push({ protocol: 'http', operation: 'RESOURCE', address: `/${resources[1]}`, framework: 'Rails routes', line });
    }
  }

  if (context.extension === 'py') {
    // Django's URLconf, where the view is the second argument rather than the
    // declaration below.
    const django = raw.match(/\b(?:path|re_path|url)\s*\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/);
    if (django) {
      found.push({
        protocol: 'http',
        operation: 'ANY',
        address: normalizeHttpPath(django[1] ?? ''),
        framework: 'Django URLconf',
        line,
        metadata: { View: django[2] ?? '' },
      });
    }
  }

  if (context.websocket) {
    const listener = raw.match(/\b(?:socket|sock|ws|wss|io|client|conn|channel)\s*\.\s*(on|once|addEventListener)\s*\(\s*['"`]([^'"`]+)/);
    if (listener?.[2]) {
      found.push({ protocol: 'websocket', operation: 'on', address: listener[2], framework: 'Socket listener', line });
    }
    const emitter = raw.match(/\b(?:socket|sock|ws|wss|io|client|conn|channel)\s*\.\s*(emit|send|broadcast)\s*\(\s*['"`]([^'"`]+)/);
    if (emitter?.[2]) {
      found.push({ protocol: 'websocket', operation: 'emit', address: emitter[2], framework: 'Socket emit', line });
    }
  }

  // Only where the response is being declared as a stream. A file that merely
  // mentions `text/event-stream` — a list of compressible media types, a test
  // fixture — is not an endpoint, and matching the string alone found far more
  // of those than of the real thing.
  const eventStream = /(?:media_?type|mimetype|content_?type|Content-Type|contentType)["']?\s*[=:,]\s*["']text\/event-stream/i.test(raw)
    || /\b(?:EventSourceResponse|SseEmitter|ServerSentEvent|TEXT_EVENT_STREAM)\b/.test(raw);
  if (eventStream) {
    found.push({ protocol: 'sse', operation: 'stream', address: context.path, framework: 'Event-stream response', line });
  }

  const broker = context.messaging;
  if (broker) {
    const framework = context.messagingFramework ?? PROTOCOL_INFO[broker].label;
    // kafkajs and its relatives name the topic inside an options object; the
    // rest of the world passes it as the first argument.
    const topicOption = raw.match(/\b(?:subscribe|consume|send|publish|produce|run)\s*\(\s*\{[^}]*?topics?\s*:\s*\[?\s*['"`]([^'"`]+)/);
    if (topicOption?.[1]) {
      found.push({ protocol: broker, operation: /\b(?:send|publish|produce)\b/.test(raw) ? 'publish' : 'subscribe', address: topicOption[1], framework, line });
    }
    const direct = raw.match(/\b(subscribe|unsubscribe|publish|consume|assertQueue|queue_declare|basic_consume|basic_publish|createConsumer)\s*\(\s*(?:queue\s*=\s*)?['"`]([^'"`]+)/);
    if (direct?.[1] && direct[1] !== 'unsubscribe') {
      const verb = direct[1];
      const operation = verb === 'publish' || verb === 'basic_publish' ? 'publish'
        : verb === 'assertQueue' || verb === 'queue_declare' ? 'declare'
          : verb === 'consume' || verb === 'basic_consume' || verb === 'createConsumer' ? 'consume'
            : 'subscribe';
      found.push({ protocol: broker, operation, address: direct[2] ?? '', framework, line });
    }
    const kafkaPython = raw.match(/\bKafka(Consumer|Producer)\s*\(\s*['"]([^'"]+)/);
    if (kafkaPython?.[2]) {
      found.push({
        protocol: 'kafka',
        operation: kafkaPython[1] === 'Producer' ? 'publish' : 'consume',
        address: kafkaPython[2],
        framework,
        line,
      });
    }
  }

  return found;
}

function protoRpcOnLine(raw: string, line: number, packageName: string, service: string): PendingEndpoint | undefined {
  const rpc = raw.match(/^\s*rpc\s+([A-Za-z_]\w*)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)/);
  if (!rpc?.[1] || !service) {
    return undefined;
  }
  const qualified = packageName ? `${packageName}.${service}` : service;
  return {
    protocol: 'grpc',
    operation: 'rpc',
    address: `${qualified}/${rpc[1]}`,
    framework: 'Protocol Buffers service',
    line,
    metadata: {
      Request: `${rpc[2] ? 'stream ' : ''}${rpc[3] ?? ''}`,
      Response: `${rpc[4] ? 'stream ' : ''}${rpc[5] ?? ''}`,
      ...(rpc[2] || rpc[4] ? { Streaming: rpc[2] && rpc[4] ? 'bidirectional' : rpc[2] ? 'client' : 'server' } : {}),
    },
  };
}

/** `EXPOSE 8080 8443/udp`, which may name several ports on one line. */
function exposedPortsOnLine(raw: string, line: number, context: FileContext): PortBinding[] {
  const exposed = raw.match(/^\s*EXPOSE\s+(.+)$/i);
  if (!exposed?.[1]) {
    return [];
  }
  const found: PortBinding[] = [];
  for (const token of exposed[1].split(/\s+/)) {
    const parsed = token.match(/^(\d{1,5})(?:\/(tcp|udp))?$/i);
    const port = Number(parsed?.[1]);
    if (!parsed || !isPort(port)) {
      continue;
    }
    found.push(portBinding(context, line, {
      port,
      kind: 'expose',
      evidence: raw.trim(),
      ...(parsed[2] ? { transport: parsed[2].toLowerCase() as 'tcp' | 'udp' } : {}),
    }));
  }
  return found;
}

/**
 * Whether this line is inside a compose `ports:` block, given where the last
 * one started. Indentation is all YAML gives us and all that is needed: a
 * `- "8080:80"` under `ports:` is a published mapping, and the same line under
 * `command:` is an argument.
 */
function yamlPortsBlock(raw: string, current: number): number {
  const opener = raw.match(/^(\s*)ports\s*:\s*$/);
  if (opener) {
    return (opener[1] ?? '').length;
  }
  if (current < 0 || !raw.trim()) {
    return current;
  }
  const indent = raw.length - raw.trimStart().length;
  return indent > current ? current : -1;
}

function configPortsOnLine(raw: string, line: number, context: FileContext, portsBlockIndent: number): PortBinding[] {
  const found: PortBinding[] = [];

  if (portsBlockIndent >= 0) {
    const mapping = raw.match(/^\s*-\s*["']?(?:(\d{1,5}):)?(\d{1,5})(?:\/(tcp|udp))?["']?\s*$/);
    const port = Number(mapping?.[2]);
    if (mapping && isPort(port)) {
      const hostPort = Number(mapping[1]);
      found.push(portBinding(context, line, {
        port,
        ...(isPort(hostPort) ? { hostPort } : {}),
        kind: 'published',
        evidence: raw.trim(),
        ...(mapping[3] ? { transport: mapping[3].toLowerCase() as 'tcp' | 'udp' } : {}),
      }));
    }
  }

  // Kubernetes and the manifests that copy it.
  const container = raw.match(/^\s*-?\s*(containerPort|targetPort|nodePort)\s*:\s*(\d{1,5})\s*$/);
  if (container && isPort(Number(container[2]))) {
    found.push(portBinding(context, line, {
      port: Number(container[2]),
      declaredAs: container[1],
      kind: container[1] === 'containerPort' ? 'listen' : 'published',
      evidence: raw.trim(),
    }));
  }

  // `server.port=8080`, `port: 8080`, `"port": 3000` — the same setting in the
  // four shapes a project's configuration is written in.
  const setting = raw.match(/^\s*["']?([\w.-]*\bport)["']?\s*[:=]\s*["']?(\d{1,5})["']?\s*,?\s*$/i);
  if (setting && isPort(Number(setting[2])) && portsBlockIndent < 0) {
    found.push(portBinding(context, line, {
      port: Number(setting[2]),
      declaredAs: setting[1],
      kind: 'config',
      evidence: raw.trim(),
      confidence: 'inferred',
    }));
  }

  return found;
}

function codePortsOnLine(raw: string, line: number, context: FileContext): PortBinding[] {
  const found: PortBinding[] = [];

  // `app.listen(3000)`, `server.listen(PORT)`, `listen({ port: 3000 })`.
  const listen = raw.match(/\.\s*listen\s*\(\s*(?:\{[^}]*?port\s*:\s*)?([A-Za-z_$][\w$.]*|\d{1,5})/);
  if (listen?.[1]) {
    found.push(...bindingFor(context, line, listen[1], 'listen', raw));
  }
  const goListen = raw.match(/Listen(?:AndServe(?:TLS)?|)\s*\(\s*"([^"]*)"/);
  if (goListen?.[1]) {
    const port = Number(goListen[1].split(':').at(-1));
    if (isPort(port)) {
      found.push(portBinding(context, line, { port, kind: 'listen', evidence: raw.trim() }));
    }
  }
  const bind = raw.match(/\b(?:bindAsync|bind|serve|start_server)\s*\(\s*["'`]([^"'`]*:(\d{1,5}))["'`]/);
  if (bind && isPort(Number(bind[2]))) {
    found.push(portBinding(context, line, { port: Number(bind[2]), kind: 'listen', evidence: raw.trim() }));
  }
  const pythonRun = raw.match(/\.\s*run\s*\([^)]*\bport\s*=\s*(\d{1,5}|[A-Za-z_]\w*)/);
  if (pythonRun?.[1]) {
    found.push(...bindingFor(context, line, pythonRun[1], 'listen', raw));
  }

  // `process.env.PORT || 3000` and `os.environ.get('PORT', 8000)`: the literal
  // is the default the project runs on when nothing overrides it, and the name
  // is what does the overriding. Both are worth saying.
  const envDefault = raw.match(/(?:process\.env\.|environ(?:\.get)?\(\s*["']|getenv\(\s*["'])([A-Z_]*PORT)["']?[^\n]*?(\d{2,5})/);
  if (envDefault && isPort(Number(envDefault[2]))) {
    found.push(portBinding(context, line, {
      port: Number(envDefault[2]),
      declaredAs: envDefault[1],
      kind: 'config',
      evidence: raw.trim(),
    }));
  }

  return found;
}

/** A `listen` argument, which is either the port or the name holding it. */
function bindingFor(
  context: FileContext,
  line: number,
  argument: string,
  kind: PortBindingKind,
  raw: string,
): PortBinding[] {
  const port = Number(argument);
  if (isPort(port)) {
    return [portBinding(context, line, { port, kind, evidence: raw.trim() })];
  }
  if (/^\d+$/.test(argument) || !/port/i.test(argument)) {
    // A number that is not a port, or a variable whose name gives no reason to
    // believe it holds one. Recording it would be inventing an interface.
    return [];
  }
  return [portBinding(context, line, {
    declaredAs: argument,
    kind,
    evidence: raw.trim(),
    confidence: 'inferred',
  })];
}

function portBinding(
  context: FileContext,
  line: number,
  fields: {
    port?: number;
    hostPort?: number;
    declaredAs?: string;
    kind: PortBindingKind;
    evidence: string;
    transport?: 'tcp' | 'udp';
    confidence?: PortBinding['confidence'];
  },
): PortBinding {
  const known = fields.port === undefined ? undefined : WELL_KNOWN_PORTS.get(fields.port);
  return {
    id: stableId('port', context.path, String(line), String(fields.port ?? fields.declaredAs ?? ''), fields.kind),
    protocol: known?.protocol ?? 'tcp',
    ...(fields.port === undefined ? {} : { port: fields.port }),
    ...(fields.hostPort === undefined ? {} : { hostPort: fields.hostPort }),
    ...(fields.declaredAs === undefined ? {} : { declaredAs: fields.declaredAs }),
    kind: fields.kind,
    evidence: truncate(fields.evidence, 120),
    ...(known?.note ? { note: known.note } : {}),
    ...(fields.transport ? { transport: fields.transport } : {}),
    source: { file: context.path, line },
    confidence: fields.confidence ?? (fields.port === undefined ? 'inferred' : 'exact'),
  };
}

function addFramework(target: Map<ProtocolId, Set<string>>, protocol: ProtocolId, framework: string): void {
  const current = target.get(protocol);
  if (current) {
    current.add(framework);
  } else {
    target.set(protocol, new Set([framework]));
  }
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** A path with exactly one leading slash and no trailing one. */
function normalizeHttpPath(path: string): string {
  const trimmed = path.trim().replace(/^\^/, '').replace(/\$$/, '');
  if (!trimmed) {
    return '/';
  }
  const leading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return leading.length > 1 ? leading.replace(/\/+$/, '') : leading;
}

function joinHttpPath(prefix: string, path: string): string {
  const head = prefix ? normalizeHttpPath(prefix) : '';
  const tail = path ? normalizeHttpPath(path) : '';
  if (!head) {
    return tail || '/';
  }
  if (!tail || tail === '/') {
    return head;
  }
  return `${head === '/' ? '' : head}${tail}`;
}

function extensionOf(filePath: string): string {
  const name = filePath.toLowerCase().split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function stableId(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}
