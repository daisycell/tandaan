import assert from 'node:assert/strict'
import { parseInput } from '../src/parser.ts'

const twoWay = ['shopping', 'purchase']

const cases = [
  {
    // Rule 1: action verb present -> Task, saved directly with no modal.
    text: 'pay electricity',
    check: parsed => {
      assert.equal(parsed.intent, 'task')
      assert.equal(parsed.ambiguous, undefined)
      assert.equal(parsed.title, 'pay electricity')
    },
  },
  {
    // Rule 2: no verb/date, number present -> 2-way modal, shopping/purchase only.
    text: 'egg 30',
    check: parsed => {
      assert.equal(parsed.ambiguous?.options.join(','), twoWay.join(','))
      assert.equal(parsed.shopping?.itemName, 'egg')
      assert.equal(parsed.shopping?.quantity, 30)
      assert.equal(parsed.purchases?.[0]?.itemName, 'egg')
      assert.equal(parsed.purchases?.[0]?.price, 30)
    },
  },
  {
    text: 'rice 40',
    check: parsed => {
      assert.equal(parsed.ambiguous?.options.join(','), twoWay.join(','))
      assert.equal(parsed.shopping?.itemName, 'rice')
      assert.equal(parsed.shopping?.quantity, 40)
      assert.equal(parsed.purchases?.[0]?.itemName, 'rice')
      assert.equal(parsed.purchases?.[0]?.price, 40)
    },
  },
  {
    // Rule 3: no verb/date, no number -> Shopping saved directly, no modal at all.
    text: 'vinegar corn',
    check: parsed => {
      assert.equal(parsed.ambiguous, undefined)
      assert.equal(parsed.intent, 'shopping')
      assert.equal(parsed.shopping?.itemName, 'vinegar corn')
    },
  },
  {
    text: 'egg',
    check: parsed => {
      assert.equal(parsed.ambiguous, undefined)
      assert.equal(parsed.intent, 'shopping')
      assert.equal(parsed.shopping?.itemName, 'egg')
    },
  },
  {
    // Multi-item list containing a unit. No verb, no date, numbers present,
    // so rule 2 applies and the shopping option is the full 3-item list.
    text: 'chicken 1kg egg 10 oil 10',
    check: parsed => {
      assert.equal(parsed.intent, 'shopping')
      assert.equal(parsed.ambiguous?.options.join(','), twoWay.join(','))
      assert.equal(parsed.shoppingItems?.length, 3)
      assert.deepEqual(parsed.shoppingItems?.map(i => i.itemName), ['chicken', 'egg', 'oil'])
      assert.deepEqual(parsed.shoppingItems?.map(i => i.quantity), [1, 10, 10])
      assert.equal(parsed.shoppingItems?.[0]?.unit, 'kg')
    },
  },
  {
    // Task must never be offered, and a date signal must short-circuit to Task
    // rather than reaching the modal.
    text: 'rice 40 tomorrow',
    check: parsed => {
      assert.equal(parsed.ambiguous, undefined)
      assert.equal(parsed.intent, 'task')
    },
  },
  {
    // Explicit money is still an unambiguous purchase.
    text: 'egg 30 pesos',
    check: parsed => {
      assert.equal(parsed.ambiguous, undefined)
      assert.equal(parsed.intent, 'purchase')
    },
  },
]

for (const testCase of cases) {
  const parsed = parseInput(testCase.text)
  try {
    testCase.check(parsed)
  } catch (error) {
    console.error(`FAILED: "${testCase.text}" -> intent=${parsed.intent} options=${parsed.ambiguous?.options.join(',') ?? 'none'}`)
    throw error
  }
}

console.log(`parser tests passed: ${cases.length}`)
