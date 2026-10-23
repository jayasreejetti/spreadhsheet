import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine, indexToCellKey, indexToColumnLetter, columnLetterToIndex, norm, toNum } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'
import { createProvider } from './ai/provider.js'
import { parseAndValidateResponse } from './ai/validator.js'
import { executeQueryPlan } from './ai/executor.js'
import { applyFormatSheet } from './ai/applier.js'
import { buildSheetContext } from './ai/context.js'

const TOTAL_ROWS = 100000
const TOTAL_COLS = 200
const DEFAULT_ROW_HEIGHT = 25
const DEFAULT_COL_WIDTH = 105
const ROW_HEADER_WIDTH = 45
const OVERSCAN_ROWS = 8
const OVERSCAN_COLS = 3

export default function App() {
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [, setVersion] = useState(0)
  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // ── Grid Dimensions & Dynamic Sizes ──
  const [colWidths, setColWidths] = useState({})
  const [rowHeights, setRowHeights] = useState({})
  const [frozenRows, setFrozenRows] = useState(1) // Row 1 is header by default

  // ── Selection & Editing State ──
  // selection: { r1, c1, r2, c2 }
  const [selection, setSelection] = useState({ r1: 0, c1: 0, r2: 0, c2: 0 })
  const [activeCell, setActiveCell] = useState({ r: 0, c: 0 })
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [nameBoxInput, setNameBoxInput] = useState('A1')

  // ── Fill Handle State ──
  // fillRange: { r1, c1, r2, c2 }
  const [, setIsFilling] = useState(false)
  const [fillRange, setFillRange] = useState(null)
  const isFillingRef = useRef(false)
  const fillStartCoord = useRef(null)
  const fillRangeRef = useRef(null)

  // ── Mouse Selection State ──
  const isMouseDown = useRef(false)
  const dragAnchor = useRef(null)
  const normalizedSelectionRef = useRef({ r1: 0, c1: 0, r2: 0, c2: 0 })

  // ── Virtual Scroll State ──
  const [scrollState, setScrollState] = useState({ scrollTop: 0, scrollLeft: 0, viewportWidth: 1000, viewportHeight: 600 })
  const gridViewportRef = useRef(null)
  const formulaBarInputRef = useRef(null)
  const cellInputRef = useRef(null)

  // ── Filters & Sort State ──
  // filters: Map of colIndex -> { search: string, selectedValues: Set<string> | null, condition: { op, value } }
  const [filters, setFilters] = useState({})
  const [openFilterCol, setOpenFilterCol] = useState(null)
  const [sortState, setSortState] = useState({ col: null, dir: null }) // dir: 'asc' | 'desc' | 'original'

  // ── AI Panel State ──
  const [isAiOpen, setIsAiOpen] = useState(false)
  const [aiProviderKind, setAiProviderKind] = useState('mock')
  const [aiProvider, setAiProvider] = useState(() => createProvider('mock'))
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const [aiHistory, setAiHistory] = useState([])
  const [showPlanIndex, setShowPlanIndex] = useState(null)

  // Synchronize AI provider switch
  useEffect(() => {
    setAiProvider(createProvider(aiProviderKind))
  }, [aiProviderKind])

  // Update name box when active cell changes
  useEffect(() => {
    if (activeCell) {
      setNameBoxInput(indexToCellKey(activeCell.r, activeCell.c))
    }
  }, [activeCell])

  // ────── Column & Row Metric Offsets (Prefix Sums) ──────

  const getColWidth = useCallback((col) => colWidths[col] || DEFAULT_COL_WIDTH, [colWidths])
  const getRowHeight = useCallback((row) => rowHeights[row] || DEFAULT_ROW_HEIGHT, [rowHeights])

  // Offset lookups with binary search
  const findRowAtOffset = useCallback((offset) => {
    // If no custom row heights, fast O(1)
    if (Object.keys(rowHeights).length === 0) {
      return Math.min(TOTAL_ROWS - 1, Math.max(0, Math.floor(offset / DEFAULT_ROW_HEIGHT)))
    }
    // Sequential scan with fallback
    let current = 0
    for (let r = 0; r < TOTAL_ROWS; r++) {
      const h = rowHeights[r] || DEFAULT_ROW_HEIGHT
      if (current + h > offset) return r
      current += h
    }
    return TOTAL_ROWS - 1
  }, [rowHeights])

  const findColAtOffset = useCallback((offset) => {
    if (Object.keys(colWidths).length === 0) {
      return Math.min(TOTAL_COLS - 1, Math.max(0, Math.floor(offset / DEFAULT_COL_WIDTH)))
    }
    let current = 0
    for (let c = 0; c < TOTAL_COLS; c++) {
      const w = colWidths[c] || DEFAULT_COL_WIDTH
      if (current + w > offset) return c
      current += w
    }
    return TOTAL_COLS - 1
  }, [colWidths])

  const getRowTop = useCallback((targetRow) => {
    if (Object.keys(rowHeights).length === 0) {
      return targetRow * DEFAULT_ROW_HEIGHT
    }
    let top = 0
    for (let r = 0; r < targetRow; r++) {
      top += rowHeights[r] || DEFAULT_ROW_HEIGHT
    }
    return top
  }, [rowHeights])

  const getColLeft = useCallback((targetCol) => {
    if (Object.keys(colWidths).length === 0) {
      return targetCol * DEFAULT_COL_WIDTH
    }
    let left = 0
    for (let c = 0; c < targetCol; c++) {
      left += colWidths[c] || DEFAULT_COL_WIDTH
    }
    return left
  }, [colWidths])

  // ────── Filter Logic ──────

  const activeFilterCols = useMemo(() => Object.keys(filters).map(Number), [filters])

  // Compute visible rows based on all active column filters (AND combination)
  const visibleRowsSet = useMemo(() => {
    if (activeFilterCols.length === 0) return null // All visible
    const visible = new Set()
    // Row 0 (header) always visible
    visible.add(0)

    for (let r = 1; r < engine.rows; r++) {
      let passes = true
      for (const col of activeFilterCols) {
        const f = filters[col]
        if (!f) continue
        const cellRaw = engine.getCell(r, col).raw
        const cellComp = engine.getCell(r, col).computed
        const cellVal = cellComp !== null && cellComp !== '' ? cellComp : cellRaw
        const cellNorm = norm(cellVal)

        // 1. Checklist filter
        if (f.selectedValues) {
          const isBlank = cellNorm === ''
          if (isBlank && !f.selectedValues.has('(Blanks)')) {
            passes = false
            break
          }
          if (!isBlank && !f.selectedValues.has(cellNorm)) {
            passes = false
            break
          }
        }

        // 2. Condition filter
        if (f.condition && f.condition.op) {
          const op = f.condition.op
          const condVal = f.condition.value
          if (op === 'contains') {
            if (!cellNorm.includes(norm(condVal))) { passes = false; break }
          } else if (op === 'gt') {
            const numC = toNum(cellVal)
            const numV = toNum(condVal)
            if (numC === null || numV === null || numC <= numV) { passes = false; break }
          } else if (op === 'lt') {
            const numC = toNum(cellVal)
            const numV = toNum(condVal)
            if (numC === null || numV === null || numC >= numV) { passes = false; break }
          } else if (op === 'isEmpty') {
            if (cellNorm !== '') { passes = false; break }
          }
        }
      }

      if (passes) visible.add(r)
    }

    return visible
  }, [filters, activeFilterCols, engine])

  const totalDataRows = useMemo(() => {
    const used = engine.getUsedRange()
    return Math.max(0, used.rowCount - 1)
  }, [engine])

  const visibleDataRowsCount = useMemo(() => {
    if (!visibleRowsSet) return totalDataRows
    let count = 0
    for (const r of visibleRowsSet) {
      if (r > 0 && r <= engine.getUsedRange().maxRow) count++
    }
    return count
  }, [visibleRowsSet, totalDataRows, engine])

  // ────── Virtualized Slice Calculation ──────

  const virtualBounds = useMemo(() => {
    const { scrollTop, scrollLeft, viewportWidth, viewportHeight } = scrollState
    const startRow = Math.max(frozenRows, findRowAtOffset(scrollTop) - OVERSCAN_ROWS)
    const endRow = Math.min(TOTAL_ROWS - 1, findRowAtOffset(scrollTop + viewportHeight) + OVERSCAN_ROWS)
    const startCol = Math.max(0, findColAtOffset(scrollLeft) - OVERSCAN_COLS)
    const endCol = Math.min(TOTAL_COLS - 1, findColAtOffset(scrollLeft + viewportWidth) + OVERSCAN_COLS)

    return { startRow, endRow, startCol, endCol }
  }, [scrollState, frozenRows, findRowAtOffset, findColAtOffset])

  // ────── Scroll Handler ──────

  const handleScroll = useCallback((e) => {
    const el = e.target
    setScrollState({
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
      viewportHeight: el.clientHeight
    })
  }, [])

  // ────── Editing & Commit ──────

  const startEditing = useCallback((r, c, initialChar = null) => {
    // Hidden rows cannot be edited
    if (visibleRowsSet && !visibleRowsSet.has(r)) return
    setActiveCell({ r, c })
    setSelection({ r1: r, c1: c, r2: r, c2: c })
    setEditingCell({ r, c })
    const cell = engine.getCellRaw(r, c)
    setEditValue(initialChar !== null ? initialChar : cell.raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine, visibleRowsSet])

  const commitEdit = useCallback(() => {
    if (!editingCell) return
    const { r, c } = editingCell
    const prev = engine.getCellRaw(r, c)
    if (prev.raw !== editValue) {
      engine.setCell(r, c, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [editingCell, editValue, engine, forceRerender])

  const cancelEdit = useCallback(() => {
    setEditingCell(null)
  }, [])

  // ────── Selection Interactions ──────

  const normalizedSelection = useMemo(() => {
    return {
      r1: Math.min(selection.r1, selection.r2),
      c1: Math.min(selection.c1, selection.c2),
      r2: Math.max(selection.r1, selection.r2),
      c2: Math.max(selection.c1, selection.c2)
    }
  }, [selection])

  useEffect(() => {
    normalizedSelectionRef.current = normalizedSelection
  }, [normalizedSelection])

  const handleCellMouseDown = useCallback((r, c, e) => {
    if (editingCell) {
      commitEdit()
    }

    if (e.shiftKey) {
      // Extend selection
      setSelection(prev => ({ ...prev, r2: r, c2: c }))
      return
    }

    isMouseDown.current = true
    dragAnchor.current = { r, c }
    setActiveCell({ r, c })
    setSelection({ r1: r, c1: c, r2: r, c2: c })
  }, [editingCell, commitEdit])

  // ────── Fill Handle Mouse Down ──────

  const handleFillHandleMouseDown = useCallback((e) => {
    e.stopPropagation()
    e.preventDefault()
    isFillingRef.current = true
    setIsFilling(true)
    fillStartCoord.current = { r: normalizedSelection.r2, c: normalizedSelection.c2 }
    fillRangeRef.current = null
    setFillRange(null)
  }, [normalizedSelection])

  // ────── Global Mouse Movement & Up (Drag Selection & Fill Handle) ──────

  useEffect(() => {
    const handleGlobalMouseMove = (e) => {
      if (!isMouseDown.current && !isFillingRef.current) return
      if (!gridViewportRef.current) return

      const rect = gridViewportRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left + gridViewportRef.current.scrollLeft - ROW_HEADER_WIDTH
      const mouseY = e.clientY - rect.top + gridViewportRef.current.scrollTop

      const r = Math.max(0, Math.min(TOTAL_ROWS - 1, findRowAtOffset(mouseY)))
      const c = Math.max(0, Math.min(TOTAL_COLS - 1, findColAtOffset(mouseX)))

      if (isMouseDown.current && dragAnchor.current) {
        setSelection({
          r1: dragAnchor.current.r,
          c1: dragAnchor.current.c,
          r2: r,
          c2: c
        })
      }

      if (isFillingRef.current && fillStartCoord.current) {
        const sel = normalizedSelectionRef.current

        const dRow = r - sel.r2
        const uRow = sel.r1 - r
        const rCol = c - sel.c2
        const lCol = sel.c1 - c

        const maxDir = Math.max(dRow, uRow, rCol, lCol)
        let nextRange = null
        if (maxDir > 0) {
          if (maxDir === dRow) {
            nextRange = { r1: sel.r1, c1: sel.c1, r2: r, c2: sel.c2 }
          } else if (maxDir === uRow) {
            nextRange = { r1: r, c1: sel.c1, r2: sel.r2, c2: sel.c2 }
          } else if (maxDir === rCol) {
            nextRange = { r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: c }
          } else if (maxDir === lCol) {
            nextRange = { r1: sel.r1, c1: c, r2: sel.r2, c2: sel.c2 }
          }
        }
        fillRangeRef.current = nextRange
        setFillRange(nextRange)
      }
    }

    const handleGlobalMouseUp = () => {
      if (isFillingRef.current) {
        const rangeToFill = fillRangeRef.current
        const sourceRange = normalizedSelectionRef.current
        if (rangeToFill) {
          engine.fill(sourceRange, rangeToFill)
          forceRerender()
          setSelection(rangeToFill)
        }
        isFillingRef.current = false
        fillRangeRef.current = null
        fillStartCoord.current = null
        setIsFilling(false)
        setFillRange(null)
      }

      if (isMouseDown.current) {
        isMouseDown.current = false
        dragAnchor.current = null
      }
    }

    window.addEventListener('mousemove', handleGlobalMouseMove)
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove)
      window.removeEventListener('mouseup', handleGlobalMouseUp)
    }
  }, [engine, forceRerender, findRowAtOffset, findColAtOffset])

  // ────── Header Selection ──────

  const selectEntireColumn = useCallback((c) => {
    if (editingCell) commitEdit()
    setActiveCell({ r: 0, c })
    setSelection({ r1: 0, c1: c, r2: TOTAL_ROWS - 1, c2: c })
  }, [editingCell, commitEdit])

  const selectEntireRow = useCallback((r) => {
    if (editingCell) commitEdit()
    setActiveCell({ r, c: 0 })
    setSelection({ r1: r, c1: 0, r2: r, c2: TOTAL_COLS - 1 })
  }, [editingCell, commitEdit])

  const selectAll = useCallback(() => {
    const used = engine.getUsedRange()
    if (used.rowCount === 0) {
      setSelection({ r1: 0, c1: 0, r2: 50, c2: 20 })
    } else {
      setSelection({ r1: 0, c1: 0, r2: used.maxRow, c2: used.maxCol })
    }
  }, [engine])

  // ────── Keyboard Shortcuts ──────

  const scrollToCell = useCallback((r, c) => {
    if (!gridViewportRef.current) return
    const top = getRowTop(r)
    const left = ROW_HEADER_WIDTH + getColLeft(c)
    gridViewportRef.current.scrollTo({ top: Math.max(0, top - 100), left: Math.max(0, left - 100), behavior: 'auto' })
  }, [getRowTop, getColLeft])

  const handleKeyDown = useCallback((e) => {
    // Ctrl+K -> AI Panel
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      setIsAiOpen(v => !v)
      return
    }

    // Ctrl+Z -> Undo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) {
        if (engine.redo()) forceRerender()
      } else {
        if (engine.undo()) forceRerender()
      }
      return
    }

    // Ctrl+Y -> Redo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      if (engine.redo()) forceRerender()
      return
    }

    // Ctrl+A -> Select Used Range
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selectAll()
      return
    }

    // While editing
    if (editingCell) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitEdit()
        const nextR = Math.min(TOTAL_ROWS - 1, activeCell.r + 1)
        setActiveCell({ r: nextR, c: activeCell.c })
        setSelection({ r1: nextR, c1: activeCell.c, r2: nextR, c2: activeCell.c })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        commitEdit()
        const nextC = Math.min(TOTAL_COLS - 1, activeCell.c + 1)
        setActiveCell({ r: activeCell.r, c: nextC })
        setSelection({ r1: activeCell.r, c1: nextC, r2: activeCell.r, c2: nextC })
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelEdit()
      }
      return
    }

    // Navigation keys when not editing
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEditing(activeCell.r, activeCell.c)
      return
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      engine.clearRange(normalizedSelection)
      forceRerender()
      return
    }

    // Arrow navigation
    if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      let dr = 0, dc = 0
      if (e.key === 'ArrowUp') dr = -1
      if (e.key === 'ArrowDown') dr = 1
      if (e.key === 'ArrowLeft') dc = -1
      if (e.key === 'ArrowRight') dc = 1

      if (e.shiftKey) {
        // Extend selection
        setSelection(prev => ({
          ...prev,
          r2: Math.max(0, Math.min(TOTAL_ROWS - 1, prev.r2 + dr)),
          c2: Math.max(0, Math.min(TOTAL_COLS - 1, prev.c2 + dc))
        }))
      } else {
        const nextR = Math.max(0, Math.min(TOTAL_ROWS - 1, activeCell.r + dr))
        const nextC = Math.max(0, Math.min(TOTAL_COLS - 1, activeCell.c + dc))
        setActiveCell({ r: nextR, c: nextC })
        setSelection({ r1: nextR, c1: nextC, r2: nextR, c2: nextC })
        scrollToCell(nextR, nextC)
      }
      return
    }

    // Page Up / Down
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      const dr = e.key === 'PageDown' ? 25 : -25
      const nextR = Math.max(0, Math.min(TOTAL_ROWS - 1, activeCell.r + dr))
      setActiveCell({ r: nextR, c: activeCell.c })
      setSelection({ r1: nextR, c1: activeCell.c, r2: nextR, c2: activeCell.c })
      scrollToCell(nextR, activeCell.c)
      return
    }

    // Ctrl+Home / Ctrl+End
    if ((e.ctrlKey || e.metaKey) && e.key === 'Home') {
      e.preventDefault()
      setActiveCell({ r: 0, c: 0 })
      setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 })
      scrollToCell(0, 0)
      return
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'End') {
      e.preventDefault()
      const used = engine.getUsedRange()
      setActiveCell({ r: used.maxRow, c: used.maxCol })
      setSelection({ r1: used.maxRow, c1: used.maxCol, r2: used.maxRow, c2: used.maxCol })
      scrollToCell(used.maxRow, used.maxCol)
      return
    }

    // Typing directly into cell
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      startEditing(activeCell.r, activeCell.c, e.key)
    }
  }, [editingCell, commitEdit, cancelEdit, activeCell, startEditing, selectAll, normalizedSelection, engine, forceRerender, scrollToCell])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // ────── Name Box Jump ──────

  const handleNameBoxSubmit = useCallback((e) => {
    if (e.key === 'Enter') {
      const match = nameBoxInput.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/)
      if (match) {
        const c = columnLetterToIndex(match[1])
        const r = parseInt(match[2], 10) - 1
        if (r >= 0 && r < TOTAL_ROWS && c >= 0 && c < TOTAL_COLS) {
          setActiveCell({ r, c })
          setSelection({ r1: r, c1: c, r2: r, c2: c })
          scrollToCell(r, c)
        }
      }
    }
  }, [nameBoxInput, scrollToCell])

  // ────── Column Header Click / Sort ──────

  const handleHeaderClick = useCallback((col) => {
    // Sort cycle: asc -> desc -> original
    let nextDir = 'asc'
    if (sortState.col === col) {
      if (sortState.dir === 'asc') nextDir = 'desc'
      else if (sortState.dir === 'desc') nextDir = 'original'
      else nextDir = 'asc'
    }

    setSortState({ col, dir: nextDir })
    // If range selected (more than 1 row), sort range, else null (default block)
    const isMultiRow = normalizedSelection.r2 > normalizedSelection.r1
    const targetRange = isMultiRow ? normalizedSelection : null

    engine.sortRange(targetRange, col, nextDir, visibleRowsSet)
    forceRerender()
  }, [sortState, normalizedSelection, engine, visibleRowsSet, forceRerender])

  // ────── Column Auto-Fit & Resize ──────

  const handleColResizeMouseDown = useCallback((col, e) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startW = getColWidth(col)

    const onMouseMove = (moveEvent) => {
      const newW = Math.max(30, startW + (moveEvent.clientX - startX))
      setColWidths(prev => ({ ...prev, [col]: newW }))
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [getColWidth])

  const handleColAutoFit = useCallback((col, e) => {
    e.stopPropagation()
    // Auto-fit: calculate maximum text length in column
    let maxLen = 4
    const used = engine.getUsedRange()
    for (let r = 0; r <= Math.min(100, used.maxRow); r++) {
      const val = engine.getFormatDisplay(r, col)
      if (val && val.length > maxLen) maxLen = val.length
    }
    const fitWidth = Math.min(400, Math.max(50, maxLen * 9 + 30))
    setColWidths(prev => ({ ...prev, [col]: fitWidth }))
  }, [engine])

  // ────── Row Resize ──────

  const handleRowResizeMouseDown = useCallback((row, e) => {
    e.stopPropagation()
    e.preventDefault()
    const startY = e.clientY
    const startH = getRowHeight(row)

    const onMouseMove = (moveEvent) => {
      const newH = Math.max(18, startH + (moveEvent.clientY - startY))
      setRowHeights(prev => ({ ...prev, [row]: newH }))
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [getRowHeight])

  // ────── Formatting Toggles on Selection ──────

  const activeStyle = useMemo(() => {
    return engine.getCellStyle(activeCell.r, activeCell.c)
  }, [engine, activeCell])

  const toggleBold = useCallback(() => {
    engine.setRangeStyle(normalizedSelection, { bold: !activeStyle.bold })
    forceRerender()
  }, [engine, normalizedSelection, activeStyle, forceRerender])

  const toggleItalic = useCallback(() => {
    engine.setRangeStyle(normalizedSelection, { italic: !activeStyle.italic })
    forceRerender()
  }, [engine, normalizedSelection, activeStyle, forceRerender])

  const toggleUnderline = useCallback(() => {
    engine.setRangeStyle(normalizedSelection, { underline: !activeStyle.underline })
    forceRerender()
  }, [engine, normalizedSelection, activeStyle, forceRerender])

  const setFontSize = useCallback((fontSize) => {
    engine.setRangeStyle(normalizedSelection, { fontSize })
    forceRerender()
  }, [engine, normalizedSelection, forceRerender])

  const setAlignment = useCallback((align) => {
    engine.setRangeStyle(normalizedSelection, { align })
    forceRerender()
  }, [engine, normalizedSelection, forceRerender])

  const setColor = useCallback((color) => {
    engine.setRangeStyle(normalizedSelection, { color })
    forceRerender()
  }, [engine, normalizedSelection, forceRerender])

  const setBgColor = useCallback((bg) => {
    engine.setRangeStyle(normalizedSelection, { bg })
    forceRerender()
  }, [engine, normalizedSelection, forceRerender])

  const setNumberFormat = useCallback((numberFormat) => {
    engine.setRangeStyle(normalizedSelection, { numberFormat })
    forceRerender()
  }, [engine, normalizedSelection, forceRerender])

  // ────── Sample Data Loaders ──────

  const loadSample = useCallback((loader) => {
    loader(engine)
    forceRerender()
    setActiveCell({ r: 0, c: 0 })
    setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 })
    setFilters({})
    setSortState({ col: null, dir: null })
  }, [engine, forceRerender])

  useEffect(() => {
    loadSample(loadSampleSmall)
  }, [loadSample])

  // ────── Row / Column Insertion / Deletion ──────

  const insertRow = useCallback(() => {
    engine.insertRow(activeCell.r)
    forceRerender()
  }, [engine, activeCell, forceRerender])

  const deleteRow = useCallback(() => {
    engine.deleteRow(activeCell.r)
    forceRerender()
  }, [engine, activeCell, forceRerender])

  const insertColumn = useCallback(() => {
    engine.insertColumn(activeCell.c)
    forceRerender()
  }, [engine, activeCell, forceRerender])

  const deleteColumn = useCallback(() => {
    engine.deleteColumn(activeCell.c)
    forceRerender()
  }, [engine, activeCell, forceRerender])

  // ────── AI Panel Interaction ──────

  const handleSendAiPrompt = useCallback(async (promptText = null) => {
    const textToSend = promptText || aiPrompt
    if (!textToSend.trim() || aiLoading) return

    setAiLoading(true)
    setAiError(null)

    const userMessage = { role: 'user', content: textToSend }
    const currentHist = [...aiHistory, userMessage]
    setAiHistory(currentHist)
    setAiPrompt('')

    try {
      const context = buildSheetContext(engine, normalizedSelection)
      const systemPrompt = `You are an AI spreadsheet assistant. Answer ONLY with a valid JSON action conforming to the schemas in AI_CONTRACT.md. Allowed actions: "query", "format_sheet", "clarify". No other text or explanation outside JSON.`
      const userPrompt = `Sheet Context:\n${JSON.stringify(context, null, 2)}\n\nUser Prompt: ${textToSend}`

      const response = await aiProvider.complete({
        system: systemPrompt,
        user: userPrompt
      })

      const validation = parseAndValidateResponse(response.text, ['query', 'format_sheet', 'clarify'])
      if (!validation.valid) {
        setAiError(`${validation.error}: ${validation.detail}`)
        setAiHistory(prev => [...prev, { role: 'assistant', error: `${validation.error}: ${validation.detail}` }])
        setAiLoading(false)
        return
      }

      const action = validation.action
      let card = { role: 'assistant', action, rawText: response.text }

      if (action.type === 'query') {
        const queryResult = executeQueryPlan(action, engine)
        card.queryResult = queryResult
      }

      setAiHistory(prev => [...prev, card])
    } catch (err) {
      setAiError(err.message)
      setAiHistory(prev => [...prev, { role: 'assistant', error: err.message }])
    } finally {
      setAiLoading(false)
    }
  }, [aiPrompt, aiLoading, aiHistory, engine, normalizedSelection, aiProvider])

  const handleApplyAiFormat = useCallback((action) => {
    const appResult = applyFormatSheet(action, engine, frozenRows)
    if (appResult.frozenRows !== undefined) {
      setFrozenRows(appResult.frozenRows)
    }
    if (appResult.columnWidthUpdates) {
      const newWidths = {}
      for (const u of appResult.columnWidthUpdates) newWidths[u.col] = u.width
      setColWidths(prev => ({ ...prev, ...newWidths }))
    }
    if (appResult.autoFitColumns) {
      const used = engine.getUsedRange()
      const newWidths = {}
      for (let c = 0; c <= used.maxCol; c++) {
        let maxLen = 4
        for (let r = 0; r <= Math.min(100, used.maxRow); r++) {
          const val = engine.getFormatDisplay(r, c)
          if (val && val.length > maxLen) maxLen = val.length
        }
        newWidths[c] = Math.min(400, Math.max(50, maxLen * 9 + 30))
      }
      setColWidths(prev => ({ ...prev, ...newWidths }))
    }
    forceRerender()
  }, [engine, frozenRows, forceRerender])

  const handleInsertQueryIntoSheet = useCallback((queryResult) => {
    if (!queryResult || !queryResult.rows || queryResult.rows.length === 0) return
    const startR = activeCell.r
    const startC = activeCell.c
    const updates = []

    // Write header
    for (let c = 0; c < queryResult.columns.length; c++) {
      updates.push({
        r: startR,
        c: startC + c,
        raw: queryResult.columns[c],
        style: { bold: true, bg: '#f0f0f0' }
      })
    }

    // Write rows
    for (let r = 0; r < queryResult.rows.length; r++) {
      const row = queryResult.rows[r]
      for (let c = 0; c < row.length; c++) {
        updates.push({
          r: startR + 1 + r,
          c: startC + c,
          raw: String(row[c] ?? '')
        })
      }
    }

    engine.batchSetCells(updates, 'insert_query', true)
    forceRerender()
  }, [activeCell, engine, forceRerender])

  // ────── Filter Popover Actions ──────

  const distinctColValues = useMemo(() => {
    if (openFilterCol === null) return []
    const used = engine.getUsedRange()
    const set = new Set()
    let hasBlank = false

    for (let r = 1; r <= used.maxRow; r++) {
      const val = engine.getCell(r, openFilterCol).raw
      const normVal = norm(val)
      if (normVal === '') hasBlank = true
      else set.add(normVal)
    }

    const list = Array.from(set).sort()
    if (hasBlank) list.unshift('(Blanks)')
    return list
  }, [openFilterCol, engine])

  const handleFilterSearchChange = useCallback((col, search) => {
    setFilters(prev => ({
      ...prev,
      [col]: { ...(prev[col] || {}), search }
    }))
  }, [])

  const toggleFilterValue = useCallback((col, val) => {
    setFilters(prev => {
      const cur = prev[col] || {}
      const selSet = cur.selectedValues ? new Set(cur.selectedValues) : new Set(distinctColValues)
      if (selSet.has(val)) selSet.delete(val)
      else selSet.add(val)
      return {
        ...prev,
        [col]: { ...cur, selectedValues: selSet }
      }
    })
  }, [distinctColValues])

  const clearFilterForCol = useCallback((col) => {
    setFilters(prev => {
      const next = { ...prev }
      delete next[col]
      return next
    })
  }, [])

  const clearAllFilters = useCallback(() => {
    setFilters({})
  }, [])

  // ────── Selection Box Layout Calculations ──────

  const selBoxStyle = useMemo(() => {
    const sel = normalizedSelection
    const top = getRowTop(sel.r1)
    const left = ROW_HEADER_WIDTH + getColLeft(sel.c1)
    let width = 0
    for (let c = sel.c1; c <= sel.c2; c++) width += getColWidth(c)
    let height = 0
    for (let r = sel.r1; r <= sel.r2; r++) height += getRowHeight(r)

    return {
      top: `${top}px`,
      left: `${left}px`,
      width: `${width}px`,
      height: `${height}px`
    }
  }, [normalizedSelection, getRowTop, getColLeft, getColWidth, getRowHeight])

  const fillPreviewStyle = useMemo(() => {
    if (!fillRange) return null
    const top = getRowTop(fillRange.r1)
    const left = ROW_HEADER_WIDTH + getColLeft(fillRange.c1)
    let width = 0
    for (let c = fillRange.c1; c <= fillRange.c2; c++) width += getColWidth(c)
    let height = 0
    for (let r = fillRange.r1; r <= fillRange.r2; r++) height += getRowHeight(r)

    return {
      top: `${top}px`,
      left: `${left}px`,
      width: `${width}px`,
      height: `${height}px`
    }
  }, [fillRange, getRowTop, getColLeft, getColWidth, getRowHeight])

  // Total canvas dimensions
  const totalGridHeight = useMemo(() => getRowTop(TOTAL_ROWS), [getRowTop])
  const totalGridWidth = useMemo(() => ROW_HEADER_WIDTH + getColLeft(TOTAL_COLS), [getColLeft])

  return (
    <div className="app-wrapper">
      {/* ── Top Bar ── */}
      <header className="app-header">
        <div className="header-left">
          <span className="logo-icon">📊</span>
          <h1 className="app-title">WorkElate Spreadsheet</h1>
          <span className="badge-pro">100k Rows Engine</span>
        </div>
        <div className="header-right">
          <button
            className={`ai-trigger-btn ${isAiOpen ? 'active' : ''}`}
            onClick={() => setIsAiOpen(v => !v)}
            title="Open AI Assistant (Ctrl+K)"
          >
            ✨ AI Assistant <kbd>Ctrl+K</kbd>
          </button>
        </div>
      </header>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <div className="toolbar-group">
          <button
            className={`toolbar-btn icon-btn ${activeStyle.bold ? 'active' : ''}`}
            onClick={toggleBold}
            title="Bold (Ctrl+B)"
          >
            <strong>B</strong>
          </button>
          <button
            className={`toolbar-btn icon-btn ${activeStyle.italic ? 'active' : ''}`}
            onClick={toggleItalic}
            title="Italic (Ctrl+I)"
          >
            <em>I</em>
          </button>
          <button
            className={`toolbar-btn icon-btn ${activeStyle.underline ? 'active' : ''}`}
            onClick={toggleUnderline}
            title="Underline (Ctrl+U)"
          >
            <u>U</u>
          </button>
        </div>

        <div className="toolbar-group">
          <select
            className="toolbar-select"
            value={activeStyle.fontSize || 13}
            onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
            title="Font Size"
          >
            {[8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
              <option key={s} value={s}>{s}px</option>
            ))}
          </select>
        </div>

        <div className="toolbar-group">
          <button
            className={`toolbar-btn ${activeStyle.align === 'left' ? 'active' : ''}`}
            onClick={() => setAlignment('left')}
            title="Align Left"
          >
            ⇤
          </button>
          <button
            className={`toolbar-btn ${activeStyle.align === 'center' ? 'active' : ''}`}
            onClick={() => setAlignment('center')}
            title="Align Center"
          >
            ⇥⇤
          </button>
          <button
            className={`toolbar-btn ${activeStyle.align === 'right' ? 'active' : ''}`}
            onClick={() => setAlignment('right')}
            title="Align Right"
          >
            ⇥
          </button>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Format:</span>
          <select
            className="toolbar-select"
            value={activeStyle.numberFormat || 'general'}
            onChange={(e) => setNumberFormat(e.target.value)}
            title="Number Format"
          >
            <option value="general">General</option>
            <option value="number">Number (1,200.00)</option>
            <option value="currency">Currency ($1,200.00)</option>
            <option value="percent">Percent (10%)</option>
            <option value="date">Date (2024-01-15)</option>
          </select>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Color:</span>
          <input
            type="color"
            className="color-picker-input"
            value={activeStyle.color || '#202124'}
            onChange={(e) => setColor(e.target.value)}
            title="Text Color"
          />
          <span className="toolbar-label">Fill:</span>
          <select
            className="toolbar-select"
            value={activeStyle.bg || 'white'}
            onChange={(e) => setBgColor(e.target.value)}
            title="Fill Color"
          >
            <option value="white">White</option>
            <option value="#ffff99">Yellow</option>
            <option value="#99ffcc">Green</option>
            <option value="#ffcccc">Red</option>
            <option value="#cce5ff">Blue</option>
            <option value="#e0ccff">Purple</option>
            <option value="#ffd9b3">Orange</option>
            <option value="#f0f0f0">Gray</option>
          </select>
        </div>

        <div className="toolbar-group">
          <button className="toolbar-btn" onClick={() => { if (engine.undo()) forceRerender() }} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button className="toolbar-btn" onClick={() => { if (engine.redo()) forceRerender() }} disabled={!engine.canRedo()} title="Redo (Ctrl+Y)">↷ Redo</button>
        </div>

        <div className="toolbar-group">
          <button className="toolbar-btn" onClick={insertRow} title="Insert Row Above">+ Row</button>
          <button className="toolbar-btn" onClick={deleteRow} title="Delete Row">- Row</button>
          <button className="toolbar-btn" onClick={insertColumn} title="Insert Column Before">+ Col</button>
          <button className="toolbar-btn" onClick={deleteColumn} title="Delete Column">- Col</button>
        </div>

        <div className="toolbar-group">
          <button
            className={`toolbar-btn ${frozenRows > 0 ? 'active' : ''}`}
            onClick={() => setFrozenRows(f => f > 0 ? 0 : 1)}
            title="Toggle Freeze Header Row"
          >
            📌 {frozenRows > 0 ? 'Unfreeze' : 'Freeze'} Row 1
          </button>
        </div>

        <div className="toolbar-group">
          {activeFilterCols.length > 0 && (
            <button className="toolbar-btn warning" onClick={clearAllFilters} title="Clear All Active Filters">
              ✕ Clear Filters ({activeFilterCols.length})
            </button>
          )}
          <button className="toolbar-btn danger" onClick={() => { engine.clearRange(normalizedSelection); forceRerender(); }} title="Clear Selection (Delete)">
            ✕ Clear
          </button>
        </div>

        <div className="toolbar-group right-group">
          <button className="toolbar-btn sample-btn" onClick={() => loadSample(loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows)">
            ⬇ Sample 33
          </button>
          <button className="toolbar-btn sample-btn" onClick={() => loadSample(loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows)">
            ⬇ Sample 3k
          </button>
        </div>
      </div>

      {/* ── Formula Bar & Name Box ── */}
      <div className="formula-bar-container">
        <div className="name-box">
          <input
            className="name-box-input"
            value={nameBoxInput}
            onChange={(e) => setNameBoxInput(e.target.value.toUpperCase())}
            onKeyDown={handleNameBoxSubmit}
            placeholder="A1"
            title="Jump to cell (e.g. AZ5000) and press Enter"
          />
        </div>
        <div className="formula-icon">fx</div>
        <input
          ref={formulaBarInputRef}
          className="formula-input"
          value={editingCell ? editValue : (engine.getCellRaw(activeCell.r, activeCell.c).raw || '')}
          onChange={(e) => {
            if (!editingCell) setEditingCell(activeCell)
            setEditValue(e.target.value)
          }}
          onFocus={() => {
            if (!editingCell) {
              setEditingCell(activeCell)
              setEditValue(engine.getCellRaw(activeCell.r, activeCell.c).raw || '')
            }
          }}
          placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
        />
      </div>

      {/* ── Main Viewport Container with Virtual Grid and AI Side Panel ── */}
      <div className="workspace-body">
        <div className="grid-outer-container">
          {/* ── Frozen Header Row (Scrolls horizontally with body) ── */}
          <div
            className="frozen-header-row"
            style={{ transform: `translateX(-${scrollState.scrollLeft}px)` }}
          >
            <div className="corner-header-cell">#</div>
            {Array.from({ length: TOTAL_COLS }, (_, c) => {
              const width = getColWidth(c)
              const isColSorted = sortState.col === c
              const hasFilter = !!filters[c]
              return (
                <div
                  key={c}
                  className={`col-header-cell ${isColSorted ? 'sorted' : ''} ${hasFilter ? 'filtered' : ''}`}
                  style={{ width: `${width}px` }}
                  onClick={() => selectEntireColumn(c)}
                  title={`Click to select column ${indexToColumnLetter(c)}. Click arrow to sort.`}
                >
                  <span className="col-letter">{indexToColumnLetter(c)}</span>
                  <button
                    className={`sort-arrow-btn ${isColSorted ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleHeaderClick(c)
                    }}
                    title="Click to sort (Asc / Desc / Original)"
                  >
                    {isColSorted ? (sortState.dir === 'asc' ? '▲' : sortState.dir === 'desc' ? '▼' : '↺') : '⇅'}
                  </button>
                  <button
                    className={`filter-icon-btn ${hasFilter ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenFilterCol(openFilterCol === c ? null : c)
                    }}
                    title="Filter this column"
                  >
                    ▼
                  </button>
                  <div
                    className="col-resize-handle"
                    onMouseDown={(e) => handleColResizeMouseDown(c, e)}
                    onDoubleClick={(e) => handleColAutoFit(c, e)}
                    title="Drag to resize, double-click to auto-fit"
                  />
                </div>
              )
            })}
          </div>

          {/* ── Virtual Grid Scrollport ── */}
          <div
            ref={gridViewportRef}
            className="virtual-scrollport"
            onScroll={handleScroll}
          >
            <div
              className="virtual-canvas"
              style={{ width: `${totalGridWidth}px`, height: `${totalGridHeight}px` }}
            >
              {/* ── Render Selection Box ── */}
              <div className="selection-box" style={selBoxStyle}>
                <div
                  className="fill-handle"
                  onMouseDown={handleFillHandleMouseDown}
                  title="Drag fill handle to extrapolate series"
                />
              </div>

              {/* ── Render Fill Handle Preview ── */}
              {fillPreviewStyle && (
                <div className="fill-preview-box" style={fillPreviewStyle} />
              )}

              {/* ── Render Virtual Visible Rows ── */}
              {Array.from({ length: virtualBounds.endRow - virtualBounds.startRow + 1 }, (_, i) => {
                const r = virtualBounds.startRow + i
                if (visibleRowsSet && !visibleRowsSet.has(r)) return null

                const rowTop = getRowTop(r)
                const rowHeight = getRowHeight(r)

                return (
                  <div
                    key={r}
                    className="virtual-row"
                    style={{
                      position: 'absolute',
                      top: `${rowTop}px`,
                      left: 0,
                      width: `${totalGridWidth}px`,
                      height: `${rowHeight}px`
                    }}
                  >
                    {/* ── Row Header Cell (Frozen on Left) ── */}
                    <div
                      className="row-header-cell"
                      style={{
                        position: 'sticky',
                        left: 0,
                        height: `${rowHeight}px`,
                        zIndex: 2
                      }}
                      onClick={() => selectEntireRow(r)}
                      title={`Row ${r + 1}`}
                    >
                      <span>{r + 1}</span>
                      <div
                        className="row-resize-handle"
                        onMouseDown={(e) => handleRowResizeMouseDown(r, e)}
                        title="Drag to resize row height"
                      />
                    </div>

                    {/* ── Virtual Visible Column Cells in this Row ── */}
                    {Array.from({ length: virtualBounds.endCol - virtualBounds.startCol + 1 }, (_, j) => {
                      const c = virtualBounds.startCol + j
                      const colLeft = ROW_HEADER_WIDTH + getColLeft(c)
                      const colWidth = getColWidth(c)
                      const isEditing = editingCell?.r === r && editingCell?.c === c
                      const isSelected = normalizedSelection.r1 <= r && r <= normalizedSelection.r2 &&
                                         normalizedSelection.c1 <= c && c <= normalizedSelection.c2

                      const cellData = engine.getCell(r, c)
                      const displayVal = engine.getFormatDisplay(r, c)
                      const style = cellData.style || {}

                      return (
                        <div
                          key={c}
                          className={`virtual-cell ${isSelected ? 'selected' : ''} ${cellData.error ? 'error' : ''}`}
                          style={{
                            position: 'absolute',
                            left: `${colLeft}px`,
                            width: `${colWidth}px`,
                            height: `${rowHeight}px`,
                            fontWeight: style.bold ? 'bold' : 'normal',
                            fontStyle: style.italic ? 'italic' : 'normal',
                            textDecoration: style.underline ? 'underline' : 'none',
                            color: cellData.error ? '#d93025' : (style.color || '#202124'),
                            fontSize: `${style.fontSize || 13}px`,
                            textAlign: style.align || 'left',
                            backgroundColor: style.bg || 'white'
                          }}
                          onMouseDown={(e) => handleCellMouseDown(r, c, e)}
                          onDoubleClick={() => startEditing(r, c)}
                        >
                          {isEditing ? (
                            <input
                              ref={cellInputRef}
                              className="cell-editor-input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={commitEdit}
                              style={{
                                fontWeight: style.bold ? 'bold' : 'normal',
                                fontStyle: style.italic ? 'italic' : 'normal',
                                textDecoration: style.underline ? 'underline' : 'none',
                                color: style.color || '#202124',
                                fontSize: `${style.fontSize || 13}px`,
                                textAlign: style.align || 'left'
                              }}
                            />
                          ) : (
                            <div className="cell-content-text">{displayVal}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── Filter Popover Dialog ── */}
        {openFilterCol !== null && (
          <div className="filter-popover-backdrop" onClick={() => setOpenFilterCol(null)}>
            <div
              className="filter-popover"
              onClick={(e) => e.stopPropagation()}
              style={{ left: `${Math.min(window.innerWidth - 320, Math.max(20, getColLeft(openFilterCol) - scrollState.scrollLeft + 40))}px` }}
            >
              <div className="filter-header">
                <h4>Filter Column {indexToColumnLetter(openFilterCol)}</h4>
                <button className="close-btn" onClick={() => setOpenFilterCol(null)}>✕</button>
              </div>

              {/* Search in Distinct Values */}
              <div className="filter-search-box">
                <input
                  className="filter-search-input"
                  placeholder="Search values..."
                  value={filters[openFilterCol]?.search || ''}
                  onChange={(e) => handleFilterSearchChange(openFilterCol, e.target.value)}
                />
              </div>

              {/* Distinct Values Checklist */}
              <div className="filter-checklist">
                <div className="checklist-actions">
                  <button
                    className="link-btn"
                    onClick={() => {
                      setFilters(prev => ({
                        ...prev,
                        [openFilterCol]: { ...(prev[openFilterCol] || {}), selectedValues: new Set(distinctColValues) }
                      }))
                    }}
                  >
                    Select All
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => {
                      setFilters(prev => ({
                        ...prev,
                        [openFilterCol]: { ...(prev[openFilterCol] || {}), selectedValues: new Set() }
                      }))
                    }}
                  >
                    Clear All
                  </button>
                </div>
                <div className="checklist-items">
                  {distinctColValues
                    .filter(v => !filters[openFilterCol]?.search || v.toLowerCase().includes(filters[openFilterCol].search.toLowerCase()))
                    .map(v => {
                      const cur = filters[openFilterCol]
                      const isChecked = !cur || !cur.selectedValues || cur.selectedValues.has(v)
                      return (
                        <label key={v} className="checklist-item">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleFilterValue(openFilterCol, v)}
                          />
                          <span>{v}</span>
                        </label>
                      )
                    })}
                </div>
              </div>

              {/* Conditions Filter */}
              <div className="filter-condition-section">
                <span className="section-title">Filter by Condition:</span>
                <select
                  className="toolbar-select"
                  value={filters[openFilterCol]?.condition?.op || ''}
                  onChange={(e) => {
                    const op = e.target.value
                    setFilters(prev => ({
                      ...prev,
                      [openFilterCol]: {
                        ...(prev[openFilterCol] || {}),
                        condition: { op, value: prev[openFilterCol]?.condition?.value || '' }
                      }
                    }))
                  }}
                >
                  <option value="">None</option>
                  <option value="contains">Text contains</option>
                  <option value="gt">Greater than</option>
                  <option value="lt">Less than</option>
                  <option value="isEmpty">Is empty</option>
                </select>
                {filters[openFilterCol]?.condition?.op && filters[openFilterCol]?.condition?.op !== 'isEmpty' && (
                  <input
                    className="condition-value-input"
                    placeholder="Value..."
                    value={filters[openFilterCol]?.condition?.value || ''}
                    onChange={(e) => {
                      const value = e.target.value
                      setFilters(prev => ({
                        ...prev,
                        [openFilterCol]: {
                          ...(prev[openFilterCol] || {}),
                          condition: { ...(prev[openFilterCol]?.condition || {}), value }
                        }
                      }))
                    }}
                  />
                )}
              </div>

              <div className="filter-footer">
                <button className="toolbar-btn danger" onClick={() => clearFilterForCol(openFilterCol)}>Clear Filter</button>
                <button className="toolbar-btn active" onClick={() => setOpenFilterCol(null)}>Apply</button>
              </div>
            </div>
          </div>
        )}

        {/* ── AI Assistant Side Panel (Ctrl+K) ── */}
        {isAiOpen && (
          <aside className="ai-side-panel">
            <div className="ai-panel-header">
              <div className="ai-header-title">
                <span className="ai-sparkle">✨</span>
                <h3>WorkElate AI Assistant</h3>
              </div>
              <div className="ai-provider-selector">
                <span className="provider-label">Provider:</span>
                <select
                  className="provider-select"
                  value={aiProviderKind}
                  onChange={(e) => setAiProviderKind(e.target.value)}
                >
                  <option value="mock">Offline Mock</option>
                  <option value="http">Live HTTP</option>
                </select>
                <button className="panel-close-btn" onClick={() => setIsAiOpen(false)}>✕</button>
              </div>
            </div>

            <div className="ai-chat-body">
              {aiHistory.length === 0 && (
                <div className="ai-empty-state">
                  <p>Ask a question or request formatting:</p>
                  <div className="ai-prompt-chips">
                    <button className="prompt-chip" onClick={() => handleSendAiPrompt("What is the total sales by region?")}>
                      "Total sales by region?"
                    </button>
                    <button className="prompt-chip" onClick={() => handleSendAiPrompt("Which product sold the most units?")}>
                      "Which product sold the most units?"
                    </button>
                    <button className="prompt-chip" onClick={() => handleSendAiPrompt("Format this as a clean table")}>
                      "Format this as a clean table"
                    </button>
                    <button className="prompt-chip" onClick={() => handleSendAiPrompt("Make the header row bold and blue")}>
                      "Make header bold and blue"
                    </button>
                  </div>
                </div>
              )}

              {aiHistory.map((item, idx) => (
                <div key={idx} className={`ai-message-card ${item.role}`}>
                  {item.role === 'user' ? (
                    <div className="user-prompt-text">{item.content}</div>
                  ) : item.error ? (
                    <div className="ai-error-box">
                      <span className="error-icon">⚠️</span>
                      <div className="error-text">{item.error}</div>
                    </div>
                  ) : item.action?.type === 'clarify' ? (
                    <div className="clarify-card">
                      <div className="clarify-question">❓ {item.action.question}</div>
                    </div>
                  ) : item.action?.type === 'query' ? (
                    <div className="query-result-card">
                      <div className="card-top-row">
                        <span className="card-type-badge">Query Plan</span>
                        <span className="row-count-badge">
                          {item.queryResult?.rowCount} rows {item.queryResult?.truncated ? '(Capped at 500)' : ''}
                        </span>
                      </div>

                      <div className="query-summary-text">
                        {item.action.groupBy ? `Grouped by ${item.action.groupBy.join(', ')}. ` : ''}
                        {item.action.aggregates ? `Aggregates: ${item.action.aggregates.map(a => `${a.fn}(${a.column})`).join(', ')}. ` : ''}
                        {item.action.sort ? `Sorted by ${item.action.sort.map(s => `${s.column} ${s.dir || 'asc'}`).join(', ')}.` : ''}
                      </div>

                      <button
                        className="toggle-plan-btn"
                        onClick={() => setShowPlanIndex(showPlanIndex === idx ? null : idx)}
                      >
                        {showPlanIndex === idx ? 'Hide Plan JSON' : 'Show Plan JSON'}
                      </button>

                      {showPlanIndex === idx && (
                        <pre className="plan-json-view">{JSON.stringify(item.action, null, 2)}</pre>
                      )}

                      {item.queryResult?.rows && item.queryResult.rows.length > 0 && (
                        <div className="query-table-scroll">
                          <table className="ai-result-table">
                            <thead>
                              <tr>
                                {item.queryResult.columns.map((c, i) => (
                                  <th key={i}>{c}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {item.queryResult.rows.slice(0, 15).map((r, i) => (
                                <tr key={i}>
                                  {r.map((val, j) => (
                                    <td key={j}>{typeof val === 'number' ? val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(val ?? '')}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {item.queryResult.rows.length > 15 && (
                            <div className="table-more-hint">...and {item.queryResult.rows.length - 15} more rows</div>
                          )}
                        </div>
                      )}

                      <div className="card-actions-row">
                        <button
                          className="toolbar-btn"
                          onClick={() => {
                            const res = executeQueryPlan(item.action, engine)
                            setAiHistory(prev => {
                              const next = [...prev]
                              next[idx] = { ...next[idx], queryResult: res }
                              return next
                            })
                          }}
                          title="Re-run query plan without calling the model"
                        >
                          🔄 Re-run
                        </button>
                        <button
                          className="toolbar-btn active"
                          onClick={() => handleInsertQueryIntoSheet(item.queryResult)}
                          title="Insert result table at current active cell (one undo step)"
                        >
                          📥 Insert into Sheet
                        </button>
                      </div>
                    </div>
                  ) : item.action?.type === 'format_sheet' ? (
                    <div className="format-preview-card">
                      <div className="card-top-row">
                        <span className="card-type-badge">Format Plan</span>
                        <span className="preview-label">Preview</span>
                      </div>

                      <ul className="preview-bullet-list">
                        {item.action.clearFormatting && <li>Clear all existing cell formatting</li>}
                        {item.action.headerStyle && <li>Header row: {Object.entries(item.action.headerStyle).map(([k, v]) => `${k}=${v}`).join(', ')}</li>}
                        {item.action.bodyStyle && <li>Body: {Object.entries(item.action.bodyStyle).map(([k, v]) => `${k}=${v}`).join(', ')}</li>}
                        {item.action.columns && <li>{item.action.columns.length} columns: number/align styles</li>}
                        {item.action.totalsStyle && <li>Totals row: {Object.entries(item.action.totalsStyle).map(([k, v]) => `${k}=${v}`).join(', ')}</li>}
                        {item.action.freezeRows !== undefined && <li>Freeze {item.action.freezeRows} rows</li>}
                        {item.action.autoFitColumns && <li>Auto-fit column widths</li>}
                      </ul>

                      <button
                        className="toggle-plan-btn"
                        onClick={() => setShowPlanIndex(showPlanIndex === idx ? null : idx)}
                      >
                        {showPlanIndex === idx ? 'Hide Action JSON' : 'Show Action JSON'}
                      </button>

                      {showPlanIndex === idx && (
                        <pre className="plan-json-view">{JSON.stringify(item.action, null, 2)}</pre>
                      )}

                      <div className="card-actions-row">
                        <button
                          className="toolbar-btn active"
                          onClick={() => handleApplyAiFormat(item.action)}
                          title="Apply format to sheet (one undo step)"
                        >
                          ✓ Apply Format
                        </button>
                        <button
                          className="toolbar-btn danger"
                          onClick={() => {
                            setAiHistory(prev => prev.filter((_, i) => i !== idx))
                          }}
                          title="Discard preview"
                        >
                          ✕ Discard
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}

              {aiError && (
                <div className="ai-error-box">
                  <span className="error-icon">⚠️</span>
                  <div className="error-text">{aiError}</div>
                </div>
              )}

              {aiLoading && (
                <div className="ai-loading-indicator">
                  <div className="spinner"></div>
                  <span>Translating prompt to action plan...</span>
                </div>
              )}
            </div>

            <div className="ai-input-footer">
              <input
                className="ai-prompt-input"
                placeholder="Ask your data or describe formatting..."
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendAiPrompt()
                  }
                }}
              />
              <button
                className="ai-send-btn"
                onClick={() => handleSendAiPrompt()}
                disabled={aiLoading || !aiPrompt.trim()}
              >
                Send
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* ── Status Bar ── */}
      <footer className="app-status-bar">
        <div className="status-left">
          <span className="status-item">
            <strong>Rows:</strong> {visibleDataRowsCount} of {totalDataRows} visible
          </span>
          {activeFilterCols.length > 0 && (
            <span className="filter-badge">
              Filtered ({activeFilterCols.length} cols)
            </span>
          )}
          <span className="status-item">
            <strong>Selection:</strong> {indexToCellKey(normalizedSelection.r1, normalizedSelection.c1)}
            {normalizedSelection.r1 !== normalizedSelection.r2 || normalizedSelection.c1 !== normalizedSelection.c2
              ? `:${indexToCellKey(normalizedSelection.r2, normalizedSelection.c2)} (${(normalizedSelection.r2 - normalizedSelection.r1 + 1) * (normalizedSelection.c2 - normalizedSelection.c1 + 1)} cells)`
              : ''}
          </span>
        </div>
        <div className="status-right">
          <span className="status-hint">
            Ctrl+K: AI Panel · Ctrl+Z: Undo · Ctrl+A: Select All · Enter: Edit · Drag ◾: Fill Handle
          </span>
        </div>
      </footer>
    </div>
  )
}
