export interface BoundarySignal {
  score: number;
  tags: string[];
}

const BOUNDARY_PATTERNS: Array<[string, RegExp, number]> = [
  ["controller", /(^|\/)controllers?\/|controller\b/i, 30],
  ["graphql", /(^|\/)(graphql|graph_api|graphql_api|resolvers?|mutations?)\//i, 30],
  ["job", /(^|\/)(jobs?|workers?|sidekiq|tasks?\/maintenance)\/|\b(job|worker|task)$/i, 25],
  ["webhook", /webhook|event_handler|consumer|subscriber/i, 25],
  ["middleware", /(^|\/)(middleware|rack|server)\//i, 25],
  ["client", /(^|\/)(api_clients?|graph_clients?|gateways?|adapters?|integrations?)\/|_client\b|[a-z]client\.[jt]sx?$|-client\.[jt]sx?$/i, 20],
  ["entrypoint", /(^|\/)(bootstrap|entry|main|routes?|app\.tsx?|index\.tsx?)$|(^|\/)routes\//i, 15],
  ["migration", /(^|\/)db\/(migrate|data)\//i, 25],
  ["mailer", /(^|\/)mailers?\/|mailer\b/i, 15],
];

const DOMAIN_PATTERNS: Array<[string, RegExp, number]> = [
  ["auth", /\b(auth|authn|authz|authoriz|authentic|permission|policy|policies|role|ability|can\?|allowed|access)/i, 25],
  ["secret", /\b(tokens?|secrets?|credentials?|passwords?|encrypt\w*|decrypt\w*|signed|signing|signatures?|verif\w+|hmac|jwt|sessions?|cookies?)\b/i, 25],
  ["tenant", /\b(tenant|shop_id|organization_id|account_id|owner_id|scope[sd]?_to|for_shop|current_shop)/i, 20],
  ["money", /\b(payment|billing|charge|invoice|payout|refund|money|price|amount|currency|subscription|plan_change|contract|grant)/i, 20],
  ["data", /\b(destroy\w*|delete\w*|purge\w*|truncate\w*|backfill\w*|migrat\w+|bulk_\w+|batch\w*|upsert\w*)\b/i, 15],
];

const FAILURE_PATTERNS: Array<[string, RegExp, number]> = [
  ["transaction", /\b(transaction|with_lock|lock!|rollback|atomic)/i, 15],
  ["retry", /\b(retry|retries|idempoten|dedup|perform_later|enqueue|deliver_later|schedule)/i, 15],
  ["rescue", /\b(rescue|catch|ensure|fallback|swallow|StandardError|Exception)/i, 10],
  ["async", /\b(async|await|promise|then\(|callback|after_commit|concurren|thread|mutex)/i, 10],
];

function apply(patterns: Array<[string, RegExp, number]>, text: string, out: Map<string, number>): void {
  for (const [tag, pattern, weight] of patterns) {
    if (pattern.test(text)) out.set(tag, Math.max(out.get(tag) ?? 0, weight));
  }
}

function words(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\/.:\-#@]+/g, " ");
}

export function boundarySignal(path: string, symbol: string, snippet?: string): BoundarySignal {
  const tags = new Map<string, number>();
  apply(BOUNDARY_PATTERNS, `${path} ${symbol}`, tags);
  apply(DOMAIN_PATTERNS, words(`${path} ${symbol}`), tags);
  if (snippet) {
    apply(DOMAIN_PATTERNS, words(snippet), tags);
    apply(FAILURE_PATTERNS, words(snippet), tags);
  }
  const ordered = [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const score = ordered.reduce((sum, [, weight]) => sum + weight, 0);
  return { score: Math.min(score, 100), tags: ordered.map(([tag]) => tag) };
}

export const RANKING_EXPLANATION = "Ranking: production definitions before tests, types and declarations; within a band, boundary relevance first (controllers, GraphQL, jobs, middleware, webhooks, clients, entrypoints, migrations; auth, secret, tenant, money and data words; transaction, retry, rescue and async paths), then path and line. Callers: changed in this diff first, then boundary relevance, then path. Tags in brackets show which signals fired.";
