/** WB 请求与缓存键的稳定序列化：可验证类型显式编码；无法建立稳定身份的值一律 fail-closed。 */
const MAX_SERIALIZE_NODES = 10_000;
const MAX_SERIALIZE_OUTPUT = 1_000_000;
// 缓存键只接受小型可验证输入；大二进制必须先做内容哈希，不进入 React 请求键。
const MAX_BINARY_BYTES = 65_536;

interface SerializeContext {
  seen: WeakSet<object>;
  memo: WeakMap<object, string>;
  nodes: number;
  output: number;
}

function consumeNode(context: SerializeContext): void {
  context.nodes += 1;
  if (context.nodes > MAX_SERIALIZE_NODES)
    throw new Error("stable_serialize_too_complex");
}

function isElementIndex(name: string, length: number): boolean {
  const index = Number(name);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === name
  );
}

function account(result: string, context: SerializeContext): string {
  context.output += result.length;
  if (context.output > MAX_SERIALIZE_OUTPUT)
    throw new Error("stable_serialize_too_complex");
  return result;
}

function readDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  context: SerializeContext,
): string {
  if (!descriptor || !("value" in descriptor))
    throw new Error("stable_serialize_accessor_unsupported");
  return serialize(descriptor.value, context);
}

function ownPropertyEntries(
  value: object,
  context: SerializeContext,
  names = Object.getOwnPropertyNames(value),
): string {
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error("stable_serialize_symbol_key_unsupported");
  return names
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${readDataDescriptor(Object.getOwnPropertyDescriptor(value, key), context)}`,
    )
    .join(",");
}

function constructorName(prototype: object | null): string {
  const descriptor = prototype
    ? Object.getOwnPropertyDescriptor(prototype, "constructor")
    : undefined;
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "function"
    ? descriptor.value.name || "anonymous"
    : "unknown";
}

function requirePrototype(value: object, expected: object): void {
  if (Object.getPrototypeOf(value) !== expected)
    throw new Error("stable_serialize_class_unsupported");
}

const VIEW_PROTOTYPES = new Set<object>([
  ArrayBuffer.prototype,
  DataView.prototype,
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
]);

function serialize(value: unknown, context: SerializeContext): string {
  consumeNode(context);
  if (value === undefined) return account("undefined", context);
  if (value === null) return account("null", context);
  const kind = typeof value;
  if (kind === "string")
    return account(`string:${JSON.stringify(value)}`, context);
  if (kind === "number")
    return account(
      `number:${Object.is(value, -0) ? "-0" : String(value)}`,
      context,
    );
  if (kind === "boolean" || kind === "bigint")
    return account(`${kind}:${String(value)}`, context);
  if (kind === "function")
    throw new Error("stable_serialize_function_unsupported");
  if (kind === "symbol") throw new Error("stable_serialize_symbol_unsupported");

  const object = value as object;
  if (context.seen.has(object))
    throw new Error("stable_serialize_circular_unsupported");
  const memoized = context.memo.get(object);
  if (memoized !== undefined) return account(memoized, context);
  context.seen.add(object);
  try {
    let result: string;
    if (value instanceof Date) {
      requirePrototype(value, Date.prototype);
      const time = Date.prototype.getTime.call(value) as number;
      result = `date:${Number.isNaN(time) ? "invalid" : new Date(time).toISOString()}:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof RegExp) {
      requirePrototype(value, RegExp.prototype);
      result = `regexp:${RegExp.prototype.toString.call(value)}:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof URL) {
      requirePrototype(value, URL.prototype);
      result = `url:${URL.prototype.toString.call(value)}:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof Number) {
      requirePrototype(value, Number.prototype);
      result = `boxed-number:${serialize(Number.prototype.valueOf.call(value), context)}:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof Boolean) {
      requirePrototype(value, Boolean.prototype);
      result = `boxed-boolean:${serialize(Boolean.prototype.valueOf.call(value), context)}:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof String) {
      requirePrototype(value, String.prototype);
      result = `boxed-string:${serialize(String.prototype.valueOf.call(value), context)}:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof Map) {
      requirePrototype(value, Map.prototype);
      const entries = [...Map.prototype.entries.call(value)]
        .map(
          ([key, item]) =>
            `${serialize(key, context)}=>${serialize(item, context)}`,
        )
        .sort();
      result = `map:{${entries.join(",")}}:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof Set) {
      requirePrototype(value, Set.prototype);
      result = `set:[${[...Set.prototype.values.call(value)]
        .map((item) => serialize(item, context))
        .sort()
        .join(",")}]:{${ownPropertyEntries(value, context)}}`;
    } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      if (!VIEW_PROTOTYPES.has(Object.getPrototypeOf(value)))
        throw new Error("stable_serialize_class_unsupported");
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (bytes.length > MAX_BINARY_BYTES)
        throw new Error("stable_serialize_binary_too_large");
      const binary = `binary:${constructorName(Object.getPrototypeOf(value))}:${Array.from(bytes).join(",")}`;
      // Typed-array indices are already covered by the binary payload; only extra named properties remain.
      const rawLength =
        ArrayBuffer.isView(value) && "length" in value ? value.length : 0;
      const elementCount =
        typeof rawLength === "number" &&
        Number.isSafeInteger(rawLength) &&
        rawLength >= 0
          ? rawLength
          : 0;
      const extraNames = Object.getOwnPropertyNames(value).filter((name) => {
        return !isElementIndex(name, elementCount);
      });
      result = `${account(binary, context)}:{${ownPropertyEntries(value, context, extraNames)}}`;
    } else if (Array.isArray(value)) {
      requirePrototype(value, Array.prototype);
      const items: string[] = [];
      const extraNames: string[] = [];
      for (const name of Object.getOwnPropertyNames(value)) {
        if (name === "length") continue;
        if (isElementIndex(name, value.length)) continue;
        extraNames.push(name);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor) items.push(readDataDescriptor(descriptor, context));
        else {
          consumeNode(context);
          items.push(account("hole", context));
        }
      }
      result = `[${items.join(",")}]:{${ownPropertyEntries(value, context, extraNames)}}`;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("stable_serialize_class_unsupported");
      result = `{${ownPropertyEntries(value, context)}}`;
    }
    context.memo.set(object, result);
    return result;
  } finally {
    context.seen.delete(object);
  }
}

export function stableSerialize(value: unknown): string {
  const result = serialize(value, {
    seen: new WeakSet<object>(),
    memo: new WeakMap<object, string>(),
    nodes: 0,
    output: 0,
  });
  if (result.length > MAX_SERIALIZE_OUTPUT)
    throw new Error("stable_serialize_too_complex");
  return result;
}
