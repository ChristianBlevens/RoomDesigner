// Main entry point for Room Furniture Planner

import * as THREE from 'three';
import {
  initScene,
  loadModelFromExtractedZip,
  collectPlacedFurniture,
  clearAllFurniture,
  addFurnitureToScene,
  removeFurnitureByEntryId,
  calculateFurnitureScale,
  setCameraFov,
  setCameraForMoGeAlignment,
  loadRoomGeometry,
  clearRoomGeometry,
  setBackgroundImagePlane,
  clearBackgroundImagePlane,
  getRoomBounds,
  getDebugInfo,
  enableDebugCamera,
  disableDebugCamera,
  isDebugCameraEnabled,
  setRoomMeshVisible,
  raycastRoomSurface,
  getRoomMesh,
  getDirectionalLight,
  setLightIntensity,
  setShadowIntensity,
  setLightDirection,
  setLightTemperature,
  showLightingGizmo,
  hideLightingGizmo,
  updateLightingGizmo,
  raycastLightingGizmo,
  setLightingGizmoHover,
  getLightPosition,
  getLightTarget,
  setLightPosition,
  setLightTargetPosition,
  getLightingSettings,
  applyLightingSettings,
  isLightingGizmoVisible,
  getRoomScale,
  setRoomScale,
  resetRoomScale,
  setFurnitureVisible,
  createMeterStick,
  addMeterStickToScene,
  removeMeterStickFromScene,
  setMeterStickVisible,
  getMeterStick,
  isMeterStickVisible,
  clearMeterStick,
  getScene,
  getCamera,
  getRenderer,
  applyRoomScaleToAllFurniture
} from './scene.js';
import {
  saveFurnitureEntry,
  getFurnitureEntry,
  getAllFurniture,
  deleteFurnitureEntry,
  getAllCategories,
  getAllTags,
  saveRoom,
  deleteRoom,
  loadRoom as dbLoadRoom,
  getAllHouses,
  getHouse,
  getRoomsByHouseId,
  getOrphanRooms,
  subscribeToEvents,
  createRoom,
  getBatchAvailability,
  generateWallColor,
  deleteWallColor,
  getWallColorPresets,
  saveWallColorPresets,
  getDestagingBuffer,
  saveDestagingBuffer,
  generateShareToken,
  revokeShareToken,
  fetchAsBlob,
  getLayouts,
  createLayout,
  getLayout,
  deleteLayout
} from './api.js';
import {
  captureRoomScreenshot,
  captureThumbnail
} from './screenshot.js';
import {
  getCurrentHouse,
  setCurrentHouse,
  createHouse,
  updateHouse,
  deleteHouseWithRooms,
  getHouseById,
  getHouseRoomCount,
  formatDateRange,
  validateHouseDates
} from './houses.js';
import {
  initCalendar,
  renderCalendar,
  setCurrentLoadedHouse,
  getHouseColorIndex
} from './calendar.js';
import { modalManager, MultiSelectTags } from './modals.js';
import { undoManager } from './undo.js';
import {
  initFurnitureInteraction,
  setOpenFurnitureModalCallback,
  getLastClickPosition,
  placeFurniture,
  placeChildFurniture,
  getPlaceOnTopTarget,
  clearPlaceOnTopTarget,
  removeAllFurnitureByEntryId,
  deselectFurniture,
  setMeterStickDeletedCallback,
  setMeterStickPlaceCallback,
  setMeterStickPlacementActive
} from './furniture.js';
import {
  showError,
  hideError,
  extractModelFromZip,
  debounce
} from './utils.js';
import { adjustUrlForProxy } from './api.js';
import { invalidateCache } from './cache.js';
import { isAuthenticated, signIn, signUp, logout, getUsername, getToken, isAdmin } from './auth.js';

// Application state
let currentHouseId = null;
let currentRoomId = null;
let currentBackgroundImage = null;
let currentRoom = null;
let tagsDropdown = null;

// Previous room state for selective saves (only save changed fields)
let previousRoomState = null;

// Meter stick state
let meterStickPlacementMode = false;
let savedMeterStickData = null;

// Pending state for multi-step room creation flow
let pendingRoomImage = null;
let pendingRoomName = null;
let pendingClearFurniture = false;
let pendingFloorHint = '';

// Helper: count how many of a specific entry are placed in the current scene
function getPlacedCountForEntry(entryId) {
  const placed = collectPlacedFurniture();
  return placed.filter(f => f.entryId === entryId).length;
}

// House popup state
let popupHouseId = null;

// Editing house state
let editingHouseId = null;

// Entry editor state
let editingEntryId = null;
let entryImageBlob = null;
let entryModelBlob = null;
let entryTags = [];

// Popup state
let popupEntryId = null;

// Meshy generation tasks - simplified client tracking
// Set of task_ids that this client initiated (for toast notifications)
const myMeshyTasks = new Set();

// Server-provided task status (updated by polling)
let meshyServerStatus = { tasks: [], active: 0, max: 10 };

// Polling interval ID
let meshyPollInterval = null;

// Autosave state
let autosaveInterval = null;
let lastSavedHash = null;
let lastSavedState = null;
let saveInProgress = false;

// ============ Utility Functions ============

/**
 * Show a popup at the specified coordinates.
 */
function showPopupAt(popupId, x, y) {
  const popup = document.getElementById(popupId);
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  popup.classList.remove('modal-hidden');
}

/**
 * Hide a popup by ID.
 */
function hidePopup(popupId) {
  const popup = document.getElementById(popupId);
  popup.classList.add('modal-hidden');
}

/**
 * Show a confirmation dialog and execute action on confirm.
 * @param {string} message - Message to display
 * @param {Function} onConfirm - Async function to call on confirm
 * @param {Function} [onCancel] - Optional function to call on cancel
 */
export function showConfirmDialog(message, onConfirm, onCancel = null) {
  const messageEl = document.getElementById('confirm-delete-message');
  const confirmBtn = document.getElementById('confirm-delete-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  messageEl.textContent = message;

  const cleanup = () => {
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', handleCancel);
  };

  const handleConfirm = async () => {
    cleanup();
    await onConfirm();
  };

  const handleCancel = () => {
    cleanup();
    if (onCancel) {
      onCancel();
    } else {
      modalManager.closeModal();
    }
  };

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', handleCancel);

  modalManager.openModal('confirm-delete-modal');
}

// Initialize application
async function init() {
  // Check authentication first
  if (!isAuthenticated()) {
    setupAuthModal();
    showAuthModal();
    showFirstVisitTutorial();
    return;
  }

  // Hide auth modal if authenticated
  const authModal = document.getElementById('auth-modal');
  if (authModal) {
    authModal.classList.add('modal-hidden');
  }

  // Initialize Three.js scene
  initScene();

  // Initialize furniture interaction
  initFurnitureInteraction();
  setOpenFurnitureModalCallback(openFurnitureModal);

  // Setup UI event handlers
  setupFileInputs();
  setupClearFurnitureModal();
  setupOrientationModal();
  setupFurnitureModal();
  setupEntryEditor();
  setupSessionModal();
  setupUndoRedo();
  setupErrorPopup();
  setupEntryActionPopup();
  setupCalendar();
  setupHouseEditor();
  setupHouseActionPopup();
  setupRoomNameModal();
  setupTabBar();
  setupDebugPanel();
  setupLightingControls();
  setupScaleControls();
  setupLayoutControls();
  setupBeforeAfterToggle();
  setupMeterStick();
  setupWallColorControls();
  setupTutorials();
  setupControlsBarLayout();

  // Close control bar panels when clicking outside (capture phase to intercept before canvas)
  document.addEventListener('pointerdown', (event) => {
    // Dismiss conflict tooltips when tapping elsewhere
    if (!event.target.closest('.availability-badge')) {
      document.querySelectorAll('.availability-badge.tooltip-visible').forEach(b => {
        b.classList.remove('tooltip-visible');
      });
    }

    if (!lightingPanelOpen && !scalePanelOpen && !layoutsPanelOpen && !wallColorPanelOpen) return;

    // Never close panels when clicking on a modal overlay (modals sit above panels)
    if (event.target.closest('.modal-overlay')) return;

    const panelIds = ['lighting-panel', 'scale-panel', 'layouts-panel', 'wall-color-panel'];
    const buttonIds = ['lighting-btn', 'scale-btn', 'layouts-btn', 'paint-btn'];

    for (const id of panelIds) {
      const el = document.getElementById(id);
      if (el && el.contains(event.target)) return;
    }
    for (const id of buttonIds) {
      const el = document.getElementById(id);
      if (el && el.contains(event.target)) return;
    }

    // When lighting panel is open, allow canvas clicks through for gizmo handle dragging
    const canvas = document.getElementById('canvas-container');
    if (lightingPanelOpen && canvas && canvas.contains(event.target)) return;

    closeLightingPanelIfOpen();
    closeScalePanelIfOpen();
    closeLayoutsPanelIfOpen();
    closeWallColorPanelIfOpen();

    // Prevent this click from triggering canvas interactions (e.g. opening furniture modal)
    event.stopPropagation();
  }, true);

  // Warn about unsaved changes on page unload
  window.addEventListener('beforeunload', (e) => {
    if (!currentRoomId || !currentBackgroundImage || !lastSavedHash) return;
    // Synchronous check using last known state — can't do async hash here
    // Instead, serialize current state and compare to last saved hash synchronously
    const state = JSON.stringify({
      placedFurniture: collectPlacedFurniture(),
      lightingSettings: getLightingSettings(),
      roomScale: getRoomScale(),
      meterStick: getMeterStickSaveData()
    });
    // Quick length check as heuristic — if state string changed, warn
    if (state !== lastSavedState) {
      e.preventDefault();
    }
  });

  // SSE available via subscribeToEvents() for future real-time features

  // Check for active Meshy tasks on page load
  try {
    const token = getToken();
    const meshyHeaders = token ? { 'Authorization': `Bearer ${token}` } : {};
    const response = await fetch(adjustUrlForProxy('/api/meshy/tasks'), { headers: meshyHeaders });
    if (response.ok) {
      meshyServerStatus = await response.json();
      if (meshyServerStatus.tasks.some(t => !['completed', 'failed'].includes(t.status))) {
        startMeshyPolling();
      }
    }
  } catch (err) {
    console.error('Failed to check Meshy tasks:', err);
  }

  // Show calendar modal on startup
  await openCalendarModal();
}

// ============ Auth Modal ============

function setupAuthModal() {
  const form = document.getElementById('auth-form');
  const toggleLink = document.getElementById('auth-toggle-link');
  const title = document.getElementById('auth-title');
  const submitBtn = document.getElementById('auth-submit-btn');
  const errorEl = document.getElementById('auth-error');
  let isSignUp = false;

  toggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    isSignUp = !isSignUp;
    title.textContent = isSignUp ? 'Create Organization' : 'Sign In';
    submitBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
    toggleLink.textContent = isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up";
    errorEl.classList.add('hidden');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;

    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait...';

    try {
      if (isSignUp) {
        await signUp(username, password);
      } else {
        const result = await signIn(username, password);
        if (result.admin) {
          window.location.href = `${window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '')}/admin.html`;
          return;
        }
      }
      window.location.reload();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
    }
  });
}

function showAuthModal() {
  document.getElementById('auth-modal').classList.remove('modal-hidden');
}

async function showFirstVisitTutorial() {
  if (localStorage.getItem('tutorialShown')) return;
  localStorage.setItem('tutorialShown', '1');

  try {
    const basePath = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
    const response = await fetch(`${basePath}/tutorials/getting-started.md`);
    if (!response.ok) return;
    const markdown = await response.text();

    const modal = document.getElementById('tutorial-content-modal');
    const rendered = document.getElementById('tutorial-content-rendered');
    rendered.innerHTML = marked.parse(markdown);

    // Show above auth modal
    modal.style.zIndex = '10001';
    modal.classList.remove('modal-hidden');

    // Close on click outside content
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('modal-hidden');
        modal.style.zIndex = '';
      }
    });
  } catch (err) {
    console.warn('Failed to load getting started tutorial:', err);
  }
}

// ============ Debug Panel ============

function setupDebugPanel() {
  const panel = document.getElementById('debug-panel');
  const closeBtn = document.getElementById('debug-close-btn');
  const infoEl = document.getElementById('debug-info');

  let updateInterval = null;

  function updateDebugInfo() {
    const info = getDebugInfo();
    infoEl.textContent = JSON.stringify(info, null, 2);
  }

  function showDebugPanel() {
    panel.classList.remove('hidden');
    updateDebugInfo();
    // Update every 100ms while open (faster for camera movement)
    updateInterval = setInterval(updateDebugInfo, 100);
    // Enable debug camera
    enableDebugCamera();
  }

  function hideDebugPanel() {
    panel.classList.add('hidden');
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
    // Disable debug camera and restore original view
    disableDebugCamera();
  }

  function toggleDebugPanel() {
    if (panel.classList.contains('hidden')) {
      showDebugPanel();
    } else {
      hideDebugPanel();
    }
  }

  // Toggle with backtick (`) key
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~') {
      // Don't toggle if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      toggleDebugPanel();
    }
  });

  closeBtn.addEventListener('click', hideDebugPanel);

  console.log('Debug panel ready - press ` (backtick) to toggle');
}

// ============ Lighting Controls ============

// State for lighting interaction
let lightingPanelOpen = false;
let lightingDirectionMode = false;      // Creating new direction via Set Direction
let lightingDraggingHandle = null;      // 'source' or 'target' when dragging gizmo
let lightingBackup = null;              // Backup of light settings before creating new direction

// Expose lighting mode state for furniture.js to check
// Returns true when lighting panel is open (to block furniture modal)
export function isLightingDirectionMode() {
  return lightingPanelOpen || lightingDirectionMode || lightingDraggingHandle !== null;
}

// Close lighting panel programmatically (called when switching rooms, etc.)
function closeLightingPanelIfOpen() {
  if (lightingPanelOpen) {
    const lightingPanel = document.getElementById('lighting-panel');
    const lightingBtn = document.getElementById('lighting-btn');

    // If in direction mode, just cancel without restoring (room is switching anyway)
    lightingDirectionMode = false;
    lightingBackup = null;
    lightingDraggingHandle = null;

    lightingPanelOpen = false;
    if (lightingPanel) lightingPanel.classList.add('hidden');
    if (lightingBtn) lightingBtn.classList.remove('active');
    hideLightingGizmo();

    // Reset direction button state
    const directionBtn = document.getElementById('lighting-direction-btn');
    const directionStatus = document.getElementById('lighting-direction-status');
    if (directionBtn) {
      directionBtn.classList.remove('active');
      directionBtn.textContent = 'Set Direction';
    }
    if (directionStatus) directionStatus.textContent = '';
  }
}

// Update lighting UI sliders to match current light settings
function updateLightingUI() {
  const intensitySlider = document.getElementById('lighting-intensity-slider');
  const intensityValue = document.getElementById('lighting-intensity-value');
  const tempSlider = document.getElementById('lighting-temp-slider');
  const tempValue = document.getElementById('lighting-temp-value');
  const shadowSlider = document.getElementById('lighting-shadow-slider');
  const shadowValue = document.getElementById('lighting-shadow-value');

  const light = getDirectionalLight();
  if (light) {
    intensitySlider.value = light.intensity;
    intensityValue.textContent = light.intensity.toFixed(1);

    const temp = light.userData.temperature || 6500;
    tempSlider.value = temp;
    tempValue.textContent = temp + 'K';

    const shadow = light.userData.shadowIntensity ?? 0.5;
    shadowSlider.value = shadow;
    shadowValue.textContent = shadow.toFixed(2);
  }
}

function setupLightingControls() {
  const lightingBtn = document.getElementById('lighting-btn');
  const lightingPanel = document.getElementById('lighting-panel');
  const lightingCloseBtn = document.getElementById('lighting-close-btn');
  const intensitySlider = document.getElementById('lighting-intensity-slider');
  const intensityValue = document.getElementById('lighting-intensity-value');
  const tempSlider = document.getElementById('lighting-temp-slider');
  const tempValue = document.getElementById('lighting-temp-value');
  const shadowSlider = document.getElementById('lighting-shadow-slider');
  const shadowValue = document.getElementById('lighting-shadow-value');
  const directionBtn = document.getElementById('lighting-direction-btn');
  const directionStatus = document.getElementById('lighting-direction-status');

  const canvas = document.getElementById('canvas-container');

  // Toggle panel visibility
  lightingBtn.addEventListener('click', () => {
    if (lightingPanelOpen) {
      closeLightingPanel();
    } else {
      openLightingPanel();
    }
  });

  // Close button
  lightingCloseBtn.addEventListener('click', closeLightingPanel);

  function openLightingPanel() {
    // Close other panels if open (only one can be open at a time)
    closeScalePanelIfOpen();
    closeLayoutsPanelIfOpen();
    closeWallColorPanelIfOpen();

    lightingPanelOpen = true;
    lightingPanel.classList.remove('hidden');
    lightingBtn.classList.add('active');
    updateLightingUI();
    showLightingGizmo();
  }

  function closeLightingPanel() {
    // If in direction mode, restore backup and cancel
    if (lightingDirectionMode && lightingBackup) {
      applyLightingSettings(lightingBackup);
      updateLightingUI();
    }
    cancelLightingDirectionMode();

    lightingPanelOpen = false;
    lightingPanel.classList.add('hidden');
    lightingBtn.classList.remove('active');
    hideLightingGizmo();
  }

  // Intensity slider
  intensitySlider.addEventListener('input', () => {
    const value = parseFloat(intensitySlider.value);
    intensityValue.textContent = value.toFixed(1);
    setLightIntensity(value);
  });

  // Temperature slider
  tempSlider.addEventListener('input', () => {
    const kelvin = parseInt(tempSlider.value, 10);
    tempValue.textContent = kelvin + 'K';
    setLightTemperature(kelvin);
    const light = getDirectionalLight();
    if (light) light.userData.temperature = kelvin;
  });

  // Shadow intensity slider
  shadowSlider.addEventListener('input', () => {
    const value = parseFloat(shadowSlider.value);
    shadowValue.textContent = value.toFixed(2);
    setShadowIntensity(value);
    const light = getDirectionalLight();
    if (light) light.userData.shadowIntensity = value;
  });

  // Set Direction button
  directionBtn.addEventListener('click', () => {
    if (lightingDirectionMode) {
      // Cancel and restore backup
      if (lightingBackup) {
        applyLightingSettings(lightingBackup);
        updateLightingGizmo();
      }
      cancelLightingDirectionMode();
    } else {
      // Start direction mode - backup current settings
      lightingBackup = getLightingSettings();
      lightingDirectionMode = true;
      directionBtn.classList.add('active');
      directionBtn.textContent = 'Cancel';
      directionStatus.textContent = 'Press on mesh to set source';
    }
  });

  function cancelLightingDirectionMode() {
    lightingDirectionMode = false;
    lightingBackup = null;
    directionBtn.classList.remove('active');
    directionBtn.textContent = 'Set Direction';
    directionStatus.textContent = '';
    setLightingGizmoHover(null);
  }

  // Track active lighting pointer for touch/pen support
  let lightingPointerId = null;

  // Helper to check if pointer is over lighting panel
  function isPointerOverLightingPanel(event) {
    const panel = document.getElementById('lighting-panel');
    if (!panel || panel.classList.contains('hidden')) return false;
    const rect = panel.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right &&
           event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  // Pointer down - start dragging or start new direction
  canvas.addEventListener('pointerdown', (event) => {
    if (!lightingPanelOpen) return;
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (modalManager.isModalOpen()) return;

    const overPanel = isPointerOverLightingPanel(event);

    // Check if clicking on gizmo handle (for dragging existing)
    if (!lightingDirectionMode) {
      const gizmoHit = raycastLightingGizmo(event);
      if (gizmoHit) {
        lightingDraggingHandle = gizmoHit.type;
        lightingPointerId = event.pointerId;
        event.target.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // If over panel but no gizmo hit, block to prevent furniture actions
      if (overPanel) {
        event.stopPropagation();
        return;
      }
    }

    // If in direction mode, set source position (but not through panel)
    if (lightingDirectionMode && !overPanel) {
      const hit = raycastRoomSurface(event);
      if (hit) {
        setLightPosition(hit.point);
        // Also set target to same point initially (will be updated on drag/release)
        setLightTargetPosition(hit.point);
        updateLightingGizmo();
        directionStatus.textContent = 'Drag to set target, release to confirm';
        lightingDraggingHandle = 'target'; // Now dragging the target
        lightingPointerId = event.pointerId;
        event.target.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      }
    }
  });

  // Pointer move - update hover or drag gizmo
  canvas.addEventListener('pointermove', (event) => {
    if (!lightingPanelOpen) return;

    // If dragging a handle, update its position
    if (lightingDraggingHandle) {
      if (lightingPointerId !== null && event.pointerId !== lightingPointerId) return;

      const hit = raycastRoomSurface(event);
      if (hit) {
        if (lightingDraggingHandle === 'source') {
          setLightPosition(hit.point);
        } else if (lightingDraggingHandle === 'target') {
          setLightTargetPosition(hit.point);
        }
      }
      return;
    }

    // Update hover state on gizmo handles (only when not in direction mode)
    // Skip hover feedback on touch devices (no hover concept)
    if (!lightingDirectionMode && event.pointerType !== 'touch') {
      const gizmoHit = raycastLightingGizmo(event);
      if (gizmoHit) {
        setLightingGizmoHover(gizmoHit.type);
        canvas.style.cursor = 'grab';
      } else {
        setLightingGizmoHover(null);
        canvas.style.cursor = '';
      }
    }
  });

  // Pointer up - finish dragging
  canvas.addEventListener('pointerup', (event) => {
    if (!lightingPanelOpen) return;
    if (lightingPointerId !== null && event.pointerId !== lightingPointerId) return;

    if (lightingDraggingHandle) {
      // Release pointer capture
      if (event.target.hasPointerCapture && event.target.hasPointerCapture(event.pointerId)) {
        event.target.releasePointerCapture(event.pointerId);
      }

      // Finish dragging
      const hit = raycastRoomSurface(event);
      if (hit) {
        if (lightingDraggingHandle === 'source') {
          setLightPosition(hit.point);
        } else if (lightingDraggingHandle === 'target') {
          setLightTargetPosition(hit.point);
        }
      }

      // If we were in direction mode, we've now completed creating the new direction
      if (lightingDirectionMode) {
        console.log('Light direction set:', {
          source: getLightPosition().toArray().map(v => v.toFixed(2)),
          target: getLightTarget().toArray().map(v => v.toFixed(2))
        });
        // Clear direction mode but keep the new settings (don't restore backup)
        lightingDirectionMode = false;
        lightingBackup = null;
        directionBtn.classList.remove('active');
        directionBtn.textContent = 'Set Direction';
        directionStatus.textContent = '';
      }

      lightingDraggingHandle = null;
      lightingPointerId = null;
      canvas.style.cursor = '';
      setLightingGizmoHover(null);
    }
  });

  // Pointer cancel - handle interruptions
  canvas.addEventListener('pointercancel', (event) => {
    if (lightingPointerId !== null && event.pointerId !== lightingPointerId) return;

    if (event.target.hasPointerCapture && event.target.hasPointerCapture(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId);
    }

    lightingDraggingHandle = null;
    lightingPointerId = null;
    canvas.style.cursor = '';
    setLightingGizmoHover(null);
  });

  // Escape key cancels direction mode
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lightingDirectionMode) {
      if (lightingBackup) {
        applyLightingSettings(lightingBackup);
        updateLightingGizmo();
      }
      cancelLightingDirectionMode();
      lightingDraggingHandle = null;
    }
  });
}

// ============ Room Layouts ============

let layoutsPanelOpen = false;
let pendingLayoutLoad = null;
const MAX_LAYOUTS_PER_ROOM = 10;

function setupLayoutControls() {
  const layoutsBtn = document.getElementById('layouts-btn');
  const layoutsCloseBtn = document.getElementById('layouts-close-btn');
  const saveLayoutBtn = document.getElementById('save-layout-btn');

  layoutsBtn.addEventListener('click', () => {
    layoutsPanelOpen ? closeLayoutsPanel() : openLayoutsPanel();
  });

  layoutsCloseBtn.addEventListener('click', closeLayoutsPanel);
  saveLayoutBtn.addEventListener('click', startSaveLayout);

  document.getElementById('layout-name-cancel').addEventListener('click', () => {
    modalManager.closeModal();
  });
  document.getElementById('layout-name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    confirmSaveLayout();
  });

  document.getElementById('layout-replace-cancel').addEventListener('click', () => {
    pendingLayoutLoad = null;
    modalManager.closeModal();
  });
  document.getElementById('layout-replace-confirm').addEventListener('click', () => {
    modalManager.closeModal();
    if (pendingLayoutLoad) {
      applyLayout(pendingLayoutLoad);
      pendingLayoutLoad = null;
    }
  });

  document.getElementById('layout-missing-ok').addEventListener('click', () => {
    modalManager.closeModal();
  });
}

function openLayoutsPanel() {
  closeLightingPanelIfOpen();
  closeScalePanelIfOpen();
  closeLayoutsPanelIfOpen();
  closeWallColorPanelIfOpen();
  layoutsPanelOpen = true;
  document.getElementById('layouts-panel').classList.remove('hidden');
  document.getElementById('layouts-btn').classList.add('active');
  renderLayoutCards();
}

function closeLayoutsPanel() {
  layoutsPanelOpen = false;
  document.getElementById('layouts-panel').classList.add('hidden');
  document.getElementById('layouts-btn').classList.remove('active');
}

function closeLayoutsPanelIfOpen() {
  if (layoutsPanelOpen) closeLayoutsPanel();
}

async function renderLayoutCards() {
  const container = document.getElementById('layouts-container');
  const countEl = document.getElementById('layouts-count');
  const saveBtn = document.getElementById('save-layout-btn');

  if (!currentRoomId) {
    container.innerHTML = '<div class="layouts-empty">No room loaded</div>';
    countEl.textContent = '';
    return;
  }

  try {
    const layouts = await getLayouts(currentRoomId);
    countEl.textContent = `(${layouts.length}/${MAX_LAYOUTS_PER_ROOM})`;
    saveBtn.disabled = layouts.length >= MAX_LAYOUTS_PER_ROOM;

    if (layouts.length === 0) {
      container.innerHTML = '<div class="layouts-empty">No saved layouts</div>';
      return;
    }

    container.innerHTML = '';
    layouts.forEach(layout => {
      const card = document.createElement('div');
      card.className = 'layout-card';
      card.innerHTML = `
        ${layout.screenshotUrl
          ? `<img class="layout-card-thumbnail" src="${layout.screenshotUrl}" alt="${layout.name}" />`
          : `<div class="layout-card-thumbnail"></div>`
        }
        <div class="layout-card-name" title="${layout.name}">${layout.name}</div>
        <button class="layout-card-delete" title="Delete layout">&times;</button>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.layout-card-delete')) return;
        loadLayoutFromCard(layout);
      });

      card.querySelector('.layout-card-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        showConfirmDialog(`Delete layout "${layout.name}"?`, async () => {
          modalManager.closeModal();
          try {
            await deleteLayout(currentRoomId, layout.id);
            showActionNotification('Layout deleted');
            renderLayoutCards();
          } catch (err) {
            showActionNotification('Failed to delete layout');
          }
        });
      });

      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = '<div class="layouts-empty">Failed to load layouts</div>';
  }
}

function startSaveLayout() {
  const input = document.getElementById('layout-name-input');
  input.value = '';
  modalManager.openModal('layout-name-modal');
  setTimeout(() => input.focus(), 100);
}

async function confirmSaveLayout() {
  const input = document.getElementById('layout-name-input');
  const name = input.value.trim();
  if (!name) return;

  modalManager.closeModal();
  showActionNotification('Saving layout...');

  try {
    const placedFurniture = collectPlacedFurniture();
    const base64Screenshot = await captureThumbnail(
      getRenderer(), getScene(), getCamera()
    );
    await createLayout(currentRoomId, name, placedFurniture, base64Screenshot);
    showActionNotification('Layout saved');
    renderLayoutCards();
  } catch (err) {
    showActionNotification('Failed to save layout');
  }
}

function loadLayoutFromCard(layout) {
  const currentFurniture = collectPlacedFurniture();
  if (currentFurniture.length > 0) {
    pendingLayoutLoad = layout;
    modalManager.openModal('layout-replace-modal');
    return;
  }
  applyLayout(layout);
}

async function applyLayout(layout) {
  closeLayoutsPanelIfOpen();
  showActionNotification('Loading layout...');

  try {
    let layoutData = layout;
    if (!layoutData.placedFurniture || layoutData.placedFurniture.length === 0) {
      layoutData = await getLayout(currentRoomId, layout.id);
    }

    // Remember meter stick state before clearing
    const meterStick = getMeterStick();
    const hadMeterStick = !!meterStick;
    const hadSavedMeterStickData = !!savedMeterStickData;
    let meterStickState = null;
    if (hadMeterStick) {
      meterStickState = {
        position: { x: meterStick.position.x, y: meterStick.position.y, z: meterStick.position.z },
        rotation: { x: meterStick.rotation.x, y: meterStick.rotation.y, z: meterStick.rotation.z },
        visible: isMeterStickVisible(),
        surfaceNormal: meterStick.userData.surfaceNormal ? {
          x: meterStick.userData.surfaceNormal.x,
          y: meterStick.userData.surfaceNormal.y,
          z: meterStick.userData.surfaceNormal.z
        } : null,
        contactAxis: meterStick.userData.contactAxis ? {
          x: meterStick.userData.contactAxis.x,
          y: meterStick.userData.contactAxis.y,
          z: meterStick.userData.contactAxis.z
        } : null
      };
    }

    clearAllFurniture();

    // Restore meter stick (either from scene or from deferred saved data)
    if (hadMeterStick && meterStickState) {
      restoreMeterStickFromData(meterStickState);
      if (!meterStickState.visible) {
        setMeterStickVisible(false);
      }
    }

    const missingItems = [];
    const loadedModels = [];
    for (const furniture of layoutData.placedFurniture) {
      try {
        const entry = await getFurnitureEntry(furniture.entryId);
        if (!entry || !entry.model) {
          missingItems.push({ name: entry?.name || furniture.entryId, reason: 'No 3D model' });
          loadedModels.push(null);
          continue;
        }

        const extractedData = await extractModelFromZip(entry.model);
        const model = await loadModelFromExtractedZip(extractedData);
        model.position.set(furniture.position.x, furniture.position.y, furniture.position.z);
        model.rotation.set(furniture.rotation.x, furniture.rotation.y, furniture.rotation.z);

        if (typeof furniture.scale === 'number') {
          model.scale.setScalar(furniture.scale);
        } else if (furniture.scale && typeof furniture.scale === 'object') {
          model.scale.set(furniture.scale.x, furniture.scale.y, furniture.scale.z);
        }

        if (furniture.surfaceNormal) {
          model.userData.surfaceNormal = new THREE.Vector3(
            furniture.surfaceNormal.x, furniture.surfaceNormal.y, furniture.surfaceNormal.z
          );
        }
        if (furniture.contactAxis) {
          model.userData.contactAxis = new THREE.Vector3(
            furniture.contactAxis.x, furniture.contactAxis.y, furniture.contactAxis.z
          );
        }
        if (typeof furniture.uprightRotation === 'number') {
          model.userData.uprightRotation = furniture.uprightRotation;
        }
        if (typeof furniture.rotationAroundNormal === 'number') {
          model.userData.rotationAroundNormal = furniture.rotationAroundNormal;
        }
        if (furniture.baseScale) {
          model.userData.baseScale = new THREE.Vector3(
            furniture.baseScale.x, furniture.baseScale.y, furniture.baseScale.z
          );
        }

        addFurnitureToScene(model, furniture.entryId);
        loadedModels.push(model);
      } catch (err) {
        missingItems.push({ name: furniture.entryId, reason: err.message });
        loadedModels.push(null);
      }
    }

    // Link parent-child relationships
    for (let i = 0; i < layoutData.placedFurniture.length; i++) {
      const data = layoutData.placedFurniture[i];
      const model = loadedModels[i];
      if (!model || data.parentIndex == null) continue;

      const parent = loadedModels[data.parentIndex];
      if (!parent) continue;

      model.userData.isChild = true;
      model.userData.parentId = parent.uuid;
      model.userData.localOffset = data.localOffset
        ? new THREE.Vector3(data.localOffset.x, data.localOffset.y, data.localOffset.z)
        : new THREE.Vector3(0, 0, 0);
      model.userData.localRotationY = data.localRotationY || 0;

      if (!parent.userData.childIds) parent.userData.childIds = [];
      parent.userData.childIds.push(model.uuid);
    }

    applyRoomScaleToAllFurniture();

    if (missingItems.length > 0) {
      const list = document.getElementById('layout-missing-list');
      list.innerHTML = missingItems.map(m => `<li>${m.name} — ${m.reason}</li>`).join('');
      modalManager.openModal('layout-missing-modal');
    }

    showActionNotification('Layout loaded');
  } catch (err) {
    showActionNotification('Failed to load layout');
  }
}

// ============ Room Scale Controls ============

let scalePanelOpen = false;

function setupScaleControls() {
  const scaleBtn = document.getElementById('scale-btn');
  const scalePanel = document.getElementById('scale-panel');
  const scaleCloseBtn = document.getElementById('scale-close-btn');
  const scaleSlider = document.getElementById('room-scale-slider');
  const scaleValue = document.getElementById('room-scale-value');

  if (!scaleBtn || !scalePanel) {
    console.warn('Scale panel elements not found');
    return;
  }

  // Toggle panel visibility
  scaleBtn.addEventListener('click', () => {
    if (scalePanelOpen) {
      closeScalePanel();
    } else {
      openScalePanel();
    }
  });

  function openScalePanel() {
    // Close other panels if open (only one can be open at a time)
    closeLightingPanelIfOpen();
    closeLayoutsPanelIfOpen();
    closeWallColorPanelIfOpen();

    scalePanelOpen = true;
    scalePanel.classList.remove('hidden');
    scaleBtn.classList.add('active');
    updateScaleUI();
  }

  function closeScalePanel() {
    scalePanelOpen = false;
    scalePanel.classList.add('hidden');
    scaleBtn.classList.remove('active');
  }

  // Close button
  scaleCloseBtn.addEventListener('click', closeScalePanel);

  // Scale slider
  scaleSlider.addEventListener('input', () => {
    const scale = parseFloat(scaleSlider.value);
    setRoomScale(scale);
    scaleValue.textContent = scale.toFixed(2) + 'x';
  });

  function updateScaleUI() {
    const scale = getRoomScale();
    scaleSlider.value = scale;
    scaleValue.textContent = scale.toFixed(2) + 'x';
  }
}

// Close scale panel programmatically (called when switching rooms)
function closeScalePanelIfOpen() {
  if (scalePanelOpen) {
    const scalePanel = document.getElementById('scale-panel');
    const scaleBtn = document.getElementById('scale-btn');
    scalePanelOpen = false;
    if (scalePanel) scalePanel.classList.add('hidden');
    if (scaleBtn) scaleBtn.classList.remove('active');
  }
}

// Update scale UI from current room scale (called when loading room)
function updateScaleUIFromRoom() {
  const scaleSlider = document.getElementById('room-scale-slider');
  const scaleValue = document.getElementById('room-scale-value');
  if (scaleSlider && scaleValue) {
    const scale = getRoomScale();
    scaleSlider.value = scale;
    scaleValue.textContent = scale.toFixed(2) + 'x';
  }
}

// ============ Before/After Toggle ============

let furnitureVisible = true;

function setupBeforeAfterToggle() {
  const btn = document.getElementById('before-after-btn');
  if (!btn) {
    console.warn('Before/after button not found');
    return;
  }

  btn.addEventListener('click', () => {
    furnitureVisible = !furnitureVisible;
    setFurnitureVisible(furnitureVisible);
    btn.classList.toggle('active', !furnitureVisible);
  });
}

// Reset furniture visibility when loading a new house (session-scoped)
function resetFurnitureVisibility() {
  furnitureVisible = true;
  setFurnitureVisible(true);
  const btn = document.getElementById('before-after-btn');
  if (btn) btn.classList.remove('active');
}

// ============ File Input Setup ============

function setupFileInputs() {
  const imageFileInput = document.getElementById('image-file-input');
  const migrateRoomsBtn = document.getElementById('migrate-rooms-btn');

  // Image file input for adding rooms
  imageFileInput.addEventListener('change', handleRoomImageUpload);

  // Legacy migration button
  if (migrateRoomsBtn) {
    migrateRoomsBtn.addEventListener('click', () => {
      showError('Legacy room migration not yet implemented. Please create a new house and re-upload room images.');
    });
  }
}

function setupClearFurnitureModal() {
  document.getElementById('clear-furniture-yes').addEventListener('click', async () => {
    pendingClearFurniture = true;
    pendingFloorHint = document.getElementById('clear-floor-hint').value.trim();
    modalManager.closeModal('clear-furniture-modal');
    await processRoomAutomatically();
  });

  document.getElementById('clear-furniture-no').addEventListener('click', async () => {
    pendingClearFurniture = false;
    pendingFloorHint = '';
    pendingFloorHint = '';
    modalManager.closeModal('clear-furniture-modal');
    await processRoomAutomatically();
  });
}

function setBackgroundImage(blob, bringToFront = false) {
  const container = document.getElementById('background-container');
  const url = URL.createObjectURL(blob);
  container.style.backgroundImage = `url(${url})`;

  // Bring background above canvas during processing (but below modals)
  if (bringToFront) {
    container.style.zIndex = '2';
  }
}

function resetBackgroundZIndex() {
  const container = document.getElementById('background-container');
  container.style.zIndex = '0';
}

// Get image aspect ratio from blob
function getImageAspectRatio(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.width / img.height);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

// Controls bar responsive layout — switches to 2-row grid when buttons overflow
function setupControlsBarLayout() {
  const bar = document.getElementById('controls-bar');
  const left = bar.querySelector('.controls-left');

  function update() {
    if (bar.classList.contains('hidden')) return;

    // Measure in single-row mode
    bar.classList.remove('two-row');

    if (bar.scrollWidth > bar.clientWidth + 1) {
      const cols = Math.ceil(left.children.length / 2);
      bar.style.setProperty('--controls-cols', cols);
      bar.classList.add('two-row');
    }

    // Set panel offset from measured bar height
    const barRect = bar.getBoundingClientRect();
    const bottomOffset = window.innerHeight - barRect.top;
    document.documentElement.style.setProperty('--above-controls', bottomOffset + 'px');
  }

  new ResizeObserver(update).observe(bar);
}

// Show the 3D scene and UI controls
function showScene() {
  document.getElementById('canvas-container').classList.remove('hidden');
  document.getElementById('controls-bar').classList.remove('hidden');
}

// Hide the 3D scene and UI controls
function hideScene() {
  document.getElementById('canvas-container').classList.add('hidden');
  document.getElementById('controls-bar').classList.add('hidden');
  hideTabBar();
}

// Show tab bar
function showTabBar() {
  document.getElementById('room-tab-bar').classList.remove('hidden');
}

// Hide tab bar
function hideTabBar() {
  document.getElementById('room-tab-bar').classList.add('hidden');
}

// ============ Orientation Modal ============

// Flag to track if room processing is in progress (prevents cancel during processing)
let roomProcessingInProgress = false;

function setupOrientationModal() {
  const modal = document.getElementById('orientation-modal');

  // Handle clicking outside modal to cancel (only if not processing)
  modal.addEventListener('click', (event) => {
    if (event.target === modal && !roomProcessingInProgress) {
      cancelRoomCreationFlow();
    }
  });
}

// Reset orientation modal state when opening
function resetOrientationModal() {
  const applyBtn = document.getElementById('apply-orientation-btn');
  const defaultInfo = document.getElementById('orientation-default-info');
  const loadingEl = document.getElementById('orientation-loading');
  const resultEl = document.getElementById('orientation-result');
  const errorEl = document.getElementById('orientation-error');

  defaultInfo.classList.remove('hidden');
  loadingEl.classList.add('hidden');
  resultEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  applyBtn.textContent = 'Analyze Room';
  applyBtn.disabled = false;
}

/**
 * Automatic room processing flow - server handles MoGe-2 via Modal.
 * Waits for server to complete mesh generation (30-60 seconds).
 */
async function processRoomAutomatically() {
  if (!pendingRoomImage || !pendingRoomName || !currentHouseId) {
    showError('Missing room data. Please try again.');
    return;
  }

  // Prevent cancellation during processing
  roomProcessingInProgress = true;

  // Use orientation modal as progress display
  const applyBtn = document.getElementById('apply-orientation-btn');
  const defaultInfo = document.getElementById('orientation-default-info');
  const loadingEl = document.getElementById('orientation-loading');
  const loadingText = document.getElementById('orientation-loading-text');
  const resultEl = document.getElementById('orientation-result');
  const fovInfo = document.getElementById('orientation-fov-info');
  const errorEl = document.getElementById('orientation-error');

  // Reset and show loading state
  defaultInfo.classList.add('hidden');
  resultEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  applyBtn.classList.add('hidden');
  loadingText.textContent = pendingClearFurniture
    ? 'Clearing furniture and analyzing geometry (60-90 seconds)...'
    : 'Creating room and analyzing geometry (30-60 seconds)...';

  modalManager.openModal('orientation-modal');

  try {
    // Create room - server waits for Modal mesh generation (and optional Gemini clearing)
    const room = await createRoom(currentHouseId, pendingRoomName, pendingRoomImage, pendingClearFurniture, pendingFloorHint);
    console.log('Room created:', room);

    // Load mesh into scene
    loadingText.textContent = 'Loading room mesh...';

    const meshUrl = adjustUrlForProxy(room.mogeData.meshUrl);
    await loadRoomGeometry(meshUrl, {
      wireframeColor: 0x00ff00,
      wireframeOpacity: 0.5
    });

    // Set camera alignment
    const fov = room.mogeData.cameraFov || 60;
    const imageAspect = room.mogeData.imageAspect;
    setCameraForMoGeAlignment(fov, imageAspect);

    // Set up background plane
    loadingText.textContent = 'Setting up background...';
    const bounds = getRoomBounds();
    const backgroundDepth = Math.abs(bounds.min.z) + 1;
    const bgResponse = await fetch(adjustUrlForProxy(room.backgroundImageUrl), { cache: 'no-store' });
    if (!bgResponse.ok) throw new Error('Failed to fetch background image');
    const backgroundBlob = await bgResponse.blob();
    await setBackgroundImagePlane(backgroundBlob, backgroundDepth);

    // Clear CSS background since we use 3D plane
    document.getElementById('background-container').style.backgroundImage = '';
    resetBackgroundZIndex();

    console.log('Room geometry loaded and camera aligned');

    // Show success
    loadingEl.classList.add('hidden');
    resultEl.classList.remove('hidden');
    fovInfo.textContent = `FOV: ${fov.toFixed(1)}°`;

    // Set as current room
    currentRoomId = room.id;
    currentRoom = room;
    currentBackgroundImage = pendingRoomImage;

    // Clear pending state
    pendingRoomImage = null;
    pendingRoomName = null;
    pendingClearFurniture = false;
    pendingFloorHint = '';

    // Clear any existing furniture
    clearAllFurniture();
    undoManager.clear();

    // Brief pause to show success
    await new Promise(resolve => setTimeout(resolve, 800));

    // Transition to room workspace
    setCurrentLoadedHouse(currentHouseId);
    resetFurnitureVisibility();
    await updateSavedHash();
    startAutosave();
    showScene();
    await renderTabBar();
    modalManager.closeAllModals();

    // Restore button visibility for future use
    applyBtn.classList.remove('hidden');
    roomProcessingInProgress = false;

  } catch (err) {
    console.error('Room creation failed:', err);

    // Show error
    loadingEl.classList.add('hidden');
    resultEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    document.getElementById('orientation-error-text').textContent =
      `Room creation failed: ${err.message}`;

    // Pause to show error
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Cancel the room creation flow
    applyBtn.classList.remove('hidden');
    roomProcessingInProgress = false;
    await cancelRoomCreationFlow();
  }
}

// Cancel room creation flow
async function cancelRoomCreationFlow() {
  // Clear pending state
  pendingRoomImage = null;
  pendingRoomName = null;
  pendingClearFurniture = false;

  modalManager.closeAllModals();
  resetBackgroundZIndex();

  if (!currentRoomId) {
    // No room loaded yet (initial stage) - return to calendar modal
    document.getElementById('canvas-container').classList.add('hidden');
    document.getElementById('background-container').style.backgroundImage = '';
    await openCalendarModal();
  } else {
    // Room already loaded (adding additional room) - restore current room's background
    if (currentBackgroundImage) {
      setBackgroundImage(currentBackgroundImage);
    }
  }
}

// ============ Furniture Modal ============

// Action ID to prevent duplicate renders from rapid open/close
let furnitureModalActionId = 0;

function setupFurnitureModal() {
  const searchInput = document.getElementById('furniture-search');
  const categorySelect = document.getElementById('category-select');
  const addEntryBtn = document.getElementById('add-entry-btn');

  // Initialize tags dropdown
  tagsDropdown = new MultiSelectTags('tags-dropdown-container', onTagsFilterChange);

  // Search input with debounce
  searchInput.addEventListener('input', debounce(filterFurnitureGrid, 200));

  // Category filter
  categorySelect.addEventListener('change', filterFurnitureGrid);

  // Add entry button
  addEntryBtn.addEventListener('click', () => {
    openEntryEditor(null);
  });
}

function openFurnitureModal() {
  // Increment action ID to invalidate any in-flight requests from previous opens
  furnitureModalActionId++;
  refreshFurnitureModal();
  modalManager.openModal('furniture-modal');
}

async function refreshFurnitureModal() {
  await updateCategorySelect();
  await updateTagsDropdown();
  await loadDestagingBufferUI();
  await renderFurnitureGrid();
}

async function loadDestagingBufferUI() {
  const input = document.getElementById('destaging-buffer-input');

  if (!input._listenerAttached) {
    input.addEventListener('change', async () => {
      const days = parseInt(input.value, 10);
      if (isNaN(days) || days < 0) return;
      try {
        await saveDestagingBuffer(days);
        invalidateCache('availability');
        await renderFurnitureGrid();
      } catch (err) {
        console.error('Failed to save destaging buffer:', err);
      }
    });
    input._listenerAttached = true;
  }

  try {
    const days = await getDestagingBuffer();
    input.value = days;
  } catch (err) {
    input.value = 0;
  }
}

async function updateCategorySelect() {
  const select = document.getElementById('category-select');
  const categories = await getAllCategories();

  select.innerHTML = '<option value="">All Categories</option>';
  categories.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat;
    option.textContent = cat;
    select.appendChild(option);
  });
}

async function updateTagsDropdown() {
  const tags = await getAllTags();
  tagsDropdown.setTags(tags);
}

function onTagsFilterChange(selectedTags) {
  filterFurnitureGrid();
}

async function renderFurnitureGrid() {
  const grid = document.getElementById('furniture-grid');

  // Capture action ID at start to detect stale requests
  const actionId = furnitureModalActionId;

  // Get furniture metadata only (no blob downloads yet)
  const furniture = await getAllFurniture({ includeImages: false, includePreview3d: false });

  // Check if this request is stale (modal was closed/reopened)
  if (actionId !== furnitureModalActionId) return;

  grid.innerHTML = '';

  if (furniture.length === 0) {
    grid.innerHTML = '<p class="no-results">No furniture entries. Click "Add Entry" to create one.</p>';
    return;
  }

  // Get all entry IDs for batch availability
  const entryIds = furniture.map(item => item.id);

  // Get placed counts for current scene
  const placedCounts = {};
  for (const id of entryIds) {
    placedCounts[id] = getPlacedCountForEntry(id);
  }

  // Batch fetch availability (single API call instead of N calls)
  const currentHouse = getCurrentHouse();
  const availabilityMap = await getBatchAvailability(
    entryIds,
    currentHouse?.id || null,
    currentRoomId,
    placedCounts
  );

  // Check again after async operation
  if (actionId !== furnitureModalActionId) return;

  // Render cards with availability from batch result
  for (const item of furniture) {
    const availability = availabilityMap[item.id] || { available: 0, total: item.quantity || 1 };
    const card = await createFurnitureCard(item, availability);
    grid.appendChild(card);
  }
}

async function filterFurnitureGrid() {
  // Capture action ID at start to detect stale requests
  const actionId = furnitureModalActionId;

  const searchTerm = document.getElementById('furniture-search').value.toLowerCase().trim();
  const category = document.getElementById('category-select').value;
  const selectedTags = tagsDropdown.getSelectedTags();

  // Use cached furniture list (no new fetch if cache is valid)
  let furniture = await getAllFurniture({ includeImages: false, includePreview3d: false });

  // Check if this request is stale (modal was closed/reopened)
  if (actionId !== furnitureModalActionId) return;

  // Client-side filtering
  if (searchTerm) {
    furniture = furniture.filter(item => {
      if (item.name.toLowerCase().includes(searchTerm)) return true;
      if (item.tags && item.tags.some(tag => tag.toLowerCase().includes(searchTerm))) return true;
      if (item.category && item.category.toLowerCase().includes(searchTerm)) return true;
      return false;
    });
  }

  if (category) {
    furniture = furniture.filter(item => item.category === category);
  }

  if (selectedTags.length > 0) {
    furniture = furniture.filter(item => {
      if (!item.tags) return false;
      return selectedTags.some(tag => item.tags.includes(tag));
    });
  }

  // Render filtered results
  const grid = document.getElementById('furniture-grid');
  grid.innerHTML = '';

  if (furniture.length === 0) {
    grid.innerHTML = '<p class="no-results">No matching furniture found.</p>';
    return;
  }

  // Batch availability for filtered items only
  const entryIds = furniture.map(item => item.id);
  const placedCounts = {};
  for (const id of entryIds) {
    placedCounts[id] = getPlacedCountForEntry(id);
  }

  const currentHouse = getCurrentHouse();
  const availabilityMap = await getBatchAvailability(
    entryIds,
    currentHouse?.id || null,
    currentRoomId,
    placedCounts
  );

  // Check again after async operation
  if (actionId !== furnitureModalActionId) return;

  for (const item of furniture) {
    const availability = availabilityMap[item.id] || { available: 0, total: item.quantity || 1 };
    const card = await createFurnitureCard(item, availability);
    grid.appendChild(card);
  }
}

/**
 * Create a furniture card element.
 * @param {Object} item - Furniture entry metadata
 * @param {Object} availability - Pre-calculated availability { available, total }
 */
async function createFurnitureCard(item, availability) {
  const card = document.createElement('div');
  card.className = 'furniture-card';
  card.dataset.id = item.id;

  const { available, total } = availability;
  const isUnavailable = available <= 0;

  if (isUnavailable) {
    card.classList.add('unavailable');
  }

  // Thumbnail container
  const thumbnailContainer = document.createElement('div');
  thumbnailContainer.className = 'card-thumbnail';

  if (item.hasModel) {
    thumbnailContainer.classList.add('has-3d-model');
  }

  // Show placeholder while images load
  thumbnailContainer.innerHTML = '<span class="placeholder loading">Loading...</span>';

  // Load images asynchronously (lazy loading)
  loadCardImages(item.id, thumbnailContainer);

  // Availability badge
  const hasBufferConflicts = availability.conflicts?.some(c => c.type === 'buffer') || false;
  const badge = document.createElement('span');
  badge.className = 'availability-badge'
      + (isUnavailable ? ' unavailable' : '')
      + (!isUnavailable && hasBufferConflicts ? ' warning' : '');
  badge.textContent = `${available}/${total}`;

  // Conflict tooltip
  if (availability.conflicts && availability.conflicts.length > 0) {
    const tooltip = document.createElement('div');
    tooltip.className = 'conflict-tooltip';
    const lines = availability.conflicts.map(c => {
      const dateRange = formatConflictDates(c.startDate, c.endDate);
      const suffix = c.type === 'buffer' ? ' \u2014 may still be there' : '';
      return `${c.count} at "${c.houseName}" (${dateRange})${suffix}`;
    });
    tooltip.innerHTML = lines.join('<br>');
    badge.appendChild(tooltip);
    badge.style.position = 'relative';

    badge.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.availability-badge.tooltip-visible').forEach(b => {
        if (b !== badge) b.classList.remove('tooltip-visible');
      });
      badge.classList.toggle('tooltip-visible');
    });
  }

  thumbnailContainer.appendChild(badge);

  // Name
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name;

  // Category and Tags container
  const metaContainer = document.createElement('div');
  metaContainer.className = 'card-meta';

  // Category (shown first)
  if (item.category) {
    const categorySpan = document.createElement('span');
    categorySpan.className = 'tag category-tag';
    categorySpan.textContent = item.category;
    metaContainer.appendChild(categorySpan);
  }

  // Tags (shown after category)
  if (item.tags && item.tags.length > 0) {
    item.tags.slice(0, 2).forEach(tag => {
      const tagSpan = document.createElement('span');
      tagSpan.className = 'tag';
      tagSpan.textContent = tag;
      metaContainer.appendChild(tagSpan);
    });
    if (item.tags.length > 2) {
      const moreSpan = document.createElement('span');
      moreSpan.className = 'tag';
      moreSpan.textContent = `+${item.tags.length - 2}`;
      metaContainer.appendChild(moreSpan);
    }
  }

  card.appendChild(thumbnailContainer);
  card.appendChild(name);
  card.appendChild(metaContainer);

  // Click handler - show action popup
  card.addEventListener('click', (event) => {
    showEntryActionPopup(item.id, event);
  });

  return card;
}

/**
 * Load images for a card asynchronously.
 * Called after card is rendered for progressive loading.
 */
async function loadCardImages(entryId, container) {
  try {
    // Fetch entry with images (but not model)
    const entry = await getFurnitureEntry(entryId, {
      includeImage: true,
      includePreview3d: false,
      includeModel: false,
    });

    // Remove placeholder
    const placeholder = container.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    if (entry.image) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(entry.image);
      container.insertBefore(img, container.firstChild);
    } else {
      const noImage = document.createElement('span');
      noImage.className = 'placeholder';
      noImage.textContent = 'No Image';
      container.insertBefore(noImage, container.firstChild);
    }
  } catch (err) {
    console.warn('Failed to load card images:', err);
    const placeholder = container.querySelector('.placeholder');
    if (placeholder) {
      placeholder.classList.remove('loading');
      placeholder.textContent = 'Error';
    }
  }
}

// ============ Entry Action Popup ============

function setupEntryActionPopup() {
  const popup = document.getElementById('entry-action-popup');
  const editBtn = document.getElementById('popup-edit-btn');
  const placeBtn = document.getElementById('popup-place-btn');
  const deleteBtn = document.getElementById('popup-delete-btn');

  editBtn.addEventListener('click', () => {
    const entryId = popupEntryId;
    hideEntryActionPopup();
    openEntryEditor(entryId);
  });

  placeBtn.addEventListener('click', async () => {
    const entryId = popupEntryId;
    hideEntryActionPopup();
    await placeEntryInScene(entryId);
  });

  deleteBtn.addEventListener('click', async () => {
    const entryId = popupEntryId;
    hideEntryActionPopup();
    await confirmDeleteEntry(entryId);
  });

  // Close popup when clicking outside
  document.addEventListener('click', (event) => {
    if (!popup.contains(event.target) && !event.target.closest('.furniture-card')) {
      hideEntryActionPopup();
    }
  });
}

async function showEntryActionPopup(entryId, event) {
  popupEntryId = entryId;

  // Get entry metadata only (no model blob needed for popup)
  const entry = await getFurnitureEntry(entryId, { metadataOnly: true });
  const hasModel = entry && entry.hasModel;

  const placedInScene = getPlacedCountForEntry(entryId);

  // Use batch availability (will hit cache if recently fetched)
  const currentHouse = getCurrentHouse();
  const availabilityMap = await getBatchAvailability(
    [entryId],
    currentHouse?.id || null,
    currentRoomId,
    { [entryId]: placedInScene }
  );
  const { available } = availabilityMap[entryId] || { available: 0 };

  const placeBtn = document.getElementById('popup-place-btn');
  if (hasModel && available > 0) {
    placeBtn.style.display = 'block';
    placeBtn.disabled = false;
    placeBtn.classList.remove('disabled');
    placeBtn.title = '';
  } else if (hasModel) {
    placeBtn.style.display = 'block';
    placeBtn.disabled = true;
    placeBtn.classList.add('disabled');
    placeBtn.title = 'No available stock';
  } else {
    placeBtn.style.display = 'none';
  }

  showPopupAt('entry-action-popup', event.clientX, event.clientY);
  event.stopPropagation();
}

function hideEntryActionPopup() {
  hidePopup('entry-action-popup');
  popupEntryId = null;
}

async function placeEntryInScene(entryId) {
  try {
    // Check availability first (uses cache)
    const placedInScene = getPlacedCountForEntry(entryId);
    const currentHouse = getCurrentHouse();
    const availabilityMap = await getBatchAvailability(
      [entryId],
      currentHouse?.id || null,
      currentRoomId,
      { [entryId]: placedInScene }
    );
    const { available } = availabilityMap[entryId] || { available: 0 };

    if (available <= 0) {
      showError('This item is not available. All stock is in use.');
      clearPlaceOnTopTarget();
      return;
    }

    // Show immediate feedback
    showActionNotification('Placing furniture...');

    // Check if placing on top of another piece
    const parentTarget = getPlaceOnTopTarget();
    if (parentTarget) {
      await placeChildFurniture(parentTarget, entryId);
      clearPlaceOnTopTarget();
    } else {
      const position = getLastClickPosition();
      await placeFurniture(entryId, position);
    }

    // Close furniture modal after placing
    modalManager.closeModal();
  } catch (err) {
    showError('Failed to place furniture: ' + err.message);
    clearPlaceOnTopTarget();
  }
}

async function confirmDeleteEntry(entryId) {
  const entry = await getFurnitureEntry(entryId);
  if (!entry) return;

  showConfirmDialog(
    `Are you sure you want to delete "${entry.name}"? This will also remove all placed instances.`,
    async () => {
      showActionNotification('Deleting entry...');
      await deleteFurnitureEntry(entryId);
      removeAllFurnitureByEntryId(entryId);
      modalManager.closeModal();
      await refreshFurnitureModal();
    }
  );
}

// ============ Entry Editor ============

function setupEntryEditor() {
  const form = document.getElementById('entry-form');
  const cancelBtn = document.getElementById('cancel-entry-btn');
  const uploadImageBtn = document.getElementById('upload-image-entry-btn');
  const uploadModelBtn = document.getElementById('upload-model-btn');
  const imageInput = document.getElementById('entry-image-input');
  const modelInput = document.getElementById('entry-model-input');
  const tagInput = document.getElementById('entry-tag-input');
  const categoryInput = document.getElementById('entry-category');
  const generateBtn = document.getElementById('generate-model-btn');

  form.addEventListener('submit', handleEntrySubmit);
  cancelBtn.addEventListener('click', closeEntryEditor);

  uploadImageBtn.addEventListener('click', () => imageInput.click());
  uploadModelBtn.addEventListener('click', () => modelInput.click());

  imageInput.addEventListener('change', handleEntryImageUpload);
  modelInput.addEventListener('change', handleEntryModelUpload);

  // Category input with dropdown
  categoryInput.addEventListener('focus', () => {
    showCategoryDropdown();
  });

  categoryInput.addEventListener('input', () => {
    hideCategoryDropdown();
  });

  categoryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideCategoryDropdown();
      categoryInput.blur();
    }
  });

  // Tag input with dropdown
  const tagDropdown = document.getElementById('tag-dropdown');

  tagInput.addEventListener('focus', () => {
    showTagDropdown();
  });

  tagInput.addEventListener('input', () => {
    filterTagDropdown(tagInput.value.trim());
  });

  tagInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = tagInput.value.trim();
      if (value) {
        addTag(value);
        tagInput.value = '';
        filterTagDropdown('');
      }
    } else if (event.key === 'Escape') {
      hideTagDropdown();
      tagInput.blur();
    }
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (event) => {
    const tagsContainer = document.getElementById('entry-tags-container');
    if (tagsContainer && !tagsContainer.contains(event.target)) {
      hideTagDropdown();
    }
    const categoryContainer = document.getElementById('entry-category-container');
    if (categoryContainer && !categoryContainer.contains(event.target)) {
      hideCategoryDropdown();
    }
  });

  // Generate model button - starts Meshy.ai background generation (server-side)
  generateBtn.addEventListener('click', async () => {
    if (!entryImageBlob) {
      showError('Please upload an image first');
      return;
    }
    if (entryModelBlob) {
      showError('A 3D model already exists for this entry');
      return;
    }

    // Auto-save new entry before generating
    if (!editingEntryId) {
      const nameInput = document.getElementById('entry-name');
      const name = nameInput.value.trim();
      if (!name) {
        showError('Please enter a name before generating');
        return;
      }
      if (!validateDimensions()) {
        showError('Enter one dimension (scale reference) or all three (exact size)');
        return;
      }

      showActionNotification('Saving entry...');
      try {
        const dimXVal = document.getElementById('entry-dimension-x').value.trim();
        const dimYVal = document.getElementById('entry-dimension-y').value.trim();
        const dimZVal = document.getElementById('entry-dimension-z').value.trim();
        const quantity = parseInt(document.getElementById('entry-quantity').value, 10) || 1;
        const categoryInput = document.getElementById('entry-category');

        const entry = {
          id: null,
          name: name,
          category: categoryInput.value.trim() || null,
          tags: entryTags.length > 0 ? entryTags : null,
          image: entryImageBlob,
          model: null,
          quantity: Math.max(1, quantity),
          dimensionX: dimXVal !== '' ? parseFloat(dimXVal) : null,
          dimensionY: dimYVal !== '' ? parseFloat(dimYVal) : null,
          dimensionZ: dimZVal !== '' ? parseFloat(dimZVal) : null
        };

        const newId = await saveFurnitureEntry(entry);
        await refreshFurnitureModal();

        // Re-open as edit modal and continue to generation
        await openEntryEditor(newId);
      } catch (err) {
        showError(`Failed to save entry: ${err.message}`);
        return;
      }
    }

    // Check if already generating (from server status)
    const existingTask = meshyServerStatus.tasks.find(t =>
      t.furniture_id === editingEntryId && !['completed', 'failed'].includes(t.status)
    );
    if (existingTask) {
      showError('Generation already in progress for this entry');
      return;
    }

    // Check server capacity
    if (meshyServerStatus.active >= meshyServerStatus.max) {
      showError(`Server at maximum capacity (${meshyServerStatus.max} concurrent tasks). Please wait.`);
      return;
    }

    // Show immediate feedback
    showActionNotification('Starting 3D generation...');

    try {
      const genToken = getToken();
      const genHeaders = genToken ? { 'Authorization': `Bearer ${genToken}` } : {};
      const response = await fetch(adjustUrlForProxy(`/api/meshy/generate/${editingEntryId}`), {
        method: 'POST',
        headers: genHeaders
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(error.detail || 'Failed to start generation');
      }

      const { task_id } = await response.json();
      myMeshyTasks.add(task_id);

      // Update button
      generateBtn.textContent = 'Generating...';
      generateBtn.disabled = true;

      // Start polling if not already
      startMeshyPolling();

      // Immediately poll to update UI
      await pollMeshyTasks();

    } catch (err) {
      showError(err.message);
    }
  });

  // Dimension inputs validation
  const dimX = document.getElementById('entry-dimension-x');
  const dimY = document.getElementById('entry-dimension-y');
  const dimZ = document.getElementById('entry-dimension-z');

  dimX.addEventListener('input', validateDimensions);
  dimY.addEventListener('input', validateDimensions);
  dimZ.addEventListener('input', validateDimensions);

  // Dimension help button
  const helpBtn = document.getElementById('dimension-help-btn');
  helpBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleDimensionHelpPopup(event);
  });

  // Close help popup when clicking outside
  document.addEventListener('click', (event) => {
    const helpPopup = document.getElementById('dimension-help-popup');
    const helpButton = document.getElementById('dimension-help-btn');
    if (helpPopup && !helpPopup.classList.contains('modal-hidden') &&
        !helpPopup.contains(event.target) && event.target !== helpButton) {
      helpPopup.classList.add('modal-hidden');
    }
  });
}

function validateDimensions() {
  const dimX = document.getElementById('entry-dimension-x');
  const dimY = document.getElementById('entry-dimension-y');
  const dimZ = document.getElementById('entry-dimension-z');
  const errorEl = document.getElementById('dimension-error');

  const x = dimX.value.trim();
  const y = dimY.value.trim();
  const z = dimZ.value.trim();

  const filledCount = [x, y, z].filter(v => v !== '').length;

  // Valid: 0, 1, or 3 filled. Invalid: exactly 2 filled
  const isValid = filledCount !== 2;

  dimX.classList.toggle('invalid', !isValid);
  dimY.classList.toggle('invalid', !isValid);
  dimZ.classList.toggle('invalid', !isValid);
  errorEl.classList.toggle('hidden', isValid);

  return isValid;
}

function toggleDimensionHelpPopup(event) {
  const popup = document.getElementById('dimension-help-popup');

  if (popup.classList.contains('modal-hidden')) {
    // Position near the button
    const rect = event.target.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 8}px`;
    popup.classList.remove('modal-hidden');
  } else {
    popup.classList.add('modal-hidden');
  }
}

async function openEntryEditor(entryId) {
  editingEntryId = entryId;
  entryImageBlob = null;
  entryModelBlob = null;
  entryTags = [];

  const title = document.getElementById('entry-editor-title');
  const nameInput = document.getElementById('entry-name');
  const categoryInput = document.getElementById('entry-category');
  const imagePreview = document.getElementById('image-upload-preview');
  const modelPreview = document.getElementById('model-upload-preview');
  const generateBtn = document.getElementById('generate-model-btn');
  const tagsList = document.getElementById('entry-tags-list');
  const tagInput = document.getElementById('entry-tag-input');
  const tagDropdown = document.getElementById('tag-dropdown');

  // Dimension inputs
  const dimX = document.getElementById('entry-dimension-x');
  const dimY = document.getElementById('entry-dimension-y');
  const dimZ = document.getElementById('entry-dimension-z');
  const dimError = document.getElementById('dimension-error');

  // Quantity input
  const qtyInput = document.getElementById('entry-quantity');

  // Reset form
  nameInput.value = '';
  categoryInput.value = '';
  qtyInput.value = '1';
  imagePreview.innerHTML = '<span>No image</span>';
  modelPreview.innerHTML = '<span>No model</span>';
  generateBtn.style.display = 'none';
  tagsList.innerHTML = '';
  tagInput.value = '';
  dimX.value = '';
  dimY.value = '';
  dimZ.value = '';
  dimX.classList.remove('invalid');
  dimY.classList.remove('invalid');
  dimZ.classList.remove('invalid');
  dimError.classList.add('hidden');
  document.getElementById('entry-location').value = '';
  document.getElementById('entry-condition').value = '';
  document.getElementById('entry-condition-notes').value = '';
  if (tagDropdown) tagDropdown.classList.add('hidden');
  const categoryDropdown = document.getElementById('category-dropdown');
  if (categoryDropdown) categoryDropdown.classList.add('hidden');

  // Update available categories and tags
  await updateAvailableCategories();
  await updateAvailableTags();

  if (entryId) {
    // Editing existing entry
    title.textContent = 'Edit Furniture Entry';
    const entry = await getFurnitureEntry(entryId);
    if (entry) {
      nameInput.value = entry.name || '';
      categoryInput.value = entry.category || '';
      qtyInput.value = entry.quantity || 1;
      document.getElementById('entry-location').value = entry.location || '';
      document.getElementById('entry-condition').value = entry.condition || '';
      document.getElementById('entry-condition-notes').value = entry.conditionNotes || '';

      if (entry.image) {
        entryImageBlob = entry.image;
        showImagePreview(entry.image, imagePreview);
      }

      if (entry.model) {
        entryModelBlob = entry.model;
        modelPreview.innerHTML = '<span style="color: #22c55e;">Model loaded</span>';
      }

      // Show generate button only if: image exists AND no model exists AND not currently generating
      if (entryImageBlob && !entryModelBlob) {
        const isGenerating = meshyServerStatus.tasks.some(t =>
          t.furniture_id === entryId && !['completed', 'failed'].includes(t.status)
        );
        if (isGenerating) {
          generateBtn.style.display = 'block';
          generateBtn.textContent = 'Generating...';
          generateBtn.disabled = true;
        } else {
          generateBtn.style.display = 'block';
          generateBtn.textContent = 'Generate 3D Model';
          generateBtn.disabled = false;
        }
      } else {
        generateBtn.style.display = 'none';
      }

      if (entry.tags) {
        entryTags = [...entry.tags];
        renderEntryTags();
      }

      // Load dimension values
      if (entry.dimensionX !== null && entry.dimensionX !== undefined) {
        dimX.value = entry.dimensionX;
      }
      if (entry.dimensionY !== null && entry.dimensionY !== undefined) {
        dimY.value = entry.dimensionY;
      }
      if (entry.dimensionZ !== null && entry.dimensionZ !== undefined) {
        dimZ.value = entry.dimensionZ;
      }
    }
  } else {
    title.textContent = 'Add Furniture Entry';
  }

  modalManager.openModal('entry-editor-modal');
}

function closeEntryEditor() {
  modalManager.closeModal();
  editingEntryId = null;
  entryImageBlob = null;
  entryModelBlob = null;
  entryTags = [];
}

// Store all available categories for dropdown
let allAvailableCategories = [];

async function updateAvailableCategories() {
  allAvailableCategories = await getAllCategories();
}

function showCategoryDropdown() {
  const dropdown = document.getElementById('category-dropdown');
  if (!dropdown) return;

  dropdown.innerHTML = '';

  if (allAvailableCategories.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tag-dropdown-empty';
    empty.textContent = 'No categories yet';
    dropdown.appendChild(empty);
  } else {
    allAvailableCategories.forEach(category => {
      const item = document.createElement('div');
      item.className = 'tag-dropdown-item';
      item.textContent = category;
      item.addEventListener('click', () => {
        document.getElementById('entry-category').value = category;
        hideCategoryDropdown();
      });
      dropdown.appendChild(item);
    });
  }

  dropdown.classList.remove('hidden');
}

function hideCategoryDropdown() {
  const dropdown = document.getElementById('category-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

// Store all available tags for dropdown
let allAvailableTags = [];

async function updateAvailableTags() {
  allAvailableTags = await getAllTags();
}

function showTagDropdown() {
  const dropdown = document.getElementById('tag-dropdown');
  if (!dropdown) return;
  filterTagDropdown('');
  dropdown.classList.remove('hidden');
}

function hideTagDropdown() {
  const dropdown = document.getElementById('tag-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

function filterTagDropdown(filter) {
  const dropdown = document.getElementById('tag-dropdown');
  if (!dropdown) return;

  // Filter tags that aren't already selected and match the filter
  const availableTags = allAvailableTags.filter(tag =>
    !entryTags.includes(tag) &&
    (filter === '' || tag.toLowerCase().includes(filter.toLowerCase()))
  );

  dropdown.innerHTML = '';

  if (availableTags.length === 0) {
    if (filter && !entryTags.includes(filter)) {
      // Show option to create new tag
      const item = document.createElement('div');
      item.className = 'tag-dropdown-item create-new';
      item.textContent = `Create "${filter}"`;
      item.addEventListener('click', () => {
        addTag(filter);
        document.getElementById('entry-tag-input').value = '';
        filterTagDropdown('');
      });
      dropdown.appendChild(item);
    } else {
      const empty = document.createElement('div');
      empty.className = 'tag-dropdown-empty';
      empty.textContent = 'No tags available';
      dropdown.appendChild(empty);
    }
    return;
  }

  availableTags.forEach(tag => {
    const item = document.createElement('div');
    item.className = 'tag-dropdown-item';
    item.textContent = tag;
    item.addEventListener('click', () => {
      addTag(tag);
      document.getElementById('entry-tag-input').value = '';
      filterTagDropdown('');
    });
    dropdown.appendChild(item);
  });
}

function handleEntryImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showError('Please select an image file');
    return;
  }

  entryImageBlob = file;
  const preview = document.getElementById('image-upload-preview');
  showImagePreview(file, preview);

  // Show generate button
  document.getElementById('generate-model-btn').style.display = 'block';

  event.target.value = '';
}

async function handleEntryModelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.glb')) {
    showError('Please upload a GLB model file');
    return;
  }

  // Store the GLB file
  entryModelBlob = file;

  const preview = document.getElementById('model-upload-preview');
  preview.innerHTML = '<span style="color: #22c55e;">Model loaded</span>';
  // 3D preview will be generated server-side during upload

  event.target.value = '';
}

function showImagePreview(blob, container) {
  container.innerHTML = '';
  const img = document.createElement('img');
  img.src = URL.createObjectURL(blob);
  container.appendChild(img);
}

function addTag(tag) {
  if (!tag || entryTags.includes(tag)) return;
  entryTags.push(tag);
  renderEntryTags();
  filterTagDropdown(document.getElementById('entry-tag-input')?.value || '');
}

function removeTag(tag) {
  entryTags = entryTags.filter(t => t !== tag);
  renderEntryTags();
  filterTagDropdown(document.getElementById('entry-tag-input')?.value || '');
}

function renderEntryTags() {
  const container = document.getElementById('entry-tags-list');
  container.innerHTML = '';

  entryTags.forEach(tag => {
    const tagEl = document.createElement('span');
    tagEl.className = 'entry-tag';
    tagEl.innerHTML = `<span class="entry-tag-text">${tag}</span><span class="entry-tag-remove">&times;</span>`;
    tagEl.addEventListener('click', () => removeTag(tag));
    container.appendChild(tagEl);
  });
}

async function handleEntrySubmit(event) {
  event.preventDefault();

  const nameInput = document.getElementById('entry-name');
  const categoryInput = document.getElementById('entry-category');

  const name = nameInput.value.trim();
  if (!name) {
    showError('Please enter a name');
    return;
  }

  // Validate dimensions
  if (!validateDimensions()) {
    showError('Enter one dimension (scale reference) or all three (exact size)');
    return;
  }

  // Note: 3D preview is auto-generated server-side when model is uploaded

  // Get dimension values
  const dimXVal = document.getElementById('entry-dimension-x').value.trim();
  const dimYVal = document.getElementById('entry-dimension-y').value.trim();
  const dimZVal = document.getElementById('entry-dimension-z').value.trim();

  // Get quantity
  const quantity = parseInt(document.getElementById('entry-quantity').value, 10) || 1;

  const entry = {
    id: editingEntryId || null,
    name: name,
    category: categoryInput.value.trim() || null,
    tags: entryTags.length > 0 ? entryTags : null,
    image: entryImageBlob,
    model: entryModelBlob,
    quantity: Math.max(1, quantity),
    dimensionX: dimXVal !== '' ? parseFloat(dimXVal) : null,
    dimensionY: dimYVal !== '' ? parseFloat(dimYVal) : null,
    dimensionZ: dimZVal !== '' ? parseFloat(dimZVal) : null,
    location: document.getElementById('entry-location').value.trim() || null,
    condition: document.getElementById('entry-condition').value || null,
    conditionNotes: document.getElementById('entry-condition-notes').value.trim() || null
  };

  // Show immediate feedback
  showActionNotification(editingEntryId ? 'Saving entry...' : 'Creating entry...');

  // Close modal immediately for responsiveness
  closeEntryEditor();

  // Save in background
  saveFurnitureEntry(entry)
    .then(() => refreshFurnitureModal())
    .catch(err => showError(`Failed to save entry: ${err.message}`));
}

// ============ Meshy Server Polling ============

function startMeshyPolling() {
  if (meshyPollInterval) return;

  // Poll immediately, then every 5 seconds
  pollMeshyTasks();
  meshyPollInterval = setInterval(pollMeshyTasks, 5000);
}

function stopMeshyPolling() {
  if (meshyPollInterval) {
    clearInterval(meshyPollInterval);
    meshyPollInterval = null;
  }
}

async function pollMeshyTasks() {
  try {
    const token = getToken();
    const meshyHeaders = token ? { 'Authorization': `Bearer ${token}` } : {};
    const response = await fetch(adjustUrlForProxy('/api/meshy/tasks'), { headers: meshyHeaders });
    if (!response.ok) return;

    const data = await response.json();
    const previousTasks = new Map(meshyServerStatus.tasks.map(t => [t.id, t]));
    meshyServerStatus = data;

    // Check for state changes in tasks we care about
    for (const task of data.tasks) {
      if (myMeshyTasks.has(task.id)) {
        const prevTask = previousTasks.get(task.id);

        if (task.status === 'completed' && prevTask?.status !== 'completed') {
          showMeshyToast(task.furniture_name, true, '3D model ready!');
          myMeshyTasks.delete(task.id);

          // Update entry editor if open
          if (editingEntryId === task.furniture_id) {
            const modelPreview = document.getElementById('model-upload-preview');
            const generateBtn = document.getElementById('generate-model-btn');
            if (modelPreview) modelPreview.innerHTML = '<span style="color: #22c55e;">Model generated</span>';
            if (generateBtn) generateBtn.style.display = 'none';
            const entry = await getFurnitureEntry(task.furniture_id);
            if (entry) entryModelBlob = entry.model;
          }

          // Refresh furniture modal
          await refreshFurnitureModal();

        } else if (task.status === 'failed' && prevTask?.status !== 'failed') {
          showMeshyToast(task.furniture_name, false, task.error_message || 'Generation failed');
          myMeshyTasks.delete(task.id);

          // Reset entry editor button if open
          if (editingEntryId === task.furniture_id) {
            const generateBtn = document.getElementById('generate-model-btn');
            if (generateBtn) {
              generateBtn.textContent = 'Generate 3D Model';
              generateBtn.disabled = false;
            }
          }
        }
      }
    }

    // Update tracker UI
    updateMeshyTrackerUI();

    // Stop polling if no active tasks and none we care about
    const hasActiveTasks = data.tasks.some(t => !['completed', 'failed'].includes(t.status));
    if (!hasActiveTasks && myMeshyTasks.size === 0) {
      stopMeshyPolling();
    }

  } catch (err) {
    console.error('Failed to poll Meshy tasks:', err);
  }
}

// ============ Meshy Notification UI ============

function updateMeshyTrackerUI() {
  const tracker = document.getElementById('meshy-task-tracker');
  const list = document.getElementById('meshy-tracker-list');
  const countEl = tracker.querySelector('.meshy-tracker-count');
  const toasts = document.getElementById('meshy-toasts');

  // Filter to only show active tasks (not completed/failed)
  const activeTasks = meshyServerStatus.tasks.filter(t =>
    !['completed', 'failed'].includes(t.status)
  );

  if (activeTasks.length === 0) {
    tracker.classList.add('hidden');
    toasts.classList.remove('with-tracker');
    return;
  }

  tracker.classList.remove('hidden');
  toasts.classList.add('with-tracker');

  // Show capacity: X/10
  countEl.textContent = `${meshyServerStatus.active}/${meshyServerStatus.max}`;

  // Build list HTML
  let html = '';
  for (const task of activeTasks) {
    const statusText = task.status === 'polling' ? `${task.progress}%` : task.status;
    html += `
      <div class="meshy-tracker-item" data-task-id="${task.id}">
        <div class="meshy-tracker-item-header">
          <span class="meshy-tracker-item-name" title="${task.furniture_name}">${task.furniture_name}</span>
          <span class="meshy-tracker-item-status">${statusText}</span>
        </div>
        <div class="meshy-tracker-item-progress">
          <div class="meshy-tracker-item-progress-fill" style="width: ${task.progress}%"></div>
        </div>
      </div>
    `;
  }
  list.innerHTML = html;
}

function showMeshyToast(entryName, success, message) {
  const container = document.getElementById('meshy-toasts');

  const toast = document.createElement('div');
  toast.className = `meshy-toast ${success ? 'success' : 'error'}`;
  toast.innerHTML = `
    <div class="meshy-toast-content">
      <span class="meshy-toast-title">${entryName}</span>
      <span class="meshy-toast-message">${message}</span>
    </div>
    <button class="meshy-toast-close">&times;</button>
  `;

  // Close button handler
  toast.querySelector('.meshy-toast-close').onclick = () => {
    removeMeshyToast(toast);
  };

  container.appendChild(toast);

  // Auto-remove after delay
  setTimeout(() => {
    removeMeshyToast(toast);
  }, success ? 5000 : 10000);
}

function removeMeshyToast(toast) {
  if (!toast || toast.classList.contains('removing')) return;

  toast.classList.add('removing');
  setTimeout(() => {
    toast.remove();
  }, 300);
}

// ============ Meter Stick ============

function setupMeterStick() {
  const btn = document.getElementById('meter-stick-btn');
  btn.addEventListener('click', handleMeterStickButtonClick);

  setMeterStickDeletedCallback(() => {
    meterStickPlacementMode = false;
    setMeterStickPlacementActive(false);
    updateMeterStickButton();
    saveCurrentRoom();
  });

  setMeterStickPlaceCallback((position, normal) => {
    placeMeterStickAtSurface(position, normal);
  });
}

function handleMeterStickButtonClick() {
  const stick = getMeterStick();

  if (meterStickPlacementMode) {
    meterStickPlacementMode = false;
    setMeterStickPlacementActive(false);
    updateMeterStickButton();
    showActionNotification('Meter stick cancelled');
    return;
  }

  if (!stick) {
    // Restore from saved data if available (deferred load)
    if (savedMeterStickData) {
      restoreMeterStickFromData(savedMeterStickData);
      savedMeterStickData = null;
      updateMeterStickButton();
      showActionNotification('Meter stick shown');
      return;
    }

    meterStickPlacementMode = true;
    setMeterStickPlacementActive(true);
    updateMeterStickButton();
    showActionNotification('Tap a surface to place meter stick', 10000);
    return;
  }

  if (isMeterStickVisible()) {
    setMeterStickVisible(false);
    deselectFurniture();
    showActionNotification('Meter stick hidden');
  } else {
    setMeterStickVisible(true);
    showActionNotification('Meter stick shown');
  }
  updateMeterStickButton();
}

function updateMeterStickButton() {
  const btn = document.getElementById('meter-stick-btn');
  btn.classList.remove('active', 'placement-mode');

  if (meterStickPlacementMode) {
    btn.classList.add('placement-mode');
  } else if (getMeterStick() && isMeterStickVisible()) {
    btn.classList.add('active');
  }
}

function placeMeterStickAtSurface(position, surfaceNormal) {
  const stick = createMeterStick();

  stick.userData.surfaceNormal = surfaceNormal.clone();

  const isFloorOrCeiling = Math.abs(surfaceNormal.y) > 0.7;

  if (!isFloorOrCeiling) {
    const wallUp = new THREE.Vector3(0, 1, 0);
    const wallRight = new THREE.Vector3().crossVectors(wallUp, surfaceNormal).normalize();
    const wallUpCorrected = new THREE.Vector3().crossVectors(surfaceNormal, wallRight).normalize();

    const rotMatrix = new THREE.Matrix4();
    rotMatrix.makeBasis(wallRight, wallUpCorrected, surfaceNormal);
    stick.quaternion.setFromRotationMatrix(rotMatrix);
  }

  const contactAxis = isFloorOrCeiling
    ? new THREE.Vector3(0, -1, 0)
    : surfaceNormal.clone().negate();
  stick.userData.contactAxis = contactAxis;

  const box = new THREE.Box3().setFromObject(stick);
  const size = new THREE.Vector3();
  box.getSize(size);

  const offset = isFloorOrCeiling ? size.y / 2 : size.z / 2;

  stick.position.copy(position).add(surfaceNormal.clone().multiplyScalar(offset));

  addMeterStickToScene(stick);
  meterStickPlacementMode = false;
  setMeterStickPlacementActive(false);
  updateMeterStickButton();
  showActionNotification('Meter stick placed');
}

function restoreMeterStickFromData(data) {
  const stick = createMeterStick();
  stick.position.set(data.position.x, data.position.y, data.position.z);
  stick.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z);
  if (data.surfaceNormal) {
    stick.userData.surfaceNormal = new THREE.Vector3(
      data.surfaceNormal.x, data.surfaceNormal.y, data.surfaceNormal.z
    );
  }
  if (data.contactAxis) {
    stick.userData.contactAxis = new THREE.Vector3(
      data.contactAxis.x, data.contactAxis.y, data.contactAxis.z
    );
  }
  addMeterStickToScene(stick);
}


function getMeterStickSaveData() {
  const stick = getMeterStick();
  if (!stick) return null;
  return {
    position: { x: stick.position.x, y: stick.position.y, z: stick.position.z },
    rotation: { x: stick.rotation.x, y: stick.rotation.y, z: stick.rotation.z },
    surfaceNormal: stick.userData.surfaceNormal
      ? { x: stick.userData.surfaceNormal.x, y: stick.userData.surfaceNormal.y, z: stick.userData.surfaceNormal.z }
      : null,
    contactAxis: stick.userData.contactAxis
      ? { x: stick.userData.contactAxis.x, y: stick.userData.contactAxis.y, z: stick.userData.contactAxis.z }
      : null,
    visible: isMeterStickVisible()
  };
}

// ============ Tutorials ============

let tutorialIndex = null;

function setupTutorials() {
  const btn = document.getElementById('tutorial-btn');
  btn.addEventListener('click', openTutorialHub);
}

async function openTutorialHub() {
  if (!tutorialIndex) {
    try {
      const basePath = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
      const response = await fetch(`${basePath}/tutorials/index.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      tutorialIndex = await response.json();
    } catch (err) {
      console.error('Failed to load tutorial index:', err);
      showActionNotification('Failed to load tutorials');
      return;
    }
  }

  const list = document.getElementById('tutorial-hub-list');
  list.innerHTML = '';

  for (const entry of tutorialIndex) {
    const item = document.createElement('button');
    item.className = 'tutorial-hub-item' + (entry.parent ? ' child' : '');
    item.textContent = entry.title;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      openTutorialContent(entry);
    });
    list.appendChild(item);
  }

  modalManager.openModal('tutorial-hub-modal');
}

async function openTutorialContent(entry) {
  try {
    const basePath = window.location.pathname.replace(/\/+$/, '').replace(/\/index\.html$/i, '');
    const response = await fetch(`${basePath}/tutorials/${entry.file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const markdown = await response.text();

    const rendered = document.getElementById('tutorial-content-rendered');
    rendered.innerHTML = marked.parse(markdown);

    modalManager.openModal('tutorial-content-modal');
  } catch (err) {
    console.error('Failed to load tutorial content:', err);
    showActionNotification('Failed to load tutorial');
  }
}

// ============ Conflict Date Formatting ============

function formatConflictDates(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const opts = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString('en-US', opts);
  const endStr = end.toLocaleDateString('en-US', opts);
  return `${startStr}\u2013${endStr}`;
}

// ============ Action Notification (Bottom-Left Feedback) ============

let actionNotificationTimeout = null;

export function showActionNotification(message, duration = 2000) {
  const el = document.getElementById('action-notification');
  if (!el) return;

  // Clear any pending hide
  if (actionNotificationTimeout) {
    clearTimeout(actionNotificationTimeout);
  }

  // Update message and show
  el.textContent = message;
  el.classList.remove('hidden');
  // Force reflow for animation
  el.offsetHeight;
  el.classList.add('visible');

  actionNotificationTimeout = setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.classList.add('hidden'), 200);
  }, duration);
}

// ============ Wall Color Panel ============

let wallColorPanelOpen = false;
let wallColorVariants = [];
let activeWallColorId = 'original';
let wallColorGenerating = false;
let wallColorPresets = null;
let selectedSwatchIndex = -1;
let currentColor = '#D3D3D3';
let currentColorName = '';
let colorCleared = false;
let colorPickerModalCallback = null;

const DEFAULT_PRESETS = [
  { color: '#F5F5DC', name: 'Beige' },
  { color: '#D3D3D3', name: 'Light Gray' },
  { color: '#FAF0E6', name: 'Linen' },
  { color: '#BCB88A', name: 'Sage Green' },
  { color: '#B0C4DE', name: 'Steel Blue' },
  { color: '#E6D5B8', name: 'Warm Sand' },
  { color: '#F0E68C', name: 'Soft Yellow' },
  { color: '#E8D4C8', name: 'Blush' },
];

function getActivePresets() {
  return wallColorPresets || DEFAULT_PRESETS;
}

function updateCustomDisplay() {
  const swatch = document.getElementById('wall-color-swatch');
  const nameDisplay = document.getElementById('wall-color-name-display');

  swatch.style.background = colorCleared ? '#333' : currentColor;
  nameDisplay.textContent = colorCleared ? '' : (currentColorName || currentColor);
}

function renderSwatches() {
  const container = document.getElementById('wall-color-presets');
  container.innerHTML = '';
  const presets = getActivePresets();

  presets.forEach((preset, index) => {
    const btn = document.createElement('button');
    btn.className = `color-swatch${index === selectedSwatchIndex ? ' selected' : ''}`;
    btn.style.background = preset.color;
    btn.title = preset.name || preset.color;
    btn.addEventListener('click', () => {
      selectSwatch(index);
    });
    container.appendChild(btn);
  });

  const editBtn = document.getElementById('wall-color-edit-btn');
  if (selectedSwatchIndex >= 0) {
    editBtn.classList.remove('hidden');
  } else {
    editBtn.classList.add('hidden');
  }
}

function selectSwatch(index) {
  const presets = getActivePresets();
  if (index === selectedSwatchIndex) {
    selectedSwatchIndex = -1;
    renderSwatches();
    return;
  }

  selectedSwatchIndex = index;
  const preset = presets[index];

  currentColor = preset.color;
  currentColorName = preset.name || '';
  colorCleared = false;

  updateCustomDisplay();
  renderSwatches();
}

function openColorPickerModal(title, color, name, onSave) {
  document.getElementById('color-picker-modal-title').textContent = title;
  document.getElementById('color-picker-modal-color').value = color || '#D3D3D3';
  document.getElementById('color-picker-modal-name').value = name || '';
  colorPickerModalCallback = onSave;
  modalManager.openModal('color-picker-modal');
}

function setupWallColorControls() {
  const paintBtn = document.getElementById('paint-btn');
  const closeBtn = document.getElementById('wall-color-close-btn');
  const applyBtn = document.getElementById('wall-color-apply');
  const editBtn = document.getElementById('wall-color-edit-btn');
  const pickBtn = document.getElementById('wall-color-pick-btn');

  paintBtn.addEventListener('click', () => {
    wallColorPanelOpen ? closeWallColorPanel() : openWallColorPanel();
  });
  closeBtn.addEventListener('click', closeWallColorPanel);

  // Clicking the pick button opens color picker modal for custom selection
  pickBtn.addEventListener('click', () => {
    openColorPickerModal('Pick Color', colorCleared ? '#D3D3D3' : currentColor, currentColorName, (color, name) => {
      currentColor = color;
      currentColorName = name;
      colorCleared = !color && !name;
      selectedSwatchIndex = -1;
      updateCustomDisplay();
      renderSwatches();
    });
  });

  // Edit preset button opens color picker modal for the selected preset
  editBtn.addEventListener('click', () => {
    if (selectedSwatchIndex < 0) return;
    const presets = getActivePresets();
    const preset = presets[selectedSwatchIndex];

    openColorPickerModal('Edit Preset', preset.color, preset.name || '', async (color, name) => {
      preset.color = color;
      preset.name = name || null;

      // Update custom display to reflect edited preset (since it was selected)
      currentColor = color;
      currentColorName = name;
      colorCleared = false;
      updateCustomDisplay();
      renderSwatches();

      try {
        await saveWallColorPresets(presets);
        wallColorPresets = presets;
      } catch (err) {
        showActionNotification('Failed to save preset');
      }
    });
  });

  // Apply button
  applyBtn.addEventListener('click', () => {
    const hex = colorCleared ? null : currentColor;
    const name = currentColorName || null;
    if (!hex && !name) return;
    applyWallColor(name, hex);
  });

  // Color picker modal save/cancel
  document.getElementById('color-picker-modal-save').addEventListener('click', () => {
    const color = document.getElementById('color-picker-modal-color').value;
    const name = document.getElementById('color-picker-modal-name').value.trim();
    modalManager.closeModal();
    if (colorPickerModalCallback) {
      colorPickerModalCallback(color, name);
      colorPickerModalCallback = null;
    }
  });

  document.getElementById('color-picker-modal-cancel').addEventListener('click', () => {
    colorPickerModalCallback = null;
    modalManager.closeModal();
  });

  // Load presets from server
  loadWallColorPresets();
}

async function loadWallColorPresets() {
  try {
    const presets = await getWallColorPresets();
    wallColorPresets = presets;
  } catch (err) {
    // Use defaults
  }
  renderSwatches();
}

function openWallColorPanel() {
  closeLightingPanelIfOpen();
  closeScalePanelIfOpen();
  closeLayoutsPanelIfOpen();
  wallColorPanelOpen = true;
  selectedSwatchIndex = -1;
  document.getElementById('wall-color-panel').classList.remove('hidden');
  document.getElementById('paint-btn').classList.add('active');
  updateCustomDisplay();
  renderSwatches();
  renderWallColorGallery();
}

function closeWallColorPanel() {
  wallColorPanelOpen = false;
  document.getElementById('wall-color-panel').classList.add('hidden');
  document.getElementById('paint-btn').classList.remove('active');
}

function closeWallColorPanelIfOpen() {
  if (wallColorPanelOpen) closeWallColorPanel();
}

async function applyWallColor(colorName, colorHex) {
  if (wallColorGenerating || !currentRoomId) return;
  wallColorGenerating = true;
  renderWallColorGallery();

  const displayName = colorName || colorHex || 'custom';

  try {
    const result = await generateWallColor(currentRoomId, colorName, colorHex);
    wallColorVariants.push({
      id: result.variant_id,
      colorName: colorName,
      colorHex: colorHex,
      imageUrl: result.image_url,
    });
    activeWallColorId = result.variant_id;

    const blob = base64ToBlob(result.image_base64, 'image/png');
    await setBackgroundImagePlane(blob);

    showActionNotification(`Wall color: ${displayName}`);
  } catch (err) {
    showActionNotification('Failed to generate wall color');
  } finally {
    wallColorGenerating = false;
    renderWallColorGallery();
  }
}

async function switchWallColor(variantId) {
  activeWallColorId = variantId;
  let url;
  if (variantId === 'original-photo' && currentRoom?.originalBackgroundUrl) {
    url = currentRoom.originalBackgroundUrl;
  } else if (variantId === 'original') {
    url = currentRoom?.backgroundImageUrl;
  } else {
    const variant = wallColorVariants.find(v => v.id === variantId);
    url = variant?.imageUrl;
  }
  if (url) {
    const blob = await fetchAsBlob(url);
    if (blob) await setBackgroundImagePlane(blob);
  }
  renderWallColorGallery();
}

function renderWallColorGallery() {
  const container = document.getElementById('wall-color-gallery');
  container.innerHTML = '';

  // Original card (split when room has cleared background)
  if (currentRoom && currentRoom.originalBackgroundUrl) {
    const splitCard = document.createElement('div');
    splitCard.className = 'wall-color-card wall-color-split';
    const leftHalf = document.createElement('div');
    leftHalf.className = `wall-color-split-half${activeWallColorId === 'original' ? ' active' : ''}`;
    leftHalf.innerHTML = '<span class="wall-color-label">Cleared</span>';
    leftHalf.addEventListener('click', () => switchWallColor('original'));
    const rightHalf = document.createElement('div');
    rightHalf.className = `wall-color-split-half${activeWallColorId === 'original-photo' ? ' active' : ''}`;
    rightHalf.innerHTML = '<span class="wall-color-label">Original</span>';
    rightHalf.addEventListener('click', () => switchWallColor('original-photo'));
    splitCard.appendChild(leftHalf);
    splitCard.appendChild(rightHalf);
    container.appendChild(splitCard);
  } else {
    const origCard = document.createElement('div');
    origCard.className = `wall-color-card${activeWallColorId === 'original' ? ' active' : ''}`;
    origCard.innerHTML = '<span class="wall-color-label">Original</span>';
    origCard.addEventListener('click', () => switchWallColor('original'));
    container.appendChild(origCard);
  }

  // Variant cards
  for (const v of wallColorVariants) {
    const card = document.createElement('div');
    card.className = `wall-color-card${activeWallColorId === v.id ? ' active' : ''}`;
    if (v.colorHex) card.style.borderTop = `4px solid ${v.colorHex}`;
    const label = v.colorName || v.colorHex || 'Custom';
    card.innerHTML = `
      <span class="wall-color-label">${label}</span>
      <button class="wall-color-delete" title="Delete">&times;</button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.wall-color-delete')) return;
      switchWallColor(v.id);
    });
    card.querySelector('.wall-color-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirmDialog(`Delete "${label}" wall color?`, async () => {
        modalManager.closeModal();
        try {
          await deleteWallColor(currentRoomId, v.id);
          wallColorVariants = wallColorVariants.filter(x => x.id !== v.id);
          if (activeWallColorId === v.id) {
            activeWallColorId = 'original';
            await switchWallColor('original');
          }
          renderWallColorGallery();
        } catch (err) {
          showActionNotification('Failed to delete variant');
        }
      });
    });
    container.appendChild(card);
  }

  // Generating placeholder
  if (wallColorGenerating) {
    const placeholder = document.createElement('div');
    placeholder.className = 'wall-color-card generating';
    placeholder.innerHTML = '<div class="wall-color-spinner"></div><span class="wall-color-label">Generating...</span>';
    container.appendChild(placeholder);
  }
}

async function loadRoomWallColors(room) {
  const wc = room.wallColors || { activeVariantId: 'original', variants: [] };
  wallColorVariants = wc.variants || [];
  activeWallColorId = wc.activeVariantId || 'original';

  if (activeWallColorId !== 'original') {
    const variant = wallColorVariants.find(v => v.id === activeWallColorId);
    if (variant && variant.imageUrl) {
      const blob = await fetchAsBlob(variant.imageUrl);
      if (blob) await setBackgroundImagePlane(blob);
    }
  }
}

function clearWallColorState() {
  wallColorVariants = [];
  activeWallColorId = 'original';
  closeWallColorPanelIfOpen();
}

// ============ Session Modal (House Operations) ============

function setupSessionModal() {
  const sessionBtn = document.getElementById('session-btn');
  const editHouseBtn = document.getElementById('edit-house-session-btn');
  const shareBtn = document.getElementById('share-session-btn');
  const closeHouseBtn = document.getElementById('close-house-session-btn');
  const deleteHouseBtn = document.getElementById('delete-house-session-btn');
  const segmentationBtn = document.getElementById('segmentation-session-btn');

  const signoutBtn = document.getElementById('signout-session-btn');

  sessionBtn.addEventListener('click', openSessionModal);
  editHouseBtn.addEventListener('click', handleEditHouseFromSession);
  shareBtn.addEventListener('click', handleShareHouse);
  segmentationBtn.addEventListener('click', handleOpenSegmentation);
  closeHouseBtn.addEventListener('click', handleCloseHouseFromSession);
  deleteHouseBtn.addEventListener('click', handleDeleteHouseFromSession);
  if (signoutBtn) {
    signoutBtn.addEventListener('click', () => {
      logout();
    });
  }

  // Share modal buttons
  document.getElementById('share-copy-btn').addEventListener('click', () => {
    const input = document.getElementById('share-url-input');
    navigator.clipboard.writeText(input.value).then(() => {
      const btn = document.getElementById('share-copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
  });

  document.getElementById('share-open-btn').addEventListener('click', () => {
    const input = document.getElementById('share-url-input');
    window.open(input.value, '_blank');
  });

  document.getElementById('share-revoke-btn').addEventListener('click', async () => {
    if (!currentHouseId) return;
    await revokeShareToken(currentHouseId);
    modalManager.closeModal();
    showActionNotification('Share link revoked');
  });
}

async function openSessionModal() {
  // Update house info display
  const house = getCurrentHouse();
  if (house) {
    document.getElementById('session-house-name').textContent = house.name;
    document.getElementById('session-house-dates').textContent = formatDateRange(house.startDate, house.endDate);
  }

  modalManager.openModal('session-modal');
}

function handleEditHouseFromSession() {
  modalManager.closeModal(); // Close session modal
  openHouseEditor(currentHouseId);
}

function handleOpenSegmentation() {
  modalManager.closeModal();
  // Build segmentation URL relative to current base path
  const path = window.location.pathname;
  const parts = path.split('/').filter(Boolean);
  const base = parts.length > 0 ? '/' + parts.join('/') + '/' : '/';
  window.open(base + 'segmentation.html', '_blank');
}

async function handleShareHouse() {
  if (!currentHouseId) return;

  modalManager.closeModal();

  if (currentRoomId && currentBackgroundImage) {
    await saveCurrentRoom();
  }

  try {
    const result = await generateShareToken(currentHouseId);
    const shareUrl = `${window.location.origin}${window.location.pathname.replace(/\/+$/, '')}${result.shareUrl}`;

    document.getElementById('share-url-input').value = shareUrl;
    modalManager.openModal('share-modal');
  } catch (err) {
    showError(`Failed to generate share link: ${err.message}`);
  }
}

function base64ToBlob(base64, mimeType = 'image/png') {
  const byteChars = atob(base64);
  const byteArrays = [];
  for (let offset = 0; offset < byteChars.length; offset += 512) {
    const slice = byteChars.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: mimeType });
}

async function handleCloseHouseFromSession() {
  // Save current room before closing
  if (currentRoomId && currentBackgroundImage) {
    await saveCurrentRoom();
  }

  modalManager.closeModal(); // Close session modal
  await closeHouse();
}

async function handleDeleteHouseFromSession() {
  const house = getCurrentHouse();
  if (!house) return;

  const roomCount = await getHouseRoomCount(currentHouseId);

  showConfirmDialog(
    `Are you sure you want to delete "${house.name}" and all ${roomCount} room${roomCount !== 1 ? 's' : ''}? This cannot be undone.`,
    async () => {
      await deleteHouseWithRooms(currentHouseId);
      modalManager.closeAllModals();
      await closeHouse();
    }
  );
}

// ============ Undo/Redo ============

function setupUndoRedo() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');

  undoBtn.addEventListener('click', () => undoManager.undo());
  redoBtn.addEventListener('click', () => undoManager.redo());

  // Keyboard shortcuts
  window.addEventListener('keydown', (event) => {
    if (modalManager.isModalOpen()) return;

    if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        undoManager.redo();
      } else {
        undoManager.undo();
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'y') {
      event.preventDefault();
      undoManager.redo();
    }
  });
}

// ============ Error Popup ============

function setupErrorPopup() {
  const closeBtn = document.getElementById('error-close-btn');
  closeBtn.addEventListener('click', hideError);
}

// ============ Calendar Modal ============

function setupCalendar() {
  initCalendar({
    onHouseClick: (houseId, event) => {
      showHouseActionPopup(houseId, event);
    },
    onNewHouse: () => {
      openHouseEditor(null);
    },
    onDayClick: (dateStr, houses, event) => {
      showDayHousesModal(dateStr, houses);
    }
  });
}

async function openCalendarModal() {
  // Clear any pending creation state (user abandoned the flow)
  pendingRoomImage = null;
  pendingRoomName = null;

  await renderCalendar();
  await checkForLegacyRooms();
  modalManager.openModal('calendar-modal');
}

function showDayHousesModal(dateStr, houses) {
  // Format date for display (e.g., "January 15, 2026")
  const date = new Date(dateStr + 'T00:00:00');
  const options = { month: 'long', day: 'numeric', year: 'numeric' };
  const formattedDate = date.toLocaleDateString('en-US', options);

  // Update modal title
  const titleEl = document.getElementById('day-houses-title');
  titleEl.textContent = `Houses on ${formattedDate}`;

  // Populate houses list
  const listEl = document.getElementById('day-houses-list');
  listEl.innerHTML = '';

  houses.forEach(house => {
    const btn = document.createElement('button');
    btn.className = 'day-house-btn';

    const colorEl = document.createElement('span');
    colorEl.className = 'day-house-color';
    colorEl.style.backgroundColor = getHouseColorStyle(getHouseColorIndex(house.id));

    const nameEl = document.createElement('span');
    nameEl.className = 'day-house-name';
    nameEl.textContent = house.name;

    const datesEl = document.createElement('span');
    datesEl.className = 'day-house-dates';
    datesEl.textContent = formatDateRange(house.startDate, house.endDate);

    btn.appendChild(colorEl);
    btn.appendChild(nameEl);
    btn.appendChild(datesEl);

    btn.addEventListener('click', async () => {
      modalManager.closeModal();
      showActionNotification('Loading house...');
      await loadHouse(house.id);
    });

    listEl.appendChild(btn);
  });

  modalManager.openModal('day-houses-modal');
}

// Get CSS color for house color index
function getHouseColorStyle(colorIndex) {
  const colors = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
  ];
  return colors[colorIndex % colors.length];
}

// Check for legacy rooms and show notice
async function checkForLegacyRooms() {
  const orphanRooms = await getOrphanRooms();
  const notice = document.getElementById('legacy-rooms-notice');
  if (notice) {
    if (orphanRooms.length > 0) {
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }
  }
}

// ============ House Editor ============

function setupHouseEditor() {
  const form = document.getElementById('house-editor-form');
  const cancelBtn = document.getElementById('house-editor-cancel');
  const startDateInput = document.getElementById('house-start-date');
  const endDateInput = document.getElementById('house-end-date');

  form.addEventListener('submit', handleHouseEditorSubmit);
  cancelBtn.addEventListener('click', closeHouseEditor);

  // Validate dates on change
  startDateInput.addEventListener('change', validateHouseEditorDates);
  endDateInput.addEventListener('change', validateHouseEditorDates);
}

function openHouseEditor(houseId) {
  editingHouseId = houseId;

  const title = document.getElementById('house-editor-title');
  const nameInput = document.getElementById('house-name');
  const startDateInput = document.getElementById('house-start-date');
  const endDateInput = document.getElementById('house-end-date');
  const errorEl = document.getElementById('house-date-error');

  // Reset form
  nameInput.value = '';
  startDateInput.value = '';
  endDateInput.value = '';
  errorEl.classList.add('hidden');

  if (houseId) {
    // Editing existing house
    title.textContent = 'Edit House';
    getHouseById(houseId).then(house => {
      if (house) {
        nameInput.value = house.name || '';
        startDateInput.value = house.startDate || '';
        endDateInput.value = house.endDate || '';
      }
    });
  } else {
    title.textContent = 'New House';
    // Set default dates to today and 30 days from now
    const today = new Date();
    const thirtyDays = new Date(today);
    thirtyDays.setDate(thirtyDays.getDate() + 30);
    startDateInput.value = today.toISOString().split('T')[0];
    endDateInput.value = thirtyDays.toISOString().split('T')[0];
  }

  modalManager.openModal('house-editor-modal');
}

function closeHouseEditor() {
  modalManager.closeModal();
  editingHouseId = null;
}

function validateHouseEditorDates() {
  const startDate = document.getElementById('house-start-date').value;
  const endDate = document.getElementById('house-end-date').value;
  const errorEl = document.getElementById('house-date-error');

  if (startDate && endDate) {
    const validation = validateHouseDates(startDate, endDate);
    if (!validation.valid) {
      errorEl.textContent = validation.error;
      errorEl.classList.remove('hidden');
      return false;
    }
  }

  errorEl.classList.add('hidden');
  return true;
}

async function handleHouseEditorSubmit(event) {
  event.preventDefault();

  const nameInput = document.getElementById('house-name');
  const startDateInput = document.getElementById('house-start-date');
  const endDateInput = document.getElementById('house-end-date');

  const name = nameInput.value.trim();
  const startDate = startDateInput.value;
  const endDate = endDateInput.value;

  if (!name) {
    showError('Please enter a house name');
    return;
  }

  if (!validateHouseEditorDates()) {
    return;
  }

  // Show immediate feedback
  showActionNotification(editingHouseId ? 'Saving house...' : 'Creating house...');

  try {
    if (editingHouseId) {
      // Update existing house
      await updateHouse(editingHouseId, { name, startDate, endDate });
      closeHouseEditor();
      await renderCalendar();
    } else {
      // Create new house immediately
      const house = await createHouse(name, startDate, endDate);
      currentHouseId = house.id;
      setCurrentHouse(house);
      closeHouseEditor();

      // Trigger image upload for first room
      document.getElementById('image-file-input').click();
    }
  } catch (err) {
    showError(err.message);
  }
}

// ============ House Action Popup ============

function setupHouseActionPopup() {
  const popup = document.getElementById('house-action-popup');
  const loadBtn = document.getElementById('house-load-btn');
  const editBtn = document.getElementById('house-edit-btn');
  const deleteBtn = document.getElementById('house-delete-btn');

  loadBtn.addEventListener('click', async () => {
    const houseId = popupHouseId;
    if (!houseId) return;
    hideHouseActionPopup();
    modalManager.closeModal(); // Close house modal
    await loadHouse(houseId);
  });

  editBtn.addEventListener('click', () => {
    const houseId = popupHouseId;
    hideHouseActionPopup();
    openHouseEditor(houseId);
  });

  deleteBtn.addEventListener('click', async () => {
    const houseId = popupHouseId;
    hideHouseActionPopup();
    await confirmDeleteHouse(houseId);
  });

  // Close popup when clicking outside
  document.addEventListener('click', (event) => {
    if (!popup.contains(event.target) && !event.target.closest('.house-card')) {
      hideHouseActionPopup();
    }
  });
}

function showHouseActionPopup(houseId, event) {
  popupHouseId = houseId;
  showPopupAt('house-action-popup', event.clientX, event.clientY);
  event.stopPropagation();
}

function hideHouseActionPopup() {
  hidePopup('house-action-popup');
  popupHouseId = null;
}

async function confirmDeleteHouse(houseId) {
  const house = await getHouseById(houseId);
  if (!house) return;

  const roomCount = await getHouseRoomCount(houseId);

  showConfirmDialog(
    `Are you sure you want to delete "${house.name}" and all ${roomCount} room${roomCount !== 1 ? 's' : ''}? This cannot be undone.`,
    async () => {
      showActionNotification('Deleting house...');
      await deleteHouseWithRooms(houseId);
      modalManager.closeModal();
      await renderCalendar();
    }
  );
}

// ============ Room Name Modal ============

function setupRoomNameModal() {
  const form = document.getElementById('room-name-form');
  const modal = document.getElementById('room-name-modal');

  form.addEventListener('submit', handleRoomNameSubmit);

  // Handle clicking outside room name modal to cancel
  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      // Clicked on overlay, not content - cancel the flow
      cancelRoomCreationFlow();
    }
  });
}

function openRoomNameModal() {
  const input = document.getElementById('room-name-input');
  input.value = '';
  modalManager.openModal('room-name-modal');
}

function closeRoomNameModal() {
  modalManager.closeModal();
}

let roomNameSubmitting = false;

async function handleRoomNameSubmit(event) {
  event.preventDefault();

  if (roomNameSubmitting) return;
  roomNameSubmitting = true;

  try {
    const nameInput = document.getElementById('room-name-input');
    const name = nameInput.value.trim();

    if (!name) {
      showError('Please enter a room name');
      return;
    }

    pendingRoomName = name;
    closeRoomNameModal();

    // Ask about furniture clearing before processing
    // Small delay ensures room name modal is fully closed before opening next modal
    setTimeout(() => {
      document.getElementById('clear-floor-hint').value = '';
      modalManager.openModal('clear-furniture-modal');
    }, 100);
  } finally {
    roomNameSubmitting = false;
  }
}

// Handle room image upload (for new room flow)
async function handleRoomImageUpload(event) {
  const file = event.target.files[0];
  if (!file) {
    // User cancelled file picker - if no house loaded yet, stay on house modal
    return;
  }

  // Save current room before creating new one
  if (currentRoomId) {
    await saveCurrentRoom();
  }

  // Close panels if open
  closeLightingPanelIfOpen();
  closeScalePanelIfOpen();
  closeLayoutsPanelIfOpen();
  closeWallColorPanelIfOpen();

  // Store pending image
  pendingRoomImage = file;

  // Show the image immediately (bring to front so it's visible over current room)
  setBackgroundImage(file, true);
  document.getElementById('canvas-container').classList.remove('hidden');

  // Close house modal and open room name modal
  modalManager.closeAllModals();
  openRoomNameModal();

  event.target.value = '';
}

// ============ Tab Bar ============

function setupTabBar() {
  const tabsContainer = document.getElementById('room-tabs-container');
  const addRoomBtn = document.getElementById('add-room-tab-btn');

  // Click on tabs (delegated)
  tabsContainer.addEventListener('click', async (e) => {
    const tab = e.target.closest('.room-tab');
    if (!tab) return;

    const closeBtn = e.target.closest('.room-tab-close');
    if (closeBtn) {
      // Close button clicked
      const roomId = tab.dataset.roomId;
      await confirmDeleteRoomFromTab(roomId);
    } else {
      // Tab clicked - switch room
      const roomId = tab.dataset.roomId;
      if (roomId !== currentRoomId) {
        await switchRoom(roomId);
      }
    }
  });

  // Add room button
  addRoomBtn.addEventListener('click', () => {
    document.getElementById('image-file-input').click();
  });
}

async function renderTabBar() {
  if (!currentHouseId) {
    hideTabBar();
    return;
  }

  const rooms = await getRoomsByHouseId(currentHouseId);
  const container = document.getElementById('room-tabs-container');
  container.innerHTML = '';

  rooms.forEach(room => {
    const tab = document.createElement('button');
    tab.className = 'room-tab' + (room.id === currentRoomId ? ' active' : '');
    tab.dataset.roomId = room.id;
    tab.innerHTML = `
      <span class="room-tab-name">${room.name || 'Untitled Room'}</span>
      <span class="room-tab-close">&times;</span>
    `;
    container.appendChild(tab);
  });

  showTabBar();
}

async function switchRoom(roomId) {
  // Show immediate feedback
  showActionNotification('Switching room...');

  // Close panels before switching
  closeLightingPanelIfOpen();
  closeScalePanelIfOpen();
  closeLayoutsPanelIfOpen();
  closeWallColorPanelIfOpen();

  // Save current room first
  if (currentRoomId) {
    await saveCurrentRoom();
  }

  // Load new room
  await loadRoomById(roomId);

  // Update tab bar
  await renderTabBar();
}

async function confirmDeleteRoomFromTab(roomId) {
  const room = await dbLoadRoom(roomId);
  if (!room) return;

  showConfirmDialog(
    `Are you sure you want to delete "${room.name || 'this room'}"? This cannot be undone.`,
    async () => {
      showActionNotification('Deleting room...');
      modalManager.closeModal();
      await deleteRoom(roomId);

      if (roomId === currentRoomId) {
        const remainingRooms = await getRoomsByHouseId(currentHouseId);
        if (remainingRooms.length > 0) {
          await loadRoomById(remainingRooms[0].id);
          await renderTabBar();
        } else {
          await closeHouse();
        }
      } else {
        await renderTabBar();
      }
    }
  );
}

// ============ House/Room Loading ============

async function loadHouse(houseId) {
  if (!houseId) return;

  // Show immediate feedback
  showActionNotification('Loading house...');

  // Reset furniture visibility for new house session
  resetFurnitureVisibility();

  const house = await getHouseById(houseId);
  if (!house) {
    showError('House not found');
    return;
  }

  currentHouseId = houseId;
  setCurrentHouse(house);
  setCurrentLoadedHouse(houseId);

  // Get rooms for this house
  const rooms = await getRoomsByHouseId(houseId);

  if (rooms.length === 0) {
    // No rooms - prompt to add first room
    document.getElementById('image-file-input').click();
    return;
  }

  // Load first room
  await loadRoomById(rooms[0].id);

  // Show tab bar
  await renderTabBar();

  // Close all modals now that house is loaded
  modalManager.closeAllModals();
}

async function loadRoomById(roomId) {
  const room = await dbLoadRoom(roomId);
  if (!room) {
    showError('Room not found');
    return;
  }

  currentRoom = room;

  // Verify room has mesh data (required)
  if (!room.mogeData || !room.mogeData.meshUrl) {
    showError('This room is missing 3D mesh data and cannot be loaded.');
    return;
  }

  currentRoomId = roomId;

  // Clear existing room geometry first
  clearRoomGeometry();

  // Load MoGe mesh
  try {
    console.log('Loading saved room mesh from:', room.mogeData.meshUrl);

    await loadRoomGeometry(room.mogeData.meshUrl, {
      wireframeColor: 0x00ff00,
      wireframeOpacity: 0.5
    });

    // Align camera to match saved MoGe settings
    const fov = room.mogeData.cameraFov || 60;

    // imageAspect must come from mogeData or be recalculated from image
    // NEVER use window aspect as fallback - it causes distortion
    let imageAspect = room.mogeData.imageAspect;

    if (!imageAspect && room.backgroundImage) {
      // Recalculate from stored background image
      imageAspect = await getImageAspectRatio(room.backgroundImage);
      console.log('Recalculated imageAspect from background image:', imageAspect);
    }

    if (!imageAspect) {
      throw new Error('Room is missing imageAspect and has no background image to calculate it from');
    }

    setCameraForMoGeAlignment(fov, imageAspect);

    // Set up background plane
    if (room.backgroundImage) {
      const bounds = getRoomBounds();
      const backgroundDepth = Math.abs(bounds.min.z) + 1;
      await setBackgroundImagePlane(room.backgroundImage, backgroundDepth);

      // Clear CSS background since we use 3D plane
      document.getElementById('background-container').style.backgroundImage = '';
    }

    currentBackgroundImage = room.backgroundImage;
    console.log('Room mesh and camera restored');

  } catch (err) {
    console.error('Failed to load room mesh:', err);
    showError('Failed to load room mesh. The mesh URL may have expired. Please delete this room and create a new one.');
    currentRoomId = null;
    return;
  }

  // Clear existing furniture
  clearAllFurniture();
  undoManager.clear();

  // Load placed furniture
  if (room.placedFurniture) {
    const loadedModels = [];

    for (const furniture of room.placedFurniture) {
      try {
        const entry = await getFurnitureEntry(furniture.entryId);
        if (!entry || !entry.model) {
          loadedModels.push(null);
          continue;
        }

        const extractedData = await extractModelFromZip(entry.model);
        const model = await loadModelFromExtractedZip(extractedData);
        model.position.set(furniture.position.x, furniture.position.y, furniture.position.z);
        model.rotation.set(furniture.rotation.x, furniture.rotation.y, furniture.rotation.z);

        if (typeof furniture.scale === 'number') {
          model.scale.setScalar(furniture.scale);
        } else if (furniture.scale && typeof furniture.scale === 'object') {
          model.scale.set(furniture.scale.x, furniture.scale.y, furniture.scale.z);
        }

        // Restore surface orientation data
        if (furniture.surfaceNormal) {
          model.userData.surfaceNormal = new THREE.Vector3(
            furniture.surfaceNormal.x,
            furniture.surfaceNormal.y,
            furniture.surfaceNormal.z
          );
        }

        if (furniture.contactAxis) {
          model.userData.contactAxis = new THREE.Vector3(
            furniture.contactAxis.x,
            furniture.contactAxis.y,
            furniture.contactAxis.z
          );
        }

        if (typeof furniture.uprightRotation === 'number') {
          model.userData.uprightRotation = furniture.uprightRotation;
        }

        if (typeof furniture.rotationAroundNormal === 'number') {
          model.userData.rotationAroundNormal = furniture.rotationAroundNormal;
        }

        // Restore base scale (needed for room scale recalculation)
        if (furniture.baseScale) {
          model.userData.baseScale = new THREE.Vector3(
            furniture.baseScale.x,
            furniture.baseScale.y,
            furniture.baseScale.z
          );
        }

        addFurnitureToScene(model, furniture.entryId);
        loadedModels.push(model);
      } catch (err) {
        console.warn(`Failed to load furniture ${furniture.entryId}:`, err);
        loadedModels.push(null);
      }
    }

    // Link parent-child relationships
    for (let i = 0; i < room.placedFurniture.length; i++) {
      const data = room.placedFurniture[i];
      const model = loadedModels[i];
      if (!model || data.parentIndex == null) continue;

      const parent = loadedModels[data.parentIndex];
      if (!parent) continue;

      model.userData.isChild = true;
      model.userData.parentId = parent.uuid;
      model.userData.localOffset = data.localOffset
        ? new THREE.Vector3(data.localOffset.x, data.localOffset.y, data.localOffset.z)
        : new THREE.Vector3(0, 0, 0);
      model.userData.localRotationY = data.localRotationY || 0;

      if (!parent.userData.childIds) parent.userData.childIds = [];
      parent.userData.childIds.push(model.uuid);
    }
  }

  // Load lighting settings
  if (room.lightingSettings) {
    applyLightingSettings(room.lightingSettings);
    console.log('Room lighting settings restored');
  }

  // Load room scale
  if (typeof room.roomScale === 'number') {
    setRoomScale(room.roomScale);
  } else {
    resetRoomScale(); // Default to 1.0 for rooms without saved scale
  }
  updateScaleUIFromRoom();
  console.log('Room scale:', getRoomScale());

  // Store meter stick data for deferred creation (hidden until button pressed)
  clearMeterStick();
  meterStickPlacementMode = false;
  setMeterStickPlacementActive(false);
  savedMeterStickData = room.meterStick || null;
  updateMeterStickButton();

  // Load wall color state
  await loadRoomWallColors(room);

  // Store initial state for selective saves (only save changed fields)
  previousRoomState = {
    id: roomId,
    placedFurniture: room.placedFurniture || [],
    lightingSettings: room.lightingSettings || null,
    roomScale: room.roomScale ?? 1.0,
    meterStick: room.meterStick || null,
  };

  // Show scene
  showScene();
  deselectFurniture();

  // Start autosave for this room
  await updateSavedHash();
  startAutosave();

  // Hint for empty rooms
  if (!room.placedFurniture || room.placedFurniture.length === 0) {
    showActionNotification('Tap anywhere to place furniture', 30000);
  }
}

async function saveCurrentRoom() {
  if (!currentRoomId || !currentBackgroundImage) return;

  const room = await dbLoadRoom(currentRoomId) || {};

  const roomState = {
    id: currentRoomId,
    houseId: currentHouseId,
    name: room.name || 'Untitled Room',
    placedFurniture: collectPlacedFurniture(),
    lightingSettings: getLightingSettings(),
    roomScale: getRoomScale(),
    meterStick: getMeterStickSaveData()
    // NOTE: mogeData intentionally omitted - never changes, handled by selective save
  };

  // Pass previous state for comparison (only changed fields will be sent)
  await saveRoom(roomState, previousRoomState);

  // Update previous state for next comparison
  previousRoomState = {
    id: currentRoomId,
    placedFurniture: roomState.placedFurniture,
    lightingSettings: roomState.lightingSettings,
    roomScale: roomState.roomScale,
    meterStick: roomState.meterStick,
  };

  // Update autosave hash so next interval doesn't re-save
  await updateSavedHash();
}

async function computeRoomHash() {
  const state = {
    placedFurniture: collectPlacedFurniture(),
    lightingSettings: getLightingSettings(),
    roomScale: getRoomScale(),
    meterStick: getMeterStickSaveData()
  };
  const json = JSON.stringify(state);
  const data = new TextEncoder().encode(json);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function startAutosave() {
  stopAutosave();
  autosaveInterval = setInterval(async () => {
    if (!currentRoomId || !currentBackgroundImage || saveInProgress) return;
    try {
      const hash = await computeRoomHash();
      if (hash !== lastSavedHash) {
        saveInProgress = true;
        await saveCurrentRoom();
        lastSavedHash = hash;
        saveInProgress = false;
      }
    } catch (err) {
      console.warn('Autosave failed:', err);
      saveInProgress = false;
    }
  }, 60000);
}

function stopAutosave() {
  if (autosaveInterval) {
    clearInterval(autosaveInterval);
    autosaveInterval = null;
  }
  lastSavedHash = null;
  lastSavedState = null;
}

async function updateSavedHash() {
  if (currentRoomId && currentBackgroundImage) {
    lastSavedHash = await computeRoomHash();
    lastSavedState = JSON.stringify({
      placedFurniture: collectPlacedFurniture(),
      lightingSettings: getLightingSettings(),
      roomScale: getRoomScale(),
      meterStick: getMeterStickSaveData()
    });
  }
}

async function closeHouse() {
  // Stop autosave
  stopAutosave();

  // Close panels
  closeLightingPanelIfOpen();
  closeScalePanelIfOpen();
  closeLayoutsPanelIfOpen();
  closeWallColorPanelIfOpen();

  currentHouseId = null;
  currentRoomId = null;
  currentBackgroundImage = null;
  currentRoom = null;
  previousRoomState = null;
  setCurrentHouse(null);
  setCurrentLoadedHouse(null);

  // Clear any pending creation state
  pendingRoomImage = null;
  pendingRoomName = null;

  clearMeterStick();
  meterStickPlacementMode = false;
  setMeterStickPlacementActive(false);
  savedMeterStickData = null;

  clearWallColorState();

  document.getElementById('background-container').style.backgroundImage = '';
  clearAllFurniture();
  clearRoomGeometry(); // Reset room bounds to default
  resetRoomScale(); // Reset to default 1.0
  undoManager.clear();
  deselectFurniture();
  hideScene();

  await openCalendarModal();
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
