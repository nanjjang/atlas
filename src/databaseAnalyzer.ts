import type {
  AnalysisDiagnostic,
  DiagramEdge,
  DiagramGraph,
  DiagramNode,
  ResolutionConfidence,
  SourceRef,
  WorkspaceFile,
} from './model';

/**
 * Where a declaration was read from.
 *
 * The last six are document stores. Nothing there enforces a schema, so what
 * these parsers read is the shape the application code agrees to keep — which
 * is the only schema such a database has, and worth drawing for exactly that
 * reason, as long as the diagram does not pretend it was read off a catalogue.
 */
type SchemaSource =
  | 'prisma' | 'sql' | 'typeorm' | 'jpa' | 'django' | 'gorm' | 'drift'
  | 'mongoose' | 'dynamoose' | 'typegoose' | 'mongoengine' | 'beanie' | 'spring-mongo';

/** The document stores, whose schema lives in application code and nowhere else. */
const SCHEMALESS_SOURCES: ReadonlySet<SchemaSource> = new Set<SchemaSource>([
  'mongoose', 'dynamoose', 'typegoose', 'mongoengine', 'beanie', 'spring-mongo',
]);

interface FieldFact {
  name: string;
  type: string;
  line: number;
  columnName?: string;
  primary?: boolean;
  unique?: boolean;
  nullable?: boolean;
  generated?: boolean;
  defaultValue?: string;
  relation?: boolean;
  inferred?: boolean;
}

interface RelationFact {
  fieldName: string;
  targetName: string;
  relationKind: string;
  line: number;
  confidence: ResolutionConfidence;
  localFields: string[];
  targetFields: string[];
  relationName?: string;
  inverseField?: string;
  owning?: boolean;
  onDelete?: string;
  onUpdate?: string;
  joinTable?: string;
}

interface EntityFact {
  variant: string;
  sourceKind: SchemaSource;
  file: string;
  line: number;
  kind: 'table' | 'entity' | 'view' | 'enum' | 'abstract-entity' | 'collection' | 'embedded';
  logicalName: string;
  qualifiedName: string;
  physicalName: string;
  physicalNameConfidence: ResolutionConfidence;
  namespace?: string;
  /**
   * Further names a relation may address this entity by. A document schema is
   * usually referenced through the variable it was assigned to rather than
   * through the model name it is registered under, and both have to resolve.
   */
  aliases?: string[];
  fields: FieldFact[];
  relations: RelationFact[];
  metadata: Record<string, string | string[]>;
}

interface TextSegment {
  text: string;
  start: number;
  end: number;
}

interface DecoratorUse {
  rawName: string;
  args?: string;
  start: number;
  end: number;
}

interface DecoratorBindings {
  localToCanonical: Map<string, string>;
  namespaces: Set<string>;
  allowCanonicalNames: boolean;
}

interface DecoratedMember {
  decorators: DecoratorUse[];
  name: string;
  type: string;
  line: number;
  style: 'typescript' | 'java-field' | 'java-getter' | 'kotlin';
}

const TYPEORM_DECORATORS = new Set([
  'Entity',
  'ViewEntity',
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'Generated',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  'Index',
  'Unique',
  'Check',
  'OneToOne',
  'OneToMany',
  'ManyToOne',
  'ManyToMany',
  'JoinColumn',
  'JoinTable',
  'RelationId',
]);

const JPA_DECORATORS = new Set([
  'Entity',
  'Table',
  'Id',
  'EmbeddedId',
  'Column',
  'GeneratedValue',
  'Version',
  'Transient',
  'Basic',
  'Enumerated',
  'ManyToOne',
  'OneToMany',
  'OneToOne',
  'ManyToMany',
  'JoinColumn',
  'JoinColumns',
  'JoinTable',
  'Embedded',
  'Embeddable',
  'MappedSuperclass',
]);

const TYPEGOOSE_DECORATORS = new Set([
  'prop',
  'arrayProp',
  'mapProp',
  'modelOptions',
  'index',
  'plugin',
]);

/**
 * Spring Data MongoDB's mapping annotations.
 *
 * `Id`, `Version` and `Transient` are spelled the same in JPA. Sharing a name
 * is harmless because a class only reaches this parser once `@Document` has
 * marked it, and `@Document` is not a JPA annotation.
 */
const SPRING_MONGO_DECORATORS = new Set([
  'Document',
  'Id',
  'Field',
  'DBRef',
  'DocumentReference',
  'Indexed',
  'CompoundIndex',
  'CompoundIndexes',
  'TextIndexed',
  'Transient',
  'Version',
  'CreatedDate',
  'LastModifiedDate',
  'ReadOnlyProperty',
]);

const PRISMA_SCALAR_TYPES = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

const normalizePath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  return normalized.length > 0 ? normalized : '.';
};

const dirname = (value: string): string => {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '.' : normalized.slice(0, index) || '.';
};

const basename = (value: string): string => {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
};

const isWithin = (filePath: string, directory: string): boolean => {
  if (directory === '.') {
    return true;
  }
  return filePath === directory || filePath.startsWith(`${directory}/`);
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const slug = (value: string): string => {
  const result = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return result.length > 0 ? result.slice(0, 36) : 'item';
};

const stableId = (prefix: string, label: string, ...parts: string[]): string =>
  `${prefix}:${slug(label)}:${fnv1a(parts.join('|'))}`;

class LineIndex {
  private readonly starts: number[] = [0];

  public constructor(text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '\n') {
        this.starts.push(index + 1);
      }
    }
  }

  public lineAt(offset: number): number {
    const target = Math.max(0, offset);
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = this.starts[middle];
      if (start === undefined) {
        break;
      }
      if (start <= target) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return Math.max(1, high + 1);
  }
}

const sourceRef = (file: string, line: number): SourceRef => ({ file, line: Math.max(1, line) });

const maskComments = (
  text: string,
  options: { slash?: boolean; hash?: boolean; dash?: boolean; block?: boolean },
): string => {
  const output = [...text];
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (current === undefined) {
      continue;
    }
    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
      } else {
        output[index] = ' ';
      }
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        blockComment = false;
      } else if (current !== '\n') {
        output[index] = ' ';
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        quote = undefined;
      }
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    if (options.block === true && current === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      blockComment = true;
      continue;
    }
    if (options.slash === true && current === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (options.dash === true && current === '-' && next === '-') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (options.hash === true && current === '#') {
      output[index] = ' ';
      lineComment = true;
    }
  }
  return output.join('');
};

const findMatching = (text: string, openIndex: number, open: string, close: string): number | undefined => {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const current = text[index];
    if (current === undefined) {
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        quote = undefined;
      }
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    if (current === open) {
      depth += 1;
    } else if (current === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
};

const splitTopLevel = (text: string, delimiter = ','): TextSegment[] => {
  const segments: TextSegment[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (current === undefined) {
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        quote = undefined;
      }
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }
    if (current === '(') round += 1;
    else if (current === ')') round = Math.max(0, round - 1);
    else if (current === '[') square += 1;
    else if (current === ']') square = Math.max(0, square - 1);
    else if (current === '{') curly += 1;
    else if (current === '}') curly = Math.max(0, curly - 1);
    else if (current === delimiter && round === 0 && square === 0 && curly === 0) {
      segments.push({ text: text.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  segments.push({ text: text.slice(start), start, end: text.length });
  return segments;
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
      return trimmed.slice(1, -1).replace(/\\([\\'"`])/g, '$1');
    }
    if (first === '[' && last === ']') {
      return trimmed.slice(1, -1).replace(/]]/g, ']');
    }
  }
  return trimmed;
};

const stringOption = (args: string | undefined, name?: string): string | undefined => {
  if (args === undefined) {
    return undefined;
  }
  let candidate = args.trim();
  if (name !== undefined) {
    const pattern = new RegExp(`\\b${name}\\s*[:=]\\s*((?:"(?:\\\\.|[^"\\\\])*")|(?:'(?:\\\\.|[^'\\\\])*')|(?:\u0060(?:\\\\.|[^\u0060\\\\])*\u0060))`);
    const match = pattern.exec(args);
    candidate = match?.[1] ?? '';
  } else {
    const first = splitTopLevel(args)[0];
    candidate = first?.text.trim() ?? '';
  }
  if (/^(?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|(?:`(?:\\.|[^`\\])*`)$/.test(candidate)) {
    return unquote(candidate);
  }
  return undefined;
};

const booleanOption = (args: string | undefined, name: string): boolean | undefined => {
  if (args === undefined) {
    return undefined;
  }
  const match = new RegExp(`\\b${name}\\s*[:=]\\s*(true|false|True|False)\\b`).exec(args);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return match[1].toLowerCase() === 'true';
};

const arrayOption = (args: string | undefined, name: string): string[] => {
  if (args === undefined) {
    return [];
  }
  const match = new RegExp(`\\b${name}\\s*[:=]\\s*\\[([^\\]]*)\\]`).exec(args);
  if (match?.[1] === undefined) {
    return [];
  }
  return splitTopLevel(match[1])
    .map((part) => unquote(part.text).replace(/\([^)]*\)$/g, '').trim())
    .filter((part) => part.length > 0);
};

const findNamedExpression = (args: string | undefined, name: string): string | undefined => {
  if (args === undefined) {
    return undefined;
  }
  const match = new RegExp(`\\b${name}\\s*[:=]\\s*([^,}\\n]+)`).exec(args);
  return match?.[1]?.trim();
};

const formatField = (field: FieldFact): string => {
  const flags: string[] = [];
  if (field.primary === true) flags.push('PK');
  if (field.unique === true) flags.push('UNIQUE');
  if (field.generated === true) flags.push('GENERATED');
  if (field.nullable === false) flags.push('NOT NULL');
  if (field.nullable === true) flags.push('NULL');
  if (field.relation === true) flags.push('RELATION');
  if (field.inferred === true) flags.push('INFERRED');
  const mapped = field.columnName !== undefined && field.columnName !== field.name ? ` -> ${field.columnName}` : '';
  const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
  return `${field.name}${mapped}: ${field.type}${suffix}`;
};

export interface ParsedField {
  name: string;
  /** The physical column, when the declaration maps the field to another name. */
  column?: string;
  type: string;
  flags: string[];
}

/**
 * The inverse of `formatField`, kept beside it so the two are changed together.
 *
 * The exported schema document has to take those strings back apart to put a
 * column in one table cell and its type in the next. It is total on purpose: a
 * string this does not recognise comes back as a name with no type, so a change
 * to `formatField` costs the document its type column rather than breaking it.
 */
export const parseFormattedField = (value: string): ParsedField => {
  const match = /^(.*?)(?: -> (.*?))?: (.*?)(?: \[([^\]]*)\])?$/.exec(value.trim());
  if (!match) {
    return { name: value.trim(), type: '', flags: [] };
  }
  const [, name = '', column, type = '', flags] = match;
  return {
    name,
    ...(column !== undefined && column.length > 0 ? { column } : {}),
    type,
    flags: flags ? flags.split(',').map((flag) => flag.trim()).filter(Boolean) : [],
  };
};

const parseDecoratorAt = (text: string, at: number): DecoratorUse | undefined => {
  if (text[at] !== '@') {
    return undefined;
  }
  const match = /^@(?:(?:field|get|set|property):)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(text.slice(at));
  const rawName = match?.[1];
  if (rawName === undefined) {
    return undefined;
  }
  let end = at + (match?.[0].length ?? 1);
  while (/\s/.test(text[end] ?? '')) end += 1;
  if (text[end] !== '(') {
    return { rawName, start: at, end };
  }
  const close = findMatching(text, end, '(', ')');
  if (close === undefined) {
    return { rawName, args: text.slice(end + 1), start: at, end: text.length };
  }
  return { rawName, args: text.slice(end + 1, close), start: at, end: close + 1 };
};

const parseDecoratorsInRange = (text: string, start: number, end: number): DecoratorUse[] => {
  const decorators: DecoratorUse[] = [];
  let cursor = start;
  while (cursor < end) {
    const at = text.indexOf('@', cursor);
    if (at < 0 || at >= end) {
      break;
    }
    const decorator = parseDecoratorAt(text, at);
    if (decorator === undefined) {
      cursor = at + 1;
      continue;
    }
    decorators.push(decorator);
    cursor = Math.max(at + 1, decorator.end);
  }
  return decorators;
};

const canonicalDecorator = (decorator: DecoratorUse, bindings: DecoratorBindings): string | undefined => {
  const pieces = decorator.rawName.split('.');
  const last = pieces[pieces.length - 1];
  if (last === undefined) {
    return undefined;
  }
  if (pieces.length > 1) {
    const namespace = pieces[0];
    if (namespace !== undefined && bindings.namespaces.has(namespace)) {
      return last;
    }
    if (decorator.rawName.startsWith('jakarta.persistence.') || decorator.rawName.startsWith('javax.persistence.')) {
      return last;
    }
  }
  return bindings.localToCanonical.get(last) ?? (bindings.allowCanonicalNames ? last : undefined);
};

const findDecorator = (
  decorators: readonly DecoratorUse[],
  bindings: DecoratorBindings,
  names: readonly string[],
): { decorator: DecoratorUse; canonical: string } | undefined => {
  for (const decorator of decorators) {
    const canonical = canonicalDecorator(decorator, bindings);
    if (canonical !== undefined && names.includes(canonical)) {
      return { decorator, canonical };
    }
  }
  return undefined;
};

const parseTypeOrmBindings = (text: string): DecoratorBindings => {
  const localToCanonical = new Map<string, string>();
  const namespaces = new Set<string>();
  const named = /\bimport\s*{([\s\S]*?)}\s*from\s*["']typeorm["']/g;
  let namedMatch: RegExpExecArray | null;
  while ((namedMatch = named.exec(text)) !== null) {
    const imports = namedMatch[1];
    if (imports === undefined) continue;
    for (const part of imports.split(',')) {
      const importMatch = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/.exec(part);
      const canonical = importMatch?.[1];
      const local = importMatch?.[2] ?? canonical;
      if (canonical !== undefined && local !== undefined && TYPEORM_DECORATORS.has(canonical)) {
        localToCanonical.set(local, canonical);
      }
    }
  }
  const namespace = /\bimport\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*["']typeorm["']/g;
  let namespaceMatch: RegExpExecArray | null;
  while ((namespaceMatch = namespace.exec(text)) !== null) {
    const local = namespaceMatch[1];
    if (local !== undefined) namespaces.add(local);
  }
  return {
    localToCanonical,
    namespaces,
    allowCanonicalNames: /(?:from\s*["']typeorm["']|require\s*\(\s*["']typeorm["'])/.test(text),
  };
};

const parseJpaBindings = (text: string): DecoratorBindings => {
  const localToCanonical = new Map<string, string>();
  let wildcard = false;
  const namespaces = new Set<string>();
  const imports = /\bimport\s+(?:jakarta|javax)\.persistence\.([A-Za-z_$*][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*;?/g;
  let match: RegExpExecArray | null;
  while ((match = imports.exec(text)) !== null) {
    const canonical = match[1];
    if (canonical === '*') {
      wildcard = true;
      continue;
    }
    const local = match[2] ?? canonical;
    if (canonical !== undefined && local !== undefined && JPA_DECORATORS.has(canonical)) {
      localToCanonical.set(local, canonical);
    }
  }
  return { localToCanonical, namespaces, allowCanonicalNames: wildcard };
};

const scanDecoratedMembers = (
  text: string,
  bodyStart: number,
  bodyEnd: number,
  lineIndex: LineIndex,
  bindings: DecoratorBindings,
  language: 'typescript' | 'jpa',
  // The vocabulary that makes a decorated member worth keeping. Passed in
  // rather than derived from `language`, because two libraries can decorate the
  // same language and each only recognises its own annotations.
  known: ReadonlySet<string> = language === 'typescript' ? TYPEORM_DECORATORS : JPA_DECORATORS,
): DecoratedMember[] => {
  const members: DecoratedMember[] = [];
  let cursor = bodyStart;
  while (cursor < bodyEnd) {
    const at = text.indexOf('@', cursor);
    if (at < 0 || at >= bodyEnd) break;
    const decorators: DecoratorUse[] = [];
    let decoratorCursor = at;
    while (decoratorCursor < bodyEnd && text[decoratorCursor] === '@') {
      const decorator = parseDecoratorAt(text, decoratorCursor);
      if (decorator === undefined || decorator.end > bodyEnd) break;
      decorators.push(decorator);
      decoratorCursor = decorator.end;
      while (/\s/.test(text[decoratorCursor] ?? '')) decoratorCursor += 1;
    }
    if (decorators.length === 0) {
      cursor = at + 1;
      continue;
    }
    const relevant = decorators.some((decorator) => {
      const canonical = canonicalDecorator(decorator, bindings);
      return canonical !== undefined && known.has(canonical);
    });
    if (!relevant) {
      cursor = decoratorCursor;
      continue;
    }
    const following = text.slice(decoratorCursor, Math.min(bodyEnd, decoratorCursor + 1200));
    if (language === 'typescript') {
      const property = /^(?:(?:public|private|protected|readonly|declare|static|abstract)\s+)*([A-Za-z_$][\w$]*)\s*[!?]?\s*:\s*([^;=\n]+)/.exec(following);
      const name = property?.[1];
      const type = property?.[2]?.trim();
      if (name !== undefined && type !== undefined) {
        members.push({ decorators, name, type, line: lineIndex.lineAt(at), style: 'typescript' });
        cursor = decoratorCursor + (property?.[0].length ?? 1);
        continue;
      }
    } else {
      const kotlin = /^(?:(?:public|private|protected|internal|lateinit|override|open)\s+)*(?:var|val)\s+([A-Za-z_$][\w$]*)\s*:\s*([^=\n,{]+)/.exec(following);
      const kotlinName = kotlin?.[1];
      const kotlinType = kotlin?.[2]?.trim();
      if (kotlinName !== undefined && kotlinType !== undefined) {
        members.push({ decorators, name: kotlinName, type: kotlinType, line: lineIndex.lineAt(at), style: 'kotlin' });
        cursor = decoratorCursor + (kotlin?.[0].length ?? 1);
        continue;
      }
      const getter = /^(?:(?:public|private|protected|abstract|final|synchronized)\s+)*([A-Za-z_$][\w$<>,.?[\] ]*)\s+(?:get|is)([A-Z][A-Za-z0-9_$]*)\s*\(/.exec(following);
      const getterType = getter?.[1]?.trim();
      const getterSuffix = getter?.[2];
      if (getterType !== undefined && getterSuffix !== undefined) {
        const name = `${getterSuffix[0]?.toLowerCase() ?? ''}${getterSuffix.slice(1)}`;
        members.push({ decorators, name, type: getterType, line: lineIndex.lineAt(at), style: 'java-getter' });
        cursor = decoratorCursor + (getter?.[0].length ?? 1);
        continue;
      }
      const field = /^(?:(?:public|private|protected|static|final|volatile|transient)\s+)*([A-Za-z_$][\w$<>,.?[\] ]*)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/.exec(following);
      const fieldType = field?.[1]?.trim();
      const fieldName = field?.[2];
      if (fieldType !== undefined && fieldName !== undefined) {
        members.push({ decorators, name: fieldName, type: fieldType, line: lineIndex.lineAt(at), style: 'java-field' });
        cursor = decoratorCursor + (field?.[0].length ?? 1);
        continue;
      }
    }
    cursor = decoratorCursor;
  }
  return members;
};

const parseArrowTarget = (args: string | undefined): string | undefined => {
  if (args === undefined) return undefined;
  const first = splitTopLevel(args)[0]?.text.trim();
  if (first === undefined) return undefined;
  const arrow = /=>\s*(?:\[\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/.exec(first);
  if (arrow?.[1] !== undefined) return arrow[1].split('.').pop();
  const directClass = /^([A-Za-z_$][\w$]*)\.class$/.exec(first);
  if (directClass?.[1] !== undefined) return directClass[1];
  const literal = stringOption(first);
  return literal;
};

const parseInverseField = (args: string | undefined): string | undefined => {
  if (args === undefined) return undefined;
  const second = splitTopLevel(args)[1]?.text;
  if (second === undefined) return undefined;
  return /=>\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/.exec(second)?.[1];
};

const unwrapRelationType = (type: string): string => {
  const trimmed = type.replace(/[?!]/g, '').trim();
  const generic = /^(?:List|Set|Collection|MutableList|MutableSet|Iterable|Array)<\s*([A-Za-z_$][\w$.]*)/.exec(trimmed);
  if (generic?.[1] !== undefined) return generic[1].split('.').pop() ?? generic[1];
  const array = /^([A-Za-z_$][\w$.]*)\[\]$/.exec(trimmed);
  if (array?.[1] !== undefined) return array[1].split('.').pop() ?? array[1];
  return trimmed.split('.').pop() ?? trimmed;
};

const buildVariantResolver = (files: readonly WorkspaceFile[]) => {
  const sourceLabels: Record<SchemaSource, string> = {
    prisma: 'Prisma',
    sql: 'SQL',
    typeorm: 'TypeORM',
    jpa: 'JPA',
    django: 'Django',
    gorm: 'GORM',
    drift: 'Drift',
    mongoose: 'Mongoose',
    dynamoose: 'Dynamoose',
    typegoose: 'Typegoose',
    mongoengine: 'MongoEngine',
    beanie: 'Beanie',
    'spring-mongo': 'Spring Data MongoDB',
  };
  const paths = files.map((file) => normalizePath(file.path));
  const manifestDirectories = new Map<string, string[]>();
  const manifests: Record<SchemaSource, Set<string>> = {
    prisma: new Set(['package.json']),
    sql: new Set(),
    typeorm: new Set(['package.json', 'pnpm-workspace.yaml', 'yarn.lock']),
    jpa: new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']),
    django: new Set(['manage.py', 'pyproject.toml', 'requirements.txt', 'Pipfile']),
    gorm: new Set(['go.mod']),
    drift: new Set(['pubspec.yaml', 'pubspec.yml']),
    mongoose: new Set(['package.json', 'pnpm-workspace.yaml', 'yarn.lock']),
    dynamoose: new Set(['package.json', 'pnpm-workspace.yaml', 'yarn.lock']),
    typegoose: new Set(['package.json', 'pnpm-workspace.yaml', 'yarn.lock']),
    mongoengine: new Set(['manage.py', 'pyproject.toml', 'requirements.txt', 'Pipfile']),
    beanie: new Set(['pyproject.toml', 'requirements.txt', 'Pipfile']),
    'spring-mongo': new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']),
  };
  for (const sourceKind of Object.keys(manifests) as SchemaSource[]) {
    const names = manifests[sourceKind];
    manifestDirectories.set(
      sourceKind,
      paths.filter((path) => names.has(basename(path))).map((path) => dirname(path)),
    );
  }

  const fallbackScope = (filePath: string): string => {
    const parts = normalizePath(filePath).split('/');
    const marker = parts.findIndex((part) => ['src', 'source', 'lib', 'server'].includes(part));
    if (marker <= 0) return '.';
    return parts.slice(0, marker).join('/') || '.';
  };

  return (sourceKind: SchemaSource, filePath: string): string => {
    const normalized = normalizePath(filePath);
    if (sourceKind === 'prisma' || sourceKind === 'sql') {
      return `${sourceLabels[sourceKind]}:${normalized}`;
    }
    const candidates = (manifestDirectories.get(sourceKind) ?? [])
      .filter((directory) => isWithin(normalized, directory))
      .sort((left, right) => right.length - left.length || left.localeCompare(right));
    const scope = candidates[0] ?? fallbackScope(normalized);
    return `${sourceLabels[sourceKind]}:${scope}`;
  };
};

const parsePrisma = (
  file: WorkspaceFile,
  variant: string,
  diagnostics: AnalysisDiagnostic[],
): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];
  const blockPattern = /\b(model|view|enum)\s+([A-Za-z_][\w]*)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(masked)) !== null) {
    const blockKind = match[1];
    const name = match[2];
    if (blockKind === undefined || name === undefined) continue;
    const open = masked.indexOf('{', match.index);
    const close = open >= 0 ? findMatching(masked, open, '{', '}') : undefined;
    if (open < 0 || close === undefined) {
      diagnostics.push({
        code: 'DB_PARSE_PARTIAL',
        severity: 'warning',
        message: `Unclosed Prisma ${blockKind} ${name}.`,
        source: sourceRef(filePath, lines.lineAt(match.index)),
      });
      continue;
    }
    const body = masked.slice(open + 1, close);
    const bodyOffset = open + 1;
    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    let physicalName = name;
    let physicalConfidence: ResolutionConfidence = 'inferred';
    let namespace: string | undefined;
    const logicalLines: TextSegment[] = [];
    let statementStart = 0;
    let roundDepth = 0;
    let squareDepth = 0;
    const rawLines = body.split(/\n/);
    let runningOffset = 0;
    for (const rawLine of rawLines) {
      const lineStart = runningOffset;
      runningOffset += rawLine.length + 1;
      for (const char of rawLine) {
        if (char === '(') roundDepth += 1;
        else if (char === ')') roundDepth = Math.max(0, roundDepth - 1);
        else if (char === '[') squareDepth += 1;
        else if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
      }
      if (roundDepth === 0 && squareDepth === 0) {
        const text = body.slice(statementStart, lineStart + rawLine.length);
        logicalLines.push({ text, start: statementStart, end: lineStart + rawLine.length });
        statementStart = runningOffset;
      }
    }
    if (statementStart < body.length) {
      logicalLines.push({ text: body.slice(statementStart), start: statementStart, end: body.length });
    }
    if (blockKind === 'enum') {
      for (const segment of logicalLines) {
        const value = /^\s*([A-Za-z_][\w]*)\b/.exec(segment.text)?.[1];
        if (value !== undefined && !segment.text.trim().startsWith('@@')) {
          fields.push({ name: value, type: 'enum value', line: lines.lineAt(bodyOffset + segment.start) });
        }
        const mapped = /@@map\s*\(\s*(["'][^"']+["'])/.exec(segment.text)?.[1];
        if (mapped !== undefined) {
          physicalName = unquote(mapped);
          physicalConfidence = 'exact';
        }
      }
    } else {
      for (const segment of logicalLines) {
        const trimmed = segment.text.trim();
        if (trimmed.length === 0) continue;
        const mapped = /@@map\s*\(\s*(["'][^"']+["'])/.exec(trimmed)?.[1];
        if (mapped !== undefined) {
          physicalName = unquote(mapped);
          physicalConfidence = 'exact';
          continue;
        }
        const schema = /@@schema\s*\(\s*(["'][^"']+["'])/.exec(trimmed)?.[1];
        if (schema !== undefined) {
          namespace = unquote(schema);
          continue;
        }
        if (trimmed.startsWith('@@')) continue;
        const fieldMatch = /^([A-Za-z_][\w]*)\s+([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
        const fieldName = fieldMatch?.[1];
        const typeToken = fieldMatch?.[2];
        const attributes = fieldMatch?.[3] ?? '';
        if (fieldName === undefined || typeToken === undefined) continue;
        const isArray = typeToken.endsWith('[]');
        const isOptional = typeToken.endsWith('?');
        const baseType = typeToken.replace(/\[\]$/, '').replace(/\?$/, '').replace(/\(.*/, '');
        const columnMap = /@map\s*\(\s*(["'][^"']+["'])/.exec(attributes)?.[1];
        const defaultValue = /@default\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/.exec(attributes)?.[1]?.trim();
        const nativeType = /@db\.([A-Za-z_][\w]*(?:\([^)]*\))?)/.exec(attributes)?.[1];
        const field: FieldFact = {
          name: fieldName,
          type: nativeType === undefined ? typeToken : `${typeToken} (${nativeType})`,
          line: lines.lineAt(bodyOffset + segment.start),
          columnName: columnMap === undefined ? fieldName : unquote(columnMap),
          primary: /(?:^|\s)@id(?:\s|\(|$)/.test(attributes),
          unique: /(?:^|\s)@unique(?:\s|\(|$)/.test(attributes),
          nullable: isOptional,
          generated: defaultValue !== undefined && /^(?:auto|autoincrement|cuid|uuid|now)\s*\(/.test(defaultValue),
          defaultValue,
        };
        fields.push(field);
        if (!PRISMA_SCALAR_TYPES.has(baseType)) {
          const relationArgs = /@relation\s*\(([\s\S]*?)\)/.exec(attributes)?.[1];
          const relationName = relationArgs === undefined ? undefined : stringOption(relationArgs);
          const localFields = arrayOption(relationArgs, 'fields');
          const targetFields = arrayOption(relationArgs, 'references');
          const onDelete = findNamedExpression(relationArgs, 'onDelete');
          const onUpdate = findNamedExpression(relationArgs, 'onUpdate');
          field.relation = true;
          relations.push({
            fieldName,
            targetName: baseType,
            relationKind: isArray ? 'many' : isOptional ? 'zero-or-one' : 'one',
            line: field.line,
            confidence: relationArgs === undefined ? 'inferred' : 'exact',
            localFields,
            targetFields,
            relationName,
            owning: localFields.length > 0,
            onDelete,
            onUpdate,
          });
        }
      }
    }
    const qualifiedName = namespace === undefined ? name : `${namespace}.${name}`;
    facts.push({
      variant,
      sourceKind: 'prisma',
      file: filePath,
      line: lines.lineAt(match.index),
      kind: blockKind === 'model' ? 'entity' : blockKind === 'view' ? 'view' : 'enum',
      logicalName: name,
      qualifiedName,
      physicalName,
      physicalNameConfidence: physicalConfidence,
      namespace,
      fields,
      relations,
      metadata: { 'Prisma block': blockKind },
    });
    blockPattern.lastIndex = close + 1;
  }
  return facts;
};

/* ------------------------------------------------------------------------- *
 * Document stores
 *
 * A document database validates nothing on write, so there is no catalogue to
 * read a schema out of. What there is instead is the shape the application
 * agrees to keep — a Mongoose schema, a Typegoose class, a MongoEngine
 * document — and that shape is a real declaration in a real file, which is what
 * these parsers read. Everything they produce is marked as declared rather than
 * enforced, because a collection can and will hold documents that disagree.
 * ------------------------------------------------------------------------- */

/** Constructors a document field is declared with, across both JS libraries. */
const DOCUMENT_SCALARS = new Set([
  'String', 'Number', 'Date', 'Boolean', 'Buffer', 'ObjectId', 'Mixed', 'Decimal128',
  'Map', 'Array', 'BigInt', 'UUID', 'Double', 'Int32', 'Set', 'Object',
]);

/** How deep a nested document literal is followed before it is left as `object`. */
const DOCUMENT_NESTING_LIMIT = 3;

interface DocumentBindings {
  /** Local names bound to the library's `Schema` constructor. */
  schemaNames: Set<string>;
  /** Local names bound to the module itself, so `x.Schema` resolves. */
  namespaces: Set<string>;
  /** Local names bound to the library's `model` factory. */
  modelNames: Set<string>;
  present: boolean;
}

const parseDocumentBindings = (text: string, moduleName: string): DocumentBindings => {
  const schemaNames = new Set<string>();
  const namespaces = new Set<string>();
  const modelNames = new Set<string>();
  const module = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const from = `(?:from\\s*["']${module}["']|require\\s*\\(\\s*["']${module}["']\\s*\\))`;

  const defaultImport = new RegExp(`\\bimport\\s+([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s*["']${module}["']`, 'g');
  const namespaceImport = new RegExp(`\\bimport\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s*from\\s*["']${module}["']`, 'g');
  const requireDefault = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\s*\\(\\s*["']${module}["']\\s*\\)`, 'g');
  for (const pattern of [defaultImport, namespaceImport, requireDefault]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] !== undefined) namespaces.add(match[1]);
    }
  }

  // `import { Schema as MongoSchema, model }` and the destructured `require`
  // form name the same two things; both are read here.
  const named = new RegExp(
    // `import { Schema }`, `import mongoose, { Schema }`, and the destructured
    // `const { Schema } = require(…)` all name the same bindings.
    `(?:\\bimport\\s+(?:type\\s+)?(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?|\\b(?:const|let|var)\\s+)\\{([^}]*)\\}\\s*(?:=\\s*)?${from}`,
    'g',
  );
  let namedMatch: RegExpExecArray | null;
  while ((namedMatch = named.exec(text)) !== null) {
    for (const part of (namedMatch[1] ?? '').split(',')) {
      const binding = /^\s*([A-Za-z_$][\w$]*)(?:\s*(?::|\bas\b)\s*([A-Za-z_$][\w$]*))?/.exec(part);
      const exported = binding?.[1];
      const local = binding?.[2] ?? exported;
      if (exported === undefined || local === undefined) continue;
      if (exported === 'Schema') schemaNames.add(local);
      if (exported === 'model') modelNames.add(local);
    }
  }

  return {
    schemaNames,
    namespaces,
    modelNames,
    present: new RegExp(from).test(text),
  };
};

/** The name of a type constructor, with any namespace in front of it dropped. */
const documentTypeName = (value: string): string | undefined => {
  const trimmed = value.trim().replace(/\s+/g, '');
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) return undefined;
  return trimmed.split('.').pop();
};

/** `{ … }` or `[ … ]` unwrapped to its contents, when that is what it is. */
const insideBrackets = (value: string, open: '{' | '['): string | undefined => {
  const trimmed = value.trim();
  const close = open === '{' ? '}' : ']';
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return undefined;
  return trimmed.slice(1, -1);
};

/** The key and the value of one `name: value` entry in an object literal. */
const splitObjectEntry = (segment: string): { key: string; value: string } | undefined => {
  const colon = splitTopLevel(segment, ':');
  if (colon.length < 2) return undefined;
  const key = unquote(colon[0]?.text ?? '').trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) return undefined;
  return { key, value: segment.slice((colon[0]?.end ?? 0) + 1) };
};

interface DocumentFieldSink {
  fields: FieldFact[];
  relations: RelationFact[];
}

/**
 * One document field, read from whichever of the three shapes it was written in:
 * a bare constructor (`name: String`), a descriptor (`name: { type: String }`),
 * or a nested literal, which is an embedded document and is followed into.
 */
const readDocumentField = (
  context: {
    name: string;
    value: string;
    line: number;
    depth: number;
    sink: DocumentFieldSink;
    schemaVariables: ReadonlySet<string>;
    array?: boolean;
  },
): void => {
  const { name, line, depth, sink, schemaVariables } = context;
  const trimmed = context.value.trim();

  const element = insideBrackets(trimmed, '[');
  if (element !== undefined) {
    // An array declares the type of one entry. `[String]` and `[]` are both
    // legal; the empty one says only that the field holds a list.
    if (element.trim().length === 0) {
      sink.fields.push({ name, type: 'Array', line });
      return;
    }
    readDocumentField({ ...context, value: element, array: true });
    return;
  }

  const body = insideBrackets(trimmed, '{');
  if (body !== undefined) {
    const entries = splitTopLevel(body)
      .map((segment) => splitObjectEntry(segment.text))
      .filter((entry): entry is { key: string; value: string } => entry !== undefined);
    const typeEntry = entries.find((entry) => entry.key === 'type');
    // A literal carrying a `type` key is a field descriptor; one without it is
    // an embedded document. Mongoose resolves the same ambiguity the same way.
    if (typeEntry !== undefined && documentTypeNameOf(typeEntry.value, schemaVariables) !== undefined) {
      readDocumentDescriptor({ ...context, entries, typeValue: typeEntry.value });
      return;
    }
    if (depth >= DOCUMENT_NESTING_LIMIT || entries.length === 0) {
      sink.fields.push({ name, type: context.array === true ? 'object[]' : 'object', line });
      return;
    }
    sink.fields.push({ name, type: context.array === true ? 'object[]' : 'object', line });
    for (const entry of entries) {
      readDocumentField({
        name: `${name}${context.array === true ? '[]' : ''}.${entry.key}`,
        value: entry.value,
        line,
        depth: depth + 1,
        sink,
        schemaVariables,
      });
    }
    return;
  }

  const typeName = documentTypeName(trimmed);
  if (typeName === undefined) {
    sink.fields.push({ name, type: context.array === true ? 'unknown[]' : 'unknown', line, inferred: true });
    return;
  }
  // A schema held in a variable and used as a field type is an embedded
  // document, and the relation says so rather than pretending it is a reference.
  if (schemaVariables.has(typeName)) {
    sink.fields.push({ name, type: context.array === true ? `${typeName}[]` : typeName, line, relation: true });
    sink.relations.push({
      fieldName: name,
      targetName: typeName,
      relationKind: context.array === true ? 'embeds many' : 'embeds',
      line,
      confidence: 'exact',
      localFields: [],
      targetFields: [],
      owning: true,
    });
    return;
  }
  sink.fields.push({
    name,
    type: context.array === true ? `${typeName}[]` : typeName,
    line,
    ...(DOCUMENT_SCALARS.has(typeName) ? {} : { inferred: true }),
  });
};

/** The type a descriptor's `type:` entry names, if it names one at all. */
const documentTypeNameOf = (value: string, schemaVariables: ReadonlySet<string>): string | undefined => {
  const trimmed = value.trim();
  const element = insideBrackets(trimmed, '[');
  if (element !== undefined) return documentTypeNameOf(element, schemaVariables);
  const name = documentTypeName(trimmed);
  if (name === undefined) return undefined;
  return DOCUMENT_SCALARS.has(name) || schemaVariables.has(name) ? name : undefined;
};

const readDocumentDescriptor = (
  context: {
    name: string;
    line: number;
    sink: DocumentFieldSink;
    schemaVariables: ReadonlySet<string>;
    entries: ReadonlyArray<{ key: string; value: string }>;
    typeValue: string;
    array?: boolean;
  },
): void => {
  const { name, line, sink, schemaVariables, entries, typeValue } = context;
  const option = (key: string): string | undefined => entries.find((entry) => entry.key === key)?.value.trim();
  const many = context.array === true || insideBrackets(typeValue, '[') !== undefined;
  const typeName = documentTypeNameOf(typeValue, schemaVariables) ?? 'unknown';
  const required = option('required');
  const reference = option('ref') ?? option('refPath');
  const target = reference === undefined ? undefined : unquote(reference).replace(/^\(\)\s*=>\s*/, '').split('.').pop();

  sink.fields.push({
    name,
    type: many ? `${typeName}[]` : typeName,
    line,
    ...(option('alias') === undefined ? {} : { columnName: unquote(option('alias') ?? '') }),
    primary: name === '_id' || option('hashKey') === 'true' ? true : undefined,
    unique: option('unique') === 'true' ? true : undefined,
    // Anything but a literal `true` — a function, a tuple with a message, a
    // conditional — is a rule this reader cannot evaluate, so it says nothing
    // rather than reporting the field as optional.
    nullable: required === undefined ? undefined : required === 'true' ? false : undefined,
    ...(option('default') === undefined ? {} : { defaultValue: option('default') }),
    ...(target === undefined ? {} : { relation: true }),
  });

  if (target !== undefined && /^[A-Za-z_$][\w$]*$/.test(target)) {
    sink.relations.push({
      fieldName: name,
      targetName: target,
      relationKind: many ? 'references many' : 'references',
      line,
      // `ref` names the model by string, so the name is exact even though
      // nothing checks that a document's stored id points at a live one.
      confidence: 'exact',
      localFields: [name],
      targetFields: ['_id'],
      owning: true,
    });
  } else if (schemaVariables.has(typeName)) {
    sink.relations.push({
      fieldName: name,
      targetName: typeName,
      relationKind: many ? 'embeds many' : 'embeds',
      line,
      confidence: 'exact',
      localFields: [],
      targetFields: [],
      owning: true,
    });
  }
};

/** `userSchema` / `UserSchema` names an entity a reader would call `User`. */
const documentEntityName = (variable: string): string => {
  const stripped = variable.replace(/(?:_?[Ss]chema|_?[Mm]odel|_?[Dd]ef)$/, '');
  const base = stripped.length > 0 ? stripped : variable;
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
};

interface DocumentSchemaDeclaration {
  variable?: string;
  definition: string;
  /** Absolute offset of the definition literal, so a field can report its line. */
  definitionStart: number;
  options?: string;
  line: number;
}

interface DocumentModelRegistration {
  modelName: string;
  collection?: string;
  line: number;
}

/**
 * Mongoose and Dynamoose declare a document the same way — `new Schema({…})`
 * held in a variable, then registered with `model('Name', schema)` — so one
 * reader serves both and the store it belongs to is recorded rather than
 * assumed.
 */
const parseDocumentSchemas = (
  file: WorkspaceFile,
  variant: string,
  store: 'mongoose' | 'dynamoose',
): EntityFact[] => {
  const moduleName = store;
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  const bindings = parseDocumentBindings(masked, moduleName);
  if (!bindings.present) return [];
  const lines = new LineIndex(file.content);

  const declarations = new Map<string, DocumentSchemaDeclaration>();
  const anonymous: DocumentSchemaDeclaration[] = [];
  const constructorPattern = /\bnew\s+((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = constructorPattern.exec(masked)) !== null) {
    const raw = (match[1] ?? '').replace(/\s+/g, '');
    const parts = raw.split('.');
    const last = parts[parts.length - 1];
    const owner = parts.length > 1 ? parts[0] : undefined;
    const isSchema = last === 'Schema'
      && (owner === undefined ? bindings.schemaNames.has(raw) : bindings.namespaces.has(owner));
    if (!isSchema) continue;
    const open = constructorPattern.lastIndex - 1;
    const close = findMatching(masked, open, '(', ')');
    if (close === undefined) continue;
    constructorPattern.lastIndex = close + 1;
    const args = splitTopLevel(masked.slice(open + 1, close));
    const first = args[0];
    const definition = insideBrackets(first?.text ?? '', '{');
    if (definition === undefined || first === undefined) continue;
    // `insideBrackets` trimmed and dropped the brace, so the contents begin one
    // character past wherever the brace itself sits inside the argument.
    const definitionStart = open + 1 + first.start + first.text.indexOf('{') + 1;
    const assignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/
      .exec(masked.slice(Math.max(0, match.index - 200), match.index));
    const declaration: DocumentSchemaDeclaration = {
      ...(assignment?.[1] === undefined ? {} : { variable: assignment[1] }),
      definition,
      definitionStart,
      ...(args[1] === undefined ? {} : { options: insideBrackets(args[1].text, '{') ?? args[1].text }),
      line: lines.lineAt(match.index),
    };
    if (declaration.variable === undefined) anonymous.push(declaration);
    else declarations.set(declaration.variable, declaration);
  }
  if (declarations.size === 0 && anonymous.length === 0) return [];

  // `model('User', userSchema, 'people')` is what turns a shape into a
  // collection. A schema never passed to one is an embedded document.
  const registrations = new Map<string, DocumentModelRegistration>();
  const modelPattern = /\b((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  let modelMatch: RegExpExecArray | null;
  while ((modelMatch = modelPattern.exec(masked)) !== null) {
    const raw = (modelMatch[1] ?? '').replace(/\s+/g, '');
    const parts = raw.split('.');
    const last = parts[parts.length - 1];
    const owner = parts.length > 1 ? parts[0] : undefined;
    const isModel = last === 'model'
      && (owner === undefined ? bindings.modelNames.has(raw) : bindings.namespaces.has(owner));
    if (!isModel) continue;
    const open = modelPattern.lastIndex - 1;
    const close = findMatching(masked, open, '(', ')');
    if (close === undefined) continue;
    modelPattern.lastIndex = close + 1;
    const args = splitTopLevel(masked.slice(open + 1, close));
    const modelName = stringOption(args[0]?.text);
    const schemaVariable = documentTypeName(args[1]?.text ?? '');
    if (modelName === undefined || schemaVariable === undefined) continue;
    const collection = stringOption(args[2]?.text);
    registrations.set(schemaVariable, {
      modelName,
      ...(collection === undefined ? {} : { collection }),
      line: lines.lineAt(modelMatch.index),
    });
  }

  const schemaVariables = new Set(declarations.keys());
  const facts: EntityFact[] = [];
  const entries: Array<[string | undefined, DocumentSchemaDeclaration]> = [
    ...[...declarations.entries()].map(([name, declaration]): [string | undefined, DocumentSchemaDeclaration] => [name, declaration]),
    ...anonymous.map((declaration): [string | undefined, DocumentSchemaDeclaration] => [undefined, declaration]),
  ];

  for (const [variable, declaration] of entries) {
    const sink: DocumentFieldSink = { fields: [], relations: [] };
    for (const segment of splitTopLevel(declaration.definition)) {
      const entry = splitObjectEntry(segment.text);
      if (entry === undefined) continue;
      readDocumentField({
        name: entry.key,
        value: entry.value,
        line: lines.lineAt(declaration.definitionStart + segment.start),
        depth: 0,
        sink,
        schemaVariables,
      });
    }

    const registration = variable === undefined ? undefined : registrations.get(variable);
    const declaredCollection = stringOption(declaration.options, 'collection')
      ?? stringOption(declaration.options, 'tableName');
    const logicalName = registration?.modelName ?? (variable === undefined ? 'Schema' : documentEntityName(variable));
    // Mongoose names a collection by lower-casing the model and pluralising it.
    // That is a default, not a declaration, so the confidence says so.
    const physicalName = declaredCollection
      ?? registration?.collection
      ?? (registration === undefined ? logicalName : pluralize(registration.modelName.toLowerCase()));
    const explicitPhysical = declaredCollection ?? registration?.collection;

    if (registration === undefined && sink.fields.length === 0) continue;
    facts.push({
      variant,
      sourceKind: store,
      file: filePath,
      line: declaration.line,
      kind: registration === undefined ? 'embedded' : 'collection',
      logicalName,
      qualifiedName: logicalName,
      physicalName,
      physicalNameConfidence: explicitPhysical === undefined ? 'inferred' : 'exact',
      ...(variable === undefined ? {} : { aliases: [variable] }),
      fields: sink.fields,
      relations: sink.relations,
      metadata: {
        ORM: store === 'mongoose' ? 'Mongoose' : 'Dynamoose',
        Store: store === 'mongoose' ? 'MongoDB' : 'DynamoDB',
        ...(variable === undefined ? {} : { 'Declared as': variable }),
        ...(registration === undefined
          ? { 'Document role': 'Embedded document — no model is registered for it' }
          : {}),
      },
    });
  }
  return facts;
};

const parseTypegooseBindings = (text: string): DecoratorBindings => {
  const localToCanonical = new Map<string, string>();
  const named = /\bimport\s*{([\s\S]*?)}\s*from\s*["']@typegoose\/typegoose["']/g;
  let match: RegExpExecArray | null;
  while ((match = named.exec(text)) !== null) {
    for (const part of (match[1] ?? '').split(',')) {
      const binding = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/.exec(part);
      const canonical = binding?.[1];
      const local = binding?.[2] ?? canonical;
      if (canonical !== undefined && local !== undefined && TYPEGOOSE_DECORATORS.has(canonical)) {
        localToCanonical.set(local, canonical);
      }
    }
  }
  const namespaces = new Set<string>();
  const namespace = /\bimport\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*["']@typegoose\/typegoose["']/g;
  let namespaceMatch: RegExpExecArray | null;
  while ((namespaceMatch = namespace.exec(text)) !== null) {
    if (namespaceMatch[1] !== undefined) namespaces.add(namespaceMatch[1]);
  }
  return {
    localToCanonical,
    namespaces,
    allowCanonicalNames: /["']@typegoose\/typegoose["']/.test(text),
  };
};

/** `Ref<Post>[]`, `Ref<Post>`, `Post[]` — the class a typed member points at. */
const typegooseTargetType = (type: string): string | undefined => {
  const trimmed = type.replace(/[?!]/g, '').trim();
  const wrapped = /^(?:Ref|mongoose\.Types\.Array|Array)\s*<\s*([A-Za-z_$][\w$.]*)/.exec(trimmed);
  if (wrapped?.[1] !== undefined) return wrapped[1].split('.').pop();
  return unwrapRelationType(trimmed);
};

/**
 * Typegoose declares a Mongoose schema as a decorated class, so the class is
 * the collection and `@prop` is the field. Only classes that carry at least one
 * `@prop` are taken: the decorator is what separates a document from every
 * other class the file may hold.
 */
const parseTypegoose = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  const bindings = parseTypegooseBindings(masked);
  if (!bindings.allowCanonicalNames && bindings.localToCanonical.size === 0 && bindings.namespaces.size === 0) return [];
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];
  const classPattern = /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
  let previousClassEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = classPattern.exec(masked)) !== null) {
    const className = match[1];
    if (className === undefined) continue;
    const open = masked.lastIndexOf('{', classPattern.lastIndex - 1);
    const close = open >= 0 ? findMatching(masked, open, '{', '}') : undefined;
    if (open < 0 || close === undefined) continue;
    const classDecorators = parseDecoratorsInRange(masked, previousClassEnd, match.index);
    const options = findDecorator(classDecorators, bindings, ['modelOptions']);
    previousClassEnd = close + 1;
    classPattern.lastIndex = close + 1;

    const members = scanDecoratedMembers(masked, open + 1, close, lines, bindings, 'typescript', TYPEGOOSE_DECORATORS);
    const properties = members.filter((member) => findDecorator(member.decorators, bindings, ['prop', 'arrayProp', 'mapProp']) !== undefined);
    if (properties.length === 0) continue;

    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    for (const member of properties) {
      const property = findDecorator(member.decorators, bindings, ['prop', 'arrayProp', 'mapProp']);
      const args = property?.decorator.args;
      const reference = findNamedExpression(args, 'ref');
      const target = reference === undefined
        ? undefined
        : unquote(reference).replace(/^\(\s*\)\s*=>\s*/, '').replace(/[[\]]/g, '').split('.').pop();
      const many = /\[\s*\]\s*$/.test(member.type.trim()) || /^(?:Array|Map)\s*</.test(member.type.trim());
      fields.push({
        name: member.name,
        type: member.type,
        line: member.line,
        ...(stringOption(args, 'alias') === undefined ? {} : { columnName: stringOption(args, 'alias') }),
        unique: booleanOption(args, 'unique') === true ? true : undefined,
        nullable: booleanOption(args, 'required') === true ? false : undefined,
        ...(findNamedExpression(args, 'default') === undefined ? {} : { defaultValue: findNamedExpression(args, 'default') }),
        ...(target === undefined ? {} : { relation: true }),
      });
      if (target !== undefined && /^[A-Za-z_$][\w$]*$/.test(target)) {
        relations.push({
          fieldName: member.name,
          targetName: target,
          relationKind: many ? 'references many' : 'references',
          line: member.line,
          confidence: 'exact',
          localFields: [member.name],
          targetFields: ['_id'],
          owning: true,
        });
        continue;
      }
      // No `ref`, but the member is typed as another document class: Typegoose
      // stores that inline, which is an embedded document rather than a link.
      const embedded = typegooseTargetType(member.type);
      if (embedded !== undefined && /^[A-Z][\w$]*$/.test(embedded) && !TYPEGOOSE_BUILTIN_TYPES.has(embedded)) {
        relations.push({
          fieldName: member.name,
          targetName: embedded,
          relationKind: many ? 'embeds many' : 'embeds',
          line: member.line,
          confidence: 'inferred',
          localFields: [],
          targetFields: [],
          owning: true,
        });
      }
    }

    const collection = stringOption(options?.decorator.args, 'collection');
    facts.push({
      variant,
      sourceKind: 'typegoose',
      file: filePath,
      line: lines.lineAt(match.index),
      kind: 'collection',
      logicalName: className,
      qualifiedName: className,
      physicalName: collection ?? pluralize(className.toLowerCase()),
      physicalNameConfidence: collection === undefined ? 'inferred' : 'exact',
      fields,
      relations,
      metadata: { ORM: 'Typegoose', Store: 'MongoDB' },
    });
  }

  // A class only becomes a collection once a model is built from it. Classes
  // this file never models, but does store inside another one, are embedded
  // documents. The test is deliberately narrow: a project that builds its
  // models in a separate file would otherwise have every document demoted.
  const modelled = new Set<string>();
  const modelFactory = /\b(?:getModelForClass|getDiscriminatorModelForClass|buildSchema|addModelToTypegoose)\s*\(\s*([A-Za-z_$][\w$]*)/g;
  let modelledMatch: RegExpExecArray | null;
  while ((modelledMatch = modelFactory.exec(masked)) !== null) {
    if (modelledMatch[1] !== undefined) modelled.add(modelledMatch[1]);
  }
  const storedInside = new Set(
    facts.flatMap((fact) => fact.relations)
      .filter((relation) => relation.relationKind.startsWith('embeds'))
      .map((relation) => relation.targetName),
  );
  for (const fact of facts) {
    if (modelled.has(fact.logicalName) || !storedInside.has(fact.logicalName)) continue;
    fact.kind = 'embedded';
    fact.physicalName = fact.logicalName;
    fact.physicalNameConfidence = 'exact';
    fact.metadata = {
      ...fact.metadata,
      'Document role': 'Embedded document — stored inside another document, not in its own collection',
    };
  }
  return facts;
};

/** Types a `@prop` may carry that are not another document class. */
const TYPEGOOSE_BUILTIN_TYPES = new Set([
  'String', 'Number', 'Boolean', 'Date', 'Buffer', 'Object', 'Array', 'Map', 'Set',
  'ObjectId', 'Types', 'Schema', 'Mixed', 'Decimal128', 'BigInt',
]);

/** One logical statement in a Python class body, at the body's own indent. */
interface PythonStatement {
  text: string;
  start: number;
  indent: number;
}

/**
 * The statements directly inside a class body, with continuations folded in.
 *
 * A statement runs to the end of its line unless a bracket is still open, which
 * is how a field declaration spread over several lines stays one statement.
 * Lines indented past the body's own level belong to a nested block and are
 * skipped, so a nested `class Settings:` does not leak into its parent's fields.
 */
const pythonStatements = (masked: string, bodyStart: number, bodyEnd: number): PythonStatement[] => {
  const body = masked.slice(bodyStart, bodyEnd);
  const statements: PythonStatement[] = [];
  const linePattern = /^([ \t]*)(\S[^\n]*)$/gm;
  let baseIndent: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(body)) !== null) {
    const indent = indentationWidth(match[1] ?? '');
    if (baseIndent === undefined) baseIndent = indent;
    if (indent > baseIndent) continue;
    let text = match[2] ?? '';
    let cursor = linePattern.lastIndex;
    // A declaration that spans lines leaves a bracket open; keep taking lines
    // until they close rather than reading half a field.
    let depth = bracketDepth(text);
    while (depth > 0 && cursor < body.length) {
      const nextBreak = body.indexOf('\n', cursor);
      const end = nextBreak < 0 ? body.length : nextBreak;
      const line = body.slice(cursor, end);
      text += `\n${line}`;
      depth += bracketDepth(line);
      cursor = end + 1;
    }
    linePattern.lastIndex = Math.max(linePattern.lastIndex, cursor);
    statements.push({ text, start: bodyStart + match.index + (match[1] ?? '').length, indent });
  }
  return statements;
};

/**
 * `{'collection': 'people'}` — a Python dict entry, whose key is a string and
 * so does not sit where `stringOption` looks for a bare name.
 */
const pythonDictOption = (body: string | undefined, key: string): string | undefined => {
  if (body === undefined) return undefined;
  const match = new RegExp(`['"]${key}['"]\\s*:\\s*(['"][^'"]*['"])`).exec(body);
  return match?.[1] === undefined ? stringOption(body, key) : unquote(match[1]);
};

/**
 * `name: annotation` and `name: annotation = default` split apart.
 *
 * The default is dropped by bracket depth rather than by the first `=`, so an
 * annotation carrying one of its own — `Indexed(str, unique=True)` — survives
 * intact instead of being cut in half.
 */
const splitPythonAnnotation = (text: string): { name: string; annotation: string } | undefined => {
  const colon = splitTopLevel(text, ':');
  const head = colon[0];
  if (colon.length < 2 || head === undefined) return undefined;
  const name = head.text.trim();
  if (!/^[A-Za-z_][\w]*$/.test(name)) return undefined;
  const rest = text.slice(head.end + 1);
  const annotation = (splitTopLevel(rest, '=')[0]?.text ?? rest).trim();
  return annotation.length === 0 ? undefined : { name, annotation };
};

const bracketDepth = (text: string): number => {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (const character of text) {
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
  }
  return depth;
};

/** Class names a Python module bound from `library`, direct and transitive. */
const pythonSubclassesOf = (
  masked: string,
  blocks: readonly PythonClassBlock[],
  library: string,
  baseNames: ReadonlySet<string>,
): Map<string, string> => {
  const localToBase = new Map<string, string>();
  const namespaces = new Set<string>();
  const escaped = library.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`^\\s*from\\s+${escaped}(?:\\.[\\w.]+)?\\s+import\\s+([^\\n]+)`, 'gm');
  let match: RegExpExecArray | null;
  while ((match = named.exec(masked)) !== null) {
    for (const part of (match[1] ?? '').replace(/[()]/g, '').split(',')) {
      const binding = /^\s*([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?/.exec(part);
      const imported = binding?.[1];
      const local = binding?.[2] ?? imported;
      if (imported !== undefined && local !== undefined && baseNames.has(imported)) {
        localToBase.set(local, imported);
      }
    }
  }
  const moduleImport = new RegExp(`^\\s*import\\s+${escaped}(?:\\s+as\\s+([A-Za-z_][\\w]*))?`, 'gm');
  let moduleMatch: RegExpExecArray | null;
  while ((moduleMatch = moduleImport.exec(masked)) !== null) {
    namespaces.add(moduleMatch[1] ?? library);
  }

  const resolved = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (resolved.has(block.name)) continue;
      for (const base of block.bases.split(',')) {
        const trimmed = base.trim().replace(/\[.*$/, '');
        const qualified = /^([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)$/.exec(trimmed);
        const viaNamespace = qualified !== null && qualified[1] !== undefined && qualified[2] !== undefined
          && namespaces.has(qualified[1]) && baseNames.has(qualified[2])
          ? qualified[2]
          : undefined;
        const found = localToBase.get(trimmed) ?? viaNamespace ?? resolved.get(trimmed);
        if (found !== undefined) {
          resolved.set(block.name, found);
          changed = true;
          break;
        }
      }
    }
  }
  return resolved;
};

/** MongoEngine base classes, and what each one means for the diagram. */
const MONGOENGINE_BASES = new Map<string, 'collection' | 'embedded'>([
  ['Document', 'collection'],
  ['DynamicDocument', 'collection'],
  ['EmbeddedDocument', 'embedded'],
  ['DynamicEmbeddedDocument', 'embedded'],
]);

/** Field classes that point at another document rather than holding a value. */
const MONGOENGINE_REFERENCES = new Set([
  'ReferenceField', 'LazyReferenceField', 'CachedReferenceField',
]);

const MONGOENGINE_EMBEDS = new Set([
  'EmbeddedDocumentField', 'GenericEmbeddedDocumentField',
]);

const MONGOENGINE_LISTS = new Set([
  'ListField', 'SortedListField', 'EmbeddedDocumentListField',
]);

/**
 * MongoEngine documents.
 *
 * The declaration reads almost exactly like a Django model — `name =
 * SomeField(...)` inside a class — which is why the two share a scanner. What
 * differs is that a base class here says whether the document lives in its own
 * collection or inside another one, and that is the distinction worth drawing.
 */
const parseMongoengine = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { hash: true });
  if (!/\bmongoengine\b/.test(masked)) return [];
  const blocks = pythonClassBlocks(masked);
  const documents = pythonSubclassesOf(masked, blocks, 'mongoengine', new Set(MONGOENGINE_BASES.keys()));
  if (documents.size === 0) return [];
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];

  for (const block of blocks) {
    const base = documents.get(block.name);
    if (base === undefined) continue;
    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    let collection: string | undefined;
    let abstract = false;

    for (const statement of pythonStatements(masked, block.bodyStart, block.bodyEnd)) {
      const meta = /^meta\s*=\s*\{([\s\S]*)\}\s*$/.exec(statement.text.trim());
      if (meta !== null) {
        collection = pythonDictOption(meta[1], 'collection');
        abstract = /['"]abstract['"]\s*:\s*True\b/.test(meta[1] ?? '') || booleanOption(meta[1], 'abstract') === true;
        continue;
      }
      const assignment = /^([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w.]*)\s*\(/.exec(statement.text);
      const name = assignment?.[1];
      const rawCall = assignment?.[2];
      if (name === undefined || rawCall === undefined) continue;
      const call = rawCall.split('.').pop() ?? rawCall;
      if (!/Field$/.test(call)) continue;
      const open = statement.text.indexOf('(', (assignment?.[0].length ?? 1) - 1);
      const close = open < 0 ? undefined : findMatching(statement.text, open, '(', ')');
      const args = open < 0 || close === undefined ? '' : statement.text.slice(open + 1, close);
      const line = lines.lineAt(statement.start);

      const many = MONGOENGINE_LISTS.has(call) || call === 'MapField';
      // A list wraps the field it holds: `ListField(ReferenceField(Post))`.
      const innerMatch = /^\s*([A-Za-z_][\w.]*)\s*\(/.exec(args);
      const inner = innerMatch?.[1]?.split('.').pop();
      const effective = many && inner !== undefined ? inner : call;
      const innerArgs = many && inner !== undefined
        ? (() => {
          const innerOpen = args.indexOf('(');
          const innerClose = findMatching(args, innerOpen, '(', ')');
          return innerClose === undefined ? '' : args.slice(innerOpen + 1, innerClose);
        })()
        : args;

      const target = call === 'EmbeddedDocumentListField'
        ? documentTypeName(splitTopLevel(args)[0]?.text ?? '') ?? stringOption(args)
        : MONGOENGINE_REFERENCES.has(effective) || MONGOENGINE_EMBEDS.has(effective)
          ? stringOption(innerArgs) ?? documentTypeName(splitTopLevel(innerArgs)[0]?.text ?? '')
          : undefined;
      const embeds = call === 'EmbeddedDocumentListField' || MONGOENGINE_EMBEDS.has(effective);

      fields.push({
        name,
        type: many ? `${effective}[]` : effective,
        line,
        ...(stringOption(args, 'db_field') === undefined ? {} : { columnName: stringOption(args, 'db_field') }),
        primary: booleanOption(args, 'primary_key') === true ? true : undefined,
        unique: booleanOption(args, 'unique') === true ? true : undefined,
        nullable: booleanOption(args, 'required') === true ? false : undefined,
        ...(findNamedExpression(args, 'default') === undefined ? {} : { defaultValue: findNamedExpression(args, 'default') }),
        ...(target === undefined ? {} : { relation: true }),
      });

      if (target !== undefined && /^[A-Za-z_][\w]*$/.test(target)) {
        relations.push({
          fieldName: name,
          targetName: target,
          relationKind: `${embeds ? 'embeds' : 'references'}${many ? ' many' : ''}`,
          line,
          confidence: 'exact',
          localFields: embeds ? [] : [name],
          targetFields: embeds ? [] : ['id'],
          owning: true,
        });
      }
    }

    if (fields.length === 0) continue;
    const kind = abstract ? 'abstract-entity' : base === 'EmbeddedDocument' || base === 'DynamicEmbeddedDocument' ? 'embedded' : 'collection';
    const physicalName = collection ?? (kind === 'collection' ? snakeCase(block.name) : block.name);
    facts.push({
      variant,
      sourceKind: 'mongoengine',
      file: filePath,
      line: lines.lineAt(block.start),
      kind,
      logicalName: block.name,
      qualifiedName: block.name,
      physicalName,
      physicalNameConfidence: collection === undefined ? 'inferred' : 'exact',
      fields,
      relations,
      metadata: {
        ORM: 'MongoEngine',
        Store: 'MongoDB',
        'Declared base': base,
        ...(kind === 'embedded'
          ? { 'Document role': 'Embedded document — stored inside another document, not in its own collection' }
          : {}),
      },
    });
  }
  return facts;
};

/** Beanie base classes that own a collection of their own. */
const BEANIE_BASES = new Set(['Document', 'View', 'UnionDoc', 'TimeSeriesDocument']);

/** The document a Beanie annotation links to, and whether it links to many. */
const beanieLink = (annotation: string): { target: string; many: boolean; back: boolean } | undefined => {
  const link = /\b(Link|BackLink)\s*\[\s*(?:"|')?([A-Za-z_][\w.]*)(?:"|')?\s*\]/.exec(annotation);
  const target = link?.[2];
  if (link === null || target === undefined) return undefined;
  return {
    target: target.split('.').pop() ?? target,
    many: /\b(?:List|list|Set|set|Tuple|tuple)\s*\[/.test(annotation),
    back: link[1] === 'BackLink',
  };
};

/**
 * Beanie documents.
 *
 * Beanie is Pydantic underneath, so the field declaration is a type annotation
 * and nothing else — there is no field object to read options off. What the
 * annotation does carry is `Optional`, and `Link[…]`, which is the only kind of
 * relationship the library expresses.
 */
const parseBeanie = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { hash: true });
  if (!/\bbeanie\b/.test(masked)) return [];
  const blocks = pythonClassBlocks(masked);
  const documents = pythonSubclassesOf(masked, blocks, 'beanie', BEANIE_BASES);
  if (documents.size === 0) return [];
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];

  for (const block of blocks) {
    if (!documents.has(block.name)) continue;
    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    let collection: string | undefined;

    // `class Settings: name = "people"` is how Beanie names the collection, and
    // it is a nested block, so it is read from the class list rather than from
    // this document's own statements.
    const settings = blocks.find((candidate) => candidate.name === 'Settings'
      && candidate.start > block.bodyStart && candidate.bodyEnd <= block.bodyEnd);
    if (settings !== undefined) {
      for (const statement of pythonStatements(masked, settings.bodyStart, settings.bodyEnd)) {
        const named = /^name\s*=\s*(.+)$/.exec(statement.text.trim());
        if (named?.[1] !== undefined) collection = stringOption(named[1]);
      }
    }

    for (const statement of pythonStatements(masked, block.bodyStart, block.bodyEnd)) {
      const annotated = splitPythonAnnotation(statement.text.trim());
      const name = annotated?.name;
      const annotation = annotated?.annotation;
      if (name === undefined || annotation === undefined || name === 'model_config') continue;
      const link = beanieLink(annotation);
      const optional = /\bOptional\s*\[/.test(annotation) || /\|\s*None\b/.test(annotation);
      const indexed = /\bIndexed\s*\(/.exec(annotation);
      fields.push({
        name,
        type: annotation.replace(/\s+/g, ' '),
        line: lines.lineAt(statement.start),
        primary: name === 'id' ? true : undefined,
        unique: indexed !== null && booleanOption(annotation, 'unique') === true ? true : undefined,
        nullable: optional ? true : false,
        ...(link === undefined ? {} : { relation: true }),
      });
      if (link !== undefined) {
        relations.push({
          fieldName: name,
          targetName: link.target,
          relationKind: `${link.back ? 'back-links' : 'references'}${link.many ? ' many' : ''}`,
          line: lines.lineAt(statement.start),
          confidence: 'exact',
          localFields: link.back ? [] : [name],
          targetFields: link.back ? [] : ['_id'],
          owning: !link.back,
        });
      }
    }

    if (fields.length === 0) continue;
    facts.push({
      variant,
      sourceKind: 'beanie',
      file: filePath,
      line: lines.lineAt(block.start),
      kind: 'collection',
      logicalName: block.name,
      qualifiedName: block.name,
      physicalName: collection ?? block.name,
      physicalNameConfidence: collection === undefined ? 'inferred' : 'exact',
      fields,
      relations,
      metadata: { ORM: 'Beanie', Store: 'MongoDB' },
    });
  }
  return facts;
};

const parseSpringMongoBindings = (text: string): DecoratorBindings => {
  const localToCanonical = new Map<string, string>();
  const imports = /\bimport\s+org\.springframework\.data\.(?:mongodb\.core\.(?:mapping|index)|annotation)\.([A-Za-z_$*][\w$]*)\s*;?/g;
  let wildcard = false;
  let match: RegExpExecArray | null;
  while ((match = imports.exec(text)) !== null) {
    const canonical = match[1];
    if (canonical === '*') {
      wildcard = true;
      continue;
    }
    if (canonical !== undefined && SPRING_MONGO_DECORATORS.has(canonical)) {
      localToCanonical.set(canonical, canonical);
    }
  }
  return { localToCanonical, namespaces: new Set<string>(), allowCanonicalNames: wildcard };
};

/** Java and Kotlin type names that hold many of something. */
const JVM_COLLECTION_TYPES = /^(?:List|Set|Collection|Iterable|MutableList|MutableSet|Array|ArrayList|HashSet|Stream)\s*</;

/**
 * Every mapped member of a JVM class body, annotated or not.
 *
 * Spring Data maps by convention: most fields of a `@Document` class carry no
 * annotation at all, and a scanner that starts from `@` — which is all the
 * relational readers here need — would report a document with two fields when
 * it has twelve.
 */
const scanJvmMembers = (
  text: string,
  bodyStart: number,
  bodyEnd: number,
  lineIndex: LineIndex,
): Array<{ decorators: DecoratorUse[]; name: string; type: string; line: number }> => {
  const body = text.slice(bodyStart, bodyEnd);
  const members: Array<{ decorators: DecoratorUse[]; name: string; type: string; line: number }> = [];
  const annotations = '((?:@[\\w.]+(?:\\([^()]*\\))?\\s*)*)';
  const patterns = [
    // Java field, and Kotlin's `val name: Type` — one language each, both
    // anchored on the modifiers so a method or a nested class cannot match.
    new RegExp(`${annotations}((?:(?:public|private|protected|static|final|transient|volatile)\\s+)*)([A-Za-z_$][\\w$]*(?:\\s*<[^;{}]*>)?(?:\\s*\\[\\s*\\])*)\\s+([A-Za-z_$][\\w$]*)\\s*(?:=[^;]*)?;`, 'g'),
    new RegExp(`${annotations}((?:(?:private|protected|internal|open|lateinit|override)\\s+)*)(?:var|val)\\s+([A-Za-z_$][\\w$]*)\\s*:\\s*([^=\\n,)]+)`, 'g'),
  ];
  for (const [index, pattern] of patterns.entries()) {
    const kotlin = index === 1;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const modifiers = match[2] ?? '';
      if (/\bstatic\b/.test(modifiers)) continue;
      const name = kotlin ? match[3] : match[4];
      const type = (kotlin ? match[4] : match[3])?.trim();
      if (name === undefined || type === undefined) continue;
      const at = bodyStart + match.index;
      members.push({
        decorators: parseDecoratorsInRange(text, at, at + (match[1] ?? '').length),
        name,
        type: type.replace(/\s+/g, ' '),
        line: lineIndex.lineAt(at),
      });
    }
  }
  // Java and Kotlin never both match inside one class, so ordering the two
  // passes' output by position restores source order for whichever one did.
  return members.sort((left, right) => left.line - right.line);
};

/**
 * The same text with everything inside a nested block replaced by spaces.
 *
 * A method body is full of statements that look exactly like field
 * declarations — `return name;` is a type and a name and a semicolon — so the
 * bodies are removed before the fields are read. Blanking rather than cutting
 * keeps every remaining offset where it was, and so keeps line numbers true.
 */
const blankNestedBlocks = (text: string, start: number, end: number): string => {
  const output = [...text];
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const character = text[index];
    if (character === '{') {
      depth += 1;
      if (depth === 1) continue;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) continue;
    }
    if (depth > 0 && character !== '\n') output[index] = ' ';
  }
  return output.join('');
};

const skipJvmSpace = (text: string, from: number): number => {
  let cursor = from;
  while (/\s/.test(text[cursor] ?? '')) cursor += 1;
  return cursor;
};

/**
 * Spring Data MongoDB documents.
 *
 * `@Document` is the whole of the declaration: everything below it is an
 * ordinary field that Spring will persist under its own name unless `@Field`
 * says otherwise. `@DBRef` and `@DocumentReference` are the only links the
 * mapping expresses, and nothing enforces that what they point at exists.
 */
const parseSpringMongo = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  if (!/org\.springframework\.data\.mongodb/.test(masked)) return [];
  const bindings = parseSpringMongoBindings(masked);
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];
  // Kotlin's `data class Post(val title: String)` has no body at all, so the
  // header and the body are located separately and either may be absent.
  const classPattern = /\b(?:(?:data|value|open|abstract|final|sealed|inner|public)\s+)*class\s+([A-Za-z_$][\w$]*)/g;
  let previousClassEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = classPattern.exec(masked)) !== null) {
    const className = match[1];
    if (className === undefined) continue;
    let cursor = skipJvmSpace(masked, classPattern.lastIndex);
    if (masked[cursor] === '<') {
      const generic = findMatching(masked, cursor, '<', '>');
      if (generic === undefined) continue;
      cursor = skipJvmSpace(masked, generic + 1);
    }
    let header: { start: number; end: number } | undefined;
    if (masked[cursor] === '(') {
      const headerClose = findMatching(masked, cursor, '(', ')');
      if (headerClose === undefined) continue;
      header = { start: cursor + 1, end: headerClose };
      cursor = skipJvmSpace(masked, headerClose + 1);
    }
    let body: { start: number; end: number } | undefined;
    // Between the header and the body sits an optional supertype list, which
    // may carry constructor arguments of its own but never a block.
    const brace = /^(?::[^{;]*)?\{/.exec(masked.slice(cursor, cursor + 600));
    if (brace !== null) {
      const open = cursor + brace[0].length - 1;
      const bodyClose = findMatching(masked, open, '{', '}');
      if (bodyClose !== undefined) body = { start: open + 1, end: bodyClose };
    }
    const classDecorators = parseDecoratorsInRange(masked, previousClassEnd, match.index);
    const document = findDecorator(classDecorators, bindings, ['Document']);
    previousClassEnd = body === undefined ? cursor : body.end + 1;
    classPattern.lastIndex = previousClassEnd;
    if (document === undefined) continue;

    const members = body === undefined
      ? []
      : scanJvmMembers(blankNestedBlocks(masked, body.start, body.end), body.start, body.end, lines);
    // A Kotlin data class declares its properties in the header, not the body.
    if (header !== undefined) {
      members.unshift(...scanJvmMembers(masked, header.start, header.end, lines));
    }

    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    for (const member of members) {
      if (findDecorator(member.decorators, bindings, ['Transient']) !== undefined) continue;
      const fieldAnnotation = findDecorator(member.decorators, bindings, ['Field']);
      const indexed = findDecorator(member.decorators, bindings, ['Indexed']);
      const reference = findDecorator(member.decorators, bindings, ['DBRef', 'DocumentReference']);
      const columnName = stringOption(fieldAnnotation?.decorator.args)
        ?? stringOption(fieldAnnotation?.decorator.args, 'name')
        ?? stringOption(fieldAnnotation?.decorator.args, 'value');
      fields.push({
        name: member.name,
        type: member.type,
        line: member.line,
        ...(columnName === undefined ? {} : { columnName }),
        primary: findDecorator(member.decorators, bindings, ['Id']) !== undefined ? true : undefined,
        unique: booleanOption(indexed?.decorator.args, 'unique') === true ? true : undefined,
        ...(reference === undefined ? {} : { relation: true }),
      });
      if (reference === undefined) continue;
      const target = unwrapRelationType(member.type);
      if (!/^[A-Za-z_$][\w$]*$/.test(target)) continue;
      relations.push({
        fieldName: member.name,
        targetName: target,
        relationKind: JVM_COLLECTION_TYPES.test(member.type) || member.type.endsWith('[]')
          ? 'references many'
          : 'references',
        line: member.line,
        confidence: 'exact',
        localFields: [member.name],
        targetFields: ['_id'],
        owning: true,
      });
    }
    if (fields.length === 0) continue;

    const args = document.decorator.args;
    const collection = stringOption(args) ?? stringOption(args, 'collection') ?? stringOption(args, 'value');
    facts.push({
      variant,
      sourceKind: 'spring-mongo',
      file: filePath,
      line: lines.lineAt(document.decorator.start),
      kind: 'collection',
      logicalName: className,
      qualifiedName: className,
      // Spring names a collection after the class with a lower-case first
      // letter, unless the annotation says otherwise.
      physicalName: collection ?? `${className.charAt(0).toLowerCase()}${className.slice(1)}`,
      physicalNameConfidence: collection === undefined ? 'inferred' : 'exact',
      fields,
      relations,
      metadata: { ORM: 'Spring Data MongoDB', Store: 'MongoDB' },
    });
  }
  return facts;
};

const SQL_IDENTIFIER = '(?:"(?:""|[^"])+"|`(?:``|[^`])+`|\\[(?:\\]\\]|[^\\]])+\\]|[A-Za-z_$][\\w$]*)(?:\\s*\\.\\s*(?:"(?:""|[^"])+"|`(?:``|[^`])+`|\\[(?:\\]\\]|[^\\]])+\\]|[A-Za-z_$][\\w$]*))?';

const parseQualifiedSqlName = (value: string): { namespace?: string; name: string } => {
  const parts = splitTopLevel(value, '.').map((part) => unquote(part.text.trim())).filter(Boolean);
  const name = parts[parts.length - 1] ?? unquote(value);
  const namespace = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
  return { namespace, name };
};

const readSqlIdentifier = (value: string): { identifier: string; rest: string } | undefined => {
  const match = new RegExp(`^\\s*(${SQL_IDENTIFIER})\\s*([\\s\\S]*)$`, 'i').exec(value);
  const identifier = match?.[1];
  const rest = match?.[2];
  if (identifier === undefined || rest === undefined) return undefined;
  return { identifier: parseQualifiedSqlName(identifier).name, rest };
};

const parseSqlColumnList = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  return splitTopLevel(value).map((part) => parseQualifiedSqlName(part.text.trim()).name).filter(Boolean);
};

const parseSql = (
  file: WorkspaceFile,
  variant: string,
  diagnostics: AnalysisDiagnostic[],
): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { dash: true, block: true });
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];
  const tablePattern = new RegExp(`\\bCREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\s*\\(`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(masked)) !== null) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const open = masked.lastIndexOf('(', tablePattern.lastIndex - 1);
    const close = open >= 0 ? findMatching(masked, open, '(', ')') : undefined;
    const parsedName = parseQualifiedSqlName(rawName);
    if (open < 0 || close === undefined) {
      diagnostics.push({
        code: 'DB_PARSE_PARTIAL',
        severity: 'warning',
        message: `Unclosed CREATE TABLE ${parsedName.name}.`,
        source: sourceRef(filePath, lines.lineAt(match.index)),
      });
      continue;
    }
    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    const primaryKeys: string[] = [];
    const uniqueConstraints: string[] = [];
    const body = masked.slice(open + 1, close);
    for (const segment of splitTopLevel(body)) {
      const definition = segment.text.trim();
      if (definition.length === 0) continue;
      const definitionLine = lines.lineAt(open + 1 + segment.start);
      const withoutConstraintName = definition.replace(/^CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_$][\w$]*)\s+/i, '');
      const tablePrimary = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(withoutConstraintName);
      if (tablePrimary?.[1] !== undefined) {
        primaryKeys.push(...parseSqlColumnList(tablePrimary[1]));
        continue;
      }
      const tableUnique = /^UNIQUE(?:\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_$][\w$]*))?\s*\(([^)]*)\)/i.exec(withoutConstraintName);
      if (tableUnique?.[1] !== undefined) {
        uniqueConstraints.push(parseSqlColumnList(tableUnique[1]).join(', '));
        continue;
      }
      const tableForeign = new RegExp(`^FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s+REFERENCES\\s+(${SQL_IDENTIFIER})\\s*\\(([^)]*)\\)([\\s\\S]*)$`, 'i').exec(withoutConstraintName);
      if (tableForeign !== null) {
        const target = tableForeign[2];
        if (target !== undefined) {
          relations.push({
            fieldName: parseSqlColumnList(tableForeign[1]).join(', '),
            targetName: parseQualifiedSqlName(target).name,
            relationKind: 'foreign-key',
            line: definitionLine,
            confidence: 'exact',
            localFields: parseSqlColumnList(tableForeign[1]),
            targetFields: parseSqlColumnList(tableForeign[3]),
            owning: true,
            onDelete: /ON\s+DELETE\s+([A-Z ]+?)(?=\s+ON\s+UPDATE|$)/i.exec(tableForeign[4] ?? '')?.[1]?.trim(),
            onUpdate: /ON\s+UPDATE\s+([A-Z ]+?)$/i.exec(tableForeign[4] ?? '')?.[1]?.trim(),
          });
        }
        continue;
      }
      if (/^(?:CHECK|EXCLUDE)\b/i.test(withoutConstraintName)) continue;
      const column = readSqlIdentifier(definition);
      if (column === undefined) continue;
      const constraintIndex = column.rest.search(/\s+(?:NOT\s+NULL|NULL\b|DEFAULT\b|PRIMARY\s+KEY|UNIQUE\b|REFERENCES\b|CHECK\b|CONSTRAINT\b|GENERATED\b|COLLATE\b)/i);
      const rawType = (constraintIndex < 0 ? column.rest : column.rest.slice(0, constraintIndex)).trim();
      const constraints = constraintIndex < 0 ? '' : column.rest.slice(constraintIndex).trim();
      const field: FieldFact = {
        name: column.identifier,
        type: rawType || 'unknown',
        line: definitionLine,
        columnName: column.identifier,
        primary: /\bPRIMARY\s+KEY\b/i.test(constraints),
        unique: /\bUNIQUE\b/i.test(constraints),
        nullable: /\bNOT\s+NULL\b/i.test(constraints) ? false : /(?:^|\s)NULL(?:\s|$)/i.test(constraints) ? true : undefined,
        generated: /\b(?:GENERATED|IDENTITY|AUTO_INCREMENT|AUTOINCREMENT)\b/i.test(constraints),
        defaultValue: /\bDEFAULT\s+(.+?)(?=\s+(?:PRIMARY|UNIQUE|REFERENCES|CHECK|CONSTRAINT|GENERATED|COLLATE)\b|$)/i.exec(constraints)?.[1]?.trim(),
      };
      fields.push(field);
      const inlineReference = new RegExp(`\\bREFERENCES\\s+(${SQL_IDENTIFIER})(?:\\s*\\(([^)]*)\\))?([\\s\\S]*)$`, 'i').exec(constraints);
      if (inlineReference?.[1] !== undefined) {
        relations.push({
          fieldName: field.name,
          targetName: parseQualifiedSqlName(inlineReference[1]).name,
          relationKind: 'foreign-key',
          line: definitionLine,
          confidence: 'exact',
          localFields: [field.name],
          targetFields: parseSqlColumnList(inlineReference[2]),
          owning: true,
          onDelete: /ON\s+DELETE\s+([A-Z ]+?)(?=\s+ON\s+UPDATE|$)/i.exec(inlineReference[3] ?? '')?.[1]?.trim(),
          onUpdate: /ON\s+UPDATE\s+([A-Z ]+?)$/i.exec(inlineReference[3] ?? '')?.[1]?.trim(),
        });
      }
    }
    for (const field of fields) {
      if (primaryKeys.includes(field.name)) field.primary = true;
      if (uniqueConstraints.some((constraint) => constraint.split(/\s*,\s*/).includes(field.name))) field.unique = true;
    }
    const qualifiedName = parsedName.namespace === undefined ? parsedName.name : `${parsedName.namespace}.${parsedName.name}`;
    facts.push({
      variant,
      sourceKind: 'sql',
      file: filePath,
      line: lines.lineAt(match.index),
      kind: 'table',
      logicalName: parsedName.name,
      qualifiedName,
      physicalName: parsedName.name,
      physicalNameConfidence: 'exact',
      namespace: parsedName.namespace,
      fields,
      relations,
      metadata: {
        'Primary key': primaryKeys,
        'Unique constraints': uniqueConstraints.filter(Boolean),
      },
    });
    tablePattern.lastIndex = close + 1;
  }

  const statements = splitTopLevel(masked, ';');
  for (const statement of statements) {
    const alter = new RegExp(`\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${SQL_IDENTIFIER})[\\s\\S]*?ADD\\s+(?:CONSTRAINT\\s+(?:"[^"]+"|\u0060[^\u0060]+\u0060|\\[[^\\]]+\\]|[A-Za-z_$][\\w$]*)\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s+REFERENCES\\s+(${SQL_IDENTIFIER})\\s*\\(([^)]*)\\)([\\s\\S]*)$`, 'i').exec(statement.text);
    if (alter === null || alter[1] === undefined || alter[3] === undefined) continue;
    const sourceName = parseQualifiedSqlName(alter[1]).name;
    const fact = facts.find((candidate) => candidate.logicalName.toLowerCase() === sourceName.toLowerCase());
    if (fact === undefined) continue;
    fact.relations.push({
      fieldName: parseSqlColumnList(alter[2]).join(', '),
      targetName: parseQualifiedSqlName(alter[3]).name,
      relationKind: 'foreign-key',
      line: lines.lineAt(statement.start),
      confidence: 'exact',
      localFields: parseSqlColumnList(alter[2]),
      targetFields: parseSqlColumnList(alter[4]),
      owning: true,
      onDelete: /ON\s+DELETE\s+([A-Z ]+?)(?=\s+ON\s+UPDATE|$)/i.exec(alter[5] ?? '')?.[1]?.trim(),
      onUpdate: /ON\s+UPDATE\s+([A-Z ]+?)$/i.exec(alter[5] ?? '')?.[1]?.trim(),
    });
  }
  return facts;
};

const parseTypeOrm = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  const bindings = parseTypeOrmBindings(masked);
  if (!bindings.allowCanonicalNames && bindings.localToCanonical.size === 0 && bindings.namespaces.size === 0) return [];
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];
  const classPattern = /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
  let previousClassEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = classPattern.exec(masked)) !== null) {
    const className = match[1];
    if (className === undefined) continue;
    const open = masked.lastIndexOf('{', classPattern.lastIndex - 1);
    const close = open >= 0 ? findMatching(masked, open, '{', '}') : undefined;
    if (open < 0 || close === undefined) continue;
    const classDecorators = parseDecoratorsInRange(masked, previousClassEnd, match.index);
    const entity = findDecorator(classDecorators, bindings, ['Entity', 'ViewEntity']);
    previousClassEnd = close + 1;
    classPattern.lastIndex = close + 1;
    if (entity === undefined) continue;
    const explicitName = stringOption(entity.decorator.args) ?? stringOption(entity.decorator.args, 'name');
    const schema = stringOption(entity.decorator.args, 'schema');
    const physicalName = explicitName ?? className;
    const members = scanDecoratedMembers(masked, open + 1, close, lines, bindings, 'typescript');
    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    for (const member of members) {
      const columnDecorator = findDecorator(member.decorators, bindings, [
        'Column',
        'PrimaryColumn',
        'PrimaryGeneratedColumn',
        'CreateDateColumn',
        'UpdateDateColumn',
        'DeleteDateColumn',
        'VersionColumn',
      ]);
      const relationDecorator = findDecorator(member.decorators, bindings, ['OneToOne', 'OneToMany', 'ManyToOne', 'ManyToMany']);
      if (columnDecorator !== undefined) {
        const args = columnDecorator.decorator.args;
        const firstType = stringOption(args);
        const optionType = stringOption(args, 'type');
        const columnName = stringOption(args, 'name') ?? member.name;
        const generatedDecorator = findDecorator(member.decorators, bindings, ['Generated']);
        fields.push({
          name: member.name,
          type: optionType ?? firstType ?? member.type,
          line: member.line,
          columnName,
          primary: columnDecorator.canonical === 'PrimaryColumn' || columnDecorator.canonical === 'PrimaryGeneratedColumn' || booleanOption(args, 'primary') === true,
          unique: booleanOption(args, 'unique') === true,
          nullable: booleanOption(args, 'nullable'),
          generated: columnDecorator.canonical === 'PrimaryGeneratedColumn' || generatedDecorator !== undefined,
          defaultValue: findNamedExpression(args, 'default'),
        });
      }
      if (relationDecorator !== undefined) {
        const joinColumn = findDecorator(member.decorators, bindings, ['JoinColumn']);
        const joinTable = findDecorator(member.decorators, bindings, ['JoinTable']);
        const targetName = parseArrowTarget(relationDecorator.decorator.args) ?? unwrapRelationType(member.type);
        const localColumn = stringOption(joinColumn?.decorator.args, 'name');
        const referencedColumn = stringOption(joinColumn?.decorator.args, 'referencedColumnName');
        const owning = relationDecorator.canonical === 'ManyToOne' || joinColumn !== undefined || joinTable !== undefined;
        relations.push({
          fieldName: member.name,
          targetName,
          relationKind: relationDecorator.canonical,
          line: member.line,
          confidence: parseArrowTarget(relationDecorator.decorator.args) === undefined ? 'inferred' : 'exact',
          localFields: localColumn === undefined ? [] : [localColumn],
          targetFields: referencedColumn === undefined ? [] : [referencedColumn],
          inverseField: parseInverseField(relationDecorator.decorator.args),
          owning,
          onDelete: stringOption(relationDecorator.decorator.args, 'onDelete'),
          joinTable: stringOption(joinTable?.decorator.args, 'name') ?? stringOption(joinTable?.decorator.args),
        });
        if (!fields.some((field) => field.name === member.name)) {
          fields.push({ name: member.name, type: member.type, line: member.line, relation: true });
        }
      }
    }
    const qualifiedName = schema === undefined ? className : `${schema}.${className}`;
    facts.push({
      variant,
      sourceKind: 'typeorm',
      file: filePath,
      line: lines.lineAt(entity.decorator.start),
      kind: entity.canonical === 'ViewEntity' ? 'view' : 'entity',
      logicalName: className,
      qualifiedName,
      physicalName,
      physicalNameConfidence: explicitName === undefined ? 'inferred' : 'exact',
      namespace: schema,
      fields,
      relations,
      metadata: { ORM: 'TypeORM' },
    });
  }
  return facts;
};

const jpaTargetEntity = (args: string | undefined): string | undefined => {
  const expression = findNamedExpression(args, 'targetEntity');
  if (expression === undefined) return undefined;
  return expression.replace(/::class(?:\.java)?$/, '').replace(/\.class$/, '').split('.').pop();
};

const parseJpa = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  const bindings = parseJpaBindings(masked);
  if (!bindings.allowCanonicalNames && bindings.localToCanonical.size === 0 && !/(?:jakarta|javax)\.persistence\./.test(masked)) return [];
  const lines = new LineIndex(file.content);
  const packageName = /\bpackage\s+([A-Za-z_$][\w$.]*)\s*;?/.exec(masked)?.[1];
  const facts: EntityFact[] = [];
  const classPattern = /\b(?:(?:public|protected|private|abstract|final|open|data|sealed)\s+)*class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
  let previousClassEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = classPattern.exec(masked)) !== null) {
    const className = match[1];
    if (className === undefined) continue;
    const open = masked.lastIndexOf('{', classPattern.lastIndex - 1);
    const close = open >= 0 ? findMatching(masked, open, '{', '}') : undefined;
    if (open < 0 || close === undefined) continue;
    const classDecorators = parseDecoratorsInRange(masked, previousClassEnd, match.index);
    const entityDecorator = findDecorator(classDecorators, bindings, ['Entity']);
    const mappedSuperclass = findDecorator(classDecorators, bindings, ['MappedSuperclass']);
    previousClassEnd = close + 1;
    classPattern.lastIndex = close + 1;
    if (entityDecorator === undefined && mappedSuperclass === undefined) continue;
    const tableDecorator = findDecorator(classDecorators, bindings, ['Table']);
    const tableName = stringOption(tableDecorator?.decorator.args, 'name');
    const schema = stringOption(tableDecorator?.decorator.args, 'schema');
    const members = scanDecoratedMembers(masked, open + 1, close, lines, bindings, 'jpa');
    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    const seenFields = new Set<string>();
    for (const member of members) {
      if (findDecorator(member.decorators, bindings, ['Transient']) !== undefined) continue;
      const column = findDecorator(member.decorators, bindings, ['Column']);
      const id = findDecorator(member.decorators, bindings, ['Id', 'EmbeddedId']);
      const generated = findDecorator(member.decorators, bindings, ['GeneratedValue']);
      const relation = findDecorator(member.decorators, bindings, ['OneToOne', 'OneToMany', 'ManyToOne', 'ManyToMany']);
      if (column !== undefined || id !== undefined || relation === undefined) {
        const columnName = stringOption(column?.decorator.args, 'name') ?? member.name;
        fields.push({
          name: member.name,
          type: member.type,
          line: member.line,
          columnName,
          primary: id !== undefined,
          unique: booleanOption(column?.decorator.args, 'unique') === true,
          nullable: booleanOption(column?.decorator.args, 'nullable'),
          generated: generated !== undefined,
          relation: relation !== undefined,
        });
        seenFields.add(member.name);
      }
      if (relation !== undefined) {
        const joinColumn = findDecorator(member.decorators, bindings, ['JoinColumn']);
        const joinTable = findDecorator(member.decorators, bindings, ['JoinTable']);
        const targetName = jpaTargetEntity(relation.decorator.args) ?? unwrapRelationType(member.type);
        const mappedBy = stringOption(relation.decorator.args, 'mappedBy');
        const localColumn = stringOption(joinColumn?.decorator.args, 'name');
        const referenced = stringOption(joinColumn?.decorator.args, 'referencedColumnName');
        relations.push({
          fieldName: member.name,
          targetName,
          relationKind: relation.canonical,
          line: member.line,
          confidence: jpaTargetEntity(relation.decorator.args) === undefined ? 'inferred' : 'exact',
          localFields: localColumn === undefined ? [] : [localColumn],
          targetFields: referenced === undefined ? [] : [referenced],
          inverseField: mappedBy,
          owning: mappedBy === undefined,
          onDelete: undefined,
          joinTable: stringOption(joinTable?.decorator.args, 'name'),
        });
        if (!seenFields.has(member.name)) {
          fields.push({ name: member.name, type: member.type, line: member.line, relation: true });
          seenFields.add(member.name);
        }
      }
    }

    const body = masked.slice(open + 1, close);
    const bodyOffset = open + 1;
    const javaField = /^\s*(?:(?:public|private|protected|final|volatile)\s+)+(?!static\b)(?!transient\b)([A-Za-z_$][\w$<>,.?[\] ]*)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/gm;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = javaField.exec(body)) !== null) {
      const fieldType = fieldMatch[1]?.trim();
      const fieldName = fieldMatch[2];
      if (fieldType === undefined || fieldName === undefined || seenFields.has(fieldName)) continue;
      fields.push({ name: fieldName, type: fieldType, line: lines.lineAt(bodyOffset + fieldMatch.index), columnName: fieldName, inferred: true });
      seenFields.add(fieldName);
    }
    const kotlinField = /^\s*(?:(?:public|private|protected|internal|lateinit|override|open)\s+)*(?:var|val)\s+([A-Za-z_$][\w$]*)\s*:\s*([^=\n,{]+)/gm;
    let kotlinMatch: RegExpExecArray | null;
    while ((kotlinMatch = kotlinField.exec(body)) !== null) {
      const fieldName = kotlinMatch[1];
      const fieldType = kotlinMatch[2]?.trim();
      if (fieldName === undefined || fieldType === undefined || seenFields.has(fieldName)) continue;
      fields.push({ name: fieldName, type: fieldType, line: lines.lineAt(bodyOffset + kotlinMatch.index), columnName: fieldName, inferred: true });
      seenFields.add(fieldName);
    }

    const physicalName = tableName ?? className;
    const qualifiedName = packageName === undefined ? className : `${packageName}.${className}`;
    facts.push({
      variant,
      sourceKind: 'jpa',
      file: filePath,
      line: lines.lineAt((entityDecorator ?? mappedSuperclass)?.decorator.start ?? match.index),
      kind: mappedSuperclass === undefined ? 'entity' : 'abstract-entity',
      logicalName: className,
      qualifiedName,
      physicalName,
      physicalNameConfidence: tableName === undefined ? 'inferred' : 'exact',
      namespace: schema ?? packageName,
      fields,
      relations,
      metadata: { ORM: 'JPA', Package: packageName ?? '' },
    });
  }
  return facts;
};

/** One `class X(Base):` block, with the span its indented body occupies. */
interface PythonClassBlock {
  indent: number;
  name: string;
  bases: string;
  start: number;
  bodyStart: number;
  bodyEnd: number;
}

/**
 * Python class blocks, delimited by indentation.
 *
 * A body runs until a non-blank line indented no further than the `class` line
 * itself, which is the same rule the language uses. Shared by every Python
 * reader here: Django, MongoEngine and Beanie disagree about what a model is
 * and agree completely about where a class ends.
 */
const pythonClassBlocks = (masked: string): PythonClassBlock[] => {
  const classPattern = /^([ \t]*)class\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*:/gm;
  const blocks: PythonClassBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = classPattern.exec(masked)) !== null) {
    const name = match[2];
    if (name === undefined) continue;
    const indent = indentationWidth(match[1] ?? '');
    const newline = masked.indexOf('\n', classPattern.lastIndex);
    const bodyStart = newline < 0 ? classPattern.lastIndex : newline + 1;
    let bodyEnd = masked.length;
    const linePattern = /^([ \t]*)(\S[^\n]*)/gm;
    const remaining = masked.slice(bodyStart);
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(remaining)) !== null) {
      if ((lineMatch[2] ?? '').trim().length === 0) continue;
      if (indentationWidth(lineMatch[1] ?? '') <= indent) {
        bodyEnd = bodyStart + lineMatch.index;
        break;
      }
    }
    blocks.push({ indent, name, bases: match[3] ?? '', start: match.index, bodyStart, bodyEnd });
  }
  return blocks;
};

interface DjangoBindings {
  modelNamespaces: Set<string>;
  directNames: Map<string, string>;
}

const parseDjangoBindings = (text: string): DjangoBindings => {
  const modelNamespaces = new Set<string>();
  const directNames = new Map<string, string>();
  const modelImport = /\bfrom\s+django\.db\s+import\s+models(?:\s+as\s+([A-Za-z_][\w]*))?/g;
  let modelMatch: RegExpExecArray | null;
  while ((modelMatch = modelImport.exec(text)) !== null) modelNamespaces.add(modelMatch[1] ?? 'models');
  const directImport = /\bfrom\s+django\.db\.models\s+import\s+([^\n]+)/g;
  let directMatch: RegExpExecArray | null;
  while ((directMatch = directImport.exec(text)) !== null) {
    const imports = directMatch[1];
    if (imports === undefined) continue;
    for (const part of imports.replace(/[()]/g, '').split(',')) {
      const parsed = /^\s*([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?/.exec(part);
      const canonical = parsed?.[1];
      const local = parsed?.[2] ?? canonical;
      if (canonical !== undefined && local !== undefined) directNames.set(local, canonical);
    }
  }
  return { modelNamespaces, directNames };
};

const djangoConstructor = (raw: string, bindings: DjangoBindings): string | undefined => {
  const pieces = raw.split('.');
  const last = pieces[pieces.length - 1];
  if (last === undefined) return undefined;
  if (pieces.length > 1) {
    const namespace = pieces[0];
    return namespace !== undefined && bindings.modelNamespaces.has(namespace) ? last : undefined;
  }
  return bindings.directNames.get(last);
};

const indentationWidth = (value: string): number => {
  let width = 0;
  for (const char of value) width += char === '\t' ? 4 : 1;
  return width;
};

const djangoAppLabel = (filePath: string): string => {
  const directory = dirname(filePath);
  const pieces = directory.split('/').filter((part) => part !== '.');
  const modelsIndex = pieces.lastIndexOf('models');
  if (modelsIndex > 0) return pieces[modelsIndex - 1] ?? 'app';
  return pieces[pieces.length - 1] ?? 'app';
};

const parseDjango = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { hash: true });
  const bindings = parseDjangoBindings(masked);
  if (bindings.modelNamespaces.size === 0 && ![...bindings.directNames.values()].includes('Model')) return [];
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];
  const classMatches = pythonClassBlocks(masked);

  const directModelNames = new Set<string>();
  for (const candidate of classMatches) {
    const isDirect = candidate.bases.split(',').some((base) => {
      const trimmed = base.trim();
      const qualified = /^([A-Za-z_][\w]*)\.Model$/.exec(trimmed);
      return (qualified?.[1] !== undefined && bindings.modelNamespaces.has(qualified[1])) || bindings.directNames.get(trimmed) === 'Model';
    });
    if (isDirect) directModelNames.add(candidate.name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of classMatches) {
      if (directModelNames.has(candidate.name)) continue;
      if (candidate.bases.split(',').some((base) => directModelNames.has(base.trim().split('.').pop() ?? ''))) {
        directModelNames.add(candidate.name);
        changed = true;
      }
    }
  }

  for (const candidate of classMatches) {
    if (!directModelNames.has(candidate.name)) continue;
    const body = masked.slice(candidate.bodyStart, candidate.bodyEnd);
    const metaMatch = /^([ \t]*)class\s+Meta\s*:/m.exec(body);
    let metaBody = '';
    if (metaMatch !== null) {
      const metaIndent = indentationWidth(metaMatch[1] ?? '');
      const metaStartLineEnd = body.indexOf('\n', (metaMatch.index ?? 0) + metaMatch[0].length);
      const metaStart = metaStartLineEnd < 0 ? body.length : metaStartLineEnd + 1;
      let metaEnd = body.length;
      const afterMeta = body.slice(metaStart);
      const metaLinePattern = /^([ \t]*)(\S[^\n]*)/gm;
      let metaLine: RegExpExecArray | null;
      while ((metaLine = metaLinePattern.exec(afterMeta)) !== null) {
        if (indentationWidth(metaLine[1] ?? '') <= metaIndent) {
          metaEnd = metaStart + metaLine.index;
          break;
        }
      }
      metaBody = body.slice(metaStart, metaEnd);
    }
    const configuredTable = /\bdb_table\s*=\s*(["'][^"']+["'])/.exec(metaBody)?.[1];
    const configuredApp = /\bapp_label\s*=\s*(["'][^"']+["'])/.exec(metaBody)?.[1];
    const appLabel = configuredApp === undefined ? djangoAppLabel(filePath) : unquote(configuredApp);
    const isAbstract = /\babstract\s*=\s*True\b/.test(metaBody);
    const isProxy = /\bproxy\s*=\s*True\b/.test(metaBody);
    const isManaged = !/\bmanaged\s*=\s*False\b/.test(metaBody);
    const physicalName = configuredTable === undefined ? `${appLabel}_${candidate.name.toLowerCase()}` : unquote(configuredTable);
    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    const assignment = /^([ \t]*)([A-Za-z_][\w]*)\s*=\s*((?:[A-Za-z_][\w]*\.)*[A-Za-z_][\w]*)\s*\(/gm;
    let assignmentMatch: RegExpExecArray | null;
    while ((assignmentMatch = assignment.exec(body)) !== null) {
      const indentation = indentationWidth(assignmentMatch[1] ?? '');
      if (indentation <= candidate.indent || (metaMatch !== null && assignmentMatch.index >= metaMatch.index)) continue;
      const fieldName = assignmentMatch[2];
      const rawConstructor = assignmentMatch[3];
      if (fieldName === undefined || rawConstructor === undefined) continue;
      const constructor = djangoConstructor(rawConstructor, bindings);
      if (constructor === undefined || (constructor !== 'ForeignKey' && constructor !== 'OneToOneField' && constructor !== 'ManyToManyField' && !constructor.endsWith('Field'))) continue;
      const open = body.indexOf('(', assignmentMatch.index + assignmentMatch[0].length - 1);
      const close = open >= 0 ? findMatching(body, open, '(', ')') : undefined;
      if (open < 0 || close === undefined) continue;
      const args = body.slice(open + 1, close);
      const fieldLine = lines.lineAt(candidate.bodyStart + assignmentMatch.index);
      const isRelation = constructor === 'ForeignKey' || constructor === 'OneToOneField' || constructor === 'ManyToManyField';
      const dbColumn = stringOption(args, 'db_column') ?? fieldName;
      fields.push({
        name: fieldName,
        type: constructor,
        line: fieldLine,
        columnName: dbColumn,
        primary: booleanOption(args, 'primary_key') === true,
        unique: booleanOption(args, 'unique') === true || constructor === 'OneToOneField',
        nullable: booleanOption(args, 'null'),
        generated: constructor === 'AutoField' || constructor === 'BigAutoField' || constructor === 'SmallAutoField',
        defaultValue: findNamedExpression(args, 'default'),
        relation: isRelation,
      });
      if (isRelation) {
        const first = splitTopLevel(args)[0]?.text.trim() ?? '';
        let targetName = stringOption(first) ?? first;
        targetName = targetName.replace(/^settings\.AUTH_USER_MODEL$/, 'auth.User').replace(/^['"]|['"]$/g, '');
        if (targetName === 'self') targetName = candidate.name;
        relations.push({
          fieldName,
          targetName,
          relationKind: constructor,
          line: fieldLine,
          confidence: stringOption(first) !== undefined || /^[A-Za-z_][\w.]*$/.test(first) ? 'exact' : 'unresolved',
          localFields: constructor === 'ManyToManyField' ? [] : [dbColumn],
          targetFields: stringOption(args, 'to_field') === undefined ? [] : [stringOption(args, 'to_field') ?? ''],
          owning: true,
          onDelete: findNamedExpression(args, 'on_delete')?.split('.').pop(),
          joinTable: stringOption(args, 'db_table'),
        });
      }
      assignment.lastIndex = close + 1;
    }
    if (!fields.some((field) => field.primary === true) && !isAbstract && !isProxy) {
      fields.unshift({
        name: 'id',
        type: 'AutoField',
        line: lines.lineAt(candidate.start),
        columnName: 'id',
        primary: true,
        generated: true,
        inferred: true,
      });
    }
    facts.push({
      variant,
      sourceKind: 'django',
      file: filePath,
      line: lines.lineAt(candidate.start),
      kind: isAbstract || isProxy ? 'abstract-entity' : 'entity',
      logicalName: candidate.name,
      qualifiedName: `${appLabel}.${candidate.name}`,
      physicalName,
      physicalNameConfidence: configuredTable === undefined ? 'inferred' : 'exact',
      namespace: appLabel,
      fields,
      relations,
      metadata: {
        ORM: 'Django',
        Abstract: String(isAbstract),
        Proxy: String(isProxy),
        Managed: String(isManaged),
      },
    });
  }
  return facts;
};

/** `TodoItem` to `todo_item`: the casing every one of these ORMs defaults to. */
const snakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/**
 * Enough English to guess a table name the way GORM does. It is a guess, and
 * the fact records it as one: an entity whose name came from here is marked
 * inferred, so a wrong plural is visible rather than asserted.
 */
const pluralize = (value: string): string => {
  if (/[^aeiou]y$/.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(value)) return `${value}es`;
  return `${value}s`;
};

/** Go's own scalars, plus the wrappers that hold one. Never a relationship. */
const GO_SCALARS = new Set([
  'string', 'bool', 'byte', 'rune', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
]);

/** The columns `gorm.Model` contributes to every struct that embeds it. */
const GORM_MODEL_FIELDS: readonly { name: string; type: string; primary?: boolean }[] = [
  { name: 'ID', type: 'uint', primary: true },
  { name: 'CreatedAt', type: 'time.Time' },
  { name: 'UpdatedAt', type: 'time.Time' },
  { name: 'DeletedAt', type: 'gorm.DeletedAt' },
];

interface GoTag {
  /** `gorm:"column:name;not null"` split into its settings, lower-cased keys. */
  settings: Map<string, string>;
  present: boolean;
}

const parseGoTag = (raw: string | undefined): GoTag => {
  const settings = new Map<string, string>();
  const body = raw?.match(/\bgorm:"([^"]*)"/)?.[1];
  if (body === undefined) {
    return { settings, present: false };
  }
  for (const part of body.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const divider = trimmed.indexOf(':');
    if (divider < 0) {
      settings.set(trimmed.toLowerCase(), '');
    } else {
      settings.set(trimmed.slice(0, divider).trim().toLowerCase(), trimmed.slice(divider + 1).trim());
    }
  }
  return { settings, present: true };
};

/**
 * GORM models.
 *
 * A Go struct is only a table because something maps it, so the file has to
 * import GORM before any of its structs are read as entities — otherwise every
 * request payload and config struct in the workspace turns up in the schema.
 *
 * A field is a relationship when its type is a bare capitalised name: that is a
 * struct in the same package. `time.Time` and `sql.NullString` are values, and
 * a relationship to another package's type is missed rather than guessed at.
 */
const parseGorm = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  if (!/["`](?:gorm\.io\/gorm|github\.com\/jinzhu\/gorm)["`]/.test(masked)) {
    return [];
  }
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];

  // `func (User) TableName() string { return "users" }`, in either receiver form.
  const tableNames = new Map<string, string>();
  for (const match of masked.matchAll(
    /func\s*\(\s*(?:\w+\s+)?\*?([A-Za-z_]\w*)\s*\)\s*TableName\s*\(\s*\)\s*string\s*\{[^}]*return\s+"([^"]*)"/g,
  )) {
    const [, typeName, tableName] = match;
    if (typeName && tableName) {
      tableNames.set(typeName, tableName);
    }
  }

  const structPattern = /(?:^|\n)\s*type\s+([A-Za-z_]\w*)\s+struct\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = structPattern.exec(masked)) !== null) {
    const typeName = match[1];
    const bodyStart = structPattern.lastIndex;
    const bodyEnd = matchingBrace(masked, bodyStart - 1);
    if (!typeName || bodyEnd < 0) continue;

    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];
    let embedsModel = false;

    // The offset is carried along rather than searched for: two identical
    // lines in one struct would otherwise both report the first one's number.
    let at = bodyStart;
    for (const raw of masked.slice(bodyStart, bodyEnd).split('\n')) {
      const line = lines.lineAt(at);
      at += raw.length + 1;
      const text = raw.trim();
      if (!text) continue;

      const tagged = /^(.*?)\s*`([^`]*)`\s*$/.exec(text);
      const declaration = (tagged?.[1] ?? text).trim();
      const tag = parseGoTag(tagged?.[2]);
      if (tag.settings.get('-') !== undefined || tag.settings.has('-')) continue;

      const named = /^([A-Za-z_]\w*)\s+(.+)$/.exec(declaration);
      if (!named) {
        if (/^(?:gorm\.)?Model$/.test(declaration)) embedsModel = true;
        continue;
      }
      const [, fieldName = '', rawType = ''] = named;
      const isSlice = rawType.startsWith('[]');
      const baseType = rawType.replace(/^\[\]/, '').replace(/^\*/, '');
      const relatesTo = /^[A-Z]\w*$/.test(baseType) && !GO_SCALARS.has(baseType) ? baseType : undefined;

      if (relatesTo) {
        const foreignKey = tag.settings.get('foreignkey');
        const references = tag.settings.get('references');
        const joinTable = tag.settings.get('many2many');
        // The key sits on whichever side holds the reference: on this struct
        // for a belongs-to, and on the other one for a has-many. Reporting it
        // on the wrong side names a column that is not there.
        const onTarget = isSlice || Boolean(joinTable);
        relations.push({
          fieldName,
          targetName: relatesTo,
          relationKind: joinTable ? 'many-to-many' : isSlice ? 'has-many' : 'belongs-to',
          line,
          confidence: foreignKey || joinTable ? 'exact' : 'inferred',
          // Without a tag GORM looks for `<Field>ID`, which is a convention;
          // the pass below drops the guess unless the struct really has it.
          localFields: onTarget ? [] : foreignKey ? [foreignKey] : [`${fieldName}ID`],
          targetFields: onTarget && foreignKey ? [foreignKey] : references ? [references] : [],
          ...(joinTable ? { joinTable } : {}),
        });
        continue;
      }

      const primary = tag.settings.has('primarykey') || tag.settings.has('primary_key') || fieldName === 'ID';
      fields.push({
        name: fieldName,
        type: rawType,
        line,
        columnName: tag.settings.get('column') ?? snakeCase(fieldName),
        primary,
        unique: tag.settings.has('unique') || tag.settings.has('uniqueindex'),
        // GORM leaves a column nullable unless told otherwise — but never the
        // key, whether or not the struct bothered to say so.
        nullable: !primary && (rawType.startsWith('*') || !tag.settings.has('not null')),
        ...(tag.settings.has('autoincrement') ? { generated: true } : {}),
        ...(tag.settings.get('default') ? { defaultValue: tag.settings.get('default') ?? '' } : {}),
        ...(tag.present ? {} : { inferred: true }),
      });
    }

    // The convention only holds when the column is there; `Profile Profile`
    // with no `ProfileID` beside it is a relationship whose key this parser
    // cannot see, and saying `ProfileID` would be inventing one.
    const declared = new Set(fields.map((field) => field.name));
    for (const relation of relations) {
      if (relation.confidence === 'inferred') {
        relation.localFields = relation.localFields.filter((name) => declared.has(name));
      }
    }

    if (embedsModel) {
      fields.unshift(...GORM_MODEL_FIELDS.map((field) => ({
        name: field.name,
        type: field.type,
        line: lines.lineAt(match?.index ?? 0),
        columnName: snakeCase(field.name),
        ...(field.primary ? { primary: true, generated: true } : {}),
        inferred: true,
      })));
    }
    if (!fields.length && !relations.length) continue;

    const configured = tableNames.get(typeName);
    facts.push({
      variant,
      sourceKind: 'gorm',
      file: filePath,
      line: lines.lineAt(match.index),
      kind: 'entity',
      logicalName: typeName,
      qualifiedName: typeName,
      physicalName: configured ?? pluralize(snakeCase(typeName)),
      physicalNameConfidence: configured === undefined ? 'inferred' : 'exact',
      fields,
      relations,
      metadata: { ORM: 'GORM', 'Embeds gorm.Model': String(embedsModel) },
    });
  }
  return facts;
};

/** The column builders drift exposes, and the SQL type each one stands for. */
const DRIFT_COLUMN_TYPES: Record<string, string> = {
  integer: 'INTEGER',
  int64: 'BIGINT',
  text: 'TEXT',
  boolean: 'BOOLEAN',
  dateTime: 'TIMESTAMP',
  real: 'REAL',
  blob: 'BLOB',
};

/**
 * Drift tables.
 *
 * A drift table is a Dart class extending `Table` whose columns are getters
 * built by chaining: `IntColumn get id => integer().autoIncrement()();`. The
 * chain is the declaration — `nullable()`, `unique()`, `references()` and
 * `named()` each say something the ERD needs — so it is the chain that is read
 * rather than the getter's return type.
 */
const parseDrift = (file: WorkspaceFile, variant: string): EntityFact[] => {
  const filePath = normalizePath(file.path);
  const masked = maskComments(file.content, { slash: true, block: true });
  if (!/package:(?:drift|moor)\//.test(masked)) {
    return [];
  }
  const lines = new LineIndex(file.content);
  const facts: EntityFact[] = [];

  const classPattern = /(?:^|\n)\s*(?:abstract\s+)?class\s+([A-Za-z_]\w*)\s+extends\s+Table\b[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = classPattern.exec(masked)) !== null) {
    const className = match[1];
    const bodyStart = classPattern.lastIndex;
    const bodyEnd = matchingBrace(masked, bodyStart - 1);
    if (!className || bodyEnd < 0) continue;
    const body = masked.slice(bodyStart, bodyEnd);

    const fields: FieldFact[] = [];
    const relations: RelationFact[] = [];

    const columnPattern = /(\w+Column(?:<[^>]*>)?)\s+get\s+(\w+)\s*=>\s*([^;]+);/g;
    let column: RegExpExecArray | null;
    while ((column = columnPattern.exec(body)) !== null) {
      const [, , name = '', chain = ''] = column;
      const builder = /^\s*(\w+)\s*\(/.exec(chain)?.[1] ?? '';
      const line = lines.lineAt(bodyStart + column.index);
      const reference = /\.references\s*\(\s*([A-Za-z_]\w*)\s*,\s*#(\w+)/.exec(chain);

      fields.push({
        name,
        type: DRIFT_COLUMN_TYPES[builder] ?? builder.toUpperCase(),
        line,
        columnName: /\.named\s*\(\s*['"]([^'"]+)['"]/.exec(chain)?.[1] ?? name,
        primary: /\.autoIncrement\s*\(/.test(chain),
        unique: /\.unique\s*\(/.test(chain),
        nullable: /\.nullable\s*\(/.test(chain),
        ...(/\.autoIncrement\s*\(/.test(chain) ? { generated: true } : {}),
        ...(reference ? { relation: true } : {}),
        ...(/\.withDefault\s*\(|\.clientDefault\s*\(/.test(chain) ? { defaultValue: 'default' } : {}),
      });

      if (reference?.[1] && reference[2]) {
        relations.push({
          fieldName: name,
          targetName: reference[1],
          relationKind: 'foreign-key',
          line,
          confidence: 'exact',
          localFields: [name],
          targetFields: [reference[2]],
        });
      }
    }
    if (!fields.length) continue;

    // `@override String get tableName => 'todo_items';`
    const configured = /String\s+get\s+tableName\s*=>\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    // Drift's own default is the class name in snake case; it is already plural
    // by the convention drift asks its users to follow.
    const primaryKey = /Set<Column>\s+get\s+primaryKey\s*=>\s*\{([^}]*)\}/.exec(body)?.[1];
    if (primaryKey) {
      const named = new Set(primaryKey.split(',').map((part) => part.trim()).filter(Boolean));
      for (const field of fields) {
        field.primary = named.has(field.name);
      }
    }

    facts.push({
      variant,
      sourceKind: 'drift',
      file: filePath,
      line: lines.lineAt(match.index),
      kind: 'table',
      logicalName: className,
      qualifiedName: className,
      physicalName: configured ?? snakeCase(className),
      physicalNameConfidence: configured === undefined ? 'inferred' : 'exact',
      fields,
      relations,
      metadata: {
        ORM: 'Drift',
        ...(/@DataClassName\s*\(\s*['"]([^'"]+)['"]/.exec(masked.slice(Math.max(0, match.index - 120), match.index))
          ? { 'Row class': /@DataClassName\s*\(\s*['"]([^'"]+)['"]/.exec(masked.slice(Math.max(0, match.index - 120), match.index))?.[1] ?? '' }
          : {}),
      },
    });
  }
  return facts;
};

/** The index of the `}` closing the `{` at `open`, or -1 when it is unbalanced. */
const matchingBrace = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const entityNodeId = (fact: EntityFact): string =>
  stableId('db-node', fact.logicalName, fact.variant, fact.kind, fact.qualifiedName, fact.file);

const targetAliases = (fact: EntityFact): string[] => {
  // Folded to lower case before they are deduplicated, not after. An entity
  // whose table name is its own name in another case — `Categories` stored as
  // `categories`, which is what most ORMs default to — would otherwise register
  // itself under that name twice and then be reported as an ambiguous target
  // against itself.
  const aliases = new Set<string>([
    fact.logicalName.toLowerCase(),
    fact.qualifiedName.toLowerCase(),
    fact.physicalName.toLowerCase(),
  ]);
  if (fact.namespace !== undefined) {
    aliases.add(`${fact.namespace}.${fact.logicalName}`.toLowerCase());
    aliases.add(`${fact.namespace}.${fact.physicalName}`.toLowerCase());
  }
  for (const alias of fact.aliases ?? []) {
    aliases.add(alias.toLowerCase());
  }
  return [...aliases];
};

const normalizeTargetName = (value: string): string =>
  unquote(value.trim())
    .replace(/\.class$/, '')
    .replace(/::class(?:\.java)?$/, '')
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();

const shouldSkipInverseRelation = (fact: EntityFact, relation: RelationFact, facts: readonly EntityFact[]): boolean => {
  if (relation.owning !== false) return false;
  const target = normalizeTargetName(relation.targetName).split('.').pop() ?? '';
  return facts.some((candidate) => {
    if (candidate.variant !== fact.variant || candidate.logicalName.toLowerCase() !== target) return false;
    return candidate.relations.some((candidateRelation) => {
      const candidateTarget = normalizeTargetName(candidateRelation.targetName).split('.').pop() ?? '';
      return candidateTarget === fact.logicalName.toLowerCase() && candidateRelation.owning !== false;
    });
  });
};

const selectPrismaRelations = (facts: readonly EntityFact[]): Set<RelationFact> => {
  const selected = new Set<RelationFact>();
  const groups = new Map<string, Array<{ fact: EntityFact; relation: RelationFact }>>();
  for (const fact of facts) {
    if (fact.sourceKind !== 'prisma') continue;
    for (const relation of fact.relations) {
      const pair = [fact.logicalName.toLowerCase(), normalizeTargetName(relation.targetName).split('.').pop() ?? ''].sort().join('|');
      const key = `${fact.variant}|${pair}|${relation.relationName ?? ''}`;
      const entries = groups.get(key) ?? [];
      entries.push({ fact, relation });
      groups.set(key, entries);
    }
  }
  for (const entries of groups.values()) {
    entries.sort((left, right) => {
      const owningDifference = Number(right.relation.localFields.length > 0) - Number(left.relation.localFields.length > 0);
      if (owningDifference !== 0) return owningDifference;
      const leftKey = `${left.fact.logicalName}.${left.relation.fieldName}`;
      const rightKey = `${right.fact.logicalName}.${right.relation.fieldName}`;
      return leftKey.localeCompare(rightKey);
    });
    const chosen = entries[0];
    if (chosen !== undefined) selected.add(chosen.relation);
  }
  return selected;
};

/**
 * Builds the metadata shown verbatim in the webview details panel, so every key
 * is a human-readable label. Empty strings and empty arrays are dropped, and
 * `overrides` (supplied by a parser) wins over the derived defaults.
 */
const displayMetadata = (
  base: Record<string, string | string[]>,
  overrides: Record<string, string | string[]> = {},
): Record<string, string | string[]> => {
  const merged: Record<string, string | string[]> = {};
  for (const [label, value] of [...Object.entries(base), ...Object.entries(overrides)]) {
    if (typeof value === 'string' ? value.length === 0 : value.length === 0) {
      // `Fields` stays visible even when empty so an entity without columns still
      // reports that fact; everything else is omitted rather than shown blank.
      if (label !== 'Fields') continue;
    }
    merged[label] = value;
  }
  return merged;
};

const buildGraph = (
  facts: EntityFact[],
  diagnostics: AnalysisDiagnostic[],
): DiagramGraph => {
  const sortedFacts = [...facts].sort((left, right) =>
    left.variant.localeCompare(right.variant)
      || left.qualifiedName.localeCompare(right.qualifiedName)
      || left.file.localeCompare(right.file)
      || left.line - right.line,
  );
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const aliases = new Map<string, EntityFact[]>();
  for (const fact of sortedFacts) {
    for (const alias of targetAliases(fact)) {
      const key = `${fact.variant}|${alias}`;
      const values = aliases.get(key) ?? [];
      values.push(fact);
      aliases.set(key, values);
    }
    const primaryKeys = fact.fields.filter((field) => field.primary === true).map((field) => field.columnName ?? field.name);
    const uniqueFields = fact.fields.filter((field) => field.unique === true).map((field) => field.columnName ?? field.name);
    nodes.push({
      id: entityNodeId(fact),
      kind: fact.kind,
      label: fact.logicalName,
      subtitle: fact.physicalName === fact.logicalName
        ? `${fact.sourceKind} · ${fact.file}`
        : `${fact.physicalName} · ${fact.sourceKind}`,
      group: fact.variant,
      source: sourceRef(fact.file, fact.line),
      confidence: 'exact',
      // Parser metadata already uses display labels and wins over the derived
      // defaults below, so a table-level primary key beats the per-field guess.
      metadata: displayMetadata({
        Fields: fact.fields.map(formatField),
        'Schema group': fact.variant,
        'Source kind': fact.sourceKind,
        'Qualified name': fact.qualifiedName === fact.logicalName ? '' : fact.qualifiedName,
        'Physical name': fact.physicalName,
        'Physical name confidence': fact.physicalNameConfidence,
        Namespace: fact.namespace ?? '',
        'Primary key': primaryKeys,
        'Unique fields': uniqueFields,
        ...(SCHEMALESS_SOURCES.has(fact.sourceKind)
          ? { 'Schema enforcement': 'Declared in application code. The database accepts documents that do not match.' }
          : {}),
      }, fact.metadata),
    });
  }

  const prismaRelations = selectPrismaRelations(sortedFacts);
  const placeholderNodes = new Map<string, DiagramNode>();
  const edgeKeys = new Set<string>();
  for (const fact of sortedFacts) {
    for (const relation of fact.relations) {
      if (fact.sourceKind === 'prisma' && !prismaRelations.has(relation)) continue;
      if ((fact.sourceKind === 'typeorm' || fact.sourceKind === 'jpa') && shouldSkipInverseRelation(fact, relation, sortedFacts)) continue;
      const normalizedTarget = normalizeTargetName(relation.targetName);
      const simpleTarget = normalizedTarget.split('.').pop() ?? normalizedTarget;
      const exactCandidates = aliases.get(`${fact.variant}|${normalizedTarget}`) ?? [];
      const simpleCandidates = aliases.get(`${fact.variant}|${simpleTarget}`) ?? [];
      const candidates = exactCandidates.length > 0 ? exactCandidates : simpleCandidates;
      let targetId: string;
      let confidence = relation.confidence;
      if (candidates.length === 1 && candidates[0] !== undefined) {
        targetId = entityNodeId(candidates[0]);
      } else {
        confidence = 'unresolved';
        const placeholderKey = `${fact.variant}|${normalizedTarget}`;
        const existing = placeholderNodes.get(placeholderKey);
        if (existing !== undefined) {
          targetId = existing.id;
        } else {
          targetId = stableId('db-unresolved', relation.targetName, fact.variant, normalizedTarget);
          const placeholder: DiagramNode = {
            id: targetId,
            kind: 'unresolved-entity',
            label: relation.targetName || 'Unknown',
            subtitle: 'Unresolved relation target',
            group: fact.variant,
            source: sourceRef(fact.file, relation.line),
            confidence: 'unresolved',
            metadata: displayMetadata({
              Fields: [],
              'Schema group': fact.variant,
              'Source kind': fact.sourceKind,
              'Referenced from': fact.file,
              'Unresolved target': relation.targetName,
            }),
          };
          placeholderNodes.set(placeholderKey, placeholder);
          nodes.push(placeholder);
        }
        diagnostics.push({
          code: candidates.length > 1 ? 'DB_AMBIGUOUS_RELATION' : 'DB_UNRESOLVED_RELATION',
          severity: 'warning',
          message: candidates.length > 1
            ? `Relation ${fact.logicalName}.${relation.fieldName} has multiple targets named ${relation.targetName}.`
            : `Could not resolve relation ${fact.logicalName}.${relation.fieldName} to ${relation.targetName}.`,
          source: sourceRef(fact.file, relation.line),
        });
      }
      const fromId = entityNodeId(fact);
      const edgeKey = [
        fact.variant,
        fromId,
        targetId,
        relation.relationKind,
        relation.fieldName,
        relation.localFields.join(','),
        relation.targetFields.join(','),
      ].join('|');
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      const mapping = relation.localFields.length > 0
        ? `${relation.localFields.join(', ')} → ${relation.targetFields.length > 0 ? relation.targetFields.join(', ') : '?'}`
        : relation.fieldName;
      edges.push({
        id: stableId('db-edge', relation.fieldName || relation.relationKind, edgeKey),
        from: fromId,
        to: targetId,
        // Embedding is containment, not a link between two stored rows: the
        // target has no independent existence, and the diagram should not draw
        // it as though following the line were a second lookup.
        kind: relation.relationKind === 'foreign-key'
          ? 'foreign-key'
          : relation.relationKind.startsWith('embeds') ? 'embeds' : 'relation',
        label: `${relation.relationKind}: ${mapping}`,
        confidence,
        source: sourceRef(fact.file, relation.line),
        metadata: displayMetadata({
          'Local fields': relation.localFields,
          References: relation.targetFields,
          'Schema group': fact.variant,
          'Source kind': fact.sourceKind,
          'Relation field': relation.fieldName,
          'Relation name': relation.relationName ?? '',
          'Inverse field': relation.inverseField ?? '',
          Owning: String(relation.owning ?? false),
          'On delete': relation.onDelete ?? '',
          'On update': relation.onUpdate ?? '',
          'Join table': relation.joinTable ?? '',
        }),
      });
    }
  }

  nodes.sort((left, right) => left.group?.localeCompare(right.group ?? '') || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  return {
    kind: 'database',
    nodes,
    edges,
    emptyMessage: 'No supported database schemas or ORM entities were found in this workspace.',
  };
};

const sortDiagnostics = (diagnostics: AnalysisDiagnostic[]): AnalysisDiagnostic[] =>
  diagnostics.sort((left, right) =>
    (left.source?.file ?? '').localeCompare(right.source?.file ?? '')
      || (left.source?.line ?? 0) - (right.source?.line ?? 0)
      || left.code.localeCompare(right.code)
      || left.message.localeCompare(right.message),
  );

export const analyzeDatabase = (
  files: WorkspaceFile[],
): { graph: DiagramGraph; diagnostics: AnalysisDiagnostic[] } => {
  const diagnostics: AnalysisDiagnostic[] = [];
  const facts: EntityFact[] = [];
  const sortedFiles = [...files].sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path)));
  const variantFor = buildVariantResolver(sortedFiles);
  for (const file of sortedFiles) {
    const path = normalizePath(file.path);
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith('.prisma')) {
      facts.push(...parsePrisma(file, variantFor('prisma', path), diagnostics));
    } else if (lowerPath.endsWith('.sql')) {
      facts.push(...parseSql(file, variantFor('sql', path), diagnostics));
    } else if (/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(lowerPath)) {
      // One file can hold a relational entity and a document schema at once —
      // an application migrating between the two routinely does — so these run
      // alongside each other rather than as branches of the same choice.
      facts.push(...parseTypeOrm(file, variantFor('typeorm', path)));
      facts.push(...parseDocumentSchemas(file, variantFor('mongoose', path), 'mongoose'));
      facts.push(...parseDocumentSchemas(file, variantFor('dynamoose', path), 'dynamoose'));
      facts.push(...parseTypegoose(file, variantFor('typegoose', path)));
    } else if (/\.(?:java|kt|kts)$/.test(lowerPath)) {
      facts.push(...parseJpa(file, variantFor('jpa', path)));
      facts.push(...parseSpringMongo(file, variantFor('spring-mongo', path)));
    } else if (lowerPath.endsWith('.py')) {
      facts.push(...parseDjango(file, variantFor('django', path)));
      facts.push(...parseMongoengine(file, variantFor('mongoengine', path)));
      facts.push(...parseBeanie(file, variantFor('beanie', path)));
    } else if (lowerPath.endsWith('.go')) {
      facts.push(...parseGorm(file, variantFor('gorm', path)));
    } else if (lowerPath.endsWith('.dart')) {
      facts.push(...parseDrift(file, variantFor('drift', path)));
    }
  }
  const schemaless = [...new Set(
    facts.filter((fact) => SCHEMALESS_SOURCES.has(fact.sourceKind))
      .map((fact) => String(fact.metadata.ORM ?? fact.sourceKind)),
  )].sort();
  if (schemaless.length > 0) {
    diagnostics.push({
      code: 'DB_SCHEMALESS_SOURCE',
      severity: 'info',
      message: `${schemaless.join(', ')} ${schemaless.length === 1 ? 'declares' : 'declare'} a document shape in application code. `
        + 'A document store enforces none of it, so a collection may hold documents these diagrams do not describe, '
        + 'and a reference may point at a document that no longer exists.',
    });
  }
  const graph = buildGraph(facts, diagnostics);
  return { graph, diagnostics: sortDiagnostics(diagnostics) };
};
