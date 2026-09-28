import assert from 'node:assert/strict'
import { parseInput } from '../src/parser.ts'

const threeWay = ['task', 'shopping', 'purchase']

const cases = [
  {
    text: 'vinegar corn',
    check: parsed => {
      assert.equal(parsed.ambiguous?.options.join(','), threeWay.join(','))
      assert.equal(parsed.shopping?.itemName, 'vinegar corn')
    },
  },
  {
    text: 'egg',
    check: parsed => {
      assert.equal(parsed.ambiguous?.options.join(','), threeWay.join(','))
      assert.equal(parsed.shopping?.itemName, 'egg')
    },
  },
  {
    text: 'pay electricity',
    check: parsed => {
      assert.equal(parsed.intent, 'task')
      assert.equal(parsed.ambiguous, undefined)
      assert.equal(parsed.title, 'pay electricity')
    },
  },
  {
    text: 'rice 40',
    check: parsed => {
      assert.equal(parsed.ambiguous?.options.join(','), threeWay.join(','))
      assert.equal(parsed.shopping?.itemName, 'rice')
      assert.equal(parsed.shopping?.quantity, 40)
      assert.equal(parsed.purchases?.[0]?.price, 40)
    },
  },
  {
    text: 'egg 3',
    check: parsed => {
      assert.equal(parsed.ambiguous?.options.join(','), threeWay.join(','))
      assert.equal(parsed.shopping?.itemName, 'egg')
      assert.equal(parsed.shopping?.quantity, 3)
      assert.equal(parsed.purchases?.[0]?.price, 3)
    },
  },
]

for (const testCase of cases) {
  const parsed = parseInput(testCase.text)
  testCase.check(parsed)
}

console.log(`parser tests passed: ${cases.length}`)
