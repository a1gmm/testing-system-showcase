import { expect, test } from 'vitest'
import * as controlApi from '../src/offline/draftControl'

test('public draft control surface exposes types only and no authority-minting runtime primitive', () => {
  expect(Object.keys(controlApi)).toEqual([])
  for (const dangerous of ['sealDraft', 'writeDraftAllow', 'writeDraftDeny', 'readDraftAuthority', 'DraftControlKeyStore']) {
    expect(dangerous in controlApi).toBe(false)
  }
})
