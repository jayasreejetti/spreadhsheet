// ─────────────────────────────────────────────────────────────
//  AI Sheet Context Builder
//  Shapes sheet metadata sent to model per AI_CONTRACT.md §1
// ─────────────────────────────────────────────────────────────

import { toNum, toDate, indexToCellKey } from '../engine/core.js'

function inferColumnType(values) {
    if (!values || values.length === 0) return 'text'
    const nonEmpties = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '')
    if (nonEmpties.length === 0) return 'text'

    // Check ID (e.g. ORD-1001, ID-123, SKU_99)
    const isId = nonEmpties.every(v => /^[A-Za-z]+[-_]\d+$/i.test(String(v).trim()))
    if (isId) return 'id'

    // Check Date
    const isDate = nonEmpties.every(v => toDate(v) !== null)
    if (isDate) return 'date'

    // Check Percent (contains % or all numbers between 0 and 1)
    const hasPercentSymbol = nonEmpties.some(v => String(v).trim().endsWith('%'))
    if (hasPercentSymbol) return 'percent'

    // Check Currency (starts with $)
    const isCurrency = nonEmpties.every(v => {
        const s = String(v).trim()
        return s.startsWith('$') || toNum(s) !== null
    }) && nonEmpties.some(v => String(v).trim().startsWith('$'))
    if (isCurrency) return 'currency'

    // Check pure Number
    const isNumber = nonEmpties.every(v => toNum(v) !== null)
    if (isNumber) return 'number'

    return 'text'
}

export function buildSheetContext(engine, selection = null) {
    const used = engine.getUsedRange()
    if (used.rowCount === 0) {
        return {
            range: 'A1',
            rowCount: 0,
            columns: [],
            sampleRows: [],
            selection: selection ? `${indexToCellKey(selection.r1, selection.c1)}` : 'A1',
            hasTotalsRow: false
        }
    }

    const rangeStr = `${indexToCellKey(0, used.minCol)}:${indexToCellKey(used.maxRow, used.maxCol)}`
    const hasTotals = engine.isTotalsRow(used.maxRow, used.minCol, used.maxCol)
    const dataEndRow = hasTotals ? used.maxRow - 1 : used.maxRow
    const dataRowCount = Math.max(0, dataEndRow)

    const columns = []
    const sampleRows = []

    for (let c = used.minCol; c <= used.maxCol; c++) {
        const headerCell = engine.getCell(0, c)
        const colName = String(headerCell.raw || '').trim() || indexToCellKey(0, c)

        // Collect body values for type inference and examples
        const colVals = []
        for (let r = 1; r <= Math.min(20, dataEndRow); r++) {
            const raw = engine.getCell(r, c).raw
            if (raw && String(raw).trim() !== '') colVals.push(String(raw).trim())
        }

        const colType = inferColumnType(colVals)
        const examples = Array.from(new Set(colVals)).slice(0, 3)

        columns.push({
            name: colName,
            index: c,
            type: colType,
            examples
        })
    }

    // At most 5 sample rows
    for (let r = 1; r <= Math.min(5, dataEndRow); r++) {
        const rowData = []
        for (let c = used.minCol; c <= used.maxCol; c++) {
            rowData.push(engine.getCell(r, c).raw || '')
        }
        sampleRows.push(rowData)
    }

    let selStr = 'A1'
    if (selection) {
        const start = indexToCellKey(selection.r1, selection.c1)
        const end = indexToCellKey(selection.r2, selection.c2)
        selStr = start === end ? start : `${start}:${end}`
    }

    return {
        range: rangeStr,
        rowCount: dataRowCount,
        columns,
        sampleRows,
        selection: selStr,
        hasTotalsRow: hasTotals
    }
}
