import { camelToSnake } from "../shared.ts";

/**
 * A Rails view template, as `render` and the controller conventions name it. `app/views/posts/_post.html.erb` is the
 * partial `posts/post`; `app/views/topics/show.html.erb` is the template `topics/show`, which `TopicsController#show`
 * renders when it renders nothing else.
 */
export interface TemplateName {
  /** The folder that holds `app/views`: `.`, or a component's root. */
  root: string;
  /** The template's path under `app/views`, as its node's symbol: `posts/_post.html.erb`. */
  file: string;
  /** The folder under `app/views`: `posts`, `admin/orders`. A controller or mailer of that name renders it by convention. */
  prefix: string;
  /** Its own name, without the partial's underscore, its format or its handler: `post`, `show`. */
  name: string;
  partial: boolean;
  handler: string;
}

/** The template languages Rails renders: ERB, Haml, Slim, Jbuilder and Builder. */
const TEMPLATE = /^(?:(.+)\/)?app\/views\/((?:[^/]+\/)*)(_?)([^/.]+)(?:\.[^/.]+)*\.(erb|haml|slim|jbuilder|builder)$/;

export function templateName(path: string): TemplateName | undefined {
  const match = TEMPLATE.exec(path);
  if (!match) return undefined;
  const prefix = match[2]!.replace(/\/$/, "");
  // Layouts wrap what an action renders, and no render call names them by path.
  if (!prefix || prefix === "layouts" || prefix.startsWith("layouts/")) return undefined;
  const root = match[1] ?? ".";
  return { root, file: root === "." ? path.slice("app/views/".length) : path.slice(root.length + "/app/views/".length), prefix, name: match[4]!, partial: match[3] === "_", handler: match[5]! };
}

export const isTemplatePath = (path: string): boolean => templateName(path) !== undefined;

/** `app/views` under a root. */
export const viewsFolder = (root: string): string => (root === "." ? "app/views" : `${root}/app/views`);

/**
 * The files whose actions render a folder's templates by convention: `admin/orders` is
 * `app/controllers/admin/orders_controller.rb`, and a mailer's folder, `user_mailer`, is `app/mailers/user_mailer.rb`.
 */
export function conventionalRenderers(template: TemplateName): string[] {
  const base = template.root === "." ? "" : `${template.root}/`;
  const snake = template.prefix.split("/").map(camelToSnake).join("/");
  return snake.endsWith("_mailer") ? [`${base}app/mailers/${snake}.rb`] : [`${base}app/controllers/${snake}_controller.rb`];
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pluralize(word: string): string {
  if (/[^aeiouy]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:x|ch|ss|sh|s)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** Patterns, in syntax both ripgrep and JavaScript read, for the lines that render a template, by how they name it. */
export interface RenderPatterns {
  /** By its path, from anywhere under the root: `render "posts/post"`, `render partial: "posts/post"`, `render template: "topics/show"`. */
  qualified: string[];
  /** By its own name, which means it only in its folder's templates and its controller or mailer: `render "post"`, `render :show`. */
  local: string[];
  /** A partial by the model of what is rendered, `render @posts` or `render post`: a guess from the name. */
  objects: string[];
  /** The names a render line writes, longest first, for finding the call again. */
  names: string[];
}

export function renderPatterns(template: TemplateName): RenderPatterns {
  const quoted = (name: string) => `["']/?${escape(name)}(?:\\.[a-z]+)*["']`;
  const qualifiedName = `${template.prefix}/${template.name}`;
  const partialOption = `(?:\\bpartial:\\s*|:partial\\s*=>\\s*)`;
  if (template.partial) {
    const plural = pluralize(template.name);
    return {
      // Also inside a turbo stream or a helper: turbo_stream.replace(post, partial: "posts/post").
      qualified: [`\\brender\\b\\s*\\(?\\s*${quoted(qualifiedName)}`, `${partialOption}${quoted(qualifiedName)}`],
      local: [`\\brender\\b\\s*\\(?\\s*${quoted(template.name)}`, `${partialOption}${quoted(template.name)}`],
      objects: [`\\brender\\b\\s*\\(?\\s*@?(?:${escape(template.name)}|${escape(plural)})\\s*(?:[),]|%>|-%>|$)`],
      names: [qualifiedName, plural, template.name],
    };
  }
  return {
    qualified: [`\\brender\\b\\s*\\(?\\s*(?:template:\\s*|:template\\s*=>\\s*)?${quoted(qualifiedName)}`],
    local: [`\\brender\\b\\s*\\(?\\s*(?:action:\\s*|:action\\s*=>\\s*)?(?::${escape(template.name)}\\b|${quoted(template.name)})`],
    objects: [],
    names: [qualifiedName, template.name],
  };
}

/** Whether a file is one where a template's own name means it: a template of its folder, or the controller or mailer of that folder. */
export function inTemplateFolder(path: string, template: TemplateName): boolean {
  const own = templateName(path);
  if (own) return own.root === template.root && own.prefix === template.prefix;
  return conventionalRenderers(template).includes(path);
}

/** The name a render line writes for a template, as the line has it. */
export function renderedName(text: string, template: TemplateName): string | undefined {
  return renderPatterns(template).names.find((name) => new RegExp(`(?:^|[^\\w/])${escape(name)}(?:[^\\w/]|$)`).test(text));
}

/**
 * Which columns of a template's lines hold Ruby: inside ERB's `<% %>` tags, which may span lines; after Haml's and
 * Slim's `=`, `-` and `!=` and inside `#{}`; every line of Jbuilder and Builder, which are Ruby. A comment tag holds none.
 */
export function rubyInTemplate(lines: string[], handler: string): (line: number, column: number) => boolean {
  if (handler === "jbuilder" || handler === "builder") return () => true;
  if (handler !== "erb") {
    return (line, column) => {
      const text = lines[line - 1] ?? "";
      const code = /^\s*(?:[%.#][\w.#-]*(?:\{[^}]*\}|\([^)]*\))?\s*)?(?:!=|&=|=|-|~)(?!#)/.exec(text);
      const interpolation = text.lastIndexOf("#{", column);
      return (code !== null && column >= code[0].length) || (interpolation >= 0 && !text.slice(interpolation, column).includes("}"));
    };
  }
  const inside: boolean[][] = [];
  let open = false;
  let comment = false;
  for (const text of lines) {
    const row: boolean[] = [];
    for (let column = 0; column < text.length; column += 1) {
      if (!open && text.startsWith("<%", column) && !text.startsWith("<%%", column)) {
        open = true;
        comment = text[column + 2] === "#";
        row.push(false, false);
        column += 1;
        continue;
      }
      if (open && text.startsWith("%>", column)) {
        open = false;
        row.push(false, false);
        column += 1;
        continue;
      }
      row.push(open && !comment);
    }
    inside.push(row);
  }
  return (line, column) => inside[line - 1]?.[column] === true;
}
