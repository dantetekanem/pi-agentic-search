import assert from "node:assert/strict";
import { boundarySignal } from "../src/rank.ts";

const mutation = boundarySignal("app/models/graph_api/signups/mutations/store_create.rb", "GraphApi::Signups::Mutations::StoreCreate#resolve", "def resolve\n  token = input.signup_token\n  ActiveRecord::Base.transaction do\n    shop.save!\n  end\nend");
assert.deepEqual(mutation.tags, ["graphql", "secret", "transaction"], mutation.tags.join(","));
assert.ok(mutation.score > 50);

const hook = boundarySignal("areas/clients/admin-web/app/signup/hooks/useStoreSignupParams.ts", "useStoreSignupParams", "const params = useSearchParams();\nreturn { signupUuid };");
assert.deepEqual(hook.tags, [], `a plain hook under a clients/ directory gets no boundary tags: ${hook.tags.join(",")}`);
assert.equal(hook.score, 0);

const job = boundarySignal("app/jobs/setup/create_and_link_contract_job.rb", "Setup::CreateAndLinkContractJob#perform", "def perform(shop)\n  retry_on Timeout\n  rescue StandardError => e\nend");
assert.deepEqual(job.tags, ["job", "money", "retry", "rescue"]);

const middleware = boundarySignal("server/middleware/signup/monorail.ts", "withoutAgenticSignupToken", "params.delete(AGENTIC_SIGNUP_TOKEN_PARAM)");
assert.deepEqual(middleware.tags, ["middleware", "secret", "data"]);

const plain = boundarySignal("lib/formatting/currency_helper.rb", "CurrencyHelper#format_amount", "def format_amount(amount)\n  amount.round(2)\nend");
assert.deepEqual(plain.tags, ["money"], "domain words in the symbol count, but nothing else fires");

const test = boundarySignal("test/models/billing/reader_test.rb", 'ReaderTest test "applicable"', "assert token");
assert.ok(test.tags.includes("secret"), "the scorer itself is neutral about test paths; callers of it decide");

console.log(`rank ok: mutation ${mutation.score}, job ${job.score}, middleware ${middleware.score}, hook ${hook.score}`);
