import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { renderPatterns, rubyInTemplate, templateName } from "../src/adapters/ruby-views.ts";
import { readExceptionsApps } from "../src/adapters/ruby-entries.ts";
import { rubyAdapter } from "../src/adapters/ruby.ts";
import { scanSparsity, type ScanOptions, type ScanResult } from "../src/sparsity-scan.ts";

/**
 * The facts a request's life cycle is drawn from: where requests come in (a route, Rails's exceptions app, what a
 * package.json exposes) and the callers a view template makes (a helper it calls, a template that renders another, the
 * action that renders its own template).
 */
async function repo(files: Record<string, string>, run: (scan: (options: Partial<ScanOptions>) => Promise<ScanResult>, git: (...args: string[]) => string, cwd: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "life-cycle-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 20_000 });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  let packs = 0;
  const scan = (options: Partial<ScanOptions>) => scanSparsity({
    cwd, diff: "", maxDepth: 1, vicinity: 5, maxNodes: 60, maxAnchors: 20, budgetMs: 30_000, indexCacheDir: join(root, "index"),
    outputDir: join(root, `pack-${++packs}`), inlineBudgetBytes: 40 * 1024, ...options,
  });
  try {
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "base");
    await run(scan, git, cwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const RAILS: Record<string, string> = {
  "Gemfile": "source 'https://rubygems.org'\n",
  "config/routes.rb": "Rails.application.routes.draw do\n  resources :users, only: [:show]\n  get \"u/:id\", to: \"users#show\", as: :short_user\nend\n",
  "config/application.rb": "module Shop\n  class Application < Rails::Application\n    config.exceptions_app = ->(env) {\n      ErrorsController.action(:show).call(env)\n    }\n  end\nend\n",
  "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
  "app/controllers/users_controller.rb": "class UsersController < ApplicationController\n  def show\n    @user = User.find(params[:id])\n  end\nend\n",
  "app/controllers/errors_controller.rb": "class ErrorsController < ApplicationController\n  def show\n    head 404\n  end\nend\n",
  "app/helpers/users_helper.rb": "module UsersHelper\n  def display_name(user)\n    user.full_name\n  end\nend\n",
  "app/models/user.rb": "class User < ApplicationRecord\n  def full_name\n    \"#{first} #{last}\"\n  end\nend\n",
  "app/views/users/show.html.erb": "<h1>display_name</h1>\n<%# display_name(@user) is in a comment %>\n<p><%= display_name(@user) %></p>\n<%= render \"users/badge\", user: @user %>\n",
  "app/views/users/_badge.html.erb": "<span>\n  <%= user.full_name %>\n</span>\n",
  "app/views/layouts/application.html.erb": "<%= yield %>\n",
};

const callerOf = (result: ScanResult, symbol: string) => {
  const anchor = result.anchors.find((entry) => entry.symbol === symbol);
  assert.ok(anchor, `anchors: ${result.anchors.map((entry) => entry.symbol).join(", ")}`);
  return anchor.callers.map((caller) => {
    const node = result.nodes.find((entry) => entry.id === caller.id)!;
    return { symbol: node.symbol, kind: node.kind, path: caller.path, line: caller.line, resolution: caller.resolution, name: caller.name, convention: caller.convention, entry: node.entry };
  });
};

test("a view template is one definition, named by its path under app/views, and render calls name it by its folder and name", () => {
  assert.deepEqual(templateName("app/views/posts/_post.html.erb"), { root: ".", file: "posts/_post.html.erb", prefix: "posts", name: "post", partial: true, handler: "erb" });
  assert.deepEqual(templateName("engines/shop/app/views/admin/orders/show.json.jbuilder"), { root: "engines/shop", file: "admin/orders/show.json.jbuilder", prefix: "admin/orders", name: "show", partial: false, handler: "jbuilder" });
  assert.equal(templateName("app/views/layouts/application.html.erb"), undefined, "a layout wraps what an action renders, and no render names it");
  assert.equal(templateName("app/helpers/posts_helper.rb"), undefined);

  const partial = renderPatterns(templateName("app/views/posts/_post.html.erb")!);
  const renders = (line: string, patterns: string[]) => patterns.some((pattern) => new RegExp(pattern).test(line));
  assert.ok(renders('<%= render partial: "posts/post", collection: @posts %>', partial.qualified));
  assert.ok(renders("turbo_stream.replace(post, partial: 'posts/post')", partial.qualified));
  assert.ok(renders('<%= render "post", post: post %>', partial.local));
  assert.ok(renders("<%= render @posts %>", partial.objects));
  assert.ok(!renders('<%= render "posts/postcard" %>', partial.qualified), "another partial");

  const show = renderPatterns(templateName("app/views/topics/show.html.erb")!);
  assert.ok(renders('render "topics/show"', show.qualified) && renders("render template: 'topics/show'", show.qualified));
  assert.ok(renders("render :show, status: :unprocessable_entity", show.local) && !renders("render :showcase", show.local));
});

test("only the Ruby inside a template's tags counts, and a comment tag holds none", () => {
  const lines = ["<h1>display_name</h1>", "<%# display_name %>", "<p><%= display_name(@user) %></p>", "<% if x", "  display_name(y) %>"];
  const code = rubyInTemplate(lines, "erb");
  const at = (line: number) => code(line, lines[line - 1]!.indexOf("display_name"));
  assert.deepEqual([1, 2, 3, 5].map(at), [false, false, true, true]);
  assert.equal(rubyInTemplate(["json.name user.full_name"], "jbuilder")(1, 0), true, "Jbuilder is Ruby");
});

test("Rails's exceptions app names the action it sends failing requests to", async () => {
  assert.ok(await rubyAdapter.ready(), "the Ruby parser");
  assert.deepEqual(readExceptionsApps("module Shop\n  class Application < Rails::Application\n    config.exceptions_app = ->(env) {\n      ErrorsController.action(:show).call(env)\n    }\n  end\nend\n"), [{ controller: "ErrorsController", action: "show", line: 3, endLine: 5 }]);
  assert.deepEqual(readExceptionsApps("config.exceptions_app = routes\n"), [], "the routes draw it, and they are read on their own");
});

test("a routed action lists its routes with the lines that draw them, and the exceptions app's action says where it is named", () => repo(RAILS, async (scan) => {
  const result = await scan({ anchors: ["app/controllers/users_controller.rb:2", "app/controllers/errors_controller.rb:2"] });
  const entry = (symbol: string) => result.anchors.find((anchor) => anchor.symbol === symbol)?.entry;
  assert.deepEqual(entry("UsersController#show"), {
    kind: "controller", exact: true,
    routes: [
      { verbs: ["GET"], path: "/users/:id", file: "config/routes.rb", line: 2, text: "resources :users, only: [:show]" },
      { verbs: ["GET"], path: "/u/:id", file: "config/routes.rb", line: 3, text: 'get "u/:id", to: "users#show", as: :short_user' },
    ],
  });
  assert.deepEqual(entry("ErrorsController#show"), { kind: "controller", exact: true, exceptionsApp: { file: "config/application.rb", line: 3, endLine: 5, text: "config.exceptions_app = ->(env) {" } });
}));

test("a template that calls a helper or a model method is its caller, found by name in the template's Ruby", () => repo(RAILS, async (scan) => {
  const result = await scan({ anchors: ["app/helpers/users_helper.rb:2", "app/models/user.rb:2"] });
  assert.deepEqual(callerOf(result, "UsersHelper#display_name"), [
    { symbol: "users/show.html.erb", kind: "template", path: "app/views/users/show.html.erb", line: 3, resolution: "exact", name: undefined, convention: undefined, entry: undefined },
  ], "a helper called with no receiver runs on the view; the heading's text and the comment tag name it too, and are no call");
  assert.deepEqual(callerOf(result, "User#full_name").map(({ symbol, kind, line, resolution }) => [symbol, kind, line, resolution]), [
    ["UsersHelper#display_name", "method", 3, "static_candidate"],
    ["users/_badge.html.erb", "template", 2, "static_candidate"],
  ], "a call on a receiver of no known type is a match by name");
  const display = result.anchors.find((anchor) => anchor.symbol === "UsersHelper#display_name")!;
  assert.deepEqual(display.callerCount, { total: 1, shown: 1, complete: true });
}));

test("what renders a template is its caller: a render call naming it, and the action that renders its own template by convention", () => repo(RAILS, async (scan) => {
  const result = await scan({ anchors: ["app/views/users/_badge.html.erb:1", "app/views/users/show.html.erb:1"] });
  const badge = result.anchors.find((anchor) => anchor.symbol === "users/_badge.html.erb")!;
  assert.deepEqual([badge.kind, badge.startLine, badge.endLine], ["template", 1, 3], "the whole file");
  assert.deepEqual(callerOf(result, "users/_badge.html.erb").map(({ symbol, line, resolution, name }) => [symbol, line, resolution, name]), [["users/show.html.erb", 4, "exact", "users/badge"]]);
  const [action] = callerOf(result, "users/show.html.erb");
  assert.deepEqual([action?.symbol, action?.line, action?.resolution, action?.convention, action?.entry?.kind, action?.entry && "routes" in action.entry ? action.entry.routes?.length : 0], ["UsersController#show", 2, "exact", true, "controller", 2]);
  assert.ok(result.edges.some((edge) => edge.relationship === "called_by" && edge.via === "convention"));
}));

test("a changed template is anchored as one definition, with its changed lines", () => repo(RAILS, async (scan, git, cwd) => {
  await writeFile(join(cwd, "app/views/users/_badge.html.erb"), "<span class=\"badge\">\n  <%= user.full_name %>\n</span>\n");
  git("commit", "-qam", "badge");
  const result = await scan({ diff: "HEAD~1..HEAD" });
  assert.deepEqual(result.anchors.map((anchor) => [anchor.symbol, anchor.kind, anchor.changedLines]), [["users/_badge.html.erb", "template", [1]]]);
  assert.deepEqual(callerOf(result, "users/_badge.html.erb").map(({ symbol }) => symbol), ["users/show.html.erb"]);
}));

const PACKAGE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "tiny", type: "module", main: "./index.ts", bin: { tiny: "./src/cli.ts" }, pi: { extensions: ["./index.ts"] } }, null, 2) + "\n",
  "tsconfig.json": '{"compilerOptions":{"strict":true,"module":"nodenext","allowImportingTsExtensions":true,"noEmit":true},"include":["index.ts","src"]}\n',
  "index.ts": 'export { default } from "./src/extension.ts";\nexport { total as sum } from "./src/lib.ts";\n',
  "src/lib.ts": "export function total(amount: number) {\n  return amount + 1;\n}\n",
  "src/extension.ts": 'import { total } from "./lib.ts";\n\nexport default function tinyExtension(pi: { registerTool(tool: object): void }) {\n  pi.registerTool({ name: "tiny", execute: () => total(1) });\n}\n',
  "src/cli.ts": 'import { total } from "./lib.ts";\n\nconsole.log(total(2));\n',
};

test("what a package exposes says so, with where its package.json does: a command, a module Pi loads, a name it exports", () => repo(PACKAGE, async (scan) => {
  const result = await scan({ anchors: ["src/extension.ts:3", "src/lib.ts:1"] });
  // package.json, as written: "main" on line 4, the command on line 6, the extension on line 10.
  assert.deepEqual(result.anchors.find((anchor) => anchor.symbol === "tinyExtension")?.entry, {
    kind: "extension", exact: true, doors: [{ kind: "extension", title: "./index.ts", file: "package.json", line: 10, text: '"./index.ts"' }],
  }, "index.ts is the package's main too, and the function Pi loads is no other way in for being its default export");
  assert.deepEqual(result.anchors.find((anchor) => anchor.symbol === "total")?.entry, {
    kind: "export", exact: true, doors: [{ kind: "export", title: "tiny: sum", file: "package.json", line: 4, text: '"main": "./index.ts",' }],
  }, "exported through index.ts under another name");
  const command = result.nodes.find((node) => node.path === "src/cli.ts");
  assert.deepEqual(command?.entry, { kind: "command", exact: true, doors: [{ kind: "command", title: "tiny", file: "package.json", line: 6, text: '"tiny": "./src/cli.ts"' }] }, "the command's file calls total as it runs");
  assert.deepEqual(result.anchors.find((anchor) => anchor.symbol === "total")?.callers.map((caller) => [caller.path, caller.entry?.kind]).sort(), [["src/cli.ts", "command"], ["src/extension.ts", "extension"]], "a caller record carries its caller's own entry");
}));

/** A host whose window commands are a map of handlers by name, and the other ways a Node app is entered. */
const HOST: Record<string, string> = {
  "package.json": JSON.stringify({ name: "host", type: "module" }, null, 2) + "\n",
  "tsconfig.json": '{"compilerOptions":{"strict":true,"module":"nodenext","allowImportingTsExtensions":true,"noEmit":true},"include":["src"]}\n',
  "src/reviews.ts": "export class Reviews {\n  prepare(id: string, options: { refresh?: boolean }) {\n    return { id, ...options };\n  }\n}\n\nexport function sync(id: string) {\n  return id;\n}\n",
  "src/seat.ts": [
    "import type { Reviews } from './reviews.ts';",
    "",
    "export function reviewHandlers(reviews: Reviews) {",
    "  return {",
    "    // Asked for by the window.",
    "    'review.prepare': ({ id, refresh }: { id: string; refresh?: boolean }) => reviews.prepare(id, { refresh }),",
    "    'review.again': ({ id }: { id: string }) => {",
    "      return reviews.prepare(id, { refresh: true });",
    "    },",
    "  };",
    "}",
    "",
  ].join("\n"),
  "src/bus.ts": [
    "import { EventEmitter } from 'node:events';",
    "import { sync } from './reviews.ts';",
    "",
    "export const bus = new EventEmitter();",
    "bus.on('sync', (id: string) => sync(id));",
    "",
  ].join("\n"),
  "src/log.ts": "import { sync } from './reviews.ts';\n\nexport const told = (id: string) => `synced ${sync(id)}`;\n",
  "src/menu.ts": [
    "import { sync, type Reviews } from './reviews.ts';",
    "",
    "export function menu(reviews: Reviews) {",
    "  return {",
    "    prepare: (id: string) => reviews.prepare(id, {}),",
    "    sync,",
    "    again: sync,",
    "  };",
    "}",
    "",
  ].join("\n"),
  "src/commands.ts": [
    "import { sync } from './reviews.ts';",
    "",
    "const commands = {",
    "  sync: (id: string) => sync(id),",
    "  again: sync,",
    "};",
    "",
    "export function run(name: keyof typeof commands, id: string) {",
    "  return commands[name](id);",
    "}",
    "",
    "export const options = { 'on-sync': () => sync('a'), retries: 2 };",
    "",
  ].join("\n"),
};

const callers = (result: ScanResult, symbol: string) => result.anchors.find((anchor) => anchor.symbol === symbol)!.callers;

test("a call inside a function that is the value of an object's property, or an argument, is a caller: the definition that holds it", () => repo(HOST, async (scan) => {
  const result = await scan({ anchors: ["src/reviews.ts:2", "src/reviews.ts:7"], allCallers: true });
  const sites = (symbol: string) => [...callers(result, symbol)]
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    .map(({ symbol, path, line, key }) => [symbol, `${path}:${line}`, key]);
  assert.deepEqual(sites("Reviews.prepare"), [
    ["menu", "src/menu.ts:5", "prepare"],
    ["reviewHandlers", "src/seat.ts:6", "review.prepare"],
    ["reviewHandlers", "src/seat.ts:8", "review.again"],
  ], "a quoted key that holds the name does not hide the call after it, and each caller keeps the key of the property whose function holds the call");
  assert.deepEqual(result.anchors.find((anchor) => anchor.symbol === "Reviews.prepare")!.callerCount, { total: 3, shown: 3, complete: true });
  assert.deepEqual(sites("sync"), [
    ["bus.on('sync', (id: string) => sync(id))", "src/bus.ts:5", undefined],
    ["commands", "src/commands.ts:4", "sync"],
    ["commands", "src/commands.ts:5", "again"],
    ["options", "src/commands.ts:12", "on-sync"],
    ["told", "src/log.ts:3", undefined],
    ["menu", "src/menu.ts:6", "sync"],
    ["menu", "src/menu.ts:7", "again"],
  ], "the event's name is the function's name, written first in a string, and that function is the value of no property; a template's `${}` holds a call; a property's value can be the name itself");
}));

test("a map of handlers by name is a way in: each key a handler, exact only where the code reads the map by a key it is given", () => repo(HOST, async (scan) => {
  const result = await scan({ anchors: ["src/reviews.ts:2", "src/reviews.ts:7"], allCallers: true });
  const entryAt = (symbol: string, path: string, line: number) => callers(result, symbol).find((caller) => caller.path === path && caller.line === line)?.entry;
  assert.deepEqual(entryAt("Reviews.prepare", "src/seat.ts", 6), {
    kind: "handler", exact: false,
    doors: [{ kind: "handler", title: "review.prepare", file: "src/seat.ts", line: 6, text: "'review.prepare': ({ id, refresh }: { id: string; refresh?: boolean }) => reviews.prepare(id, { refresh })," }],
  }, "every value a function written in place, under quoted keys that are no names: the window's commands, sent by key from another file");
  assert.deepEqual(entryAt("Reviews.prepare", "src/seat.ts", 8), {
    kind: "handler", exact: false,
    doors: [{ kind: "handler", title: "review.again", file: "src/seat.ts", line: 7, text: "'review.again': ({ id }: { id: string }) => {" }],
  }, "the door is the line of the handler's key");
  assert.deepEqual(entryAt("sync", "src/commands.ts", 4), {
    kind: "handler", exact: true,
    doors: [{ kind: "handler", title: "sync", file: "src/commands.ts", line: 4, text: "sync: (id: string) => sync(id)," }],
  }, "`commands[name](id)` reads the map by a key it is given");
  assert.equal(entryAt("Reviews.prepare", "src/menu.ts", 5), undefined, "an object of methods under plain names is no map of handlers by itself");
  assert.equal(entryAt("sync", "src/commands.ts", 12), undefined, "an object with a value that is no function holds options");
  assert.deepEqual(result.anchors.find((anchor) => anchor.symbol === "sync")?.entry, {
    kind: "handler", exact: true,
    doors: [{ kind: "handler", title: "again", file: "src/commands.ts", line: 5, text: "again: sync," }],
  }, "a definition that is a handler's value is the handler");
}));
