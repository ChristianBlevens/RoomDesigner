// Main entry point for Room Furniture Planner

import {
  initScene,
  loadModelFromExtractedZip,
  generateThumbnailFromModel,
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
  isLightingGizmoVisible
} from './scene.js';
import { MoGe2Client } from '../huggingface-moge2/moge2-client.js';
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
  getOrphanRooms
} from './api.js';
import {
  getCurrentHouse,
  setCurrentHouse,
  createHouse,
  updateHouse,
  deleteHouseWithRooms,
  getHouseById,
  getHouseRoomCount,
  formatDateRange,
  validateHouseDates,
  getAvailableQuantity
} from './houses.js';
import {
  initCalendar,
  renderCalendar,
  setCurrentLoadedHouse
} from './calendar.js';
import { modalManager, MultiSelectTags } from './modals.js';
import { undoManager } from './undo.js';
import {
  initFurnitureInteraction,
  setOpenFurnitureModalCallback,
  getLastClickPosition,
  placeFurniture,
  removeAllFurnitureByEntryId,
  deselectFurniture
} from './furniture.js';
import {
  showError,
  hideError,
  extractModelFromZip,
  blobToBase64,
  base64ToBlob,
  debounce
} from './utils.js';
import { adjustUrlForProxy } from './api.js';

// Application state
let currentHouseId = null;
let currentRoomId = null;
let currentBackgroundImage = null;
let tagsDropdown = null;

// Pending state for multi-step room creation flow
let pendingRoomImage = null;
let pendingRoomName = null;

// MoGe-2 client for room geometry extraction
const moge2Client = new MoGe2Client();

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
let entryThumbnailBlob = null;
let entryTags = [];

// Popup state
let popupEntryId = null;

// Meshy background generation tasks
// Map of entryId -> { taskId, status, progress, entryName }
const meshyActiveTasks = new Map();
const MESHY_MAX_CONCURRENT = 10;

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
function showConfirmDialog(message, onConfirm, onCancel = null) {
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
  // Initialize Three.js scene
  initScene();

  // Initialize furniture interaction
  initFurnitureInteraction();
  setOpenFurnitureModalCallback(openFurnitureModal);

  // Setup UI event handlers
  setupFileInputs();
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

  // Show calendar modal on startup
  await openCalendarModal();
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

  const light = getDirectionalLight();
  if (light) {
    intensitySlider.value = light.intensity;
    intensityValue.textContent = light.intensity.toFixed(1);

    const temp = light.userData.temperature || 6500;
    tempSlider.value = temp;
    tempValue.textContent = temp + 'K';
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
    // Store temperature in light userData for saving
    const light = getDirectionalLight();
    if (light) light.userData.temperature = kelvin;
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

  // Mouse down - start dragging or start new direction
  canvas.addEventListener('mousedown', (event) => {
    if (!lightingPanelOpen) return;
    if (event.button !== 0) return;
    if (modalManager.isModalOpen()) return;

    // Check if clicking on gizmo handle (for dragging existing)
    if (!lightingDirectionMode) {
      const gizmoHit = raycastLightingGizmo(event);
      if (gizmoHit) {
        lightingDraggingHandle = gizmoHit.type;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    // If in direction mode, set source position
    if (lightingDirectionMode) {
      const hit = raycastRoomSurface(event);
      if (hit) {
        setLightPosition(hit.point);
        // Also set target to same point initially (will be updated on drag/release)
        setLightTargetPosition(hit.point);
        updateLightingGizmo();
        directionStatus.textContent = 'Drag to set target, release to confirm';
        lightingDraggingHandle = 'target'; // Now dragging the target
        event.preventDefault();
        event.stopPropagation();
      }
    }
  });

  // Mouse move - update hover or drag gizmo
  canvas.addEventListener('mousemove', (event) => {
    if (!lightingPanelOpen) return;

    // If dragging a handle, update its position
    if (lightingDraggingHandle) {
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
    if (!lightingDirectionMode) {
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

  // Mouse up - finish dragging
  canvas.addEventListener('mouseup', (event) => {
    if (!lightingPanelOpen) return;

    if (lightingDraggingHandle) {
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
      canvas.style.cursor = '';
      setLightingGizmoHover(null);
    }
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

function setBackgroundImage(blob) {
  const container = document.getElementById('background-container');
  const url = URL.createObjectURL(blob);
  container.style.backgroundImage = `url(${url})`;
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

// Show the 3D scene and UI controls
function showScene() {
  document.getElementById('canvas-container').classList.remove('hidden');
  document.getElementById('controls-left').classList.remove('hidden');
  document.getElementById('controls-right').classList.remove('hidden');
}

// Hide the 3D scene and UI controls
function hideScene() {
  document.getElementById('canvas-container').classList.add('hidden');
  document.getElementById('controls-left').classList.add('hidden');
  document.getElementById('controls-right').classList.add('hidden');
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

// State for MoGe-2 processing
let moge2Result = null;
let moge2Processing = false;

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

// Process pending room image with MoGe-2
async function processWithMoGe2() {
  if (!pendingRoomImage || moge2Processing) return;

  moge2Processing = true;
  moge2Result = null;

  const applyBtn = document.getElementById('apply-orientation-btn');
  const defaultInfo = document.getElementById('orientation-default-info');
  const loadingEl = document.getElementById('orientation-loading');
  const loadingText = document.getElementById('orientation-loading-text');
  const resultEl = document.getElementById('orientation-result');
  const fovInfo = document.getElementById('orientation-fov-info');
  const errorEl = document.getElementById('orientation-error');
  const errorText = document.getElementById('orientation-error-text');

  // Show loading state
  defaultInfo.classList.add('hidden');
  resultEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  applyBtn.disabled = true;

  try {
    loadingText.textContent = 'Connecting to MoGe-2...';
    await moge2Client.connect();

    loadingText.textContent = 'Analyzing room geometry (30-60 seconds)...';
    const result = await moge2Client.processImageForRoom(pendingRoomImage);

    moge2Result = result;
    console.log('MoGe-2 result:', result);

    // Show success state
    loadingEl.classList.add('hidden');
    resultEl.classList.remove('hidden');

    // Display FOV info
    if (result.camera) {
      const hFov = result.camera.fovHorizontal;
      const vFov = result.camera.fovVertical;
      if (hFov && vFov) {
        fovInfo.textContent = `Horizontal FOV: ${hFov.toFixed(1)}° | Vertical FOV: ${vFov.toFixed(1)}°`;
      } else if (vFov) {
        fovInfo.textContent = `Vertical FOV: ${vFov.toFixed(1)}°`;
      } else {
        fovInfo.textContent = 'FOV: Using default (60°)';
      }
    }

    applyBtn.textContent = 'Continue';
    applyBtn.disabled = false;

  } catch (err) {
    console.error('MoGe-2 processing failed:', err);

    // Show error state
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    errorText.textContent = `Analysis failed: ${err.message}`;

    // Allow user to continue with defaults
    applyBtn.textContent = 'Continue with Defaults';
    applyBtn.disabled = false;
    moge2Result = null;

  } finally {
    moge2Processing = false;
  }
}

// Reset orientation modal state when opening
function resetOrientationModal() {
  moge2Result = null;
  moge2Processing = false;

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
 * Automatic room processing flow - no user interaction required.
 * Shows progress, processes with MoGe-2, creates room, and shows scene.
 * If MoGe-2 fails, room creation is cancelled entirely (no fallback).
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
  loadingText.textContent = 'Connecting to MoGe-2...';

  modalManager.openModal('orientation-modal');

  let processingResult = null;

  try {
    // Connect and process with MoGe-2
    await moge2Client.connect();
    loadingText.textContent = 'Analyzing room geometry (30-60 seconds)...';

    processingResult = await moge2Client.processImageForRoom(pendingRoomImage);
    console.log('MoGe-2 result:', processingResult);

    // Verify we got a valid mesh URL
    const geometryUrl = processingResult?.meshUrl || processingResult?.modelUrl;
    if (!geometryUrl) {
      throw new Error('MoGe-2 did not return a valid mesh');
    }

    // Show success briefly
    loadingEl.classList.add('hidden');
    resultEl.classList.remove('hidden');

    if (processingResult.camera) {
      const hFov = processingResult.camera.fovHorizontal;
      const vFov = processingResult.camera.fovVertical;
      if (hFov && vFov) {
        fovInfo.textContent = `Horizontal FOV: ${hFov.toFixed(1)}° | Vertical FOV: ${vFov.toFixed(1)}°`;
      } else if (vFov) {
        fovInfo.textContent = `Vertical FOV: ${vFov.toFixed(1)}°`;
      } else {
        fovInfo.textContent = 'FOV: Using default (60°)';
      }
    }

    // Load geometry
    loadingEl.classList.remove('hidden');
    resultEl.classList.add('hidden');
    loadingText.textContent = 'Loading room mesh...';

    await loadRoomGeometry(geometryUrl, {
      wireframeColor: 0x00ff00,
      wireframeOpacity: 0.5
    });

    // Get image dimensions for aspect ratio
    const imageAspect = await getImageAspectRatio(pendingRoomImage);

    // Align camera to match MoGe output
    const fov = processingResult?.camera?.fov || 60;
    setCameraForMoGeAlignment(fov, imageAspect);

    // Set up background plane
    loadingText.textContent = 'Setting up background...';
    const bounds = getRoomBounds();
    const backgroundDepth = Math.abs(bounds.min.z) + 1;
    await setBackgroundImagePlane(pendingRoomImage, backgroundDepth);

    // Clear CSS background since we use 3D plane
    document.getElementById('background-container').style.backgroundImage = '';

    // Store MoGe data for room persistence (meshUrl is placeholder - server will set local URL)
    const mogeDataForSave = {
      meshUrl: null,  // Will be set by server after download
      cameraFov: fov,
      imageAspect: imageAspect
    };

    console.log('Room geometry loaded and camera aligned');

    // Show final success
    loadingEl.classList.add('hidden');
    resultEl.classList.remove('hidden');
    fovInfo.textContent = 'Room ready! Saving...';

    // Brief pause to show success
    await new Promise(resolve => setTimeout(resolve, 800));

    // Create the room - server downloads mesh atomically
    loadingText.textContent = 'Saving room and mesh...';
    loadingEl.classList.remove('hidden');
    resultEl.classList.add('hidden');
    const room = await createRoomInCurrentHouse(pendingRoomImage, pendingRoomName, mogeDataForSave, geometryUrl);

    // Set as current room
    currentRoomId = room.id;
    currentBackgroundImage = pendingRoomImage;

    // Clear pending state
    pendingRoomImage = null;
    pendingRoomName = null;
    moge2Result = null;

    // Clear any existing furniture
    clearAllFurniture();
    undoManager.clear();

    // Show scene and close modal
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
  moge2Result = null;
  moge2Processing = false;

  modalManager.closeAllModals();

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
  refreshFurnitureModal();
  modalManager.openModal('furniture-modal');
}

async function refreshFurnitureModal() {
  await updateCategorySelect();
  await updateTagsDropdown();
  await renderFurnitureGrid();
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
  const furniture = await getAllFurniture();

  grid.innerHTML = '';

  if (furniture.length === 0) {
    grid.innerHTML = '<p class="no-results">No furniture entries. Click "Add Entry" to create one.</p>';
    return;
  }

  for (const item of furniture) {
    const card = await createFurnitureCard(item);
    grid.appendChild(card);
  }
}

async function filterFurnitureGrid() {
  const searchTerm = document.getElementById('furniture-search').value.toLowerCase().trim();
  const category = document.getElementById('category-select').value;
  const selectedTags = tagsDropdown.getSelectedTags();

  let furniture = await getAllFurniture();

  // Filter by search term
  if (searchTerm) {
    furniture = furniture.filter(item => {
      if (item.name.toLowerCase().includes(searchTerm)) return true;
      if (item.tags && item.tags.some(tag => tag.toLowerCase().includes(searchTerm))) return true;
      if (item.category && item.category.toLowerCase().includes(searchTerm)) return true;
      return false;
    });
  }

  // Filter by category
  if (category) {
    furniture = furniture.filter(item => item.category === category);
  }

  // Filter by tags
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

  for (const item of furniture) {
    const card = await createFurnitureCard(item);
    grid.appendChild(card);
  }
}

async function createFurnitureCard(item) {
  const card = document.createElement('div');
  card.className = 'furniture-card';
  card.dataset.id = item.id;

  // Get availability info (include count already placed in current scene)
  const placedInScene = getPlacedCountForEntry(item.id);
  const { available, total } = await getAvailableQuantity(item.id, currentRoomId, placedInScene);
  const isUnavailable = available <= 0;

  if (isUnavailable) {
    card.classList.add('unavailable');
  }

  // Thumbnail container (holds thumbnail and availability badge)
  const thumbnailContainer = document.createElement('div');
  thumbnailContainer.className = 'card-thumbnail';

  const hasImage = item.thumbnail || item.image;
  const hasModel = item.hasModel || (item.model !== null && item.model !== undefined);

  if (hasImage) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(item.thumbnail || item.image);
    img.className = 'default-thumbnail';
    thumbnailContainer.appendChild(img);

    // If both image and model exist, add hover behavior for model preview
    if (hasModel) {
      thumbnailContainer.classList.add('has-model-preview');
      thumbnailContainer.dataset.entryId = item.id;

      let modelThumbnailGenerated = false;
      let modelThumbnailUrl = null;
      let hoverTimeout = null;

      // Create overlay image element (hidden initially)
      const modelImg = document.createElement('img');
      modelImg.className = 'model-thumbnail-overlay';
      thumbnailContainer.appendChild(modelImg);

      thumbnailContainer.addEventListener('mouseenter', async () => {
        // Generate model thumbnail on first hover (lazy loading)
        if (!modelThumbnailGenerated && !thumbnailContainer.dataset.loadingModel) {
          thumbnailContainer.dataset.loadingModel = 'true';
          try {
            const entry = await getFurnitureEntry(item.id);
            if (entry && entry.model) {
              const extracted = await extractModelFromZip(entry.model);
              const model = await loadModelFromExtractedZip(extracted);
              const blob = await generateThumbnailFromModel(model);
              modelThumbnailUrl = URL.createObjectURL(blob);
              modelImg.src = modelThumbnailUrl;
              modelThumbnailGenerated = true;
            }
          } catch (e) {
            console.warn('Failed to generate model thumbnail on hover:', e);
          }
          delete thumbnailContainer.dataset.loadingModel;
        }

        // Show model thumbnail after 300ms hold
        if (modelThumbnailGenerated) {
          hoverTimeout = setTimeout(() => {
            thumbnailContainer.classList.add('showing-model');
          }, 300);
        }
      });

      thumbnailContainer.addEventListener('mouseleave', () => {
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
        thumbnailContainer.classList.remove('showing-model');
      });
    }
  } else {
    thumbnailContainer.innerHTML = '<span class="placeholder">No Image</span>';
  }

  // Availability badge
  const badge = document.createElement('span');
  badge.className = 'availability-badge' + (isUnavailable ? ' unavailable' : '');
  badge.textContent = `${available}/${total}`;
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

  const entry = await getFurnitureEntry(entryId);
  const hasModel = entry && entry.model;
  const placedInScene = getPlacedCountForEntry(entryId);
  const { available } = await getAvailableQuantity(entryId, currentRoomId, placedInScene);

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
    // Check availability before placing (include count already placed in current scene)
    const placedInScene = getPlacedCountForEntry(entryId);
    const { available } = await getAvailableQuantity(entryId, currentRoomId, placedInScene);
    if (available <= 0) {
      showError('This item is not available. All stock is in use.');
      return;
    }

    const position = getLastClickPosition();
    await placeFurniture(entryId, position);

    // Close furniture modal after placing
    modalManager.closeModal();
  } catch (err) {
    showError('Failed to place furniture: ' + err.message);
  }
}

async function confirmDeleteEntry(entryId) {
  const entry = await getFurnitureEntry(entryId);
  if (!entry) return;

  showConfirmDialog(
    `Are you sure you want to delete "${entry.name}"? This will also remove all placed instances.`,
    async () => {
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

  // Generate model button - starts Meshy.ai generation
  // Generate model button - starts Meshy.ai background generation
  generateBtn.addEventListener('click', async () => {
    if (!entryImageBlob) {
      showError('Please upload an image first');
      return;
    }
    if (entryModelBlob) {
      showError('A 3D model already exists for this entry');
      return;
    }
    if (!editingEntryId) {
      showError('Please save the entry first, then generate the 3D model');
      return;
    }
    if (meshyActiveTasks.has(editingEntryId)) {
      showError('Generation already in progress for this entry');
      return;
    }
    if (meshyActiveTasks.size >= MESHY_MAX_CONCURRENT) {
      showError(`Maximum ${MESHY_MAX_CONCURRENT} concurrent generations allowed`);
      return;
    }

    const entryName = document.getElementById('entry-name').value || 'Unnamed';
    startMeshyBackgroundGeneration(editingEntryId, entryName);

    // Update button to show generation started
    generateBtn.textContent = 'Generating...';
    generateBtn.disabled = true;
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
  entryThumbnailBlob = null;
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
        if (meshyActiveTasks.has(entryId)) {
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

      if (entry.thumbnail) {
        entryThumbnailBlob = entry.thumbnail;
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
  entryThumbnailBlob = null;
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

  if (!file.name.toLowerCase().endsWith('.zip')) {
    showError('Please upload a ZIP file containing a GLB or GLTF model');
    return;
  }

  try {
    // Validate the ZIP contains a valid model
    await extractModelFromZip(file);

    // Store the original ZIP file (preserves all assets)
    entryModelBlob = file;

    const preview = document.getElementById('model-upload-preview');
    preview.innerHTML = '<span style="color: #22c55e;">Model loaded</span>';
    // Note: Thumbnail will be generated server-side during upload
  } catch (err) {
    showError(err.message);
  }

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

  // Determine thumbnail
  let thumbnail = entryThumbnailBlob;
  if (entryImageBlob) {
    thumbnail = entryImageBlob; // Use image as thumbnail if available
  }
  // Note: If only model exists (no image), server generates thumbnail during upload

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
    thumbnail: thumbnail,
    quantity: Math.max(1, quantity),
    dimensionX: dimXVal !== '' ? parseFloat(dimXVal) : null,
    dimensionY: dimYVal !== '' ? parseFloat(dimYVal) : null,
    dimensionZ: dimZVal !== '' ? parseFloat(dimZVal) : null
  };

  await saveFurnitureEntry(entry);
  closeEntryEditor();
  await refreshFurnitureModal();
}

// ============ Meshy Background Generation ============

function startMeshyBackgroundGeneration(entryId, entryName) {
  // Track task
  meshyActiveTasks.set(entryId, {
    taskId: null,
    status: 'Starting...',
    progress: 0,
    entryName: entryName
  });

  // Update tracker UI
  updateMeshyTrackerUI();

  // Start async generation (don't await - runs in background)
  runMeshyGeneration(entryId).catch(err => {
    console.error('Meshy background generation failed:', err);
  });
}

async function runMeshyGeneration(entryId) {
  const task = meshyActiveTasks.get(entryId);
  if (!task) return;

  try {
    // Build the full image URL for Meshy API
    const imageUrl = `${window.location.origin}${adjustUrlForProxy(`/api/files/furniture/${entryId}/image`)}`;

    // Step 1: Create Meshy task
    updateMeshyTaskStatus(entryId, 'Connecting...', 0);

    const createResponse = await fetch(adjustUrlForProxy(`/api/meshy/generate/${entryId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl })
    });

    if (!createResponse.ok) {
      const error = await createResponse.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(error.detail || 'Failed to start generation');
    }

    const { task_id } = await createResponse.json();
    task.taskId = task_id;

    // Step 2: Poll for completion
    updateMeshyTaskStatus(entryId, 'Generating...', 0);

    const result = await pollMeshyBackground(entryId, task_id);

    if (result.status === 'FAILED') {
      throw new Error(result.message || 'Model generation failed');
    }

    // Step 3: Download the model
    updateMeshyTaskStatus(entryId, 'Downloading...', 100);

    const glbUrl = result.model_urls?.glb;
    if (!glbUrl) {
      throw new Error('No GLB model URL in response');
    }

    const downloadResponse = await fetch(adjustUrlForProxy(`/api/meshy/download/${entryId}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ glb_url: glbUrl })
    });

    if (!downloadResponse.ok) {
      const error = await downloadResponse.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(error.detail || 'Failed to download model');
    }

    // Step 4: Finalize - server already processed model and queued thumbnail generation
    updateMeshyTaskStatus(entryId, 'Finalizing...', 100);

    // Step 5: Success - remove from tracker, show toast
    meshyActiveTasks.delete(entryId);
    updateMeshyTrackerUI();
    showMeshyToast(task.entryName, true, '3D model ready!');

    // Update entry editor if still open for this entry
    if (editingEntryId === entryId) {
      const modelPreview = document.getElementById('model-upload-preview');
      const generateBtn = document.getElementById('generate-model-btn');
      if (modelPreview) modelPreview.innerHTML = '<span style="color: #22c55e;">Model generated</span>';
      if (generateBtn) generateBtn.style.display = 'none';
      // Refresh the entry data
      const entry = await getFurnitureEntry(entryId);
      if (entry) entryModelBlob = entry.model;
    }

    // Refresh furniture modal if open
    await refreshFurnitureModal();

  } catch (err) {
    console.error('Meshy generation error:', err);

    // Remove from tracker, show error toast
    const task = meshyActiveTasks.get(entryId);
    const entryName = task?.entryName || 'Unknown';
    meshyActiveTasks.delete(entryId);
    updateMeshyTrackerUI();
    showMeshyToast(entryName, false, err.message);

    // Reset entry editor button if still open
    if (editingEntryId === entryId) {
      const generateBtn = document.getElementById('generate-model-btn');
      if (generateBtn) {
        generateBtn.textContent = 'Generate 3D Model';
        generateBtn.disabled = false;
      }
    }
  }
}

async function pollMeshyBackground(entryId, taskId) {
  let attempts = 0;
  const maxAttempts = 120; // 10 minutes at 5-second intervals

  while (attempts < maxAttempts) {
    attempts++;

    // Check if task was cancelled
    if (!meshyActiveTasks.has(entryId)) {
      throw new Error('Generation cancelled');
    }

    const response = await fetch(adjustUrlForProxy(`/api/meshy/status/${taskId}`));

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Status check failed' }));
      throw new Error(error.detail);
    }

    const status = await response.json();

    // Update progress
    if (status.progress !== undefined) {
      updateMeshyTaskStatus(entryId, `${status.progress}%`, status.progress);
    }

    // Check completion
    if (status.status === 'SUCCEEDED' || status.status === 'FAILED') {
      return status;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error('Generation timed out after 10 minutes');
}

async function uploadMeshyThumbnail(entryId, thumbnailBlob) {
  const formData = new FormData();
  formData.append('file', thumbnailBlob, 'thumbnail.png');

  const response = await fetch(adjustUrlForProxy(`/api/files/furniture/${entryId}/thumbnail`), {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error('Failed to upload thumbnail');
  }
}

// ============ Meshy Notification UI ============

function updateMeshyTaskStatus(entryId, status, progress) {
  const task = meshyActiveTasks.get(entryId);
  if (task) {
    task.status = status;
    task.progress = progress;
    updateMeshyTrackerUI();
  }
}

function updateMeshyTrackerUI() {
  const tracker = document.getElementById('meshy-task-tracker');
  const list = document.getElementById('meshy-tracker-list');
  const countEl = tracker.querySelector('.meshy-tracker-count');
  const toasts = document.getElementById('meshy-toasts');

  if (meshyActiveTasks.size === 0) {
    tracker.classList.add('hidden');
    toasts.classList.remove('with-tracker');
    return;
  }

  tracker.classList.remove('hidden');
  toasts.classList.add('with-tracker');
  countEl.textContent = `${meshyActiveTasks.size} task${meshyActiveTasks.size > 1 ? 's' : ''}`;

  // Build list HTML
  let html = '';
  for (const [entryId, task] of meshyActiveTasks) {
    html += `
      <div class="meshy-tracker-item" data-entry-id="${entryId}">
        <div class="meshy-tracker-item-header">
          <span class="meshy-tracker-item-name" title="${task.entryName}">${task.entryName}</span>
          <span class="meshy-tracker-item-status">${task.status}</span>
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

// ============ Session Modal (House Operations) ============

function setupSessionModal() {
  const sessionBtn = document.getElementById('session-btn');
  const editHouseBtn = document.getElementById('edit-house-session-btn');
  const exportBtn = document.getElementById('export-session-btn');
  const closeHouseBtn = document.getElementById('close-house-session-btn');
  const deleteHouseBtn = document.getElementById('delete-house-session-btn');

  sessionBtn.addEventListener('click', openSessionModal);
  editHouseBtn.addEventListener('click', handleEditHouseFromSession);
  exportBtn.addEventListener('click', handleExportHouse);
  closeHouseBtn.addEventListener('click', handleCloseHouseFromSession);
  deleteHouseBtn.addEventListener('click', handleDeleteHouseFromSession);
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

async function handleExportHouse() {
  if (!currentHouseId) {
    showError('No house to export');
    return;
  }

  // Save current room first
  if (currentRoomId && currentBackgroundImage) {
    await saveCurrentRoom();
  }

  const house = getCurrentHouse();
  const rooms = await getRoomsByHouseId(currentHouseId);

  // Build export data with all rooms
  const roomsData = [];
  for (const room of rooms) {
    const roomExport = {
      id: room.id,
      name: room.name,
      backgroundImage: room.backgroundImage ? await blobToBase64(room.backgroundImage) : null,
      cameraOrientation: room.cameraOrientation,
      placedFurniture: room.placedFurniture || []
    };
    roomsData.push(roomExport);
  }

  const exportData = {
    house: {
      id: house.id,
      name: house.name,
      startDate: house.startDate,
      endDate: house.endDate
    },
    rooms: roomsData
  };

  const jsonString = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });

  const link = document.createElement('a');
  const safeName = house.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  link.download = `house-${safeName}.json`;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);

  modalManager.closeModal();
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

async function handleRoomNameSubmit(event) {
  event.preventDefault();

  const nameInput = document.getElementById('room-name-input');
  const name = nameInput.value.trim();

  if (!name) {
    showError('Please enter a room name');
    return;
  }

  pendingRoomName = name;
  closeRoomNameModal();

  // Start automatic processing flow (no user interaction required)
  await processRoomAutomatically();
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

  // Close lighting panel if open
  closeLightingPanelIfOpen();

  // Store pending image
  pendingRoomImage = file;

  // Show the image immediately
  setBackgroundImage(file);
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
  // Close lighting panel before switching
  closeLightingPanelIfOpen();

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
    for (const furniture of room.placedFurniture) {
      try {
        const entry = await getFurnitureEntry(furniture.entryId);
        if (!entry || !entry.model) continue;

        const extractedData = await extractModelFromZip(entry.model);
        const model = await loadModelFromExtractedZip(extractedData);
        model.position.set(furniture.position.x, furniture.position.y, furniture.position.z);
        model.rotation.set(furniture.rotation.x, furniture.rotation.y, furniture.rotation.z);

        if (typeof furniture.scale === 'number') {
          model.scale.setScalar(furniture.scale);
        } else if (furniture.scale && typeof furniture.scale === 'object') {
          model.scale.set(furniture.scale.x, furniture.scale.y, furniture.scale.z);
        }

        addFurnitureToScene(model, furniture.entryId);
      } catch (err) {
        console.warn(`Failed to load furniture ${furniture.entryId}:`, err);
      }
    }
  }

  // Load lighting settings
  if (room.lightingSettings) {
    applyLightingSettings(room.lightingSettings);
    console.log('Room lighting settings restored');
  }

  // Show scene
  showScene();
  deselectFurniture();
}

async function saveCurrentRoom() {
  if (!currentRoomId || !currentBackgroundImage) return;

  const room = await dbLoadRoom(currentRoomId) || {};

  const roomState = {
    id: currentRoomId,
    houseId: currentHouseId,
    name: room.name || 'Untitled Room',
    backgroundImage: currentBackgroundImage,
    cameraOrientation: null,
    placedFurniture: collectPlacedFurniture(),
    // Preserve MoGe data from original room
    mogeData: room.mogeData || null,
    // Save lighting settings
    lightingSettings: getLightingSettings()
  };

  await saveRoom(roomState);
}

async function createRoomInCurrentHouse(image, name, mogeData = null, remoteMeshUrl = null) {
  const room = {
    id: null,  // Server generates ID
    houseId: currentHouseId,
    name: name,
    backgroundImage: image,
    cameraOrientation: null,
    placedFurniture: [],
    // MoGe-2 data for mesh reconstruction on load
    mogeData: mogeData ? {
      meshUrl: mogeData.meshUrl,
      cameraFov: mogeData.cameraFov,
      imageAspect: mogeData.imageAspect
    } : null,
    // Remote mesh URL for server to download atomically
    remoteMeshUrl: remoteMeshUrl
  };

  const roomId = await saveRoom(room);
  return { ...room, id: roomId };
}

async function closeHouse() {
  // Close lighting panel
  closeLightingPanelIfOpen();

  currentHouseId = null;
  currentRoomId = null;
  currentBackgroundImage = null;
  setCurrentHouse(null);
  setCurrentLoadedHouse(null);

  // Clear any pending creation state
  pendingRoomImage = null;
  pendingRoomName = null;

  document.getElementById('background-container').style.backgroundImage = '';
  clearAllFurniture();
  clearRoomGeometry(); // Reset room bounds to default
  undoManager.clear();
  deselectFurniture();
  hideScene();

  await openCalendarModal();
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
