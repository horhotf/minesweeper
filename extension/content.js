const SETTINGS_KEY = "ms-helper-settings";
const DEFAULT_SETTINGS = {
  efficiencyMode: false,
};

const KEYBINDINGS = {
  highlightMines: { altKey: true, shiftKey: true, code: "Digit1" },
  showProbabilities: { altKey: true, shiftKey: true, code: "Digit2" },
  highlightSafe: { altKey: true, shiftKey: true, code: "Digit3" },
};

let settings = { ...DEFAULT_SETTINGS };
let overlayContainer = null;

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

const locateGrid = () => {
  const board =
    document.querySelector("#game") ||
    document.querySelector("#board") ||
    document.querySelector(".game") ||
    document.querySelector(".board") ||
    document.querySelector(".minesweeper") ||
    document.querySelector("#AreaBlock") ||
    document.querySelector("#area");

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

const analyzeBoard = () => {
  const grid = locateGrid();
  if (!grid) return null;

  const mines = new Set();
  const safe = new Set();
  const probabilities = new Map();

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
        const probability = remaining / closed.length;
        closed.forEach((neighbor) => {
          const current = probabilities.get(neighbor.cell) ?? [];
          probabilities.set(neighbor.cell, [...current, probability]);
        });
      }
    });
  });

  const probabilityMap = new Map();
  probabilities.forEach((list, cell) => {
    const average = list.reduce((sum, value) => sum + value, 0) / list.length;
    probabilityMap.set(cell, average);
  });

  return { mines, safe, probabilityMap };
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

const matchesKey = (event, binding) =>
  event.altKey === binding.altKey &&
  event.shiftKey === binding.shiftKey &&
  event.code === binding.code;

const onKeydown = (event) => {
  if (matchesKey(event, KEYBINDINGS.highlightMines)) {
    event.preventDefault();
    highlightMines();
  } else if (matchesKey(event, KEYBINDINGS.showProbabilities)) {
    event.preventDefault();
    showProbabilities();
  } else if (matchesKey(event, KEYBINDINGS.highlightSafe)) {
    event.preventDefault();
    highlightSafe();
  }
};

const init = async () => {
  await loadSettings();
  saveSettingsListener();
  document.addEventListener("keydown", onKeydown);
};

init();
