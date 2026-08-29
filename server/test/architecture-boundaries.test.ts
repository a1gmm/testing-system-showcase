import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (name: string) => readFileSync(join(import.meta.dirname, '..', 'src', name), 'utf8')

test('workflow and qualification domains do not import the handlers composition module', () => {
  for (const file of ['workflow.ts', 'qualifications.ts']) {
    assert.doesNotMatch(source(file), /from ['"]\.\/handlers\.ts['"]/, `${file} must not depend on handlers.ts`)
  }
})
