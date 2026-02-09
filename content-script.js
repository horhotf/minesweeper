(() => {
  const HOTKEYS = {
    mines: { altKey: true, shiftKey: true, code: "Digit1" },
    probability: { altKey: true, shiftKey: true, code: "Digit2" },
    safe: { altKey: true, shiftKey: true, code: "Digit3" }
  };

  const STATE = {
    efficiencyMode: false
  };

  const OVERLAY_CLASS = "ms-helper-overlay";

  const STORAGE_KEY = "efficiencyMode";

  function loadSettings() {
    chrome.storage.sync.get({ [STORAGE_KEY]: false }, (data) => {
      STATE.efficiencyMode = Boolean(data[STORAGE_KEY]);
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) {
      STATE.efficiencyMode = Boolean(changes[STORAGE_KEY].newValue);
    }
  });

  loadSettings();

  function isHotkeyMatch(event, config) {
    return (
      event.code === config.code &&
      event.altKey === config.altKey &&
      event.shiftKey === config.shiftKey
    );
  }

  function getBoardElement() {
    return (
      document.querySelector("#game") ||
      document.querySelector(".game") ||
      document.querySelector(".board")
    );
  }

  function collectCells() {
    const board = getBoardElement();
    if (!board) {
      return [];
    }

    const cellNodes = board.querySelectorAll(".cell, td, .square");
    if (!cellNodes.length) {
      return [];
    }

    const boardRect = board.getBoundingClientRect();
    const cells = Array.from(cellNodes)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          rect,
          top: Math.round(rect.top - boardRect.top),
          left: Math.round(rect.left - boardRect.left)
        };
      })
      .filter((cell) => cell.rect.width > 0 && cell.rect.height > 0);

    const rows = [...new Set(cells.map((cell) => cell.top))].sort((a, b) => a - b);
    const cols = [...new Set(cells.map((cell) => cell.left))].sort((a, b) => a - b);

    cells.forEach((cell) => {
      cell.row = rows.indexOf(cell.top);
      cell.col = cols.indexOf(cell.left);
      cell.state = detectCellState(cell.element);
      cell.number = detectCellNumber(cell.element);
    });

    return cells;
  }

  function detectCellState(element) {
    const classList = element.classList;
    if (classList.contains("flag") || classList.contains("flagged") || classList.contains("cell-flag")) {
      return "flagged";
    }
    if (classList.contains("open") || classList.contains("opened") || classList.contains("open1")) {
      return "opened";
    }
    if (classList.contains("closed") || classList.contains("unopened")) {
      return "closed";
    }
    if (element.getAttribute("data-state") === "opened") {
      return "opened";
    }
    if (element.getAttribute("data-state") === "flagged") {
      return "flagged";
    }
    return "closed";
  }

  function detectCellNumber(element) {
    const text = element.textContent?.trim() || "";
    const match = text.match(/^[1-8]$/);
    if (match) {
      return Number(match[0]);
    }
    const classMatch = Array.from(element.classList).join(" ").match(/open([1-8])/);
    if (classMatch) {
      return Number(classMatch[1]);
    }
    return null;
  }

  function buildGrid(cells) {
    const grid = new Map();
    cells.forEach((cell) => {
      grid.set(`${cell.row},${cell.col}`, cell);
    });
    return grid;
  }

  function getNeighbors(cell, grid) {
    const neighbors = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) {
          continue;
        }
        const neighbor = grid.get(`${cell.row + dr},${cell.col + dc}`);
        if (neighbor) {
          neighbors.push(neighbor);
        }
      }
    }
    return neighbors;
  }

  function solveBoard(cells) {
    const grid = buildGrid(cells);
    const mines = new Set();
    const safe = new Set();
    const probabilities = new Map();

    cells
      .filter((cell) => cell.state === "opened" && cell.number !== null)
      .forEach((cell) => {
        const neighbors = getNeighbors(cell, grid);
        const closed = neighbors.filter((neighbor) => neighbor.state === "closed");
        const flagged = neighbors.filter((neighbor) => neighbor.state === "flagged");
        const remaining = cell.number - flagged.length;

        if (remaining === 0 && closed.length) {
          closed.forEach((neighbor) => safe.add(neighbor));
        } else if (remaining === closed.length && closed.length) {
          closed.forEach((neighbor) => mines.add(neighbor));
        }

        if (remaining > 0 && closed.length) {
          const localProbability = Math.min(1, Math.max(0, remaining / closed.length));
          closed.forEach((neighbor) => {
            const prev = probabilities.get(neighbor) ?? 0;
            probabilities.set(neighbor, Math.max(prev, localProbability));
          });
        }
      });

    safe.forEach((cell) => probabilities.set(cell, 0));
    mines.forEach((cell) => probabilities.set(cell, 1));

    return { mines, safe, probabilities };
  }

  function clearOverlay() {
    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((element) => {
      element.classList.remove(OVERLAY_CLASS);
      element.style.removeProperty("--ms-helper-color");
      element.removeAttribute("data-ms-helper-label");
    });
  }

  function applyOverlay(items) {
    clearOverlay();
    items.forEach(({ cell, color, label }) => {
      cell.element.classList.add(OVERLAY_CLASS);
      cell.element.style.setProperty("--ms-helper-color", color);
      if (label) {
        cell.element.setAttribute("data-ms-helper-label", label);
      }
    });
  }

  function gradientColor(probability) {
    const clamped = Math.min(1, Math.max(0, probability));
    const red = Math.round(255 * clamped);
    const green = Math.round(200 * (1 - clamped));
    return `rgba(${red}, ${green}, 60, 0.35)`;
  }

  function highlightMines(cells, mines) {
    const items = Array.from(mines).map((cell) => ({
      cell,
      color: "rgba(255, 60, 60, 0.45)",
      label: "💣"
    }));
    applyOverlay(items);
  }

  function highlightSafe(cells, safe) {
    const items = Array.from(safe).map((cell) => ({
      cell,
      color: "rgba(60, 200, 60, 0.35)",
      label: "✓"
    }));
    applyOverlay(items);
  }

  function highlightProbabilities(cells, probabilities) {
    let entries = Array.from(probabilities.entries())
      .filter(([cell]) => cell.state === "closed")
      .map(([cell, probability]) => ({ cell, probability }));

    if (!entries.length) {
      clearOverlay();
      return;
    }

    if (STATE.efficiencyMode) {
      const minProbability = Math.min(...entries.map((entry) => entry.probability));
      entries = entries.filter((entry) => entry.probability === minProbability);
    }

    const items = entries.map(({ cell, probability }) => ({
      cell,
      color: gradientColor(probability),
      label: `${Math.round(probability * 100)}%`
    }));

    applyOverlay(items);
  }

  function handleHotkey(action) {
    const cells = collectCells();
    if (!cells.length) {
      return;
    }

    const { mines, safe, probabilities } = solveBoard(cells);

    if (action === "mines") {
      highlightMines(cells, mines);
    } else if (action === "safe") {
      highlightSafe(cells, safe);
    } else if (action === "probability") {
      highlightProbabilities(cells, probabilities);
    }
  }

  document.addEventListener("keydown", (event) => {
    if (isHotkeyMatch(event, HOTKEYS.mines)) {
      event.preventDefault();
      handleHotkey("mines");
    } else if (isHotkeyMatch(event, HOTKEYS.probability)) {
      event.preventDefault();
      handleHotkey("probability");
    } else if (isHotkeyMatch(event, HOTKEYS.safe)) {
      event.preventDefault();
      handleHotkey("safe");
    }
  });
})();
