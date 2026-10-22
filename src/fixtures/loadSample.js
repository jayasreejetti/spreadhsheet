// Loads a fixture TSV into the engine starting at A1.
// Fast bulk loader: loads entire TSV without intermediate undo stack clutter.
import salesSmall from '../../fixtures/sales.tsv?raw'
import salesLarge from '../../fixtures/sales-large.tsv?raw'

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

function loadTsv(engine, text) {
    if (typeof engine.loadData === 'function') {
        return engine.loadData(text)
    }
    const rows = parseTsv(text)
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
            engine.setCell(r, c, rows[r][c])
        }
    }
    return { rows: rows.length, cols }
}

/** 33 lines: header, 31 messy data rows, totals row. */
export function loadSampleSmall(engine) {
    return loadTsv(engine, salesSmall)
}

/** ~3,000 lines of the same kind of data. */
export function loadSampleLarge(engine) {
    return loadTsv(engine, salesLarge)
}
