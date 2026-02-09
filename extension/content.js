const SETTINGS_KEY = "ms-helper-settings";
const DEFAULT_SETTINGS = {
  efficiencyMode: false,
};

const KEYBINDINGS = {
  highlightMines: { altKey: true, shiftKey: true, code: "Digit1" },
  showProbabilities: { altKey: true, shiftKey: true, code: "Digit2" },
  highlightSafe: { altKey: true, shiftKey: true, code: "Digit3" },
  efficiencyMove: { altKey: true, shiftKey: true, code: "Digit4" },
};

let settings = { ...DEFAULT_SETTINGS };
let overlayContainer = null;
let activeMode = null;
let boardObserver = null;
let pendingRefresh = null;
let cellIdCounter = 0;
const cellIds = new WeakMap();

const loadSettings = async () => {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
};

const saveSettingsListener = () => {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[SETTINGS_KEY]) {
      settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
    }
  });
};

const enableEfficiencyMode = async () => {
  if (settings.efficiencyMode) return;
  settings = { ...settings, efficiencyMode: true };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
};

const ensureOverlay = () => {
  if (overlayContainer && document.body.contains(overlayContainer)) {
    return overlayContainer;
  }

  overlayContainer = document.createElement("div");
  overlayContainer.className = "ms-helper-overlay";
  document.body.appendChild(overlayContainer);
  return overlayContainer;
};

const clearOverlay = () => {
  if (!overlayContainer) return;
  overlayContainer.innerHTML = "";
};

const getCellId = (cell) => {
  if (!cellIds.has(cell)) {
    cellIds.set(cell, `c${cellIdCounter}`);
    cellIdCounter += 1;
  }
  return cellIds.get(cell);
};

const parseNumberFromClass = (className) => {
  if (!className) return null;
  const match = className.match(/(?:type|open|number)([0-8])/i);
  if (match) return Number(match[1]);
  return null;
};

const getCellNumber = (cell) => {
  const text = cell.textContent.trim();
  if (text && Number.isInteger(Number(text))) {
    return Number(text);
  }
  const datasetValue = cell.dataset.value ?? cell.getAttribute("data-value");
  if (datasetValue && Number.isInteger(Number(datasetValue))) {
    return Number(datasetValue);
  }
  const classValue = parseNumberFromClass(cell.className);
  if (Number.isInteger(classValue)) {
    return classValue;
  }
  return null;
};

const getCellState = (cell) => {
  const classList = cell.className;
  const text = cell.textContent.trim();

  if (
    classList.includes("flag") ||
    classList.includes("flagged") ||
    classList.includes("marked") ||
    text === "🚩"
  ) {
    return "flag";
  }
  if (
    classList.includes("closed") ||
    classList.includes("unopened") ||
    classList.includes("blank") ||
    classList.includes("covered") ||
    cell.dataset.state === "closed" ||
    cell.getAttribute("data-state") === "closed"
  ) {
    return "closed";
  }
  if (Number.isInteger(getCellNumber(cell))) {
    return "open-number";
  }
  if (classList.includes("open") || classList.includes("opened")) {
    return "open";
  }
  return "unknown";
};

const parseCellId = (cellId) => {
  if (!cellId) return null;
  const match = cellId.match(/cell[_-](\d+)[_-](\d+)/i);
  if (!match) return null;
  return { row: Number(match[2]), col: Number(match[1]) };
};

const findBoardElement = () =>
  document.querySelector("#game") ||
  document.querySelector("#board") ||
  document.querySelector(".game") ||
  document.querySelector(".board") ||
  document.querySelector(".minesweeper") ||
  document.querySelector("#AreaBlock") ||
  document.querySelector("#area");

const locateGrid = () => {
  const board = findBoardElement();

  const candidateCells = Array.from(
    document.querySelectorAll("[id^='cell_'], [data-x][data-y], [data-row][data-col]")
  );
  if (candidateCells.length) {
    const cellsByRow = new Map();
    candidateCells.forEach((cell) => {
      const parsedId = parseCellId(cell.id);
      const row = Number(
        parsedId?.row ?? cell.dataset.row ?? cell.dataset.y ?? cell.getAttribute("data-row")
      );
      const col = Number(
        parsedId?.col ?? cell.dataset.col ?? cell.dataset.x ?? cell.getAttribute("data-col")
      );
      if (Number.isFinite(row) && Number.isFinite(col)) {
        if (!cellsByRow.has(row)) {
          cellsByRow.set(row, []);
        }
        cellsByRow.get(row).push({ cell, row, col });
      }
    });
    if (cellsByRow.size) {
      return Array.from(cellsByRow.keys())
        .sort((a, b) => a - b)
        .map((row) => cellsByRow.get(row).sort((a, b) => a.col - b.col));
    }
  }

  if (!board) return null;

  const rows = Array.from(board.querySelectorAll(".row"));
  if (rows.length) {
    return rows.map((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll(".cell, td, div"));
      return cells.map((cell, colIndex) => ({ cell, row: rowIndex, col: colIndex }));
    });
  }

  const flatCells = Array.from(board.querySelectorAll(".cell, td, div"));
  if (!flatCells.length) return null;

  const cellsByRow = new Map();
  flatCells.forEach((cell) => {
    const parsedId = parseCellId(cell.id);
    const row = Number(parsedId?.row ?? cell.dataset.row ?? cell.dataset.y ?? cell.getAttribute("data-row"));
    const col = Number(parsedId?.col ?? cell.dataset.col ?? cell.dataset.x ?? cell.getAttribute("data-col"));
    if (Number.isFinite(row) && Number.isFinite(col)) {
      if (!cellsByRow.has(row)) {
        cellsByRow.set(row, []);
      }
      cellsByRow.get(row).push({ cell, row, col });
    }
  });

  if (cellsByRow.size) {
    return Array.from(cellsByRow.keys())
      .sort((a, b) => a - b)
      .map((row) => cellsByRow.get(row).sort((a, b) => a.col - b.col));
  }

  const inferred = [];
  const cellsPerRow = Math.sqrt(flatCells.length);
  const rowCount = Number.isFinite(cellsPerRow) ? Math.round(cellsPerRow) : 0;
  if (!rowCount) return null;

  for (let row = 0; row < rowCount; row += 1) {
    const rowCells = flatCells.slice(row * rowCount, (row + 1) * rowCount);
    inferred.push(rowCells.map((cell, col) => ({ cell, row, col })));
  }

  return inferred;
};

const getNeighbors = (grid, row, col) => {
  const neighbors = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const targetRow = grid[row + dr];
      if (!targetRow) continue;
      const neighbor = targetRow[col + dc];
      if (neighbor) neighbors.push(neighbor);
    }
  }
  return neighbors;
};

const getGameMeta = () => {
  const widthInput = document.querySelector("#custom_width");
  const heightInput = document.querySelector("#custom_height");
  const minesInput = document.querySelector("#custom_mines");

  const width = widthInput ? Number(widthInput.value) : null;
  const height = heightInput ? Number(heightInput.value) : null;
  const mines = minesInput ? Number(minesInput.value) : null;

  if (Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(mines)) {
    return { width, height, mines };
  }

  const popover = document.querySelector("#difficulty_popover");
  const dataContent = popover?.getAttribute("data-content") || popover?.dataset?.content;
  if (dataContent) {
    const match = dataContent.match(/Размер:\s*(\d+)\s*x\s*(\d+)\s*\/\s*(\d+)/i);
    if (match) {
      return {
        width: Number(match[1]),
        height: Number(match[2]),
        mines: Number(match[3]),
      };
    }
  }

  return null;
};

const applyKnownToConstraint = (constraint, knownMines, knownSafe) => {
  const nextCells = new Set();
  let nextCount = constraint.count;

  constraint.cells.forEach((cell) => {
    if (knownSafe.has(cell)) {
      return;
    }
    if (knownMines.has(cell)) {
      nextCount -= 1;
      return;
    }
    nextCells.add(cell);
  });

  return { cells: nextCells, count: nextCount };
};

const isSubset = (subset, superset) => {
  for (const cell of subset) {
    if (!superset.has(cell)) return false;
  }
  return true;
};

const constraintKey = (constraint) => {
  const ids = Array.from(constraint.cells)
    .map((cell) => getCellId(cell))
    .sort();
  return `${ids.join(",")}:${constraint.count}`;
};

const propagateConstraints = (constraints, knownMines, knownSafe) => {
  let updated = true;

  while (updated) {
    updated = false;
    constraints = constraints
      .map((constraint) => applyKnownToConstraint(constraint, knownMines, knownSafe))
      .filter((constraint) => constraint.cells.size > 0);

    constraints.forEach((constraint) => {
      if (constraint.count === 0) {
        constraint.cells.forEach((cell) => {
          if (!knownSafe.has(cell)) {
            knownSafe.add(cell);
            updated = true;
          }
        });
      }
      if (constraint.count === constraint.cells.size && constraint.count > 0) {
        constraint.cells.forEach((cell) => {
          if (!knownMines.has(cell)) {
            knownMines.add(cell);
            updated = true;
          }
        });
      }
    });

    constraints = constraints
      .map((constraint) => applyKnownToConstraint(constraint, knownMines, knownSafe))
      .filter((constraint) => constraint.cells.size > 0);

    const existingKeys = new Set(constraints.map((constraint) => constraintKey(constraint)));
    for (let i = 0; i < constraints.length; i += 1) {
      for (let j = 0; j < constraints.length; j += 1) {
        if (i === j) continue;
        const a = constraints[i];
        const b = constraints[j];
        if (a.cells.size >= b.cells.size) continue;
        if (!isSubset(a.cells, b.cells)) continue;
        const diffCells = new Set();
        b.cells.forEach((cell) => {
          if (!a.cells.has(cell)) diffCells.add(cell);
        });
        const diffCount = b.count - a.count;
        if (diffCells.size === 0 || diffCount < 0) continue;
        const derived = { cells: diffCells, count: diffCount };
        const key = constraintKey(derived);
        if (!existingKeys.has(key)) {
          constraints.push(derived);
          existingKeys.add(key);
          updated = true;
        }
      }
    }
  }

  return constraints;
};

const enumerateProbabilities = (cells, constraints) => {
  const MAX_ENUM_CELLS = 15;
  if (cells.length > MAX_ENUM_CELLS) {
    return null;
  }

  const cellIndex = new Map();
  cells.forEach((cell, index) => cellIndex.set(cell, index));
  const constraintData = constraints.map((constraint) => ({
    cells: Array.from(constraint.cells).map((cell) => cellIndex.get(cell)),
    count: constraint.count,
  }));
  const constraintsByCell = Array.from({ length: cells.length }, () => []);
  constraintData.forEach((constraint, index) => {
    constraint.cells.forEach((cellIdx) => {
      constraintsByCell[cellIdx].push(index);
    });
  });

  const remainingCounts = constraintData.map((constraint) => constraint.count);
  const remainingCells = constraintData.map((constraint) => constraint.cells.length);

  let total = 0;
  const mineCounts = Array(cells.length).fill(0);

  const dfs = (index) => {
    if (index === cells.length) {
      if (remainingCounts.every((count) => count === 0)) {
        total += 1;
      }
      return;
    }

    for (let value = 0; value <= 1; value += 1) {
      const affected = constraintsByCell[index];
      const prevCounts = [];
      const prevCells = [];
      let valid = true;

      affected.forEach((constraintIndex) => {
        prevCounts.push(remainingCounts[constraintIndex]);
        prevCells.push(remainingCells[constraintIndex]);
        remainingCells[constraintIndex] -= 1;
        if (value === 1) {
          remainingCounts[constraintIndex] -= 1;
        }
        if (
          remainingCounts[constraintIndex] < 0 ||
          remainingCounts[constraintIndex] > remainingCells[constraintIndex]
        ) {
          valid = false;
        }
      });

      if (valid) {
        const beforeTotal = total;
        dfs(index + 1);
        if (total > beforeTotal && value === 1) {
          mineCounts[index] += total - beforeTotal;
        }
      }

      affected.forEach((constraintIndex, idx) => {
        remainingCounts[constraintIndex] = prevCounts[idx];
        remainingCells[constraintIndex] = prevCells[idx];
      });
    }
  };

  dfs(0);

  if (total === 0) return null;
  const probabilities = new Map();
  mineCounts.forEach((count, index) => {
    probabilities.set(cells[index], count / total);
  });
  return probabilities;
};

const computeProbabilities = (constraints, knownMines, knownSafe, unknownCells, flagsCount) => {
  const probabilityMap = new Map();
  knownMines.forEach((cell) => probabilityMap.set(cell, 1));
  knownSafe.forEach((cell) => probabilityMap.set(cell, 0));

  const remainingConstraints = constraints.filter((constraint) => constraint.cells.size > 0);
  const cellToConstraints = new Map();
  remainingConstraints.forEach((constraint) => {
    constraint.cells.forEach((cell) => {
      if (!cellToConstraints.has(cell)) {
        cellToConstraints.set(cell, []);
      }
      cellToConstraints.get(cell).push(constraint);
    });
  });

  const visited = new Set();
  remainingConstraints.forEach((constraint) => {
    constraint.cells.forEach((cell) => {
      if (visited.has(cell)) return;
      const stack = [cell];
      const componentCells = new Set();
      const componentConstraints = new Set();
      while (stack.length) {
        const current = stack.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        componentCells.add(current);
        const related = cellToConstraints.get(current) || [];
        related.forEach((relatedConstraint) => {
          componentConstraints.add(relatedConstraint);
          relatedConstraint.cells.forEach((neighbor) => {
            if (!visited.has(neighbor)) stack.push(neighbor);
          });
        });
      }

      const componentCellsArray = Array.from(componentCells);
      const componentConstraintsArray = Array.from(componentConstraints);
      const enumerated = enumerateProbabilities(componentCellsArray, componentConstraintsArray);
      if (enumerated) {
        enumerated.forEach((probability, targetCell) => {
          probabilityMap.set(targetCell, probability);
        });
      } else {
        componentConstraintsArray.forEach((componentConstraint) => {
          const average = componentConstraint.count / componentConstraint.cells.size;
          componentConstraint.cells.forEach((targetCell) => {
            const existing = probabilityMap.get(targetCell);
            if (existing == null) {
              probabilityMap.set(targetCell, average);
            } else {
              probabilityMap.set(targetCell, (existing + average) / 2);
            }
          });
        });
      }
    });
  });

  const meta = getGameMeta();
  if (meta && Number.isFinite(meta.mines)) {
    const totalCells = meta.width * meta.height;
    const remainingMines = Math.max(meta.mines - flagsCount - knownMines.size, 0);
    const remainingUnknown = Math.max(totalCells - flagsCount - knownMines.size - knownSafe.size, 0);
    const baseProbability =
      remainingUnknown > 0 ? Math.min(1, remainingMines / remainingUnknown) : null;

    if (baseProbability != null) {
      unknownCells.forEach((cell) => {
        if (!probabilityMap.has(cell)) {
          probabilityMap.set(cell, baseProbability);
        }
      });
    }
  }

  return probabilityMap;
};

const analyzeBoard = () => {
  const grid = locateGrid();
  if (!grid) return null;

  const mines = new Set();
  const safe = new Set();
  const constraints = [];
  const unknownCells = new Set();
  let flagsCount = 0;

  grid.forEach((row) => {
    row.forEach((entry) => {
      const { cell } = entry;
      const state = getCellState(cell);
      if (state === "flag") {
        flagsCount += 1;
      }
      if (state === "closed" || state === "unknown") {
        unknownCells.add(cell);
      }
    });
  });

  grid.forEach((row) => {
    row.forEach((entry) => {
      const { cell, row: rowIndex, col } = entry;
      const state = getCellState(cell);
      if (state !== "open-number") return;

      const number = getCellNumber(cell);
      if (!Number.isFinite(number) || number < 0) return;

      const neighbors = getNeighbors(grid, rowIndex, col);
      const closed = neighbors.filter((neighbor) => {
        const neighborState = getCellState(neighbor.cell);
        return neighborState === "closed" || neighborState === "unknown";
      });
      const flags = neighbors.filter((neighbor) => getCellState(neighbor.cell) === "flag");
      const remaining = number - flags.length;

      if (remaining === 0) {
        closed.forEach((neighbor) => safe.add(neighbor.cell));
        return;
      }

      if (remaining === closed.length && remaining > 0) {
        closed.forEach((neighbor) => mines.add(neighbor.cell));
        return;
      }

      if (closed.length > 0 && remaining > 0) {
        constraints.push({ cells: new Set(closed.map((neighbor) => neighbor.cell)), count: remaining });
      }
    });
  });

  const normalizedConstraints = propagateConstraints(constraints, mines, safe);
  const probabilityMap = computeProbabilities(
    normalizedConstraints,
    mines,
    safe,
    unknownCells,
    flagsCount
  );

  return { mines, safe, probabilityMap, unknownCells };
};

const colorForProbability = (probability) => {
  const clamped = Math.min(1, Math.max(0, probability));
  const red = Math.round(255 * clamped);
  const green = Math.round(255 * (1 - clamped));
  return `rgba(${red}, ${green}, 0, 0.55)`;
};

const addOverlay = (cell, color, label) => {
  const overlay = ensureOverlay();
  const rect = cell.getBoundingClientRect();
  const cellOverlay = document.createElement("div");
  cellOverlay.className = "ms-helper-cell-overlay";
  cellOverlay.style.left = `${rect.left + window.scrollX}px`;
  cellOverlay.style.top = `${rect.top + window.scrollY}px`;
  cellOverlay.style.width = `${rect.width}px`;
  cellOverlay.style.height = `${rect.height}px`;
  cellOverlay.style.backgroundColor = color;
  if (label) {
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    cellOverlay.appendChild(labelEl);
  }
  overlay.appendChild(cellOverlay);
};

const highlightMines = () => {
  const analysis = analyzeBoard();
  if (!analysis) return;
  clearOverlay();
  analysis.mines.forEach((cell) => addOverlay(cell, "rgba(255, 0, 0, 0.65)", "M"));
};

const highlightSafe = () => {
  const analysis = analyzeBoard();
  if (!analysis) return;
  clearOverlay();
  analysis.safe.forEach((cell) => addOverlay(cell, "rgba(0, 200, 0, 0.55)", "✓"));
};

const showProbabilities = () => {
  const analysis = analyzeBoard();
  if (!analysis) return;
  clearOverlay();

  analysis.probabilityMap.forEach((probability, cell) => {
    if (settings.efficiencyMode) {
      if (probability > 0.1 && probability < 0.9) return;
    }
    const percentage = Math.round(probability * 100);
    addOverlay(cell, colorForProbability(probability), `${percentage}%`);
  });
};

const highlightEfficiencyMove = () => {
  const analysis = analyzeBoard();
  if (!analysis) return;
  clearOverlay();

  if (analysis.safe.size > 0) {
    analysis.safe.forEach((cell) => addOverlay(cell, "rgba(0, 200, 0, 0.55)", "✓"));
    return;
  }

  let bestCell = null;
  let bestProbability = Infinity;
  analysis.probabilityMap.forEach((probability, cell) => {
    if (probability < bestProbability) {
      bestProbability = probability;
      bestCell = cell;
    }
  });

  if (bestCell) {
    const label = Number.isFinite(bestProbability)
      ? `${Math.round(bestProbability * 100)}%`
      : "?";
    addOverlay(bestCell, "rgba(0, 120, 255, 0.6)", label);
  }
};

const runActiveMode = () => {
  if (!activeMode) return;
  if (activeMode === "mines") highlightMines();
  if (activeMode === "safe") highlightSafe();
  if (activeMode === "probabilities") showProbabilities();
  if (activeMode === "efficiency") highlightEfficiencyMove();
};

const scheduleRefresh = () => {
  if (!activeMode) return;
  if (pendingRefresh) return;
  pendingRefresh = window.requestAnimationFrame(() => {
    pendingRefresh = null;
    runActiveMode();
  });
};

const stopObserver = () => {
  if (boardObserver) {
    boardObserver.disconnect();
    boardObserver = null;
  }
  if (pendingRefresh) {
    window.cancelAnimationFrame(pendingRefresh);
    pendingRefresh = null;
  }
};

const startObserver = () => {
  stopObserver();
  if (!activeMode) return;
  const target = findBoardElement() || document.body;
  boardObserver = new MutationObserver(() => scheduleRefresh());
  boardObserver.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "data-state", "data-value"],
  });
};

const setActiveMode = (mode) => {
  activeMode = mode;
  runActiveMode();
  startObserver();
};

const clearAll = () => {
  clearOverlay();
  activeMode = null;
  stopObserver();
};

const matchesKey = (event, binding) =>
  event.altKey === binding.altKey &&
  event.shiftKey === binding.shiftKey &&
  event.code === binding.code;

const onKeydown = (event) => {
  if (event.code === "Escape") {
    event.preventDefault();
    clearAll();
    return;
  }
  if (matchesKey(event, KEYBINDINGS.highlightMines)) {
    event.preventDefault();
    setActiveMode("mines");
  } else if (matchesKey(event, KEYBINDINGS.showProbabilities)) {
    event.preventDefault();
    setActiveMode("probabilities");
  } else if (matchesKey(event, KEYBINDINGS.highlightSafe)) {
    event.preventDefault();
    setActiveMode("safe");
  } else if (matchesKey(event, KEYBINDINGS.efficiencyMove)) {
    event.preventDefault();
    void enableEfficiencyMode();
    setActiveMode("efficiency");
  }
};

const init = async () => {
  await loadSettings();
  saveSettingsListener();
  document.addEventListener("keydown", onKeydown);
};

init();
