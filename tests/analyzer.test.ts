import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeWorkspace,
  isTextAnalysisPath,
  moduleNodeIdForPath,
  structureNodeIdForPath,
} from '../src/analyzer';
import type { StructureNode, WorkspaceFile } from '../src/model';

function file(path: string, content: string): WorkspaceFile {
  return { path, content, size: new TextEncoder().encode(content).byteLength };
}

test('builds deterministic module and external dependency graphs', () => {
  const files = [
    file('package.json', JSON.stringify({ dependencies: { react: '^19.0.0' } })),
    file('src/domain/user.ts', 'export interface User { id: string }'),
    file('src/api/client.ts', "import type { User } from '../domain/user';\nexport const load = (): User => ({ id: '1' });"),
    file('src/ui/App.tsx', "import React from 'react';\nimport { load } from '@/api/client';\nexport const App = () => load().id;"),
  ];

  const first = analyzeWorkspace(files, { projectName: 'demo', revision: 1 });
  const second = analyzeWorkspace([...files].reverse(), { projectName: 'demo', revision: 1 });

  assert.deepEqual(first.architecture, second.architecture);
  assert.deepEqual(first.technologies, ['React', 'TypeScript']);
  assert.equal(first.stats.modules, 3);
  assert.ok(first.architecture.nodes.some((node) => node.label === 'react' && node.kind === 'external-package'));
  assert.ok(first.architecture.edges.some((edge) => edge.kind === 'imports' && edge.label === '1 import'));
});

test('creates a searchable structure tree with source locations', () => {
  const snapshot = analyzeWorkspace([
    file('README.md', '# Demo'),
    file('src/index.ts', 'export {};'),
    file('src/features/user.ts', 'export {};'),
  ], { projectName: 'demo', revision: 2 });

  assert.equal(snapshot.structure.label, 'demo');
  const src = snapshot.structure.children.find((node) => node.label === 'src');
  const features = src?.children.find((node) => node.label === 'features');
  const user = features?.children.find((node) => node.label === 'user.ts');
  assert.deepEqual(user?.source, { file: 'src/features/user.ts', line: 1 });
  assert.equal(snapshot.stats.files, 3);
});

test('extracts Prisma models and their relations without merging schema sources', () => {
  const snapshot = analyzeWorkspace([
    file('prisma/schema.prisma', `
      datasource db { provider = "postgresql" url = env("DATABASE_URL") }
      model User {
        id Int @id @default(autoincrement())
        posts Post[]
        @@map("users")
      }
      model Post {
        id Int @id
        authorId Int
        author User @relation(fields: [authorId], references: [id])
      }
    `),
  ], { projectName: 'database', revision: 3 });

  assert.equal(snapshot.database.nodes.length, 2);
  assert.equal(snapshot.database.edges.length, 1);
  assert.ok(snapshot.database.nodes.some((node) => node.label.includes('User')));
  assert.ok(snapshot.database.edges.some((edge) => edge.label?.includes('author')));
  assert.deepEqual(snapshot.technologies, ['Prisma']);
});

test('extracts SQL tables, columns, primary keys, and foreign keys', () => {
  const snapshot = analyzeWorkspace([
    file('db/schema.sql', `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY,
        author_id INTEGER NOT NULL,
        CONSTRAINT posts_author_fk FOREIGN KEY (author_id) REFERENCES users(id)
      );
    `),
  ], { projectName: 'sql', revision: 4 });

  assert.equal(snapshot.database.nodes.length, 2);
  assert.equal(snapshot.database.edges.length, 1);
  const users = snapshot.database.nodes.find((node) => node.label.includes('users'));
  assert.ok(users);
  assert.ok(Array.isArray(users.metadata.Fields));
  assert.ok((users.metadata.Fields).some((fieldValue) => fieldValue.includes('PK')));
});

test('extracts representative TypeORM, JPA, and Django ORM entities', () => {
  const snapshot = analyzeWorkspace([
    file('src/user.entity.ts', `
      import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
      @Entity('users')
      export class User {
        @PrimaryGeneratedColumn() id!: number;
        @Column() email!: string;
      }
      @Entity('posts')
      export class Post {
        @PrimaryGeneratedColumn() id!: number;
        @ManyToOne(() => User) author!: User;
      }
    `),
    file('src/main/java/Order.java', `
      import jakarta.persistence.*;
      @Entity
      @Table(name = "orders")
      public class Order {
        @Id private Long id;
        @ManyToOne private Customer customer;
      }
    `),
    file('app/models.py', `
      from django.db import models
      class Team(models.Model):
          name = models.CharField(max_length=100)
      class Member(models.Model):
          team = models.ForeignKey(Team, on_delete=models.CASCADE)
    `),
  ], { projectName: 'orm', revision: 5 });

  const groups = new Set(snapshot.database.nodes.map((node) => node.group));
  assert.ok([...groups].some((group) => group?.includes('TypeORM')));
  assert.ok([...groups].some((group) => group?.includes('JPA')));
  assert.ok([...groups].some((group) => group?.includes('Django')));
  assert.ok(snapshot.database.edges.length >= 3);
});

test('never treats dotenv files as parseable source', () => {
  assert.equal(isTextAnalysisPath('.env'), false);
  assert.equal(isTextAnalysisPath('.env.local'), false);
  assert.equal(isTextAnalysisPath('src/index.ts'), true);
  assert.equal(isTextAnalysisPath('schema.prisma'), true);
});

test('resolves C#, Rust, PHP, and Ruby imports into module relationships', () => {
  const snapshot = analyzeWorkspace([
    file('src/models/user.rs', 'pub struct User;'),
    file('src/api/handler.rs', 'use crate::models::user::User;\nmod helper;'),
    file('src/api/helper.rs', 'pub fn help() {}'),
    file('src/Domain/Order.cs', 'namespace App.Domain;\npublic class Order {}'),
    file('src/Api/Controller.cs', 'using App.Domain;\npublic class Controller {}'),
    file('src/Model/User.php', '<?php\nnamespace App\\Model;\nclass User {}'),
    file('src/Http/Controller.php', '<?php\nnamespace App\\Http;\nuse App\\Model\\User;'),
    file('lib/thing.rb', 'module Thing; end'),
    file('app/main.rb', "require_relative '../lib/thing'"),
  ], { projectName: 'polyglot', revision: 6 });

  const labelOf = (id: string): string | undefined =>
    snapshot.architecture.nodes.find((node) => node.id === id)?.label;
  const relationships = snapshot.architecture.edges
    .filter((edge) => edge.kind === 'imports')
    .map((edge) => `${labelOf(edge.from)} -> ${labelOf(edge.to)}`);

  assert.ok(relationships.includes('src/api -> src/models'), 'a Rust `use crate::` path must resolve');
  assert.ok(relationships.includes('src/Api -> src/Domain'), 'a C# namespace import must resolve');
  assert.ok(relationships.includes('src/Http -> src/Model'), 'a PHP namespaced `use` must resolve');
  assert.ok(relationships.includes('app -> lib'), 'a Ruby require_relative must resolve');
});

test('a Java package wildcard reaches the whole package, counted once per module', () => {
  const snapshot = analyzeWorkspace([
    file('src/domain/A.java', 'package com.demo.domain;\npublic class A {}'),
    file('src/domain/B.java', 'package com.demo.domain;\npublic class B {}'),
    file('src/domain/C.java', 'package com.demo.domain;\npublic class C {}'),
    file('src/api/Service.java', 'package com.demo.api;\nimport com.demo.domain.*;\npublic class Service {}'),
  ], { projectName: 'java', revision: 7 });

  const imports = snapshot.architecture.edges.filter((edge) => edge.kind === 'imports');
  assert.equal(imports.length, 1);
  // Three types are reachable, but they live in one module, so it stays one import.
  assert.equal(imports[0]?.label, '1 import');
});

test('an external package edge points at a file inside the module that uses it', () => {
  const snapshot = analyzeWorkspace([
    file('src/aaa/first.ts', "import React from 'react';"),
    file('src/zzz/second.ts', "import React from 'react';"),
  ], { projectName: 'external', revision: 8 });

  const uses = snapshot.architecture.edges.filter((edge) => edge.kind === 'uses');
  assert.equal(uses.length, 2);
  const moduleOf = (id: string): string | undefined =>
    snapshot.architecture.nodes.find((node) => node.id === id)?.label;
  for (const edge of uses) {
    const owner = moduleOf(edge.from);
    assert.ok(owner && edge.source?.file.startsWith(owner), `${edge.source?.file} must live in ${owner}`);
  }
});

test('reports unresolved local imports but stays quiet about third-party ones', () => {
  const snapshot = analyzeWorkspace([
    file('src/app/index.ts', "import './missing-neighbour';\nimport 'lodash';"),
    file('src/app/lib.rs', 'use crate::nowhere::Thing;\nuse serde::Serialize;'),
  ], { projectName: 'unresolved', revision: 9 });

  const unresolved = snapshot.diagnostics.find((diagnostic) => diagnostic.code === 'UNRESOLVED_IMPORT');
  assert.ok(unresolved, 'the two workspace-local imports must be reported');
  assert.match(unresolved.message, /^2 local imports/);
});

test('a file directly under a container directory belongs to that directory', () => {
  const snapshot = analyzeWorkspace([
    file('src/analyzer.ts', "import { parse } from './glob';\nexport const run = parse;"),
    file('src/glob.ts', 'export const parse = (): number => 1;'),
    file('src/features/user.ts', 'export {};'),
    file('apps/web/main.ts', 'export {};'),
    file('index.ts', 'export {};'),
  ], { projectName: 'granularity', revision: 10 });

  const modules = snapshot.architecture.nodes
    .filter((node) => node.kind === 'module')
    .map((node) => node.label)
    .sort();

  // `src/analyzer.ts` is a file, not a module: it belongs to `src`.
  assert.deepEqual(modules, ['(root)', 'apps/web', 'src', 'src/features']);
  assert.equal(
    snapshot.architecture.edges.length,
    0,
    'two files inside one module are an internal detail, not a dependency',
  );
});

test('a workspace path maps onto the ids the diagram actually uses', () => {
  const snapshot = analyzeWorkspace([
    file('src/features/user.ts', "export const id = 1;"),
    file('apps/web/main.ts', 'export {};'),
  ], { projectName: 'ids', revision: 11 });

  // The views turn the active editor into a position on the diagram through
  // these helpers, so they have to agree with what the analyzer emitted.
  const moduleNode = snapshot.architecture.nodes.find((node) => node.label === 'src/features');
  assert.ok(moduleNode, 'the fixture must produce an src/features module');
  assert.equal(moduleNodeIdForPath('src/features/user.ts'), moduleNode.id);

  const fileNode = findByPath(snapshot.structure, 'src/features/user.ts');
  assert.ok(fileNode, 'the fixture must produce a row for the file');
  assert.equal(structureNodeIdForPath('src/features/user.ts'), fileNode.id);
});

test('path ids survive the separators and prefixes an editor can hand over', () => {
  assert.equal(moduleNodeIdForPath('src\\features\\user.ts'), moduleNodeIdForPath('src/features/user.ts'));
  assert.equal(structureNodeIdForPath('./src/features/user.ts'), structureNodeIdForPath('src/features/user.ts'));
});

/** The modules one module depends on, by label, for the assertions below. */
function dependenciesOf(snapshot: ReturnType<typeof analyzeWorkspace>, label: string): string[] {
  const byId = new Map(snapshot.architecture.nodes.map((node) => [node.id, node.label]));
  const source = snapshot.architecture.nodes.find((node) => node.label === label);
  return snapshot.architecture.edges
    .filter((edge) => edge.from === source?.id)
    .map((edge) => byId.get(edge.to) ?? '')
    .sort();
}

function externalsOf(snapshot: ReturnType<typeof analyzeWorkspace>): string[] {
  return snapshot.architecture.nodes
    .filter((node) => node.kind === 'external-package')
    .map((node) => node.label)
    .sort();
}

test('a Go import names a package directory, so it reaches every file in it', () => {
  const snapshot = analyzeWorkspace([
    file('go.mod', 'module example.com/shop\n\ngo 1.22\n'),
    file('cmd/api/main.go', 'package main\n\nimport "example.com/shop/internal/store"\n\nfunc main() { _ = store.Name }\n'),
    // Two files in one package, plus a test that importing the package cannot reach.
    file('internal/store/store.go', 'package store\n\nvar Name = "store"\n'),
    file('internal/store/query.go', 'package store\n\nfunc Query() {}\n'),
    file('internal/store/store_test.go', 'package store\n\nfunc TestName(t *testing.T) {}\n'),
  ], { projectName: 'shop', revision: 20 });

  assert.deepEqual(dependenciesOf(snapshot, 'cmd/api'), ['internal/store']);
  const edge = snapshot.architecture.edges.find((candidate) => candidate.kind === 'imports');
  assert.ok(edge, 'the import must produce an edge');
  assert.deepEqual(edge.metadata?.Sources, ['cmd/api/main.go']);
});

test('the Go standard library is not a dependency, and a module is named in full', () => {
  const snapshot = analyzeWorkspace([
    file('go.mod', 'module example.com/shop\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n'),
    file('cmd/api/main.go', `package main

import (
\t"fmt"
\t"net/http"

\t"github.com/gin-gonic/gin/binding"
\t"golang.org/x/sync/errgroup"
\t"gopkg.in/yaml.v3"
)

func main() { fmt.Println(http.StatusOK, binding.JSON, errgroup.Group{}, yaml.Marshal) }
`),
  ], { projectName: 'shop', revision: 21 });

  assert.deepEqual(externalsOf(snapshot), [
    // Three segments is where a module path ends, and a shorter one keeps what it has.
    'github.com/gin-gonic/gin',
    'golang.org/x/sync',
    'gopkg.in/yaml.v3',
  ], 'the standard library must not be filed as a dependency');
});

test('each Go module in a repository resolves against its own path', () => {
  const snapshot = analyzeWorkspace([
    file('services/api/go.mod', 'module example.com/api\n'),
    file('services/worker/go.mod', 'module example.com/worker\n'),
    file('services/api/handler/handler.go', 'package handler\n\nfunc New() {}\n'),
    file('services/worker/main.go', 'package main\n\nimport "example.com/api/handler"\n\nfunc main() { handler.New() }\n'),
  ], { projectName: 'mono', revision: 22 });

  // Each service has its own `go.mod`, so the modules worth drawing are the
  // packages inside them rather than the two directories they live in.
  assert.deepEqual(dependenciesOf(snapshot, 'services/worker'), ['services/api/handler']);
});

test('a module boundary is read from where its project begins', () => {
  const snapshot = analyzeWorkspace([
    file('backend/go.mod', 'module example.com/shop\n'),
    file('backend/cmd/api/main.go', 'package main\n\nimport "example.com/shop/internal/store"\n\nfunc main() { _ = store.Name }\n'),
    file('backend/internal/store/store.go', 'package store\n\nvar Name = "s"\n'),
    file('client/pubspec.yaml', 'name: shop_client\n'),
    file('client/lib/main.dart', "import 'data/api.dart';\nvoid main() {}\n"),
    file('client/lib/data/api.dart', 'class Api {}\n'),
  ], { projectName: 'mono', revision: 36 });

  const modules = snapshot.architecture.nodes
    .filter((node) => node.kind === 'module')
    .map((node) => node.label)
    .sort();
  // Without the manifests these all collapse to `backend` and `client`, and the
  // structure inside each project — which is the whole diagram — disappears.
  assert.deepEqual(modules, ['backend/cmd/api', 'backend/internal/store', 'client/lib', 'client/lib/data']);
  assert.deepEqual(dependenciesOf(snapshot, 'backend/cmd/api'), ['backend/internal/store']);
  assert.deepEqual(dependenciesOf(snapshot, 'client/lib'), ['client/lib/data']);
});

test('a single-project repository keeps the boundaries it always had', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/index.ts', "export {};"),
    file('src/domain/user.ts', 'export interface User { id: string }'),
    file('apps/web/main.ts', 'export {};'),
  ], { projectName: 'single', revision: 37 });

  const modules = snapshot.architecture.nodes
    .filter((node) => node.kind === 'module')
    .map((node) => node.label)
    .sort();
  assert.deepEqual(modules, ['apps/web', 'src', 'src/domain']);
});

test('a Swift target is a module, and the platform is not a dependency', () => {
  const snapshot = analyzeWorkspace([
    file('Package.swift', '// swift-tools-version:5.9\nimport PackageDescription\n'),
    file('Sources/App/main.swift', `import Foundation
import SwiftUI
import Alamofire
import Models

struct App {}
`),
    file('Sources/Models/User.swift', 'import Foundation\n\npublic struct User {}\n'),
  ], { projectName: 'swift', revision: 38 });

  assert.deepEqual(dependenciesOf(snapshot, 'Sources/App'), ['Alamofire', 'Sources/Models']);
  // `PackageDescription` is SwiftPM's own module, not something to depend on.
  assert.deepEqual(externalsOf(snapshot), ['Alamofire']);
});

test('a C include is resolved against the file and the include tree', () => {
  const snapshot = analyzeWorkspace([
    file('CMakeLists.txt', 'project(engine)\n'),
    file('include/engine/mesh.h', '#pragma once\nstruct Mesh {};\n'),
    file('src/render/renderer.cpp', `#include <vector>
#include <sys/stat.h>
#include <boost/asio.hpp>
// #include <should/not/count.hpp>
#include "engine/mesh.h"
#include "shader.h"

void render() {}
`),
    file('src/render/shader.h', '#pragma once\nvoid compile();\n'),
  ], { projectName: 'engine', revision: 39 });

  // `"engine/mesh.h"` is on the include path; `"shader.h"` sits beside the file.
  assert.deepEqual(dependenciesOf(snapshot, 'src/render'), ['boost', 'include/engine']);
  // The platform headers are not dependencies, and neither is a commented one.
  assert.deepEqual(externalsOf(snapshot), ['boost']);
});

test('a Dart import resolves through the package its pubspec declares', () => {
  const snapshot = analyzeWorkspace([
    file('pubspec.yaml', 'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.4.0\n'),
    file('lib/main.dart', "import 'package:shop_app/data/repository.dart';\nvoid main() {}\n"),
    file('lib/data/repository.dart', "class Repository {}\n"),
  ], { projectName: 'shop_app', revision: 23 });

  assert.deepEqual(dependenciesOf(snapshot, 'lib'), ['lib/data']);
});

test('a Dart sibling import has no leading dot and still resolves', () => {
  const snapshot = analyzeWorkspace([
    file('pubspec.yaml', 'name: shop_app\n'),
    file('lib/app.dart', "import 'features/cart.dart';\nimport 'dart:async';\nclass App {}\n"),
    file('lib/features/cart.dart', 'class Cart {}\n'),
  ], { projectName: 'shop_app', revision: 24 });

  assert.deepEqual(dependenciesOf(snapshot, 'lib'), ['lib/features']);
  // `dart:async` is the SDK, so it is neither a dependency nor an unresolved import.
  assert.deepEqual(externalsOf(snapshot), []);
  assert.equal(snapshot.diagnostics.length, 0);
});

test('a Dart dependency is named by its package, and Flutter is recognised', () => {
  const snapshot = analyzeWorkspace([
    file('pubspec.yaml', `name: shop_app
dependencies:
  flutter:
    sdk: flutter
  dio: ^5.4.0
  flutter_riverpod: ^2.4.0
  drift: ^2.14.0
`),
    file('lib/main.dart', `import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart';
void main() {}
`),
  ], { projectName: 'shop_app', revision: 25 });

  assert.deepEqual(externalsOf(snapshot), ['dio', 'drift', 'flutter']);
  for (const technology of ['Dart', 'Drift', 'Flutter', 'Riverpod']) {
    assert.ok(snapshot.technologies.includes(technology), `expected ${technology} in ${snapshot.technologies.join(', ')}`);
  }
});

test('a Go framework is read from the module file rather than guessed', () => {
  const snapshot = analyzeWorkspace([
    file('go.mod', 'module example.com/shop\n\nrequire (\n\tgithub.com/labstack/echo/v4 v4.11.0\n\tgorm.io/gorm v1.25.0\n)\n'),
    file('main.go', 'package main\n\nfunc main() {}\n'),
  ], { projectName: 'shop', revision: 26 });

  // The major version is part of a Go module path, so the match is a prefix.
  for (const technology of ['Echo', 'GORM', 'Go', 'Go modules']) {
    assert.ok(snapshot.technologies.includes(technology), `expected ${technology} in ${snapshot.technologies.join(', ')}`);
  }
});

test('a Python import is a dependency only when it is not the standard library', () => {
  const snapshot = analyzeWorkspace([
    file('app/views.py', `import os
import sys
from datetime import datetime
from collections import OrderedDict
from django.db import models
from rest_framework import serializers
import requests
from .models import User
`),
    file('app/models.py', 'class User: pass\n'),
  ], { projectName: 'py', revision: 30 });

  assert.deepEqual(externalsOf(snapshot), ['django', 'requests', 'rest_framework']);
});

test('a JVM import drops the type it names and keeps the library', () => {
  const snapshot = analyzeWorkspace([
    file('src/main/java/com/shop/Api.java', `package com.shop;

import java.util.List;
import javax.annotation.Nullable;
import kotlin.Unit;
import org.springframework.boot.SpringApplication;
import com.google.common.collect.Lists;
import org.junit.Test;

public class Api {}
`),
  ], { projectName: 'jvm', revision: 31 });

  assert.deepEqual(externalsOf(snapshot), [
    // `Lists`, `SpringApplication` and `Test` are types, not artifacts.
    'com.google.common',
    'org.junit',
    'org.springframework.boot',
  ]);
});

test('a C# using of the framework is not a dependency', () => {
  const snapshot = analyzeWorkspace([
    file('src/Api.cs', `using System;
using System.Collections.Generic;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;
using Serilog;

namespace Shop { public class Api {} }
`),
  ], { projectName: 'cs', revision: 32 });

  assert.deepEqual(externalsOf(snapshot), ['Microsoft.Extensions', 'Newtonsoft.Json', 'Serilog']);
});

test('a Rust crate is found, which no `use` outside the crate ever was', () => {
  const snapshot = analyzeWorkspace([
    file('src/main.rs', `use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tokio::runtime::Runtime;
use crate::store::Store;
extern crate regex;

mod store;
fn main() {}
`),
    file('src/store.rs', 'pub struct Store;\n'),
  ], { projectName: 'rs', revision: 33 });

  assert.deepEqual(externalsOf(snapshot), ['regex', 'serde', 'tokio']);
  // `crate::store` is this crate's own module and stays a local relationship.
  assert.equal(externalsOf(snapshot).includes('crate'), false);
});

test('a Ruby require of the standard library is not a gem', () => {
  const snapshot = analyzeWorkspace([
    file('app/api.rb', `require 'json'
require 'net/http'
require 'rails'
require 'active_support/core_ext'
require_relative 'store'
`),
    file('app/store.rb', 'class Store; end\n'),
  ], { projectName: 'rb', revision: 34 });

  assert.deepEqual(externalsOf(snapshot), ['active_support', 'rails']);
});

test('a PHP use is named by the vendor namespace it publishes under', () => {
  const snapshot = analyzeWorkspace([
    file('src/Api.php', `<?php
namespace Shop;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\Routing\\Router;
use Doctrine\\ORM\\EntityManager;
`),
  ], { projectName: 'php', revision: 35 });

  assert.deepEqual(externalsOf(snapshot), ['Doctrine\\ORM', 'Symfony\\Component']);
});

function findByPath(node: StructureNode, path: string): StructureNode | undefined {
  if (node.path === path) {
    return node;
  }
  for (const child of node.children) {
    const found = findByPath(child, path);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findFile(node: StructureNode, path: string): StructureNode {
  const found = findByPath(node, path);
  assert.ok(found, `no structure node for ${path}`);
  return found;
}

test('measures every file the Files view ranks by', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/main.ts', "import { load } from './api/client';\nexport const run = () => load();\n"),
    file('src/api/client.ts', 'export const load = () => 1;\n'),
  ], { projectName: 'demo', revision: 1 });

  const main = findFile(snapshot.structure, 'src/main.ts');
  assert.equal(main.lines, 2);
  assert.equal(main.imports, 1);
  assert.equal(main.importedBy, 0);
  assert.ok(main.bytes && main.bytes > 0);

  const client = findFile(snapshot.structure, 'src/api/client.ts');
  assert.equal(client.importedBy, 1);
  assert.equal(client.imports, 0);

  // Folders are not files and carry none of it.
  const src = snapshot.structure.children.find((node) => node.label === 'src');
  assert.equal(src?.lines, undefined);
  assert.equal(src?.importedBy, undefined);
});

test('a named-import list spread over several lines is still an import', () => {
  const snapshot = analyzeWorkspace([
    file('src/main.ts', "import {\n  load,\n  type Result,\n} from './api/client';\nexport const run = () => load();\n"),
    file('src/api/client.ts', 'export const load = () => 1;\nexport type Result = number;\n'),
  ], { projectName: 'demo', revision: 1 });

  assert.equal(findFile(snapshot.structure, 'src/api/client.ts').importedBy, 1);
  assert.equal(findFile(snapshot.structure, 'src/main.ts').imports, 1);
});

test('a clause without a `from` does not swallow the next statement’s specifier', () => {
  const snapshot = analyzeWorkspace([
    file('src/main.ts', "import './styles.css';\nimport { load } from './api/client';\nexport const run = () => load();\n"),
    file('src/styles.css', 'body { margin: 0 }'),
    file('src/api/client.ts', 'export const load = () => 1;\n'),
  ], { projectName: 'demo', revision: 1 });

  assert.equal(findFile(snapshot.structure, 'src/api/client.ts').importedBy, 1);
  // Two specifiers were written, and each resolved to the file it named.
  assert.equal(findFile(snapshot.structure, 'src/main.ts').imports, 2);
});

test('sorts files into the roles the Files view separates', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/main.ts', 'export const run = () => 1;'),
    file('src/features/user.ts', 'export const user = 1;'),
    file('src/features/user.test.ts', "import { user } from './user';\nexport default user;"),
    file('tests/integration.ts', 'export default 1;'),
    file('esbuild.mjs', 'export default 1;'),
    file('vite.config.ts', 'export default {};'),
    file('README.md', '# Demo'),
  ], { projectName: 'demo', revision: 1 });

  assert.equal(findFile(snapshot.structure, 'src/main.ts').role, 'entry');
  assert.equal(findFile(snapshot.structure, 'src/features/user.ts').role, 'source');
  assert.equal(findFile(snapshot.structure, 'src/features/user.test.ts').role, 'test');
  // A whole directory of tests counts, not only the `.test.` suffix.
  assert.equal(findFile(snapshot.structure, 'tests/integration.ts').role, 'test');
  assert.equal(findFile(snapshot.structure, 'esbuild.mjs').role, 'config');
  assert.equal(findFile(snapshot.structure, 'vite.config.ts').role, 'config');
  assert.equal(findFile(snapshot.structure, 'package.json').role, 'config');
  assert.equal(findFile(snapshot.structure, 'README.md').role, 'other');
});

test('an entry name deep inside the tree is an ordinary source file', () => {
  const snapshot = analyzeWorkspace([
    file('package.json', '{}'),
    file('src/index.ts', 'export const run = () => 1;'),
    file('src/features/user/index.ts', 'export const user = 1;'),
  ], { projectName: 'demo', revision: 1 });

  assert.equal(findFile(snapshot.structure, 'src/index.ts').role, 'entry');
  assert.equal(findFile(snapshot.structure, 'src/features/user/index.ts').role, 'source');
});
