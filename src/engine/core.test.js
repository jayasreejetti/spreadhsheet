import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'

describe('engine basics', () => {
    it('evaluates arithmetic and ranges', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('reports a cycle instead of hanging', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=B1')
        engine.setCell(0, 1, '=A1')
        expect(engine.getCell(0, 1).error).toBe('#CYCLE!')
    })

    it('undoes and redoes a single edit', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'hello')
        engine.setCell(0, 0, 'world')
        engine.undo()
        expect(engine.getCell(0, 0).raw).toBe('hello')
        engine.redo()
        expect(engine.getCell(0, 0).raw).toBe('world')
    })

    it('shifts references when a row is inserted above them', () => {
        const engine = createEngine(10, 10)
        engine.setCell(2, 0, '5')       // A3
        engine.setCell(4, 0, '=A3+1')   // A5
        engine.insertRow(1)             // A3 -> A4, A5 -> A6
        expect(engine.getCell(5, 0).raw).toBe('=A4+1')
        expect(engine.getCell(5, 0).computed).toBe(6)
    })
})

describe('Challenge 1: Range selection and fill handle', () => {
    it('fills text ending in a number (ORD-1001, ORD-1002 -> ORD-1003..ORD-1005) with one undo', () => {
        const engine = createEngine(10, 10)
        engine.setCell(1, 0, 'ORD-1001') // A2
        engine.setCell(2, 0, 'ORD-1002') // A3

        // Select A2:A3, drag to A6
        engine.fill({ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 5, c2: 0 })

        expect(engine.getCell(3, 0).raw).toBe('ORD-1003') // A4
        expect(engine.getCell(4, 0).raw).toBe('ORD-1004') // A5
        expect(engine.getCell(5, 0).raw).toBe('ORD-1005') // A6

        // One undo restores them
        expect(engine.undo()).toBe(true)
        expect(engine.getCell(3, 0).raw).toBe('')
        expect(engine.getCell(4, 0).raw).toBe('')
        expect(engine.getCell(5, 0).raw).toBe('')
    })

    it('shifts relative formulas and preserves absolute references ($G$2*H2)', () => {
        const engine = createEngine(50, 15)
        // Put values in G2 and H2
        engine.setCell(1, 6, '10') // G2
        engine.setCell(1, 7, '2')  // H2
        engine.setCell(1, 10, '=G2*H2')    // K2
        engine.setCell(1, 11, '=$G$2*H2')  // L2

        // Fill down to row 32 (0-indexed 31)
        engine.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 31, c2: 10 })
        engine.fill({ r1: 1, c1: 11, r2: 1, c2: 11 }, { r1: 1, c1: 11, r2: 31, c2: 11 })

        expect(engine.getCell(31, 10).raw).toBe('=G32*H32')
        expect(engine.getCell(31, 11).raw).toBe('=$G$2*H32')

        // Insert a row above row 10 (atIndex 9)
        engine.insertRow(9)
        // L32 was at row index 31, now at 32 (L33)
        expect(engine.getCell(32, 11).raw).toBe('=$G$2*H33')
    })

    it('fills dates stepping by delta while preserving each seed format', () => {
        const engine = createEngine(15, 10)
        engine.setCell(1, 1, '2024-01-03') // B2 (ISO)
        engine.setCell(2, 1, '2024-01-05') // B3 (ISO)
        engine.setCell(3, 1, '1/8/2024')   // B4 (Slash)

        // Select B2:B4, fill to B8 (rows 1..3 to 1..7)
        engine.fill({ r1: 1, c1: 1, r2: 3, c2: 1 }, { r1: 1, c1: 1, r2: 7, c2: 1 })

        // Check date formats: B5 has seed 0 format (ISO), B6 has seed 1 (ISO), B7 has seed 2 (Slash), B8 has seed 0 (ISO)
        expect(engine.getCell(4, 1).raw).toMatch(/^\d{4}-\d{2}-\d{2}$/) // B5
        expect(engine.getCell(5, 1).raw).toMatch(/^\d{4}-\d{2}-\d{2}$/) // B6
        expect(engine.getCell(6, 1).raw).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/) // B7
        expect(engine.getCell(7, 1).raw).toMatch(/^\d{4}-\d{2}-\d{2}$/) // B8
    })

    it('cycles weekdays and months preserving case', () => {
        const engine = createEngine(15, 10)
        engine.setCell(0, 0, 'Mon')
        engine.fill({ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 })
        expect(engine.getCell(1, 0).raw).toBe('Tue')
        expect(engine.getCell(2, 0).raw).toBe('Wed')
        expect(engine.getCell(3, 0).raw).toBe('Thu')

        engine.setCell(0, 1, 'JAN')
        engine.fill({ r1: 0, c1: 1, r2: 0, c2: 1 }, { r1: 0, c1: 1, r2: 2, c2: 1 })
        expect(engine.getCell(1, 1).raw).toBe('FEB')
        expect(engine.getCell(2, 1).raw).toBe('MAR')
    })

    it('completes filling 5,000 cells in under 200 ms', () => {
        const engine = createEngine(6000, 10)
        engine.setCell(0, 0, 'ORD-1000')
        engine.setCell(1, 0, 'ORD-1001')

        const start = performance.now()
        engine.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5001, c2: 0 })
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(200)
        expect(engine.getCell(5001, 0).raw).toBe('ORD-6001')
    })
})

describe('Challenge 2: Sort and filter', () => {
    it('sorts data descending with pinned totals row and blank rows last', () => {
        const engine = createEngine(35, 12)
        // Set header
        engine.setCell(0, 0, 'Order ID')
        engine.setCell(0, 6, 'Units')
        engine.setCell(0, 9, 'Total')
        engine.setCell(0, 10, 'Unit Price')

        // Row 2: ORD-1001, Units 4, Total $4,320.00
        engine.setCell(1, 0, 'ORD-1001')
        engine.setCell(1, 6, '4')
        engine.setCell(1, 9, '$4,320.00')
        engine.setCell(1, 10, '=J2/G2')

        // Row 3: ORD-1025, Units 9, Total $9,720.00
        engine.setCell(2, 0, 'ORD-1025')
        engine.setCell(2, 6, '9')
        engine.setCell(2, 9, '$9,720.00')
        engine.setCell(2, 10, '=J3/G3')

        // Row 4: blank row
        engine.setCell(3, 0, '')

        // Row 5: Total row
        engine.setCell(4, 0, 'Total')
        engine.setCell(4, 9, '$14,040.00')

        // Sort by Total descending (col 9)
        engine.sortRange(null, 9, 'desc')

        // ORD-1025 ($9720) should be at row 2 (index 1)
        expect(engine.getCell(1, 0).raw).toBe('ORD-1025')
        // Unit price = 9720 / 9 = 1080
        expect(engine.getCell(1, 10).computed).toBe(1080)

        // ORD-1001 at row 3 (index 2)
        expect(engine.getCell(2, 0).raw).toBe('ORD-1001')

        // Blank row at index 3
        expect(engine.getCell(3, 0).raw).toBe('')

        // Totals row stayed pinned at index 4
        expect(engine.getCell(4, 0).raw).toBe('Total')

        // Sort back to original order
        engine.sortRange(null, 9, 'original')
        expect(engine.getCell(1, 0).raw).toBe('ORD-1001')
        expect(engine.getCell(2, 0).raw).toBe('ORD-1025')
    })

    it('keeps a full-block range formula like =SUM(J2:J4) unchanged during sort', () => {
        const engine = createEngine(10, 12)
        engine.setCell(0, 9, 'Total')
        engine.setCell(1, 9, '50')
        engine.setCell(2, 9, '100')
        engine.setCell(3, 9, '20')
        engine.setCell(4, 0, 'Total')
        engine.setCell(4, 9, '=SUM(J2:J4)')

        expect(engine.getCell(4, 9).computed).toBe(170)

        // Sort rows by Total ascending
        engine.sortRange(null, 9, 'asc')

        // Row 4 formula still reads =SUM(J2:J4)
        expect(engine.getCell(4, 9).raw).toBe('=SUM(J2:J4)')
        expect(engine.getCell(4, 9).computed).toBe(170)
    })

    it('sorts 10,000 rows in under 300 ms', () => {
        const engine = createEngine(10050, 5)
        engine.setCell(0, 0, 'Val')
        const updates = []
        for (let i = 1; i <= 10000; i++) {
            updates.push({ r: i, c: 0, raw: String((10000 - i) * 3 % 10000) })
        }
        engine.batchSetCells(updates, 'init', false)

        const start = performance.now()
        engine.sortRange({ r1: 1, c1: 0, r2: 10000, c2: 0 }, 0, 'asc')
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(300)
        expect(Number(engine.getCell(1, 0).raw)).toBeLessThanOrEqual(Number(engine.getCell(2, 0).raw))
    })
})
