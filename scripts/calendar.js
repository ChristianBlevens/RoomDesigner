// Calendar module for Room Furniture Planner

import { getAllHouses } from './api.js';
import { formatDateRange } from './houses.js';

// Calendar state
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed
let housesData = [];
let houseColorMap = new Map();
let currentLoadedHouseId = null;

// Callbacks
let onHouseClick = null;
let onNewHouse = null;

// Color palette for houses
const HOUSE_COLORS = 8;

/**
 * Initialize the calendar module
 * @param {Object} callbacks - { onHouseClick, onNewHouse }
 */
export function initCalendar(callbacks) {
  onHouseClick = callbacks.onHouseClick;
  onNewHouse = callbacks.onNewHouse;

  setupCalendarControls();
}

/**
 * Set the currently loaded house (for highlighting)
 * @param {string|null} houseId
 */
export function setCurrentLoadedHouse(houseId) {
  currentLoadedHouseId = houseId;
}

/**
 * Render the calendar for the current month
 */
export async function renderCalendar() {
  // Fetch all houses
  housesData = await getAllHouses();

  // Assign colors to houses
  assignHouseColors();

  // Update header
  updateCalendarHeader();

  // Render the grid
  renderCalendarGrid();
}

/**
 * Setup calendar navigation controls
 */
function setupCalendarControls() {
  const prevBtn = document.getElementById('calendar-prev-btn');
  const nextBtn = document.getElementById('calendar-next-btn');
  const todayBtn = document.getElementById('calendar-today-btn');
  const newHouseBtn = document.getElementById('calendar-new-house-btn');

  prevBtn?.addEventListener('click', () => {
    currentMonth--;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear--;
    }
    renderCalendar();
  });

  nextBtn?.addEventListener('click', () => {
    currentMonth++;
    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
    renderCalendar();
  });

  todayBtn?.addEventListener('click', () => {
    const today = new Date();
    currentYear = today.getFullYear();
    currentMonth = today.getMonth();
    renderCalendar();
  });

  newHouseBtn?.addEventListener('click', () => {
    if (onNewHouse) onNewHouse();
  });
}

/**
 * Update the month/year header display
 */
function updateCalendarHeader() {
  const monthYearEl = document.getElementById('calendar-month-year');
  if (!monthYearEl) return;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  monthYearEl.textContent = `${monthNames[currentMonth]} ${currentYear}`;
}

/**
 * Assign consistent colors to houses
 */
function assignHouseColors() {
  houseColorMap.clear();

  // Sort houses by creation date for consistent color assignment
  const sortedHouses = [...housesData].sort((a, b) =>
    (a.createdAt || 0) - (b.createdAt || 0)
  );

  sortedHouses.forEach((house, index) => {
    houseColorMap.set(house.id, index % HOUSE_COLORS);
  });
}

/**
 * Render the calendar grid
 */
function renderCalendarGrid() {
  const daysContainer = document.getElementById('calendar-days');
  if (!daysContainer) return;

  daysContainer.innerHTML = '';

  // Get first day of month and total days
  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDayOfWeek = firstDay.getDay(); // 0 = Sunday

  // Get days from previous month to fill first row
  const prevMonthLastDay = new Date(currentYear, currentMonth, 0).getDate();

  // Today's date for highlighting
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Get houses visible in this month
  const visibleHouses = getHousesInMonth(currentYear, currentMonth);

  // Calculate which row each house should be in for each day
  const houseRows = calculateHouseRows(visibleHouses);

  // Render 6 weeks (42 days)
  let dayNum = 1;
  let nextMonthDay = 1;

  for (let i = 0; i < 42; i++) {
    const dayCell = document.createElement('div');
    dayCell.className = 'calendar-day';

    let cellDate;
    let displayDay;

    if (i < startDayOfWeek) {
      // Previous month
      displayDay = prevMonthLastDay - startDayOfWeek + i + 1;
      cellDate = new Date(currentYear, currentMonth - 1, displayDay);
      dayCell.classList.add('other-month');
    } else if (dayNum <= daysInMonth) {
      // Current month
      displayDay = dayNum;
      cellDate = new Date(currentYear, currentMonth, dayNum);
      dayNum++;
    } else {
      // Next month
      displayDay = nextMonthDay;
      cellDate = new Date(currentYear, currentMonth + 1, nextMonthDay);
      nextMonthDay++;
      dayCell.classList.add('other-month');
    }

    const dateStr = formatDateStr(cellDate);
    dayCell.dataset.date = dateStr;

    // Check if today
    if (dateStr === todayStr) {
      dayCell.classList.add('today');
    }

    // Day number
    const dayNumberEl = document.createElement('div');
    dayNumberEl.className = 'day-number';
    dayNumberEl.textContent = displayDay;
    dayCell.appendChild(dayNumberEl);

    // Events container
    const eventsContainer = document.createElement('div');
    eventsContainer.className = 'day-events';

    // Add house events for this day
    const dayHouses = getHousesForDate(dateStr, houseRows);
    dayHouses.forEach(({ house, position }) => {
      const eventEl = createHouseEventElement(house, position);
      eventsContainer.appendChild(eventEl);
    });

    dayCell.appendChild(eventsContainer);
    daysContainer.appendChild(dayCell);
  }
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get houses that are visible in the given month
 */
function getHousesInMonth(year, month) {
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const monthStartStr = formatDateStr(monthStart);
  const monthEndStr = formatDateStr(monthEnd);

  return housesData.filter(house => {
    return house.startDate <= monthEndStr && house.endDate >= monthStartStr;
  });
}

/**
 * Calculate which row each house should occupy to avoid overlaps
 * Returns a map of houseId -> row number
 */
function calculateHouseRows(houses) {
  const rowAssignments = new Map();

  // Sort houses by start date
  const sortedHouses = [...houses].sort((a, b) =>
    a.startDate.localeCompare(b.startDate)
  );

  // Track which rows are occupied on each date
  const dateRowOccupancy = new Map();

  sortedHouses.forEach(house => {
    let row = 0;
    let foundRow = false;

    while (!foundRow) {
      foundRow = true;

      // Check if this row is free for all days this house spans
      const start = new Date(house.startDate);
      const end = new Date(house.endDate);

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDateStr(d);
        const occupancy = dateRowOccupancy.get(dateStr) || new Set();

        if (occupancy.has(row)) {
          foundRow = false;
          row++;
          break;
        }
      }
    }

    // Assign this row to the house
    rowAssignments.set(house.id, row);

    // Mark this row as occupied for all dates
    const start = new Date(house.startDate);
    const end = new Date(house.endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDateStr(d);
      if (!dateRowOccupancy.has(dateStr)) {
        dateRowOccupancy.set(dateStr, new Set());
      }
      dateRowOccupancy.get(dateStr).add(row);
    }
  });

  return rowAssignments;
}

/**
 * Get houses that should appear on a specific date
 * Returns array of { house, position, row }
 * position: 'start', 'middle', 'end', 'single'
 */
function getHousesForDate(dateStr, houseRows) {
  const result = [];

  housesData.forEach(house => {
    if (dateStr >= house.startDate && dateStr <= house.endDate) {
      let position;

      if (house.startDate === house.endDate) {
        position = 'single';
      } else if (dateStr === house.startDate) {
        position = 'start';
      } else if (dateStr === house.endDate) {
        position = 'end';
      } else {
        // Check if this is start of a week (Sunday) - treat as segment start
        const date = new Date(dateStr);
        if (date.getDay() === 0) {
          position = 'start';
        } else {
          position = 'middle';
        }
      }

      // Check if this is end of a week (Saturday) - treat as segment end
      const date = new Date(dateStr);
      if (date.getDay() === 6 && position === 'middle') {
        position = 'end';
      }
      if (date.getDay() === 6 && position === 'start' && dateStr !== house.endDate) {
        position = 'single'; // Single day in this week segment
      }

      result.push({
        house,
        position,
        row: houseRows.get(house.id) || 0
      });
    }
  });

  // Sort by row
  result.sort((a, b) => a.row - b.row);

  return result;
}

/**
 * Create a house event element
 */
function createHouseEventElement(house, position) {
  const el = document.createElement('div');
  el.className = `house-event event-${position} house-color-${houseColorMap.get(house.id)}`;
  el.dataset.houseId = house.id;

  if (house.id === currentLoadedHouseId) {
    el.classList.add('current-house');
  }

  // Only show name on start or single
  if (position === 'start' || position === 'single') {
    el.textContent = house.name;
    el.title = `${house.name}\n${formatDateRange(house.startDate, house.endDate)}`;
  } else {
    el.innerHTML = '&nbsp;'; // Invisible content to maintain height
    el.title = `${house.name}\n${formatDateRange(house.startDate, house.endDate)}`;
  }

  // Click handler
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (onHouseClick) onHouseClick(house.id, e);
  });

  return el;
}

