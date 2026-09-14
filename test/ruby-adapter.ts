import assert from "node:assert/strict";
import { rubyAdapter } from "../src/adapters/ruby.ts";

const source = `# frozen_string_literal: true
# Café ünïcode comment to shift byte offsets
module Billing
  class Reader < ApplicationRecord
    include Billing::Auditable
    extend T::Sig

    GRACE_DAYS = 14

    has_many :items, class_name: "Billing::Item"
    scope :recent, -> { where(created_at: 1.day.ago..) }
    validates :shop, presence: true

    sig { params(shop: Shop, entity: T.nilable(Admin::LegalEntity)).void }
    def initialize(shop, entity = nil)
      @shop = shop
      @entity = entity
      @reader = Admin::LegalEntity.for_shop(shop)
      @count = 0
    end

    #: (Integer) -> bool
    def applicable?(threshold)
      return false unless @shop.organization_id
      entity = Admin::LegalEntity.for_shop(@shop)
      grant = ContractManagement::IroncladSignupGrant.new(@shop).by_token(token)
      complete_entity?(entity) && !exempt? && Billing::Exemptions::EXEMPT.include?(threshold)
    end

    def extra=(value)
      super(value)
    end

    def self.build(shop) = new(shop)

    class << self
      def registry
        @registry ||= {}
      end
    end

    private

    def complete_entity?(entity)
      entity.complete?
    end
  end
end

class ReaderTest < ActiveSupport::TestCase
  test "applicable for complete entities" do
    assert Billing::Reader.new(shop).applicable?(3)
  end
end
`;

assert.equal(await rubyAdapter.ready(), true, "prism loads");
const facts = rubyAdapter.parse("app/models/billing/reader.rb", source)!;
assert.ok(facts, "parses");
assert.equal(facts.errors, 0);

const bySymbol = new Map(facts.definitions.map((def) => [def.symbol, def]));
const applicable = bySymbol.get("Billing::Reader#applicable?")!;
assert.equal(applicable.kind, "method");
assert.equal(applicable.startLine, 23);
assert.equal(applicable.endLine, 28);
assert.deepEqual(applicable.params?.map((param) => [param.name, param.type]), [["threshold", "Integer"]], "inline RBS types the parameter");
assert.equal(applicable.returns, undefined);

const setter = bySymbol.get("Billing::Reader#extra=")!;
assert.equal(setter.startLine, 30);
assert.equal(setter.endLine, 32, "setter is not mistaken for an endless def");

const build = bySymbol.get("Billing::Reader.build")!;
assert.equal(build.kind, "singleton_method");
assert.equal(build.startLine, 34);
assert.equal(build.endLine, 34, "endless def spans one line");

const registry = bySymbol.get("Billing::Reader.registry")!;
assert.equal(registry.kind, "singleton_method", "class << self makes singleton methods");

const initialize = bySymbol.get("Billing::Reader#initialize")!;
assert.deepEqual(initialize.params?.map((param) => [param.name, param.type]), [["shop", "Shop"], ["entity", "Admin::LegalEntity"]], "sig types flow into params, T.nilable unwrapped");

assert.equal(bySymbol.get("Billing::Reader::GRACE_DAYS")?.kind, "constant");
assert.equal(bySymbol.get("Billing::Reader has_many :items")?.kind, "has_many");
assert.equal(bySymbol.get("Billing::Reader scope :recent")?.kind, "scope");
assert.equal(bySymbol.get("Billing::Reader validates :shop")?.kind, "validates");
assert.equal(bySymbol.get("Billing::Reader#complete_entity?")?.kind, "method", "private def visited");
assert.equal(bySymbol.get('ReaderTest test "applicable for complete entities"')?.kind, "test");
assert.equal(bySymbol.get("Billing::Reader")?.kind, "class");
assert.equal(bySymbol.get("Billing")?.kind, "module");

const reader = facts.namespaces.find((namespace) => namespace.symbol === "Billing::Reader")!;
assert.equal(reader.superclass, "ApplicationRecord");
assert.deepEqual(reader.mixins, ["Billing::Auditable", "T::Sig"]);

const ivars = facts.ivars.get("Billing::Reader")!;
const ivar = (name: string) => ivars.find((item) => item.name === name);
assert.deepEqual([ivar("@shop")?.type, ivar("@shop")?.via], ["Shop", "typed"]);
assert.deepEqual([ivar("@entity")?.type, ivar("@entity")?.via], ["Admin::LegalEntity", "typed"]);
assert.deepEqual([ivar("@reader")?.type, ivar("@reader")?.via], ["Admin::LegalEntity", "assigned"]);
assert.equal(ivar("@count")?.type, undefined);

// definitionAt picks the innermost leaf, not the class
assert.equal(rubyAdapter.definitionAt(facts, 26)?.symbol, "Billing::Reader#applicable?");
assert.equal(rubyAdapter.definitionAt(facts, 10)?.symbol, "Billing::Reader has_many :items");
assert.equal(rubyAdapter.definitionAt(facts, 4)?.symbol, "Billing::Reader");
assert.equal(rubyAdapter.definitionAt(facts, 52)?.kind, "test");
assert.equal(rubyAdapter.definitionAt(facts, 1), undefined, "a comment outside any definition is nothing");

// calls with receiver classification and inferred types
const calls = rubyAdapter.calls(facts, applicable);
const call = (name: string) => calls.find((site) => site.name === name);
assert.deepEqual([call("organization_id")?.receiverKind, call("organization_id")?.receiverType, call("organization_id")?.via], ["ivar", "Shop", "typed"], "ivar receiver typed through the sig on initialize");
assert.deepEqual([call("for_shop")?.receiverKind, call("for_shop")?.receiver], ["constant", "Admin::LegalEntity"]);
assert.deepEqual([call("by_token")?.receiverKind, call("by_token")?.receiverType, call("by_token")?.via], ["chain", "ContractManagement::IroncladSignupGrant", "assigned"], "Const.new(...).method keeps its receiver type");
assert.deepEqual([call("complete_entity?")?.receiverKind, call("complete_entity?")?.receiverType], ["implicit", "Billing::Reader"]);
assert.equal(call("exempt?")?.receiverKind, "implicit");
assert.ok(calls.some((site) => site.source === "constant" && site.name === "Billing::Exemptions::EXEMPT"), "constant reference recorded");
assert.ok(!calls.some((site) => site.name === "ContractManagement::IroncladSignupGrant" && site.source === "constant_method"), "constructor receiver is a reference, not a method call");
const completeCalls = rubyAdapter.calls(facts, bySymbol.get("Billing::Reader#complete_entity?")!);
assert.deepEqual([completeCalls[0]?.name, completeCalls[0]?.receiverKind, completeCalls[0]?.receiverType, completeCalls[0]?.via], ["complete?", "local", "Entity", "named"], "untyped param falls back to naming convention, labeled as such");
const setterCalls = rubyAdapter.calls(facts, setter);
assert.deepEqual([setterCalls[0]?.name, setterCalls[0]?.source, setterCalls[0]?.receiverType], ["super", "super", "ApplicationRecord"]);

// a test block yields its body calls
const testCalls = rubyAdapter.calls(facts, bySymbol.get('ReaderTest test "applicable for complete entities"')!);
assert.ok(testCalls.some((site) => site.name === "applicable?" && site.receiverKind === "chain" && site.receiverType === "Billing::Reader"));

console.log(`ruby adapter ok: ${facts.definitions.length} definitions, ${facts.namespaces.length} namespaces, ${calls.length} calls in applicable?`);
