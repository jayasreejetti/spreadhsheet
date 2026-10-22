// ─────────────────────────────────────────────────────────────
//  Pure Query Executor (No React, pure sheet data computation)
//  Implements AI_CONTRACT.md §3 (Streaming single-pass performance)
// ─────────────────────────────────────────────────────────────

import { norm, toNum, toDate } from '../engine/core.js'
import { MAX_RESULT_ROWS, FILTER_OPS, AGGREGATE_FNS } from './contract.js'

export function executeQueryPlan(plan, engine) {
    if (!plan || plan.type !== 'query') {
        return { error: 'READ_ONLY', detail: 'Executor only runs query plans' }
    }

    const used = engine.getUsedRange()
    if (used.rowCount === 0) {
        return { columns: [], rows: [], rowCount: 0, truncated: false }
    }

    // 1. Build column header map: norm(header) -> { colIndex, originalName }
    const headerMap = new Map()
    const headerIndices = []
    const headerNames = []

    for (let c = used.minCol; c <= used.maxCol; c++) {
        const cell = engine.getCell(0, c)
        const name = String(cell.raw || '').trim()
        if (name) {
            headerMap.set(norm(name), { col: c, name })
            headerIndices.push(c)
            headerNames.push(name)
        }
    }

    function resolveCol(colName) {
        if (!colName || typeof colName !== 'string') return null
        return headerMap.get(norm(colName)) || null
    }

    // Verify all referenced columns exist in headers
    if (plan.filters) {
        for (const f of plan.filters) {
            if (!resolveCol(f.column)) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${f.column}` }
            }
            if (!FILTER_OPS.includes(f.op)) {
                return { error: 'UNKNOWN_OP', detail: `UNKNOWN_OP:${f.op}` }
            }
        }
    }

    if (plan.groupBy) {
        for (const g of plan.groupBy) {
            if (!resolveCol(g)) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${g}` }
            }
        }
    }

    if (plan.aggregates) {
        for (const a of plan.aggregates) {
            if (!resolveCol(a.column)) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${a.column}` }
            }
            if (!AGGREGATE_FNS.includes(a.fn)) {
                return { error: 'UNKNOWN_FN', detail: `UNKNOWN_FN:${a.fn}` }
            }
        }
    }

    if (plan.columns && (!plan.aggregates || plan.aggregates.length === 0)) {
        for (const c of plan.columns) {
            if (!resolveCol(c)) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${c}` }
            }
        }
    }

    // Pre-resolve filter columns
    const filterRules = (plan.filters || []).map(f => {
        const colInfo = resolveCol(f.column)
        const dateV = toDate(f.value)
        const numV = toNum(f.value)
        return {
            col: colInfo.col,
            op: f.op,
            val: f.value,
            dateV,
            numV,
            normV: norm(f.value)
        }
    })

    // Pre-resolve group columns
    const groupCols = (plan.groupBy || []).map(g => resolveCol(g))

    // Pre-resolve aggregate columns
    const aggRules = (plan.aggregates || []).map(a => ({
        fn: a.fn,
        col: resolveCol(a.column).col,
        as: a.as || `${a.fn}(${resolveCol(a.column).name})`
    }))

    const excludeTotals = plan.excludeTotalsRow !== false
    const hasAggs = aggRules.length > 0
    const startRow = 1
    const endRow = used.maxRow

    // Helper to get raw and computed values fast
    function getCellFast(r, c) {
        const rawCell = engine.getCellRaw(r, c)
        let comp = rawCell.raw
        if (comp && comp.startsWith('=')) {
            const disp = engine.getCell(r, c)
            comp = disp.computed !== null && disp.computed !== '' ? disp.computed : disp.raw
        }
        return { raw: rawCell.raw, computed: comp }
    }

    // Grouping state
    // key -> { labels: string[], aggs: array of aggregate collectors }
    const groupMap = new Map()
    const nonAggRows = []

    function createAggCollectors() {
        return aggRules.map(a => {
            if (a.fn === 'count') return { count: 0 }
            if (a.fn === 'countDistinct') return { set: new Set() }
            if (a.fn === 'sum') return { sum: 0, count: 0 }
            if (a.fn === 'avg') return { sum: 0, count: 0 }
            if (a.fn === 'min') return { min: Infinity, count: 0 }
            if (a.fn === 'max') return { max: -Infinity, count: 0 }
            return {}
        })
    }

    function updateCollector(collector, fn, val) {
        if (fn === 'count') {
            if (String(val ?? '').trim() !== '') collector.count++
        } else if (fn === 'countDistinct') {
            const nv = norm(val)
            if (nv !== '') collector.set.add(nv)
        } else {
            const num = toNum(val)
            if (num !== null) {
                collector.count++
                if (fn === 'sum' || fn === 'avg') collector.sum += num
                else if (fn === 'min') { if (num < collector.min) collector.min = num }
                else if (fn === 'max') { if (num > collector.max) collector.max = num }
            }
        }
    }

    // Single-pass row iteration
    for (let r = startRow; r <= endRow; r++) {
        // Check if totals row on last row
        if (r === endRow && excludeTotals) {
            let firstNonEmpty = null
            for (let c = used.minCol; c <= used.maxCol; c++) {
                const raw = engine.getCellRaw(r, c).raw
                if (raw && raw.trim() !== '') {
                    firstNonEmpty = raw.trim()
                    break
                }
            }
            if (firstNonEmpty && /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(firstNonEmpty)) {
                continue
            }
        }

        // Check if row is all empty
        let allEmpty = true
        for (let c = used.minCol; c <= used.maxCol; c++) {
            const raw = engine.getCellRaw(r, c).raw
            if (raw && raw.trim() !== '') {
                allEmpty = false
                break
            }
        }
        if (allEmpty) continue

        // Check filters
        let passes = true
        for (let i = 0; i < filterRules.length; i++) {
            const f = filterRules[i]
            const cell = getCellFast(r, f.col)
            const cVal = cell.computed
            const op = f.op

            if (op === 'isEmpty') {
                if (norm(cVal) !== '') { passes = false; break }
            } else if (op === 'notEmpty') {
                if (norm(cVal) === '') { passes = false; break }
            } else if (op === 'eq') {
                const numC = toNum(cVal)
                if (numC !== null && f.numV !== null) {
                    if (numC !== f.numV) { passes = false; break }
                } else {
                    if (norm(cVal) !== f.normV) { passes = false; break }
                }
            } else if (op === 'neq') {
                const numC = toNum(cVal)
                if (numC !== null && f.numV !== null) {
                    if (numC === f.numV) { passes = false; break }
                } else {
                    if (norm(cVal) === f.normV) { passes = false; break }
                }
            } else if (op === 'contains') {
                if (!norm(cVal).includes(f.normV)) { passes = false; break }
            } else if (op === 'startsWith') {
                if (!norm(cVal).startsWith(f.normV)) { passes = false; break }
            } else if (op === 'endsWith') {
                if (!norm(cVal).endsWith(f.normV)) { passes = false; break }
            } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
                if (f.dateV !== null) {
                    const dateC = toDate(cVal)
                    if (dateC === null) { passes = false; break }
                    const cmp = dateC.localeCompare(f.dateV)
                    if (op === 'gt' && cmp <= 0) { passes = false; break }
                    if (op === 'gte' && cmp < 0) { passes = false; break }
                    if (op === 'lt' && cmp >= 0) { passes = false; break }
                    if (op === 'lte' && cmp > 0) { passes = false; break }
                } else {
                    const numC = toNum(cVal)
                    if (numC === null || f.numV === null) { passes = false; break }
                    if (op === 'gt' && numC <= f.numV) { passes = false; break }
                    if (op === 'gte' && numC < f.numV) { passes = false; break }
                    if (op === 'lt' && numC >= f.numV) { passes = false; break }
                    if (op === 'lte' && numC > f.numV) { passes = false; break }
                }
            }
        }
        if (!passes) continue

        // Row passed filters: aggregate or collect
        if (hasAggs) {
            let groupKey = '__ALL__'
            let labels = []
            if (groupCols.length > 0) {
                const parts = new Array(groupCols.length)
                labels = new Array(groupCols.length)
                for (let i = 0; i < groupCols.length; i++) {
                    const cell = getCellFast(r, groupCols[i].col)
                    parts[i] = norm(cell.computed)
                    labels[i] = String(cell.computed ?? '').trim()
                }
                groupKey = parts.join('\x1F')
            }

            let entry = groupMap.get(groupKey)
            if (!entry) {
                entry = { labels, collectors: createAggCollectors() }
                groupMap.set(groupKey, entry)
            }

            for (let i = 0; i < aggRules.length; i++) {
                const a = aggRules[i]
                const cell = getCellFast(r, a.col)
                updateCollector(entry.collectors[i], a.fn, cell.computed)
            }
        } else {
            // No aggregates: project columns
            const projCols = plan.columns ? plan.columns.map(c => resolveCol(c)) : headerIndices.map(idx => ({ col: idx, name: headerNames[idx - used.minCol] }))
            const outRow = projCols.map(p => getCellFast(r, p.col).raw)
            nonAggRows.push(outRow)
        }
    }

    // Format output
    let resultColumns = []
    let resultRows = []

    if (hasAggs) {
        resultColumns = [
            ...groupCols.map(g => g.name),
            ...aggRules.map(a => a.as)
        ]

        // If no groupCols and no rows passed: still return 1 row with 0/null
        if (groupCols.length === 0 && groupMap.size === 0) {
            groupMap.set('__ALL__', { labels: [], collectors: createAggCollectors() })
        }

        for (const entry of groupMap.values()) {
            const outRow = [...entry.labels]
            for (let i = 0; i < aggRules.length; i++) {
                const a = aggRules[i]
                const coll = entry.collectors[i]
                if (a.fn === 'count') {
                    outRow.push(coll.count)
                } else if (a.fn === 'countDistinct') {
                    outRow.push(coll.set.size)
                } else if (a.fn === 'sum') {
                    outRow.push(coll.count > 0 ? Math.round(coll.sum * 100) / 100 : null)
                } else if (a.fn === 'avg') {
                    outRow.push(coll.count > 0 ? Math.round((coll.sum / coll.count) * 100) / 100 : null)
                } else if (a.fn === 'min') {
                    outRow.push(coll.count > 0 ? Math.round(coll.min * 100) / 100 : null)
                } else if (a.fn === 'max') {
                    outRow.push(coll.count > 0 ? Math.round(coll.max * 100) / 100 : null)
                }
            }
            resultRows.push(outRow)
        }
    } else {
        const projCols = plan.columns ? plan.columns.map(c => resolveCol(c).name) : headerNames
        resultColumns = projCols
        resultRows = nonAggRows
    }

    // 5. Sorting
    if (plan.sort && plan.sort.length > 0) {
        for (const s of plan.sort) {
            const colIdx = resultColumns.findIndex(c => norm(c) === norm(s.column))
            if (colIdx === -1) {
                return { error: 'UNKNOWN_SORT_COLUMN', detail: `UNKNOWN_SORT_COLUMN:${s.column}` }
            }
        }

        const sortRules = plan.sort.map(s => ({
            colIdx: resultColumns.findIndex(c => norm(c) === norm(s.column)),
            dir: s.dir || 'asc'
        }))

        resultRows.sort((rowA, rowB) => {
            for (const rule of sortRules) {
                const valA = rowA[rule.colIdx]
                const valB = rowB[rule.colIdx]
                const dirMul = rule.dir === 'desc' ? -1 : 1

                const numA = toNum(valA)
                const numB = toNum(valB)

                if (numA !== null && numB !== null) {
                    if (numA !== numB) return (numA - numB) * dirMul
                    continue
                }

                if (numA !== null && numB === null) return -1
                if (numA === null && numB !== null) return 1

                const strA = norm(valA)
                const strB = norm(valB)
                const cmp = strA.localeCompare(strB)
                if (cmp !== 0) return cmp * dirMul
            }
            return 0
        })
    }

    // 6. Limit & Truncation
    const totalCount = resultRows.length
    const limit = Math.min(MAX_RESULT_ROWS, plan.limit ? plan.limit : MAX_RESULT_ROWS)
    const truncated = totalCount > limit
    const finalRows = resultRows.slice(0, limit)

    return {
        columns: resultColumns,
        rows: finalRows,
        rowCount: finalRows.length,
        truncated
    }
}
