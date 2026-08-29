import optimizedList from './optimizedCodes.json'
import templates from './templates.json'

const entryReadyCodes = new Set(optimizedList as string[])
const entryReadyFiles = new Set(
  templates
    .filter(template => !template.retired && entryReadyCodes.has(template.code))
    .map(template => template.file),
)

export function isTemplateReadyForEntry(template: { file: string; code: string; retired?: boolean }) {
  return !template.retired && entryReadyFiles.has(template.file)
}
