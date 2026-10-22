// ─────────────────────────────────────────────────────────────
//  Pure JSON Schema Validator (No external libraries)
//  Validates AI actions against schemas defined in contract.js
// ─────────────────────────────────────────────────────────────

import { ACTION_TYPES, FILTER_OPS, AGGREGATE_FNS, NUMBER_FORMATS } from './contract.js'

/**
 * Extracts the first JSON object substring from raw model output.
 * Handles markdown code fences (```json ... ``` or ``` ... ```) and surrounding prose.
 */
export function extractJsonFromText(text) {
    if (!text || typeof text !== 'string') return null

    // 1. Check for markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fenceMatch && fenceMatch[1]) {
        const candidate = fenceMatch[1].trim()
        if (candidate.startsWith('{') && candidate.endsWith('}')) {
            return candidate
        }
    }

    // 2. Scan for first balanced { ... } object in the text
    const firstBrace = text.indexOf('{')
    if (firstBrace === -1) return null

    let depth = 0
    let inString = false
    let escape = false
    let startIdx = -1

    for (let i = firstBrace; i < text.length; i++) {
        const char = text[i]

        if (escape) {
            escape = false
            continue
        }

        if (char === '\\' && inString) {
            escape = true
            continue
        }

        if (char === '"') {
            inString = !inString
            continue
        }

        if (!inString) {
            if (char === '{') {
                if (depth === 0) startIdx = i
                depth++
            } else if (char === '}') {
                depth--
                if (depth === 0 && startIdx !== -1) {
                    return text.slice(startIdx, i + 1)
                }
            }
        }
    }

    return null
}

function isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val)
}

function validateStyle(style, path = 'style') {
    if (!isPlainObject(style)) return `${path} must be an object`

    const allowedProps = new Set(['bold', 'italic', 'underline', 'bg', 'color', 'align', 'fontSize', 'numberFormat'])
    for (const key of Object.keys(style)) {
        if (!allowedProps.has(key)) return `Unknown property in ${path}: ${key}`
    }

    if (style.bold !== undefined && typeof style.bold !== 'boolean') return `${path}.bold must be boolean`
    if (style.italic !== undefined && typeof style.italic !== 'boolean') return `${path}.italic must be boolean`
    if (style.underline !== undefined && typeof style.underline !== 'boolean') return `${path}.underline must be boolean`
    if (style.fontSize !== undefined) {
        if (!Number.isInteger(style.fontSize) || style.fontSize < 8 || style.fontSize > 24) {
            return `${path}.fontSize must be an integer between 8 and 24`
        }
    }
    if (style.align !== undefined && !['left', 'center', 'right'].includes(style.align)) {
        return `${path}.align must be left, center, or right`
    }
    if (style.bg !== undefined) {
        if (style.bg !== 'white' && !/^#[0-9a-fA-F]{6}$/.test(style.bg)) {
            return `${path}.bg must be #RRGGBB or 'white'`
        }
    }
    if (style.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(style.color)) {
        return `${path}.color must be #RRGGBB`
    }
    if (style.numberFormat !== undefined && !NUMBER_FORMATS.includes(style.numberFormat)) {
        return `${path}.numberFormat must be one of: ${NUMBER_FORMATS.join(', ')}`
    }
    return null
}

/**
 * Validates a parsed action object against contract schemas.
 * Returns { valid: true } or { valid: false, error: 'INVALID_RESPONSE' | 'READ_ONLY', detail: string }
 */
export function validateAction(action, allowedTypes = null) {
    if (!isPlainObject(action)) {
        return { valid: false, error: 'INVALID_RESPONSE', detail: 'Response is not a JSON object' }
    }

    const type = action.type
    if (!type || typeof type !== 'string') {
        return { valid: false, error: 'INVALID_RESPONSE', detail: 'Missing or invalid "type" property' }
    }

    if (!Object.values(ACTION_TYPES).includes(type)) {
        return { valid: false, error: 'READ_ONLY', detail: `Action type "${type}" is not recognized or not allowed` }
    }

    if (allowedTypes && !allowedTypes.includes(type)) {
        return { valid: false, error: 'READ_ONLY', detail: `Action type "${type}" is not allowed in this context` }
    }

    // ── 1. Query Schema Validation ──
    if (type === ACTION_TYPES.QUERY) {
        const allowedKeys = new Set(['type', 'excludeTotalsRow', 'filters', 'groupBy', 'aggregates', 'columns', 'sort', 'limit'])
        for (const k of Object.keys(action)) {
            if (!allowedKeys.has(k)) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: `Unexpected property in query: ${k}` }
            }
        }

        if (action.excludeTotalsRow !== undefined && typeof action.excludeTotalsRow !== 'boolean') {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'excludeTotalsRow must be boolean' }
        }

        if (action.filters !== undefined) {
            if (!Array.isArray(action.filters)) return { valid: false, error: 'INVALID_RESPONSE', detail: 'filters must be array' }
            for (let i = 0; i < action.filters.length; i++) {
                const f = action.filters[i]
                if (!isPlainObject(f)) return { valid: false, error: 'INVALID_RESPONSE', detail: `filter[${i}] must be object` }
                if (typeof f.column !== 'string' || !f.column.trim()) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `filter[${i}].column must be non-empty string` }
                }
                if (!FILTER_OPS.includes(f.op)) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `filter[${i}].op must be one of: ${FILTER_OPS.join(', ')}` }
                }
                const allowedFilterKeys = new Set(['column', 'op', 'value'])
                for (const fk of Object.keys(f)) {
                    if (!allowedFilterKeys.has(fk)) return { valid: false, error: 'INVALID_RESPONSE', detail: `Unexpected property in filter[${i}]: ${fk}` }
                }
            }
        }

        if (action.groupBy !== undefined) {
            if (!Array.isArray(action.groupBy)) return { valid: false, error: 'INVALID_RESPONSE', detail: 'groupBy must be array' }
            for (let i = 0; i < action.groupBy.length; i++) {
                if (typeof action.groupBy[i] !== 'string') return { valid: false, error: 'INVALID_RESPONSE', detail: `groupBy[${i}] must be string` }
            }
        }

        if (action.aggregates !== undefined) {
            if (!Array.isArray(action.aggregates)) return { valid: false, error: 'INVALID_RESPONSE', detail: 'aggregates must be array' }
            for (let i = 0; i < action.aggregates.length; i++) {
                const a = action.aggregates[i]
                if (!isPlainObject(a)) return { valid: false, error: 'INVALID_RESPONSE', detail: `aggregates[${i}] must be object` }
                if (!AGGREGATE_FNS.includes(a.fn)) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `aggregates[${i}].fn must be one of: ${AGGREGATE_FNS.join(', ')}` }
                }
                if (typeof a.column !== 'string') {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `aggregates[${i}].column must be string` }
                }
                if (a.as !== undefined && typeof a.as !== 'string') {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `aggregates[${i}].as must be string` }
                }
            }
        }

        if (action.columns !== undefined) {
            if (!Array.isArray(action.columns)) return { valid: false, error: 'INVALID_RESPONSE', detail: 'columns must be array' }
            for (let i = 0; i < action.columns.length; i++) {
                if (typeof action.columns[i] !== 'string') return { valid: false, error: 'INVALID_RESPONSE', detail: `columns[${i}] must be string` }
            }
        }

        if (action.sort !== undefined) {
            if (!Array.isArray(action.sort)) return { valid: false, error: 'INVALID_RESPONSE', detail: 'sort must be array' }
            for (let i = 0; i < action.sort.length; i++) {
                const s = action.sort[i]
                if (!isPlainObject(s)) return { valid: false, error: 'INVALID_RESPONSE', detail: `sort[${i}] must be object` }
                if (typeof s.column !== 'string') return { valid: false, error: 'INVALID_RESPONSE', detail: `sort[${i}].column must be string` }
                if (s.dir !== undefined && s.dir !== 'asc' && s.dir !== 'desc') {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `sort[${i}].dir must be 'asc' or 'desc'` }
                }
            }
        }

        if (action.limit !== undefined) {
            if (!Number.isInteger(action.limit) || action.limit < 1) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'limit must be positive integer' }
            }
        }

        return { valid: true, action }
    }

    // ── 2. Format Sheet Schema Validation ──
    if (type === ACTION_TYPES.FORMAT_SHEET) {
        const allowedKeys = new Set(['type', 'clearFormatting', 'headerStyle', 'bodyStyle', 'totalsStyle', 'columns', 'freezeRows', 'columnWidths', 'autoFitColumns'])
        for (const k of Object.keys(action)) {
            if (!allowedKeys.has(k)) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: `Unexpected property in format_sheet: ${k}` }
            }
        }

        if (action.clearFormatting !== undefined && typeof action.clearFormatting !== 'boolean') {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'clearFormatting must be boolean' }
        }

        if (action.headerStyle) {
            const err = validateStyle(action.headerStyle, 'headerStyle')
            if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
        }
        if (action.bodyStyle) {
            const err = validateStyle(action.bodyStyle, 'bodyStyle')
            if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
        }
        if (action.totalsStyle) {
            const err = validateStyle(action.totalsStyle, 'totalsStyle')
            if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
        }

        if (action.columns !== undefined) {
            if (!Array.isArray(action.columns)) return { valid: false, error: 'INVALID_RESPONSE', detail: 'columns must be array' }
            for (let i = 0; i < action.columns.length; i++) {
                const colItem = action.columns[i]
                if (!isPlainObject(colItem)) return { valid: false, error: 'INVALID_RESPONSE', detail: `columns[${i}] must be object` }
                if (!Number.isInteger(colItem.col) || colItem.col < 0) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `columns[${i}].col must be non-negative integer` }
                }
                const err = validateStyle(colItem.style, `columns[${i}].style`)
                if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
            }
        }

        if (action.freezeRows !== undefined && action.freezeRows !== null) {
            if (!Number.isInteger(action.freezeRows) || action.freezeRows < 0) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'freezeRows must be non-negative integer or null' }
            }
        }

        if (action.columnWidths !== undefined) {
            if (!Array.isArray(action.columnWidths)) return { valid: false, error: 'INVALID_RESPONSE', detail: 'columnWidths must be array' }
            for (let i = 0; i < action.columnWidths.length; i++) {
                const cw = action.columnWidths[i]
                if (!isPlainObject(cw)) return { valid: false, error: 'INVALID_RESPONSE', detail: `columnWidths[${i}] must be object` }
                if (!Number.isInteger(cw.col) || cw.col < 0) return { valid: false, error: 'INVALID_RESPONSE', detail: `columnWidths[${i}].col must be non-negative integer` }
                if (!Number.isInteger(cw.width) || cw.width < 30 || cw.width > 600) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `columnWidths[${i}].width must be between 30 and 600` }
                }
            }
        }

        if (action.autoFitColumns !== undefined && typeof action.autoFitColumns !== 'boolean') {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'autoFitColumns must be boolean' }
        }

        return { valid: true, action }
    }

    // ── 3. Clarify Schema Validation ──
    if (type === ACTION_TYPES.CLARIFY) {
        if (typeof action.question !== 'string' || !action.question.trim()) {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'clarify action requires non-empty "question" string' }
        }
        return { valid: true, action }
    }

    return { valid: false, error: 'INVALID_RESPONSE', detail: `Unknown action type: ${type}` }
}

/**
 * Parses and validates raw model text response.
 */
export function parseAndValidateResponse(rawText, allowedTypes = null) {
    const jsonStr = extractJsonFromText(rawText)
    if (!jsonStr) {
        return { valid: false, error: 'INVALID_RESPONSE', detail: 'No JSON object found in response' }
    }

    let parsed
    try {
        parsed = JSON.parse(jsonStr)
    } catch (e) {
        return { valid: false, error: 'INVALID_RESPONSE', detail: `Invalid JSON: ${e.message}` }
    }

    return validateAction(parsed, allowedTypes)
}
