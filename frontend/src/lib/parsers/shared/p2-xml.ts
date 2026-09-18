/**
 * The smallest XML reader that can read an iPoker hand history, and nothing
 * more.
 *
 * iPoker is the one room in this project that does not ship text, and adding an
 * XML dependency for it is not on the table. The browser already has
 * `DOMParser`, so that is used when it exists; Node - which is where the test
 * suite runs - does not have it, so a scanner for the subset iPoker actually
 * emits stands in. Both paths produce the same `XmlElement` tree, and
 * `backend/test/p2Xml.test.ts` asserts that they agree wherever both are
 * available.
 *
 * The subset is deliberately narrow: elements, attributes, text, comments and
 * the XML declaration. No namespaces, no DTDs, no CDATA, no processing
 * instructions beyond the declaration. An iPoker export contains none of those,
 * and silently half-supporting them would be worse than not supporting them.
 */

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Direct text content, with entities resolved and edges trimmed. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Resolves the five XML entities plus numeric character references. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/* ------------------------------------------------------------- the scanner - */

interface Frame {
  element: XmlElement;
  text: string[];
}

/**
 * Reads the document with a hand-rolled scanner.
 *
 * Exported so the tests can exercise it even in a browser-like environment,
 * where `parseXml` would otherwise take the `DOMParser` path.
 */
export function scanXml(source: string): XmlElement | null {
  const text = source.replace(/^\uFEFF/, "");
  const stack: Frame[] = [];
  let root: XmlElement | null = null;
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0) {
      break;
    }
    if (stack.length > 0) {
      stack[stack.length - 1].text.push(text.slice(i, open));
    }

    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("<!", open)) {
      const end = text.indexOf(">", open + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }

    const close = findTagEnd(text, open);
    if (close < 0) {
      return null;
    }
    const body = text.slice(open + 1, close);
    i = close + 1;

    if (body.startsWith("/")) {
      const frame = stack.pop();
      if (!frame) {
        return null;
      }
      frame.element.text = decodeEntities(frame.text.join("")).trim();
      if (stack.length === 0) {
        root ??= frame.element;
      }
      continue;
    }

    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const name = inner.match(/^[^\s/]+/)?.[0];
    if (!name) {
      return null;
    }
    const element: XmlElement = {
      tag: name,
      attrs: readAttributes(inner.slice(name.length)),
      children: [],
      text: "",
    };
    stack[stack.length - 1]?.element.children.push(element);
    if (selfClosing) {
      if (stack.length === 0) {
        root ??= element;
      }
      continue;
    }
    stack.push({ element, text: [] });
  }

  return stack.length === 0 ? root : null;
}

/** Index of the `>` that closes the tag opened at `open`, quotes respected. */
function findTagEnd(text: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return i;
    }
  }
  return -1;
}

function readAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    attrs[match[1]] = decodeEntities(match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/* --------------------------------------------------------------- DOMParser - */

function fromDom(node: Element): XmlElement {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(node.attributes)) {
    attrs[attr.name] = attr.value;
  }
  const children = Array.from(node.children).map((child) => fromDom(child));
  const text = Array.from(node.childNodes)
    .filter((child) => child.nodeType === 3)
    .map((child) => child.nodeValue ?? "")
    .join("")
    .trim();
  return { tag: node.nodeName, attrs, children, text };
}

/**
 * Parses an XML document into an `XmlElement` tree, or null when it is not
 * well formed.
 *
 * Never throws: a malformed upload has to become a `ConversionFailure`, not a
 * crash in the browser tab.
 */
export function parseXml(source: string): XmlElement | null {
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (Parser) {
    try {
      const doc = new Parser().parseFromString(source.replace(/^\uFEFF/, ""), "text/xml");
      const root = doc.documentElement;
      // `parsererror` is how DOMParser reports a broken document; the element
      // is in a different namespace but checking the tag name is enough here.
      if (!root || root.nodeName === "parsererror" || doc.querySelector("parsererror")) {
        return null;
      }
      return fromDom(root);
    } catch {
      return null;
    }
  }
  try {
    return scanXml(source);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- lookups - */

export function child(element: XmlElement | null, tag: string): XmlElement | null {
  return element?.children.find((entry) => entry.tag === tag) ?? null;
}

export function children(element: XmlElement | null, tag: string): XmlElement[] {
  return element?.children.filter((entry) => entry.tag === tag) ?? [];
}

/** Trimmed text of the first `tag` child, or "" when there is none. */
export function childText(element: XmlElement | null, tag: string): string {
  return child(element, tag)?.text ?? "";
}
