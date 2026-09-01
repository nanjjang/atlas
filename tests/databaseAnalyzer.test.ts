import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDatabase } from '../src/databaseAnalyzer';
import type { DiagramNode, WorkspaceFile } from '../src/model';

function file(path: string, content: string): WorkspaceFile {
  return { path, content, size: new TextEncoder().encode(content).byteLength };
}

function fieldsOf(node: DiagramNode | undefined): string[] {
  const fields = node?.metadata.Fields;
  return Array.isArray(fields) ? fields : [];
}

function nodeNamed(nodes: DiagramNode[], label: string): DiagramNode | undefined {
  return nodes.find((node) => node.label === label);
}

test('entity metadata carries no duplicate or internal keys', () => {
  const { graph } = analyzeDatabase([
    file('prisma/schema.prisma', 'model User {\n  id Int @id\n  email String @unique\n}'),
  ]);

  const user = nodeNamed(graph.nodes, 'User');
  assert.ok(user);
  const keys = Object.keys(user.metadata);
  assert.equal(new Set(keys).size, keys.length, 'metadata keys must be unique');
  assert.equal(keys.includes('fields'), false, 'the lowercase duplicate of Fields must be gone');
  for (const key of keys) {
    assert.match(key, /^[A-Z]/, `metadata key ${key} is shown as a UI label, so it must read as one`);
  }
  assert.deepEqual(user.metadata['Primary key'], ['id']);
  assert.deepEqual(user.metadata['Unique fields'], ['email']);
  assert.equal(user.metadata.Namespace, undefined, 'empty values must be dropped, not shown blank');
});

test('a table level primary key wins over the per-field guess', () => {
  const { graph } = analyzeDatabase([
    file('db/schema.sql', `
      CREATE TABLE enrollment (
        student_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        PRIMARY KEY (student_id, course_id)
      );
    `),
  ]);

  const enrollment = graph.nodes[0];
  assert.ok(enrollment);
  assert.deepEqual(enrollment.metadata['Primary key'], ['student_id', 'course_id']);
});

test('SQL comments never produce phantom tables', () => {
  const { graph } = analyzeDatabase([
    file('db/schema.sql', `
      -- CREATE TABLE ghost_line (id INT);
      /* CREATE TABLE ghost_block (id INT); */
      CREATE TABLE real_table (id INTEGER PRIMARY KEY);
    `),
  ]);

  assert.equal(graph.nodes.length, 1);
  assert.ok(nodeNamed(graph.nodes, 'real_table'));
});

test('SQL quoted and bracketed identifiers are unwrapped', () => {
  const { graph } = analyzeDatabase([
    file('db/schema.sql', `
      CREATE TABLE "order" (
        "id" INTEGER PRIMARY KEY,
        "user id" INTEGER NOT NULL,
        CONSTRAINT fk_user FOREIGN KEY ("user id") REFERENCES "app_user" ("id")
      );
      CREATE TABLE "app_user" ("id" INTEGER PRIMARY KEY);
    `),
  ]);

  assert.ok(nodeNamed(graph.nodes, 'order'), 'a quoted table name must lose its quotes');
  assert.ok(fieldsOf(nodeNamed(graph.nodes, 'order')).some((field) => field.startsWith('user id')));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.kind, 'foreign-key');
  assert.equal(graph.edges[0]?.confidence, 'exact');
});

test('an inline SQL REFERENCES clause is a foreign key too', () => {
  const { graph } = analyzeDatabase([
    file('db/schema.sql', `
      CREATE TABLE authors (id INTEGER PRIMARY KEY);
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        author_id INTEGER REFERENCES authors(id)
      );
    `),
  ]);

  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.metadata?.['Local fields']?.includes('author_id'), true);
});

test('TypeORM decorators are recognized through import aliases and namespaces', () => {
  const aliased = analyzeDatabase([
    file('src/user.entity.ts', `
      import { Entity as Table, Column as Field, PrimaryGeneratedColumn as Pk } from 'typeorm';
      @Table('users')
      export class User {
        @Pk() id!: number;
        @Field() email!: string;
      }
    `),
  ]);
  const user = nodeNamed(aliased.graph.nodes, 'User');
  assert.ok(user, 'an aliased @Entity must still be detected');
  assert.equal(fieldsOf(user).length, 2);

  const namespaced = analyzeDatabase([
    file('src/post.entity.ts', `
      import * as orm from 'typeorm';
      @orm.Entity('posts')
      export class Post {
        @orm.PrimaryGeneratedColumn() id!: number;
      }
    `),
  ]);
  assert.ok(nodeNamed(namespaced.graph.nodes, 'Post'), 'a namespaced @orm.Entity must be detected');
});

test('a class decorated by something other than TypeORM is not an entity', () => {
  const { graph } = analyzeDatabase([
    file('src/service.ts', `
      import { Injectable } from '@nestjs/common';
      @Injectable()
      export class UserService {}
    `),
  ]);

  assert.equal(graph.nodes.length, 0);
});

test('JPA entities resolve relations through the declared package', () => {
  const { graph } = analyzeDatabase([
    file('src/main/java/Order.java', `
      package com.demo.shop;
      import jakarta.persistence.*;
      @Entity
      @Table(name = "orders")
      public class Order {
        @Id private Long id;
        @ManyToOne private Customer customer;
      }
    `),
    file('src/main/java/Customer.java', `
      package com.demo.shop;
      import jakarta.persistence.*;
      @Entity
      public class Customer {
        @Id private Long id;
      }
    `),
  ]);

  const order = nodeNamed(graph.nodes, 'Order');
  assert.ok(order);
  assert.equal(order.metadata['Physical name'], 'orders');
  assert.equal(order.metadata.Package, 'com.demo.shop');
  const relation = graph.edges.find((edge) => edge.from === order.id);
  assert.ok(relation, 'the @ManyToOne must produce an edge');
  const customer = nodeNamed(graph.nodes, 'Customer');
  assert.ok(customer);
  assert.equal(relation.to, customer.id, 'the relation must reach the real entity, not a placeholder');
  // A target read off the field type is an inference; only an explicit
  // targetEntity is stated outright.
  assert.equal(relation.confidence, 'inferred');
});

test('an explicit JPA targetEntity is reported as exact rather than inferred', () => {
  const { graph } = analyzeDatabase([
    file('src/main/java/Order.java', `
      package com.demo.shop;
      import jakarta.persistence.*;
      @Entity
      public class Order {
        @Id private Long id;
        @ManyToOne(targetEntity = Customer.class) private Object customer;
      }
    `),
    file('src/main/java/Customer.java', `
      package com.demo.shop;
      import jakarta.persistence.*;
      @Entity
      public class Customer {
        @Id private Long id;
      }
    `),
  ]);

  const relation = graph.edges[0];
  assert.ok(relation);
  assert.equal(relation.confidence, 'exact');
});

test('Django models expose their relations and table mapping', () => {
  const { graph } = analyzeDatabase([
    file('app/models.py', `
      from django.db import models

      class Team(models.Model):
          name = models.CharField(max_length=100)

          class Meta:
              db_table = "teams"

      class Member(models.Model):
          team = models.ForeignKey(Team, on_delete=models.CASCADE)
          profile = models.OneToOneField("Profile", on_delete=models.CASCADE)

      class Profile(models.Model):
          bio = models.TextField()
    `),
  ]);

  const team = nodeNamed(graph.nodes, 'Team');
  assert.ok(team);
  assert.equal(team.metadata['Physical name'], 'teams');
  assert.equal(team.metadata.ORM, 'Django');
  assert.equal(graph.edges.length, 2, 'the ForeignKey and the OneToOneField are both relations');
  assert.ok(graph.edges.every((edge) => edge.confidence !== 'unresolved'), 'a string target must resolve');
});

test('an unresolvable relation target becomes a placeholder plus a diagnostic', () => {
  const { graph, diagnostics } = analyzeDatabase([
    file('app/models.py', `
      from django.db import models

      class Member(models.Model):
          team = models.ForeignKey("Missing", on_delete=models.CASCADE)
    `),
  ]);

  const placeholder = graph.nodes.find((node) => node.kind === 'unresolved-entity');
  assert.ok(placeholder, 'the unknown target must still appear on the diagram');
  assert.equal(placeholder.confidence, 'unresolved');
  assert.equal(placeholder.metadata['Unresolved target'], 'Missing');
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'DB_UNRESOLVED_RELATION'));
});

test('entities from different projects are not merged into one schema', () => {
  const { graph } = analyzeDatabase([
    file('services/billing/package.json', '{}'),
    file('services/billing/src/user.entity.ts', "import { Entity, PrimaryGeneratedColumn } from 'typeorm';\n@Entity() export class User { @PrimaryGeneratedColumn() id!: number; }"),
    file('services/crm/package.json', '{}'),
    file('services/crm/src/user.entity.ts', "import { Entity, PrimaryGeneratedColumn } from 'typeorm';\n@Entity() export class User { @PrimaryGeneratedColumn() id!: number; }"),
  ]);

  const users = graph.nodes.filter((node) => node.label === 'User');
  assert.equal(users.length, 2, 'each service keeps its own User entity');
  assert.equal(new Set(users.map((node) => node.group)).size, 2, 'and its own schema group');
});

test('analysis is deterministic regardless of file order', () => {
  const files = [
    file('prisma/schema.prisma', 'model User {\n  id Int @id\n  posts Post[]\n}\nmodel Post {\n  id Int @id\n  authorId Int\n  author User @relation(fields: [authorId], references: [id])\n}'),
    file('db/schema.sql', 'CREATE TABLE t (id INTEGER PRIMARY KEY);'),
    file('app/models.py', 'from django.db import models\nclass Team(models.Model):\n    name = models.CharField(max_length=1)'),
  ];

  const forward = analyzeDatabase(files);
  const reversed = analyzeDatabase([...files].reverse());
  assert.deepEqual(forward.graph, reversed.graph);
  assert.deepEqual(forward.diagnostics, reversed.diagnostics);
});

test('a workspace without any schema yields an empty graph, not invented tables', () => {
  const { graph, diagnostics } = analyzeDatabase([
    file('src/index.ts', "export const start = (): string => 'CREATE TABLE not_a_table (id INT);';"),
    file('README.md', '# CREATE TABLE docs (id INT);'),
  ]);

  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(diagnostics, []);
  assert.match(graph.emptyMessage, /No supported database schemas/);
});

/** The relation edges out of one entity, as `Target: label` for readability. */
function relationsFrom(
  graph: ReturnType<typeof analyzeDatabase>['graph'],
  label: string,
): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const from = nodeNamed(graph.nodes, label);
  return graph.edges
    .filter((edge) => edge.from === from?.id)
    .map((edge) => `${byId.get(edge.to) ?? '?'}: ${edge.label ?? ''}`)
    .sort();
}

const GORM_MODELS = `package model

import (
	"time"

	"gorm.io/gorm"
)

type User struct {
	gorm.Model
	Name      string \`gorm:"size:255;not null"\`
	Email     string \`gorm:"uniqueIndex;column:email_address"\`
	LastLogin *time.Time
	Posts     []Post \`gorm:"foreignKey:AuthorID"\`
}

func (User) TableName() string { return "users" }

type Post struct {
	ID       uint   \`gorm:"primaryKey"\`
	Title    string \`gorm:"not null"\`
	AuthorID uint
	Author   User
}
`;

test('a Go struct is only a table when the file maps it with GORM', () => {
  const { graph } = analyzeDatabase([
    file('internal/model/user.go', GORM_MODELS),
    // Same shape, no ORM: a request payload is not a table.
    file('internal/api/dto.go', 'package api\n\ntype CreateUserRequest struct {\n\tName string\n}\n'),
  ]);

  assert.deepEqual(graph.nodes.map((node) => node.label).sort(), ['Post', 'User']);
});

test('GORM columns follow the tag, and the embedded model brings its own', () => {
  const { graph } = analyzeDatabase([file('internal/model/user.go', GORM_MODELS)]);
  const user = nodeNamed(graph.nodes, 'User');
  assert.ok(user);

  assert.equal(user.metadata['Physical name'], 'users', 'TableName() is what the table is called');
  assert.equal(user.metadata['Physical name confidence'], 'exact');
  const fields = fieldsOf(user);
  // `gorm.Model` is four columns the struct never spells out.
  assert.ok(fields.some((entry) => entry.startsWith('ID ') && entry.includes('PK')));
  assert.ok(fields.some((entry) => entry.startsWith('DeletedAt')));
  assert.ok(fields.some((entry) => entry.includes('email_address') && entry.includes('UNIQUE')));
  assert.ok(fields.some((entry) => entry.startsWith('Name ') && entry.includes('NOT NULL')));
});

/** The markers a formatted field carries, e.g. `[PK, NOT NULL]` to `['PK', 'NOT NULL']`. */
function markersOf(field: string): string[] {
  return (/\[([^\]]*)\]\s*$/.exec(field)?.[1] ?? '')
    .split(',')
    .map((marker) => marker.trim())
    .filter(Boolean);
}

test('a GORM key is never nullable, whatever the tag left unsaid', () => {
  const { graph } = analyzeDatabase([file('internal/model/user.go', GORM_MODELS)]);
  const key = fieldsOf(nodeNamed(graph.nodes, 'Post')).find((entry) => entry.startsWith('ID '));
  assert.ok(key, 'Post must have an ID column');
  // `NOT NULL` contains `NULL`, so the markers are compared whole.
  assert.equal(markersOf(key).includes('NULL'), false, `the key was reported nullable: ${key}`);
  assert.ok(markersOf(key).includes('PK'), `the key lost its marker: ${key}`);
});

test('a GORM foreign key is reported on the side that holds it', () => {
  const { graph } = analyzeDatabase([file('internal/model/user.go', GORM_MODELS)]);
  // `Author User` on Post: the key is Post's, and the convention names it.
  assert.deepEqual(relationsFrom(graph, 'Post'), ['User: belongs-to: AuthorID → ?']);
  // `Posts []Post`: the key is Post's too, so User claims none of its own.
  assert.deepEqual(relationsFrom(graph, 'User'), ['Post: has-many: Posts']);
});

test('a GORM key the struct does not declare is not invented', () => {
  const { graph } = analyzeDatabase([
    file('m.go', 'package m\n\nimport "gorm.io/gorm"\n\nvar _ = gorm.Model{}\n\n'
      + 'type Team struct {\n\tID uint\n\tOwner Person\n}\n\n'
      + 'type Person struct {\n\tID uint\n\tTeamID uint\n}\n'),
  ]);
  // There is no `OwnerID` on Team, so the guess is dropped rather than shown.
  assert.deepEqual(relationsFrom(graph, 'Team'), ['Person: belongs-to: Owner']);
});

const DRIFT_TABLES = `import 'package:drift/drift.dart';

class TodoItems extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get title => text().withLength(min: 1, max: 50)();
  TextColumn get body => text().named('description').nullable()();
  IntColumn get category => integer().nullable().references(Categories, #id)();
  @override
  String get tableName => 'todos';
}

class Categories extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get description => text().unique()();
}

class Users extends Table {
  TextColumn get email => text()();
  TextColumn get name => text()();
  @override
  Set<Column> get primaryKey => {email};
}
`;

test('a drift column is read from the chain that builds it', () => {
  const { graph } = analyzeDatabase([file('lib/data/tables.dart', DRIFT_TABLES)]);
  const todos = nodeNamed(graph.nodes, 'TodoItems');
  assert.ok(todos);

  assert.equal(todos.metadata['Physical name'], 'todos');
  const fields = fieldsOf(todos);
  assert.ok(fields.some((entry) => entry.startsWith('id:') && entry.includes('PK')), fields.join(' | '));
  assert.ok(fields.some((entry) => entry.includes('description')), '`named()` renames the column');
  assert.ok(
    fields.some((entry) => entry.startsWith('body') && markersOf(entry).includes('NULL')),
    fields.join(' | '),
  );
});

test('a drift table with no override is named after its class in snake case', () => {
  const { graph } = analyzeDatabase([file('lib/data/tables.dart', DRIFT_TABLES)]);
  assert.equal(nodeNamed(graph.nodes, 'Categories')?.metadata['Physical name'], 'categories');
});

test('an explicit drift primary key overrides the auto-increment guess', () => {
  const { graph } = analyzeDatabase([file('lib/data/tables.dart', DRIFT_TABLES)]);
  const users = fieldsOf(nodeNamed(graph.nodes, 'Users'));
  assert.ok(users.some((entry) => entry.startsWith('email') && entry.includes('PK')));
  assert.equal(users.some((entry) => entry.startsWith('name') && entry.includes('PK')), false);
});

test('a drift reference resolves to the table it names', () => {
  const { graph, diagnostics } = analyzeDatabase([file('lib/data/tables.dart', DRIFT_TABLES)]);
  assert.deepEqual(relationsFrom(graph, 'TodoItems'), ['Categories: foreign-key: category → id']);
  assert.equal(graph.nodes.some((node) => node.kind === 'unresolved-entity'), false);
  assert.deepEqual(diagnostics, []);
});

test('an entity whose table is its own name in another case is not ambiguous with itself', () => {
  // The aliases an entity answers to are folded to one case; deduplicating
  // before folding let `Categories` and `categories` count as two entities.
  const { graph, diagnostics } = analyzeDatabase([
    file('schema.sql', 'CREATE TABLE categories (id integer PRIMARY KEY);\n'
      + 'CREATE TABLE items (id integer PRIMARY KEY, category_id integer REFERENCES categories(id));\n'),
  ]);
  assert.equal(diagnostics.some((entry) => entry.code === 'DB_AMBIGUOUS_RELATION'), false);
  assert.deepEqual(relationsFrom(graph, 'items'), ['categories: foreign-key: category_id → id']);
});

function edgeLabels(graph: { edges: Array<{ label?: string }> }): string[] {
  return graph.edges.map((edge) => edge.label ?? '').sort();
}

test('a Mongoose schema becomes a collection, and the schema it stores becomes an embedded document', () => {
  const { graph } = analyzeDatabase([
    file('package.json', '{"dependencies":{"mongoose":"^8.0.0"}}'),
    file('src/user.ts', `
      import mongoose, { Schema, model } from 'mongoose';

      const addressSchema = new Schema({
        street: String,
        city: { type: String, required: true },
      });

      const userSchema = new Schema({
        email: { type: String, required: true, unique: true },
        address: addressSchema,
        posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
      }, { collection: 'people' });

      export const User = model('User', userSchema);
    `),
  ]);

  const user = nodeNamed(graph.nodes, 'User');
  assert.ok(user);
  assert.equal(user.kind, 'collection');
  // The option named the collection, so the physical name is read rather than guessed.
  assert.equal(user.metadata['Physical name'], 'people');
  assert.equal(user.metadata['Physical name confidence'], 'exact');
  assert.equal(user.metadata.Store, 'MongoDB');
  assert.match(String(user.metadata['Schema enforcement']), /does not enforce|not match/);

  const address = nodeNamed(graph.nodes, 'Address');
  assert.ok(address);
  // Nothing registers a model for it, so it exists only inside another document.
  assert.equal(address.kind, 'embedded');

  assert.deepEqual(edgeLabels(graph), ['embeds: address', 'references many: posts → _id']);
  assert.equal(graph.edges.find((edge) => edge.kind === 'embeds')?.label, 'embeds: address');
});

test('a Mongoose collection name is pluralized only when nothing declared one', () => {
  const { graph } = analyzeDatabase([
    file('package.json', '{}'),
    file('src/post.js', `
      const mongoose = require('mongoose');
      const postSchema = new mongoose.Schema({ title: String });
      module.exports = mongoose.model('Post', postSchema);
    `),
  ]);

  const post = nodeNamed(graph.nodes, 'Post');
  assert.ok(post);
  assert.equal(post.metadata['Physical name'], 'posts');
  assert.equal(post.metadata['Physical name confidence'], 'inferred');
});

test('a nested document literal is flattened rather than lost', () => {
  const { graph } = analyzeDatabase([
    file('package.json', '{}'),
    file('src/user.ts', `
      import { Schema, model } from 'mongoose';
      const userSchema = new Schema({
        profile: { bio: String, links: [String] },
      });
      export default model('User', userSchema);
    `),
  ]);

  assert.deepEqual(fieldsOf(nodeNamed(graph.nodes, 'User')), [
    'profile: object',
    'profile.bio: String',
    'profile.links: String[]',
  ]);
});

test('a Typegoose class without a model of its own is an embedded document', () => {
  const { graph } = analyzeDatabase([
    file('package.json', '{}'),
    file('src/models.ts', `
      import { prop, modelOptions, getModelForClass, Ref } from '@typegoose/typegoose';

      class Address {
        @prop({ required: true })
        public city!: string;
      }

      @modelOptions({ schemaOptions: { collection: 'people' } })
      export class User {
        @prop({ required: true, unique: true })
        public email!: string;

        @prop({ ref: () => Post })
        public posts?: Ref<Post>[];

        @prop({ type: () => Address })
        public address?: Address;
      }

      export class Post {
        @prop({ required: true })
        public title!: string;
      }

      export const UserModel = getModelForClass(User);
      export const PostModel = getModelForClass(Post);
    `),
  ]);

  assert.equal(nodeNamed(graph.nodes, 'User')?.kind, 'collection');
  assert.equal(nodeNamed(graph.nodes, 'Post')?.kind, 'collection');
  assert.equal(nodeNamed(graph.nodes, 'Address')?.kind, 'embedded');
  assert.deepEqual(edgeLabels(graph), ['embeds: address', 'references many: posts → _id']);
});

test('MongoEngine reads its collection out of meta and its base class as the document role', () => {
  const { graph } = analyzeDatabase([
    file('requirements.txt', 'mongoengine==0.28'),
    file('app/models.py', `
from mongoengine import Document, EmbeddedDocument, StringField, ReferenceField, ListField, EmbeddedDocumentField

class Address(EmbeddedDocument):
    city = StringField(required=True)

class Post(Document):
    title = StringField(required=True)

class User(Document):
    email = StringField(required=True, unique=True, db_field='e')
    address = EmbeddedDocumentField(Address)
    posts = ListField(ReferenceField(Post))
    meta = {'collection': 'people'}
`),
  ]);

  const user = nodeNamed(graph.nodes, 'User');
  assert.ok(user);
  assert.equal(user.kind, 'collection');
  assert.equal(user.metadata['Physical name'], 'people');
  assert.deepEqual(fieldsOf(user), [
    'email -> e: StringField [UNIQUE, NOT NULL]',
    'address: EmbeddedDocumentField [RELATION]',
    'posts: ReferenceField[] [RELATION]',
  ]);
  assert.equal(nodeNamed(graph.nodes, 'Address')?.kind, 'embedded');
  assert.deepEqual(edgeLabels(graph), ['embeds: address', 'references many: posts → id']);
});

test('a Beanie annotation carrying its own equals sign is not cut in half', () => {
  const { graph } = analyzeDatabase([
    file('requirements.txt', 'beanie==1.25'),
    file('app/docs.py', `
from typing import List, Optional
from beanie import Document, Link, Indexed

class Author(Document):
    email: Indexed(str, unique=True)

class Article(Document):
    title: str
    subtitle: Optional[str] = None
    author: Link[Author]
    reviewers: List[Link[Author]]

    class Settings:
        name = "articles"
`),
  ]);

  assert.deepEqual(fieldsOf(nodeNamed(graph.nodes, 'Author')), [
    'email: Indexed(str, unique=True) [UNIQUE, NOT NULL]',
  ]);
  const article = nodeNamed(graph.nodes, 'Article');
  assert.equal(article?.metadata['Physical name'], 'articles');
  // `Settings` is a nested class, and must not be read as a document of its own.
  assert.equal(nodeNamed(graph.nodes, 'Settings'), undefined);
  assert.deepEqual(fieldsOf(article), [
    'title: str [NOT NULL]',
    'subtitle: Optional[str] [NULL]',
    'author: Link[Author] [NOT NULL, RELATION]',
    'reviewers: List[Link[Author]] [NOT NULL, RELATION]',
  ]);
});

test('Spring Data maps unannotated fields, and no statement from a method body', () => {
  const { graph } = analyzeDatabase([
    file('pom.xml', '<project/>'),
    file('src/main/java/com/demo/User.java', `
package com.demo;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.index.Indexed;
import java.util.List;

@Document(collection = "people")
public class User {
    private static final long serialVersionUID = 1L;

    @Id
    private String id;

    @Indexed(unique = true)
    private String email;

    @Field("n")
    private String name;

    private int age;

    @DBRef
    private List<Post> posts;

    public String getName() { return name; }
}
`),
    file('src/main/kotlin/com/demo/Post.kt', `
package com.demo

import org.springframework.data.annotation.Id
import org.springframework.data.mongodb.core.mapping.Document
import org.springframework.data.mongodb.core.mapping.DBRef

@Document
data class Post(
    @Id val id: String? = null,
    val title: String,
    @DBRef val author: User,
)
`),
  ]);

  // Convention-mapped fields count, `static final` constants and the contents
  // of a method body do not.
  assert.deepEqual(fieldsOf(nodeNamed(graph.nodes, 'User')), [
    'id: String [PK]',
    'email: String [UNIQUE]',
    'name -> n: String',
    'age: int',
    'posts: List<Post> [RELATION]',
  ]);
  // A Kotlin data class declares its properties in the header and has no body.
  assert.deepEqual(fieldsOf(nodeNamed(graph.nodes, 'Post')), [
    'id: String? [PK]',
    'title: String',
    'author: User [RELATION]',
  ]);
  assert.deepEqual(edgeLabels(graph), ['references many: posts → _id', 'references: author → _id']);
});

test('a document store is reported as declared rather than enforced, once per store', () => {
  const { diagnostics } = analyzeDatabase([
    file('package.json', '{}'),
    file('src/a.ts', `
      import { Schema, model } from 'mongoose';
      export default model('A', new Schema({ x: String }));
    `),
    file('src/b.ts', `
      import { Schema, model } from 'mongoose';
      export default model('B', new Schema({ y: String }));
    `),
  ]);

  const schemaless = diagnostics.filter((entry) => entry.code === 'DB_SCHEMALESS_SOURCE');
  assert.equal(schemaless.length, 1, 'one note per analysis, not one per collection');
  assert.match(schemaless[0]?.message ?? '', /Mongoose/);
});

test('a relational schema reports no schemaless note', () => {
  const { diagnostics } = analyzeDatabase([
    file('prisma/schema.prisma', 'model User {\n  id Int @id\n}'),
  ]);

  assert.equal(diagnostics.some((entry) => entry.code === 'DB_SCHEMALESS_SOURCE'), false);
});
