import optimizedList from './optimizedCodes.json'

const entryReadyCodes = new Set(optimizedList as string[])

export function isTemplateReadyForEntry(template: { code: string; retired?: boolean }) {
  return !template.retired && entryReadyCodes.has(template.code)
}
