// ─────────────────────────────────────────────────────────────
//  Spreadsheet Engine (Pure logic — no React, no DOM)
// ─────────────────────────────────────────────────────────────

const MAX_UNDO_HISTORY = 100
const OPERATOR_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 }

export const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const WEEKDAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const WEEKDAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// ─────────────────────────────────────────────────────────────
//  Coordinate Utilities
// ─────────────────────────────────────────────────────────────

export function columnLetterToIndex(columnLetter) {
    let index = 0
    const str = columnLetter.toUpperCase()
    for (let i = 0; i < str.length; i++) {
        index = index * 26 + (str.charCodeAt(i) - 64)
    }
    return index - 1
}

const COLUMN_LETTERS_CACHE = []
export function indexToColumnLetter(colIndex) {
    const cached = COLUMN_LETTERS_CACHE[colIndex]
    if (cached) return cached
    let label = ''
    let num = colIndex + 1
    while (num > 0) {
        num--
        label = String.fromCharCode(65 + (num % 26)) + label
        num = Math.floor(num / 26)
    }
    COLUMN_LETTERS_CACHE[colIndex] = label
    return label
}

export function indexToCellKey(row, col) {
    return `${indexToColumnLetter(col)}${row + 1}`
}

export function parseCellKey(cellKey) {
    if (!cellKey) return null
    const match = cellKey.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)$/)
    if (!match) return null
    return {
        col: columnLetterToIndex(match[2]),
        row: parseInt(match[4], 10) - 1,
        absCol: match[1] === '$',
        absRow: match[3] === '$',
        colLetters: match[2].toUpperCase(),
        rowNum: parseInt(match[4], 10)
    }
}

// ─────────────────────────────────────────────────────────────
//  Text, Number & Date Helpers
// ─────────────────────────────────────────────────────────────

export function norm(v) {
    return String(v ?? '').trim().toLowerCase()
}

export function toNum(v) {
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return Number.isNaN(v) ? null : v
    if (typeof v === 'string') {
        const s = v.trim()
        if (s === '') return null
        const fast = +s
        if (!Number.isNaN(fast) && !s.includes('%') && !s.includes('$')) {
            return fast
        }
        const isPercent = s.endsWith('%')
        const stripped = s.replace(/[$,%\s]/g, '')
        if (!/^-?\d+(\.\d+)?$/.test(stripped)) return null
        let num = parseFloat(stripped)
        if (Number.isNaN(num)) return null
        if (isPercent) num = num / 100
        return num
    }
    const n = Number(v)
    return Number.isNaN(n) ? null : n
}

export function toDate(v) {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    if (!s) return null

    // 1. ISO: YYYY-M-D or YYYY-MM-DD
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (isoMatch) {
        const y = parseInt(isoMatch[1], 10)
        const m = parseInt(isoMatch[2], 10)
        const d = parseInt(isoMatch[3], 10)
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
    }

    // 2. Slash: M/D/YYYY or MM/DD/YYYY
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (slashMatch) {
        const m = parseInt(slashMatch[1], 10)
        const d = parseInt(slashMatch[2], 10)
        const y = parseInt(slashMatch[3], 10)
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
    }

    // 3. Word: D Mon YYYY or DD Mon YYYY (e.g. 15 Jan 2024)
    const wordMatch = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/)
    if (wordMatch) {
        const d = parseInt(wordMatch[1], 10)
        const monStr = wordMatch[2].toLowerCase()
        const y = parseInt(wordMatch[3], 10)
        const monIdx = MONTH_NAMES_SHORT.findIndex(m => monStr.startsWith(m.toLowerCase()))
        if (monIdx !== -1 && d >= 1 && d <= 31) {
            return `${y}-${String(monIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
    }

    return null
}

export function detectDateFormat(s) {
    if (!s) return null
    const str = String(s).trim()
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(str)) return 'ISO'
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) return 'SLASH'
    if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(str)) return 'WORD'
    return null
}

export function formatDateTo(year, month, day, formatType) {
    const yStr = String(year)
    const mStr = String(month)
    const dStr = String(day)
    if (formatType === 'ISO') {
        return `${yStr}-${mStr.padStart(2, '0')}-${dStr.padStart(2, '0')}`
    }
    if (formatType === 'SLASH') {
        return `${mStr}/${dStr}/${yStr}`
    }
    if (formatType === 'WORD') {
        const monthName = MONTH_NAMES_SHORT[month - 1] || 'Jan'
        return `${dStr} ${monthName} ${yStr}`
    }
    return `${yStr}-${mStr.padStart(2, '0')}-${dStr.padStart(2, '0')}`
}

export function formatNumberDisplay(value, numberFormat) {
    if (!numberFormat || numberFormat === 'general') {
        return value !== null && value !== undefined ? String(value) : ''
    }

    if (numberFormat === 'date') {
        const iso = toDate(value)
        if (iso) return iso
        return value !== null && value !== undefined ? String(value) : ''
    }

    const num = toNum(value)
    if (num === null) {
        return value !== null && value !== undefined ? String(value) : ''
    }

    if (numberFormat === 'number') {
        return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    if (numberFormat === 'currency') {
        return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    if (numberFormat === 'percent') {
        const rawStr = String(value).trim()
        let pctVal = num * 100
        if (rawStr.endsWith('%')) {
            // Already a percentage, num was divided by 100, so num*100 is original percentage
            pctVal = num * 100
        }
        return (pctVal % 1 === 0 ? pctVal.toFixed(0) : pctVal.toFixed(2)) + '%'
    }

    return value !== null && value !== undefined ? String(value) : ''
}

// ─────────────────────────────────────────────────────────────
//  Dependency Graph
// ─────────────────────────────────────────────────────────────

function createDependencyGraph() {
    const forwardEdges = new Map() // cell -> Set of cells it depends on
    const reverseEdges = new Map() // cell -> Set of cells depending on it

    function addDependency(cell, dependsOn) {
        if (!forwardEdges.has(cell)) forwardEdges.set(cell, new Set())
        if (!reverseEdges.has(dependsOn)) reverseEdges.set(dependsOn, new Set())
        forwardEdges.get(cell).add(dependsOn)
        reverseEdges.get(dependsOn).add(cell)
    }

    function removeAllDependencies(cell) {
        const deps = forwardEdges.get(cell)
        if (deps) {
            for (const dep of deps) {
                if (reverseEdges.has(dep)) {
                    reverseEdges.get(dep).delete(cell)
                    if (reverseEdges.get(dep).size === 0) reverseEdges.delete(dep)
                }
            }
            forwardEdges.delete(cell)
        }
    }

    function getDependencies(cell) {
        return forwardEdges.get(cell) || new Set()
    }

    function getDependents(cell) {
        return reverseEdges.get(cell) || new Set()
    }

    function getAllDependentsRecursive(cell, visited = new Set()) {
        if (visited.has(cell)) return new Set()
        visited.add(cell)
        const result = new Set()
        for (const dependent of getDependents(cell)) {
            result.add(dependent)
            for (const indirect of getAllDependentsRecursive(dependent, visited)) {
                result.add(indirect)
            }
        }
        return result
    }

    function hasCycle(startCell) {
        const visited = new Set()
        const recursionStack = new Set()
        const dfs = (node) => {
            if (recursionStack.has(node)) return true
            if (visited.has(node)) return false
            visited.add(node)
            recursionStack.add(node)
            for (const dep of getDependencies(node)) {
                if (dfs(dep)) return true
            }
            recursionStack.delete(node)
            return false
        }
        return dfs(startCell)
    }

    function topologicalSort(affectedCells) {
        const inDegree = new Map()
        const queue = []
        const sorted = []

        for (const cell of affectedCells) inDegree.set(cell, 0)
        for (const cell of affectedCells) {
            for (const dep of getDependencies(cell)) {
                if (affectedCells.has(dep)) {
                    inDegree.set(cell, (inDegree.get(cell) || 0) + 1)
                }
            }
        }
        for (const cell of affectedCells) {
            if (inDegree.get(cell) === 0) queue.push(cell)
        }
        let head = 0
        while (head < queue.length) {
            const cell = queue[head++]
            sorted.push(cell)
            for (const dependent of getDependents(cell)) {
                if (affectedCells.has(dependent)) {
                    inDegree.set(dependent, inDegree.get(dependent) - 1)
                    if (inDegree.get(dependent) === 0) queue.push(dependent)
                }
            }
        }
        return sorted
    }

    function clear() {
        forwardEdges.clear()
        reverseEdges.clear()
    }

    return {
        addDependency,
        removeAllDependencies,
        getDependencies,
        getDependents,
        getAllDependentsRecursive,
        hasCycle,
        topologicalSort,
        clear
    }
}

// ─────────────────────────────────────────────────────────────
//  Formula Parser & AST Evaluator
// ─────────────────────────────────────────────────────────────

export function expandCellRange(startKey, endKey) {
    const start = parseCellKey(startKey)
    const end = parseCellKey(endKey)
    if (!start || !end) throw new Error('REF')

    const rMin = Math.min(start.row, end.row)
    const rMax = Math.max(start.row, end.row)
    const cMin = Math.min(start.col, end.col)
    const cMax = Math.max(start.col, end.col)

    const cells = []
    for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
            cells.push(indexToCellKey(r, c))
        }
    }
    return cells
}

export function tokenize(expression) {
    const tokens = []
    let pos = 0
    const len = expression.length

    while (pos < len) {
        const char = expression[pos]

        if (char === ' ' || char === '\t') {
            pos++
            continue
        }

        if (char === '(' || char === ')') {
            tokens.push({ type: 'paren', value: char })
            pos++
            continue
        }

        if ('+-*/,'.includes(char)) {
            tokens.push({ type: 'operator', value: char })
            pos++
            continue
        }

        if ((char >= '0' && char <= '9') || char === '.') {
            let numStr = ''
            while (pos < len && ((expression[pos] >= '0' && expression[pos] <= '9') || expression[pos] === '.')) {
                numStr += expression[pos]
                pos++
            }
            tokens.push({ type: 'number', value: parseFloat(numStr) })
            continue
        }

        // Cell or range or function
        if (char === '$' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')) {
            // Check for range or cell
            const sub = expression.slice(pos)
            // Match range like $A$1:$B$5 or A1:B5
            const rangeMatch = sub.match(/^(\$?[A-Za-z]+\$?\d+)\s*:\s*(\$?[A-Za-z]+\$?\d+)/)
            if (rangeMatch) {
                tokens.push({ type: 'range', start: rangeMatch[1].toUpperCase(), end: rangeMatch[2].toUpperCase() })
                pos += rangeMatch[0].length
                continue
            }

            // Match single cell like $A$1 or A1
            const cellMatch = sub.match(/^(\$?[A-Za-z]+\$?\d+)\b/)
            if (cellMatch) {
                tokens.push({ type: 'cell', value: cellMatch[1].toUpperCase() })
                pos += cellMatch[0].length
                continue
            }

            // Match identifier (function name like SUM, AVG)
            const identMatch = sub.match(/^([A-Za-z]+)\b/)
            if (identMatch) {
                tokens.push({ type: 'function', value: identMatch[1].toUpperCase() })
                pos += identMatch[0].length
                continue
            }
        }

        throw new Error(`Unexpected character: ${char}`)
    }

    return tokens
}

export function parseTokensToAST(tokens) {
    const outputQueue = []
    const operatorStack = []
    let pos = 0

    while (pos < tokens.length) {
        const token = tokens[pos]

        if (token.type === 'number' || token.type === 'cell' || token.type === 'range') {
            outputQueue.push(token)
            pos++
        } else if (token.type === 'function') {
            operatorStack.push(token)
            pos++
        } else if (token.type === 'operator') {
            while (
                operatorStack.length > 0 &&
                operatorStack[operatorStack.length - 1].type === 'operator' &&
                OPERATOR_PRECEDENCE[operatorStack[operatorStack.length - 1].value] >= OPERATOR_PRECEDENCE[token.value]
            ) {
                outputQueue.push(operatorStack.pop())
            }
            operatorStack.push(token)
            pos++
        } else if (token.type === 'paren' && token.value === '(') {
            operatorStack.push(token)
            pos++
        } else if (token.type === 'paren' && token.value === ')') {
            while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value !== '(') {
                outputQueue.push(operatorStack.pop())
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value === '(') {
                operatorStack.pop() // discard '('
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].type === 'function') {
                const funcToken = operatorStack.pop()
                if (outputQueue.length > 0 && outputQueue[outputQueue.length - 1].type === 'range') {
                    const rangeToken = outputQueue.pop()
                    outputQueue.push({ type: 'function', name: funcToken.value, range: rangeToken })
                } else {
                    outputQueue.push(funcToken)
                }
            }
            pos++
        } else {
            pos++
        }
    }

    while (operatorStack.length > 0) {
        const op = operatorStack.pop()
        if (op.value === '(') throw new Error('Mismatched parentheses')
        outputQueue.push(op)
    }

    return buildASTFromRPN(outputQueue)
}

function buildASTFromRPN(rpnTokens) {
    const stack = []

    for (const token of rpnTokens) {
        if (token.type === 'number' || token.type === 'cell' || token.type === 'range') {
            stack.push(token)
        } else if (token.type === 'operator') {
            if (stack.length < 2) throw new Error('Invalid expression')
            const right = stack.pop()
            const left = stack.pop()
            stack.push({ type: 'binary', operator: token.value, left, right })
        } else if (token.type === 'function') {
            if (token.range) {
                stack.push(token)
            } else {
                if (stack.length === 0) throw new Error(`Function ${token.value} requires arguments`)
                const argument = stack.pop()
                if (argument.type === 'range') {
                    stack.push({ type: 'function', name: token.value, range: argument })
                } else {
                    throw new Error(`Function ${token.value} requires a range`)
                }
            }
        }
    }

    if (stack.length !== 1) throw new Error('Invalid expression')
    return stack[0]
}

function evaluateAST(ast, getCellValue, visited = new Set()) {
    if (!ast) return 0

    if (ast.type === 'number') return ast.value

    if (ast.type === 'cell') {
        const canonicalKey = ast.value.replace(/\$/g, '')
        if (visited.has(canonicalKey)) throw new Error('CIRCULAR')
        visited.add(canonicalKey)
        const rawVal = getCellValue(canonicalKey, visited)
        visited.delete(canonicalKey)
        const num = toNum(rawVal)
        return num !== null ? num : (rawVal || 0)
    }

    if (ast.type === 'range') throw new Error('VALUE')

    if (ast.type === 'binary') {
        const leftVal = evaluateAST(ast.left, getCellValue, visited)
        const rightVal = evaluateAST(ast.right, getCellValue, visited)
        const leftNum = typeof leftVal === 'number' ? leftVal : toNum(leftVal)
        const rightNum = typeof rightVal === 'number' ? rightVal : toNum(rightVal)
        if (leftNum === null || rightNum === null) throw new Error('VALUE')

        switch (ast.operator) {
            case '+': return leftNum + rightNum
            case '-': return leftNum - rightNum
            case '*': return leftNum * rightNum
            case '/':
                if (rightNum === 0) throw new Error('VALUE')
                return leftNum / rightNum
            default: throw new Error('VALUE')
        }
    }

    if (ast.type === 'function') {
        const rangeCells = expandCellRange(ast.range.start, ast.range.end)
        const values = rangeCells.map(cellKey => {
            const canonicalKey = cellKey.replace(/\$/g, '')
            if (visited.has(canonicalKey)) throw new Error('CIRCULAR')
            visited.add(canonicalKey)
            const val = getCellValue(canonicalKey, visited)
            visited.delete(canonicalKey)
            const num = toNum(val)
            return num !== null ? num : 0
        })

        switch (ast.name) {
            case 'SUM': return values.reduce((sum, val) => sum + val, 0)
            case 'AVG': return values.length === 0 ? 0 : values.reduce((sum, val) => sum + val, 0) / values.length
            case 'MIN': return values.length === 0 ? 0 : Math.min(...values)
            case 'MAX': return values.length === 0 ? 0 : Math.max(...values)
            default: throw new Error('VALUE')
        }
    }

    throw new Error('VALUE')
}

export function evaluateFormula(expression, getCellValue) {
    try {
        if (!expression || String(expression).trim() === '') return { value: '', error: null }
        if (!String(expression).startsWith('=')) return { value: expression, error: null }

        const formulaBody = expression.slice(1).trim()
        if (formulaBody === '') return { value: '', error: null }

        const tokens = tokenize(formulaBody)
        const ast = parseTokensToAST(tokens)
        const result = evaluateAST(ast, getCellValue)
        return { value: result, error: null }
    } catch (error) {
        if (error.message === 'CIRCULAR') return { value: null, error: '#CYCLE!' }
        if (error.message === 'REF') return { value: null, error: '#REF!' }
        if (error.message === 'VALUE') return { value: null, error: '#VALUE!' }
        return { value: null, error: '#PARSE!' }
    }
}

// ─────────────────────────────────────────────────────────────
//  Reference Shifting & Extraction
// ─────────────────────────────────────────────────────────────

export function extractCellReferences(formula) {
    const references = new Set()
    if (!formula || !formula.startsWith('=')) return references

    // Check ranges first
    const rangeRegex = /(\$?[A-Za-z]+\$?\d+)\s*:\s*(\$?[A-Za-z]+\$?\d+)/g
    let rMatch
    while ((rMatch = rangeRegex.exec(formula)) !== null) {
        try {
            const cells = expandCellRange(rMatch[1], rMatch[2])
            for (const c of cells) references.add(c)
        } catch {
            // ignore invalid range in extract
        }
    }

    // Check individual cells
    const cellRegex = /(\$?[A-Za-z]+\$?\d+)/g
    let cMatch
    while ((cMatch = cellRegex.exec(formula)) !== null) {
        references.add(cMatch[1].replace(/\$/g, '').toUpperCase())
    }
    return references
}

/**
 * Shifts formula references for row/col insert/delete, fill handle, or row sorting.
 */
export function shiftFormulaReferences(formula, options = {}) {
    if (!formula || typeof formula !== 'string' || !formula.startsWith('=')) return formula

    const {
        rowOffset = 0,
        colOffset = 0,
        isFillHandle = false,
        insertRowAt = undefined,
        deleteRowAt = undefined,
        insertColAt = undefined,
        deleteColAt = undefined,
        rowMapping = undefined, // Map<oldRowIndex, newRowIndex>
        sortBlock = undefined,  // { r1, r2 }
    } = options

    // 1. If sortBlock is defined and a range spans the ENTIRE block (e.g. J2:J32): keep unchanged!
    let transformedFormula = formula
    if (sortBlock) {
        const fullRangeRegex = new RegExp(
            `(\\$?[A-Za-z]+)(\\$?)(${sortBlock.r1 + 1})\\s*:\\s*(\\$?[A-Za-z]+)(\\$?)(${sortBlock.r2 + 1})\\b`,
            'g'
        )
        // Temporarily protect full range matches
        const protectedRanges = []
        transformedFormula = transformedFormula.replace(fullRangeRegex, (match) => {
            protectedRanges.push(match)
            return `__PROTECTED_RANGE_${protectedRanges.length - 1}__`
        })

        // Now shift remaining references
        transformedFormula = replaceReferences(transformedFormula)

        // Restore protected ranges
        for (let i = 0; i < protectedRanges.length; i++) {
            transformedFormula = transformedFormula.replace(`__PROTECTED_RANGE_${i}__`, protectedRanges[i])
        }
        return transformedFormula
    }

    return replaceReferences(transformedFormula)

    function replaceReferences(text) {
        return text.replace(/(\$?)([A-Za-z]+)(\$?)(\d+)/g, (match, absColPrefix, colLetters, absRowPrefix, rowStr) => {
            const colIdx = columnLetterToIndex(colLetters)
            const rowIdx = parseInt(rowStr, 10) - 1
            const hasAbsCol = absColPrefix === '$'
            const hasAbsRow = absRowPrefix === '$'

            let newCol = colIdx
            let newRow = rowIdx

            if (isFillHandle) {
                if (!hasAbsCol) newCol = colIdx + colOffset
                if (!hasAbsRow) newRow = rowIdx + rowOffset
            } else if (insertRowAt !== undefined) {
                if (rowIdx >= insertRowAt) newRow = rowIdx + 1
            } else if (deleteRowAt !== undefined) {
                if (rowIdx === deleteRowAt) return '#REF!'
                if (rowIdx > deleteRowAt) newRow = rowIdx - 1
            } else if (insertColAt !== undefined) {
                if (colIdx >= insertColAt) newCol = colIdx + 1
            } else if (deleteColAt !== undefined) {
                if (colIdx === deleteColAt) return '#REF!'
                if (colIdx > deleteColAt) newCol = colIdx - 1
            } else if (rowMapping) {
                if (rowMapping.has(rowIdx)) {
                    newRow = rowMapping.get(rowIdx)
                }
            }

            if (newRow < 0 || newCol < 0) return '#REF!'
            return `${absColPrefix}${indexToColumnLetter(newCol)}${absRowPrefix}${newRow + 1}`
        })
    }
}

// ─────────────────────────────────────────────────────────────
//  Fill Handle Logic
// ─────────────────────────────────────────────────────────────

export function extrapolateFill(seedList, targetCount, direction = 'down') {
    // seedList is array of { raw, style }
    if (!seedList || seedList.length === 0) return []
    const K = seedList.length
    const results = []

    // Check if formulas
    const allFormulas = seedList.every(s => s.raw && s.raw.startsWith('='))
    if (allFormulas) {
        for (let step = 1; step <= targetCount; step++) {
            const seedIdx = (step - 1) % K
            const seed = seedList[seedIdx]
            const rOffset = (direction === 'down' ? (step + (K - 1 - seedIdx)) : direction === 'up' ? -step : 0)
            const cOffset = (direction === 'right' ? (step + (K - 1 - seedIdx)) : direction === 'left' ? -step : 0)
            // Exact formula offset relative to the seed cell
            const shiftedRaw = shiftFormulaReferences(seed.raw, { rowOffset: rOffset, colOffset: cOffset, isFillHandle: true })
            results.push({ raw: shiftedRaw, style: seed.style ? { ...seed.style } : undefined })
        }
        return results
    }

    // Check if dates
    const allDates = seedList.every(s => toDate(s.raw) !== null)
    if (allDates) {
        const parsedDates = seedList.map(s => {
            const iso = toDate(s.raw)
            const [y, m, d] = iso.split('-').map(Number)
            return {
                utc: Date.UTC(y, m - 1, d),
                format: detectDateFormat(s.raw) || 'ISO',
                style: s.style
            }
        })

        let deltaDays = 1
        if (K > 1) {
            deltaDays = Math.round((parsedDates[K - 1].utc - parsedDates[0].utc) / (K - 1) / (24 * 3600 * 1000))
            if (deltaDays === 0) deltaDays = 1
        }
        if (direction === 'up' || direction === 'left') deltaDays = -deltaDays

        const lastUtc = parsedDates[K - 1].utc
        for (let step = 1; step <= targetCount; step++) {
            const targetUtc = lastUtc + step * deltaDays * 24 * 3600 * 1000
            const dObj = new Date(targetUtc)
            const seedIdx = (step - 1) % K
            const targetFormat = parsedDates[seedIdx].format
            const formatted = formatDateTo(dObj.getUTCFullYear(), dObj.getUTCMonth() + 1, dObj.getUTCDate(), targetFormat)
            results.push({ raw: formatted, style: parsedDates[seedIdx].style ? { ...parsedDates[seedIdx].style } : undefined })
        }
        return results
    }

    // Check weekdays
    const isWeekday = (s) => {
        const l = norm(s)
        return WEEKDAY_NAMES_SHORT.some(w => w.toLowerCase() === l) || WEEKDAY_NAMES_FULL.some(w => w.toLowerCase() === l)
    }
    if (seedList.every(s => isWeekday(s.raw))) {
        const getWkIdx = (str) => {
            const l = norm(str)
            let idx = WEEKDAY_NAMES_SHORT.findIndex(w => w.toLowerCase() === l)
            if (idx !== -1) return { idx, isShort: true }
            return { idx: WEEKDAY_NAMES_FULL.findIndex(w => w.toLowerCase() === l), isShort: false }
        }
        const parsed = seedList.map(s => getWkIdx(s.raw))
        let stepDelta = 1
        if (K > 1) {
            stepDelta = (parsed[K - 1].idx - parsed[0].idx + 7) % 7
            if (stepDelta === 0) stepDelta = 1
        }
        if (direction === 'up' || direction === 'left') stepDelta = -stepDelta

        let currentIdx = parsed[K - 1].idx
        for (let step = 1; step <= targetCount; step++) {
            currentIdx = (currentIdx + stepDelta + 7000) % 7
            const seed = seedList[(step - 1) % K]
            const isUpper = seed.raw === seed.raw.toUpperCase()
            const isLower = seed.raw === seed.raw.toLowerCase()
            const info = parsed[(step - 1) % K]
            let name = info.isShort ? WEEKDAY_NAMES_SHORT[currentIdx] : WEEKDAY_NAMES_FULL[currentIdx]
            if (isUpper) name = name.toUpperCase()
            else if (isLower) name = name.toLowerCase()
            results.push({ raw: name, style: seed.style ? { ...seed.style } : undefined })
        }
        return results
    }

    // Check months
    const isMonth = (s) => {
        const l = norm(s)
        return MONTH_NAMES_SHORT.some(m => m.toLowerCase() === l) || MONTH_NAMES_FULL.some(m => m.toLowerCase() === l)
    }
    if (seedList.every(s => isMonth(s.raw))) {
        const getMonIdx = (str) => {
            const l = norm(str)
            let idx = MONTH_NAMES_SHORT.findIndex(m => m.toLowerCase() === l)
            if (idx !== -1) return { idx, isShort: true }
            return { idx: MONTH_NAMES_FULL.findIndex(m => m.toLowerCase() === l), isShort: false }
        }
        const parsed = seedList.map(s => getMonIdx(s.raw))
        let stepDelta = 1
        if (K > 1) {
            stepDelta = (parsed[K - 1].idx - parsed[0].idx + 12) % 12
            if (stepDelta === 0) stepDelta = 1
        }
        if (direction === 'up' || direction === 'left') stepDelta = -stepDelta

        let currentIdx = parsed[K - 1].idx
        for (let step = 1; step <= targetCount; step++) {
            currentIdx = (currentIdx + stepDelta + 12000) % 12
            const seed = seedList[(step - 1) % K]
            const isUpper = seed.raw === seed.raw.toUpperCase()
            const isLower = seed.raw === seed.raw.toLowerCase()
            const info = parsed[(step - 1) % K]
            let name = info.isShort ? MONTH_NAMES_SHORT[currentIdx] : MONTH_NAMES_FULL[currentIdx]
            if (isUpper) name = name.toUpperCase()
            else if (isLower) name = name.toLowerCase()
            results.push({ raw: name, style: seed.style ? { ...seed.style } : undefined })
        }
        return results
    }

    // Check text ending in numbers (e.g. "ORD-1001", "Item 1", "Q4", "2024-W01")
    const numEndRegex = /^(.*?)(\d+)$/
    const allEndInNum = seedList.every(s => s.raw && numEndRegex.test(s.raw))
    if (allEndInNum) {
        const parsed = seedList.map(s => {
            const m = s.raw.match(numEndRegex)
            return {
                prefix: m[1],
                num: parseInt(m[2], 10),
                digits: m[2].length,
                style: s.style
            }
        })

        // Check if prefixes match
        const firstPrefix = parsed[0].prefix
        const prefixesMatch = parsed.every(p => p.prefix === firstPrefix)
        if (prefixesMatch) {
            let delta = 1
            if (K > 1) {
                delta = Math.round((parsed[K - 1].num - parsed[0].num) / (K - 1))
                if (delta === 0) delta = 1
            }
            if (direction === 'up' || direction === 'left') delta = -delta

            const baseNum = parsed[K - 1].num
            const digits = parsed[K - 1].digits
            for (let step = 1; step <= targetCount; step++) {
                const nextVal = baseNum + step * delta
                const padded = String(Math.max(0, nextVal)).padStart(digits, '0')
                const seed = seedList[(step - 1) % K]
                results.push({ raw: `${firstPrefix}${padded}`, style: seed.style ? { ...seed.style } : undefined })
            }
            return results
        }
    }

    // Check numbers
    const allNumbers = seedList.every(s => s.raw && !isNaN(Number(s.raw)))
    if (allNumbers) {
        const nums = seedList.map(s => Number(s.raw))
        if (K === 1) {
            // One seed -> copy
            for (let step = 1; step <= targetCount; step++) {
                results.push({ raw: seedList[0].raw, style: seedList[0].style ? { ...seedList[0].style } : undefined })
            }
            return results
        }
        let delta = (nums[K - 1] - nums[0]) / (K - 1)
        if (direction === 'up' || direction === 'left') delta = -delta

        const baseNum = nums[K - 1]
        for (let step = 1; step <= targetCount; step++) {
            const nextVal = baseNum + step * delta
            // Clean up float representation
            const rawStr = parseFloat(nextVal.toFixed(10)).toString()
            const seed = seedList[(step - 1) % K]
            results.push({ raw: rawStr, style: seed.style ? { ...seed.style } : undefined })
        }
        return results
    }

    // Default: cycle seeds
    for (let step = 1; step <= targetCount; step++) {
        const seedIdx = (step - 1) % K
        const seed = seedList[seedIdx]
        results.push({ raw: seed.raw, style: seed.style ? { ...seed.style } : undefined })
    }
    return results
}

// ─────────────────────────────────────────────────────────────
//  Main Engine Factory
// ─────────────────────────────────────────────────────────────

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    const cells = new Map()       // key "A1" -> { raw, computed, error, style }
    const graph = createDependencyGraph()
    const dirtyCells = new Set()
    const computedCache = new Map()
    const undoStack = []
    const redoStack = []

    // Stable row identities for sorting
    // rowIdentities[r] is an immutable ID given to the row at its inception
    let nextRowIdentity = 0
    let rowIdentities = Array.from({ length: initialRows }, () => nextRowIdentity++)

    let _generation = 0
    let _batchMode = false

    function cellKey(row, col) {
        return indexToCellKey(row, col)
    }

    function cellCoords(key) {
        return parseCellKey(key)
    }

    function isValidCellKey(key) {
        const coords = cellCoords(key)
        return coords && coords.row >= 0 && coords.row < rows && coords.col >= 0 && coords.col < cols
    }

    let formulaCount = 0

    function updateDependencies(key, rawFormula) {
        const canonicalKey = key.replace(/\$/g, '').toUpperCase()
        for (const ref of extractCellReferences(rawFormula)) {
            const canonicalRef = ref.replace(/\$/g, '').toUpperCase()
            if (isValidCellKey(canonicalRef)) {
                graph.addDependency(canonicalKey, canonicalRef)
            }
        }
    }

    function markCellDirty(key) {
        cachedUsedRange = null
        const canonicalKey = key.replace(/\$/g, '').toUpperCase()
        dirtyCells.add(canonicalKey)
        const deps = graph.getDependents(canonicalKey)
        if (deps.size > 0) {
            for (const dependent of graph.getAllDependentsRecursive(canonicalKey)) {
                dirtyCells.add(dependent)
            }
        }
    }

    function markAllCellsDirty() {
        cachedUsedRange = null
        for (const key of cells.keys()) dirtyCells.add(key)
    }

    function resolveCellValue(key, visited = new Set()) {
        const canonicalKey = key.replace(/\$/g, '').toUpperCase()
        if (visited.has(canonicalKey)) return '#CYCLE!'
        visited.add(canonicalKey)

        if (computedCache.has(canonicalKey)) {
            const cached = computedCache.get(canonicalKey)
            if (cached._gen === _generation && !dirtyCells.has(canonicalKey)) {
                visited.delete(canonicalKey)
                return cached.error || cached.computed
            }
            computedCache.delete(canonicalKey)
        }

        const cell = cells.get(canonicalKey)
        if (!cell || !cell.raw) {
            visited.delete(canonicalKey)
            return ''
        }

        if (!cell.raw.startsWith('=')) {
            const numericValue = toNum(cell.raw)
            visited.delete(canonicalKey)
            return numericValue !== null ? numericValue : cell.raw
        }

        const result = evaluateFormula(cell.raw, (refKey) => resolveCellValue(refKey, visited))
        visited.delete(canonicalKey)

        if (result.error) {
            computedCache.set(canonicalKey, { computed: null, error: result.error, _gen: _generation })
            return result.error
        }

        computedCache.set(canonicalKey, { computed: result.value, error: null, _gen: _generation })
        return result.value
    }

    function recalculate() {
        if (dirtyCells.size === 0) return
        if (formulaCount === 0) {
            dirtyCells.clear()
            return
        }

        const affected = new Set(dirtyCells)
        const sorted = graph.topologicalSort(affected)
        const sortedSet = new Set(sorted)

        for (const cell of sorted) {
            if (dirtyCells.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }
        for (const cell of affected) {
            if (!sortedSet.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }

        dirtyCells.clear()
    }

    function setCellRawInternal(row, col, raw, style = undefined) {
        const key = cellKey(row, col)
        graph.removeAllDependencies(key)
        computedCache.delete(key)

        const existing = cells.get(key)
        const newStyle = style !== undefined ? style : existing?.style
        if (existing?.raw?.startsWith('=')) formulaCount--

        if ((!raw || String(raw).trim() === '') && !newStyle) {
            cells.delete(key)
            markCellDirty(key)
            return
        }

        const rawStr = String(raw ?? '')
        if (rawStr.startsWith('=')) {
            formulaCount++
            cells.set(key, { raw: rawStr, computed: null, error: null, style: newStyle })
            updateDependencies(key, rawStr)
            if (graph.hasCycle(key)) {
                graph.removeAllDependencies(key)
                cells.set(key, { raw: rawStr, computed: null, error: '#CYCLE!', style: newStyle })
                markCellDirty(key)
                return
            }
        } else {
            cells.set(key, { raw: rawStr, computed: null, error: null, style: newStyle })
        }

        markCellDirty(key)
    }

    function pushToUndoStack(entry) {
        undoStack.push({ ...entry, _gen: _generation })
        if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
        redoStack.length = 0
    }

    const EMPTY_CELL = Object.freeze({ raw: '', computed: null, error: null, style: undefined })

    function getCellRaw(row, col) {
        const key = cellKey(row, col)
        const cell = cells.get(key)
        return cell || EMPTY_CELL
    }

    function getCellForDisplay(row, col) {
        const cell = getCellRaw(row, col)
        const key = cellKey(row, col)
        const value = resolveCellValue(key)

        let computed = value
        let error = null
        if (typeof value === 'string' && value.startsWith('#')) {
            error = value
            computed = null
        }

        return {
            raw: cell.raw,
            computed,
            error,
            style: cell.style ? { ...cell.style } : undefined
        }
    }

    function getFormatDisplay(row, col) {
        const cell = getCellForDisplay(row, col)
        if (cell.error) return cell.error
        const fmt = cell.style?.numberFormat
        if (!fmt || fmt === 'general') {
            if (cell.raw && cell.raw.startsWith('=')) {
                return cell.computed !== null && cell.computed !== '' ? String(cell.computed) : ''
            }
            return cell.raw || ''
        }
        const val = cell.computed !== null && cell.computed !== '' ? cell.computed : cell.raw
        return formatNumberDisplay(val, fmt)
    }

    // ── Used range & Totals row ──

    let cachedUsedRange = null

    function fastCellCoords(key) {
        let col = 0
        let i = 0
        const len = key.length
        while (i < len) {
            const code = key.charCodeAt(i)
            if (code >= 65 && code <= 90) {
                col = col * 26 + (code - 64)
                i++
            } else if (code >= 97 && code <= 122) {
                col = col * 26 + (code - 96)
                i++
            } else break
        }
        col--
        let row = 0
        while (i < len) {
            const code = key.charCodeAt(i)
            if (code >= 48 && code <= 57) {
                row = row * 10 + (code - 48)
            }
            i++
        }
        return { row: row - 1, col }
    }

    function getUsedRange() {
        if (cachedUsedRange) return { ...cachedUsedRange }
        let minR = rows, maxR = -1, minC = cols, maxC = -1
        for (const [key, cell] of cells.entries()) {
            if ((cell.raw && cell.raw.trim() !== '') || cell.style) {
                const coords = fastCellCoords(key)
                if (coords.row < minR) minR = coords.row
                if (coords.row > maxR) maxR = coords.row
                if (coords.col < minC) minC = coords.col
                if (coords.col > maxC) maxC = coords.col
            }
        }
        if (maxR === -1) {
            cachedUsedRange = { minRow: 0, minCol: 0, maxRow: 0, maxCol: 0, rowCount: 0, colCount: 0 }
            return { ...cachedUsedRange }
        }
        cachedUsedRange = {
            minRow: minR,
            minCol: minC,
            maxRow: maxR,
            maxCol: maxC,
            rowCount: maxR - minR + 1,
            colCount: maxC - minC + 1
        }
        return { ...cachedUsedRange }
    }

    function isTotalsRow(rowIndex, minCol = 0, maxCol = cols - 1) {
        let firstFilled = null
        let filledCount = 0
        let hasEmpty = false
        const totalCols = maxCol - minCol + 1

        for (let c = minCol; c <= maxCol; c++) {
            const raw = getCellRaw(rowIndex, c).raw.trim()
            if (raw !== '') {
                filledCount++
                if (firstFilled === null) firstFilled = raw
            } else {
                hasEmpty = true
            }
        }

        if (!firstFilled) return false

        // 1. Matches regex
        if (/^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(firstFilled)) {
            return true
        }

        // 2. Summary line heuristic: non-numeric label first, then numbers, at least 1 empty column, >= 2 filled, not all filled
        if (toNum(firstFilled) === null && filledCount >= 2 && hasEmpty && filledCount < totalCols) {
            return true
        }

        return false
    }

    // ── Single cell operations ──

    function executeSetCell(row, col, value) {
        const prev = getCellRaw(row, col)
        if (prev.raw !== value) {
            pushToUndoStack({
                type: 'set',
                r: row,
                c: col,
                oldVal: prev.raw,
                newVal: value,
                oldStyle: prev.style ? { ...prev.style } : undefined,
                newStyle: prev.style ? { ...prev.style } : undefined
            })
        }
        setCellRawInternal(row, col, value)
        _generation++
        recalculate()
    }

    function setCellStyle(row, col, styleUpdates) {
        const prev = getCellRaw(row, col)
        const updatedStyle = { ...(prev.style || {}), ...styleUpdates }
        pushToUndoStack({
            type: 'set',
            r: row,
            c: col,
            oldVal: prev.raw,
            newVal: prev.raw,
            oldStyle: prev.style ? { ...prev.style } : undefined,
            newStyle: updatedStyle
        })
        setCellRawInternal(row, col, prev.raw, updatedStyle)
        _generation++
    }

    function getCellStyle(row, col) {
        return getCellRaw(row, col).style || {
            bold: false, italic: false, underline: false,
            bg: 'white', color: '#202124', align: 'left', fontSize: 13, numberFormat: 'general'
        }
    }

    // ── Bulk & Range operations ──

    function setRangeStyle(range, styleUpdates) {
        const { r1, c1, r2, c2 } = range
        const minR = Math.min(r1, r2)
        const maxR = Math.max(r1, r2)
        const minC = Math.min(c1, c2)
        const maxC = Math.max(c1, c2)

        const before = []
        const after = []

        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                const prev = getCellRaw(r, c)
                const nextStyle = { ...(prev.style || {}), ...styleUpdates }
                before.push({ r, c, raw: prev.raw, style: prev.style ? { ...prev.style } : undefined })
                after.push({ r, c, raw: prev.raw, style: nextStyle })
                setCellRawInternal(r, c, prev.raw, nextStyle)
            }
        }

        pushToUndoStack({ type: 'bulk', before, after, description: 'format' })
        _generation++
    }

    function clearRange(range) {
        const { r1, c1, r2, c2 } = range
        const minR = Math.min(r1, r2)
        const maxR = Math.max(r1, r2)
        const minC = Math.min(c1, c2)
        const maxC = Math.max(c1, c2)

        const before = []
        const after = []

        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                const prev = getCellRaw(r, c)
                if (prev.raw || prev.style) {
                    before.push({ r, c, raw: prev.raw, style: prev.style ? { ...prev.style } : undefined })
                    after.push({ r, c, raw: '', style: undefined })
                    setCellRawInternal(r, c, '', undefined)
                }
            }
        }

        if (before.length > 0) {
            pushToUndoStack({ type: 'bulk', before, after, description: 'clear' })
            _generation++
            recalculate()
        }
    }

    function batchSetCells(updates, description = 'batch', isUndoable = true) {
        // updates is array of { r, c, raw, style }
        const before = []
        const after = []

        for (const u of updates) {
            const prev = getCellRaw(u.r, u.c)
            before.push({ r: u.r, c: u.c, raw: prev.raw, style: prev.style ? { ...prev.style } : undefined })
            const nextRaw = u.raw !== undefined ? u.raw : prev.raw
            const nextStyle = u.style !== undefined ? u.style : prev.style
            after.push({ r: u.r, c: u.c, raw: nextRaw, style: nextStyle ? { ...nextStyle } : undefined })
            setCellRawInternal(u.r, u.c, nextRaw, nextStyle)
        }

        if (isUndoable && before.length > 0) {
            pushToUndoStack({ type: 'bulk', before, after, description })
        }
        _generation++
        recalculate()
    }

    // ── Fill Handle Execution ──

    function fill(sourceRange, targetRange) {
        const srcMinR = Math.min(sourceRange.r1, sourceRange.r2)
        const srcMaxR = Math.max(sourceRange.r1, sourceRange.r2)
        const srcMinC = Math.min(sourceRange.c1, sourceRange.c2)
        const srcMaxC = Math.max(sourceRange.c1, sourceRange.c2)

        const tgtMinR = Math.min(targetRange.r1, targetRange.r2)
        const tgtMaxR = Math.max(targetRange.r1, targetRange.r2)
        const tgtMinC = Math.min(targetRange.c1, targetRange.c2)
        const tgtMaxC = Math.max(targetRange.c1, targetRange.c2)

        // Ensure capacity
        ensureCapacity(Math.max(srcMaxR, tgtMaxR) + 1, Math.max(srcMaxC, tgtMaxC) + 1)

        const updates = []
        const before = []

        // Determine orientation: vertical or horizontal
        if (tgtMaxR > srcMaxR) {
            // Drag down
            const count = tgtMaxR - srcMaxR
            for (let c = srcMinC; c <= srcMaxC; c++) {
                const seeds = []
                for (let r = srcMinR; r <= srcMaxR; r++) {
                    const rawData = getCellRaw(r, c)
                    seeds.push({ raw: rawData.raw, style: rawData.style })
                }
                const filled = extrapolateFill(seeds, count, 'down')
                for (let i = 0; i < filled.length; i++) {
                    const targetR = srcMaxR + 1 + i
                    const prev = getCellRaw(targetR, c)
                    before.push({ r: targetR, c, raw: prev.raw, style: prev.style })
                    updates.push({ r: targetR, c, raw: filled[i].raw, style: filled[i].style })
                }
            }
        } else if (tgtMinR < srcMinR) {
            // Drag up
            const count = srcMinR - tgtMinR
            for (let c = srcMinC; c <= srcMaxC; c++) {
                const seeds = []
                for (let r = srcMaxR; r >= srcMinR; r--) {
                    const rawData = getCellRaw(r, c)
                    seeds.push({ raw: rawData.raw, style: rawData.style })
                }
                const filled = extrapolateFill(seeds, count, 'up')
                for (let i = 0; i < filled.length; i++) {
                    const targetR = srcMinR - 1 - i
                    const prev = getCellRaw(targetR, c)
                    before.push({ r: targetR, c, raw: prev.raw, style: prev.style })
                    updates.push({ r: targetR, c, raw: filled[i].raw, style: filled[i].style })
                }
            }
        } else if (tgtMaxC > srcMaxC) {
            // Drag right
            const count = tgtMaxC - srcMaxC
            for (let r = srcMinR; r <= srcMaxR; r++) {
                const seeds = []
                for (let c = srcMinC; c <= srcMaxC; c++) {
                    const rawData = getCellRaw(r, c)
                    seeds.push({ raw: rawData.raw, style: rawData.style })
                }
                const filled = extrapolateFill(seeds, count, 'right')
                for (let i = 0; i < filled.length; i++) {
                    const targetC = srcMaxC + 1 + i
                    const prev = getCellRaw(r, targetC)
                    before.push({ r, c: targetC, raw: prev.raw, style: prev.style })
                    updates.push({ r, c: targetC, raw: filled[i].raw, style: filled[i].style })
                }
            }
        } else if (tgtMinC < srcMinC) {
            // Drag left
            const count = srcMinC - tgtMinC
            for (let r = srcMinR; r <= srcMaxR; r++) {
                const seeds = []
                for (let c = srcMaxC; c >= srcMinC; c--) {
                    const rawData = getCellRaw(r, c)
                    seeds.push({ raw: rawData.raw, style: rawData.style })
                }
                const filled = extrapolateFill(seeds, count, 'left')
                for (let i = 0; i < filled.length; i++) {
                    const targetC = srcMinC - 1 - i
                    const prev = getCellRaw(r, targetC)
                    before.push({ r, c: targetC, raw: prev.raw, style: prev.style })
                    updates.push({ r, c: targetC, raw: filled[i].raw, style: filled[i].style })
                }
            }
        }

        if (updates.length > 0) {
            for (const u of updates) {
                setCellRawInternal(u.r, u.c, u.raw, u.style)
            }
            pushToUndoStack({ type: 'bulk', before, after: updates, description: 'fill' })
            _generation++
            recalculate()
        }
    }

    // ── Sorting ──

    // Sort block: selection if given, otherwise used range with row 1 as header and trailing totals row pinned
    function sortRange(range = null, sortColIndex = 0, sortDir = 'asc', visibleRowIndices = null) {
        let minR, maxR, minC, maxC
        const used = getUsedRange()
        if (used.rowCount === 0) return

        if (range) {
            minR = Math.min(range.r1, range.r2)
            maxR = Math.max(range.r1, range.r2)
            minC = Math.min(range.c1, range.c2)
            maxC = Math.max(range.c1, range.c2)
        } else {
            // Default: data block from row 1 (0-indexed 1) to last used row
            minR = 1 // row 1 is header (0-indexed 0)
            maxR = used.maxRow
            minC = used.minCol
            maxC = used.maxCol

            // If last row is totals row, pin it at the bottom!
            if (isTotalsRow(maxR, minC, maxC)) {
                maxR--
            }
        }

        if (minR >= maxR) return // nothing to sort

        // Identify which rows participate in the sort
        let rowsToSort = []
        for (let r = minR; r <= maxR; r++) {
            if (!visibleRowIndices || visibleRowIndices.has(r)) {
                rowsToSort.push(r)
            }
        }

        if (rowsToSort.length <= 1) return

        // Capture previous state for undo
        const beforeSnapshot = takeFullSnapshot()
        const previousRowIdentities = [...rowIdentities]

        // Build sort items
        const items = rowsToSort.map((rowIdx, originalOrderIdx) => {
            const rawVal = getCellRaw(rowIdx, sortColIndex).raw
            const compVal = getCellForDisplay(rowIdx, sortColIndex).computed
            const effectiveVal = compVal !== null && compVal !== '' ? compVal : rawVal
            let isAllBlank = true
            for (let c = minC; c <= maxC; c++) {
                const cell = getCellRaw(rowIdx, c)
                if (cell.raw && !cell.raw.startsWith('=') && cell.raw.trim() !== '') {
                    isAllBlank = false
                    break
                }
            }
            return {
                rowIdx,
                originalOrderIdx,
                rowIdentity: rowIdentities[rowIdx],
                val: effectiveVal,
                isAllBlank
            }
        })

        // Sort comparator:
        // Ascending -> Descending -> Original order
        // Comparison: numbers before text, blanks last, dates as dates, text case-insensitive, stable.
        if (sortDir === 'original') {
            items.sort((a, b) => a.rowIdentity - b.rowIdentity)
        } else {
            items.sort((a, b) => {
                const vA = a.val
                const vB = b.val
                const blankA = vA === null || vA === undefined || String(vA).trim() === ''
                const blankB = vB === null || vB === undefined || String(vB).trim() === ''

                // Blanks last regardless of dir
                if (blankA && blankB) {
                    if (a.isAllBlank !== b.isAllBlank) {
                        return a.isAllBlank ? 1 : -1
                    }
                    return a.originalOrderIdx - b.originalOrderIdx
                }
                if (blankA) return 1
                if (blankB) return -1

                // Dates as dates
                const dateA = toDate(vA)
                const dateB = toDate(vB)
                if (dateA && dateB) {
                    const cmp = dateA.localeCompare(dateB)
                    if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp
                    return a.originalOrderIdx - b.originalOrderIdx
                }

                // Numbers before text
                const numA = toNum(vA)
                const numB = toNum(vB)
                if (numA !== null && numB !== null) {
                    if (numA !== numB) return sortDir === 'asc' ? numA - numB : numB - numA
                    return a.originalOrderIdx - b.originalOrderIdx
                }
                if (numA !== null && numB === null) return -1
                if (numA === null && numB !== null) return 1

                // Text case-insensitive
                const strA = norm(vA)
                const strB = norm(vB)
                const cmp = strA.localeCompare(strB)
                if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp

                // Stable sort
                return a.originalOrderIdx - b.originalOrderIdx
            })
        }

        // Mapping from old row to new row
        const rowMapping = new Map()
        for (let i = 0; i < items.length; i++) {
            const oldRow = items[i].rowIdx
            const newRow = rowsToSort[i]
            rowMapping.set(oldRow, newRow)
        }

        // Reorder rows
        // Read all row data from old positions
        const rowDataMap = new Map()
        for (const oldRow of rowsToSort) {
            const rowCells = []
            for (let c = 0; c < cols; c++) {
                rowCells.push(getCellRaw(oldRow, c))
            }
            rowDataMap.set(oldRow, rowCells)
        }

        // Update row identities
        const newIdentities = [...rowIdentities]
        for (let i = 0; i < items.length; i++) {
            newIdentities[rowsToSort[i]] = items[i].rowIdentity
        }
        rowIdentities = newIdentities

        // Place rows into new positions with formulas shifted
        for (let i = 0; i < items.length; i++) {
            const oldRow = items[i].rowIdx
            const targetRow = rowsToSort[i]
            const oldRowCells = rowDataMap.get(oldRow)

            for (let c = 0; c < cols; c++) {
                const cellData = oldRowCells[c]
                let newRaw = cellData.raw
                if (newRaw && newRaw.startsWith('=')) {
                    newRaw = shiftFormulaReferences(newRaw, {
                        rowMapping,
                        sortBlock: { r1: minR, r2: maxR }
                    })
                }
                setCellRawInternal(targetRow, c, newRaw, cellData.style)
            }
        }

        // Also shift formulas outside the sorted rows that might reference moved rows
        if (formulaCount > 0) {
            const rowsToSortSet = new Set(rowsToSort)
            for (let r = 0; r < rows; r++) {
                if (!rowsToSortSet.has(r)) {
                    for (let c = 0; c < cols; c++) {
                        const cellData = getCellRaw(r, c)
                        if (cellData.raw && cellData.raw.startsWith('=')) {
                            const shifted = shiftFormulaReferences(cellData.raw, {
                                rowMapping,
                                sortBlock: { r1: minR, r2: maxR }
                            })
                            if (shifted !== cellData.raw) {
                                setCellRawInternal(r, c, shifted, cellData.style)
                            }
                        }
                    }
                }
            }
        }

        const afterSnapshot = takeFullSnapshot()
        pushToUndoStack({
            type: 'sort',
            before: beforeSnapshot,
            after: afterSnapshot,
            previousRowIdentities,
            currentRowIdentities: [...rowIdentities],
            description: 'sort'
        })

        _generation++
        recalculate()
    }

    // ── Row / Column Structural Operations ──

    function takeFullSnapshot() {
        const snap = new Map()
        for (const [k, v] of cells.entries()) {
            snap.set(k, { raw: v.raw, style: v.style ? { ...v.style } : undefined })
        }
        return snap
    }

    function restoreFullSnapshot(snap) {
        cells.clear()
        for (const [k, v] of snap.entries()) {
            cells.set(k, { raw: v.raw, computed: null, error: null, style: v.style ? { ...v.style } : undefined })
        }
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++
        for (const [k, v] of cells.entries()) {
            if (v.raw && v.raw.startsWith('=')) updateDependencies(k, v.raw)
        }
        markAllCellsDirty()
    }

    function executeInsertRow(atIndex) {
        const snapshot = takeFullSnapshot()
        const prevRows = rows
        const prevIdentities = [...rowIdentities]

        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            const shiftedRaw = shiftFormulaReferences(value.raw, { insertRowAt: atIndex })
            if (coords.row >= atIndex) {
                cells.set(cellKey(coords.row + 1, coords.col), { ...value, raw: shiftedRaw })
            } else {
                cells.set(key, { ...value, raw: shiftedRaw })
            }
        }

        rowIdentities.splice(atIndex, 0, nextRowIdentity++)
        rows++

        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()

        pushToUndoStack({
            type: 'structure',
            snap: snapshot,
            oldRows: prevRows,
            oldCols: cols,
            oldIdentities: prevIdentities,
            description: 'insertRow'
        })
        recalculate()
    }

    function executeDeleteRow(atIndex) {
        const snapshot = takeFullSnapshot()
        const prevRows = rows
        const prevIdentities = [...rowIdentities]

        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row === atIndex) continue
            const shiftedRaw = shiftFormulaReferences(value.raw, { deleteRowAt: atIndex })
            if (coords.row > atIndex) {
                cells.set(cellKey(coords.row - 1, coords.col), { ...value, raw: shiftedRaw })
            } else {
                cells.set(key, { ...value, raw: shiftedRaw })
            }
        }

        rowIdentities.splice(atIndex, 1)
        rows--

        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()

        pushToUndoStack({
            type: 'structure',
            snap: snapshot,
            oldRows: prevRows,
            oldCols: cols,
            oldIdentities: prevIdentities,
            description: 'deleteRow'
        })
        recalculate()
    }

    function executeInsertColumn(atIndex) {
        const snapshot = takeFullSnapshot()
        const prevCols = cols

        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            const shiftedRaw = shiftFormulaReferences(value.raw, { insertColAt: atIndex })
            if (coords.col >= atIndex) {
                cells.set(cellKey(coords.row, coords.col + 1), { ...value, raw: shiftedRaw })
            } else {
                cells.set(key, { ...value, raw: shiftedRaw })
            }
        }

        cols++

        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()

        pushToUndoStack({
            type: 'structure',
            snap: snapshot,
            oldRows: rows,
            oldCols: prevCols,
            oldIdentities: [...rowIdentities],
            description: 'insertCol'
        })
        recalculate()
    }

    function executeDeleteColumn(atIndex) {
        const snapshot = takeFullSnapshot()
        const prevCols = cols

        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col === atIndex) continue
            const shiftedRaw = shiftFormulaReferences(value.raw, { deleteColAt: atIndex })
            if (coords.col > atIndex) {
                cells.set(cellKey(coords.row, coords.col - 1), { ...value, raw: shiftedRaw })
            } else {
                cells.set(key, { ...value, raw: shiftedRaw })
            }
        }

        cols--

        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()

        pushToUndoStack({
            type: 'structure',
            snap: snapshot,
            oldRows: rows,
            oldCols: prevCols,
            oldIdentities: [...rowIdentities],
            description: 'deleteCol'
        })
        recalculate()
    }

    // ── Undo / Redo ──

    function undo() {
        if (undoStack.length === 0) return false
        const entry = undoStack.pop()

        if (entry.type === 'set') {
            const cur = getCellRaw(entry.r, entry.c)
            redoStack.push({ ...entry, currentVal: cur.raw, currentStyle: cur.style })
            setCellRawInternal(entry.r, entry.c, entry.oldVal, entry.oldStyle)
            _generation++
            recalculate()
        } else if (entry.type === 'bulk') {
            redoStack.push({ ...entry })
            for (const item of entry.before) {
                setCellRawInternal(item.r, item.c, item.raw, item.style)
            }
            _generation++
            recalculate()
        } else if (entry.type === 'sort') {
            redoStack.push({ ...entry })
            restoreFullSnapshot(entry.before)
            rowIdentities = [...entry.previousRowIdentities]
            recalculate()
        } else if (entry.type === 'structure') {
            redoStack.push({
                ...entry,
                restoreSnap: takeFullSnapshot(),
                restoreRows: rows,
                restoreCols: cols,
                restoreIdentities: [...rowIdentities]
            })
            restoreFullSnapshot(entry.snap)
            rows = entry.oldRows
            cols = entry.oldCols
            rowIdentities = [...entry.oldIdentities]
            recalculate()
        }
        return true
    }

    function redo() {
        if (redoStack.length === 0) return false
        const entry = redoStack.pop()

        if (entry.type === 'set') {
            undoStack.push({ ...entry })
            setCellRawInternal(entry.r, entry.c, entry.newVal, entry.newStyle)
            _generation++
            recalculate()
        } else if (entry.type === 'bulk') {
            undoStack.push({ ...entry })
            for (const item of entry.after) {
                setCellRawInternal(item.r, item.c, item.raw, item.style)
            }
            _generation++
            recalculate()
        } else if (entry.type === 'sort') {
            undoStack.push({ ...entry })
            restoreFullSnapshot(entry.after)
            rowIdentities = [...entry.currentRowIdentities]
            recalculate()
        } else if (entry.type === 'structure') {
            undoStack.push({
                ...entry,
                snap: takeFullSnapshot(),
                oldRows: rows,
                oldCols: cols,
                oldIdentities: [...rowIdentities]
            })
            restoreFullSnapshot(entry.restoreSnap)
            rows = entry.restoreRows
            cols = entry.restoreCols
            rowIdentities = [...entry.restoreIdentities]
            recalculate()
        }
        return true
    }

    function ensureCapacity(minRows, minCols) {
        if (minRows > rows) {
            const added = minRows - rows
            for (let i = 0; i < added; i++) rowIdentities.push(nextRowIdentity++)
            rows = minRows
        }
        if (minCols > cols) cols = minCols
    }

    // ── Fast Data Loader ──
    function loadData(tsvText) {
        const lines = tsvText.replace(/\r\n?/g, '\n').split('\n')
        if (lines.length && lines[lines.length - 1] === '') lines.pop()
        const rowCount = lines.length
        let maxCols = 0
        const parsedRows = lines.map(line => {
            const cellsInLine = line.split('\t')
            if (cellsInLine.length > maxCols) maxCols = cellsInLine.length
            return cellsInLine
        })

        ensureCapacity(rowCount + 20, maxCols + 5)
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        undoStack.length = 0
        redoStack.length = 0
        cachedUsedRange = null
        _generation++

        rowIdentities = Array.from({ length: rows }, (_, i) => i)
        nextRowIdentity = rows

        for (let r = 0; r < rowCount; r++) {
            const rowData = parsedRows[r]
            for (let c = 0; c < rowData.length; c++) {
                const val = rowData[c]
                if (val !== '') {
                    const key = cellKey(r, c)
                    cells.set(key, { raw: val, computed: null, error: null, style: undefined })
                    if (val.startsWith('=')) {
                        updateDependencies(key, val)
                    }
                }
            }
        }
        markAllCellsDirty()
        recalculate()
        return { rows: rowCount, cols: maxCols }
    }

    return {
        get rows() { return rows },
        get cols() { return cols },
        getCell: getCellForDisplay,
        getFormatDisplay,
        getCellRaw,
        setCell: executeSetCell,
        getCellStyle,
        setCellStyle,
        setRangeStyle,
        clearRange,
        batchSetCells,
        fill,
        sortRange,
        isTotalsRow,
        getUsedRange,
        insertRow: executeInsertRow,
        deleteRow: executeDeleteRow,
        insertColumn: executeInsertColumn,
        deleteColumn: executeDeleteColumn,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        ensureCapacity,
        loadData
    }
}
