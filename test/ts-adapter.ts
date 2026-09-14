import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectSparsity } from "../index.ts";
import { tsAdapter, TsPrograms } from "../src/adapters/ts.ts";

const cwd = await mkdtemp(join(tmpdir(), "ts-adapter-"));
const files: Record<string, string> = {
  "package.json": `{ "name": "web", "type": "module" }\n`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "allowJs": true,
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"] },
    "strict": true
  },
  "include": ["src/**/*", "lib/**/*"]
}
`,
  "src/team/team.ts": `export interface Team {
  id: string;
  name: string;
}

export function loadTeam(id: string): Team {
  return { id, name: id.toUpperCase() };
}

export const TEAM_LIMIT = 3;
`,
  "src/team/index.ts": `export { loadTeam, TEAM_LIMIT } from "./team";
export type { Team } from "./team";
`,
  "src/billing/Profile.tsx": `import { loadTeam, type Team } from "@app/team";
import { format } from "date-fns";
import { Badge } from "./Badge";
import { legacyTotal } from "../../lib/legacy.js";

interface ProfileProps {
  teamId: string;
}

function label(team: Team): string {
  return team.name.trim();
}

export function Profile({ teamId }: ProfileProps) {
  const team = loadTeam(teamId);
  const stamp = format(new Date(), "yyyy");
  const total = legacyTotal([1, 2]);
  return <Badge text={label(team) + stamp + total} />;
}

export class ProfileStore {
  private cache = new Map<string, Team>();

  remember(team: Team): void {
    this.cache.set(team.id, team);
    this.touch();
  }

  private touch(): void {
    this.cache.clear();
  }
}
`,
  "src/billing/Badge.tsx": `export function Badge({ text }: { text: string }) {
  return <span>{text}</span>;
}
`,
  "lib/legacy.js": `const helper = require("./helper.js");

function legacyTotal(values) {
  return helper.sum(values);
}

module.exports = { legacyTotal };
`,
  "lib/helper.js": `function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

module.exports = { sum };
`,
  "src/billing/tests/Profile.test.tsx": `import { Profile } from "../Profile";

describe("<Profile />", () => {
  describe("labels", () => {
    it("renders the team name", () => {
      expect(Profile).toBeDefined();
    });
  });
});
`,
};
for (const [path, content] of Object.entries(files)) {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content, "utf8");
}

// Definitions without a program
const facts = tsAdapter.parse(join(cwd, "src/billing/Profile.tsx"), files["src/billing/Profile.tsx"]!)!;
const symbols = new Map(facts.definitions.map((def) => [def.symbol, def]));
assert.deepEqual([symbols.get("Profile")?.kind, symbols.get("Profile")?.startLine, symbols.get("Profile")?.endLine], ["component", 14, 19]);
assert.deepEqual([symbols.get("label")?.kind, symbols.get("label")?.startLine], ["function", 10]);
assert.equal(symbols.get("ProfileProps")?.kind, "type");
assert.equal(symbols.get("ProfileStore")?.kind, "class");
assert.deepEqual([symbols.get("ProfileStore.remember")?.kind, symbols.get("ProfileStore.remember")?.startLine, symbols.get("ProfileStore.remember")?.endLine], ["method", 24, 27]);
assert.equal(symbols.get("ProfileStore.touch")?.kind, "method");
assert.equal(tsAdapter.definitionAt(facts, 16)?.symbol, "Profile");
assert.equal(tsAdapter.definitionAt(facts, 26)?.symbol, "ProfileStore.remember");
assert.equal(tsAdapter.definitionAt(facts, 7)?.symbol, "ProfileProps");

const testFacts = tsAdapter.parse(join(cwd, "src/billing/tests/Profile.test.tsx"), files["src/billing/tests/Profile.test.tsx"]!)!;
const testDefs = testFacts.definitions.map((def) => def.symbol);
assert.ok(testDefs.includes("<Profile />"), `describe block: ${testDefs.join(" | ")}`);
assert.ok(testDefs.some((symbol) => symbol.endsWith("renders the team name")), "nested it block found");
assert.equal(tsAdapter.definitionAt(testFacts, 6)?.kind, "test");

const cjs = tsAdapter.parse(join(cwd, "lib/legacy.js"), files["lib/legacy.js"]!)!;
assert.deepEqual(cjs.definitions.map((def) => [def.symbol, def.kind]), [["helper", "constant"], ["legacyTotal", "function"], ["module.exports", "constant"]]);

// With a program: checker-resolved targets through alias, barrel, CJS and JSX
const programs = new TsPrograms(cwd);
programs.prepare([join(cwd, "src/billing/Profile.tsx")]);
tsAdapter.attach(programs, cwd);
const typed = tsAdapter.parse(join(cwd, "src/billing/Profile.tsx"), files["src/billing/Profile.tsx"]!)!;
const profile = typed.definitions.find((def) => def.symbol === "Profile")!;
const calls = tsAdapter.calls(typed, profile);
const call = (name: string) => calls.find((site) => site.name === name);
assert.ok(call("loadTeam")?.target?.path.endsWith("src/team/team.ts"), "alias + barrel resolve to the defining file");
assert.equal(call("loadTeam")?.target?.line, 6);
assert.equal(call("loadTeam")?.via, "checker");
assert.equal(call("format")?.target, undefined, "unresolvable package import has no target");
assert.ok(call("legacyTotal")?.target?.path.endsWith("lib/legacy.js"), "CommonJS module resolved from TS");
assert.ok(call("Badge")?.target?.path.endsWith("src/billing/Badge.tsx"), "JSX component reference resolved");
assert.equal(call("Badge")?.source, "jsx");
assert.ok(call("label")?.target?.path.endsWith("src/billing/Profile.tsx"));
assert.ok(!calls.some((site) => site.name === "Date"), "globals are not recorded");
assert.ok(!calls.some((site) => site.name === "trim"), "lib methods on typed values are builtins, not edges");
const remember = typed.definitions.find((def) => def.symbol === "ProfileStore.remember")!;
const rememberCalls = tsAdapter.calls(typed, remember);
assert.ok(rememberCalls.some((site) => site.name === "touch" && site.receiver === "this" && site.target?.line === 29), "this.method resolves to the class method");
assert.ok(!rememberCalls.some((site) => site.name === "set"), "Map#set is a builtin");
assert.ok(programs.describe()[0]?.startsWith("TypeScript program for tsconfig.json"), programs.describe().join(" | "));

// End to end through the collector
const result = await collectSparsity({ cwd, target: "src/billing/Profile.tsx:15", maxDepth: 2, vicinity: 20, maxNodes: 24, callers: true, budgetMs: 20_000 });
const edge = (name: string) => result.edges.find((item) => item.from === result.anchor.id && item.name === name);
assert.deepEqual([edge("loadTeam")?.resolution, edge("loadTeam")?.via], ["exact", "checker"]);
assert.equal(result.nodes.find((node) => node.id === edge("loadTeam")?.to)?.path, "src/team/team.ts");
assert.deepEqual([edge("format")?.resolution], ["external"]);
assert.deepEqual([edge("legacyTotal")?.resolution, result.nodes.find((node) => node.id === edge("legacyTotal")?.to)?.symbol], ["exact", "legacyTotal"]);
const legacyNode = result.nodes.find((node) => node.id === edge("legacyTotal")?.to)!;
const sumEdge = result.edges.find((item) => item.from === legacyNode.id && item.name === "helper.sum");
assert.deepEqual([sumEdge?.resolution, result.nodes.find((node) => node.id === sumEdge?.to)?.path], ["exact", "lib/helper.js"], "require() chain followed into JS");
assert.deepEqual([edge("Badge")?.resolution, result.nodes.find((node) => node.id === edge("Badge")?.to)?.symbol], ["exact", "Badge"]);
assert.ok(result.edges.some((item) => item.relationship === "called_by" && result.nodes.find((node) => node.id === item.from)?.path.includes("Profile.test.tsx")), "test file is a caller");
assert.ok(result.coverage.notes.some((note) => note.startsWith("TypeScript program for")));

console.log(`ts adapter ok: ${facts.definitions.length} definitions, ${calls.length} typed calls, collector ${result.nodes.length} nodes/${result.edges.length} edges in ${result.coverage.elapsedMs} ms`);
