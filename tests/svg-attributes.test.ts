import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// TanStack Redact 0.3.1 turns camelCase SVG props into hyphenated attributes only for clip*, fill*
// and stroke* (src/core/attributes.ts, attributeName). Any other presentation attribute written in
// camelCase (textAnchor, stopColor, fontSize, …) reaches the DOM unchanged and has no effect, so
// those go into `style`, which works the same under React and Redact. Real camelCase SVG attributes
// (viewBox, pathLength, stdDeviation, …) are not presentation attributes and are not listed here.
const PRESENTATION = [
  'alignmentBaseline',
  'baselineShift',
  'colorInterpolation',
  'colorInterpolationFilters',
  'dominantBaseline',
  'floodColor',
  'floodOpacity',
  'fontFamily',
  'fontSize',
  'fontSizeAdjust',
  'fontStretch',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'imageRendering',
  'letterSpacing',
  'lightingColor',
  'markerEnd',
  'markerMid',
  'markerStart',
  'paintOrder',
  'pointerEvents',
  'shapeRendering',
  'stopColor',
  'stopOpacity',
  'textAnchor',
  'textDecoration',
  'textRendering',
  'transformOrigin',
  'unicodeBidi',
  'vectorEffect',
  'wordSpacing',
  'writingMode',
]
const ATTRIBUTE = new RegExp(`\\s(${PRESENTATION.join('|')})=`, 'g')

describe('SVG presentation attributes', () => {
  it('are set through style, not as camelCase props', () => {
    const found = globSync('src/**/*.tsx').flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => [...line.matchAll(ATTRIBUTE)].map((mm) => `${file}:${i + 1} ${mm[1]}`)),
    )
    expect(found).toEqual([])
  })
})
