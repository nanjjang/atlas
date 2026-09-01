import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWorkspace } from '../src/analyzer';
import { analyzeInterfaces } from '../src/interfaceAnalyzer';
import type { InterfaceCatalog, ProtocolId, WorkspaceFile } from '../src/model';

function file(path: string, content: string): WorkspaceFile {
  return { path, content, size: new TextEncoder().encode(content).byteLength };
}

function read(files: WorkspaceFile[]): InterfaceCatalog {
  return analyzeInterfaces(files, new Map()).catalog;
}

function addresses(catalog: InterfaceCatalog, protocol: ProtocolId): string[] {
  const surface = catalog.surfaces.find((candidate) => candidate.protocol === protocol);
  return (surface?.endpoints ?? []).map((endpoint) => `${endpoint.operation} ${endpoint.address}`);
}

test('reads HTTP endpoints from a router registration and from decorators with a controller prefix', () => {
  const catalog = read([
    file('src/server.ts', `
      const app = express();
      app.get('/health', health);
      app.post('/users/:id', updateUser);
      userRepository.delete('42');
    `),
    file('src/users.controller.ts', `
      @Controller('users')
      export class UsersController {
        @Get(':id')
        findOne(id: string) { return id; }
        @Post()
        create(body: Body) { return body; }
      }
    `),
  ]);

  const http = addresses(catalog, 'http');
  assert.ok(http.includes('GET /health'));
  assert.ok(http.includes('POST /users/:id'));
  assert.ok(http.includes('GET /users/:id'), 'the controller path is joined onto the method path');
  assert.ok(http.includes('POST /users'), 'a bare decorator answers on the controller path itself');
  // A repository call spelled like a route is not a route.
  assert.ok(!http.some((entry) => entry.includes('42')));
});

test('a decorated route is attributed to the callable declared under it', () => {
  const catalog = read([
    file('api/main.py', `
      @app.get("/items/{item_id}")
      async def read_item(item_id: int):
          return item_id
    `),
  ]);
  const surface = catalog.surfaces.find((candidate) => candidate.protocol === 'http');
  assert.equal(surface?.endpoints[0]?.address, '/items/{item_id}');
  assert.equal(surface?.endpoints[0]?.handler, 'read_item');
});

test('a handler is named only when it is the one declared under the route', () => {
  const catalog = read([
    file('src/auth.controller.ts', `
      @Controller('v1/auth')
      export class AuthController {
        @Post('login')
        @HttpCode(200)
        async login(
          @Body() body: { email?: string },
          @Res() reply: FastifyReply,
        ) {
          return this.auth.login(body);
        }

        @Post('reset')
        async confirmReset(@Body() body: { token?: string; password?: string }) {
          return this.auth.reset(body);
        }
      }
    `),
    file('src/orphan.ts', `
      @Get('/late')
      // Nothing answers this for a while.
      const unrelated = 1;
      const alsoUnrelated = 2;
      const stillUnrelated = 3;
      const andAnother = 4;
      const oneMore = 5;
      const yetMore = 6;
      function somethingElse() { return 0; }
    `),
  ]);

  const byAddress = new Map(
    (catalog.surfaces.find((surface) => surface.protocol === 'http')?.endpoints ?? [])
      .map((endpoint) => [endpoint.address, endpoint]),
  );
  // Both signatures defeat a one-line reader: the first runs over several
  // lines, the second carries semicolons inside its parameter list.
  assert.equal(byAddress.get('/v1/auth/login')?.handler, 'login');
  assert.equal(byAddress.get('/v1/auth/reset')?.handler, 'confirmReset');
  // Out of reach: the route is kept, the wrong function is not named.
  assert.ok(byAddress.has('/late'));
  assert.equal(byAddress.get('/late')?.handler, undefined);
});

test('reads Spring and Go route declarations', () => {
  const catalog = read([
    file('src/main/java/app/OrderController.java', `
      @RestController
      @RequestMapping("/api/orders")
      public class OrderController {
        @GetMapping("/{id}")
        public Order find(String id) { return null; }
      }
    `),
    file('cmd/server/main.go', `
      func main() {
        r := gin.Default()
        r.GET("/ping", pong)
        http.ListenAndServe(":8080", r)
      }
    `),
  ]);
  const http = addresses(catalog, 'http');
  assert.ok(http.includes('GET /api/orders/{id}'));
  assert.ok(http.includes('GET /ping'));
  assert.ok(catalog.ports.some((port) => port.port === 8080 && port.kind === 'listen'));
});

test('reads the routes a Next.js project declares by where its files sit', () => {
  const catalog = read([
    file('src/app/(marketing)/api/users/[id]/route.ts', `
      export async function GET(request: Request) { return Response.json({}); }
      export async function DELETE(request: Request) { return new Response(null); }
    `),
    file('pages/api/legacy/index.ts', 'export default function handler(req, res) { res.end(); }\n'),
    file('src/app/dashboard/page.tsx', 'export default function Page() { return null; }\n'),
  ]);

  const http = addresses(catalog, 'http');
  // The route group is a folder for the author, not a segment of the URL.
  assert.ok(http.includes('GET /api/users/[id]'));
  assert.ok(http.includes('DELETE /api/users/[id]'));
  assert.ok(http.includes('ANY /api/legacy'));
  // A page is not an endpoint; only `route.ts` and `pages/api` are.
  assert.equal(http.length, 3);
});

test('tells a class path from a method path when both are spelled the same way', () => {
  const catalog = read([
    file('src/main/java/app/OrderResource.java', `
      @Path("/orders")
      public class OrderResource {
        @GET
        @Path("/{id}")
        public Order find(String id) { return null; }

        @POST
        public Order create(Order order) { return order; }
      }
    `),
    file('src/main/java/app/ReportController.java', `
      @RestController
      @RequestMapping("/reports")
      public class ReportController {
        @GetMapping
        public List<Report> all() { return null; }
      }
    `),
  ]);

  const http = addresses(catalog, 'http');
  assert.ok(http.includes('GET /orders/{id}'), 'the method @Path joins onto the class @Path');
  assert.ok(http.includes('POST /orders'), 'a verb with no @Path answers on the class path');
  assert.ok(http.includes('GET /reports'));
  // The method-level path must not have become the prefix for what follows it.
  assert.ok(!http.includes('POST /{id}'));
});

test('reads gRPC methods, including which side streams', () => {
  const catalog = read([
    file('proto/users.proto', `
      syntax = "proto3";
      package acme.users.v1;
      service Users {
        rpc GetUser (GetUserRequest) returns (User);
        rpc Watch (WatchRequest) returns (stream Event);
      }
    `),
  ]);
  const surface = catalog.surfaces.find((candidate) => candidate.protocol === 'grpc');
  assert.deepEqual(
    surface?.endpoints.map((endpoint) => endpoint.address),
    ['acme.users.v1.Users/GetUser', 'acme.users.v1.Users/Watch'],
  );
  const watch = surface?.endpoints.find((endpoint) => endpoint.address.endsWith('Watch'));
  assert.equal(watch?.metadata?.Streaming, 'server');
});

test('reads GraphQL root fields and leaves ordinary types alone', () => {
  const catalog = read([
    file('schema.graphql', `
      type User {
        id: ID!
        name: String
      }
      type Query {
        user(id: ID!): User
        users: [User!]!
      }
      type Mutation {
        createUser(input: NewUser!): User
      }
    `),
  ]);
  const graphql = addresses(catalog, 'graphql');
  assert.deepEqual(graphql.sort(), ['mutation createUser', 'query user', 'query users']);
});

test('a broker topic is read only where the file says which broker it is', () => {
  const withImport = read([
    file('src/orders.ts', `
      import { Kafka } from 'kafkajs';
      await consumer.subscribe({ topic: 'orders.created' });
      await producer.send({ topic: 'orders.shipped', messages: [] });
    `),
  ]);
  assert.deepEqual(addresses(withImport, 'kafka').sort(), ['publish orders.shipped', 'subscribe orders.created']);

  const withoutImport = read([
    file('src/bus.ts', `
      emitter.subscribe('anything');
    `),
  ]);
  assert.equal(withoutImport.surfaces.length, 0, 'a bare subscribe names no protocol');
});

test('socket events are read where a socket library is in reach', () => {
  const catalog = read([
    file('src/gateway.ts', `
      import { Server } from 'socket.io';
      io.on('connection', (socket) => {
        socket.on('message:new', handle);
        socket.emit('message:ack', {});
      });
    `),
  ]);
  const websocket = addresses(catalog, 'websocket');
  assert.ok(websocket.includes('on message:new'));
  assert.ok(websocket.includes('emit message:ack'));
});

test('ports are read from code, containers, and settings, and keep the declaration they came from', () => {
  const catalog = read([
    file('src/index.ts', "const server = app.listen(4321);"),
    file('Dockerfile', 'FROM node:22\nEXPOSE 8080 9000/udp\nCMD ["node", "."]'),
    file('docker-compose.yml', `
services:
  api:
    ports:
      - "18080:8080"
    command: run 1234
`),
    file('deploy/api.yaml', `
spec:
  containers:
    - name: api
      ports:
        - containerPort: 8080
`),
    file('src/main/resources/application.properties', 'server.port=9090\n'),
  ]);

  const listed = catalog.ports.map((port) => `${port.kind} ${port.port}`);
  assert.ok(listed.includes('listen 4321'));
  assert.ok(listed.includes('expose 8080'));
  assert.ok(listed.includes('expose 9000'));
  assert.ok(listed.includes('published 8080'));
  assert.ok(listed.includes('config 9090'));
  assert.equal(catalog.ports.find((port) => port.kind === 'published')?.hostPort, 18080);
  assert.equal(catalog.ports.find((port) => port.port === 9000)?.transport, 'udp');
  // `command: run 1234` sits under the service, not under `ports:`.
  assert.ok(!listed.includes('published 1234'));
  // A well-known number says what usually answers on it, and says it as a note.
  assert.equal(catalog.ports.find((port) => port.port === 8080)?.note, 'HTTP');
});

test('a port declared beside an endpoint takes that endpoint\'s protocol', () => {
  const catalog = read([
    file('src/rpc/server.ts', `
      const server = new grpc.Server();
      server.bindAsync('0.0.0.0:7070', credentials, () => {});
    `),
    file('proto/a.proto', 'package a;\nservice A {\n  rpc Do (Req) returns (Res);\n}\n'),
    file('src/http/server.ts', `
      app.get('/status', status);
      app.listen(4444);
    `),
  ]);
  assert.equal(catalog.ports.find((port) => port.port === 4444)?.protocol, 'http');
  assert.equal(catalog.ports.find((port) => port.port === 7070)?.protocol, 'tcp');
});

test('a protocol with a published port but no readable endpoint still gets a surface', () => {
  const catalog = read([file('Dockerfile', 'EXPOSE 6379\n')]);
  const redis = catalog.surfaces.find((surface) => surface.protocol === 'redis');
  assert.ok(redis);
  assert.equal(redis.endpoints.length, 0);
});

test('the snapshot carries the interface catalog, its counts, and a note about what static analysis cannot see', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/server.ts', "app.get('/health', health);\napp.listen(3000);\n"),
  ], { projectName: 'interfaces-demo', revision: 1 });

  assert.equal(snapshot.stats.protocols, 1);
  assert.equal(snapshot.stats.endpoints, 1);
  assert.equal(snapshot.stats.ports, 1);
  assert.equal(snapshot.interfaces.surfaces[0]?.protocol, 'http');
  assert.ok(snapshot.diagnostics.some((entry) => entry.code === 'INTERFACE_STATIC_HEURISTIC'));
});

test('a workspace that exposes nothing reports an empty catalog rather than guesses', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/math.ts', 'export const add = (a: number, b: number) => a + b;\n'),
  ], { projectName: 'quiet', revision: 1 });
  assert.deepEqual(snapshot.interfaces.surfaces, []);
  assert.deepEqual(snapshot.interfaces.ports, []);
  assert.equal(snapshot.stats.protocols, 0);
});
