import { describe, it, expect } from 'vitest'
import { createEngine } from '../engine/core.js'
import { parseAndValidateResponse } from './validator.js'
import { executeQueryPlan } from './executor.js'
import { applyFormatSheet } from './applier.js'
import { createMockProvider } from './mockProvider.js'
import queriesData from '../../fixtures/ai-eval/queries.json'
import formatData from '../../fixtures/ai-eval/format-prompts.json'
import salesSmall from '../../fixtures/sales.tsv?raw'
import salesLarge from '../../fixtures/sales-large.tsv?raw'

describe('Challenge 4: Ask your data golden evaluation suite', () => {
    const engine = createEngine()
    engine.loadData(salesLarge)
    const mock = createMockProvider()

    for (const c of queriesData.cases) {
        it(`query case ${c.id}: "${c.prompt}"`, async () => {
            const resp = await mock.complete({ user: c.prompt })
            const validation = parseAndValidateResponse(resp.text, ['query', 'clarify'])

            if (!validation.valid) {
                if (c.expect.error) {
                    expect(validation.error).toBe(c.expect.error)
                    return
                }
                expect(validation.valid).toBe(true)
            }

            if (validation.action.type === 'clarify') {
                expect(c.expect.clarify).toBe(true)
                return
            }

            const result = executeQueryPlan(validation.action, engine)

            if (c.expect.error) {
                expect(result.error).toBe(c.expect.error)
                if (c.expect.detail) {
                    expect(result.detail).toBe(c.expect.detail)
                }
            } else {
                expect(result.columns).toEqual(c.expect.columns)
                expect(result.rowCount).toBe(c.expect.rowCount)
                expect(result.truncated).toBe(c.expect.truncated)

                // Compare first rows if available
                const expectedRows = c.expect.rows || c.expect.rowsPreview || []
                for (let i = 0; i < expectedRows.length; i++) {
                    const actualRow = result.rows[i]
                    const expRow = expectedRows[i]
                    expect(actualRow).toBeDefined()
                    for (let j = 0; j < expRow.length; j++) {
                        if (typeof expRow[j] === 'number') {
                            expect(Math.abs(actualRow[j] - expRow[j])).toBeLessThanOrEqual(0.01)
                        } else {
                            expect(actualRow[j]).toBe(expRow[j])
                        }
                    }
                }
            }
        })
    }

    it('runs golden query over sales-large.tsv in under 50 ms budget', () => {
        const q1 = queriesData.cases[0].plan
        const start = performance.now()
        const res = executeQueryPlan(q1, engine)
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(50)
        expect(res.rowCount).toBe(5)
    })

    it('runs two-level group-by over 100,000 generated rows in under 500 ms budget', () => {
        const bigEngine = createEngine(100050, 5)
        bigEngine.setCell(0, 0, 'Category')
        bigEngine.setCell(0, 1, 'Region')
        bigEngine.setCell(0, 2, 'Sales')

        const updates = []
        const categories = ['Tech', 'Furniture', 'Supplies']
        const regions = ['East', 'West', 'Central', 'North', 'South']

        for (let i = 1; i <= 100000; i++) {
            updates.push({
                r: i,
                c: 0,
                raw: categories[i % categories.length]
            })
            updates.push({
                r: i,
                c: 1,
                raw: regions[i % regions.length]
            })
            updates.push({
                r: i,
                c: 2,
                raw: String((i % 500) + 10)
            })
        }
        bigEngine.batchSetCells(updates, 'init_100k', false)

        const plan = {
            type: 'query',
            groupBy: ['Category', 'Region'],
            aggregates: [
                { fn: 'sum', column: 'Sales', as: 'TotalSales' },
                { fn: 'count', column: 'Sales', as: 'Count' }
            ],
            sort: [{ column: 'TotalSales', dir: 'desc' }]
        }

        const start = performance.now()
        const res = executeQueryPlan(plan, bigEngine)
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(500)
        expect(res.rowCount).toBe(15)
    })
})

describe('Challenge 5: Format with AI golden evaluation suite', () => {
    const mock = createMockProvider()

    for (const c of formatData.cases) {
        it(`format case ${c.id}: "${c.prompt}"`, async () => {
            const engine = createEngine()
            engine.loadData(salesSmall)

            if (c.id === 'f10') {
                // Precondition in fixture: "Delete row 33 first, so the last row is ORD-1029 (an ordinary data row)."
                // Row 33 is 0-indexed row 32
                engine.deleteRow(32)
            }

            const resp = await mock.complete({ user: c.prompt })
            const validation = parseAndValidateResponse(resp.text, ['format_sheet', 'clarify'])
            expect(validation.valid).toBe(true)

            const appResult = applyFormatSheet(validation.action, engine, 0)

            for (const check of c.expect) {
                if (check.result) {
                    expect(appResult.result).toBe(check.result)
                }
                if (check.cell) {
                    const coords = {
                        r: parseInt(check.cell.slice(1)) - 1,
                        c: check.cell.charCodeAt(0) - 65
                    }
                    if (check.style) {
                        const style = engine.getCellStyle(coords.r, coords.c)
                        for (const [k, v] of Object.entries(check.style)) {
                            expect(style[k]).toBe(v)
                        }
                    }
                    if (check.display) {
                        const disp = engine.getFormatDisplay(coords.r, coords.c)
                        expect(disp).toBe(check.display)
                    }
                }
                if (check.frozenRows !== undefined) {
                    expect(appResult.frozenRows).toBe(check.frozenRows)
                }
            }
        })
    }

    it('applies formatting on sales-large.tsv in under 300 ms budget', () => {
        const engine = createEngine()
        engine.loadData(salesLarge)

        const action = formatData.cases[0].action
        const start = performance.now()
        const res = applyFormatSheet(action, engine, 0)
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(300)
        expect(res.result).toBe('APPLIED')
    })
})
