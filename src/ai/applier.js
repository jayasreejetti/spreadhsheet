// ─────────────────────────────────────────────────────────────
//  Pure Format Applier (No React, pure sheet style mutation)
//  Implements AI_CONTRACT.md §4
// ─────────────────────────────────────────────────────────────

export function applyFormatSheet(action, engine, currentFrozenRows = 0) {
    if (!action || action.type !== 'format_sheet') {
        return { result: 'INVALID_ACTION', error: 'INVALID_ACTION' }
    }

    const used = engine.getUsedRange()
    if (used.rowCount === 0) {
        return { result: 'NO_CHANGES' }
    }

    // 1. Validate freezeRows
    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (action.freezeRows >= used.rowCount) {
            return {
                result: 'OUT_OF_RANGE',
                error: 'OUT_OF_RANGE',
                detail: `freezeRows (${action.freezeRows}) cannot freeze all used rows (${used.rowCount})`
            }
        }
    }

    // Check totals row
    const hasTotals = engine.isTotalsRow(used.maxRow, used.minCol, used.maxCol)

    // Build map of planned updates: key "r,c" -> style object
    // Capture previous styles to check for NO_CHANGES
    const prevStyles = new Map()
    const nextStyles = new Map()

    for (let r = 0; r <= used.maxRow; r++) {
        for (let c = 0; c <= used.maxCol; c++) {
            const curStyle = engine.getCellStyle(r, c)
            const copy = curStyle ? { ...curStyle } : {}
            prevStyles.set(`${r},${c}`, copy)
            nextStyles.set(`${r},${c}`, { ...copy })
        }
    }

    let modified = false

    // 1. clearFormatting first
    if (action.clearFormatting) {
        for (let r = 0; r <= used.maxRow; r++) {
            for (let c = 0; c <= used.maxCol; c++) {
                nextStyles.set(`${r},${c}`, {
                    bold: false, italic: false, underline: false,
                    bg: 'white', color: '#202124', align: 'left', fontSize: 13, numberFormat: 'general'
                })
            }
        }
    }

    // 2. bodyStyle (body rows 1..maxRow, all used cols 0..maxCol)
    if (action.bodyStyle && used.maxRow >= 1) {
        for (let r = 1; r <= used.maxRow; r++) {
            for (let c = 0; c <= used.maxCol; c++) {
                const k = `${r},${c}`
                nextStyles.set(k, { ...nextStyles.get(k), ...action.bodyStyle })
            }
        }
    }

    // 3. columns[] (body rows of that column only; header row is NEVER formatted by column entry)
    if (action.columns && Array.isArray(action.columns)) {
        for (const colEntry of action.columns) {
            const col = colEntry.col
            if (col < 0 || col > used.maxCol) continue
            const colStyle = colEntry.style || {}

            for (let r = 1; r <= used.maxRow; r++) {
                const k = `${r},${col}`
                nextStyles.set(k, { ...nextStyles.get(k), ...colStyle })
            }
        }
    }

    // 4. totalsStyle (only if totals row exists)
    if (hasTotals && action.totalsStyle && used.maxRow >= 1) {
        const totR = used.maxRow
        for (let c = 0; c <= used.maxCol; c++) {
            const k = `${totR},${c}`
            nextStyles.set(k, { ...nextStyles.get(k), ...action.totalsStyle })
        }
    }

    // 5. headerStyle LAST so it wins over column alignment (header never number-formatted)
    if (action.headerStyle) {
        const hStyle = { ...action.headerStyle }
        delete hStyle.numberFormat // header is never number-formatted
        for (let c = 0; c <= used.maxCol; c++) {
            const k = `0,${c}`
            nextStyles.set(k, { ...nextStyles.get(k), ...hStyle })
        }
    }

    // Check if cell styles actually changed
    const updates = []
    for (const [k, nStyle] of nextStyles.entries()) {
        const pStyle = prevStyles.get(k)
        let cellDiff = false
        for (const prop of Object.keys(nStyle)) {
            if (nStyle[prop] !== pStyle[prop]) {
                cellDiff = true
                break
            }
        }
        if (cellDiff) {
            const [r, c] = k.split(',').map(Number)
            updates.push({ r, c, style: nStyle })
            modified = true
        }
    }

    // Check freezeRows changes
    let nextFrozenRows = currentFrozenRows
    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (action.freezeRows !== currentFrozenRows) {
            nextFrozenRows = action.freezeRows
            modified = true
        }
    }

    // Check column widths
    const columnWidthUpdates = []
    if (action.columnWidths && Array.isArray(action.columnWidths)) {
        for (const cw of action.columnWidths) {
            if (cw.col >= 0 && cw.col <= used.maxCol && cw.width >= 30 && cw.width <= 600) {
                columnWidthUpdates.push({ col: cw.col, width: cw.width })
                modified = true
            }
        }
    }

    if (action.autoFitColumns) {
        modified = true
    }

    if (!modified && updates.length === 0) {
        return { result: 'NO_CHANGES', frozenRows: currentFrozenRows }
    }

    // Apply cell styles via engine batchSetCells (reverts in one undo)
    if (updates.length > 0) {
        engine.batchSetCells(updates, 'ai_format', true)
    }

    return {
        result: 'APPLIED',
        frozenRows: nextFrozenRows,
        columnWidthUpdates,
        autoFitColumns: !!action.autoFitColumns
    }
}
